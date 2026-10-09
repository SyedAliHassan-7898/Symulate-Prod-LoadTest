// config/thresholds.js
//
// Central pass/fail budgets for Symulate load tests.
//
// PROFILE SELECTION ORDER (first match wins):
//   1. PERFORMANCE_PROFILE env var (strict | baseline | functional | auto)
//   2. ENV_PROFILE env var (production | staging | dev) mapped to thresholds
//   3. LOAD_MODE (smoke → strict, load → baseline) when both above are 'auto'
//
// ENV_PROFILE → threshold mapping:
//   production  → strict    (tight latency SLOs; any p95 regression fails CI)
//   staging     → standard  (intermediate — tighter than baseline, more
//                            realistic than strict for a pre-prod environment)
//   dev         → baseline  (concurrency-aware; setup queueing tolerated)
//
// PERFORMANCE_PROFILE values (explicitly overrides ENV_PROFILE):
//   auto        → resolves via ENV_PROFILE / LOAD_MODE as above
//   strict      → latency-sensitive regression gate
//   standard    → staging-grade intermediate profile
//   baseline    → concurrency-aware load gate for dev environment
//   functional  → only correctness / request-failure gates; latency reported
//
// Dynamic scaling note:
//   LOAD_SCALE (computed in config/environments.js) further widens p99
//   thresholds at higher VU counts so the test gate doesn't fail purely
//   because of environment queueing under concurrent provisioning writes.
//   p95 thresholds are intentionally kept fixed — they should reflect the
//   SLO of a single request path, not how loaded the environment is.

// ---------------------------------------------------------------------------
// Default (global) thresholds
// ---------------------------------------------------------------------------
const STRICT_DEFAULT_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<2000', 'p(99)<3500'],
  checks: ['rate>0.99']
};

const STANDARD_DEFAULT_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<2000', 'p(99)<6000'],
  checks: ['rate>0.99']
};

const BASELINE_DEFAULT_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<2000', 'p(99)<12000'],
  checks: ['rate>0.99']
};

const FUNCTIONAL_DEFAULT_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  checks: ['rate>0.99']
};

// ---------------------------------------------------------------------------
// Per-step thresholds (p95 per named request)
// p95 is kept constant across profiles — it is an SLO on the request path
// itself and should not depend on how many VUs are running.
// p99 is widened per-profile and then further widened by LOAD_SCALE in
// buildThresholds() to tolerate environment queueing at high concurrency.
// ---------------------------------------------------------------------------
const STEP_P95 = {
  'Login - Super Admin':                    1500,
  'Login - Client Admin':                   1500,
  'Login - Candidate (access token)':       1500,
  'Create Client':                          2000,
  'Enable Intelligence (Anam)':             2500,
  'Create Task':                            2500,
  'Assign Task':                            2000,
  'Create Project':                         2000,
  'Import Candidates (CSV)':                3000,
  'Get Assigned Activities':                1500,
  'Submit Activity':                        3000,
  'Submit Activity (Anam evaluation)':      5000,
  'Project Review - Get Activity Score':    2000,
  'Project Review - Save Sub Skill Review': 1500,
  'Project Review - Get Summary':           1500,
  'Project Review - Submit Review':         2000,
  'Project Review - Get Report':            2000
};

// p99 multipliers applied on top of the p95 base, per profile.
// These reflect realistic tail latency under concurrent provisioning writes.
const P99_MULTIPLIER = {
  strict:     1.75,  // ~75% above p95  (tight; minimal tail tolerance)
  standard:   2.5,   // ~2.5× p95       (staging-grade; moderate tail)
  baseline:   5.0,   // ~5× p95         (dev; large tail for queueing writes)
  functional: null   // no latency gate
};

// ---------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------
function runtimeValue(name, fallback = '') {
  if (typeof __ENV === 'undefined' || __ENV === null) return fallback;
  const value = __ENV[name];
  return value === undefined || value === null || String(value).trim() === ''
    ? fallback
    : String(value).trim();
}

