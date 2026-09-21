// scenarios/clientcreation.js
// Step 2: Super Admin creates a new Client (organization).
//
// CHANGED vs. original assumption:
// - CONFIRMED real payload (CreateOrganizationDto): { organizationName,
//   name, email, parentOrgId? } — NOT { clientName, adminName, adminEmail }.
//   Verified against a real captured 201 response, which returns
//   { data: { id, name, type, enableTalentIntelligence, ... } }.
// - There is NO separate "enable intelligence" endpoint. It's the boolean
//   `enableTalentIntelligence` field, toggled via
//   PATCH /organizations/{id} (UpdateOrganizationDto) after creation.

import { check } from 'k6';
import { postJson, patchJson, extractId } from '../utils/http.js';
import { logStep, log, uniqueSuffix } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { superAdminLogin } from './login.js';
import { ANUM_API_ENABLED, SEND_CLIENT_EMAIL } from '../config/environments.js';

export function createClient(token) {
  const suffix = uniqueSuffix();
  const clientEmail = `loadtest.admin.${suffix}@yopmail.com`;
  const payload = {
    organizationName: `Load Test Org ${suffix}`,
    name: `Load Test Admin ${suffix}`,
    email: clientEmail
  };

  if (SEND_CLIENT_EMAIL) {
    log('Create Client', `Client email: ${clientEmail}; notification email enabled (SEND_CLIENT_EMAIL=true)`);
  } else {
    log('Create Client', `Client email: ${clientEmail}; notification email disabled (SEND_CLIENT_EMAIL=false)`);
  }

  const res = postJson(routes.organizations(), payload, token, 'Create Client');
  logStep('Create Client', res);
  const orgId = extractId(res, 'id');
  const adminUserId = extractOwnerId(res);

  check(res, {
    'create client: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create client: organization id returned': () => !!orgId
  });

  if (ANUM_API_ENABLED && orgId) {
    enableIntelligence(token, orgId);
  }

  return { orgId, adminUserId, adminEmail: payload.email, clientName: payload.organizationName };
}

// Toggles Talent Intelligence (Anam) for the organization. The API uses a
// PATCH on the organization itself, not a dedicated endpoint.
export function enableIntelligence(token, orgId) {
  const res = patchJson(routes.organizationById(orgId), { enableTalentIntelligence: true }, token, 'Enable Intelligence (Anam)');
  logStep('Enable Intelligence (Anam)', res);
  check(res, { 'enable intelligence: status 2xx': (r) => r.status >= 200 && r.status < 300 });
  return res;
}

// BEST-EFFORT: the captured create-org response didn't include an
// admin/owner userId field directly (it showed ownerId: null on the new
// org, and a populated ownerId only on its parent). If impersonateClientAdmin()
// in scenarios/login.js comes back empty, confirm with Backend where the
// created admin's userId actually lives on this response.
function extractOwnerId(res) {
  try {
    const body = res.json();
    const data = body.data || body;
    return data.ownerId || (data.owner && data.owner.id) || null;
  } catch (e) {
    return null;
  }
}

// Standalone-runnable: `k6 run scenarios/clientcreation.js`
export default function () {
  const token = superAdminLogin();
  createClient(token);
}
