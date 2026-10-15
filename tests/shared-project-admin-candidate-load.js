// tests/shared-project-admin-candidate-load.js
//
// Combined load test — simulates BOTH Client Admin portal activity AND
// candidate assessment activity concurrently on the SAME shared project.
//
// Flow per VU:
//   1. Client Admin login (shared credentials — 10 VUs hit same account simultaneously)
//   2. GET account details, skills profile, project details  ← admin portal load
//   3. Candidate login via invitation href
//   4. Accept agreement → perform all assigned activities    ← candidate load
//
// This simulates the realistic scenario where Client Admins are reviewing
// the project dashboard WHILE candidates are performing assessments.
//
// Required env vars (set by scripts/run-shared-project-load.js):
//   SHARED_PROJECT_ID          — the provisioned project
//   SHARED_CANDIDATE_HREFS_FILE — temp file with base64 hrefs map
//   SHARED_ORG_ID              — org id for admin portal calls
//   LOAD_VUS                   — concurrent VUs (default 10)

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';
import { b64decode } from 'k6/encoding';

import { ANUM_API_ENABLED, SCENARIO, LOAD_MODE } from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { getJson, getJsonWithHeaders } from '../utils/http.js';
import { routes } from '../utils/routes.js';
import { performAllActivities } from '../scenarios/candidateassessment.js';
import { clientAdminLogin } from '../scenarios/login.js';

const PROJECT_ID  = __ENV.SHARED_PROJECT_ID;
const ORG_ID      = __ENV.SHARED_ORG_ID || '';
const LOAD_VUS    = Math.max(1, Number(__ENV.LOAD_VUS || 10));

const CLIENT_ADMIN_HEADERS = {
  'x-base-origin': 'client-admin',
  Origin:  __ENV.CLIENT_ADMIN_URL  || 'https://client-admin.symulate-dev.weuno.co',
  Referer: `${__ENV.CLIENT_ADMIN_URL || 'https://client-admin.symulate-dev.weuno.co'}/`
};

// ── Load candidate hrefs from temp file ──────────────────────────────────────
let CANDIDATE_HREFS = {};
try {
  let raw = String(__ENV.SHARED_CANDIDATE_HREFS || '').trim();
  if (!raw) {
    const filePath = String(__ENV.SHARED_CANDIDATE_HREFS_FILE || '').trim();
    if (filePath) raw = open(filePath).trim();
  }
  if (raw && raw !== 'NONE') {
    CANDIDATE_HREFS = JSON.parse(b64decode(raw, 'std', 's'));
  }
} catch (e) { /* handled in setup() */ }

const candidateEntries = Object.entries(CANDIDATE_HREFS); // [[candidateId, href], ...]

// ── k6 options ────────────────────────────────────────────────────────────────
export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    shared_admin_candidate_load: {
      executor: 'per-vu-iterations',
      vus: Math.min(LOAD_VUS, candidateEntries.length || LOAD_VUS),
      iterations: 1,
      maxDuration: __ENV.LOAD_MAX_DURATION || '30m',
      gracefulStop: '90s'
    }
  },
  thresholds: {
    // A capacity run should not treat widespread 429/403 responses as success.
    // Keep a small allowance for unrelated transient network failures.
    http_req_failed:   ['rate<0.01'],
    http_req_duration: ['p(95)<8000']
  }
};

// ── setup() ───────────────────────────────────────────────────────────────────
export function setup() {
  if (!PROJECT_ID) {
    exec.test.abort('SHARED_PROJECT_ID is not set.');
  }
  if (candidateEntries.length === 0) {
    exec.test.abort('SHARED_CANDIDATE_HREFS is empty or invalid.');
  }
  log('AdminCandidateLoad', `Project=${PROJECT_ID}, candidates=${candidateEntries.length}, VUs=${LOAD_VUS}`);

  // Return shared admin token so all VUs reuse the same session — this is
  // intentional: we want to simulate N concurrent Client Admins using the
  // SAME account (shared org dashboard), which is the realistic scenario.
  const adminToken = clientAdminLogin(
    __ENV.CLIENT_ADMIN_EMAIL,
    __ENV.CLIENT_ADMIN_PASSWORD
  );

  if (!adminToken) {
    exec.test.abort('Client Admin login failed in setup(). Check CLIENT_ADMIN_EMAIL and CLIENT_ADMIN_PASSWORD in .env');
  }

  log('AdminCandidateLoad', 'Client Admin token obtained — will be shared across all VUs');
  return { adminToken };
}

