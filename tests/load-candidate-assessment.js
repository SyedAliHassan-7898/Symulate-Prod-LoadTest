// tests/load-candidate-assessment.js
//
// Focused candidate-assessment load against pre-provisioned candidates.
// This command does not create projects. Configure one candidate/project pair
// per VU (`CANDIDATE_EMAIL_2`, `ASSESSMENT_CANDIDATE_ID_2`, etc.) or explicitly
// enable contention with ALLOW_SHARED_CANDIDATES=true.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { htmlReport } from '../utils/local-report.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import {
  LOAD_MODE,
  SCENARIO,
  ANUM_API_ENABLED,
  HARDCODED_CANDIDATES,
  HARDCODED_PROJECT_ID,
  ALLOW_SHARED_CANDIDATES
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { getActivitiesFromProject, performAllActivities } from '../scenarios/candidateassessment.js';
import { candidateLogin } from '../scenarios/login.js';

const LOAD_VUS = Math.max(1, Number(__ENV.LOAD_VUS || 1));
const ITERATIONS_PER_VU = Math.max(1, Number(__ENV.LOAD_ITERATIONS_PER_VU || 1));

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds(),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          candidate_assessment_load: {
            executor: 'per-vu-iterations',
            vus: LOAD_VUS,
            iterations: ITERATIONS_PER_VU,
            maxDuration: __ENV.LOAD_MAX_DURATION || '20m',
            gracefulStop: '30s'
          }
        }
      : {
          candidate_assessment_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m',
            gracefulStop: '30s'
          }
        }
};

export function setup() {
  if (!HARDCODED_CANDIDATES.length) {
    exec.test.abort('No pre-provisioned candidate is configured. Populate CANDIDATE_EMAIL and ASSESSMENT_CANDIDATE_ID/PROJECT_ID in .env.');
  }

  if (LOAD_MODE === 'load' && HARDCODED_CANDIDATES.length < LOAD_VUS && !ALLOW_SHARED_CANDIDATES) {
    exec.test.abort(
      `Candidate load requires at least ${LOAD_VUS} configured candidates, but only ${HARDCODED_CANDIDATES.length} were found. ` +
      'Add suffixed candidate variables or set ALLOW_SHARED_CANDIDATES=true for an intentional contention test.'
    );
  }
}

export default function () {
  const candidateIndex = ALLOW_SHARED_CANDIDATES
    ? (__VU - 1) % HARDCODED_CANDIDATES.length
    : __VU - 1;
  const candidate = HARDCODED_CANDIDATES[candidateIndex];

  if (!candidate) {
    throw new Error(`No configured candidate is available for VU ${__VU}`);
  }

  log(
    'Candidate Load',
    `Starting candidate iteration: VU=${__VU}, candidate=${candidate.email || candidate.candidateId}, scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}`
  );

  const loginResult = candidateLogin(candidate.email, candidate.password);
  const candidateToken = loginResult && loginResult.token;
  if (!candidateToken) throw new Error(`Candidate login failed for VU ${__VU}`);

  const candidateId = loginResult.candidateId || candidate.candidateId;
  const organizationId = loginResult.organizationId || __ENV.CANDIDATE_ORG_ID || '';
  const projectId = candidate.projectId || HARDCODED_PROJECT_ID;

  if (!candidateId || !projectId) {
    throw new Error(`Candidate/project identifiers are incomplete for VU ${__VU}`);
  }

  const activities = getActivitiesFromProject(candidateToken, candidateId, projectId);
  performAllActivities(
    candidate.email,
    candidate.password,
    candidateId,
    activities,
    organizationId,
    candidateId,
    projectId
  );

  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('candidate-assessment-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
