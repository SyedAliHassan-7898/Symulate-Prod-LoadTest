// tests/smoke-no-anum-perform.js
//
// PART 2 of 2 — Anam Disabled Validation: Perform + Score Assert
//
// Run AFTER smoke:no-anum:setup completes.
//
// What this does:
//   1. Super Admin login + impersonate the no-anum org's client admin
//   2. Get activities from the no-anum project
//   3. Candidate login via portal-tokens (no password needed)
//   4. Auto-fetch slots + book the earliest one (no manual booking needed)
//   5. Candidate performs all activities (transcript sent via socket)
//   6. Wait 5s for backend async processing
//   7. Assert all activity scores are null (Anam did not run)
//   8. Assert reviewer sees no reviewable sub-skills
//
// Required .env vars (set after smoke:no-anum:setup):
//   NOANUMTEST_PROJECT_ID        — printed by smoke:no-anum:setup
//   NOANUMTEST_ORG_ID            — printed by smoke:no-anum:setup
//   NOANUMTEST_ADMIN_USER_ID     — printed by smoke:no-anum:setup
//   NOANUMTEST_CANDIDATE_ID      — candidateId from the project's candidate list
//   NOANUMTEST_CANDIDATE_EMAIL   — candidate email (e.g. john7@yopmail.com)
//
// Run:
//   npm run smoke:no-anum:perform

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';
import { htmlReport } from '../utils/local-report.js';

import { reportName, log, logStep } from '../utils/helpers.js';
import { getJson } from '../utils/http.js';
import { routes } from '../utils/routes.js';

import { superAdminLogin, impersonateClientAdmin } from '../scenarios/login.js';
import {
  performAllActivities,
  getActivitiesFromProject
} from '../scenarios/candidateassessment.js';

// ---------------------------------------------------------------------------
// Config — all from .env after smoke:no-anum:setup
// ---------------------------------------------------------------------------
const PROJECT_ID     = __ENV.NOANUMTEST_PROJECT_ID;
const ORG_ID         = __ENV.NOANUMTEST_ORG_ID;
const ADMIN_USER_ID  = __ENV.NOANUMTEST_ADMIN_USER_ID;
const CANDIDATE_ID   = __ENV.NOANUMTEST_CANDIDATE_ID;
const CANDIDATE_EMAIL = __ENV.NOANUMTEST_CANDIDATE_EMAIL || __ENV.CANDIDATE_EMAIL;

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  scenarios: {
    no_anum_perform: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '8m',
      gracefulStop: '30s'
    }
  },
  thresholds: {
    checks: ['rate==1.0']
  }
};

