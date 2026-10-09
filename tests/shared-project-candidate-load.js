// tests/shared-project-candidate-load.js
//
// Phase 2 of the shared-project load test.
// 150 concurrent VUs each login via invitation href and perform all activities
// against the SAME pre-provisioned project.
//
// Required env vars (set automatically by scripts/run-shared-project-load.js):
//   SHARED_PROJECT_ID          — the project all candidates belong to
//   SHARED_CANDIDATE_HREFS_FILE — path to JSON file: { "<candidateId>": "<href>", ... }
//   LOAD_VUS                   — number of concurrent VUs (default 150)

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';
import { b64decode } from 'k6/encoding';

import { ANUM_API_ENABLED, SCENARIO, LOAD_MODE } from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import {
  candidateSessionFromInviteHref,
  acceptCandidateAgreement,
  getAssignedActivities,
  performAllActivities,
  ensureCandidateBooking
} from '../scenarios/candidateassessment.js';

const PROJECT_ID = __ENV.SHARED_PROJECT_ID;
const LOAD_VUS   = Math.max(1, Number(__ENV.LOAD_VUS || 150));

// Decode the per-candidate invitation hrefs map.
// Shape: { "<candidateId>": "<href>", ... }
// Delivered as base64-encoded JSON via env var to avoid Windows arg-length limits.
let CANDIDATE_HREFS = {};
try {
  let raw = String(__ENV.SHARED_CANDIDATE_HREFS || '').trim();
  // Fallback: runner writes oversized base64 to a temp file and passes its path
  if (!raw) {
    const filePath = String(__ENV.SHARED_CANDIDATE_HREFS_FILE || '').trim();
    if (filePath) raw = open(filePath).trim();
  }
  if (raw && raw !== 'NONE') {
    CANDIDATE_HREFS = JSON.parse(b64decode(raw, 'std', 's'));
  }
} catch (e) {
  // leave empty — VUs will fail with a clear error in setup()
}

const candidateEntries = Object.entries(CANDIDATE_HREFS); // [[id, href], ...]

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    shared_project_candidate_load: {
      executor: 'per-vu-iterations',
      vus: Math.min(LOAD_VUS, candidateEntries.length || LOAD_VUS),
      iterations: 1,
      maxDuration: __ENV.LOAD_MAX_DURATION || '30m',
      gracefulStop: '90s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.10'],   // allow up to 10% failure for dev env rate limits
    http_req_duration: ['p(95)<5000'] // 5s p95
  }
};

export function setup() {
  if (!PROJECT_ID) {
    exec.test.abort('SHARED_PROJECT_ID is not set. Run scripts/run-shared-project-load.js to auto-provision.');
  }
  if (candidateEntries.length === 0) {
    exec.test.abort('SHARED_CANDIDATE_HREFS is empty or invalid. Run scripts/run-shared-project-load.js to auto-provision.');
  }
  log('SharedLoad', `Project=${PROJECT_ID}, candidates=${candidateEntries.length}, VUs=${LOAD_VUS}`);
}

export default function () {
  // Round-robin candidate assignment — each VU picks a unique candidate
  const vuIndex = (__VU - 1) % candidateEntries.length;
  const [candidateId, invitationHref] = candidateEntries[vuIndex];

  log('SharedLoad', `VU=${__VU} -> candidate=${candidateId}`);

  // Login via invitation href
  const session = invitationHref ? candidateSessionFromInviteHref(invitationHref, PROJECT_ID) : null;
  const candidateToken = session && session.token;

  check(candidateToken, {
    'candidate invitation login: token obtained': (t) => !!t
  });

  if (!candidateToken) {
    log('SharedLoad', `VU=${__VU}: invitation href login failed for candidate=${candidateId}`);
    return;
  }

  const orgId = session.organizationId || '';

  // Accept agreement
  acceptCandidateAgreement(candidateToken, candidateId, PROJECT_ID);

  // Booking gate (dev env: ENFORCE_BOOKING=false → skipped automatically)
  ensureCandidateBooking(candidateToken, PROJECT_ID);

  // Perform all assigned activities
  performAllActivities(
    `candidate-${candidateId}`,
    '',              // no password needed — invitation href flow
    candidateId,
    [],              // activities fetched inside performAllActivities
    orgId,
    candidateId,
    PROJECT_ID,
    invitationHref
  );

  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('shared-project-load', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
