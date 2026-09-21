// scenarios/taskassign.js
// Step 4: Assign all created activities ("tasks") to the newly created
// client/org.
//
// CHANGED vs. original assumption: CONFIRMED real endpoint is
// POST /activities/assign-to-organizations, body
// { activityId, organizationIds: [...] } — one call per activity, org ids
// passed as an array (kept to a single-element array here since each load
// test run creates exactly one org).

import { check } from 'k6';
import { postJson } from '../utils/http.js';
import { logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { superAdminLogin } from './login.js';
import { createClient } from './clientcreation.js';
import { createAllTaskTypes } from './taskcreation.js';

export function assignTasksToOrg(token, orgId, activities) {
  const results = [];

  activities.forEach(({ activityId, type, label }) => {
    const res = postJson(
      routes.assignActivityToOrganizations(),
      { activityId, organizationIds: [orgId] },
      token,
      'Assign Task'
    );
    logStep(`Assign Task (${label})`, res);
    check(res, { [`assign task (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300 });
    results.push({ activityId, type, label, ok: res.status >= 200 && res.status < 300 });
  });

  return results;
}

// Standalone-runnable: `k6 run scenarios/taskassign.js`
export default function () {
  const token = superAdminLogin();
  const { orgId } = createClient(token);
  const activities = createAllTaskTypes(token);
  assignTasksToOrg(token, orgId, activities);
}
