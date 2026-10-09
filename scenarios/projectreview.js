// Client Admin project review flow.
//
// Mirrors Review Project.har:
//   1. Load candidate scoring list for the project
//   2. Load project details, bands, and candidate stages
//   3. Open each activity score detail
//   4. PATCH reviewer score/reason for each reviewable sub-skill
//   5. Load review summary, submit stage review, and fetch report

import { check, sleep } from 'k6';
import { getJson, getJsonWithHeaders, postJsonWithHeaders, patchJsonWithHeaders } from '../utils/http.js';
import { log, logStep } from '../utils/helpers.js';
import { routes } from '../utils/routes.js';
import { PORTALS, HARDCODED_CANDIDATES } from '../config/environments.js';
import { superAdminLogin, clientAdminLogin, impersonateClientAdmin } from './login.js';

const REVIEW_REASON = __ENV.PROJECT_REVIEW_REASON || 'good';
const REVIEW_SCORE_OVERRIDE = __ENV.PROJECT_REVIEW_SCORE ? Number(__ENV.PROJECT_REVIEW_SCORE) : null;
const DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID = __ENV.CLIENT_ADMIN_USER_ID;
const CLIENT_ADMIN_HEADERS = {
  'x-base-origin': 'client-admin',
  Origin: PORTALS.clientAdmin,
  Referer: `${PORTALS.clientAdmin}/`
};

function reviewProjectId() {
  return (
    __ENV.PROJECT_REVIEW_PROJECT_ID ||
    __ENV.REVIEW_PROJECT_ID ||
    HARDCODED_CANDIDATES[0]?.projectId ||
    null
  );
}

export function projectReviewLogin() {
  if (__ENV.CLIENT_ADMIN_EMAIL && __ENV.CLIENT_ADMIN_PASSWORD) {
    return clientAdminLogin(__ENV.CLIENT_ADMIN_EMAIL, __ENV.CLIENT_ADMIN_PASSWORD);
  }

  const superAdminToken = superAdminLogin();
  if (!superAdminToken) return null;

  const clientAdminUserId = __ENV.CLIENT_ADMIN_USER_ID || __ENV.HARDCODED_CLIENT_ADMIN_USER_ID || DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID;

  log('Project Review', `Impersonating client admin userId=${clientAdminUserId}`);
  return impersonateClientAdmin(superAdminToken, clientAdminUserId);
}

