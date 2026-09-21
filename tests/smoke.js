// tests/smoke.js
//
// Managed end-to-end smoke/load flow.
//
// Each VU/iteration owns its own organization, activities, project and
// generated candidate data. Candidate execution is lifecycle-gated by
// SEND_PROJECT_INVITATIONS and selected with CANDIDATE_EXECUTION_SOURCE.
// In load mode one isolated provisioning iteration runs per VU.

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
  INCLUDE_PROJECT_REVIEW,
  SEND_PROJECT_INVITATIONS,
  HARDCODED_CANDIDATES,
  resolveCandidateExecutionSource,
  isCompletePreprovisionedCandidate
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';

import { superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import { completeProjectCreationFlow } from '../scenarios/projectcreation.js';
import {
  performAllActivities,
  getActivitiesFromProject,
  getHardcodedProjectCandidateId
} from '../scenarios/candidateassessment.js';
import { runProjectReviewFlow } from '../scenarios/projectreview.js';

const LOAD_MAX_DURATION = __ENV.LOAD_MAX_DURATION || '30m';
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
            maxDuration: LOAD_MAX_DURATION,
            gracefulStop: '30s'
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

function performGeneratedProjectCandidate(clientToken, project, projectOrgId) {
  const candidateId = project.candidateIds[0];
  const candidateEmail = project.candidates[0] && project.candidates[0].email;

  if (!candidateId || !candidateEmail) {
    throw new Error('Generated candidate execution requires the first managed candidate ID and email.');
  }

  const projectActivities = getActivitiesFromProject(
    clientToken,
    candidateId,
    project.projectId
  );
  if (!projectActivities.length) {
    throw new Error(`No activities were resolved for generated project ${project.projectId}.`);
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
      projectActivities,
      projectOrgId,
      candidateId,
      project.projectId
    )
  };
}

function performPreprovisionedCandidate(superAdminToken) {
  const candidate = HARDCODED_CANDIDATES.find(isCompletePreprovisionedCandidate);
  if (!candidate) {
    throw new Error(
      'CANDIDATE_EXECUTION_SOURCE requires a pre-provisioned candidate, but CANDIDATE_EMAIL, ' +
      'ASSESSMENT_CANDIDATE_ID and ASSESSMENT_PROJECT_ID are not all configured.'
    );
  }

  // Resolve the project-candidate identifier from the configured project when
  // possible. The super-admin token is used because the freshly-created client
  // admin must not be used to read an unrelated pre-provisioned project.
  const resolvedCandidateId =
    getHardcodedProjectCandidateId(superAdminToken, candidate.email, candidate.projectId) ||
    candidate.candidateId;

  const projectActivities = getActivitiesFromProject(
    superAdminToken,
    resolvedCandidateId,
    candidate.projectId
  );
  if (!projectActivities.length) {
    throw new Error(
      `No activities were resolved for pre-provisioned project ${candidate.projectId}. ` +
      'Verify ASSESSMENT_PROJECT_ID and candidate assignment.'
    );
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
      projectActivities,
      '',
      resolvedCandidateId,
      candidate.projectId
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

export default function () {
  const candidateSource = resolveCandidateExecutionSource();
  log(
    'Flow',
    `Starting isolated flow: mode=${LOAD_MODE}, scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}, ` +
    `projectInvitations=${SEND_PROJECT_INVITATIONS}, candidateSource=${candidateSource}, iteration=${__ITER}`
  );

  try {
    const superAdminToken = superAdminLogin();
    if (!superAdminToken) {
      exec.test.abort('Super Admin login failed');
      return;
    }

    const { orgId, adminUserId } = createClient(superAdminToken);
    if (!orgId || !adminUserId) {
      throw new Error('Client creation did not return the organization/admin identifiers required by the next steps');
    }
    managedClientsCreated.add(1);

    const activities = createAllTaskTypes(superAdminToken);
    if (!activities.length) {
      throw new Error('No activities were created for the selected scenario');
    }
    assignTasksToOrg(superAdminToken, orgId, activities);

    const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
    if (!clientToken) {
      exec.test.abort('Client Admin impersonation failed');
      return;
    }

    const accountSetup = setupAccountAndSkillsProfile(clientToken, orgId);
    const projectOrgId = accountSetup.accountOrgId || orgId;
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

    // SEND_PROJECT_INVITATIONS is the lifecycle gate for managed smoke runs.
    // false means provisioning-only: candidates are uploaded/assigned but no
    // portal session, booking, transcript socket, or COMPLETED status call is
    // allowed to execute. No runner is allowed to override this .env value.
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
      executions.push(performGeneratedProjectCandidate(clientToken, project, projectOrgId));
    }

    if (candidateSource === 'preprovisioned' || candidateSource === 'both') {
      executions.push(performPreprovisionedCandidate(superAdminToken));
    }

    if (candidateSource === 'none') {
      log('Candidate Execution', 'Skipped by CANDIDATE_EXECUTION_SOURCE=none.');
    }

    const generatedExecution = executions.find((execution) => execution && execution.source === 'generated');
    const preprovisionedExecution = executions.find((execution) => execution && execution.source === 'preprovisioned');

    if (candidateSource === 'generated' || candidateSource === 'both') {
      check(generatedExecution || {}, {
        'candidate execution: generated managed-project candidate ran': () => !!generatedExecution,
        'candidate execution: generated candidate produced activity results': () =>
          !!(generatedExecution && Array.isArray(generatedExecution.results) && generatedExecution.results.length > 0)
      });
    }

    if (candidateSource === 'preprovisioned' || candidateSource === 'both') {
      check(preprovisionedExecution || {}, {
        'candidate execution: configured pre-provisioned candidate ran': () => !!preprovisionedExecution,
        'candidate execution: pre-provisioned candidate produced activity results': () =>
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
      .map((execution) => `${execution.source}:${execution.candidateId}@${execution.projectId}`)
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

// Produces a self-contained HTML report + JSON summary on every run.
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
        label,
        samples,
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
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.min,
      row.max,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec,
      row.avgBytes
    ])
  ]);
}

function aggregateCsv(data) {
  const rows = requestRows(data);
  return toCsv([
    ['Label', '# Samples', 'Average', 'Median', '90% Line', '95% Line', '99% Line', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.median,
      row.p90,
      row.p95,
      row.p99,
      row.min,
      row.max,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec
    ])
  ]);
}

function checksCsv(data) {
  const rows = [];

  function collectChecks(group, prefix = '') {
    const groupName = group.name && group.name !== '' ? `${prefix}${group.name}` : prefix;
    for (const check of group.checks || []) {
      const passes = check.passes || 0;
      const fails = check.fails || 0;
      rows.push([
        groupName || 'default',
        check.name,
        passes,
        fails,
        round((passes / Math.max(passes + fails, 1)) * 100, 2)
      ]);
    }
    for (const nested of group.groups || []) {
      collectChecks(nested, groupName ? `${groupName} / ` : '');
    }
  }

  collectChecks(data.root_group || {});
  return toCsv([['Group', 'Check', 'Passes', 'Fails', 'Pass %'], ...rows]);
}