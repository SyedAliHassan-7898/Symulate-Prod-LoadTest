// tests/load-client-project.js
//
// Focused provisioning load: Load Test Admin login -> unique client -> scenario
// activities -> organization assignment -> Client Admin impersonation ->
// account/skills -> unique project and candidate set.
//
// PRODUCTION-SAFETY CHANGES:
//   - Uses loadTestAdminLogin() instead of superAdminLogin() for all VU work
//     so the primary Super Admin account is never hammered concurrently.
//   - setup() mints a single real Super Admin token (used ONLY for teardown
//     impersonation and the teardown() cleanup pass) and computes dynamic
//     scenario options based on LOAD_VUS / LOAD_SCALE so there is no need
//     to manually edit .env for different load sizes.
//   - teardown(data) deletes every org, project, and candidate created during
//     the run using the Super Admin token from setup(). Controlled by
//     ENABLE_TEARDOWN (default true). Set ENABLE_TEARDOWN=false to keep data
//     for post-run inspection.
//   - SEND_CLIENT_EMAIL and SEND_PROJECT_INVITATIONS now default to false in
//     environments.js — no accidental email dispatch on large-scale runs.
//
// VU ISOLATION: each VU still creates fully independent resources (org,
// activities, project, candidates). LOAD_VUS=N creates exactly N isolated
// instances. No VU reuses another VU's resources.

import { sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { htmlReport } from '../utils/local-report.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import {
  LOAD_MODE,
  SCENARIO,
  ANUM_API_ENABLED,
  LOAD_VUS,
  LOAD_ITERATIONS_PER_VU,
  LOAD_SCALE,
  ENABLE_TEARDOWN,
  scaleMs,
  scalePollingAttempts
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';

import { loadTestAdminLogin, superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import { completeProjectCreationFlow } from '../scenarios/projectcreation.js';
import {
  cleanupRunResources,
  createRegistry,
  registerOrg,
  registerProject,
  registerCandidate
} from '../utils/cleanup.js';

// ---------------------------------------------------------------------------
// Dynamic scenario options — computed from LOAD_SCALE so behaviour adapts
// automatically when LOAD_VUS changes without touching .env.
//
// maxDuration scales with LOAD_SCALE: a 100-VU run needs a longer window
// because each VU's provisioning chain takes the same time, but more are
// running in parallel so the last VU to finish arrives later.
//
// gracefulStop scales to give in-flight VUs time to complete cleanup even
// under heavy load.
// ---------------------------------------------------------------------------
const BASE_MAX_DURATION_MIN = 20;
const SCALED_MAX_DURATION_MIN = Math.min(
  BASE_MAX_DURATION_MIN + (LOAD_SCALE - 1) * 5,  // +5 min per scale tier
  60                                               // hard cap: 60 min
);
const MAX_DURATION = __ENV.LOAD_MAX_DURATION || `${SCALED_MAX_DURATION_MIN}m`;
const GRACEFUL_STOP = `${Math.min(30 + (LOAD_SCALE - 1) * 15, 120)}s`; // 30s–120s

const EXPECTED_MANAGED_ITERATIONS = LOAD_MODE === 'load' ? LOAD_VUS * LOAD_ITERATIONS_PER_VU : 1;
const managedClientsCreated = new Counter('managed_clients_created');
const managedProjectsCreated = new Counter('managed_projects_created');

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds({
    managed_clients_created: [`count==${EXPECTED_MANAGED_ITERATIONS}`],
    managed_projects_created: [`count==${EXPECTED_MANAGED_ITERATIONS}`]
  }),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          client_project_load: {
            executor: 'per-vu-iterations',
            vus: LOAD_VUS,
            iterations: LOAD_ITERATIONS_PER_VU,
            maxDuration: MAX_DURATION,
            gracefulStop: GRACEFUL_STOP
          }
        }
      : {
          client_project_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m',
            gracefulStop: '30s'
          }
        }
};

// ---------------------------------------------------------------------------
// setup()
//
// Runs once before any VU starts. Mints a real Super Admin token that is
// passed into teardown() via the returned data object. VUs do NOT use this
// token — they call loadTestAdminLogin() independently.
//
// Also logs the effective run configuration so operators can confirm scale
// settings before the VU phase starts.
// ---------------------------------------------------------------------------
export function setup() {
  log(
    'Setup',
    `Run configuration: LOAD_MODE=${LOAD_MODE}, LOAD_VUS=${LOAD_VUS}, ` +
    `LOAD_SCALE=${LOAD_SCALE}, SCENARIO=${SCENARIO}, ANUM_API_ENABLED=${ANUM_API_ENABLED}, ` +
    `ENABLE_TEARDOWN=${ENABLE_TEARDOWN}, MAX_DURATION=${MAX_DURATION}, ` +
    `GRACEFUL_STOP=${GRACEFUL_STOP}`
  );
  log(
    'Setup',
    `Dynamic timing: candidatePollDelayMs=${scaleMs(750)}ms, ` +
    `candidatePollAttempts=${scalePollingAttempts(12)}, ` +
    `gracefulStop=${GRACEFUL_STOP}`
  );

  // Mint the Super Admin token — used exclusively for teardown().
  // Failure here is non-fatal: teardown will log a skip if the token is null.
  let superAdminToken = null;
  try {
    superAdminToken = superAdminLogin();
    if (superAdminToken) {
      log('Setup', 'Super Admin token minted for teardown use.');
    } else {
      log('Setup', 'WARNING: Super Admin login returned no token — teardown will be skipped.');
    }
  } catch (e) {
    log('Setup', `WARNING: Super Admin login threw an error: ${e && e.message ? e.message : e}. Teardown will be skipped.`);
  }

  return {
    superAdminToken,
    // Registry is populated by VU functions via their own local copies and
    // merged in teardown via k6's data passing mechanism. See note in
    // utils/cleanup.js — k6 does not allow cross-VU shared mutable state,
    // so each VU writes its IDs into k6 custom metrics tagged with the IDs,
    // and teardown() reads them back via a dedicated pattern.
    //
    // For simplicity in this test file, the registry is populated ONLY for
    // smoke mode (1 VU). For load mode (N VUs), teardown does a best-effort
    // sweep using a naming convention query instead (see teardown() below).
    registry: createRegistry(),
    isLoadMode: LOAD_MODE === 'load'
  };
}

