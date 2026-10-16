// scripts/failure-utils.js
//
// Parses the structured [FAILED_REQUEST] {json} lines that utils/http.js emits
// (k6's console.log goes to stderr) and persists them to
// reports/failures-latest.json so the professional HTML report can render a
// per-request failure table (status code + message) that k6's aggregated
// summary JSON never contains.

const fs = require('fs');
const path = require('path');

const reportsDir = path.resolve(__dirname, '..', 'reports');
const LATEST_FAILURES = path.join(reportsDir, 'failures-latest.json');

// Extract every [FAILED_REQUEST] {...} payload from a chunk of k6 output.
// The JSON is single-line (JSON.stringify), so a non-greedy brace match is safe.
function parseFailures(output) {
  const failures = [];
  if (!output) return failures;
  const re = /\[FAILED_REQUEST\]\s*(\{[^\n\r]*\})/g;
  let m;
  while ((m = re.exec(output)) !== null) {
    try {
      failures.push(JSON.parse(m[1]));
    } catch (_) {
      // Ignore a malformed/partial line rather than aborting the whole parse.
    }
  }
  return failures;
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
