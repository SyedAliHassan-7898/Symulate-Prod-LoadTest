// tests/smoke-no-anum-setup.js
//
// Phase 1 setup for all Anam validation modes.
// The filename is retained for backwards compatibility with existing npm
// scripts, but behavior is controlled by ANAM_MODE / ANUM_API_ENABLED.
//
// Candidate allocation:
//   candidateIds[0]      -> browser / Playwright candidate (john1)
//   candidateIds[1..6]   -> one dedicated audit candidate per activity
// This prevents the backend audit from leaving an active session on the
// browser candidate.

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { b64encode } from 'k6/encoding';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';

import { HARDCODED_CANDIDATES, ANUM_API_ENABLED, NUM_CANDIDATES } from '../config/environments.js';
import { reportName, log, logStep, uniqueSuffix } from '../utils/helpers.js';
import { getJson, postJson, extractId } from '../utils/http.js';
import { routes } from '../utils/routes.js';

import { superAdminLogin, impersonateClientAdmin, candidatePortalTokenLogin } from '../scenarios/login.js';
import { createAllTaskTypes } from '../scenarios/taskcreation.js';
import { assignTasksToOrg } from '../scenarios/taskassign.js';
import { setupAccountAndSkillsProfile } from '../scenarios/accountsetup.js';
import {
  completeProjectCreationFlow,
  configureTalentIntelligenceForMode,
  normalizeAnamMode,
  getDefaultEmailTemplate,
  sendInvitationsToProjectCandidates,
  extractInvitationHref
} from '../scenarios/projectcreation.js';
import { candidateSessionFromInviteHref } from '../scenarios/candidateassessment.js';

const ANAM_MODE = normalizeAnamMode(__ENV.ANAM_MODE);

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(95)'],
  scenarios: {
    no_anum_setup: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '6m',
      gracefulStop: '30s'
    }
  },
  thresholds: { checks: ['rate==1.0'] }
};

function createValidationClient(superAdminToken) {
  const suffix = uniqueSuffix();
  const clientEmail = `loadtest.anamval.${suffix}@yopmail.com`;
  const payload = {
    organizationName: `Anam Validation Org ${suffix}`,
    name: `Anam Validation Admin ${suffix}`,
    email: clientEmail
  };

  log('Anam Setup', `Creating validation org: ${clientEmail}`);
  const res = postJson(routes.organizations(), payload, superAdminToken, 'Create Anam Validation Client');
  logStep('Create Anam Validation Client', res);

  const orgId = extractId(res, 'id');
  let adminUserId = null;
  try {
    const body = res.json();
    const data = body.data || body;
    adminUserId = data.ownerId || (data.owner && data.owner.id) || null;
  } catch (e) {}

  check(res, {
    'anam setup: org created (status 2xx)': (r) => r.status >= 200 && r.status < 300,
    'anam setup: org id returned': () => !!orgId,
    'anam setup: admin user id returned': () => !!adminUserId
  });

  return { orgId, adminUserId, adminEmail: clientEmail };
}

function getTalentIntelligenceStatus(superAdminToken, orgId) {
  const res = getJson(routes.organizationById(orgId), superAdminToken, 'Confirm Talent Intelligence Status');
  logStep('Confirm Talent Intelligence Status', res);
  try {
    const body = res.json();
    const org = body && body.data;
    return org ? org.enableTalentIntelligence : null;
  } catch (e) {
    return null;
  }
}

