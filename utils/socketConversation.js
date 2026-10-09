// utils/socketConversation.js
//
// Drives the real transcript-persistence channel confirmed in
// symulate-ai-dev_weuno_co.har: the frontend does NOT submit a transcript
// via a plain REST call. It opens a Socket.IO connection, joins a room
// keyed by activityId, and streams one "text-line" event per utterance —
//   { activityId, sessionId, id, role, content, interrupted, name }
// (SITUATIONS sends a single "audio-line" event with the same shape,
// candidate side only). The server echoes back "transcript-updated" (the
// growing transcript row) and "transcribed-line" (per-utterance ack) —
// that's what persists the transcript Anam later scores.
//
// WHAT THIS DOES NOT DO: it does not join the Anam WebRTC call, do
// speech-to-text, or generate AI persona replies — none of that is
// reachable from k6 (no media/WebRTC stack). It sends the same
// text-line/audio-line events the browser sends once Anam's real-time
// transcript reaches the frontend, using canned dialogue from
// data/conversationScripts.js instead.
//
// PRODUCTION-SAFETY ADDITIONS (concurrency throttling):
//
//   1. Per-VU staggered connect delay (scaleSocketDelay)
//      At 100 VUs the default behavior is all VUs opening Socket.IO
//      connections simultaneously — a thundering herd that can exhaust the
//      server's accept queue. scaleSocketDelay() from environments.js
//      spreads connection opens across a configurable time window based on
//      LOAD_SCALE and the VU index so the server sees a smooth ramp instead
//      of a spike.
//
//   2. Exponential backoff on WebSocket 503/429
//      ws.connect() itself does not retry. If the initial handshake fails
//      with a status that indicates the server is temporarily overloaded
//      (503, 429, or a connection error), runTranscriptConversation() retries
//      up to SOCKET_MAX_RETRIES times with exponential backoff before giving
//      up and returning transcriptConfirmed=false.
//
//   3. Per-activity socket connection cap (SOCKET_MAX_CONCURRENT)
//      When the environment variable SOCKET_MAX_CONCURRENT is set, each VU
//      records its own in-flight count and sleeps until it is under the cap
//      before opening the next connection. This is a lightweight, per-VU
//      soft cap — it does not coordinate across VUs (k6 has no cross-VU
//      shared mutable state), but it prevents a single VU from piling up
//      many parallel sockets if it processes multiple activities rapidly.

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { log } from './helpers.js';
import { API_URL, scaleSocketDelay, LOAD_SCALE } from '../config/environments.js';
import { WEBM_AUDIO } from './webmAudio.js';

// ---------------------------------------------------------------------------
// Throttle configuration
// ---------------------------------------------------------------------------

// Maximum WebSocket connection retries on transient server overload (503/429).
// Base: 2 retries. Increases to 3 at scale >= 3 to give a loaded server more
// recovery time without waiting forever.
const SOCKET_MAX_RETRIES = LOAD_SCALE >= 3 ? 3 : 2;

// Base backoff in seconds between socket retries (doubles each attempt).
// scale 1–2 → 2 s base; scale 3–4 → 3 s; scale 5 → 4 s
const SOCKET_RETRY_BASE_S = LOAD_SCALE >= 5 ? 4 : LOAD_SCALE >= 3 ? 3 : 2;

// Optional per-VU in-flight socket cap. 0 = unlimited (default).
// Set SOCKET_MAX_CONCURRENT=N in .env to activate the soft cap.
const SOCKET_MAX_CONCURRENT = Math.max(0, Number(__ENV.SOCKET_MAX_CONCURRENT || 0));

// Per-VU in-flight counter. Shared across calls within the same VU JS runtime.
let _inFlightSockets = 0;

function socketIoUrl() {
  // API_URL is e.g. https://api.symulate.weuno.co/dev/api -> the socket.io
  // endpoint captured in the HAR lives at the same host, same /dev/api
  // prefix: wss://api.symulate.weuno.co/dev/api/socket.io/?EIO=4&transport=websocket
  const wsBase = API_URL.replace(/^http/, 'ws');
  return `${wsBase}/socket.io/?EIO=4&transport=websocket`;
}

// Returns true if the WebSocket connect status suggests a transient server
// overload that is worth retrying (503 Service Unavailable, 429 Too Many
// Requests, or a connection-level error indicated by a null/0 status).
function isRetryableSocketStatus(status) {
  return status === 503 || status === 429 || !status || status === 0;
}

// Waits until the per-VU in-flight socket count is below the configured cap.
// No-ops when SOCKET_MAX_CONCURRENT=0 (unlimited).
function waitForSocketSlot(stepLabel) {
  if (SOCKET_MAX_CONCURRENT <= 0) return;
  let waited = 0;
  while (_inFlightSockets >= SOCKET_MAX_CONCURRENT) {
    if (waited === 0) {
      log('Socket', `${stepLabel}: in-flight cap (${SOCKET_MAX_CONCURRENT}) reached — waiting for a slot`);
    }
    sleep(0.5);
    waited += 500;
    if (waited > 30000) {
      log('Socket', `${stepLabel}: gave up waiting for socket slot after 30s`);
      return;
    }
  }
}

