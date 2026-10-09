// scenarios/projectcreation.js
//
// Creates an isolated project and candidate set for the current k6 VU/iteration.
// Project titles and candidate email addresses are unique per VU/iteration so
// concurrent provisioning runs do not share or overwrite mutable resources.
//
// The stage assignment enforces the backend invariant that every stage contains
// exactly one Welcome activity. Focused scenarios are composed with Welcome by
// data/taskTemplates.js before this module assigns the stage.

import { check } from 'k6';
import { sleep } from 'k6';
import { getJson, postJson, patchJson, extractId, extractToken } from '../utils/http.js';
import { log, logStep, uniqueSuffix } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { superAdminLogin, impersonateClientAdmin } from './login.js';
import { createClient } from './clientcreation.js';
import { createAllTaskTypes } from './taskcreation.js';
import { assignTasksToOrg } from './taskassign.js';
import { setupAccountAndSkillsProfile } from './accountsetup.js';
import { SEND_PROJECT_INVITATIONS, ANUM_API_ENABLED, NUM_CANDIDATES } from '../config/environments.js';

const candidatesCsvTemplate = open('../data/candidates.csv');
const candidateTemplates = parseCandidatesCsv(candidatesCsvTemplate);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeAnamMode(mode = __ENV.ANAM_MODE) {
  const raw = String(mode || '')
    .trim()
    .toLowerCase();
  if (raw === 'disabled' || raw === 'healthy' || raw === 'outage503' || raw === 'network') return raw;
  return ANUM_API_ENABLED ? 'healthy' : 'disabled';
}

export function talentIntelligenceEnabledForMode(mode = __ENV.ANAM_MODE) {
  return normalizeAnamMode(mode) !== 'disabled';
}

// Applies the organization-level Talent Intelligence flag for the selected
// validation mode. The same generated project can therefore be used for:
// disabled, healthy, 503-outage and network-outage scenarios.
export function configureTalentIntelligenceForMode(superAdminToken, orgId, mode = __ENV.ANAM_MODE) {
  const normalizedMode = normalizeAnamMode(mode);
  const enabled = talentIntelligenceEnabledForMode(normalizedMode);
  const res = patchJson(
    routes.organizationById(orgId),
    { enableTalentIntelligence: enabled },
    superAdminToken,
    `Configure Talent Intelligence (${normalizedMode})`,
  );
  logStep(`Configure Talent Intelligence (${normalizedMode})`, res);
  check(res, {
    [`configure talent intelligence (${normalizedMode}): status 2xx`]: (r) => r.status >= 200 && r.status < 300,
  });
  return { enabled, mode: normalizedMode, response: res };
}

export function createProject(clientToken, orgId) {
  const suffix = uniqueSuffix();
  const payload = {
    title: `Candidate Perform with timer ${suffix}`,
    description: '',
  };

  const res = postJson(routes.createProject(orgId), payload, clientToken, 'Create Project');
  logStep('Create Project', res);
  const projectId = extractId(res, 'id');
  check(res, {
    'create project: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create project: id returned': () => !!projectId,
  });
  return projectId;
}

export function assignRoleProfileToProject(clientToken, projectId, roleProfileId) {
  const payload = { projectId, roleProfileId };
  const res = postJson(routes.assignRoleProfileToProject(), payload, clientToken, 'Assign Role Profile to Project');
  logStep('Assign Role Profile to Project', res);
  check(res, {
    'assign role profile to project: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'assign role profile to project: role profile returned': (r) => hasNestedId(r, 'roleProfile', roleProfileId),
  });
  return res;
}

export function createProjectStage(clientToken, projectId) {
  const payload = {
    name: 'Stage 1',
    sequence: 1,
    projectId,
  };
  const res = postJson(routes.stages(), payload, clientToken, 'Create Project Stage');
  logStep('Create Project Stage', res);
  const stageId = extractId(res, 'id');
  check(res, {
    'create project stage: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'create project stage: id returned': () => !!stageId,
  });
  return stageId;
}

