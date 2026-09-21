// scenarios/candidateassessment.js
// Steps 6 & 7: Candidate logs in and performs each assigned activity,
// one by one, sequentially.
//
// CHANGED vs. original assumption:
// - Candidate login is plain email/password (scenarios/login.js ->
//   candidateLogin()), NOT an access-token endpoint.
// - CONFIRMED real activity list endpoint: GET /activities/assigned-activities
//   (no projectId param in the spec — it's scoped to the authenticated
//   candidate's token).
//
// SUPERSEDED (kept only as history): earlier notes here assumed a plain
// REST submission (POST /sessions -> GET /stimuli/activity/{id} -> POST
// /responses). A real HAR capture (symulate-ai-dev_weuno_co.har) shows
// that's not how it actually works. The real flow per activity is:
//   1. POST session-token (or the board-meeting/contact variants)  -> sessionId
//   2. Client opens a Socket.IO connection, joins a room keyed by
//      activityId, and streams "text-line" events (role: persona/user) as
//      the Anam voice conversation happens. Server persists these into a
//      transcript row and echoes "transcript-updated"/"transcribed-line".
//      SITUATIONS sends a single "audio-line" event instead (no persona
//      dialogue — one video prompt, one recorded response).
//   3. PATCH candidate-activity/update-status -> COMPLETED
// The actual voice/AI turn generation happens inside Anam's WebRTC engine,
// which k6 cannot join (no media stack available to a load-testing tool).
// What THIS suite was missing — and what was almost certainly producing
// the null performance scores — is step 2 entirely: it went straight from
// session-token to COMPLETED with zero transcript content, so Anam had
// nothing to score. utils/socketConversation.js now drives that same
// Socket.IO path with realistic canned dialogue (data/conversationScripts.js)
// so a load run exercises the real transcript-persistence path instead of
// skipping it. See utils/socketConversation.js for the "confirm with
// Backend" caveat on whether Anam reads this same record regardless of
// how it was populated.

