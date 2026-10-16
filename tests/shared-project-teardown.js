// tests/shared-project-teardown.js
//
// Phase 3 of the shared-project load test — deletes everything Phase 1
// provisioned, so repeated runs don't pile up orgs/projects/candidates.
//
// Historically the shared runner forced ENABLE_TEARDOWN=false for Phase 1
// ("keep resources for Phase 2") and then never cleaned up afterwards, so every
// run left one organisation, one project and NUM_CANDIDATES candidates behind.
//
// Deletion order (dependency-safe, all best-effort):
//   1. candidates — ids are the keys of the invitation-hrefs map
//   2. project
//   3. organisation (cascades anything the backend still owns)
//
// 429s are retried with backoff instead of failing immediately: the DELETE
// helper in utils/cleanup.js deliberately skips retries for speed, but this
// phase runs straight after a 150-VU burst against a per-IP limiter.
//
// Required env (set by scripts/run-shared-project-load.js):
//   SHARED_PROJECT_ID
// Optional env:
//   SHARED_ORG_ID                  — org created in Phase 1
//   SHARED_CANDIDATE_HREFS_FILE    — keys of this map are candidate ids
//   SHARED_CANDIDATE_IDS           — comma-separated ids (alternative)
//   CLEANUP_DELETE_RETRIES         — retries per resource on 429/5xx (default 3)

import { Counter } from 'k6/metrics';
import { sleep } from 'k6';
import http from 'k6/http';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { b64decode } from 'k6/encoding';

import { API_URL } from '../config/environments.js';
import { log } from '../utils/helpers.js';
import { superAdminLogin } from '../scenarios/login.js';

const PROJECT_ID = String(__ENV.SHARED_PROJECT_ID || '').trim();
const ORG_ID     = String(__ENV.SHARED_ORG_ID || '').trim();
const MAX_RETRIES = Math.max(0, Number(__ENV.CLEANUP_DELETE_RETRIES ?? 3));

// Candidate ids: either an explicit list, or the keys of the hrefs map that
// Phase 1 wrote. Read at init stage — open() is not available inside default().
const CANDIDATE_IDS = (() => {
  const explicit = String(__ENV.SHARED_CANDIDATE_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;

  // scripts/run-shared-project-load.js moves values longer than ~4000 chars to
  // a temp file and passes <KEY>_FILE instead (Windows arg-length limit).
  const idsFile = String(__ENV.SHARED_CANDIDATE_IDS_FILE || '').trim();
  if (idsFile) {
    try {
      return open(idsFile).trim().split(',').map((value) => value.trim()).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  const filePath = String(__ENV.SHARED_CANDIDATE_HREFS_FILE || '').trim();
  if (!filePath) return [];
  try {
    const raw = open(filePath).trim();
    if (!raw || raw === 'NONE') return [];
    const map = JSON.parse(b64decode(raw, 'std', 's'));
    return Object.keys(map).filter((key) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
    );
  } catch (_) {
    return [];
  }
})();

const cleanupFailures = new Counter('cleanup_failures');

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    shared_project_teardown: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '15m',
      gracefulStop: '30s'
    }
  },
  // Turns a failed cleanup into a non-zero k6 exit code, which the runner maps
  // to exit 1 — a pipeline can gate on leftover data the same way it gates on
  // thresholds.
  thresholds: {
    cleanup_failures: ['count==0']
  }
};

// Best-effort DELETE with 429/5xx backoff.
// Returns { ok, status } — never throws, so one stubborn resource can't stop
// the rest of the cleanup.
function deleteResource(url, token, label) {
  let status = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let res;
    try {
      res = http.del(url, null, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        tags: { name: label },
        timeout: '30s'
      });
    } catch (error) {
      status = -1;
      log('Teardown', `${label}: transport error ${error && error.message}`);
      sleep(Math.min(8, 2 * (attempt + 1)));
      continue;
    }

    status = res.status;
    if (res.status >= 200 && res.status < 300) {
      log('Teardown', `DELETE ${label} -> ${res.status} OK`);
      return { ok: true, status: res.status };
    }
    if (res.status === 404) {
      log('Teardown', `DELETE ${label} -> 404 (already gone — treated as clean)`);
      return { ok: true, status: 404 };
    }

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < MAX_RETRIES) {
      const wait = Math.min(8, 2 * (attempt + 1));
      log('Teardown', `DELETE ${label} -> ${res.status}; retry ${attempt + 1}/${MAX_RETRIES} in ${wait}s`);
      sleep(wait);
      continue;
    }
    break;
  }

  log('Teardown', `DELETE ${label} -> ${status} FAILED after ${MAX_RETRIES + 1} attempt(s)`);
  return { ok: false, status };
}

export default function () {
  // Guarantee at least one sample so the cleanup_failures threshold is always
  // evaluated by k6, even on a fully successful run.
  cleanupFailures.add(0);

  if (!PROJECT_ID) {
    log('Teardown', 'ABORT — SHARED_PROJECT_ID is not set; nothing to delete.');
    cleanupFailures.add(1);
    return;
  }

  log('Teardown', `Targets: project=${PROJECT_ID} org=${ORG_ID || '<none>'} candidates=${CANDIDATE_IDS.length}`);

  const token = superAdminLogin();
  if (!token) {
    log('Teardown', 'ABORT — Super Admin login failed; resources were NOT deleted.');
    log('Teardown', `CLEANUP_RESULT deleted=0 failed=${1 + (ORG_ID ? 1 : 0) + CANDIDATE_IDS.length} skipped=login`);
    cleanupFailures.add(1);
    return;
  }

  let deleted = 0;
  let failed = 0;

  // 1. Candidates first — smallest, no inbound dependencies.
  CANDIDATE_IDS.forEach((candidateId) => {
    const result = deleteResource(`${API_URL}/candidate/${candidateId}`, token, `Candidate ${candidateId}`);
    if (result.ok) deleted += 1;
    else failed += 1;
    sleep(0.1);
  });

  // 2. Project next (candidate list and activities hang off it).
  const projectResult = deleteResource(`${API_URL}/project/${PROJECT_ID}`, token, `Project ${PROJECT_ID}`);
  if (projectResult.ok) deleted += 1;
  else failed += 1;

  // 3. Organisation last — cascade-deletes users, invitations and anything else.
  if (ORG_ID) {
    sleep(0.5);
    const orgResult = deleteResource(`${API_URL}/organizations/${ORG_ID}`, token, `Organization ${ORG_ID}`);
    if (orgResult.ok) deleted += 1;
    else failed += 1;
  }

  if (failed > 0) cleanupFailures.add(failed);

  log('Teardown', `Cleanup complete — deleted=${deleted} failed=${failed}`);
  log('Teardown', `CLEANUP_RESULT deleted=${deleted} failed=${failed} skipped=none`);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true })
  };
}