export default function () {
  log(
    'Anam Setup',
    `=== Phase 1: validation setup (ANAM_MODE=${ANAM_MODE}, ANUM_API_ENABLED=${ANUM_API_ENABLED}) ===`
  );

  try {
    const superAdminToken = superAdminLogin();
    if (!superAdminToken) {
      exec.test.abort('Super Admin login failed');
      return;
    }

    const { orgId, adminUserId } = createValidationClient(superAdminToken);
    if (!orgId || !adminUserId) {
      exec.test.abort('Validation organization creation did not return the required identifiers');
      return;
    }

    const configured = configureTalentIntelligenceForMode(superAdminToken, orgId, ANAM_MODE);
    const expectedTalentIntelligence = configured.enabled;
    const actualTalentIntelligence = getTalentIntelligenceStatus(superAdminToken, orgId);

    log(
      'Anam Setup',
      `API confirmed enableTalentIntelligence=${actualTalentIntelligence}; expected=${expectedTalentIntelligence}`
    );
    check(actualTalentIntelligence, {
      [`anam setup: enableTalentIntelligence=${expectedTalentIntelligence} confirmed`]: (value) =>
        value === expectedTalentIntelligence
    });

    const activities = createAllTaskTypes(superAdminToken);
    assignTasksToOrg(superAdminToken, orgId, activities);

    const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
    if (!clientToken) {
      exec.test.abort('Client Admin impersonation failed');
      return;
    }

    const setup = setupAccountAndSkillsProfile(clientToken, orgId);
    const projectOrgId = setup.accountOrgId || orgId;
    const minimumCandidates = activities.length + 1;
    if (NUM_CANDIDATES < minimumCandidates) {
      exec.test.abort(
        `Anam validation requires at least ${minimumCandidates} project candidates ` +
        `(1 browser candidate + ${activities.length} dedicated audit candidates); NUM_CANDIDATES=${NUM_CANDIDATES}.`
      );
      return;
    }

    const project = completeProjectCreationFlow(
      clientToken,
      projectOrgId,
      setup.roleProfileId,
      activities
    );

    const projectId = project && project.projectId;
    const projectCandidateIds = (project && project.candidateIds) || [];
    const projectCandidates = (project && project.candidates) || [];

    check(projectId, {
      'anam setup: project created and id returned': (id) => !!id
    });

    const browserCandidateId = projectCandidateIds[0] || null;
    const browserCandidateEmail =
      (projectCandidates[0] && projectCandidates[0].email) ||
      __ENV.NOANUMTEST_CANDIDATE_EMAIL ||
      (HARDCODED_CANDIDATES[0] && HARDCODED_CANDIDATES[0].email) ||
      null;

    const requiredAuditCandidates = activities.length;
    const auditCandidateIds = projectCandidateIds.slice(1, 1 + requiredAuditCandidates);

    check(browserCandidateId, {
      'anam setup: browser candidate id available': (id) => !!id
    });
    check(auditCandidateIds, {
      'anam setup: dedicated audit candidate ids available': (ids) =>
        ids.length === requiredAuditCandidates
    });

    let candidateAccessToken = null;
    let candidateRefreshToken = null;
    let candidateOrgId = null;
    let candidateParentOrgId = null;

    if (browserCandidateId && projectId) {
      // Try portal-tokens first; fall back to invitation-href if the endpoint returns 404.
      try {
        const portalSession = candidatePortalTokenLogin(browserCandidateId, projectId);
        candidateAccessToken = portalSession && portalSession.token ? portalSession.token : null;
        candidateRefreshToken = portalSession && portalSession.refreshToken ? portalSession.refreshToken : null;
        candidateOrgId = portalSession && portalSession.organizationId ? portalSession.organizationId : null;
        candidateParentOrgId = portalSession && portalSession.parentOrganizationId
          ? portalSession.parentOrganizationId
          : null;
      } catch (e) {
        log('Anam Setup', `Browser candidate portal-token login threw: ${e}.`);
      }

      // Fallback: re-dispatch invitation for browser candidate and extract token from href.
      if (!candidateAccessToken) {
        log(
          'Anam Setup',
          'portal-tokens unavailable — falling back to invitation-href login for browser candidate.'
        );
        try {
          const invHref = project.invitationHref || project.invitationBody || '';
          let session = invHref ? candidateSessionFromInviteHref(invHref, projectId) : null;

          // If the stored href didn't contain a token, dispatch a fresh invitation.
          if (!session || !session.token) {
            const emailTemplateId = getDefaultEmailTemplate(clientToken, project.emailTemplateId);
            const freshInvRes = sendInvitationsToProjectCandidates(
              clientToken,
              projectId,
              emailTemplateId,
              [browserCandidateId],
              [browserCandidateEmail]
            );
            const freshHref = extractInvitationHref(freshInvRes, browserCandidateId, browserCandidateEmail);
            session = freshHref ? candidateSessionFromInviteHref(freshHref, projectId) : null;
          }

          if (session && session.token) {
            candidateAccessToken = session.token;
            candidateRefreshToken = session.refreshToken || null;
            candidateOrgId = session.organizationId || null;
            candidateParentOrgId = session.parentOrganizationId || null;
            log('Anam Setup', 'Browser candidate session obtained from invitation href.');
          } else {
            log('Anam Setup', 'WARNING: invitation href fallback also failed to produce a token. Phase 3 browser validation will not be able to authenticate.');
          }
        } catch (e) {
          log('Anam Setup', `Invitation href fallback failed: ${e}`);
        }
      }
    }

    log('Anam Setup', '');
    log('Anam Setup', '========================================');
    log('Anam Setup', `SETUP COMPLETE — ANAM_MODE=${ANAM_MODE}`);
    log('Anam Setup', `   NOANUMTEST_PROJECT_ID=${projectId}`);
    log('Anam Setup', `   NOANUMTEST_ORG_ID=${orgId}`);
    log('Anam Setup', `   NOANUMTEST_ADMIN_USER_ID=${adminUserId}`);
    log('Anam Setup', `   NOANUMTEST_CANDIDATE_ID=${browserCandidateId || 'FETCH_FAILED'}`);
    log('Anam Setup', `   NOANUMTEST_CANDIDATE_EMAIL=${browserCandidateEmail || 'FETCH_FAILED'}`);
    log('Anam Setup', `   NOANUMTEST_AUDIT_CANDIDATE_IDS=${auditCandidateIds.join(',')}`);

    // Emit the browser candidate's direct invitation href so Phase 3 can
    // navigate the SPA without needing a mock portal-tokens intercept.
    const browserCandidateHref =
      (project.allInvitationHrefs && (
        (browserCandidateId && project.allInvitationHrefs[String(browserCandidateId)]) ||
        (browserCandidateEmail && project.allInvitationHrefs[String(browserCandidateEmail).toLowerCase()])
      )) ||
      project.invitationHref ||
      '';
    log('Anam Setup', `   NOANUMTEST_CANDIDATE_INVITATION_HREF=${browserCandidateHref || 'FETCH_FAILED'}`);

    // Emit per-candidate invitation hrefs for audit phase (base64-encoded JSON to survive log parsing).
    // Format: { "<candidateId>": "<href>", "<email>": "<href>", ... }
    // Format: { "<candidateId>": "<href>", "<email>": "<href>", ... }
    const auditHrefsMap = project.allInvitationHrefs || {};
    const auditHrefsJson = JSON.stringify(auditHrefsMap);
    const auditHrefsB64 = b64encode(auditHrefsJson);
    log('Anam Setup', `   NOANUMTEST_AUDIT_INVITATION_HREFS=${auditHrefsB64}`);
    log('Anam Setup', '');
    const emitSessionSecrets = String(__ENV.E2E_EMIT_SESSION_SECRETS || 'false').toLowerCase() === 'true';
    log(
      'Anam Setup',
      `   CANDIDATE_ACCESS_TOKEN=${emitSessionSecrets ? (candidateAccessToken || 'FETCH_FAILED') : '<redacted>'}`
    );
    log(
      'Anam Setup',
      `   CANDIDATE_REFRESH_TOKEN=${emitSessionSecrets ? (candidateRefreshToken || 'FETCH_FAILED') : '<redacted>'}`
    );
    log('Anam Setup', `   CANDIDATE_ORG_ID=${candidateOrgId || 'FETCH_FAILED'}`);
    log('Anam Setup', `   CANDIDATE_PARENT_ORG_ID=${candidateParentOrgId || 'FETCH_FAILED'}`);
    log('Anam Setup', '');
    log('Anam Setup', 'Browser candidate is reserved for Playwright; audit candidates are isolated.');
    log('Anam Setup', '========================================');
  } catch (err) {
    log('Anam Setup', `Unexpected error: ${err.message || err}`);
    sleep(5);
    exec.test.abort(`setup failed: ${err.message || err}`);
  }
}

export function handleSummary(data) {
  const name = reportName('report-anam-validation-setup', {
    SCENARIO: `anam-${ANAM_MODE}`,
    LOAD_MODE: 'smoke',
    ANUM_API_ENABLED
  });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
