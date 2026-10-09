// tests/smoke.js
//
// Managed end-to-end smoke/load flow.
//
// Each VU/iteration owns its own organization, activities, project and
// generated candidate data. Candidate execution is lifecycle-gated by
// SEND_PROJECT_INVITATIONS and selected with CANDIDATE_EXECUTION_SOURCE.
// In load mode one isolated provisioning iteration runs per VU.
//
// PRODUCTION-SAFETY CHANGES:
//   - Uses loadTestAdminLogin() for all VU provisioning work so the primary
//     Super Admin account is never hammered by concurrent VU logins.
//   - setup() mints a real Super Admin token for teardown use only, logs
//     effective run configuration, and returns a resource registry.
//   - teardown(data) deletes all resources via cleanupRunResources().
//     Controlled by ENABLE_TEARDOWN (default true).
//   - SEND_CLIENT_EMAIL and SEND_PROJECT_INVITATIONS now default to false —
//     no accidental email dispatch on large-scale runs.
//   - MAX_DURATION and GRACEFUL_STOP scale dynamically with LOAD_SCALE.

import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';

import { buildThresholds } from '../config/thresholds.js';
import {
  LOAD_MODE,
  SCENARIO,
  ANUM_API_ENABLED,
  LOAD_VUS,
  LOAD_ITERATIONS_PER_VU,
  LOAD_SCALE,
  ENABLE_TEARDOWN,
  INCLUDE_PROJECT_REVIEW,
  SEND_PROJECT_INVITATIONS,
  HARDCODED_CANDIDATES,
  resolveCandidateExecutionSource,
  isCompletePreprovisionedCandidate,
  scaleMs,
  scalePollingAttempts
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';

import { loadTestAdminLogin, superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import {
  completeProjectCreationFlow,
  getProjectById,
  getDefaultEmailTemplate,
  sendInvitationsToProjectCandidates,
  extractInvitationHref
} from '../scenarios/projectcreation.js';
import {
  performAllActivities,
  getHardcodedProjectCandidateId
} from '../scenarios/candidateassessment.js';
import { runProjectReviewFlow } from '../scenarios/projectreview.js';
import {
  cleanupRunResources,
  createRegistry,
  registerOrg,
  registerProject,
  registerCandidate
} from '../utils/cleanup.js';

// ---------------------------------------------------------------------------
// Dynamic scenario options — scale with LOAD_SCALE so operators never need
// to manually update .env when changing VU counts.
// ---------------------------------------------------------------------------
const BASE_MAX_DURATION_MIN = 10;
const SCALED_MAX_DURATION_MIN = Math.min(
  BASE_MAX_DURATION_MIN + (LOAD_SCALE - 1) * 8,  // +8 min per scale tier
  90                                               // hard cap: 90 min
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
          full_flow_load: {
            executor: 'per-vu-iterations',
            vus: LOAD_VUS,
            iterations: LOAD_ITERATIONS_PER_VU,
            maxDuration: MAX_DURATION,
            gracefulStop: GRACEFUL_STOP
          }
        }
      : {
          full_flow_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '15m',
            gracefulStop: '30s'
          }
        }
};

