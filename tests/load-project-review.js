// tests/load-project-review.js
//
// Focused review load against pre-provisioned review data. Multiple concurrent
// reviewers can update the same review target, so shared-target concurrency is
// blocked by default. Set ALLOW_SHARED_REVIEW_TARGETS=true only when contention
// is the behavior you intentionally want to test.

import { sleep } from 'k6';
import exec from 'k6/execution';
import { htmlReport } from '../utils/local-report.js';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

import { buildThresholds } from '../config/thresholds.js';
import {
  LOAD_MODE,
  SCENARIO,
  ANUM_API_ENABLED,
  ALLOW_SHARED_REVIEW_TARGETS
} from '../config/environments.js';
import { reportName, log } from '../utils/helpers.js';
import { projectReviewLogin, runProjectReviewFlow } from '../scenarios/projectreview.js';

const LOAD_VUS = Math.max(1, Number(__ENV.LOAD_VUS || 1));
const ITERATIONS_PER_VU = Math.max(1, Number(__ENV.LOAD_ITERATIONS_PER_VU || 1));

export const options = {
  summaryTrendStats: ['count', 'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  thresholds: buildThresholds(),
  scenarios:
    LOAD_MODE === 'load'
      ? {
          project_review_load: {
            executor: 'per-vu-iterations',
            vus: LOAD_VUS,
            iterations: ITERATIONS_PER_VU,
            maxDuration: __ENV.LOAD_MAX_DURATION || '20m',
            gracefulStop: '30s'
          }
        }
      : {
          project_review_smoke: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '10m',
            gracefulStop: '30s'
          }
        }
};

export function setup() {
  if (LOAD_MODE === 'load' && LOAD_VUS > 1 && !ALLOW_SHARED_REVIEW_TARGETS) {
    exec.test.abort(
      'Project review load is configured with multiple VUs against shared review targets. ' +
      'Use LOAD_VUS=1 or set ALLOW_SHARED_REVIEW_TARGETS=true for an intentional contention test.'
    );
  }
}

export default function () {
  log('Project Review', `Starting review iteration: VU=${__VU}, scenario=${SCENARIO}, Anam=${ANUM_API_ENABLED}`);
  const token = projectReviewLogin();
  if (!token) throw new Error('Project review login failed');
  runProjectReviewFlow(token);
  sleep(1);
}

export function handleSummary(data) {
  const name = reportName('project-review-report', { SCENARIO, LOAD_MODE, ANUM_API_ENABLED });
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    [`reports/${name}.html`]: htmlReport(data),
    [`reports/${name}.json`]: JSON.stringify(data, null, 2)
  };
}
