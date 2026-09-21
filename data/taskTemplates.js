// data/taskTemplates.js
//
// Activity factories used by managed smoke/load scenarios. Each activity is
// created through the platform's initial-activity endpoint and then completed
// with its type-specific detail endpoint. Focused scenarios automatically add
// one Welcome activity because the backend requires exactly one Welcome activity
// in every project stage.

const ROLE_LEVEL = 'Not Specified'; // CONFIRMED enum value (CreateInitialActivityDto.roleLevel)
const ACTIVITY_IMAGE_URL = String(
  __ENV.ACTIVITY_IMAGE_URL || `${String(__ENV.CANDIDATE_URL || 'https://symulate-ai-dev.weuno.co').replace(/\/$/, '')}/favicon.ico`
); // Required imageUrl; default stays on the already-tested candidate portal origin.

function initial(suffix, title, type, extra = {}) {
  return {
    title: `${title} ${suffix}`,
    type,
    roleLevel: ROLE_LEVEL,
    duration: extra.duration || 600,
    imageUrl: ACTIVITY_IMAGE_URL,
    description: extra.description || `${title} activity created by k6 load test`,
    order: 1
  };
}

// --- Role Play (type: ROLE_PLAY) -----------------------------------------
export function rolePlay(suffix) {
  return {
    initial: initial(suffix, 'Leadership Communication', 'ROLE_PLAY', { duration: 900 }),
    buildDetail: (rolePlayId, personaId) => ({
      id: rolePlayId,
      personaId,
      scenarioDescription:
        '<p>Address a conflict with a colleague regarding project deadlines while maintaining professionalism, communicating concerns clearly and working towards a mutually beneficial resolution.</p>',
      roleTitle: 'Regional Director',
      introductionMessage: "Hi, I'm Gabriel, let's talk through this scenario.",
      personaRole: 'Regional Director evaluating communication and conflict resolution',
      context:
        'The candidate is speaking with a senior stakeholder about missed delivery dates, competing priorities, and how the team can agree on practical next steps.',
      additionalGuardrails:
        'Stay in character as the stakeholder. Challenge unclear answers, ask for practical next steps, and keep the role-play focused on communication, ownership, and resolution.'
    })
  };
}

// --- Interview (type: INTERVIEW) ------------------------------------------
export function interview(suffix) {
  return {
    initial: initial(suffix, 'Professional Interview', 'INTERVIEW', { duration: 900 }),
    buildDetail: (interviewId, personaId) => ({
      id: interviewId,
      personaId,
      interviewQuestions:
        '<p>Tell me about a time you handled a tight deadline.</p><p>Describe a situation where you had to resolve a disagreement with a colleague.</p><p>What does success look like for you in this role?</p>',
      roleTitle: 'Hiring Manager',
      introductionMessage: "Hi, I'm Gabriel, your interviewer for this assessment.",
      personaRole: 'Professional and approachable hiring manager who asks structured interview questions.',
      context:
        'This interview assesses how the candidate diagnoses problems, develops practical solutions, structures information, and explains trade-offs under realistic workplace pressure.',
      additionalGuardrails: 'Ask one question at a time. Keep the conversation focused on the interview.'
    })
  };
}

// --- Case Exercise (type: CASE) -------------------------------------------
// UI capture: CASE content is added as child records after the initial
// activity: activity-mails, activity-documents, activity-contacts, then
// activity-contacts/bulk-update-durations.
export function caseExercise(suffix) {
  return {
    initial: initial(suffix, 'Strategic Case Study', 'CASE', {
      duration: 900,
      description: '<p>Review a business case involving declining customer retention and propose a practical action plan.</p>'
    }),
    buildDetail: (activityId, personaId) => ({
      mail: {
        activityId,
        senderName: 'Case Sponsor',
        senderEmail: 'case.sponsor@yopmail.com',
        subject: `Customer Retention Update ${suffix}`,
        priority: 'HIGH',
        designation: 'VP Operations',
        body: '<p>Please review the attached case materials and recommend a practical retention improvement plan.</p>',
        order: 1,
        imageUrl: null
      },
      document: {
        activityId,
        name: `Retention Brief ${suffix}`,
        fileUrl: 'documents/case-retention-brief-placeholder.pdf',
        mimeType: 'application/pdf',
        size: '1024',
        order: 1
      },
      contact: {
        activityId,
        title: 'VPO',
        personaId,
        order: 1,
        imageUrl: null
      },
      contactDuration: (contactId) => ({
        activityId,
        personas: [{ id: contactId, duration: 300 }]
      })
    })
  };
}

