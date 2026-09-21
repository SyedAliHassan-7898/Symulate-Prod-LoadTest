// scenarios/taskcreation.js
// Step 3: Create activities ("tasks"), with persona selection where the
// real API requires it.
//
// CHANGED vs. original assumption: this is now a real multi-call sequence
// per activity type (see data/taskTemplates.js + utils/routes.js):
//   1. POST /activities/create-initial-activity -> activityId
//   2. (if needsPersona) GET /personas -> resolve a real personaId
//   3. POST to the type-specific endpoint with { activityId, personaId, ... }
// Board Meeting needs multiple personaIds; Situation needs none; Case
// currently only runs step 1 (see BEST-EFFORT note in taskTemplates.js).

import { check } from 'k6';
import { getJson, postJson, patchJson, extractId } from '../utils/http.js';
import { logStep, uniqueSuffix } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { superAdminLogin } from './login.js';
import { taskTypesForScenario } from '../data/taskTemplates.js';
import { PREFERRED_PERSONA_NAME, PREFERRED_BOARD_PERSONA_NAMES } from '../data/personas.js';
import { SCENARIO } from '../config/environments.js';

// Cache resolved persona IDs within a VU so repeated activity creation does not
// perform unnecessary persona lookups.
let personaCache = null;
let skillIdsCache = null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUIRED_SKILL_NAMES = ['Problem Solving', 'Analytical Thinking'];

function findUuid(value) {
  if (!value) return null;
  if (typeof value === 'string') return UUID_RE.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = findUuid(item);
      if (id) return id;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['id', 'personaId', 'uuid', '_id']) {
      const id = findUuid(value[key]);
      if (id) return id;
    }
    for (const item of Object.values(value)) {
      const id = findUuid(item);
      if (id) return id;
    }
  }
  return null;
}

function resolvePersonaId(token, preferredName) {
  if (personaCache && personaCache[preferredName]) return personaCache[preferredName];
  const res = getJson(`${routes.personas()}?search=${encodeURIComponent(preferredName)}&limit=1`, token, 'Get Personas');
  logStep(`Get Personas (${preferredName})`, res);
  let id = null;
  try {
    const body = res.json();
    id = findUuid(body);
    if (!id) {
      // fall back to first persona in the system if the exact name isn't there
      const fallbackRes = getJson(`${routes.personas()}?limit=1`, token, 'Get Personas');
      logStep(`Get Personas fallback (${preferredName})`, fallbackRes);
      const fbBody = fallbackRes.json();
      id = findUuid(fbBody);
    }
  } catch (e) {
    id = null;
  }
  personaCache = personaCache || {};
  personaCache[preferredName] = id;
  return id;
}

function responseList(body) {
  return (body && body.data && body.data.data) || (body && body.data && body.data.items) || (body && body.data) || body.items || body || [];
}

function resolveRequiredSkillIds(token) {
  if (skillIdsCache) return skillIdsCache;

  const res = getJson(routes.skills(), token, 'Get Skills');
  logStep('Get Skills', res);

  let ids = [];
  try {
    const skills = responseList(res.json());
    ids = REQUIRED_SKILL_NAMES.map((name) => {
      const skill = skills.find((item) => item && item.name === name);
      return skill && skill.id;
    }).filter(Boolean);
  } catch (e) {
    ids = [];
  }

  skillIdsCache = ids;
  return skillIdsCache;
}

function extractNestedActivityId(res, key) {
  try {
    const body = res.json();
    return body && body.data && body.data[key] && body.data[key].id;
  } catch (e) {
    return null;
  }
}