// ---------------------------------------------------------------------------
// setup()
//
// Runs once before VUs start. Mints a real Super Admin token for teardown,
// logs the effective run configuration, and returns the initial data object
// that is passed to both default() and teardown().
// ---------------------------------------------------------------------------
export function setup() {
  const candidateSource = resolveCandidateExecutionSource();

  log(
    'Setup',
    `Run configuration: LOAD_MODE=${LOAD_MODE}, LOAD_VUS=${LOAD_VUS}, ` +
    `LOAD_SCALE=${LOAD_SCALE}, SCENARIO=${SCENARIO}, ANUM_API_ENABLED=${ANUM_API_ENABLED}, ` +
    `SEND_PROJECT_INVITATIONS=${SEND_PROJECT_INVITATIONS}, candidateSource=${candidateSource}, ` +
    `INCLUDE_PROJECT_REVIEW=${INCLUDE_PROJECT_REVIEW}, ENABLE_TEARDOWN=${ENABLE_TEARDOWN}, ` +
    `MAX_DURATION=${MAX_DURATION}, GRACEFUL_STOP=${GRACEFUL_STOP}`
  );
  log(
    'Setup',
    `Dynamic timing: candidatePollDelayMs=${scaleMs(750)}ms, ` +
    `candidatePollAttempts=${scalePollingAttempts(12)}`
  );

  // Mint the real Super Admin token for teardown use only.
  let superAdminToken = null;
  try {
    superAdminToken = superAdminLogin();
    if (superAdminToken) {
      log('Setup', 'Super Admin token minted for teardown use.');
    } else {
      log('Setup', 'WARNING: Super Admin login returned no token — teardown will be skipped.');
    }
  } catch (e) {
    log(
      'Setup',
      `WARNING: Super Admin login error: ${e && e.message ? e.message : e}. Teardown will be skipped.`
    );
  }

  return {
    superAdminToken,
    registry: createRegistry(),
    isLoadMode: LOAD_MODE === 'load'
  };
}

// ---------------------------------------------------------------------------
// Candidate execution helpers (unchanged logic, now accept data for registry)
// ---------------------------------------------------------------------------
function performGeneratedProjectCandidate(clientToken, project, projectOrgId, registry, isLoadMode) {
  const candidateId = project.candidateIds[0];
  const candidateEmail = project.candidates[0] && project.candidates[0].email;

  if (!candidateId || !candidateEmail) {
    throw new Error('Generated candidate execution requires the first managed candidate ID and email.');
  }

  log(
    'Candidate Execution',
    `Running generated candidate ${candidateEmail} on managed project ${project.projectId}`
  );

  return {
    source: 'generated',
    candidateId,
    projectId: project.projectId,
    results: performAllActivities(
      candidateEmail,
      '',
      candidateId,
      [],
      projectOrgId,
      candidateId,
      project.projectId,
      project.invitationHref || project.invitationBody
    )
  };
}

function performPreprovisionedCandidate(loadTestToken) {
  const candidate = HARDCODED_CANDIDATES.find(isCompletePreprovisionedCandidate);
  if (!candidate) {
    throw new Error(
      'CANDIDATE_EXECUTION_SOURCE requires a pre-provisioned candidate, but CANDIDATE_EMAIL, ' +
      'ASSESSMENT_CANDIDATE_ID and ASSESSMENT_PROJECT_ID are not all configured.'
    );
  }

  const resolvedCandidateId =
    getHardcodedProjectCandidateId(loadTestToken, candidate.email, candidate.projectId) ||
    candidate.candidateId;

  // The pre-provisioned project is not part of the managed provisioning flow,
  // so it has no fresh accessMyPortal URL unless we dispatch its invitation in
  // this run. Match the response by candidate ID/email and pass only the URL
  // to the candidate flow; never log the token itself.
  const preProject = getProjectById(
    loadTestToken,
    candidate.projectId,
    'Get Pre-provisioned Project Details'
  );
  const emailTemplateId = getDefaultEmailTemplate(
    loadTestToken,
    preProject && preProject.emailTemplateId
  );
  const invitationResponse = sendInvitationsToProjectCandidates(
    loadTestToken,
    candidate.projectId,
    emailTemplateId,
    [resolvedCandidateId],
    [candidate.email]
  );
  const invitationHref = extractInvitationHref(
    invitationResponse,
    resolvedCandidateId,
    candidate.email
  );
  if (!invitationHref) {
    log(
      'Candidate Execution',
      `Pre-provisioned invitation did not return accessMyPortal for ${candidate.email}; skipping candidate.`
    );
    return {
      source: 'preprovisioned',
      candidateId: resolvedCandidateId,
      projectId: candidate.projectId,
      skipped: true,
      results: []
    };
  }

  log(
    'Candidate Execution',
    `Running pre-provisioned candidate ${candidate.email} on project ${candidate.projectId}`
  );

  return {
    source: 'preprovisioned',
    candidateId: resolvedCandidateId,
    projectId: candidate.projectId,
    results: performAllActivities(
      candidate.email,
      candidate.password || '',
      resolvedCandidateId,
      [],
      '',
      resolvedCandidateId,
      candidate.projectId,
      invitationHref
    )
  };
}