import { check, sleep } from 'k6';
import { getJson, getJsonWithHeaders, postJson, postJsonWithHeaders, patchJson, extractId } from '../utils/http.js';
import { log, logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { candidateLogin, candidatePortalTokenLogin } from './login.js';
import { runTranscriptConversation } from '../utils/socketConversation.js';
import { buildConversationTurns, buildSituationTurn } from '../data/conversationScripts.js';
import { ANUM_API_ENABLED, HARDCODED_PROJECT_ID, API_URL } from '../config/environments.js';

const BOOKING_START_SETTLE_MS = Math.max(0, Number(__ENV.BOOKING_START_SETTLE_MS || 3000));
const SESSION_START_RETRY_ATTEMPTS = Math.max(1, Number(__ENV.SESSION_START_RETRY_ATTEMPTS || 3));
const SESSION_START_RETRY_DELAY_MS = Math.max(250, Number(__ENV.SESSION_START_RETRY_DELAY_MS || 2500));

export function getAssignedActivities(candidateToken, candidateId, organizationId, projectId = HARDCODED_PROJECT_ID) {
  const res = getJson(
    routes.assignedActivities(projectId, organizationId),
    candidateToken,
    'Get Assigned Activities'
  );
  logStep('Get Assigned Activities', res);
  check(res, { 'get assigned activities: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  try {
    const body = res.json();
    const project = body && body.data;
    if (!project) return [];

    // Response structure: { data: { stages: [{ stageActivities: [{ activity: {...}, activityId, ... }] }] } }
    const activities = [];
    const stages = project.stages || [];
    stages.forEach((stage) => {
      const stageActivities = stage.stageActivities || [];
      stageActivities.forEach((sa) => {
        const activity = sa.activity || {};
        activities.push({
          id: activity.id || sa.activityId,
          title: activity.title || activity.type,
          type: activity.type || sa.type,
          stageId: stage.id,
          candidateId
        });
      });
    });
    return activities;
  } catch (e) {
    return [];
  }
}

// Get activities from project details using admin token (fallback when candidate token fails)
export function getActivitiesFromProject(adminToken, candidateId, projectId = HARDCODED_PROJECT_ID) {
  const res = getJson(
    routes.projectById(projectId),
    adminToken,
    'Get Project Details (Activities)'
  );
  logStep('Get Project Details (Activities)', res);
  check(res, { 'get project details: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  try {
    const body = res.json();
    const project = body && body.data;
    if (!project) return [];

    // Response structure: { data: { stages: [{ stageActivities: [{ activity: {...}, activityId, ... }] }] } }
    const activities = [];
    const stages = project.stages || [];
    stages.forEach((stage) => {
      const stageActivities = stage.stageActivities || [];
      stageActivities.forEach((sa) => {
        const activity = sa.activity || {};
        activities.push({
          id: activity.id || sa.activityId,
          title: activity.title || activity.type,
          type: activity.type || sa.type,
          stageId: stage.id,
          candidateId
        });
      });
    });
    return activities;
  } catch (e) {
    return [];
  }
}

export function getHardcodedProjectCandidateId(adminToken, email, projectId = HARDCODED_PROJECT_ID) {
  const res = getJson(routes.projectCandidates(projectId), adminToken, 'Get Hardcoded Project Candidates');
  logStep('Get Hardcoded Project Candidates', res);

  try {
    const body = res.json();
    const data = body && body.data;
    const candidates =
      (data && (data.candidates || data.projectCandidates || data.items || data.rows || data.results || data.data)) ||
      body.candidates || body.projectCandidates || body.items || body.rows || body.results || [];
    const target = (Array.isArray(candidates) ? candidates : []).find((item) => {
      const candidate = item && (item.candidate || item.user || item.profile || item);
      return candidate && String(candidate.email || '').toLowerCase() === String(email || '').toLowerCase();
    });
    const candidate = target && (target.candidate || target.user || target.profile || target);
    const resolvedId = target && (target.candidateId || target.userId || (candidate && (candidate.candidateId || candidate.id))) || null;
    return resolvedId;
  } catch (e) {
    return null;
  }
}

// Accept agreement on behalf of candidate (mirrors clicking "I Agree" in the UI)
export function acceptCandidateAgreement(candidateToken, candidateId, projectId = HARDCODED_PROJECT_ID) {
  const res = patchJson(
    routes.acceptAgreement(candidateId, projectId),
    { isAgreementPolicyAccepted: true },
    candidateToken,
    'Accept Candidate Agreement'
  );
  logStep('Accept Candidate Agreement', res);
  check(res, { 'accept agreement: status 2xx': (r) => r.status >= 200 && r.status < 300 });
  return res.status >= 200 && res.status < 300;
}

function responseData(res) {
  try {
    const body = res.json();
    return body && body.data ? body.data : null;
  } catch (e) {
    return null;
  }
}

export function ensureCandidateBooking(candidateToken, projectId) {
  const candidateOrigin = __ENV.CANDIDATE_URL || 'https://symulate-ai-dev.weuno.co';
  const candidateHeaders = { Origin: candidateOrigin, Referer: `${candidateOrigin}/` };

  const bookingRes = getJsonWithHeaders(routes.candidateMyBooking(projectId), candidateToken, 'Get Candidate Booking', candidateHeaders);
  logStep('Get Candidate Booking', bookingRes);

  // A 404 here has two very different causes and they must NOT be treated
  // the same way:
  //  - "Candidate is not assigned to this project" -> resolveAssignment()
  //    failed on the backend. This is a terminal condition; retries cannot
  //    booking, or polling entry-check will ever fix it — canEnter/
  //    entry-check will just return NO_ACTIVE_BOOKING forever because there
  //    is nothing to attach a booking to. Re-run the assignment (manually,
  //    or via bulk-assign) before re-running this script.
  //  - Any other 404 shape -> genuinely "no booking configured yet", which
  //    is fine to proceed past by creating one below.
  if (bookingRes.status === 404) {
    let message = '';
    try {
      message = (bookingRes.json() || {}).message || '';
    } catch (e) {
      message = '';
    }
    if (/not assigned to this project/i.test(message)) {
      log(
        'Flow',
        `Cannot continue: candidate is not assigned to project ${projectId} (backend: "${message}"). ` +
          'This is a data/assignment problem, not something a booking call or entry-check retry can fix — ' +
          're-assign this candidate to the project before re-running.'
      );
      return false;
    }
  }

  check(bookingRes, {
    'get candidate booking: status 2xx or no booking configured': (r) => (r.status >= 200 && r.status < 300) || r.status === 404
  });

  let booking = responseData(bookingRes);
  if (booking && booking.booking) booking = booking.booking;

  if (!booking || !booking.id || booking.status !== 'BOOKED') {
    const bookedOk = bookEarliestSlot(candidateToken, projectId, candidateHeaders);
    if (!bookedOk) return false;
  }

  // Gate on entry-check the same way the real candidate portal does —
  // canEnter must be true before starting a session. Reasons fall into
  // three buckets, and each must be handled differently:
  //  - NOT_YET_TIME: genuinely transient — the booking exists but the
  //    window hasn't opened. Safe to poll, bounded by maxWaitMs.
  //  - NO_ACTIVE_BOOKING: if we just booked (above) and entry-check still
  //    can't see it, that's either replication lag (worth a SHORT bounded
  //    retry) or a real problem (booking silently failed server-side /
  //    was never persisted). It must NEVER be retried indefinitely — if
  //    a booking truly doesn't exist, waiting longer will not create one.
  //  - anything else: stop immediately; do not retry.
  const maxWaitMs = 60000;
  const pollIntervalMs = 3000;
  const maxNoActiveBookingRetries = 3;
  let waited = 0;
  let noActiveBookingRetries = 0;

  for (;;) {
    const entryRes = getJsonWithHeaders(
      routes.candidateBookingEntryCheck(projectId, new Date().toISOString()),
      candidateToken,
      'Booking Entry Check',
      candidateHeaders
    );
    logStep('Booking Entry Check', entryRes);
    const entry = responseData(entryRes) || {};

    if (entry.canEnter) {
      if (BOOKING_START_SETTLE_MS > 0) {
        log(
          'Flow',
          `Booking entry gate is open for ${projectId}; waiting ${BOOKING_START_SETTLE_MS}ms for session services to observe the booked start time.`
        );
        sleep(BOOKING_START_SETTLE_MS / 1000);
      }
      return true;
    }

    if (entry.reason === 'NOT_YET_TIME' && waited < maxWaitMs) {
      log('Flow', `Booking not open yet (${entry.reason}) for ${projectId} — waiting ${pollIntervalMs}ms and re-checking.`);
      sleep(pollIntervalMs / 1000);
      waited += pollIntervalMs;
      continue;
    }

    if (entry.reason === 'NO_ACTIVE_BOOKING' && noActiveBookingRetries < maxNoActiveBookingRetries) {
      noActiveBookingRetries++;
      log(
        'Flow',
        `entry-check says NO_ACTIVE_BOOKING (attempt ${noActiveBookingRetries}/${maxNoActiveBookingRetries}) for ${projectId} — ` +
          'short bounded retry in case of replication lag, NOT an infinite retry.'
      );
      sleep(2);
      continue;
    }

    log('Flow', `Cannot continue: entry check denied for ${projectId} — reason: ${entry.reason || 'unknown'} (no further retries).`);
    return false;
  }
}

// Fetches available slots and books the earliest one. Handles the TOCTOU
// race where the slot offered by GET /booking-slots can fall just behind
// the backend's live "minimum lead time" floor by the time POST /book
// lands a few hundred ms later (backend recomputes `now` fresh on each
// call) — retries once against a freshly-fetched slot before giving up.
function bookEarliestSlot(candidateToken, projectId, candidateHeaders, attempt = 1) {
  const maxAttempts = 2;

  const slotsRes = getJsonWithHeaders(routes.candidateBookingSlots(projectId), candidateToken, 'Get Booking Slots', candidateHeaders);
  logStep('Get Booking Slots', slotsRes);
  check(slotsRes, {
    'get booking slots: status 2xx': (r) => r.status >= 200 && r.status < 300
  });

  if (slotsRes.status === 404) {
    let message = '';
    try {
      message = (slotsRes.json() || {}).message || '';
    } catch (e) {
      message = '';
    }
    log('Flow', `Cannot continue: booking slots returned 404 for ${projectId} (backend: "${message}").`);
    return false;
  }

  const slotsData = responseData(slotsRes);
  const availableSlots = (slotsData && slotsData.availableSlots) || [];
  if (!availableSlots.length) {
    log('Flow', `Cannot continue: no available booking slots were returned for project ${projectId} — check availability-config.`);
    return false;
  }

  const slotStart = availableSlots[0].startAt;
  log('Flow', `Booking earliest available slot for ${projectId}: ${slotStart} (attempt ${attempt}/${maxAttempts})`);
  const bookRes = postJsonWithHeaders(
    routes.candidateBooking(projectId),
    { slotStart },
    candidateToken,
    'Book Assessment Slot',
    candidateHeaders
  );
  logStep('Book Assessment Slot', bookRes);
  check(bookRes, { 'book assessment slot: status 2xx': (r) => r.status >= 200 && r.status < 300 });

  if (bookRes.status >= 200 && bookRes.status < 300) {
    return true;
  }

  let message = '';
  try {
    message = (bookRes.json() || {}).message || '';
  } catch (e) {
    message = '';
  }

  const isStaleWindowRace = bookRes.status === 400 && /outside the availability window/i.test(message);
  if (isStaleWindowRace && attempt < maxAttempts) {
    log('Flow', `Book Assessment Slot 400 (stale slot — availability floor moved between GET and POST). Re-fetching and retrying once.`);
    return bookEarliestSlot(candidateToken, projectId, candidateHeaders, attempt + 1);
  }

  log('Flow', `Cannot continue: failed to book a slot for ${projectId} (status ${bookRes.status}, message: "${message}").`);
  return false;
}

function clientSessionId() {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const vu = Number(__VU || 0).toString(16).padStart(4, '0');
  const iteration = Number(__ITER || 0).toString(16).padStart(4, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}00-${vu}0-${iteration}0000-000000000000`;
}

// Starts exactly one activity session for a candidate. This helper is shared
// by the normal candidate flow and the session-token audit so both paths use
// the same request shape. It deliberately does NOT try to call
// /sessions/{id}/complete: that route returned 404 in the real environment.
export function startCandidateActivitySession(candidateToken, activity, projectId = HARDCODED_PROJECT_ID, options = {}) {
  const activityId = activity && activity.id;
  const type = activity && activity.type;
  const stepName = options.stepName || 'Start Candidate Activity Session';
  const force = options.force === true;
  const suppliedClientSessionId = options.clientSessionId || clientSessionId();

  if (type === 'BOARD_MEETING') {
    const personaId =
      (activity && activity.boardMeetingActivity && activity.boardMeetingActivity.id) ||
      options.personaId ||
      '30d457a4-5ef1-41ae-bb58-a144d48c0a00';

    return postJson(
      routes.startBoardMeetingSession(activityId, personaId, projectId),
      {},
      candidateToken,
      stepName
    );
  }

  return postJson(
    routes.startSession(),
    {
      projectId,
      activityId,
      force,
      clientSessionId: suppliedClientSessionId
    },
    candidateToken,
    stepName
  );
}

function responseMessage(res) {
  try {
    const body = res && res.json ? res.json() : null;
    return body && body.message ? String(body.message) : '';
  } catch (_) {
    return '';
  }
}

function isBookedStartPropagationRace(res) {
  if (!res || res.status !== 403) return false;
  return /assessment has not started yet|booked start time|wait until that time/i.test(responseMessage(res));
}

// Session-start authorization and booking entry-check are served by different
// backend paths. In the dev environment the entry-check can become true a few
// seconds before the session-token guard observes the same booked start time.
// Retry only that specific 403 race; all other errors are returned immediately.
export function startCandidateActivitySessionWithRetry(
  candidateToken,
  activity,
  projectId = HARDCODED_PROJECT_ID,
  options = {}
) {
  const maxAttempts = Math.max(1, Number(options.maxAttempts || SESSION_START_RETRY_ATTEMPTS));
  const retryDelayMs = Math.max(250, Number(options.retryDelayMs || SESSION_START_RETRY_DELAY_MS));
  const stableClientSessionId = options.clientSessionId || clientSessionId();
  let res = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    res = startCandidateActivitySession(candidateToken, activity, projectId, {
      ...options,
      clientSessionId: stableClientSessionId
    });

    if (!isBookedStartPropagationRace(res) || attempt >= maxAttempts) {
      return res;
    }

    log(
      'Flow',
      `${options.stepName || 'Start Candidate Activity Session'} returned the transient booked-start 403 ` +
        `(attempt ${attempt}/${maxAttempts}). Waiting ${retryDelayMs}ms before retrying.`
    );
    sleep(retryDelayMs / 1000);
  }

  return res;
}

// Real activity/session cleanup mechanism observed in the candidate flow.
// Marking the activity COMPLETED closes the candidate's active activity state
// without relying on the non-working POST /sessions/{id}/complete route.
export function completeCandidateActivity(candidateToken, activityOrId, projectId = HARDCODED_PROJECT_ID, stepName = 'Complete Candidate Activity') {
  const activityId = typeof activityOrId === 'string' ? activityOrId : activityOrId && activityOrId.id;
  if (!activityId) {
    log('Flow', `${stepName}: skipped because activityId is missing`);
    return null;
  }

  const endedAt = new Date().toISOString();
  const res = patchJson(
    routes.updateActivityStatus(activityId),
    { status: 'COMPLETED', projectId, endedAt },
    candidateToken,
    stepName
  );
  logStep(`${stepName} (${activityId})`, res);
  check(res, { [`${stepName}: status 2xx`]: (r) => r.status >= 200 && r.status < 300 });
  return res;
}

export function submitActivity(candidateToken, candidateId, activity, candidateName = 'Candidate', projectId = HARDCODED_PROJECT_ID) {
  const activityId = activity.id;
  const label = activity.title || activity.type || 'Unknown';
  const stepName = ANUM_API_ENABLED ? 'Submit Activity (Anam evaluation)' : 'Submit Activity';
  const activityClientSessionId = clientSessionId();

  // DEBUG: log values being sent to API
  log('SubmitActivity', `projectId=${projectId} activityId=${activityId} candidateId=${candidateId} type=${activity.type}`);

  // ------------------------------------------------------------------
  // Step 1: Start session (endpoint varies by activity type)
  // ------------------------------------------------------------------
  let sessionRes;
  let personaId = null;

  if (activity.type === 'BOARD_MEETING') {
    personaId = (activity.boardMeetingActivity && activity.boardMeetingActivity.id) || '30d457a4-5ef1-41ae-bb58-a144d48c0a00';
  }

  function startSessionRequest() {
    return startCandidateActivitySessionWithRetry(candidateToken, activity, projectId, {
      clientSessionId: activityClientSessionId,
      stepName,
      personaId,
      force: false
    });
  }

  sessionRes = startSessionRequest();

  // Recover from an active session left by an interrupted previous run using
  // the REAL completion mechanism (candidate-activity status PATCH), not the
  // runtime-404 /sessions/{sessionId}/complete endpoint.
  if (sessionRes.status === 409) {
    try {
      const errorBody = sessionRes.json();
      const activeSession = errorBody && errorBody.details && errorBody.details.activeSession;
      const activeActivityId = activeSession && activeSession.activityId;

      if (activeActivityId) {
        log('SubmitActivity', `Active session detected for activity ${activeActivityId}; marking that activity COMPLETED before retry/continue`);
        const staleCompleteRes = completeCandidateActivity(
          candidateToken,
          activeActivityId,
          projectId,
          'Complete Stale Active Activity'
        );

        if (staleCompleteRes && staleCompleteRes.status >= 200 && staleCompleteRes.status < 300) {
          sleep(1);

          // If the stale active session belongs to a different activity, retry
          // the current activity once. If it is the same activity, it has now
          // been safely completed as cleanup and should not be started again.
          if (String(activeActivityId) !== String(activityId)) {
            sessionRes = startSessionRequest();
          } else {
            log('SubmitActivity', `${label}: stale session belonged to this same activity; cleanup completed it, so no duplicate restart is attempted`);
            return {
              status: staleCompleteRes.status,
              skipped: false,
              transcriptConfirmed: false,
              linesAcked: 0,
              recoveredStaleSession: true,
              completedByCleanup: true
            };
          }
        }
      }
    } catch (e) {
      log('SubmitActivity', `Failed to recover 409 active session: ${e}`);
    }
  }

  logStep(`${stepName} - start session (${label})`, sessionRes);
  const sessionId = extractId(sessionRes, 'sessionId');
  check(sessionRes, { [`start session (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300 });

  if (!sessionId) {
    log('Flow', `Activity not started for ${label}; completion and transcript submission skipped`);
    return { status: sessionRes.status, skipped: true, transcriptConfirmed: false, linesAcked: 0 };
  }

  // ------------------------------------------------------------------
  // Step 2: Drive the real transcript-persistence channel (Socket.IO).
  // This is the piece that was missing before — without it, Anam has no
  // transcript content and the performance score comes back null. See the
  // header comment above and utils/socketConversation.js for what this
  // does and doesn't replicate (canned dialogue over the real persistence
  // path, not real speech/AI generation — that part lives inside Anam's
  // WebRTC engine and is out of reach for a load-testing tool).
  // ------------------------------------------------------------------
  let transcriptResult = { transcriptConfirmed: false, linesAcked: 0 };
  if (sessionId) {
    const seed = (__VU || 0) + (__ITER || 0);
    if (activity.type === 'SITUATIONS') {
      let situationId = null;
      const detailsUrl = `${API_URL}/activities/${activityId}?projectId=${projectId}&stageId=${activity.stageId}`;
      const detailsRes = getJson(detailsUrl, candidateToken, 'Get Activity Details');
      logStep(`${stepName} - get details (${label})`, detailsRes);
      if (detailsRes.status === 200) {
        try {
          const body = detailsRes.json();
          const situations = body && body.data && body.data.situations;
          log(
            'Flow',
            `SITUATIONS activity details loaded: status=${detailsRes.status}, situations=${Array.isArray(situations) ? situations.length : 0}`
          );
          if (situations && situations.length > 0) {
            situationId = situations[0].id;
          }
        } catch (e) {
          log('Flow', `Error parsing activity details: ${e}`);
        }
      }
      log('Flow', `Parsed situationId: ${situationId}`);
      if (!situationId) {
        log('Flow', `Warning: Could not fetch situationId, falling back to default`);
        situationId = '4c1418d8-391e-4a3f-8cf9-1607c015629e';
      }

      // Extra pause before opening the transcript socket for SITUATIONS.
      // Anam needs a moment after session-start to register the room on
      // its side; without this the first SITUATIONS activity closes with
      // lines_acked=0 because the server isn't ready to ack yet.
      sleep(2);

      const turn = buildSituationTurn(label, candidateName, seed);
      transcriptResult = runTranscriptConversation({
        candidateToken,
        activityId,
        sessionId,
        conversationId: personaId,
        situationId,
        turns: [turn],
        eventName: 'audio-line',
        stepLabel: `${stepName} - transcript (${label})`
      });
    } else {
      const turns = buildConversationTurns(activity.type, label, candidateName, seed);
      transcriptResult = runTranscriptConversation({
        candidateToken,
        activityId,
        sessionId,
        conversationId: personaId,
        turns,
        eventName: 'text-line',
        stepLabel: `${stepName} - transcript (${label})`
      });
    }
    if (!transcriptResult.transcriptConfirmed) {
      log('Flow', `WARNING: no transcript-updated ack for ${label} (${activityId}) — this activity will likely score null`);
    }
  }

  // Small pause mirrors a real candidate moving between tasks after the
  // conversation ends.
  sleep(1);

  // ------------------------------------------------------------------
  // Step 3: Mark activity as COMPLETED (same endpoint for all types)
  // ------------------------------------------------------------------
  const completeRes = completeCandidateActivity(
    candidateToken,
    activityId,
    projectId,
    `${stepName} - complete activity (${label})`
  );

  return {
    status: completeRes.status,
    skipped: false,
    transcriptConfirmed: transcriptResult.transcriptConfirmed,
    linesAcked: transcriptResult.linesAcked
  };
}

// Runs every assigned activity for one candidate, strictly one after
// another (not in parallel).
// Activities are passed in (fetched dynamically from project details).
// organizationId is needed for the assignedActivities endpoint.
// All activity types are processed: CASE, WELCOME, SITUATIONS, ROLE_PLAY, INTERVIEW, BOARD_MEETING
export function performAllActivities(email, password, candidateId, activities, organizationId, projectCandidateId = null, projectId = HARDCODED_PROJECT_ID) {
  // Login via portal-tokens, NOT plain email/password. candidateLogin()
  // (email+password) mints a session whose JWT `sub` does not reliably
  // match ProjectCandidates.candidateId, so every booking/entry-check call
  // 404s with "Candidate is not assigned to this project" even when the
  // assignment genuinely exists (confirmed against a real portal-token HAR
  // capture + booking-flow-api-sequence.json). portal-tokens accepts
  // { candidateId, projectId } directly as an alternative to a
  // portalToken from the invite email — so this works without ever
  // touching yopmail/captcha, and yields a token whose `sub` IS the
  // candidateId the booking service checks against.
  const loginId = projectCandidateId || candidateId;
  log('Flow', `Candidate login (portal-tokens): candidateId=${loginId} projectId=${projectId}`);
  const loginResult = candidatePortalTokenLogin(loginId, projectId);
  const candidateToken = loginResult && loginResult.token;
  if (!candidateToken) {
    log('Flow', `Candidate portal-token login FAILED for candidateId=${loginId} — no token returned`);
    return [];
  }
  log('Flow', `Candidate portal-token login SUCCESS for candidateId=${loginId} — resolved candidateId=${loginResult.candidateId} orgId=${loginResult.organizationId}`);

  // Use organizationId from login response if available, otherwise use the one passed in
  const orgId = loginResult.organizationId || organizationId;

  // Real HAR capture shows the frontend sends the candidate's short handle
  // (e.g. "performer8") as the `name` field on every user text-line, not
  // their full email — derive the same thing from the email prefix.
  const candidateName = (email || 'candidate').split('@')[0];

  // Accept agreement first (mirrors the candidate clicking "I Agree" in the UI)
  const actualCandidateId = loginResult.candidateId || projectCandidateId || candidateId;
  if (actualCandidateId !== candidateId) {
    log('Flow', `Using candidate profile ID ${actualCandidateId} for configured candidate ${email}`);
  }
  acceptCandidateAgreement(candidateToken, actualCandidateId, projectId);

  // Booking is optional for the pre-provisioned project. The candidate
  // portal may already have admitted the candidate while the booking API
  // still returns 404 for this legacy assignment.
  if (String(__ENV.ENFORCE_BOOKING || 'true').toLowerCase() === 'true') {
    if (!ensureCandidateBooking(candidateToken, projectId)) {
      log('Flow', `Candidate booking entry denied for ${email} — skipping activity performance`);
      return [];
    }
  } else {
    log('Flow', 'Booking gate disabled; continuing with the existing activity session flow');
  }

  log('Flow', `Processing all ${activities.length} activities`);

  const results = [];

  activities.forEach((activity, activityIndex) => {
    log('Flow', `Starting activity: ${activity.title} (${activity.type})`);

    // First activity gets an extra warm-up pause so Anam's WebSocket
    // server has time to fully initialise the session before we open
    // the transcript socket. Without this the socket closes with
    // lines_acked=0 and the activity scores null.
    // Subsequent activities don't need it — the server is already warm.
    if (activityIndex === 0) {
      log('Flow', 'First activity: waiting 3 seconds for Anam session warm-up');
      sleep(3);
    }

    const res = submitActivity(candidateToken, actualCandidateId, activity, candidateName, projectId);
    results.push({
      activity: activity.title || activity.type,
      status: res.status,
      transcriptConfirmed: res.transcriptConfirmed || false
    });
    sleep(1); // mirrors a real candidate moving between tasks
  });

  return results;
}

// Standalone-runnable smoke check only: `k6 run scenarios/candidateassessment.js`
// (needs CANDIDATE_EMAIL + CANDIDATE_PASSWORD env vars)
export default function () {
  const email = __ENV.CANDIDATE_EMAIL;
  const password = __ENV.CANDIDATE_PASSWORD;
  const organizationId = __ENV.CANDIDATE_ORG_ID;
  if (!email || !password) {
    console.error('Standalone run needs -e CANDIDATE_EMAIL=... -e CANDIDATE_PASSWORD=...');
    return;
  }
  if (!organizationId) {
    console.error('Standalone run needs -e CANDIDATE_ORG_ID=... (candidate organization ID)');
    return;
  }
  // For standalone run, try to get activities via candidate token
  const loginResult = candidateLogin(email, password);
  const candidateToken = loginResult && loginResult.token;
  if (!candidateToken) return;
  const orgId = loginResult.organizationId || organizationId;
  acceptCandidateAgreement(candidateToken, 'standalone-candidate');
  const activities = getAssignedActivities(candidateToken, 'standalone-candidate', orgId);
  performAllActivities(email, password, 'standalone-candidate', activities, orgId);
}