// ── default() — runs once per VU ─────────────────────────────────────────────
export default function (data) {
  const { adminToken } = data;

  // Spread candidate flows over a configurable interval to avoid an
  // artificial request burst while still exercising concurrent users.
  const vuIndex = (__VU - 1) % candidateEntries.length;
  const startIntervalSeconds = Math.max(
    0,
    Number(__ENV.LOAD_VU_START_INTERVAL_SECONDS || 1.5),
  );
  const startDelaySeconds = vuIndex * startIntervalSeconds;
  if (startDelaySeconds > 0) {
    sleep(startDelaySeconds);
  }

  const [candidateId, invitationHref] = candidateEntries[vuIndex];

  log('AdminCandidateLoad', `VU=${__VU} → candidate=${candidateId}`);

  // ── STEP 1: Client Admin portal load ──────────────────────────────────────
  // Simulate 10 concurrent Client Admins hitting the project dashboard.
  // These calls use the SAME admin token — all 10 VUs hit simultaneously.

  log('AdminCandidateLoad', `VU=${__VU} → [Admin] Fetching project details`);

  const projectRes = getJsonWithHeaders(
    routes.projectById(PROJECT_ID),
    adminToken,
    'Admin - Get Project Details',
    CLIENT_ADMIN_HEADERS
  );
  check(projectRes, {
    'admin: get project details: status 2xx': (r) => r.status >= 200 && r.status < 300
  });

  // Simulate Admin fetching candidate list for the project
  const candidatesRes = getJsonWithHeaders(
    `${routes.projectById(PROJECT_ID)}?include=candidates`,
    adminToken,
    'Admin - Get Project Candidates',
    CLIENT_ADMIN_HEADERS
  );
  check(candidatesRes, {
    'admin: get project candidates: status 2xx': (r) => r.status >= 200 && r.status < 300
  });

  // Simulate Admin fetching skills profile / org account details
  if (ORG_ID) {
    const orgRes = getJsonWithHeaders(
      routes.organizationById ? routes.organizationById(ORG_ID) : `${__ENV.API_URL}/organizations/${ORG_ID}`,
      adminToken,
      'Admin - Get Organization Details',
      CLIENT_ADMIN_HEADERS
    );
    check(orgRes, {
      'admin: get org details: status 2xx': (r) => r.status >= 200 && r.status < 300
    });
  }

  log('AdminCandidateLoad', `VU=${__VU} → [Admin] Portal calls complete`);

  // Small pause — simulate admin reading the dashboard before candidate starts
  sleep(0.5);

  // ── STEP 2: Candidate assessment flow ─────────────────────────────────────
  // Each VU now switches to candidate mode using their unique invitation href

  if (!invitationHref) {
    log('AdminCandidateLoad', `VU=${__VU}: invitation href missing for candidateId=${candidateId}`);
    check(null, { 'candidate invitation href exists': (value) => value !== null });
    return;
  }

  // This helper owns candidate login, agreement, optional booking, activity
  // discovery, and execution. Do not duplicate those calls in this wrapper.
  const activityResults = performAllActivities(
    `candidate-${candidateId}`,
    '',
    candidateId,
    [],
    ORG_ID,
    candidateId,
    PROJECT_ID,
    invitationHref
  );

  check(activityResults, {
    'candidate flow: at least one stage activity processed': (results) =>
      Array.isArray(results) && results.length > 0,
    'candidate flow: processed activities completed successfully': (results) =>
      Array.isArray(results) && results.length > 0 &&
      results.every((result) => result.status >= 200 && result.status < 300),
  });

  sleep(1);
}

// ── handleSummary() ───────────────────────────────────────────────────────────
export function handleSummary(data) {
  const name = reportName('shared-admin-candidate-load', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
