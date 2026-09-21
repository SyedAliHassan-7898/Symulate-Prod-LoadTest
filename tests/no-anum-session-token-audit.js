// tests/no-anum-session-token-audit.js
//
// Backend session-token audit used by the end-to-end Anam validation runner.
//
// Key design rule:
//   The browser candidate is NEVER reused for the backend audit. Each activity
//   receives its own audit candidate (john2..john7 in the generated project).
//   This removes the old 404 -> stale active session -> 409 cascade entirely.
//
// After a successful audit session, the activity for that audit candidate is
// marked COMPLETED using the real candidate-activity PATCH endpoint. This is
// cleanup only; it does not touch the browser candidate reserved for Phase 3.

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';

import { reportName, log, logStep } from '../utils/helpers.js';
import { getJson } from '../utils/http.js';
import { routes } from '../utils/routes.js';
import { ANUM_API_ENABLED } from '../config/environments.js';

import { superAdminLogin, impersonateClientAdmin, candidatePortalTokenLogin } from '../scenarios/login.js';
import {
  getActivitiesFromProject,
  ensureCandidateBooking,
  startCandidateActivitySessionWithRetry,
  completeCandidateActivity
} from '../scenarios/candidateassessment.js';

const PROJECT_ID      = __ENV.NOANUMTEST_PROJECT_ID;
const ADMIN_USER_ID   = __ENV.NOANUMTEST_ADMIN_USER_ID;
const BROWSER_CANDIDATE_ID = __ENV.NOANUMTEST_CANDIDATE_ID;
const ANAM_MODE = String(__ENV.ANAM_MODE || (ANUM_API_ENABLED ? 'healthy' : 'disabled')).toLowerCase();

const ENV_AUDIT_CANDIDATE_IDS = String(__ENV.NOANUMTEST_AUDIT_CANDIDATE_IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    no_anum_session_token_audit: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '8m',
      gracefulStop: '10s'
    }
  },
  thresholds: { checks: ['rate==1.0'] }
};

function containsAnamSignature(res) {
  try {
    return JSON.stringify(res.json()).toLowerCase().includes('anam');
  } catch (e) {
    return false;
  }
}

function responseMessage(res) {
  try {
    const body = res.json();
    return body && body.message ? body.message : '';
  } catch (e) {
    return '';
  }
}

function parseCandidateId(item) {
  if (!item) return null;
  const candidate = item.candidate || item.user || item.profile || item;
  return (
    item.candidateId ||
    item.userId ||
    (candidate && candidate.candidateId) ||
    (candidate && candidate.userId) ||
    (candidate && candidate.id) ||
    null
  );
}

function responseCandidateList(res) {
  try {
    const body = res.json() || {};
    const data = body.data;
    return (
      (data && data.data) ||
      (data && data.items) ||
      (data && data.candidates) ||
      (data && data.projectCandidates) ||
      (data && data.results) ||
      (Array.isArray(data) ? data : null) ||
      body.items ||
      body.candidates ||
      body.projectCandidates ||
      []
    );
  } catch (e) {
    return [];
  }
}

function resolveAuditCandidateIds(clientToken, requiredCount) {
  if (ENV_AUDIT_CANDIDATE_IDS.length >= requiredCount) {
    return ENV_AUDIT_CANDIDATE_IDS.slice(0, requiredCount);
  }

  log(
    'Session Audit',
    `NOANUMTEST_AUDIT_CANDIDATE_IDS supplied ${ENV_AUDIT_CANDIDATE_IDS.length}/${requiredCount}; ` +
      'falling back to the project candidate list'
  );

  const res = getJson(routes.projectCandidates(PROJECT_ID), clientToken, 'Get Audit Candidate Pool');
  logStep('Get Audit Candidate Pool', res);
  check(res, { 'session audit: audit candidate pool fetched': (r) => r.status >= 200 && r.status < 300 });

  const ids = responseCandidateList(res)
    .map(parseCandidateId)
    .filter(Boolean)
    .filter((id) => String(id) !== String(BROWSER_CANDIDATE_ID));

  // Preserve order while removing duplicates.
  const unique = [];
  ids.forEach((id) => {
    if (!unique.some((existing) => String(existing) === String(id))) unique.push(id);
  });

  return unique.slice(0, requiredCount);
}