export function assignActivitiesToStage(clientToken, stageId, activities) {
  const source = Array.isArray(activities) ? activities : [];
  const assignableActivities = source.filter((activity) => activity && activity.activityId && UUID_RE.test(String(activity.activityId)));
  const skippedActivities = source.filter((activity) => !activity || !activity.activityId || !UUID_RE.test(String(activity.activityId)));

  if (skippedActivities.length) {
    log('Project Creation', `Skipping ${skippedActivities.length} activity record(s) without a valid activity ID before stage assignment`);
  }

  const welcomeCount = assignableActivities.filter((activity) => activity.type === 'WELCOME').length;
  const dependencyReady = check(
    { welcomeCount },
    {
      'assign activities to stage: exactly one Welcome activity is present': (value) => value.welcomeCount === 1,
    },
  );

  if (!dependencyReady) {
    const body = `Stage dependency validation failed: expected exactly one Welcome activity, resolved ${welcomeCount}.`;
    log('Project Creation', body);
    return { status: 0, body, timings: { duration: 0 } };
  }

  const payload = {
    assignments: [
      {
        stageId,
        activityIds: assignableActivities.map((activity) => activity.activityId),
      },
    ],
  };
  const res = postJson(routes.assignStageActivitiesBulk(), payload, clientToken, 'Assign Activities to Stage');
  logStep('Assign Activities to Stage', res);
  check(res, {
    'assign activities to stage: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'assign activities to stage: all activities assigned': (r) => responseListFromRes(r).length === assignableActivities.length,
  });
  return res;
}

export function getDefaultEmailTemplate(clientToken, templateId = null) {
  // Retry on 429 rate-limit
  let res;
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    res = getJson(routes.emailTemplates(), clientToken, 'Get Email Templates');
    if (res.status !== 429) break;
    const waitSec = attempt * 3;
    log('Email Template', `[RETRY] Get Email Templates — 429 rate limited, retry ${attempt}/${maxRetries} after ${waitSec}s`);
    sleep(waitSec);
  }

  logStep('Get Email Templates', res);
  const templates = responseListFromRes(res);
  const template =
    (templateId && templates.find((item) => item.id === templateId)) || templates.find((item) => item.isSystemDefault) || templates[0] || null;
  const emailTemplateId = template && template.id;
  getDefaultEmailTemplate.lastBody = template && String(template.body || '');
  log('Email Template', `Selected templateId=${emailTemplateId || 'NONE'}, bodyLength=${(getDefaultEmailTemplate.lastBody || '').length}`);

  check(res, {
    'get email templates: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'get email templates: template id returned': () => !!emailTemplateId,
  });

  return emailTemplateId;
}

export function getProjectById(clientToken, projectId, stepName = 'Get Project By Id') {
  const res = getJson(routes.projectById(projectId), clientToken, stepName);
  logStep(stepName, res);
  const project = responseObjectFromRes(res);

  check(res, {
    [`${stepName.toLowerCase()}: status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${stepName.toLowerCase()}: project returned`]: () => !!(project && project.id === projectId),
  });

  return project;
}

export function sendInvitationsToProjectCandidates(clientToken, projectId, emailTemplateId, candidateIds = [], candidateEmails = []) {
  const assignedCandidateIds = Array.isArray(candidateIds) ? candidateIds.filter(Boolean) : [];
  const assignedCandidateEmails = Array.isArray(candidateEmails) ? candidateEmails.filter(Boolean) : [];
  const preconditionsReady = check(
    { projectId, emailTemplateId, candidateCount: assignedCandidateIds.length },
    {
      'send project invitations: project id available': (value) => !!value.projectId,
      'send project invitations: email template selected': (value) => !!value.emailTemplateId,
      'send project invitations: at least one candidate assigned': (value) => value.candidateCount > 0,
    },
  );

  if (!preconditionsReady) {
    const body = 'Project invitation preconditions failed: project, email template, and assigned candidates are required.';
    log('Project Invitations', body);
    return { status: 0, body, timings: { duration: 0 } };
  }

  const recipientText = assignedCandidateEmails.length ? ` Recipients: ${assignedCandidateEmails.join(', ')}` : '';
  log(
    'Project Invitations',
    `Sending project invitation email to ${assignedCandidateIds.length} assigned candidate(s) for project ${projectId}.${recipientText}`,
  );

  // The backend endpoint sends the selected template to all candidates already
  // assigned to the project. Candidate IDs are validated above to prevent a
  // successful no-recipient call, but are intentionally not added to the API
  // payload because the confirmed contract accepts projectId + emailTemplateId.
  const payload = {
    projectId,
    emailTemplateId,
    extractToken,
  };
  const res = postJson(routes.sendProjectCandidateInvitations(), payload, clientToken, 'Send Project Candidate Invitations');
  logStep('Send Project Candidate Invitations', res);

  const body = parseResponseBody(res);
  const message = String((body && (body.message || (body.data && body.data.message))) || '');
  check(res, {
    'send project invitations: status 2xx': (r) => r.status >= 200 && r.status < 300,
    'send project invitations: backend confirmed email dispatch': () => /email sent successfully/i.test(message),
  });
  return res;
}