// --- Situation (type: SITUATIONS) ------------------------------------------
// CONFIRMED: no persona field — this is the type used to isolate the
// no-persona path. Detail endpoint takes an ARRAY of situations.
export function situation(suffix) {
  return {
    initial: initial(suffix, 'Workplace Situation', 'SITUATIONS', { duration: 900 }),
    buildDetail: (activityId, skillIds = []) => [
      {
        activityId,
        title: `Workplace Situation ${suffix}`,
        videoLink: 'situations/chrome-placeholder.mp4',
        order: 1,
        status: 'NOT_STARTED',
        questions: [
          {
            question:
              "Problem\nWrite a SQL query to find the second highest salary in each department, along with the department name and the employee's name.\n\nIf two or more employees in the same department tie for the second-highest salary, include all of them. If a department has fewer than two employees, it should not appear in the result set. How would you structure your query?",
            order: 0,
            skillIds
          }
        ]
      }
    ]
  };
}

// --- Board Meeting (type: BOARD_MEETING) ------------------------------------
// UI capture: PATCH /board-meeting-activities/{boardMeetingId}; body takes
// boardMeetingPersonas as objects, not raw UUID strings.
export function boardMeeting(suffix) {
  return {
    initial: initial(suffix, 'Executive Board Meeting', 'BOARD_MEETING', { duration: 900 }),
    buildDetail: (boardMeetingId, personaIds) => ({
      _boardMeetingIdInPath: boardMeetingId,
      boardMeetingPersonas: personaIds.map((personaId, index) => ({
        personaId,
        roleTitle: index === 1 ? 'a Manager' : 'Manager',
        introductionMessage:
          index === 1
            ? "Hi, I'm Gabriel. I will challenge your assumptions and help the group reach a practical decision."
            : 'Hello. I will represent a board stakeholder and keep the discussion focused on evidence and trade-offs.',
        personaRole:
          index === 1
            ? 'A direct senior stakeholder who asks practical questions about risk, feasibility, and next steps.'
            : 'A professional board stakeholder who evaluates the candidate on problem solving and analytical thinking.',
        context:
          'The board is discussing a strategic decision with competing priorities, operational constraints, and incomplete information.',
        additionalGuardrails: '',
        order: index,
        duration: 300
      }))
    })
  };
}

// --- Welcome (type: WELCOME) -------------------------------------------
export function welcome(suffix) {
  return {
    initial: initial(suffix, 'Welcome Simulation', 'WELCOME', { duration: 900 }),
    buildDetail: (welcomeId, personaId) => ({
      id: welcomeId,
      personaId,
      roleTitle: 'VPO',
      introductionMessage: '"Hi, I am Sophie Adams, the HR Manager, and I am here to make sure that you have everything you need to complete your task today".',
      personaRole: 'You are helpful, professional, and neutral. Your role is to welcome the candidate to the task.',
      context:
        'Welcome the candidate, set expectations for the assessment, and explain that the following activities will assess problem solving and analytical thinking.',
      additionalGuardrails: 'Keep the welcome concise, friendly, and focused on what to expect.'
    })
  };
}

// Activity descriptors used by scenario composition.
export const TASK_TYPES = [
  { type: 'ROLE_PLAY', label: 'Role Play', build: rolePlay, needsPersona: true, singlePersona: true },
  { type: 'INTERVIEW', label: 'Interview', build: interview, needsPersona: true, singlePersona: true },
  { type: 'CASE', label: 'Case Exercise', build: caseExercise, needsPersona: false, singlePersona: false },
  { type: 'SITUATIONS', label: 'Situation', build: situation, needsPersona: false, singlePersona: false },
  { type: 'BOARD_MEETING', label: 'Board Meeting', build: boardMeeting, needsPersona: true, singlePersona: false },
  { type: 'WELCOME', label: 'Welcome', build: welcome, needsPersona: true, singlePersona: true }
];

export const ALL_TASK_TYPES = TASK_TYPES;

const SCENARIO_PRIMARY_TYPES = {
  'role-play-only': ['ROLE_PLAY'],
  'interview-only': ['INTERVIEW'],
  'case-only': ['CASE'],
  'situation-only': ['SITUATIONS'],
  'board-meeting-only': ['BOARD_MEETING'],
  'welcome-only': ['WELCOME']
};

// Every assessment stage must contain exactly one Welcome activity. For a
// focused scenario, automatically add Welcome next to the requested activity.
// The full scenario already contains one Welcome activity.
export function taskTypesForScenario(scenario = 'full') {
  const normalized = String(scenario || 'full').trim().toLowerCase();
  if (normalized === 'full') return TASK_TYPES.slice();

  const primaryTypes = SCENARIO_PRIMARY_TYPES[normalized];
  if (!primaryTypes) {
    throw new Error(
      `Unsupported SCENARIO=${scenario}. Use full, role-play-only, interview-only, case-only, situation-only, board-meeting-only, or welcome-only.`
    );
  }

  const requiredTypes = normalized === 'welcome-only'
    ? ['WELCOME']
    : [...primaryTypes, 'WELCOME'];

  return requiredTypes.map((type) => TASK_TYPES.find((item) => item.type === type));
}

// Backwards-compatible export retained for existing imports. It now includes
// Welcome because the backend requires one Welcome activity per stage.
export const SITUATION_ONLY_TASK_TYPES = taskTypesForScenario('situation-only');
