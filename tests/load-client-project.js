// tests/load-client-project.js
//
// Focused provisioning load: Super Admin login -> unique client -> scenario
// activities -> organization assignment -> Client Admin impersonation ->
// account/skills -> unique project and candidate set.
//
// LOAD_VUS=N and LOAD_ITERATIONS_PER_VU=1 creates exactly N independent
// client/project instances. No VU reuses another VU's generated resources.

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
  LOAD_ITERATIONS_PER_VU
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import { createClient } from '../scenarios/clientcreation.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import { completeProjectCreationFlow } from '../scenarios/projectcreation.js';

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
            maxDuration: __ENV.LOAD_MAX_DURATION || '20m',
            gracefulStop: '30s'
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

export default function () {
  log(
    'Client Project Load',
    `Starting isolated provisioning iteration: mode=${LOAD_MODE}, scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}`
  );

  const superAdminToken = superAdminLogin();
  if (!superAdminToken) throw new Error('Super Admin login failed');

  const { orgId, adminUserId } = createClient(superAdminToken);
  if (!orgId || !adminUserId) throw new Error('Client creation did not return required identifiers');
  managedClientsCreated.add(1);

  const activities = createAllTaskTypes(superAdminToken);
  assignTasksToOrg(superAdminToken, orgId, activities);

  const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
  if (!clientToken) throw new Error('Client Admin impersonation failed');

  const setup = setupAccountAndSkillsProfile(clientToken, orgId);
  const projectOrgId = setup.accountOrgId || orgId;
  const project = completeProjectCreationFlow(
    clientToken,
    projectOrgId,
    setup.roleProfileId,
    activities
  );

  if (!project || !project.projectId) throw new Error('Project creation did not return a project ID');
  managedProjectsCreated.add(1);

  log(
    'Client Project Load',
    `Completed isolated provisioning iteration: VU=${__VU}, iteration=${__ITER}, project=${project.projectId}, candidates=${project.candidateCount}`
  );
  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('client-project-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