function hasCompletedTranscript(executions) {
  return executions.some((execution) =>
    execution &&
    Array.isArray(execution.results) &&
    execution.results.some((result) => result && result.status >= 200 && result.transcriptConfirmed)
  );
}

// ---------------------------------------------------------------------------
// default function (VU body)
// ---------------------------------------------------------------------------
export default function (data) {
  const candidateSource = resolveCandidateExecutionSource();
  log(
    'Flow',
    `Starting isolated flow: VU=${__VU}, iter=${__ITER}, mode=${LOAD_MODE}, ` +
    `scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}, scale=${LOAD_SCALE}, ` +
    `projectInvitations=${SEND_PROJECT_INVITATIONS}, candidateSource=${candidateSource}`
  );

  try {
    // Use dedicated load-test admin — NOT the real Super Admin.
    const loadTestToken = loadTestAdminLogin();
    if (!loadTestToken) {
      exec.test.abort('Load test admin login failed');
      return;
    }

    const { orgId, adminUserId } = createClient(loadTestToken);
    if (!orgId || !adminUserId) {
      throw new Error('Client creation did not return the organization/admin identifiers');
    }
    managedClientsCreated.add(1);

    // Register for teardown in smoke mode only (see cleanup.js note).
    if (data && data.registry && !data.isLoadMode) {
      registerOrg(data.registry, orgId);
    }

    const activities = createAllTaskTypes(loadTestToken);
    if (!activities.length) {
      throw new Error('No activities were created for the selected scenario');
    }
    assignTasksToOrg(loadTestToken, orgId, activities);

    const clientToken = impersonateClientAdmin(loadTestToken, adminUserId);
    if (!clientToken) {
      exec.test.abort('Client Admin impersonation failed');
      return;
    }

    const accountSetup = setupAccountAndSkillsProfile(clientToken, orgId);
    const projectOrgId = accountSetup.accountOrgId || orgId;

    if (data && data.registry && !data.isLoadMode && accountSetup.accountOrgId) {
      registerOrg(data.registry, accountSetup.accountOrgId);
    }

    const project = completeProjectCreationFlow(
      clientToken,
      projectOrgId,
      accountSetup.roleProfileId,
      activities
    );

    if (!project || !project.projectId || !project.candidateIds || !project.candidateIds.length) {
      throw new Error('Project creation did not return a project ID and generated candidate IDs');
    }
    managedProjectsCreated.add(1);

    if (data && data.registry && !data.isLoadMode) {
      registerProject(data.registry, project.projectId);
      (project.candidateIds || []).forEach((id) => registerCandidate(data.registry, id));
    }

    // SEND_PROJECT_INVITATIONS is the lifecycle gate — default is now false.
    if (!SEND_PROJECT_INVITATIONS) {
      log(
        'Flow',
        `Provisioning-only completion: project=${project.projectId}, candidates=${project.candidateCount}, ` +
        'SEND_PROJECT_INVITATIONS=false; candidate activity execution skipped.'
      );
      sleep(1);
      return;
    }

    if (!project.candidateExecutionAllowed) {
      throw new Error(
        `Project ${project.projectId} is not ACTIVE after invitation dispatch; candidate activity execution is blocked.`
      );
    }

    const executions = [];

    if (candidateSource === 'generated' || candidateSource === 'both') {
      executions.push(
        performGeneratedProjectCandidate(
          clientToken,
          project,
          projectOrgId,
          data && data.registry,
          data && data.isLoadMode
        )
      );
    }

    if (candidateSource === 'preprovisioned' || candidateSource === 'both') {
      executions.push(performPreprovisionedCandidate(loadTestToken));
    }

    if (candidateSource === 'none') {
      log('Candidate Execution', 'Skipped by CANDIDATE_EXECUTION_SOURCE=none.');
    }

    const generatedExecution = executions.find((e) => e && e.source === 'generated');
    const preprovisionedExecution = executions.find((e) => e && e.source === 'preprovisioned');

    if (candidateSource === 'generated' || candidateSource === 'both') {
      check(generatedExecution || {}, {
        'candidate execution: generated managed-project candidate ran': () => !!generatedExecution,
        'candidate execution: generated candidate produced activity results': () =>
          !!(generatedExecution && Array.isArray(generatedExecution.results) && generatedExecution.results.length > 0)
      });
    }

    if (candidateSource === 'preprovisioned' || candidateSource === 'both') {
        const preprovisionedSkipped = !!(preprovisionedExecution && preprovisionedExecution.skipped);
      if (preprovisionedSkipped) {
        log(
          'Candidate Execution',
          'Pre-provisioned candidate was skipped (no accessMyPortal URL returned). ' +
          'Activity-results check is waived because the generated candidate already completed all activities.'
        );
      }
      check(preprovisionedExecution || {}, {
        'candidate execution: configured pre-provisioned candidate ran': () => !!preprovisionedExecution,
        'candidate execution: pre-provisioned candidate produced activity results': () =>
          preprovisionedSkipped ||
          !!(preprovisionedExecution && Array.isArray(preprovisionedExecution.results) && preprovisionedExecution.results.length > 0)
      });
    }

    if (INCLUDE_PROJECT_REVIEW && hasCompletedTranscript(executions)) {
      if (generatedExecution) {
        runProjectReviewFlow(
          clientToken,
          project.projectId,
          [{ candidateId: generatedExecution.candidateId }]
        );
      } else {
        log(
          'Project Review',
          'Skipped: review is scoped to the generated managed project, but no generated candidate execution ran.'
        );
      }
    } else if (INCLUDE_PROJECT_REVIEW) {
      log('Project Review', 'Skipped because no completed activity contained confirmed transcript evidence');
    } else {
      log('Project Review', 'Skipped by configuration (INCLUDE_PROJECT_REVIEW=false)');
    }

    const summary = executions
      .map((e) => `${e.source}:${e.candidateId}@${e.projectId}`)
      .join(', ');
    log(
      'Flow',
      `Completed isolated flow for managed project=${project.projectId}; executions=${summary || 'none'}`
    );
    sleep(1);
  } catch (error) {
    log('Flow', `Unexpected error: ${error && error.message ? error.message : error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// teardown(data)
//
// Runs once after all VUs complete. Deletes all tracked resources.
// Smoke mode: deletes exactly what was registered during the single-VU run.
// Load mode: logs an operator notice (cross-VU registry not possible in k6).
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
    log(
      'Teardown',
      `LOAD MODE: ${LOAD_VUS} VU(s) each created independent org/project/candidates. ` +
      'These are NOT in the teardown registry (k6 cross-VU state is not shared). ' +
      'To clean up: search orgs with the "Load Test Org" prefix via the Super Admin portal ' +
      'or run a dedicated post-test cleanup script against the run report.'
    );
  }

  const result = cleanupRunResources(data.registry, data.superAdminToken);
  log(
    'Teardown',
    `Registry cleanup result: deleted=${result.deleted}, failed=${result.failed}, skipped=${result.skipped}`
  );
}

// ---------------------------------------------------------------------------
// handleSummary — produces HTML + JSON + CSV reports
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const name = reportName('report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  const csvBaseName = name.replace(/^report-/, 'symulate-report-');
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2),
    [`reports/${csvBaseName}-overview.csv`]: overviewCsv(data, name),
    [`reports/${csvBaseName}-summary.csv`]: summaryCsv(data),
    [`reports/${csvBaseName}-aggregate.csv`]: aggregateCsv(data),
    [`reports/${csvBaseName}-checks.csv`]: checksCsv(data)
  };
}

// ---------------------------------------------------------------------------
// CSV report helpers (unchanged from original)
// ---------------------------------------------------------------------------
function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  return `${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricValue(metric, key, fallback = 0) {
  return metric && metric.values && Number.isFinite(metric.values[key]) ? metric.values[key] : fallback;
}

function extractRequestLabel(metricName) {
  const match = metricName.match(/^http_req_duration\{name:(.+)\}$/);
  return match ? match[1] : null;
}

function requestRows(data) {
  const metrics = data.metrics || {};
  const durationSeconds = Math.max(metricValue(metrics.iteration_duration, 'avg') / 1000, 1);
  const totalDataReceived = metricValue(metrics.data_received, 'count');
  const totalDataSent = metricValue(metrics.data_sent, 'count') || metricValue(metrics.sent_bytes, 'count');
  const globalRequests = metricValue(metrics.http_reqs, 'count') || 1;
  const globalFailures = metricValue(metrics.http_req_failed, 'rate');

  return Object.keys(metrics)
    .map((name) => ({ label: extractRequestLabel(name), metric: metrics[name] }))
    .filter((row) => row.label)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, metric }) => {
      const samples = Math.round(metricValue(metric, 'count', globalRequests));
      const share = samples / globalRequests;
      const throughput = samples / durationSeconds;
      const receivedKbSec = (totalDataReceived * share) / 1024 / durationSeconds;
      const sentKbSec = (totalDataSent * share) / 1024 / durationSeconds;
      const avgBytes = samples ? (totalDataReceived * share) / samples : 0;
      return {
        label, samples,
        average: round(metricValue(metric, 'avg')),
        median: round(metricValue(metric, 'med')),
        p90: round(metricValue(metric, 'p(90)')),
        p95: round(metricValue(metric, 'p(95)')),
        p99: round(metricValue(metric, 'p(99)')),
        min: round(metricValue(metric, 'min')),
        max: round(metricValue(metric, 'max')),
        errorRate: round(globalFailures * 100, 4),
        throughput: round(throughput, 5),
        receivedKbSec: round(receivedKbSec, 2),
        sentKbSec: round(sentKbSec, 2),
        avgBytes: round(avgBytes, 1)
      };
    });
}

function overviewCsv(data, sourceName) {
  const metrics = data.metrics || {};
  return toCsv([
    ['Metric', 'Value'],
    ['Report Type', 'Symulate Load Test Report'],
    ['Source JSON', `${sourceName}.json`],
    ['Generated At', new Date().toISOString()],
    ['Mode', LOAD_MODE],
    ['Scenario', SCENARIO],
    ['Anam Enabled', ANUM_API_ENABLED],
    ['Total Requests', metricValue(metrics.http_reqs, 'count')],
    ['Failed Request %', round(metricValue(metrics.http_req_failed, 'rate') * 100, 4)],
    ['Checks Passed %', round(metricValue(metrics.checks, 'rate') * 100, 2)],
    ['Iterations', metricValue(metrics.iterations, 'count')]
  ]);
}

function summaryCsv(data) {
  const rows = requestRows(data);
  return toCsv([
    ['Label', '# Samples', 'Average', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec', 'Avg. Bytes'],
    ...rows.map((r) => [r.label, r.samples, r.average, r.min, r.max, r.errorRate, r.throughput, r.receivedKbSec, r.sentKbSec, r.avgBytes])
  ]);
}

function aggregateCsv(data) {
  const rows = requestRows(data);
  return toCsv([
    ['Label', '# Samples', 'Average', 'Median', '90% Line', '95% Line', '99% Line', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec'],
    ...rows.map((r) => [r.label, r.samples, r.average, r.median, r.p90, r.p95, r.p99, r.min, r.max, r.errorRate, r.throughput, r.receivedKbSec, r.sentKbSec])
  ]);
}

function checksCsv(data) {
  const rows = [];
  function collectChecks(group, prefix = '') {
    const groupName = group.name && group.name !== '' ? `${prefix}${group.name}` : prefix;
    for (const check of group.checks || []) {
      const passes = check.passes || 0;
      const fails = check.fails || 0;
      rows.push([groupName || 'default', check.name, passes, fails, round((passes / Math.max(passes + fails, 1)) * 100, 2)]);
    }
    for (const nested of group.groups || []) {
      collectChecks(nested, groupName ? `${groupName} / ` : '');
    }
  }
  collectChecks(data.root_group || {});
  return toCsv([['Group', 'Check', 'Passes', 'Fails', 'Pass %'], ...rows]);
}
