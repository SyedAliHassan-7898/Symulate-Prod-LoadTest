// tests/discover-login.js
//
// Fast authentication smoke check for the configured Symulate API.
// This script intentionally redacts passwords, cookies, and tokens from logs.
//
// Usage:
//   npm run discover
//   k6 run -e API_URL=https://api.symulate.weuno.co/dev/api tests/discover-login.js

import { check } from 'k6';
import { postJson, extractToken } from '../utils/http.js';
import { routes } from '../utils/routes.js';
import { CREDENTIALS } from '../config/environments.js';

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ['rate==1.0'] }
};

function safeHeaders(headers = {}) {
  const out = {};
  Object.entries(headers).forEach(([key, value]) => {
    if (/set-cookie|authorization|cookie/i.test(key)) return;
    out[key] = value;
  });
  return out;
}

function responseSummary(res) {
  try {
    const body = res.json() || {};
    const data = body.data || {};
    const user = data.user || {};
    const organization = user.organization || data.organization || {};
    return {
      statusCode: body.statusCode,
      success: body.success,
      message: body.message,
      user: {
        id: user.id || null,
        email: user.email || null,
        role: user.role && user.role.name ? user.role.name : null
      },
      organization: {
        id: organization.id || null,
        name: organization.name || null,
        enableTalentIntelligence: organization.enableTalentIntelligence
      },
      accessTokenPresent: !!data.accessToken,
      refreshTokenPresent: !!data.refreshToken
    };
  } catch (_) {
    return { rawResponsePresent: !!(res && res.body) };
  }
}

export default function () {
  const url = routes.login();
  const payload = {
    email: CREDENTIALS.superAdmin.email,
    password: CREDENTIALS.superAdmin.password
  };

  console.log(`[Discover] POST ${url}`);
  console.log(`[Discover] Request: ${JSON.stringify({ email: payload.email, password: '<redacted>' })}`);

  const res = postJson(url, payload, null, 'Login - Super Admin (discover)');
  const token = extractToken(res);

  console.log(`[Discover] HTTP ${res.status}`);
  console.log(`[Discover] Response headers: ${JSON.stringify(safeHeaders(res.headers))}`);
  console.log(`[Discover] Response summary: ${JSON.stringify(responseSummary(res))}`);

  const ok = check(res, {
    'discover login: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'discover login: access token returned': () => !!token
  });

  if (!ok) {
    console.log('[Discover] Login validation failed. Verify API_URL, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, and the /auth/login contract.');
    return;
  }

  console.log('[Discover] Login validation passed. Access token was returned and intentionally not printed.');
}
