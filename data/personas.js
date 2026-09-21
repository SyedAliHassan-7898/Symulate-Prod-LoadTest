// data/personas.js
//
// CHANGED vs. original assumption: personas are NOT free-text names picked
// at task-creation time. CreateActivityRolePlayDto / *InterviewDto /
// *WelcomeDto / *BoardMeetingDto all require a real `personaId` (UUID) that
// must already exist in the system (GET /personas). This file now only
// keeps the preferred persona NAME to search for; the actual ID lookup
// happens in scenarios/taskcreation.js -> resolvePersonaId(), which calls
// GET /personas?search=<name> and falls back to the first persona returned
// if no exact name match exists (keeps the suite runnable in an
// environment where "Gabriel" etc. don't exist by that exact name).

export const PREFERRED_PERSONA_NAME = 'Gabriel';
export const PREFERRED_BOARD_PERSONA_NAMES = ['Gabriel', 'Sophie Adams', 'Adams'];