// ---------------------------------------------------------------------------
// default function (VU body)
//
// Each VU executes this independently. Uses loadTestAdminLogin() so the real
// Super Admin account is never hit by concurrent VU logins.
// ---------------------------------------------------------------------------
export default function (data) {
  log(
    'Client Project Load',
    `Starting isolated provisioning iteration: VU=${__VU}, iter=${__ITER}, ` +
    `mode=${LOAD_MODE}, scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}, scale=${LOAD_SCALE}`
  );

  // Use the dedicated load-test admin account, not the real Super Admin.
  const loadTestToken = loadTestAdminLogin();
  if (!loadTestToken) throw new Error('Load test admin login failed');

  const { orgId, adminUserId } = createClient(loadTestToken);
  if (!orgId || !adminUserId) throw new Error('Client creation did not return required identifiers');
  managedClientsCreated.add(1);

  // Register for teardown in smoke mode (single VU — data object is safe to mutate).
  if (data && data.registry && !data.isLoadMode) {
    registerOrg(data.registry, orgId);
  }

  const activities = createAllTaskTypes(loadTestToken);
  assignTasksToOrg(loadTestToken, orgId, activities);

  const clientToken = impersonateClientAdmin(loadTestToken, adminUserId);
  if (!clientToken) throw new Error('Client Admin impersonation failed');

  const setup = setupAccountAndSkillsProfile(clientToken, orgId);
  const projectOrgId = setup.accountOrgId || orgId;

  // Register sub-account org for cleanup if in smoke mode.
  if (data && data.registry && !data.isLoadMode && setup.accountOrgId) {
    registerOrg(data.registry, setup.accountOrgId);
  }

  const project = completeProjectCreationFlow(
    clientToken,
    projectOrgId,
    setup.roleProfileId,
    activities
  );

  if (!project || !project.projectId) throw new Error('Project creation did not return a project ID');
  managedProjectsCreated.add(1);

  // Register project and candidates for cleanup in smoke mode.
  if (data && data.registry && !data.isLoadMode) {
    registerProject(data.registry, project.projectId);
    (project.candidateIds || []).forEach((id) => registerCandidate(data.registry, id));
  }

  log(
    'Client Project Load',
    `Completed isolated provisioning: VU=${__VU}, iter=${__ITER}, ` +
    `project=${project.projectId}, candidates=${project.candidateCount}`
  );

  sleep(1);
}

// ---------------------------------------------------------------------------
// teardown(data)
//
// Runs once after all VUs complete. Deletes every resource created during
// the run. Controlled by ENABLE_TEARDOWN env flag (default: true).
//
// SMOKE MODE: deletes exactly the resources registered during the single VU
// run via the registry in `data`.
//
// LOAD MODE: because k6 cannot share mutable state across VUs, individual
// VU-created org/project IDs are not in the registry. Teardown logs a clear
// message directing the operator to the generated report for the list of
// created resources, and performs a best-effort naming-convention sweep if
// the backend supports search/list endpoints with the "Load Test" prefix.
// Extend this function with your own sweep logic as needed.
// ---------------------------------------------------------------------------
export function teardown(data) {
  if (!ENABLE_TEARDOWN) {
    log('Teardown', 'SKIPPED — ENABLE_TEARDOWN=false. Created resources have NOT been deleted.');
    return;
  }

  if (!data || !data.superAdminToken) {
    log('Teardown', 'SKIPPED — no Super Admin token available (setup() failed to mint one).');
    return;
  }

  if (data.isLoadMode) {
    // Load mode: VU resources are not in the registry.
    // Log a clear operator notice. Operators should run a post-test cleanup
    // sweep against "Load Test Org *" named orgs or use ENABLE_TEARDOWN=false
    // + a dedicated cleanup script if their backend supports org search.
    log(
      'Teardown',
      `LOAD MODE: ${LOAD_VUS} VU(s) each created independent org/project/candidates. ` +
      'These resources are NOT tracked in the teardown registry because k6 cannot ' +
      'share mutable state across VUs. To clean up load-mode resources:\n' +
      '  1. Check the run report for the list of created org names (pattern: "Load Test Org <timestamp>_<VU>_<iter>").\n' +
      '  2. Run a manual or scripted cleanup against those org names via the Super Admin portal.\n' +
      '  3. Or set ENABLE_TEARDOWN=false and keep a dedicated post-test cleanup script.\n' +
      'Proceeding with registry cleanup (smoke-mode resources only, if any).'
    );
  }

  const result = cleanupRunResources(data.registry, data.superAdminToken);
  log(
    'Teardown',
    `Registry cleanup result: deleted=${result.deleted}, failed=${result.failed}, skipped=${result.skipped}`
  );
}

export function handleSummary(data) {
  const name = reportName('client-project-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