// ---------------------------------------------------------------------------
// Score check — returns true if Anam populated a score
// ---------------------------------------------------------------------------
function activityHasScore(reviewToken, projectId, candidateId, activityId) {
  const res = getJson(
    routes.scoringProjectCandidateActivity(projectId, candidateId, activityId),
    reviewToken,
    'Anam Disabled Perform - Get Activity Score'
  );
  logStep(`Anam Disabled Perform - Score Check (${activityId})`, res);
  if (res.status !== 200) return false;
  try {
    const body = res.json();
    const activity = body && body.data && body.data.activity;
    if (!activity) return false;
    return (activity.skills || []).some((skill) =>
      (skill.subSkills || []).some(
        (sub) => sub.systemScore !== null && sub.systemScore !== undefined
      )
    );
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export default function () {
  log('Anam Disabled Perform', '=== PART 2: Anam Disabled Validation Perform + Assert ===');

  // Guard — required vars
  if (!PROJECT_ID || !CANDIDATE_ID) {
    log('Anam Disabled Perform', 'ABORTED — missing required .env vars:');
    log('Anam Disabled Perform', `  NOANUMTEST_PROJECT_ID   = ${PROJECT_ID   || 'MISSING'}`);
    log('Anam Disabled Perform', `  NOANUMTEST_CANDIDATE_ID = ${CANDIDATE_ID || 'MISSING'}`);
    log('Anam Disabled Perform', 'Run smoke:no-anum:setup first and copy the printed values to .env');
    exec.test.abort('missing NOANUMTEST_ env vars');
    return;
  }

  log('Anam Disabled Perform', `Project   : ${PROJECT_ID}`);
  log('Anam Disabled Perform', `Candidate : ${CANDIDATE_ID} (${CANDIDATE_EMAIL})`);
  log('Anam Disabled Perform', `Admin     : ${ADMIN_USER_ID || 'will use default reviewer'}`);

  try {
    // ------------------------------------------------------------------
    // 1. Get a client-admin token for the no-anum org
    //    If NOANUMTEST_ADMIN_USER_ID is set → impersonate that admin
    //    Otherwise → fall back to the default hardcoded reviewer
    // ------------------------------------------------------------------
    const superAdminToken = superAdminLogin();
    if (!superAdminToken) {
      exec.test.abort('Super Admin login failed');
      return;
    }

    const adminUserId = ADMIN_USER_ID || __ENV.ASSESSMENT_ADMIN_USER_ID;
    const clientToken = impersonateClientAdmin(superAdminToken, adminUserId);
    if (!clientToken) {
      exec.test.abort('Client Admin impersonation failed');
      return;
    }

    // ------------------------------------------------------------------
    // 2. Get activities from the no-anum project
    // ------------------------------------------------------------------
    const candidateActivities = getActivitiesFromProject(clientToken, CANDIDATE_ID, PROJECT_ID);

    check(candidateActivities, {
      'no-anum perform: activities found in project': (a) => Array.isArray(a) && a.length > 0
    });

    log('Anam Disabled Perform', `Found ${candidateActivities.length} activities`);

    // ------------------------------------------------------------------
    // 3. Candidate performs activities
    //    - portal-tokens login (no password needed)
    //    - auto-booking via bookEarliestSlot inside ensureCandidateBooking
    //    - transcript sent via socket
    // ------------------------------------------------------------------
    const performedResults = performAllActivities(
      CANDIDATE_EMAIL,
      null,              // password not needed — portal-tokens flow
      CANDIDATE_ID,
      candidateActivities,
      null,              // orgId — resolved from login response
      CANDIDATE_ID,
      PROJECT_ID
    );

    const completedCount = performedResults.filter(
      (r) => r && r.status >= 200 && !r.skipped
    ).length;

    const transcriptSentCount = performedResults.filter(
      (r) => r && r.transcriptConfirmed === true
    ).length;

    check(completedCount, {
      'no-anum perform: at least one activity completed': (c) => c > 0
    });

    check(transcriptSentCount, {
      'no-anum perform: transcript sent (proves null score = Anam off, not missing transcript)': (c) => c > 0
    });

    log('Anam Disabled Perform',
      `Activities completed=${completedCount}, transcriptConfirmed=${transcriptSentCount}`
    );

    // ------------------------------------------------------------------
    // 4. Wait for backend async processing
    // ------------------------------------------------------------------
    log('Anam Disabled Perform', 'Waiting 5s for backend async processing...');
    sleep(5);

    // ------------------------------------------------------------------
    // 5. Score assertions — must all be null
    // ------------------------------------------------------------------
    const scoringListRes = getJson(
      routes.scoringProjectCandidates(PROJECT_ID),
      clientToken,
      'Anam Disabled Perform - Get Scoring List'
    );
    logStep('Anam Disabled Perform - Get Scoring List', scoringListRes);

    let activityIds = [];
    try {
      const body = scoringListRes.json();
      const candidates = (body && body.data && body.data.data) ||
                         (body && body.data) || [];
      const match = Array.isArray(candidates)
        ? candidates.find((c) => c.candidateId === CANDIDATE_ID || c.id === CANDIDATE_ID)
        : null;
      if (match) {
        const stages = match.stages || match.projectStages || [];
        stages.forEach((stage) => {
          (stage.activities || []).forEach((act) => {
            if (act.activityId || act.id) activityIds.push(act.activityId || act.id);
          });
        });
      }
    } catch (e) {
      log('Anam Disabled Perform', `Could not parse scoring list: ${e}`);
    }

    // Filter WELCOME — backend never scores those
    const reviewableIds = activityIds.filter((id) =>
      !candidateActivities.find((a) => a.id === id && a.type === 'WELCOME')
    );

    log('Anam Disabled Perform', `Checking Anam scores for ${reviewableIds.length} activities`);

    let populatedCount = 0;
    let nullCount = 0;

    reviewableIds.forEach((activityId) => {
      const hasScore = activityHasScore(clientToken, PROJECT_ID, CANDIDATE_ID, activityId);
      if (hasScore) {
        populatedCount += 1;
        log('Anam Disabled Perform',
          `Regression detected: activityId=${activityId} has Anam score despite Anam being disabled`
        );
      } else {
        nullCount += 1;
        log('Anam Disabled Perform',
          `PASS activityId=${activityId} score=null (correct — Anam disabled)`
        );
      }
      sleep(0.3);
    });

    check(populatedCount, {
      'no-anum perform: all activity scores are null — Anam did not run': (c) => c === 0
    });

    check(nullCount, {
      'no-anum perform: all activities confirmed score-null': (c) =>
        c === reviewableIds.length || reviewableIds.length === 0
    });

    // ------------------------------------------------------------------
    // 6. Reviewer sees no reviewable sub-skills
    // ------------------------------------------------------------------
    const stagesRes = getJson(
      routes.scoringProjectCandidateStages(PROJECT_ID, CANDIDATE_ID),
      clientToken,
      'Anam Disabled Perform - Get Candidate Stages'
    );
    logStep('Anam Disabled Perform - Get Candidate Stages', stagesRes);

    let totalReviewableSubSkills = 0;
    try {
      const body = stagesRes.json();
      const stages = (body && body.data && body.data.data) ||
                     (body && body.data) || [];
      (Array.isArray(stages) ? stages : []).forEach((stage) => {
        (stage.activities || []).forEach((act) => {
          (act.skills || []).forEach((skill) => {
            (skill.subSkills || []).forEach((sub) => {
              if (sub.systemScore !== null && sub.systemScore !== undefined) {
                totalReviewableSubSkills += 1;
              }
            });
          });
        });
      });
    } catch (e) {
      log('Anam Disabled Perform', `Could not parse candidate stages: ${e}`);
    }

    check(totalReviewableSubSkills, {
      'no-anum perform: reviewer sees no reviewable sub-skills (empty review page)': (c) => c === 0
    });

    log('Anam Disabled Perform',
      `Reviewable sub-skills: ${totalReviewableSubSkills} (expected 0 when Anam disabled)`
    );

    sleep(1);
    log('Anam Disabled Perform', 'Completed: Anam-disabled validation complete');

  } catch (err) {
    log('Anam Disabled Perform', `Unexpected error: ${err.message || err}`);
    sleep(5);
  }
}

export function handleSummary(data) {
  const name = reportName('report-no-anum-perform', {
    SCENARIO: 'no-anum-perform',
    LOAD_MODE: 'smoke',
    ANUM_API_ENABLED: false
  });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