// Previously named completeHardcodedProjectReviewFlow — renamed because the
// flow is no longer hardcoded: project candidates are resolved dynamically
// from the API, with HARDCODED_CANDIDATES as a last-resort fallback only.
export function runProjectReviewFlow(
  token,
  projectId = reviewProjectId(),
  candidates = HARDCODED_CANDIDATES
) {
  if (!projectId) {
    log('Project Review', 'ABORTED - project id is missing');
    return [];
  }

  reviewGet(routes.organizationsList(1, 1000), token, 'Project Review - Get Accounts');
  const projectRes = reviewGet(routes.projectById(projectId), token, 'Project Review - Get Project Details');
  logStep('Project Review - Get Project Details', projectRes);
  reviewGet(routes.bandsList(1, 15), token, 'Project Review - Get Bands');

  const reviewTargets = resolveReviewTargetsFromProject(projectRes, candidates);
  check(reviewTargets, { 'project review: target candidates found': (items) => items.length > 0 });

  const results = [];
  reviewTargets.forEach((target) => {
    const stages = target.stages;
    stages.forEach((stage) => {
      const stageId = stage.stageId;
      const activities = stage.activities || [];

      check(stage, {
        'project review stage: id returned': () => !!stageId,
        'project review stage: activities returned': () => activities.length > 0
      });

      let reviewedItems = 0;
      let skippedActivities = 0;
      activities.forEach((activity, activityIndex) => {
        const result = reviewActivity(token, projectId, target.candidateId, activity, activityIndex);
        reviewedItems += result.reviewedItems;
        if (result.skipped) skippedActivities += 1;
        sleep(0.5);
      });

      const summaryRes = reviewGet(
        routes.projectCandidateReviewSummary(projectId, target.candidateId, stageId),
        token,
        'Project Review - Get Summary'
      );
      logStep(`Project Review - Get Summary (${target.candidateId})`, summaryRes);
      check(summaryRes, { 'project review summary: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      if (reviewedItems === 0) {
        log('Project Review', `SKIP submit - candidateId=${target.candidateId} stageId=${stageId}: no skills/sub-skills were reviewed; skippedActivities=${skippedActivities}`);
        results.push({ candidateId: target.candidateId, stageId, submitted: false, reviewedItems, skippedActivities });
        return;
      }

      const submitRes = reviewPost(
        routes.submitProjectCandidateStageReview(projectId, target.candidateId, stageId),
        {},
        token,
        'Project Review - Submit Review'
      );
      logStep(`Project Review - Submit Review (${target.candidateId})`, submitRes);
      check(submitRes, { 'project review submit: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      const reportRes = reviewGet(
        routes.projectCandidateStageReport(projectId, stageId, target.candidateId),
        token,
        'Project Review - Get Report'
      );
      logStep(`Project Review - Get Report (${target.candidateId})`, reportRes);
      check(reportRes, { 'project review report: status 2xx': (r) => r.status >= 200 && r.status < 300 });

      const completed = submitRes.status >= 200 && submitRes.status < 300 && isReviewMarkedComplete(submitRes, reportRes);
      if (completed) {
        log('Project Review', `Review completed - candidateId=${target.candidateId} stageId=${stageId} reviewedItems=${reviewedItems} skippedActivities=${skippedActivities}`);
      } else {
        log('Project Review', `Warning: submit succeeded but the completion marker was not confirmed - candidateId=${target.candidateId} stageId=${stageId}`);
      }

      results.push({ candidateId: target.candidateId, stageId, submitted: submitRes.status >= 200 && submitRes.status < 300, reviewedItems, skippedActivities });
    });
  });

  return results;
}

function resolveProjectAdminUserId(superAdminToken, projectId) {
  if (!projectId) return DEFAULT_REVIEW_CLIENT_ADMIN_USER_ID;

  const projectRes = getJson(routes.projectById(projectId), superAdminToken, 'Project Review - Resolve Project Org');
  logStep('Project Review - Resolve Project Org', projectRes);

  const org = extractProjectOrganization(projectRes);
  if (!org.id && !org.name) return null;

  if (org.id) {
    const orgByIdRes = getJson(routes.organizationById(org.id), superAdminToken, 'Project Review - Resolve Client Admin By Org Id');
    logStep('Project Review - Resolve Client Admin By Org Id', orgByIdRes);
    const adminFromOrgById = extractAdminUserId(orgByIdRes, org);
    if (adminFromOrgById) {
      log('Project Review', `Resolved project org admin userId=${adminFromOrgById} from org id=${org.id}`);
      return adminFromOrgById;
    }
  }

  const search = encodeURIComponent(org.name || org.id);
  const orgRes = getJson(`${routes.organizationsList(1, 10)}&search=${search}`, superAdminToken, 'Project Review - Resolve Client Admin');
  logStep('Project Review - Resolve Client Admin', orgRes);

  const adminUserId = extractAdminUserId(orgRes, org);
  if (adminUserId) {
    log('Project Review', `Resolved project org admin userId=${adminUserId} for org=${org.name || org.id}`);
  } else {
    log('Project Review', `Could not resolve project org admin for org=${org.name || org.id}`);
  }
  return adminUserId;
}

function extractProjectOrganization(res) {
  const body = parseResponseBody(res);
  if (!body) return { id: null, name: null };
  const project = body.data;
  const org = (project && project.organization) || {};
  return { id: org.id || (project && project.organizationId) || null, name: org.name || (project && project.organizationName) || null };
}

function extractAdminUserId(res, projectOrg) {
  const orgs = responseData(res);
  const list = Array.isArray(orgs) && orgs.length ? orgs : [safeDataObject(res)].filter(Boolean);
  const match = list.find((org) => {
    if (projectOrg.id && org.id === projectOrg.id) return true;
    return projectOrg.name && org.name === projectOrg.name;
  }) || list[0];

  return match && ((match.admin && match.admin.id) || match.ownerId || null);
}

function safeDataObject(res) {
  const body = parseResponseBody(res);
  return body && body.data && !Array.isArray(body.data) ? body.data : null;
}

function reviewActivity(token, projectId, candidateId, activity, activityIndex) {
  const activityId = activity.activityId;
  const detailRes = reviewGet(
    routes.scoringProjectCandidateActivity(projectId, candidateId, activityId),
    token,
    'Project Review - Get Activity Score'
  );
  logStep(`Project Review - Get Activity Score (${activityId})`, detailRes);

  if (detailRes.status === 404) {
    log('Project Review', `SKIP activityId=${activityId}: activity not found in project for candidateId=${candidateId}`);
    return { skipped: true, reviewedItems: 0, reason: 'activity_not_found' };
  }

  if (detailRes.status < 200 || detailRes.status >= 300) {
    log('Project Review', `SKIP activityId=${activityId}: activity score request failed with status=${detailRes.status}`);
    return { skipped: true, reviewedItems: 0, reason: 'activity_score_failed' };
  }

  const missingReason = getMissingReviewDataReason(detailRes);
  if (missingReason) {
    log('Project Review', `SKIP activityId=${activityId}: ${missingReason}`);
    return { skipped: true, reviewedItems: 0, reason: 'missing_review_data' };
  }

  logTranscriptWarning(detailRes, activityId);
  const reviewItems = extractReviewItems(detailRes, null, activityId, activity.type, activityIndex);
  if (reviewItems.length === 0) {
    log('Project Review', `SKIP activityId=${activityId}: ${explainMissingReviewItems(detailRes)}`);
    return { skipped: true, reviewedItems: 0, reason: 'no_review_items' };
  }

  validateCandidateResponsesAgainstTranscript(detailRes, activityId, candidateId);

  let reviewedItems = 0;
  reviewItems.forEach((item) => {
    const res = reviewPatch(
      routes.reviewProjectCandidate(projectId, candidateId),
      item,
      token,
      'Project Review - Save Sub Skill Review'
    );
    logStep(`Project Review - Save Sub Skill Review (${activityId})`, res);
    check(res, { 'project review save sub skill: status 2xx': (r) => r.status >= 200 && r.status < 300 });
    if (res.status >= 200 && res.status < 300) reviewedItems += 1;

    reviewGet(
      routes.scoringProjectCandidateActivity(projectId, candidateId, activityId),
      token,
      'Project Review - Refresh Activity Score'
    );
  });

  return { skipped: reviewedItems === 0, reviewedItems, reason: reviewedItems === 0 ? 'save_failed' : null };
}

function resolveReviewTargetsFromProject(res, configuredCandidates) {
  const project = safeDataObject(res);
  if (!project) return [];

  // Priority for who gets reviewed:
  //   1. PROJECT_REVIEW_CANDIDATE_ID / REVIEW_CANDIDATE_ID — explicit single-
  //      candidate override, when you deliberately want just one.
  //   2. The project's real candidates, as returned by the API — this is what
  //      "review every candidate assigned to the project" means, and must
  //      win over the hardcoded config; otherwise the hardcoded single
  //      candidate always wins (it's never empty) and every other assigned
  //      candidate is silently skipped regardless of any limit setting.
  //   3. HARDCODED_CANDIDATES (config) — last-resort fallback only if the API
  //      genuinely returned no candidates for this project.
  const explicitCandidateId = __ENV.PROJECT_REVIEW_CANDIDATE_ID || __ENV.REVIEW_CANDIDATE_ID;
  const projectCandidates = project.candidates || [];
  const projectCandidateIds = projectCandidates
    .map((row) => (row.candidate && row.candidate.id) || row.candidateId || row.id)
    .filter(Boolean);
  const configuredCandidateIds = configuredCandidates.map((candidate) => candidate.candidateId).filter(Boolean);

  const candidateIds = explicitCandidateId
    ? [explicitCandidateId]
    : projectCandidateIds.length
      ? projectCandidateIds
      : configuredCandidateIds;

  // WELCOME activities are never reviewable — the backend does not score
  // or track them as part of a project stage's review, so requesting a
  // score for one always 404s ("Activity not found in project"). Excluding
  // them here means reviewActivity() is never called for them at all,
  // instead of calling it and handling the resulting 404 after the fact.
  const stageRows = (project.stages || []).map((stage) => ({
    stageId: stage.id || stage.stageId,
    stageName: stage.name || stage.stageName,
    activities: (stage.stageActivities || stage.activities || [])
      .map((row) => ({
        activityId: (row.activity && row.activity.id) || row.activityId || row.id,
        title: (row.activity && row.activity.title) || row.title,
        type: (row.activity && row.activity.type) || row.type
      }))
      .filter((activity) => activity.activityId && activity.type !== 'WELCOME')
  })).filter((stage) => stage.stageId && stage.activities.length > 0);

  // No cap by default — validate/review every candidate assigned to the
  // project. Set PROJECT_REVIEW_CANDIDATE_LIMIT explicitly to restrict to a
  // smaller batch (e.g. for a quick smoke run).
  const candidateLimit = __ENV.PROJECT_REVIEW_CANDIDATE_LIMIT
    ? Number(__ENV.PROJECT_REVIEW_CANDIDATE_LIMIT)
    : candidateIds.length;

  return candidateIds.slice(0, candidateLimit).map((candidateId) => ({
    candidateId,
    stages: stageRows
  }));
}

function resolveReviewTargets(res, configuredCandidates) {
  const rows = responseData(res);
  const explicitCandidateId = __ENV.PROJECT_REVIEW_CANDIDATE_ID || __ENV.REVIEW_CANDIDATE_ID;
  const wantedIds = explicitCandidateId
    ? [explicitCandidateId]
    : configuredCandidates
        .map((candidate) => candidate.reviewCandidateId || candidate.projectReviewCandidateId || candidate.candidateId)
        .filter(Boolean);
  const projects = Array.isArray(rows) ? rows : [];
  const candidates = [];
  projects.forEach((project) => {
    (project.candidates || []).forEach((candidate) => {
      const isRequested = wantedIds.length && wantedIds.indexOf(candidate.candidateId) !== -1;
      const isReviewable =
        !wantedIds.length &&
        candidate.candidateStatus === 'COMPLETED' &&
        (!candidate.actionLabel || candidate.actionLabel === 'Review') &&
        hasReviewableStage(candidate);

      if (isRequested || isReviewable) {
        candidates.push({
          candidateId: candidate.candidateId,
          candidateName: candidate.candidateName,
          stages: candidate.stages || []
        });
      }
    });
  });
  return candidates.slice(0, Number(__ENV.PROJECT_REVIEW_CANDIDATE_LIMIT || 1));
}

function hasReviewableStage(candidate) {
  return (candidate.stages || []).some((stage) => stage.stageId && stage.stageCandidateId && (stage.activities || []).length > 0);
}

function mergeStageDetails(candidateStages, stageDetails) {
  const byId = {};
  (candidateStages || []).forEach((stage) => {
    byId[stage.stageId] = { ...stage };
  });
  (stageDetails || []).forEach((stage) => {
    const existing = byId[stage.stageId] || {};
    byId[stage.stageId] = {
      ...existing,
      ...stage,
      activities: stage.activities || existing.activities || []
    };
  });
  return Object.values(byId);
}

function extractStages(res) {
  const rows = responseData(res);
  const first = Array.isArray(rows) ? rows[0] : null;
  return (first && first.stages) || [];
}

function extractReviewItems(res, fallbackStageCandidateId, fallbackActivityId, activityType, activityIndex = 0) {
  try {
    const body = parseResponseBody(res);
    const activity = body && body.data && body.data.activity;
    const stageCandidateId = (activity && activity.stageCandidateId) || fallbackStageCandidateId;
    const activityId = (activity && activity.id) || fallbackActivityId;
    const skills = (activity && activity.skills) || [];
    const items = [];

    skills.forEach((skill, skillIndex) => {
      (skill.subSkills || []).forEach((subSkill, subSkillIndex) => {
        const skillId = skill.skillId || skill.id;
        const subSkillId = subSkill.subSkillId || subSkill.id;
        if (!skillId || !subSkillId) return;
        const score = reviewScore(activityType, activityIndex, skillIndex, subSkillIndex, subSkill.score);
        items.push({
          stageCandidateId,
          activityId,
          skillId,
          subSkillId,
          reviewerScore: score,
          reviewerScoreReason: reviewReason(score, skill.skillName, subSkill.subSkillName)
          // NOTE: candidateResponse/evidenceRationale intentionally NOT included
          // here — this object is sent verbatim as the PATCH body to
          // reviewProjectCandidate, and the backend DTO rejects unknown
          // properties ("property candidateResponse should not exist"). The
          // verbatim-transcript evidence check reads those fields straight off
          // the raw Get Activity Score response instead — see
          // validateCandidateResponsesAgainstTranscript() below — so nothing
          // is lost, it's just kept out of what gets submitted back to the API.
        });
      });
    });

    return items.filter((item) => item.stageCandidateId && item.activityId);
  } catch (e) {
    return [];
  }
}

function getMissingReviewDataReason(res) {
  try {
    const body = parseResponseBody(res);
    const activity = body && body.data && body.data.activity;
    if (!activity) return 'activity detail payload is missing';
    if (!activity.transcript) return 'transcript not found, so no evidence is available for review';
    const skills = activity.skills || [];
    if (skills.length === 0) return 'skills not found on activity score response';
    const subSkillCount = skills.reduce((count, skill) => count + ((skill.subSkills || []).length), 0);
    if (subSkillCount === 0) return 'sub-skills not found on activity score response';
    return null;
  } catch (e) {
    return 'activity score response could not be parsed';
  }
}

function reviewScore(activityType, activityIndex, skillIndex, subSkillIndex, systemScore) {
  if (Number.isFinite(REVIEW_SCORE_OVERRIDE)) return REVIEW_SCORE_OVERRIDE;

  const pattern = [2, 4, 3, 5, 1, 4, 2, 5];
  const typeOffset = {
    CASE: 0,
    INTERVIEW: 1,
    ROLE_PLAY: 2,
    BOARD_MEETING: 3,
    SITUATIONS: 4,
    WELCOME: 5
  }[activityType] || 0;
  const index = (activityIndex + typeOffset + skillIndex * 2 + subSkillIndex) % pattern.length;
  return pattern[index] || systemScore || 3;
}

function reviewReason(score, skillName, subSkillName) {
  const label = `${skillName || 'Skill'} / ${subSkillName || 'Sub-skill'}`;
  if (score >= 5) return `${label}: clear strength; evidence shows consistent, high-quality behaviour.`;
  if (score >= 4) return `${label}: strong performance with only minor gaps to refine.`;
  if (score >= 3) return `${label}: acceptable performance; next step is to make reasoning more specific and evidence-led.`;
  if (score >= 2) return `${label}: developing area; needs clearer structure, stronger evidence, and more complete explanation.`;
  return `${label}: key improvement area; response needs more relevant evidence and a clearer approach.`;
}

function explainMissingReviewItems(res) {
  try {
    const body = parseResponseBody(res);
    const activity = body && body.data && body.data.activity;
    if (!activity) return 'activity detail payload is missing';
    const skills = activity.skills || [];
    if (skills.length === 0) return 'skills not found on activity score response';
    const subSkillCount = skills.reduce((count, skill) => count + ((skill.subSkills || []).length), 0);
    if (subSkillCount === 0) return 'sub-skills not found on activity score response';
    return 'skills/sub-skills are present but ids required for review payload are missing';
  } catch (e) {
    return 'activity score response could not be parsed';
  }
}

// Normalizes text for comparison: lowercase, strip punctuation, collapse
// whitespace. This lets a verbatim-quote check tolerate cosmetic differences
// (casing, stray punctuation, double spaces) without tolerating an actually
// different or fabricated quote.
function normalizeQuoteText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// activity.transcript is the same { role, content, name, interrupted } shape
// confirmed via the real HAR capture and mirrored in utils/socketConversation.js
// / data/conversationScripts.js. role === 'user' is the candidate's own lines.
function extractCandidateTranscriptText(res) {
  try {
    const body = parseResponseBody(res);
    const activity = body && body.data && body.data.activity;
    const lines = (activity && activity.transcript) || [];
    return normalizeQuoteText(
      lines
        .filter((line) => line && line.role === 'user')
        .map((line) => line.content || '')
        .join(' ')
    );
  } catch (e) {
    return '';
  }
}

// Validates that every "Candidate response" quoted in the review evidence is
// an actual, word-for-word excerpt of what that candidate said — not a
// paraphrase or a hallucinated summary. Runs for every candidate the review
// flow processes (see resolveReviewTargetsFromProject — no longer capped to
// a single hardcoded candidate unless PROJECT_REVIEW_CANDIDATE_LIMIT is set).
function validateCandidateResponsesAgainstTranscript(detailRes, activityId, candidateId) {
  const body = parseResponseBody(detailRes);
  const activity = body && body.data && body.data.activity;
  if (!activity) return;

  const skills = activity.skills || [];
  const candidateTranscriptText = extractCandidateTranscriptText(detailRes);

  skills.forEach((skill) => {
    (skill.subSkills || []).forEach((subSkill) => {
      const candidateResponse = subSkill.candidateResponse;
      if (!candidateResponse) return; // nothing to validate for this sub-skill

      const normalizedResponse = normalizeQuoteText(candidateResponse);
      const matchesTranscript = !!normalizedResponse && candidateTranscriptText.includes(normalizedResponse);

      check(null, {
        [`project review evidence: candidate response is verbatim from transcript (${activityId})`]: () => matchesTranscript
      });

      if (!matchesTranscript) {
        log(
          'Project Review',
          `WARN activityId=${activityId} candidateId=${candidateId} skill=${skill.skillName || skill.skillId} subSkill=${subSkill.subSkillName || subSkill.subSkillId}: candidate response evidence does not match the transcript word-for-word (possible paraphrase/hallucination)`
        );
      }
    });
  });
}

function logTranscriptWarning(res, activityId) {
  const body = parseResponseBody(res);
  const activity = body && body.data && body.data.activity;
  if (activity && !activity.transcript) {
    log('Project Review', `WARN activityId=${activityId}: transcript not found; reviewing available skills/sub-skills`);
  }
}

function isReviewMarkedComplete(submitRes, reportRes) {
  const submitBody = parseResponseBody(submitRes);
  if (submitBody && submitBody.data && submitBody.data.reviewSubmittedAt) return true;
  const reportBody = parseResponseBody(reportRes);
  return !!(reportBody && reportBody.data && reportBody.data.pdfReportUrl);
}

// Safely parses JSON from a k6 response. Returns null on any parse error,
// so callers never need their own try/catch for this common operation.
function parseResponseBody(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

function responseData(res) {
  const body = parseResponseBody(res);
  if (!body) return [];
  return (
    (body.data && body.data.data) ||
    (body.data && body.data.items) ||
    (body.data && body.data.projects) ||
    (body.data && body.data.results) ||
    (Array.isArray(body.data) ? body.data : null) ||
    body.projects ||
    body.items ||
    body.results ||
    []
  );
}

function reviewGet(url, token, name) {
  return getJsonWithHeaders(url, token, name, CLIENT_ADMIN_HEADERS);
}

function reviewPost(url, body, token, name) {
  return postJsonWithHeaders(url, body, token, name, CLIENT_ADMIN_HEADERS);
}

function reviewPatch(url, body, token, name) {
  return patchJsonWithHeaders(url, body, token, name, CLIENT_ADMIN_HEADERS);
}

export default function () {
  const token = projectReviewLogin();
  if (!token) return;
  runProjectReviewFlow(token);
}