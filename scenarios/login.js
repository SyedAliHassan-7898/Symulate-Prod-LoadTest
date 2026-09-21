// scenarios/login.js
// Authentication helpers for Super Admin, Client Admin impersonation, and
// candidate sessions. Managed assessment flows use candidate portal tokens
// because that token is scoped to the candidate/project assignment used by the
// booking service.

import { check } from 'k6';
import { postJson, getJson, extractToken } from '../utils/http.js';
import { logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { CREDENTIALS, CANDIDATE_DEFAULT_PASSWORD } from '../config/environments.js';

export function superAdminLogin() {
  const res = postJson(
    routes.login(),
    { email: CREDENTIALS.superAdmin.email, password: CREDENTIALS.superAdmin.password },
    null,
    'Login - Super Admin'
  );
  logStep('Login - Super Admin', res);
  const token = extractToken(res);
  check(res, {
    'super admin login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'super admin login: token returned': () => !!token
  });
  return token;
}

// Client Admin logs in with the admin email/password captured when the
// client/org was created (scenarios/clientcreation.js). Only works once the
// real activation-email flow is confirmed and the admin actually has a
// password set — until then prefer impersonateClientAdmin() below.
export function clientAdminLogin(email, password) {
  const res = postJson(routes.login(), { email, password }, null, 'Login - Client Admin');
  logStep('Login - Client Admin', res);
  const token = extractToken(res);
  check(res, {
    'client admin login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'client admin login: token returned': () => !!token
  });
  return token;
}

// Super Admin impersonates the newly created Client Admin user, so the load
// test can proceed without knowing that admin's real (emailed) password.
// Two calls: get a short-lived impersonation token for the target userId,
// then redeem it for a full access token via verify-impersonate-user.
export function impersonateClientAdmin(superAdminToken, adminUserId) {
  const startRes = postJson(
    routes.impersonateUser(),
    { userId: adminUserId },
    superAdminToken,
    'Impersonate Client Admin (start)'
  );
  logStep('Impersonate Client Admin (start)', startRes);
  const directAccessToken = safeField(startRes, 'accessToken') || safeField(startRes, 'access_token');
  if (directAccessToken) {
    check(startRes, {
      'impersonate start: status 2xx': (r) => r.status >= 200 && r.status < 300,
      'impersonate start: access token returned': () => !!directAccessToken
    });

    const verifiedDirectToken = verifyImpersonationToken(directAccessToken);
    return verifiedDirectToken || directAccessToken;
  }

  const impersonationToken = safeField(startRes, 'token');
  check(startRes, { 'impersonate start: status 2xx': (r) => r.status >= 200 && r.status < 300 });
  if (!impersonationToken) return null;

  return verifyImpersonationToken(impersonationToken);
}

function verifyImpersonationToken(impersonationToken) {
  const verifyRes = postJson(
    routes.verifyImpersonateUser(),
    { token: impersonationToken },
    null,
    'Impersonate Client Admin (verify)'
  );
  logStep('Impersonate Client Admin (verify)', verifyRes);
  const clientToken = extractToken(verifyRes);
  check(verifyRes, {
    'impersonate verify: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'impersonate verify: token returned': () => !!clientToken
  });
  return clientToken;
}

// Candidate login — CONFIRMED to be plain email/password against
// /auth/candidate/login, same LoginResponseDto shape as the other logins.
// Returns { token, organizationId } — organizationId is extracted from the
// candidate's organizations array in the response (needed for theme + activities).
export function candidateLogin(email, password = CANDIDATE_DEFAULT_PASSWORD) {
  const res = postJson(routes.candidateLogin(), { email, password }, null, 'Login - Candidate');
  logStep('Login - Candidate', res);
  const token = extractToken(res);
  check(res, {
    'candidate login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'candidate login: token returned': () => !!token
  });

  let organizationId = null;
  let candidateId = null;
  try {
    const body = res.json();
    const data = body.data || body;
    const user = data.user || data.candidate || data.profile || data;
    candidateId = user.id || user.userId || user.candidateId || null;
    const orgs = (body.data && body.data.organizations) || [];
    if (orgs.length > 0) {
      organizationId = orgs[0].organizationId;
    }
  } catch (e) {
    // ignore parse errors
  }

  // Fallback: if login response didn't include organizations, fetch from
  // the candidate profile endpoint (GET /users/me)
  if (token && (!organizationId || !candidateId)) {
    try {
      const profileRes = getJson(routes.currentCandidateProfile(), token, 'Get Candidate Profile (orgId fallback)');
      logStep('Get Candidate Profile (orgId fallback)', profileRes);
      const profile = profileRes.json();
      const profileData = profile.data || profile;
      const profileUser = profileData.user || profileData.candidate || profileData.profile || profileData;
      candidateId = profileUser.id || profileUser.userId || profileUser.candidateId || candidateId || null;
      const orgs = (profile.data && profile.data.organizations) || profile.organizations || [];
      if (orgs.length > 0) {
        organizationId = orgs[0].organizationId;
      }
    } catch (e) {
      // ignore — organizationId stays null, getTheme will be skipped
    }
  }

  return { token, organizationId, candidateId };
}

// Candidate login via portal-tokens — CONFIRMED against a real browser HAR
// capture AND booking-flow-api-sequence.json as the ACTUAL session type the
// candidate portal uses (POST /auth/candidate/portal-tokens). In the
// captured JWT, `sub` === the response's own `candidateId` field, which is
// the same id the booking service checks ProjectCandidates against — unlike
// candidateLogin() above, whose token's `sub` does not reliably match a
// ProjectCandidates.candidateId, causing every booking call to 404 with
// "Candidate is not assigned to this project" regardless of the real
// assignment.
//
// The endpoint accepts EITHER { portalToken } (from the invite email link —
// blocked here by captcha on yopmail) OR { candidateId, projectId } directly
// (per booking-flow-api-sequence.json body schema) — so this suite can mint
// a real, booking-capable candidate session without ever touching email.
export function candidatePortalTokenLogin(candidateId, projectId) {
  const res = postJson(
    routes.candidatePortalTokens(),
    { candidateId, projectId },
    null,
    'Login - Candidate (portal-tokens)'
  );
  logStep('Login - Candidate (portal-tokens)', res);
  const token = extractToken(res);
  check(res, {
    'candidate portal-token login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'candidate portal-token login: token returned': () => !!token
  });

  let resolvedCandidateId = candidateId;
  let organizationId = null;
  let parentOrganizationId = null;
  let refreshToken = null;
  try {
    const body = res.json();
    const data = body.data || body;
    resolvedCandidateId = data.candidateId || candidateId;
    organizationId = data.organizationId || null;
    parentOrganizationId = data.parentOrganizationId || null;
    refreshToken = data.refreshToken || null;
  } catch (e) {
    // ignore parse errors
  }

  return { token, refreshToken, candidateId: resolvedCandidateId, organizationId, parentOrganizationId };
}

function safeField(res, key) {
  try {
    const body = res.json();
    return body[key] || (body.data && body.data[key]) || null;
  } catch (e) {
    return null;
  }
}

// Standalone-runnable: `k6 run scenarios/login.js`
export default function () {
  superAdminLogin();
} 