function resolveLoadScale() {
  const raw = Number(runtimeValue('LOAD_SCALE', '1'));
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

function resolveEnvProfile() {
  const raw = runtimeValue('ENV_PROFILE', 'dev').toLowerCase();
  const map = { production: 'strict', staging: 'standard', dev: 'baseline' };
  return map[raw] || 'baseline';
}

function resolveProfile() {
  const configured = runtimeValue('PERFORMANCE_PROFILE', 'auto').toLowerCase();
  const allowed = ['auto', 'strict', 'standard', 'baseline', 'functional'];

  if (!allowed.includes(configured)) {
    throw new Error(
      `PERFORMANCE_PROFILE must be one of ${allowed.join(', ')}; received ${configured}`
    );
  }

  if (configured !== 'auto') return configured;

  // Auto: ENV_PROFILE takes precedence over LOAD_MODE heuristic.
  const envProfile = runtimeValue('ENV_PROFILE', '').toLowerCase();
  if (envProfile === 'production') return 'strict';
  if (envProfile === 'staging') return 'standard';
  if (envProfile === 'dev') return 'baseline';

  // Fall back to LOAD_MODE heuristic.
  return runtimeValue('LOAD_MODE', 'smoke').toLowerCase() === 'load'
    ? 'baseline'
    : 'strict';
}

// ---------------------------------------------------------------------------
// buildThresholds(extra?)
//
// Returns a merged k6 thresholds object.
//   extra — any additional caller-supplied thresholds (e.g. custom counters)
// ---------------------------------------------------------------------------
export function buildThresholds(extra = {}) {
  const profile = resolveProfile();
  const loadScale = resolveLoadScale();

  // Select default thresholds for the profile.
  let defaults;
  if (profile === 'functional') {
    defaults = FUNCTIONAL_DEFAULT_THRESHOLDS;
  } else if (profile === 'standard') {
    defaults = STANDARD_DEFAULT_THRESHOLDS;
  } else if (profile === 'baseline') {
    defaults = BASELINE_DEFAULT_THRESHOLDS;
  } else {
    defaults = STRICT_DEFAULT_THRESHOLDS;
  }

  // Widen the global p99 dynamically at higher scale so environment queueing
  // at 50–100 VUs doesn't fail CI when every HTTP request itself succeeds.
  // The scale multiplier adds 10% per scale tier above 1 (capped at +50%).
  const p99ScaleFactor = Math.min(1 + (loadScale - 1) * 0.1, 1.5);
  const scaledDefaults = scaleP99InThresholds(defaults, p99ScaleFactor);

  if (profile === 'functional') {
    return { ...scaledDefaults, ...extra };
  }

  // Build per-step threshold entries.
  const p99Multiplier = P99_MULTIPLIER[profile];
  const stepEntries = {};
  Object.keys(STEP_P95).forEach((name) => {
    const p95 = STEP_P95[name];
    const rules = [`p(95)<${p95}`];
    if (p99Multiplier !== null) {
      // Scale p99 by load scale factor as well.
      const p99 = Math.round(p95 * p99Multiplier * p99ScaleFactor);
      rules.push(`p(99)<${p99}`);
    }
    stepEntries[`http_req_duration{name:${name}}`] = rules;
  });

  return { ...scaledDefaults, ...stepEntries, ...extra };
}

// Parses a threshold rule like 'p(99)<3500' and replaces the limit.
function scaleP99InThresholds(thresholds, factor) {
  if (factor === 1) return thresholds;
  const result = {};
  Object.keys(thresholds).forEach((key) => {
    result[key] = (thresholds[key] || []).map((rule) => {
      const match = rule.match(/^p\(99\)<(\d+)$/);
      if (match) {
        return `p(99)<${Math.round(Number(match[1]) * factor)}`;
      }
      return rule;
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Convenience exports (for callers that want a named reference)
// ---------------------------------------------------------------------------
export const DEFAULT_THRESHOLDS = STRICT_DEFAULT_THRESHOLDS;
export const STEP_THRESHOLDS = STEP_P95;
export default DEFAULT_THRESHOLDS;
