const fs = require('fs');
const path = require('path');

const reportsDir = path.resolve(__dirname, '..', 'reports');
const envFilePath = path.resolve(__dirname, '..', '.env');

// Minimal .env reader (no dependency). Returns {} when the file is absent.
function readProjectEnv() {
  const env = {};
  if (!fs.existsSync(envFilePath)) return env;
  fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  });
  return env;
}

// Resolve a config value: explicit process env wins, then .env file, then fallback.
function resolveConfig(key, fallback = '') {
  const fromProcess = process.env[key];
  if (fromProcess != null && String(fromProcess).trim() !== '') return fromProcess;
  const fromFile = readProjectEnv()[key];
  if (fromFile != null && String(fromFile).trim() !== '') return fromFile;
  return fallback;
}

function latestJsonReport() {
  // Explicit override: allow the runner to point at a specific JSON report
  // (e.g. Phase 2 of the shared-project load) via SOURCE_REPORT_JSON.
  const explicit = process.env.SOURCE_REPORT_JSON;
  if (explicit) {
    const explicitPath = path.isAbsolute(explicit) ? explicit : path.join(reportsDir, explicit);
    if (fs.existsSync(explicitPath)) {
      return { name: path.basename(explicitPath), fullPath: explicitPath, mtimeMs: fs.statSync(explicitPath).mtimeMs };
    }
  }

  // Pick the newest k6 JSON report. Include every *.json (not just the
  // `report-` prefix) so multi-phase runs surface the latest phase — e.g. the
  // shared-project loader's Phase 2 report is `shared-admin-candidate-load-...`
  // which the old `^report-` filter silently dropped, causing setup/smoke data
  // to be reported instead of the real load run.
  const reports = fs
    .readdirSync(reportsDir)
    .filter((name) => /\.json$/i.test(name))
    .map((name) => {
      const fullPath = path.join(reportsDir, name);
      return { name, fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (!reports.length) {
    throw new Error(`No k6 JSON reports found in ${reportsDir}. Run npm run smoke, npm run load:grafana, or another k6 script first.`);
  }

  return reports[0];
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricValue(metric, key, fallback = 0) {
  return metric && metric.values && Number.isFinite(metric.values[key]) ? metric.values[key] : fallback;
}

function extractLabel(metricName) {
  const match = metricName.match(/^http_req_duration\{name:(.+)\}$/);
  return match ? match[1] : null;
}

function requestRows(data) {
  const metrics = data.metrics || {};
  const durationSeconds = Math.max(metricValue(metrics.iteration_duration, 'avg') / 1000, 1);
  const totalDataReceived = metricValue(metrics.data_received, 'count');
  const totalDataSent = metricValue(metrics.data_sent, 'count') || metricValue(metrics.sent_bytes, 'count');
  const globalRequests = metricValue(metrics.http_reqs, 'count') || 1;
  const globalFailures = metricValue(metrics.http_req_failed, 'rate');

  return Object.entries(metrics)
    .map(([name, metric]) => ({ label: extractLabel(name), metric }))
    .filter((row) => row.label)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, metric }) => {
      const samples = Math.round(metricValue(metric, 'count', globalRequests));
      const share = samples / globalRequests;
      const throughput = samples / durationSeconds;
      const receivedKbSec = (totalDataReceived * share) / 1024 / durationSeconds;
      const sentKbSec = (totalDataSent * share) / 1024 / durationSeconds;
      const avgBytes = samples ? (totalDataReceived * share) / samples : 0;

      return {
        label,
        samples,
        average: round(metricValue(metric, 'avg')),
        median: round(metricValue(metric, 'med')),
        p90: round(metricValue(metric, 'p(90)')),
        p95: round(metricValue(metric, 'p(95)')),
        p99: round(metricValue(metric, 'p(99)')),
        min: round(metricValue(metric, 'min')),
        max: round(metricValue(metric, 'max')),
        stddev: round(metricValue(metric, 'stddev')),
        errorRate: round(globalFailures * 100, 4),
        throughput: round(throughput, 5),
        receivedKbSec: round(receivedKbSec, 2),
        sentKbSec: round(sentKbSec, 2),
        avgBytes: round(avgBytes, 1)
      };
    });
}

function checkRows(data) {
  const rows = [];

  function collectChecks(group, prefix = '') {
    const groupName = group.name && group.name !== '' ? `${prefix}${group.name}` : prefix;
    for (const check of group.checks || []) {
      rows.push({
        group: groupName || 'default',
        check: check.name,
        passes: check.passes || 0,
        fails: check.fails || 0,
        passRate: round(((check.passes || 0) / Math.max((check.passes || 0) + (check.fails || 0), 1)) * 100, 2)
      });
    }
    for (const nested of group.groups || []) {
      collectChecks(nested, groupName ? `${groupName} / ` : '');
    }
  }

  collectChecks(data.root_group || {});
  return rows;
}

function loadLatestReport() {
  const sourceReport = latestJsonReport();
  return {
    sourceReport,
    data: JSON.parse(fs.readFileSync(sourceReport.fullPath, 'utf8'))
  };
}

module.exports = {
  reportsDir,
  loadLatestReport,
  metricValue,
  requestRows,
  checkRows,
  round,
  readProjectEnv,
  resolveConfig
};
