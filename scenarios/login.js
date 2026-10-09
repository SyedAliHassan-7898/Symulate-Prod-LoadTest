// scenarios/login.js
// Authentication helpers for Super Admin, Client Admin impersonation, and
// candidate sessions. Managed assessment flows use candidate portal tokens
// because that token is scoped to the candidate/project assignment used by the
// booking service.
//
// PRODUCTION-SAFETY ADDITION:
//   loadTestAdminLogin() — uses CREDENTIALS.loadTestAdmin (the dedicated load-test
//   account from environments.js). Falls back to the real Super Admin with a
//   runtime warning if the dedicated account is not configured. All load test
//   VU functions should call this instead of superAdminLogin() directly so that
//   the primary Super Admin account is never hammered by 100+ concurrent logins.
//
//   superAdminLogin() is retained for teardown() and impersonation flows that
//   genuinely need the real Super Admin account.

import { check } from 'k6';
import { postJson, getJson, extractToken } from '../utils/http.js';
import { logStep, log } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import {
  CREDENTIALS,
  CANDIDATE_DEFAULT_PASSWORD,
  USING_FALLBACK_ADMIN_CREDENTIALS
} from '../config/environments.js';

// ---------------------------------------------------------------------------
// loadTestAdminLogin()
//
// Preferred entry point for all VU-scoped provisioning work.
// Uses the dedicated LOAD_TEST_ADMIN_EMAIL / LOAD_TEST_ADMIN_PASSWORD account.
// If those are not configured, falls back to the real Super Admin and emits a
// per-VU runtime warning so operators can see it in the k6 output even after
// the init-context warning has scrolled away.
// ---------------------------------------------------------------------------
export function loadTestAdminLogin() {
  if (USING_FALLBACK_ADMIN_CREDENTIALS) {
    log(
      'Auth',
      '[SAFETY WARNING] No dedicated load-test admin configured. ' +
      'Falling back to SUPER_ADMIN credentials for this VU. ' +
      'Set LOAD_TEST_ADMIN_EMAIL + LOAD_TEST_ADMIN_PASSWORD in .env ' +
      'to remove this warning and avoid hammering the primary admin account.'
    );
  }

  const { email, password } = CREDENTIALS.loadTestAdmin;
  const res = postJson(
    routes.login(),
    { email, password },
    null,
    'Login - Load Test Admin'
  );
  logStep('Login - Load Test Admin', res);
  const token = extractToken(res);
  check(res, {
    'load test admin login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'load test admin login: token returned': () => !!token
  });
  return token;
}

// ---------------------------------------------------------------------------
// superAdminLogin()
//
// Always uses the REAL Super Admin credentials (SUPER_ADMIN_EMAIL/PASSWORD).
// Reserved for:
//   - teardown() cleanup operations
//   - impersonateClientAdmin() calls that require full admin privileges
//   - standalone scenario scripts (k6 run scenarios/login.js)
//
// Do NOT call this inside a VU default function for provisioning work —
// use loadTestAdminLogin() instead.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// clientAdminLogin()
//
// Client Admin logs in with the admin email/password captured when the
// client/org was created. Only works once the real activation-email flow is
// confirmed and the admin actually has a password set — until then prefer
// impersonateClientAdmin() below.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// impersonateClientAdmin()
//
// Super Admin impersonates the newly created Client Admin user, so the load
// test can proceed without knowing that admin's real (emailed) password.
// Two calls: get a short-lived impersonation token for the target userId,
// then redeem it for a full access token via verify-impersonate-user.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// candidateLogin()
//
// Plain email/password login for candidates. Returns { token, organizationId,
// candidateId }. Note: the resulting JWT's sub does not reliably match
// ProjectCandidates.candidateId — use candidatePortalTokenLogin() instead for
// any flow that involves booking/entry-check.
// ---------------------------------------------------------------------------
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
    if (orgs.length > 0) organizationId = orgs[0].organizationId;
  } catch (e) {
    // ignore parse errors
  }

  if (token && (!organizationId || !candidateId)) {
    try {
      const profileRes = getJson(routes.currentCandidateProfile(), token, 'Get Candidate Profile (orgId fallback)');
      logStep('Get Candidate Profile (orgId fallback)', profileRes);
      const profile = profileRes.json();
      const profileData = profile.data || profile;
      const profileUser = profileData.user || profileData.candidate || profileData.profile || profileData;
      candidateId = profileUser.id || profileUser.userId || profileUser.candidateId || candidateId || null;
      const orgs = (profile.data && profile.data.organizations) || profile.organizations || [];
      if (orgs.length > 0) organizationId = orgs[0].organizationId;
    } catch (e) {
      // ignore — organizationId stays null
    }
  }

  return { token, organizationId, candidateId };
}

// ---------------------------------------------------------------------------
// candidatePortalTokenLogin()
//
// Candidate login via portal-tokens — the ACTUAL session type the candidate
// portal uses. The resulting JWT's sub === candidateId, which is what the
// booking service checks against ProjectCandidates. Accepts { candidateId,
// projectId } directly without touching yopmail/captcha.
// ---------------------------------------------------------------------------
export function candidatePortalTokenLogin(candidateId, projectId) {
  const res = postJson(
    routes.candidatePortalTokens(),
    { candidateId, projectId },
    null,
    'Login - Candidate (portal-tokens)'
  );
  logStep('Login - Candidate (portal-tokens)', res);
  const token = extractToken(res);

  // The portal-tokens endpoint is deprecated on some environments and may
  // return 404. Treat a missing token as a soft failure — the caller decides
  // whether to abort or fall back to the invitation-href flow.
  const isAvailable = res.status !== 404;
  check(res, {
    'candidate portal-token login: status 2xx': (r) => !isAvailable || (r.status >= 200 && r.status < 300),
    'candidate portal-token login: token returned': () => !isAvailable || !!token
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
