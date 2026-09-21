// config/environments.js
//
// Centralized runtime configuration. Values are supplied through `.env` and
// forwarded to k6 by scripts/run.js. No credentials or execution policy is
// hardcoded in test entrypoints.

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

export const ENV = __ENV.ENV || 'dev';
export const API_URL = __ENV.API_URL;

export const PORTALS = {
  superAdmin: __ENV.SUPER_ADMIN_URL,
  clientAdmin: __ENV.CLIENT_ADMIN_URL,
  candidate: __ENV.CANDIDATE_URL
};

export const CREDENTIALS = {
  superAdmin: {
    email: __ENV.SUPER_ADMIN_EMAIL,
    password: __ENV.SUPER_ADMIN_PASSWORD
  }
};

export const CANDIDATE_DEFAULT_PASSWORD = __ENV.CANDIDATE_DEFAULT_PASSWORD;
export const CLIENT_ADMIN_DEFAULT_PASSWORD = __ENV.CLIENT_ADMIN_DEFAULT_PASSWORD;

// `ANUM_API_ENABLED` is retained for backwards compatibility with existing
// scripts. Documentation and logs use the product name "Anam".
export const ANUM_API_ENABLED = bool('ANUM_API_ENABLED', true);

export const SCENARIO = String(__ENV.SCENARIO || 'full').trim().toLowerCase();
export const LOAD_MODE = String(__ENV.LOAD_MODE || 'smoke').trim().toLowerCase();
export const LOAD_VUS = positiveInt('LOAD_VUS', 10);
export const LOAD_ITERATIONS_PER_VU = positiveInt('LOAD_ITERATIONS_PER_VU', 1);

// Every generated project uses this value. The repository contains exactly 20
// seed candidate rows, therefore the production default is 20.
export const NUM_CANDIDATES = positiveInt('NUM_CANDIDATES', 20);

// Single source of truth for project invitation behavior.
// IMPORTANT: top-level runners must not override this value.
export const SEND_PROJECT_INVITATIONS = bool('SEND_PROJECT_INVITATIONS', false);
export const SEND_CLIENT_EMAIL = bool('SEND_CLIENT_EMAIL', true);
export const INCLUDE_PROJECT_REVIEW = bool('INCLUDE_PROJECT_REVIEW', false);
export const ALLOW_SHARED_CANDIDATES = bool('ALLOW_SHARED_CANDIDATES', false);
export const ALLOW_SHARED_REVIEW_TARGETS = bool('ALLOW_SHARED_REVIEW_TARGETS', false);

// Candidate execution source for `npm run smoke`.
// generated      -> candidate created in the new managed project
// preprovisioned -> CANDIDATE_*/ASSESSMENT_* from .env
// both           -> run both managed + pre-provisioned candidate flows
// auto           -> smoke: both when a complete pre-provisioned candidate is
//                   configured, otherwise generated; load: generated only
// none           -> provisioning only even when invitations are enabled
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

  return {
    email,
    password,
    candidateId,
    projectId,
    bookingId,
    bookingStartAt
  };
}

// Focused candidate-load tests require one configured candidate per VU unless
// ALLOW_SHARED_CANDIDATES=true. Up to 100 candidates can be configured using
// suffixed variables (_2, _3, ...).
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

  return HARDCODED_CANDIDATES.some(isCompletePreprovisionedCandidate)
    ? 'both'
    : 'generated';
}