export function createAndAssignCandidatesFromCsvSeed(clientToken, projectId, organizationId, candidates) {
  const expectedCandidates = Array.isArray(candidates) ? candidates : [];
  const candidateIds = [];

  log(
    'Candidate Provisioning',
    `Creating ${expectedCandidates.length} project candidate(s) from data/candidates.csv using the confirmed create-for-project API.`,
  );

  expectedCandidates.forEach((candidate, index) => {
    const payload = {
      organizationId,
      name: candidate.name,
      email: candidate.email,
      force: false,
    };

    const step = `Create Project Candidate ${index + 1}/${expectedCandidates.length}`;

    // Retry on 429 rate-limit with exponential backoff
    let res;
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      res = postJson(routes.createCandidateForProject(projectId), payload, clientToken, step);
      if (res.status !== 429) break;
      const waitSec = attempt * 3; // 3s, 6s, 9s, 12s, 15s
      log('Candidate Provisioning', `[RETRY] ${step} — 429 rate limited, retry ${attempt}/${maxRetries} after ${waitSec}s`);
      sleep(waitSec);
    }

    logStep(`${step} (${candidate.email})`, res);
    const candidateId = extractCandidateId(res);

    check(res, {
      [`${step}: status 2xx`]: (r) => r.status >= 200 && r.status < 300,
      [`${step}: candidate id returned`]: () => !!candidateId,
    });

    if (!candidateId) {
      throw new Error(
        `Candidate provisioning failed for ${candidate.email}: create-for-project did not return a candidate ID (status=${res.status}).`,
      );
    }

    candidateIds.push(candidateId);
    // Pace requests to avoid rate limiting — 300ms between candidates
    sleep(0.3);
  });

  if (candidateIds.length !== expectedCandidates.length) {
    throw new Error(`Candidate provisioning failed: expected ${expectedCandidates.length} candidate IDs, resolved ${candidateIds.length}.`);
  }

  const assignRes = postJson(routes.bulkAssignCandidatesToProject(projectId), { candidateIds }, clientToken, 'Bulk Assign Candidates to Project');
  logStep('Bulk Assign Candidates to Project', assignRes);
  const assigned = check(assignRes, {
    'bulk assign candidates to project: status 2xx': (r) => r.status >= 200 && r.status < 300,
  });

  if (!assigned) {
    throw new Error(`Bulk candidate assignment failed for project ${projectId} (status=${assignRes.status}).`);
  }

  const verified = waitForAssignedProjectCandidates(clientToken, projectId, expectedCandidates, 12, 750);

  if (!verified.ok) {
    throw new Error(
      `Project candidate verification failed: expected ${expectedCandidates.length} assigned candidates, ` +
        `matched ${verified.matchedCount}. Missing: ${verified.missingEmails.join(', ')}`,
    );
  }

  log(
    'Candidate Provisioning',
    `Candidate provisioning complete: ${verified.matchedCount}/${expectedCandidates.length} candidates assigned to project ${projectId}.`,
  );

  return candidateIds;
}

