// scripts/failure-utils.js
//
// Parses the structured [FAILED_REQUEST] {json} lines that utils/http.js emits
// (k6's console.log goes to stderr) and persists them to
// reports/failures-latest.json so the professional HTML report can render a
// per-request failure table (status code + message) that k6's aggregated
// summary JSON never contains.

const fs = require('fs');
const path = require('path');
const { parseFailedRequestLines } = require('../utils/failed-request-line');

const reportsDir = path.resolve(__dirname, '..', 'reports');
const LATEST_FAILURES = path.join(reportsDir, 'failures-latest.json');

// Extract every [FAILED_REQUEST] {...} payload from a chunk of k6 output.
//
// Handled line by line through utils/failed-request-line.js: k6 v1/v2 wraps
// console output as `time=... level=info msg="[FAILED_REQUEST] {\"...\"}"`,
// where the payload is logfmt-escaped. A bare regex over the whole blob only
// matches unwrapped output and would silently capture zero failures on modern
// k6, leaving the report's failure table empty.
function parseFailures(output) {
  if (!output) return [];
  return parseFailedRequestLines(String(output).split(/\r?\n/));
}

// Persist parsed failures for the report generator. Always writes the file
// (even an empty array) so a clean run clears any stale failures from the
// previous run.
function writeFailures(failures) {
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    totalFailures: failures.length,
    failures
  };
  fs.writeFileSync(LATEST_FAILURES, JSON.stringify(payload, null, 2), 'utf-8');
  return LATEST_FAILURES;
}

module.exports = { parseFailures, writeFailures, LATEST_FAILURES, reportsDir };