export function createAllTaskTypes(token) {
  const taskTypes = taskTypesForScenario(SCENARIO);
  const suffix = uniqueSuffix();
  const createdActivities = [];
  const skillIds = resolveRequiredSkillIds(token);

  taskTypes.forEach(({ type, label, build, needsPersona, singlePersona }) => {
    const { initial, buildDetail } = build(suffix);
    if (type !== 'SITUATIONS' && type !== 'WELCOME') {
      initial.skillIds = skillIds;
    }

    const initRes = postJson(routes.createInitialActivity(), initial, token, 'Create Task');
    logStep(`Create Task - initial (${label})`, initRes);
    const activityId = extractId(initRes, 'id');
    check(initRes, {
      [`create task (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300,
      [`create task (${label}): id returned`]: () => !!activityId
    });

    if (!activityId || !buildDetail) {
      if (activityId) createdActivities.push({ activityId, type, label });
      return;
    }

    let detailRes;
    if (type === 'BOARD_MEETING') {
      const personaIds = PREFERRED_BOARD_PERSONA_NAMES.map((name) => resolvePersonaId(token, name)).filter(Boolean);
      const boardMeetingId = extractNestedActivityId(initRes, 'boardMeeting');
      const detailBody = buildDetail(boardMeetingId, personaIds);
      detailRes = patchJson(
        routes.boardMeetingActivities(boardMeetingId),
        { boardMeetingPersonas: detailBody.boardMeetingPersonas },
        token,
        'Create Task'
      );
    } else if (type === 'CASE') {
      const personaId = resolvePersonaId(token, PREFERRED_PERSONA_NAME);
      const detailBody = buildDetail(activityId, personaId);
      const mailRes = postJson(routes.activityMails(), detailBody.mail, token, 'Create Task');
      logStep(`Create Task - case mail (${label})`, mailRes);
      const documentRes = postJson(routes.activityDocuments(), detailBody.document, token, 'Create Task');
      logStep(`Create Task - case document (${label})`, documentRes);
      const contactRes = postJson(routes.activityContacts(), detailBody.contact, token, 'Create Task');
      logStep(`Create Task - case contact (${label})`, contactRes);
      const contactId = extractId(contactRes, 'id');
      const durationRes = patchJson(routes.bulkUpdateActivityContactDurations(), detailBody.contactDuration(contactId), token, 'Create Task');
      logStep(`Create Task - case contact durations (${label})`, durationRes);
      detailRes = {
        status:
          mailRes.status >= 200 &&
          mailRes.status < 300 &&
          documentRes.status >= 200 &&
          documentRes.status < 300 &&
          contactRes.status >= 200 &&
          contactRes.status < 300 &&
          durationRes.status >= 200 &&
          durationRes.status < 300
            ? 200
            : 500,
        body: '',
        timings: { duration: 0 }
      };
    } else if (type === 'SITUATIONS') {
      const detailBody = buildDetail(activityId, skillIds);
      detailRes = postJson(routes.situationActivities(), detailBody, token, 'Create Task');
    } else if (type === 'ROLE_PLAY') {
      const personaId = resolvePersonaId(token, PREFERRED_PERSONA_NAME);
      const rolePlayId = extractNestedActivityId(initRes, 'rolePlay');
      const detailBody = buildDetail(rolePlayId, personaId);
      detailRes = patchJson(routes.rolePlayActivities(), detailBody, token, 'Create Task');
    } else if (type === 'INTERVIEW') {
      const personaId = resolvePersonaId(token, PREFERRED_PERSONA_NAME);
      const interviewId = extractNestedActivityId(initRes, 'interview');
      const detailBody = buildDetail(interviewId, personaId);
      detailRes = patchJson(routes.interviewActivities(), detailBody, token, 'Create Task');
    } else if (type === 'WELCOME') {
      const personaId = resolvePersonaId(token, PREFERRED_PERSONA_NAME);
      const welcomeId = extractNestedActivityId(initRes, 'welcome');
      const detailBody = buildDetail(welcomeId, personaId);
      detailRes = patchJson(routes.welcomeActivities(), detailBody, token, 'Create Task');
    } else {
      const personaId = needsPersona ? resolvePersonaId(token, PREFERRED_PERSONA_NAME) : null;
      const detailBody = buildDetail(activityId, personaId);
      detailRes = postJson(routes.welcomeActivities(), detailBody, token, 'Create Task');
    }

    logStep(`Create Task - detail (${label})`, detailRes);
    check(detailRes, {
      [`create task detail (${label}): status 2xx`]: (r) => r.status >= 200 && r.status < 300
    });

    const publishRes = postJson(routes.publishActivity(activityId), {}, token, 'Publish Activity');
    logStep(`Publish Activity (${label})`, publishRes);

    createdActivities.push({ activityId, type, label });
  });

  return createdActivities;
}

// Standalone-runnable: `k6 run scenarios/taskcreation.js`
export default function () {
  const token = superAdminLogin();
  createAllTaskTypes(token);
}
