// data/conversationScripts.js
//
// WHY THIS FILE EXISTS
// --------------------
// Captured HAR (symulate-ai-dev_weuno_co.har) shows the real transcript is
// NOT built from a plain REST call. It's built turn-by-turn over the
// Socket.IO channel (wss://.../dev/api/socket.io/...):
//   client emits  42["text-line", { activityId, sessionId, id, role,
//                                    content, interrupted, name }]
//   server emits  42["transcript-updated", { ...growing transcript row... }]
//   server emits  42["transcribed-line", { id, text }]
//
// A REAL captured exchange from the HAR (candidate "performer8" talking to
// persona "Gabriel"/"Ayesha Malik") looks like this, in order:
//   persona: "I'm Ayesha Malik, an HR Manager with over 8 years of
//             experience... How can I assist you today?"
//   user:    " you can give me your review about your medical policies."
//   persona: "I'd be happy to walk you through our medical policies..."
//             (a full paragraph, 3-4 sentences)
//   user:    " you"                                    <- starts talking
//   persona: "I think you were about to ask"  interrupted:true  <- cut off
//   user:    " and I page"                             <- keeps going
//   persona: "It"                             interrupted:true  <- cut off again
//   user:    " I will be on the dev side."             <- finishes the thought
// That's real overlapping speech: short fragments, a persona reply getting
// cut off mid-word because the candidate kept talking, and a final
// completing sentence. This file reproduces that shape (paragraph-length
// persona turns, a mid-conversation interruption exchange, natural
// half-sentence candidate fragments) instead of a clean, evenly-alternating
// Q&A script, so the resulting transcript reads like an actual recorded
// conversation rather than a templated one.
//
// It is still a stand-in for the real candidate/persona speech content —
// not a claim that k6 is doing real speech recognition or AI generation.
// That happens inside Anam's WebRTC engine, which a load-testing tool has
// no way to join. This just gives the real transcript-persistence path
// (Socket.IO text-line -> transcript-updated) something to persist that
// looks like a real call instead of nothing at all.
//
// SITUATIONS is different: HAR shows a single "audio-line" event and no
// back-and-forth (matches the existing project note that SITUATIONS has
// no persona/dialogue — it's one video prompt + one recorded response).

// Persona display names already used elsewhere in this suite
// (data/personas.js), kept consistent so transcripts line up with whichever
// persona was actually assigned to the activity.
const PERSONA_NAMES_BY_TYPE = {
  CASE: ['Ayesha Malik', 'Gabriel'],
  INTERVIEW: ['Sophie Adams', 'Gabriel'],
  ROLE_PLAY: ['Gabriel', 'Adams'],
  BOARD_MEETING: ['Sophie Adams', 'Gabriel'],
  WELCOME: ['Sophie Adams']
};

function personaNameFor(activityType, seed) {
  const names = PERSONA_NAMES_BY_TYPE[activityType] || PERSONA_NAMES_BY_TYPE.CASE;
  return names[seed % names.length];
}

function pick(list, seed) {
  return list[seed % list.length];
}

// --- Persona opening lines: a full introduction + open question, the way ---
// Anam's persona actually talks (paragraph-length, mentions their role,
// ends by inviting the candidate to speak) — not a one-line greeting.
const PERSONA_OPENERS = {
  CASE: (name, title) =>
    `I'm ${name}, and I'll be walking through ${title} with you today. I've spent the last several years dealing with exactly this kind of situation, so feel free to ask me anything as we go. How can I help you get started?`,
  INTERVIEW: (name, title) =>
    `Hi, thanks for making time today. I'm ${name}, and I'll be your interviewer for ${title}. This is meant to feel like a normal conversation, so don't worry too much about giving a perfect answer — I'd just like to understand how you think. Ready to get started?`,
  ROLE_PLAY: (name, title) =>
    `Hi, I appreciate you meeting with me. I'm ${name}. Regarding ${title}, I want to make sure we're on the same page before we go any further — can you walk me through where you think things currently stand?`,
  BOARD_MEETING: (name, title) =>
    `Welcome to the board discussion on ${title}. I'm ${name}, and the rest of the group is looking to you to open with a quick summary before we get into questions. Whenever you're ready.`,
  WELCOME: (name, title) =>
    `Hi, welcome! I'm ${name}, the HR Manager, and I'm here to make sure you have everything you need before you start ${title}. Do you have any questions before we begin, or would you like me to walk you through what's ahead?`
};

// --- Candidate's very first, short reply — real speech starts small ---
const CANDIDATE_OPENING_FRAGMENTS = [
  ' yeah, can you give me a bit more context on that first',
  ' sure, so from what I understand so far',
  ' okay, before I answer, can I ask a quick question',
  ' right, I think the main thing I noticed is'
];

// --- Persona's substantial follow-up paragraph, after the candidate speaks ---
const PERSONA_FOLLOWUP_PARAGRAPHS = [
  (title) =>
    `That's a fair place to start. Just so you have the full picture on ${title} — there are a few moving pieces here: timeline pressure from the client, budget constraints on our side, and a team that's already stretched thin. If you had to pick just one to solve first, what would it be, and why?`,
  (title) =>
    `Good question. On ${title}, the honest answer is we don't have complete data yet, so a lot of this comes down to judgment. What I'd like to hear from you is how you'd handle the uncertainty — would you wait for more information, or move ahead with what we have?`,
  (title) =>
    `I can share more context, sure. The short version on ${title} is that expectations were set a while back and haven't really been revisited since. Given that, how would you go about resetting expectations without it feeling like we're walking things back?`
];

