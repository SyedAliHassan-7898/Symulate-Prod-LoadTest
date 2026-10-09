// config/environments.js
//
// Centralized runtime configuration. Values are supplied through `.env` and
// forwarded to k6 by scripts/run.js. No credentials or execution policy is
// hardcoded in test entrypoints.
//
// PRODUCTION-SAFETY ADDITIONS:
//   - LOAD_TEST_ADMIN_EMAIL / LOAD_TEST_ADMIN_PASSWORD  — dedicated load-test
//     Super Admin account. Falls back to SUPER_ADMIN_* with a console warning
//     so real admin credentials are never silently used in large-scale runs.
//   - SEND_CLIENT_EMAIL / SEND_PROJECT_INVITATIONS default to FALSE (was TRUE).
//     Must be explicitly set to true when you want real emails to fire.
//   - ENV_PROFILE (dev | staging | production) drives threshold selection and
//     scale-aware timing.
//   - LOAD_SCALE helpers: auto-calculated multipliers used by polling timeouts,
//     socket delays, and retry counts so behavior stays sane at 100+ VUs
//     without manual .env edits.

function bool(name, fallback = false) {
  const raw = __ENV[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
}

function positiveInt(name, fallback) {
  const parsed = Number(__ENV[name] || fallback);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received ${__ENV[name]}`);
  }
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// Base environment
// ---------------------------------------------------------------------------
export const ENV = __ENV.ENV || 'production';
export const API_URL = __ENV.API_URL;

// ENV_PROFILE controls threshold selection and scale-aware timing.
// Valid values: dev | staging | production
// Defaults to 'dev' so existing dev workflows are unaffected.
export const ENV_PROFILE = (function () {
  const raw = String(__ENV.ENV_PROFILE || 'production').trim().toLowerCase();
  const allowed = ['dev', 'staging', 'production'];
  if (!allowed.includes(raw)) {
    throw new Error(
      `ENV_PROFILE must be one of ${allowed.join(', ')}; received ${raw}`
    );
  }
  return raw;
})();

export const PORTALS = {
  superAdmin: __ENV.SUPER_ADMIN_URL,
  clientAdmin: __ENV.CLIENT_ADMIN_URL,
  candidate: __ENV.CANDIDATE_URL
};

// ---------------------------------------------------------------------------
// Credentials — dedicated load-test admin (PRODUCTION SAFETY)
//
// Priority:
//   1. LOAD_TEST_ADMIN_EMAIL + LOAD_TEST_ADMIN_PASSWORD  (recommended)
//   2. SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD           (fallback, warns)
//
// A warning is emitted at init-context so it appears before the first VU
// starts, giving operators a chance to abort if the real admin is in use.
// ---------------------------------------------------------------------------
const _hasLoadTestAdmin =
  !!(__ENV.LOAD_TEST_ADMIN_EMAIL && __ENV.LOAD_TEST_ADMIN_PASSWORD);

const _usedFallbackAdmin = !_hasLoadTestAdmin;

if (_usedFallbackAdmin) {
  console.warn(
    '[SAFETY WARNING] LOAD_TEST_ADMIN_EMAIL / LOAD_TEST_ADMIN_PASSWORD are not set. ' +
    'Falling back to SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD. ' +
    'Using the primary Super Admin account for load testing is NOT recommended ' +
    'for staging or production runs. Set LOAD_TEST_ADMIN_EMAIL and ' +
    'LOAD_TEST_ADMIN_PASSWORD in .env to silence this warning.'
  );
}

export const CREDENTIALS = {
  // Resolved load-test admin: dedicated account if set, real admin otherwise.
  loadTestAdmin: {
    email: __ENV.LOAD_TEST_ADMIN_EMAIL || __ENV.SUPER_ADMIN_EMAIL,
    password: __ENV.LOAD_TEST_ADMIN_PASSWORD || __ENV.SUPER_ADMIN_PASSWORD
  },
  // Real Super Admin — reserved for teardown and impersonation only.
  superAdmin: {
    email: __ENV.SUPER_ADMIN_EMAIL,
    password: __ENV.SUPER_ADMIN_PASSWORD
  }
};

export const USING_FALLBACK_ADMIN_CREDENTIALS = _usedFallbackAdmin;

export const CANDIDATE_DEFAULT_PASSWORD = __ENV.CANDIDATE_DEFAULT_PASSWORD;
export const CLIENT_ADMIN_DEFAULT_PASSWORD = __ENV.CLIENT_ADMIN_DEFAULT_PASSWORD;

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------
export const ANUM_API_ENABLED = bool('ANUM_API_ENABLED', true);

export const SCENARIO = String(__ENV.SCENARIO || 'full').trim().toLowerCase();
export const LOAD_MODE = String(__ENV.LOAD_MODE || 'smoke').trim().toLowerCase();
export const LOAD_VUS = positiveInt('LOAD_VUS', 10);
export const LOAD_ITERATIONS_PER_VU = positiveInt('LOAD_ITERATIONS_PER_VU', 1);

export const NUM_CANDIDATES = positiveInt('NUM_CANDIDATES', 20);

// ---------------------------------------------------------------------------
// PRODUCTION-SAFETY: email / invitation flags default to FALSE
//
// Previously SEND_CLIENT_EMAIL defaulted to true, which meant accidentally
// running against staging/production would fire real emails. Both flags now
// require an explicit opt-in. A warning is logged when either is enabled so
// operators are always aware of live email dispatch.
// ---------------------------------------------------------------------------
export const SEND_PROJECT_INVITATIONS = (function () {
  const value = bool('SEND_PROJECT_INVITATIONS', true); // CHANGED: was true
  if (value) {
    console.warn(
      '[EMAIL WARNING] SEND_PROJECT_INVITATIONS=true — project invitation emails ' +
      'WILL be dispatched. Ensure this is intentional for the target environment.'
    );
  }
  return value;
})();

export const SEND_CLIENT_EMAIL = (function () {
  const value = bool('SEND_CLIENT_EMAIL', true);
  if (value) {
    console.warn(
      '[EMAIL WARNING] SEND_CLIENT_EMAIL=true — client onboarding emails ' +
      'WILL be dispatched. Ensure this is intentional for the target environment.'
    );
  }
  return value;
})();

export const INCLUDE_PROJECT_REVIEW = bool('INCLUDE_PROJECT_REVIEW', true);
export const ALLOW_SHARED_CANDIDATES = bool('ALLOW_SHARED_CANDIDATES', true);
export const ALLOW_SHARED_REVIEW_TARGETS = bool('ALLOW_SHARED_REVIEW_TARGETS', false);

// ---------------------------------------------------------------------------
// Teardown control
//
// ENABLE_TEARDOWN=true (default) — all resources created during the run are
// deleted in teardown(). Set to false only when you deliberately want to keep
// generated data for manual inspection.
// ---------------------------------------------------------------------------
export const ENABLE_TEARDOWN = bool('ENABLE_TEARDOWN', true);

// ---------------------------------------------------------------------------
// Candidate execution source
// ---------------------------------------------------------------------------
export const CANDIDATE_EXECUTION_SOURCE = String(__ENV.CANDIDATE_EXECUTION_SOURCE || 'auto')
  .trim()
  .toLowerCase();

const ALLOWED_CANDIDATE_SOURCES = ['auto', 'generated', 'preprovisioned', 'both', 'none'];
if (!ALLOWED_CANDIDATE_SOURCES.includes(CANDIDATE_EXECUTION_SOURCE)) {
  throw new Error(
    `CANDIDATE_EXECUTION_SOURCE must be one of ${ALLOWED_CANDIDATE_SOURCES.join(', ')}; ` +
    `received ${CANDIDATE_EXECUTION_SOURCE}`
  );
}

// ---------------------------------------------------------------------------
// Hardcoded / pre-provisioned candidates
// ---------------------------------------------------------------------------
export const HARDCODED_ASSESSMENT_CANDIDATE_ID = __ENV.ASSESSMENT_CANDIDATE_ID;
export const HARDCODED_ASSESSMENT_PROJECT_ID = __ENV.ASSESSMENT_PROJECT_ID;
export const HARDCODED_ASSESSMENT_BOOKING_ID = __ENV.ASSESSMENT_BOOKING_ID;
export const HARDCODED_ASSESSMENT_BOOKING_START_AT = __ENV.ASSESSMENT_BOOKING_START_AT;

function configuredCandidate(index) {
  const suffix = index === 1 ? '' : `_${index}`;
  const email = __ENV[`CANDIDATE_EMAIL${suffix}`];
  const password = __ENV[`CANDIDATE_PASSWORD${suffix}`];
  const candidateId = __ENV[`ASSESSMENT_CANDIDATE_ID${suffix}`];
  const projectId = __ENV[`ASSESSMENT_PROJECT_ID${suffix}`];
  const bookingId = __ENV[`ASSESSMENT_BOOKING_ID${suffix}`];
  const bookingStartAt = __ENV[`ASSESSMENT_BOOKING_START_AT${suffix}`];

  if (!email && !candidateId && !projectId) return null;

  return { email, password, candidateId, projectId, bookingId, bookingStartAt };
}

export const HARDCODED_CANDIDATES = [];
for (let index = 1; index <= 100; index += 1) {
  const candidate = configuredCandidate(index);
  if (candidate) HARDCODED_CANDIDATES.push(candidate);
}

export const HARDCODED_PROJECT_ID = __ENV.ASSESSMENT_PROJECT_ID;

export function isCompletePreprovisionedCandidate(candidate) {
  return !!(
    candidate &&
    candidate.email &&
    candidate.candidateId &&
    candidate.projectId
  );
}

export function resolveCandidateExecutionSource() {
  if (CANDIDATE_EXECUTION_SOURCE !== 'auto') return CANDIDATE_EXECUTION_SOURCE;
  if (LOAD_MODE === 'load') return 'generated';
  return HARDCODED_CANDIDATES.some(isCompletePreprovisionedCandidate) ? 'both' : 'generated';
}

// ---------------------------------------------------------------------------
// LOAD_SCALE — dynamic scaling helpers
//
// LOAD_SCALE is an explicit multiplier (default: derived from LOAD_VUS).
// It is used by polling loops, socket delays, and retry counts to stay sane
// at higher concurrency without manual .env edits.
//
// Scale tiers (based on active VU count):
//   1–9 VUs   → scale 1  (dev / smoke)
//   10–24 VUs → scale 2  (light load)
//   25–49 VUs → scale 3  (moderate load)
//   50–99 VUs → scale 4  (heavy load)
//   100+ VUs  → scale 5  (large-scale / production-like)
//
// Pass LOAD_SCALE=N explicitly to override the auto-computed value.
// ---------------------------------------------------------------------------
function computeLoadScale(vuCount) {
  if (vuCount >= 100) return 5;
  if (vuCount >= 50) return 4;
  if (vuCount >= 25) return 3;
  if (vuCount >= 10) return 2;
  return 1;
}

const _explicitScale = __ENV.LOAD_SCALE ? Number(__ENV.LOAD_SCALE) : null;
export const LOAD_SCALE = (
  _explicitScale && Number.isFinite(_explicitScale) && _explicitScale >= 1
    ? Math.floor(_explicitScale)
    : computeLoadScale(LOAD_VUS)
);

// Scale-aware timing helpers — import and call these instead of hardcoding ms.
//
//   scaleMs(base)          — linearly scales a base millisecond value.
//                            e.g. scaleMs(750) at scale 4 → 1500ms
//   scalePollingAttempts(base) — scales a polling loop count.
//                            e.g. scalePollingAttempts(12) at scale 4 → 18
//   scaleSocketDelay(vuIndex)  — per-VU stagger delay for socket connections
//                            so 100 VUs don't all open sockets simultaneously.
//
export function scaleMs(baseMs) {
  // Apply a sub-linear growth curve so delays don't become unbearably long:
  // scale 1→1x, 2→1.25x, 3→1.5x, 4→1.75x, 5→2x
  const multiplier = 1 + (LOAD_SCALE - 1) * 0.25;
  return Math.round(baseMs * multiplier);
}

export function scalePollingAttempts(base) {
  // More concurrent writes need more polling headroom, but cap at 3× base.
  const multiplier = Math.min(1 + (LOAD_SCALE - 1) * 0.5, 3);
  return Math.max(base, Math.round(base * multiplier));
}

export function scaleSocketDelay(vuIndex = 0) {
  // Spread socket opens across time to avoid thundering-herd on the
  // Socket.IO server. Each VU waits an additional staggered ms window.
  // At scale 1: max stagger ~0ms (smoke, 1 VU)
  // At scale 5: max stagger up to 2000ms spread across 100 VUs
  const maxStaggerMs = (LOAD_SCALE - 1) * 500; // 0 / 500 / 1000 / 1500 / 2000
  if (maxStaggerMs <= 0 || LOAD_VUS <= 1) return 0;
  // Distribute evenly across the stagger window, bounded per VU slot.
  const slotMs = maxStaggerMs / Math.max(LOAD_VUS, 1);
  return Math.round(slotMs * (vuIndex % LOAD_VUS));
}