export function waitForAssignedProjectCandidates(clientToken, projectId, expectedCandidates, maxAttempts = 12, delayMs = 750) {
  const expected = Array.isArray(expectedCandidates) ? expectedCandidates : [];
  const expectedEmails = new Set(
    expected.map((candidate) =>
      String(candidate.email || '')
        .trim()
        .toLowerCase(),
    ),
  );
  let matched = [];
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = getJson(routes.projectById(projectId), clientToken, 'Verify Project Candidates');
    lastStatus = res.status;
    const project = responseObjectFromRes(res);
    const records = project && Array.isArray(project.candidates) ? project.candidates : [];
    matched = records.filter((record) => expectedEmails.has(candidateEmailFromRecord(record)));

    log(
      'Candidate Provisioning',
      `Assignment verification ${attempt}/${maxAttempts}: ${matched.length}/${expected.length} expected candidates visible on project ${projectId}.`,
    );

    if (res.status >= 200 && res.status < 300 && matched.length === expected.length) {
      return { ok: true, matchedCount: matched.length, missingEmails: [], records: matched };
    }

    if (attempt < maxAttempts) sleep(delayMs / 1000);
  }

  const matchedEmails = new Set(matched.map(candidateEmailFromRecord).filter(Boolean));
  const missingEmails = expected
    .map((candidate) =>
      String(candidate.email || '')
        .trim()
        .toLowerCase(),
    )
    .filter((email) => email && !matchedEmails.has(email));

  check(
    { lastStatus, matchedCount: matched.length, expectedCount: expected.length },
    {
      'project candidates: project lookup status 2xx': (value) => value.lastStatus >= 200 && value.lastStatus < 300,
      'project candidates: all CSV-seed candidates assigned': (value) => value.matchedCount === value.expectedCount,
    },
  );

  return { ok: false, matchedCount: matched.length, missingEmails, records: matched };
}

function candidateEntity(record) {
  if (!record || typeof record !== 'object') return {};
  const candidate = record.candidate || record.user || record.profile || record;
  if (!candidate || typeof candidate !== 'object') return {};
  return candidate.user || candidate.profile || candidate;
}

function candidateEmailFromRecord(record) {
  const entity = candidateEntity(record);
  return String(entity.email || record.email || (record.candidate && record.candidate.email) || '')
    .trim()
    .toLowerCase();
}

function extractCandidateId(res) {
  const body = parseResponseBody(res);
  if (!body) return null;
  const data = body.data || body;
  return data.id || data.candidateId || data.userId || (data.user && data.user.id) || null;
}

function responseObjectFromRes(res) {
  const body = parseResponseBody(res);
  if (!body) return null;
  return body.data && !Array.isArray(body.data) ? body.data : body;
}

export function verifyProjectActive(clientToken, projectId, expectedCount = 1) {
  let project = null;

  // `candidateAccess` is not a reliable activation gate in the current backend
  // contract. The project API can report candidateAccess=false even after the
  // project is ACTIVE, invitations were accepted by the backend, all expected
  // candidates are attached, and candidate portal-token login succeeds.
  //
  // Treat the flag as diagnostic only. Candidate execution readiness is proven
  // by the real candidate authentication/session path that follows provisioning.
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    project = getProjectById(clientToken, projectId, 'Verify Active Project');
    const candidateCount = project && Array.isArray(project.candidates) ? project.candidates.length : 0;
    const candidateAccessFlag = project && Object.prototype.hasOwnProperty.call(project, 'candidateAccess') ? project.candidateAccess : 'UNAVAILABLE';

    log(
      'Project Activation',
      `Verification ${attempt}/10: status=${project && project.status ? project.status : 'UNKNOWN'}, ` +
        `candidateAccessFlag=${candidateAccessFlag} (diagnostic only), candidates=${candidateCount}/${expectedCount}.`,
    );

    if (project && project.status === 'ACTIVE' && project.emailTemplateId && candidateCount >= expectedCount) {
      break;
    }

    if (attempt < 10) sleep(1);
  }

  check(project || {}, {
    'project active: status ACTIVE': () => project && project.status === 'ACTIVE',
    'project active: email template selected': () => project && !!project.emailTemplateId,
    'project active: candidates assigned': () => project && Array.isArray(project.candidates) && project.candidates.length >= expectedCount,
  });

  return project;
}

