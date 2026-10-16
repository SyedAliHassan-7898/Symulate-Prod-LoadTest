/**
 * Parses `[FAILED_REQUEST] {...}` telemetry lines out of k6 stdout.
 *
 * k6 v1/v2 wraps console output in logfmt, so the line actually looks like:
 *   time=2026-10-15T09:00:00.000Z level=info msg="[FAILED_REQUEST] {\"name\":...}"
 * Older builds (or plain output) emit the bare line. Support both.
 */

const FAILED_REQUEST_PREFIX = '[FAILED_REQUEST]';

/** Undo logfmt string escaping (k6 escapes msg values like JSON strings). */
function unescapeLogfmtMsg(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

/**
 * @param {string} line single stdout/stderr line from k6
 * @returns {object|null} parsed FAILED_REQUEST payload, or null if not one
 */
function extractFailedRequest(line) {
  if (typeof line !== 'string' || !line.includes(FAILED_REQUEST_PREFIX)) return null;
  const trimmed = line.trim();
  let payload = null;

  if (trimmed.startsWith(FAILED_REQUEST_PREFIX)) {
    // Bare line: `[FAILED_REQUEST] {...}`
    payload = trimmed.slice(FAILED_REQUEST_PREFIX.length).trim();
  } else {
    // Wrapped line: ... msg="[FAILED_REQUEST] {...}"
    const marker = 'msg="';
    const start = trimmed.indexOf(marker);
    const end = trimmed.lastIndexOf('"');
    if (start !== -1 && end > start + marker.length) {
      payload = unescapeLogfmtMsg(trimmed.slice(start + marker.length, end));
      if (payload.startsWith(FAILED_REQUEST_PREFIX)) {
        payload = payload.slice(FAILED_REQUEST_PREFIX.length).trim();
      }
    }
  }

  if (!payload || !payload.startsWith('{')) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** @param {string[]} lines @returns {object[]} parsed FAILED_REQUEST payloads */
function parseFailedRequestLines(lines) {
  return (Array.isArray(lines) ? lines : []).map(extractFailedRequest).filter(Boolean);
}

// CommonJS on purpose: scripts/run.js and scripts/run-shared-project-load.js
// are CJS, and require(esm) only exists on newer Node. The k6 test scripts do
// not need this module (they *emit* the lines, they never parse them).
module.exports = {
  FAILED_REQUEST_PREFIX,
  extractFailedRequest,
  parseFailedRequestLines
};