export default function () {
  log(
    'Session Audit',
    `=== Session-token audit (ANAM_MODE=${ANAM_MODE}, ANUM_API_ENABLED=${ANUM_API_ENABLED}) ===`
  );

  if (!PROJECT_ID || !BROWSER_CANDIDATE_ID || !ADMIN_USER_ID) {
    log(
      'Session Audit',
      'ABORTED — missing NOANUMTEST_PROJECT_ID / NOANUMTEST_CANDIDATE_ID / NOANUMTEST_ADMIN_USER_ID'
    );
    exec.test.abort('missing NOANUMTEST_ env vars');
    return;
  }

  const superAdminToken = superAdminLogin();
  if (!superAdminToken) {
    exec.test.abort('super admin login failed');
    return;
  }

  const clientToken = impersonateClientAdmin(superAdminToken, ADMIN_USER_ID);
  if (!clientToken) {
    exec.test.abort('client admin impersonation failed');
    return;
  }

  const activities = getActivitiesFromProject(clientToken, BROWSER_CANDIDATE_ID, PROJECT_ID);
  const activitiesFound = check(activities, {
    'session audit: activities found': (a) => Array.isArray(a) && a.length > 0
  });
  if (!activitiesFound) {
    exec.test.abort('no project activities found');
    return;
  }

  const auditCandidateIds = resolveAuditCandidateIds(clientToken, activities.length);
  const candidatePoolReady = check(auditCandidateIds, {
    'session audit: one dedicated audit candidate per activity': (ids) =>
      Array.isArray(ids) && ids.length >= activities.length
  });

  if (!candidatePoolReady) {
    log(
      'Session Audit',
      `ABORTED — need ${activities.length} dedicated audit candidates but only resolved ${auditCandidateIds.length}. ` +
        'Phase 1 should print NOANUMTEST_AUDIT_CANDIDATE_IDS using john2..john7.'
    );
    exec.test.abort('insufficient dedicated audit candidates');
    return;
  }

  let leaks = 0;
  let audited = 0;
  let failedSessionStarts = 0;
  let failedCompletions = 0;

  activities.forEach((activity, index) => {
    const label = activity.title || activity.type || activity.id;
    const candidateId = auditCandidateIds[index];

    log(
      'Session Audit',
      `Activity ${index + 1}/${activities.length}: "${label}" -> dedicated audit candidate ${candidateId}`
    );

    const candidateSession = candidatePortalTokenLogin(candidateId, PROJECT_ID);
    const loginOk = !!(candidateSession && candidateSession.token);
    check(loginOk, {
      [`session audit (${label}): dedicated candidate portal login succeeded`]: (ok) => ok === true
    });

    if (!loginOk) {
      failedSessionStarts += 1;
      return;
    }

    const bookingReady = ensureCandidateBooking(candidateSession.token, PROJECT_ID);
    check(bookingReady, {
      [`session audit (${label}): dedicated candidate booking ready`]: (ready) => ready === true
    });

    if (!bookingReady) {
      failedSessionStarts += 1;
      return;
    }

    const sessionRes = startCandidateActivitySessionWithRetry(
      candidateSession.token,
      activity,
      PROJECT_ID,
      {
        stepName: `Session Audit - start (${label})`,
        clientSessionId: `audit-${__VU}-${__ITER}-${index}-${activity.id}`,
        force: false
      }
    );

    logStep(`Session Audit (${label})`, sessionRes);
    audited += 1;

    const statusOk = sessionRes.status >= 200 && sessionRes.status < 300;
    if (!statusOk) {
      failedSessionStarts += 1;
      log(
        'Session Audit',
        `INVALID AUDIT: "${label}" returned HTTP ${sessionRes.status}` +
          `${responseMessage(sessionRes) ? ` — ${responseMessage(sessionRes)}` : ''}`
      );
    }

    const hasAnam = statusOk && containsAnamSignature(sessionRes);
    if (!ANUM_API_ENABLED && hasAnam) {
      leaks += 1;
      log('Session Audit', `REGRESSION: "${label}" response contains Anam while Talent Intelligence is disabled`);
    }

    check(sessionRes, {
      [`session audit (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300
    });

    if (!ANUM_API_ENABLED) {
      check(hasAnam, {
        [`session audit (${label}): no Anam credential when disabled`]: (value) => value === false
      });
    } else {
      check(statusOk, {
        [`session audit (${label}): Anam-enabled session initialized without backend error`]: (ok) => ok === true
      });
    }

    // IMPORTANT: use the real activity completion mechanism. Each audit
    // candidate owns only one audited activity, so completing it cannot affect
    // the browser candidate or another activity's audit state.
    if (statusOk) {
      const completionRes = completeCandidateActivity(
        candidateSession.token,
        activity,
        PROJECT_ID,
        `Session Audit Cleanup - mark COMPLETED (${label})`
      );

      const completionOk = !!completionRes && completionRes.status >= 200 && completionRes.status < 300;
      if (!completionOk) failedCompletions += 1;
      check(completionOk, {
        [`session audit (${label}): audit activity marked COMPLETED`]: (ok) => ok === true
      });
    }

    sleep(0.3);
  });

  if (!ANUM_API_ENABLED) {
    check(leaks, {
      'session audit: zero activities leaked Anam credentials': (count) => count === 0
    });
  }

  check(failedSessionStarts, {
    'session audit: every activity session started successfully': (count) => count === 0
  });
  check(failedCompletions, {
    'session audit: every successful audit activity was marked COMPLETED': (count) => count === 0
  });

  log(
    'Session Audit',
    `Audited ${audited} activities — failed starts=${failedSessionStarts}, failed completions=${failedCompletions}, disabled-mode leaks=${leaks}`
  );

  if (failedSessionStarts === 0 && failedCompletions === 0 && (!ANUM_API_ENABLED ? leaks === 0 : true)) {
    log('Session Audit', 'Backend audit clean — dedicated-candidate sessions completed successfully');
  } else {
    log('Session Audit', 'Backend audit failed — inspect the failed dedicated candidate/activity above');
  }
}

export function handleSummary(data) {
  const name = reportName('report-anam-session-audit', {
    SCENARIO: 'anam-session-audit',
    LOAD_MODE: 'smoke',
    ANUM_API_ENABLED
  });

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