export function completeProjectCreationFlow(clientToken, projectOrgId, roleProfileId, activities, options = {}) {
  const requestedCount = Number(options.candidateCount || NUM_CANDIDATES || 20);
  if (!Number.isFinite(requestedCount) || requestedCount < 1 || !Number.isInteger(requestedCount)) {
    throw new Error(`NUM_CANDIDATES must be a positive integer; received ${requestedCount}`);
  }
  if (requestedCount > candidateTemplates.length) {
    throw new Error(
      `NUM_CANDIDATES=${requestedCount} exceeds the ${candidateTemplates.length} candidate rows available in data/candidates.csv. ` +
        'Add more seed rows or lower NUM_CANDIDATES.',
    );
  }

  const candidateCount = requestedCount;
  const runCandidates = buildRunCandidates(candidateCount, options.candidateSuffix || uniqueSuffix());

  log('Project Creation', `Creating isolated project data for VU ${__VU}, iteration ${__ITER}: ${candidateCount} unique candidate(s)`);

  getJson(routes.organizationsList(), clientToken, 'Get Accounts');
  getJson(routes.roleProfilesList(), clientToken, 'Get Role Profiles');
  if (roleProfileId) getJson(routes.roleProfileById(roleProfileId), clientToken, 'Get Selected Role Profile');

  const projectId = createProject(clientToken, projectOrgId);
  if (roleProfileId) assignRoleProfileToProject(clientToken, projectId, roleProfileId);

  getJson(routes.bandsList(), clientToken, 'Get Bands');
  getJson(routes.activitiesList(), clientToken, 'Get Activities for Project Setup');

  const stageId = createProjectStage(clientToken, projectId);
  assignActivitiesToStage(clientToken, stageId, activities);

  const candidateIds = createAndAssignCandidatesFromCsvSeed(clientToken, projectId, projectOrgId, runCandidates);

  if (candidateIds.length !== candidateCount) {
    throw new Error(`Project candidate provisioning failed: expected ${candidateCount} candidates, resolved ${candidateIds.length}.`);
  }

  let emailTemplateId = null;
  let invitationResponse = null;
  let activeProject = null;

  if (SEND_PROJECT_INVITATIONS) {
    // The project detail is the source of truth for the selected template.
    const projectBeforeInvitation = getProjectById(clientToken, projectId, 'Get Project Details (Email Template)');
    const projectTemplateId = projectBeforeInvitation && projectBeforeInvitation.emailTemplateId;
    emailTemplateId = getDefaultEmailTemplate(clientToken, projectTemplateId);
    invitationResponse = sendInvitationsToProjectCandidates(
      clientToken,
      projectId,
      emailTemplateId,
      candidateIds,
      runCandidates.map((candidate) => candidate.email),
    );

    if (!invitationResponse || invitationResponse.status < 200 || invitationResponse.status >= 300) {
      throw new Error('Project invitation dispatch failed; candidate activity execution must not start.');
    }

    activeProject = verifyProjectActive(clientToken, projectId, candidateCount);
    if (!activeProject || activeProject.status !== 'ACTIVE') {
      throw new Error('Project did not reach ACTIVE state after invitation dispatch.');
    }
  } else {
    log(
      'Project Invitations',
      'SEND_PROJECT_INVITATIONS=false: invitation dispatch is disabled. The managed project remains provisioning-only and candidate activities must not start.',
    );
    activeProject = getProjectById(clientToken, projectId, 'Get Provisioned Project');
  }

  const invitationSent = !!(invitationResponse && invitationResponse.status >= 200 && invitationResponse.status < 300);

  // Extract per-candidate invitation hrefs from the bulk invitation response.
  // The API returns accessMyPortal as an array when multiple candidates are invited.
  // Store all hrefs indexed by candidateId so downstream phases can login without re-dispatching.
  const allInvitationHrefs = {};
  if (invitationResponse) {
    try {
      const invBody = parseResponseBody(invitationResponse);
      const portalArray = invBody && (invBody.accessMyPortal || (invBody.data && invBody.data.accessMyPortal));
      if (Array.isArray(portalArray)) {
        portalArray.forEach((item) => {
          if (item && item.accessMyPortal) {
            // Index by both candidateId and email for flexible lookup.
            if (item.candidateId) allInvitationHrefs[String(item.candidateId)] = item.accessMyPortal;
            if (item.email) allInvitationHrefs[String(item.email).toLowerCase()] = item.accessMyPortal;
          }
        });
      } else if (typeof portalArray === 'string' && portalArray) {
        // Single-candidate invitation returns a plain string.
        if (candidateIds[0]) allInvitationHrefs[String(candidateIds[0])] = portalArray;
      }
    } catch (e) {
      // ignore — allInvitationHrefs stays empty
    }
  }

  return {
    projectId,
    stageId,
    candidates: runCandidates,
    candidateIds,
    candidateCount,
    emailTemplateId,
    invitationSent,
    allInvitationHrefs,
    invitationHref: extractInvitationHref(
      invitationResponse,
      candidateIds[0],
      runCandidates[0] && runCandidates[0].email
    ),
    // Preserve rendered invitation content when the API returns it. The
    // candidate flow extracts access_token from the email login href.
    invitationBody:
      invitationResponse && /access_token=/i.test(String(invitationResponse.body || ''))
        ? invitationResponse.body
        : getDefaultEmailTemplate.lastBody || '',
    projectStatus: activeProject && activeProject.status,
    candidateExecutionAllowed: SEND_PROJECT_INVITATIONS && invitationSent && activeProject && activeProject.status === 'ACTIVE',
  };
}