// --- A short interruption exchange: user starts talking, persona gets cut ---
// off mid-thought, user finishes, matching the real HAR pattern exactly.
function interruptionExchange(candidateName, personaName) {
  return [
    { role: 'user', name: candidateName, content: ' so', interrupted: false, pauseMs: 400 },
    { role: 'persona', name: personaName, content: 'I think what you might be getting at is', interrupted: true, pauseMs: 300 },
    { role: 'user', name: candidateName, content: ' actually, hold on, let me back up', interrupted: false, pauseMs: 500 },
    { role: 'persona', name: personaName, content: 'Go ahead', interrupted: true, pauseMs: 300 },
    {
      role: 'user',
      name: candidateName,
      content: " no, it's fine — what I meant is I'd rather confirm the constraint before committing to an approach.",
      interrupted: false,
      pauseMs: 1200
    }
  ];
}

// --- Candidate's substantive answer after the interruption settles ---
const CANDIDATE_SUBSTANTIVE_ANSWERS = [
  "Okay — if I had to pick one, I'd tackle the timeline first, because everything else is easier to renegotiate once there's a realistic date on the table.",
  "I'd rather move ahead with what we have and flag the assumptions clearly, than wait and lose momentum — as long as we're upfront that it might change.",
  "I'd reset expectations by showing the original assumptions side-by-side with what's actually happened, so it's clear this isn't just walking things back for no reason."
];

// --- Persona's closing line: acknowledges the answer, wraps the segment ---
const PERSONA_CLOSINGS = [
  (title) => `That's a reasonable way to think about ${title}. I don't think we need to go further right now — let's pick this back up once you've had a chance to firm up the details.`,
  (title) => `Appreciate you walking me through your reasoning on ${title}. I think that's enough for me to go on for now.`,
  (title) => `Good discussion on ${title}. Let's leave it there and regroup once next steps are drafted.`
];

const CANDIDATE_CLOSINGS = [
  "Sounds good — I'll put together next steps and share them shortly.",
  "Thanks, I'll follow up with a short written summary of what we covered.",
  "Understood — I'll firm up the plan and circle back with you."
];

// Builds a realistic, sometimes-overlapping turn list for the "text-line"
// event types (everything except SITUATIONS). `seed` varies persona name,
// wording, and phrasing across VUs/iterations so a load run doesn't send
// byte-identical transcripts on every request.
export function buildConversationTurns(activityType, activityTitle, candidateName = 'Candidate', seed = 0) {
  const title = activityTitle || activityType;
  const personaName = personaNameFor(activityType, seed);
  const opener = (PERSONA_OPENERS[activityType] || PERSONA_OPENERS.CASE)(personaName, title);
  const followupParagraph = pick(PERSONA_FOLLOWUP_PARAGRAPHS, seed)(title);
  const closing = pick(PERSONA_CLOSINGS, seed)(title);

  const turns = [
    { role: 'persona', name: personaName, content: opener, interrupted: false, pauseMs: 1800 },
    { role: 'user', name: candidateName, content: pick(CANDIDATE_OPENING_FRAGMENTS, seed), interrupted: false, pauseMs: 1400 },
    { role: 'persona', name: personaName, content: followupParagraph, interrupted: false, pauseMs: 2000 }
  ];

  turns.push(...interruptionExchange(candidateName, personaName));

  turns.push(
    { role: 'persona', name: personaName, content: 'Go on, I want to hear the rest of that.', interrupted: false, pauseMs: 800 },
    { role: 'user', name: candidateName, content: pick(CANDIDATE_SUBSTANTIVE_ANSWERS, seed), interrupted: false, pauseMs: 1600 },
    { role: 'persona', name: personaName, content: closing, interrupted: false, pauseMs: 1000 },
    { role: 'user', name: candidateName, content: pick(CANDIDATE_CLOSINGS, seed), interrupted: false, pauseMs: 800 }
  );

  return turns;
}

// SITUATIONS: one recorded response to the video prompt, no persona side —
// matches the existing project note that this type has no persona field.
export function buildSituationTurn(activityTitle, candidateName = 'Candidate', seed = 0) {
  const responses = [
    "So, for the second-highest salary per department — the way I'd do this is a window function, DENSE_RANK partitioned by department and ordered by salary descending, then filter to rank two and join back to employee and department names for the output.",
    "I'd start with a correlated subquery just to sanity-check the logic, then move to DENSE_RANK() for a cleaner version that scales across every department in one pass instead of one at a time.",
    "My approach is a CTE that ranks salaries within each department using DENSE_RANK, selects rank equals two, and joins that back against the employee and department tables to get the names in the output."
  ];
  return {
    role: 'user',
    name: candidateName,
    content: pick(responses, seed),
    interrupted: false,
    pauseMs: 1200,
    title: activityTitle
  };
}