export function joinBookingRoom(candidateToken, stepLabel = 'Booking room') {
  const url = socketIoUrl();
  let joined = false;
  const res = ws.connect(url, {}, function (socket) {
    socket.setTimeout(function () {
      socket.close();
    }, 8000);

    socket.on('message', function (data) {
      if (typeof data !== 'string') return;
      if (data.startsWith('0{')) {
        socket.send(`40${JSON.stringify({ token: `Bearer ${candidateToken}` })}`);
        return;
      }
      if (data === '2') {
        socket.send('3');
        return;
      }
      if (data.startsWith('42')) {
        const parsed = parseEventFrame(data);
        if (!parsed) return;
        const [event, payload] = parsed;
        if (event === 'authenticated' && payload && payload.status === true) {
          socket.send('42["booking:join"]');
          return;
        }
        if (event === 'booking:join:ack') {
          joined = true;
          socket.send('41');
          socket.close();
        }
      }
    });
  });

  check(res, { [`${stepLabel}: websocket handshake 101`]: (r) => r && r.status === 101 });
  check(null, { [`${stepLabel}: booking room joined`]: () => joined });
  log('Socket', `${stepLabel}: booking room joined=${joined}`);
  return joined;
}

// Parses a Socket.IO event frame like `42["event-name",{...}]` or
// `420["event-name",{...}]` (ack id present) into [eventName, payload].
// Returns null for anything that isn't a "42..." event frame.
function parseEventFrame(data) {
  const bracketIndex = data.indexOf('[');
  if (bracketIndex === -1) return null;
  try {
    const parsed = JSON.parse(data.slice(bracketIndex));
    if (!Array.isArray(parsed) || parsed.length < 1) return null;
    return [parsed[0], parsed[1]];
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// runTranscriptConversation()
//
// Runs one scripted conversation over the socket.io channel for a single
// activity and returns { transcriptConfirmed, linesAcked, connectStatus }.
//
// New parameters:
//   vuIndex  — zero-based VU index used to compute the stagger delay.
//              Defaults to (__VU - 1) if not supplied.
//
// Throttling behavior added:
//   1. Applies a per-VU stagger delay before opening the connection so all
//      VUs do not connect simultaneously (scaleSocketDelay).
//   2. Checks the per-VU in-flight socket cap (SOCKET_MAX_CONCURRENT).
//   3. Retries the entire connect+conversation sequence on transient 503/429
//      with exponential backoff (SOCKET_MAX_RETRIES, SOCKET_RETRY_BASE_S).
// ---------------------------------------------------------------------------
export function runTranscriptConversation({
  candidateToken,
  activityId,
  sessionId,
  conversationId,
  situationId,
  turns,
  eventName = 'text-line',
  stepLabel,
  connectTimeoutMs = 8000,
  hardStopMs = 30000,
  vuIndex = null
}) {
  const url = socketIoUrl();
  const lineId = conversationId || activityId;

  // -------------------------------------------------------------------------
  // Step 1: staggered delay — spreads connection opens across the run window.
  // -------------------------------------------------------------------------
  const resolvedVuIndex = vuIndex !== null ? vuIndex : (typeof __VU !== 'undefined' ? __VU - 1 : 0);
  const staggerMs = scaleSocketDelay(resolvedVuIndex);
  if (staggerMs > 0) {
    log('Socket', `${stepLabel}: stagger delay ${staggerMs}ms (VU ${resolvedVuIndex + 1}, scale=${LOAD_SCALE})`);
    sleep(staggerMs / 1000);
  }

  // -------------------------------------------------------------------------
  // Step 2: in-flight cap check.
  // -------------------------------------------------------------------------
  waitForSocketSlot(stepLabel);

  // -------------------------------------------------------------------------
  // Step 3: attempt loop with exponential backoff on retryable status codes.
  // -------------------------------------------------------------------------
  let lastResult = { transcriptConfirmed: false, linesAcked: 0, connectStatus: null };

  for (let attempt = 1; attempt <= SOCKET_MAX_RETRIES + 1; attempt++) {
    const result = _attemptTranscriptConversation({
      url,
      lineId,
      candidateToken,
      activityId,
      sessionId,
      conversationId,
      situationId,
      turns,
      eventName,
      stepLabel,
      connectTimeoutMs,
      hardStopMs,
      attempt
    });

    lastResult = result;

    if (!isRetryableSocketStatus(result.connectStatus) || attempt > SOCKET_MAX_RETRIES) {
      break;
    }

    const backoffS = SOCKET_RETRY_BASE_S * Math.pow(2, attempt - 1);
    log(
      'Socket',
      `${stepLabel}: connect attempt ${attempt}/${SOCKET_MAX_RETRIES + 1} failed ` +
      `(status=${result.connectStatus}) — retrying in ${backoffS}s`
    );
    sleep(backoffS);
  }

  return lastResult;
}

// Internal: performs one attempt at the full connect → join → converse cycle.
function _attemptTranscriptConversation({
  url,
  lineId,
  candidateToken,
  activityId,
  sessionId,
  conversationId,
  situationId,
  turns,
  eventName,
  stepLabel,
  connectTimeoutMs,
  hardStopMs,
  attempt
}) {
  let joined = false;
  let transcriptConfirmed = false;
  let linesAcked = 0;
  let turnIndex = 0;
  let connectStatus = null;

  _inFlightSockets++;

  try {
    const res = ws.connect(url, {}, function (socket) {
      socket.on('open', function () {
        log('Socket', `${stepLabel}: connection opened (attempt ${attempt})`);
      });

      socket.setTimeout(function () {
        if (!joined) {
          log('Socket', `${stepLabel}: never joined room within ${hardStopMs}ms — closing`);
        }
        socket.close();
      }, hardStopMs);

      function sendNextTurn() {
        if (turnIndex >= turns.length) {
          let waitAttempts = 0;
          function checkAndClose() {
            if (transcriptConfirmed || waitAttempts >= 10) {
              socket.send('41'); // Socket.IO namespace disconnect
              socket.close();
            } else {
              waitAttempts++;
              socket.setTimeout(checkAndClose, 500);
            }
          }
          socket.setTimeout(checkAndClose, 500);
          return;
        }
        const turn = turns[turnIndex++];
        if (eventName === 'audio-line') {
          const sitId = situationId || turn.situationId || lineId;
          socket.send(
            `420${JSON.stringify([
              'audio-line',
              {
                activityId,
                sessionId,
                situationId: sitId,
                id: sitId,
                role: 'user',
                character: 'User',
                line: turn.audio || WEBM_AUDIO,
                startedAt: new Date().toISOString()
              }
            ])}`
          );
        } else {
          socket.send(
            `42${JSON.stringify([
              eventName,
              {
                activityId,
                sessionId,
                id: lineId,
                role: turn.role,
                content: turn.content,
                interrupted: turn.interrupted || false,
                name: turn.name || (turn.role === 'persona' ? 'Persona' : 'Candidate')
              }
            ])}`
          );
        }
        socket.setTimeout(sendNextTurn, turn.pauseMs || 1200);
      }

      socket.on('message', function (data) {
        if (typeof data !== 'string' || data.length === 0) return;

        // Engine.IO "open" packet -> send Socket.IO connect with auth.
        if (data.startsWith('0{')) {
          socket.send(`40${JSON.stringify({ token: `Bearer ${candidateToken}` })}`);
          return;
        }
        // Engine.IO ping -> pong.
        if (data === '2') {
          socket.send('3');
          return;
        }
        // Socket.IO connect ack -> join the room.
        if (data.startsWith('40{') || data === '40') {
          socket.send(`42${JSON.stringify(['join-room', activityId])}`);
          return;
        }
        // Regular event frame.
        if (data.startsWith('42') || data.startsWith('420')) {
          const parsed = parseEventFrame(data);
          if (!parsed) return;
          const [event, payload] = parsed;

          if (event === 'authenticated') {
            const ok = payload && payload.status === true;
            log('Socket', `${stepLabel}: authenticated=${ok}`);
            return;
          }
          if (event === 'joined-room') {
            joined = true;
            log('Socket', `${stepLabel}: joined room, starting conversation`);
            sendNextTurn();
            return;
          }
          if (event === 'transcript-updated') {
            transcriptConfirmed = true;
            return;
          }
          if (event === 'transcribed-line') {
            linesAcked += 1;
            return;
          }
        }
      });

      socket.on('close', function () {
        log(
          'Socket',
          `${stepLabel}: closed (attempt=${attempt}, joined=${joined}, ` +
          `transcript=${transcriptConfirmed}, lines_acked=${linesAcked})`
        );
      });

      socket.on('error', function (e) {
        log('Socket', `${stepLabel}: error ${e && e.error ? e.error() : e}`);
      });
    });

    connectStatus = res && res.status;
    check(res, { [`${stepLabel}: websocket handshake 101`]: (r) => r && r.status === 101 });
    check(null, { [`${stepLabel}: transcript persisted (server ack)`]: () => transcriptConfirmed });
  } finally {
    _inFlightSockets = Math.max(0, _inFlightSockets - 1);
  }

  return { transcriptConfirmed, linesAcked, connectStatus };
}