export function extractInvitationHref(res, candidateId, candidateEmail) {
  const body = parseResponseBody(res);
  const value = body && (body.accessMyPortal || (body.data && body.data.accessMyPortal));
  if (Array.isArray(value)) {
    const match = value.find((item) =>
      String(item && item.candidateId || '') === String(candidateId || '') ||
      String(item && item.email || '').toLowerCase() === String(candidateEmail || '').toLowerCase()
    );
    return match && match.accessMyPortal ? match.accessMyPortal : '';
  }
  return typeof value === 'string' ? value : '';
}

function buildRunCandidates(count, suffix) {
  const normalizedSuffix = String(suffix || uniqueSuffix())
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-28);
  return candidateTemplates.slice(0, count).map((candidate, index) => {
    const at = candidate.email.lastIndexOf('@');
    const local = at >= 0 ? candidate.email.slice(0, at) : `candidate${index + 1}`;
    const domain = at >= 0 ? candidate.email.slice(at + 1) : 'yopmail.com';
    return {
      name: `${candidate.name} Load ${__VU}-${__ITER}`,
      email: `${local}.load.${normalizedSuffix}.${index + 1}@${domain}`,
    };
  });
}

function buildCandidatesCsv(candidates) {
  const rows = ['name,email'];
  (candidates || []).forEach((candidate) => {
    const name = String(candidate.name || '').replace(/"/g, '""');
    const email = String(candidate.email || '').replace(/"/g, '""');
    rows.push(`"${name}","${email}"`);
  });
  return `${rows.join('\n')}\n`;
}

// Safely parses JSON from a k6 response. Returns null on any parse error.
function parseResponseBody(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

function parseCandidatesCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const headers = lines
    .shift()
    .split(',')
    .map((header) => header.trim());
  const nameIndex = headers.indexOf('name');
  const emailIndex = headers.indexOf('email');
  return lines
    .map((line) => line.split(',').map((value) => value.trim()))
    .filter((columns) => columns[nameIndex] && columns[emailIndex])
    .map((columns) => ({
      name: columns[nameIndex],
      email: columns[emailIndex],
    }));
}

function responseListFromRes(res) {
  const body = parseResponseBody(res);
  if (!body) return [];
  return (
    (body.data && body.data.data) ||
    (body.data && body.data.items) ||
    (body.data && body.data.candidates) ||
    (body.data && body.data.projectCandidates) ||
    (body.data && body.data.results) ||
    (Array.isArray(body.data) ? body.data : null) ||
    body.items ||
    body.candidates ||
    body.projectCandidates ||
    []
  );
}

function hasNestedId(res, key, expectedId) {
  const body = parseResponseBody(res);
  return !!(body && body.data && body.data[key] && body.data[key].id === expectedId);
}

// Standalone-runnable: `k6 run scenarios/projectcreation.js`
export default function () {
  const superAdminToken = superAdminLogin();
  const { orgId, adminUserId } = createClient(superAdminToken);
  const activities = createAllTaskTypes(superAdminToken);
  assignTasksToOrg(superAdminToken, orgId, activities);

  const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
  const setup = setupAccountAndSkillsProfile(clientToken, orgId);
  const projectOrgId = setup.accountOrgId || orgId;
  completeProjectCreationFlow(clientToken, projectOrgId, setup.roleProfileId, activities);
}
