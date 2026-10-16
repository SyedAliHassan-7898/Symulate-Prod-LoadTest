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
//
// Load-shaping env vars:
//   LOAD_VU_START_INTERVAL_SECONDS — seconds between VU starts (default 1.5).
//     Previously hardcoded to 500ms and this variable was ignored, which made
//     the documented ramp/peak numbers wrong.
//   PERFORMANCE_PROFILE / ENV_PROFILE — select the pass/fail budgets via
//     config/thresholds.js, exactly like every other load test in this repo.
//
// Ramp telemetry:
//   Each VU emits `WORK_START` / `WORK_END` log lines. scripts/run-shared-project-load.js
//   parses them to report the real peak number of *executing* VUs — don't infer
//   it from the ramp formula.

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';
import { b64decode } from 'k6/encoding';

import { ANUM_API_ENABLED, SCENARIO, LOAD_MODE } from '../config/environments.js';
import { buildThresholds } from '../config/thresholds.js';
import { reportName, log } from '../utils/helpers.js';
import { getJson, getJsonWithHeaders } from '../utils/http.js';
import { routes } from '../utils/routes.js';
import {
  candidateSessionFromInviteHref,
  acceptCandidateAgreement,
  performAllActivities,
  ensureCandidateBooking
} from '../scenarios/candidateassessment.js';
import { clientAdminLogin } from '../scenarios/login.js';

const PROJECT_ID  = __ENV.SHARED_PROJECT_ID;
const ORG_ID      = __ENV.SHARED_ORG_ID || '';
const LOAD_VUS    = Math.max(1, Number(__ENV.LOAD_VUS || 10));

// Ramp pacing. This used to be a hardcoded `vuIndex * 500` while the runner
// exported LOAD_VU_START_INTERVAL_SECONDS that nothing read — so the README's
// "~64 peak at 1.5s" note described a ramp the test never performed.
const START_INTERVAL_SECONDS = (() => {
  const raw = Number(__ENV.LOAD_VU_START_INTERVAL_SECONDS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.5;
})();

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
  // Pass/fail budgets come from config/thresholds.js like every other test in
  // this repo (smoke, load-client-project, load-candidate, load-review), so the
  // documented gate is real:
  //   PERFORMANCE_PROFILE=strict npm run load:shared
  // fails at error rate >= 1%, p95 >= 2s or checks <= 99%.
  // The previous hardcoded budgets (rate<0.15 / p95<8000) let a run with 14%
  // failed requests pass, which made every documented SLA claim false.
  // Loosen per environment with PERFORMANCE_PROFILE / ENV_PROFILE — see
  // config/thresholds.js for the profile table.
  thresholds: buildThresholds()
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

  // Ramp pacing — avoid a thundering herd on rate-limited endpoints.
  // Each VU waits (vuIndex * LOAD_VU_START_INTERVAL_SECONDS) before doing any
  // work: default 1.5s, so 150 VUs are scheduled over ~225s.
  const vuIndex = (__VU - 1) % candidateEntries.length;
  const staggerSeconds = vuIndex * START_INTERVAL_SECONDS;
  if (staggerSeconds > 0) {
    sleep(staggerSeconds);
  }

  // Teardown/ramp telemetry — parsed by scripts/run-shared-project-load.js to
  // report the real peak of concurrently *executing* VUs (k6's builtin `vus`
  // counts sleeping VUs too, so it always reads the full VU count).
  log('AdminCandidateLoad', `WORK_START vu=${__VU} idx=${vuIndex}`);

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

  const session = invitationHref
    ? candidateSessionFromInviteHref(invitationHref, PROJECT_ID)
    : null;
  const candidateToken = session && session.token;

  check(candidateToken, {
    'candidate invitation login: token obtained': (t) => !!t
  });

  if (!candidateToken) {
    log('AdminCandidateLoad', `VU=${__VU}: candidate login failed for candidateId=${candidateId}`);
    log('AdminCandidateLoad', `WORK_END vu=${__VU} reason=candidate-login-failed`);
    return;
  }

  const orgId = session.organizationId || ORG_ID;

  // Accept agreement
  acceptCandidateAgreement(candidateToken, candidateId, PROJECT_ID);

  // Booking gate
  ensureCandidateBooking(candidateToken, PROJECT_ID);

  // Perform all assigned activities
  performAllActivities(
    `candidate-${candidateId}`,
    '',
    candidateId,
    [],
    orgId,
    candidateId,
    PROJECT_ID,
    invitationHref
  );

  log('AdminCandidateLoad', `WORK_END vu=${__VU} reason=done`);

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
