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
// data/conversationScripts.js instead. That's enough to exercise the real
// backend persistence path end-to-end and give Anam something real to
// score, which is the gap this suite had (session-token -> immediately
// COMPLETED, zero transcript lines, null score).
//
// CONFIRM WITH BACKEND: whether Anam's scoring reads this same transcript
// record regardless of how it was populated. Everything observed in the
// HAR suggests the server just persists whatever "text-line" content
// arrives in the room, but that assumption is worth one real check before
// relying on scores from a load run.

import ws from 'k6/ws';
import { check } from 'k6';
import { log } from './helpers.js';
import { API_URL } from '../config/environments.js';
import { WEBM_AUDIO } from './webmAudio.js';

function socketIoUrl() {
  // API_URL is e.g. https://api.symulate.weuno.co/dev/api -> the socket.io
  // endpoint captured in the HAR lives at the same host, same /dev/api
  // prefix: wss://api.symulate.weuno.co/dev/api/socket.io/?EIO=4&transport=websocket
  const wsBase = API_URL.replace(/^http/, 'ws');
  return `${wsBase}/socket.io/?EIO=4&transport=websocket`;
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
// Returns null for anything that isn't a "42..." event frame (engine.io
// pings, bare connect acks, etc. are handled separately by the caller).
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

// Runs one scripted conversation over the socket.io channel for a single
// activity and returns true if the server confirmed a transcript was
// persisted (i.e. at least one "transcript-updated" event came back).
//
// turns: array of { role, content, pauseMs } for text-line activities, OR
//        a single { role: 'user', content } for the SITUATIONS audio-line
//        case (pass eventName: 'audio-line' in that case).
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
  hardStopMs = 30000
}) {
  const url = socketIoUrl();
  const lineId = conversationId || activityId;
  let joined = false;
  let transcriptConfirmed = false;
  let linesAcked = 0;
  let turnIndex = 0;
  let connectStatus = null;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      log('Socket', `${stepLabel}: connection opened`);
    });

    socket.setTimeout(function () {
      if (!joined) {
        log('Socket', `${stepLabel}: never joined room within ${connectTimeoutMs}ms — closing`);
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

      // Engine.IO "open" packet -> send Socket.IO connect packet with auth.
      if (data.startsWith('0{')) {
        socket.send(`40${JSON.stringify({ token: `Bearer ${candidateToken}` })}`);
        return;
      }

      // Engine.IO ping -> pong (keeps the connection alive on longer runs).
      if (data === '2') {
        socket.send('3');
        return;
      }

      // Socket.IO connect ack for the default namespace -> join the room.
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
      log('Socket', `${stepLabel}: closed (joined=${joined}, transcript=${transcriptConfirmed}, lines_acked=${linesAcked})`);
    });

    socket.on('error', function (e) {
      log('Socket', `${stepLabel}: error ${e && e.error ? e.error() : e}`);
    });
  });

  connectStatus = res && res.status;
  check(res, { [`${stepLabel}: websocket handshake 101`]: (r) => r && r.status === 101 });
  check(null, { [`${stepLabel}: transcript persisted (server ack)`]: () => transcriptConfirmed });

  return { transcriptConfirmed, linesAcked, connectStatus };
}
