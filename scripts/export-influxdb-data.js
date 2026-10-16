#!/usr/bin/env node
/**
 * InfluxDB Data Exporter for Grafana Metrics
 * 
 * Extracts time-series data from InfluxDB and exports to CSV format.
 * Captures actual URLs, response times, and all HTTP metrics that Grafana visualizes.
 * 
 * Requirements:
 * - InfluxDB container must be running (npm run monitoring:up)
 * - k6 test must have been run with --out influxdb flag
 * 
 * Usage:
 *   node scripts/export-influxdb-data.js
 *   node scripts/export-influxdb-data.js --database k6 --output grafana-export.csv
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');

// Parse command line arguments
const args = process.argv.slice(2);
const database = args.includes('--database') ? args[args.indexOf('--database') + 1] : 'k6';
const customOutput = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;

if (!fs.existsSync(REPORTS_DIR)) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
}

// ── Run-window scoping ──────────────────────────────────────────────────────
// InfluxDB accumulates points from EVERY run forever, so unscoped aggregates
// (count/mean/min/max) and the first()/last() test window would span all
// history. The orchestrator stamps the current run's start time in
// INFLUX_SINCE_MS; we scope every data query to that window so the JMeter
// report reflects only the run that just executed. If the env var is absent,
// we fall back to no scoping (standalone usage keeps old behaviour).
const SINCE_MS = Number(process.env.INFLUX_SINCE_MS) || 0;
const TIME_FILTER = SINCE_MS > 0 ? `time >= ${BigInt(SINCE_MS) * 1000000n}` : '';

// Inject the run-window time bound into a SELECT. InfluxQL wants WHERE before
// GROUP BY / ORDER BY / LIMIT, and existing WHERE clauses get AND-ed.
function scoped(query) {
  if (!TIME_FILTER) return query;
  if (/\bWHERE\b/i.test(query)) {
    return query.replace(/\bWHERE\b/i, `WHERE ${TIME_FILTER} AND`);
  }
  const m = query.match(/\b(GROUP BY|ORDER BY|LIMIT)\b/i);
  if (m) {
    const idx = query.indexOf(m[0]);
    return `${query.slice(0, idx)}WHERE ${TIME_FILTER} ${query.slice(idx)}`;
  }
  return `${query} WHERE ${TIME_FILTER}`;
}

/**
 * Check if InfluxDB container is running
 */
function checkInfluxDB() {
  console.log('🔍 Checking InfluxDB availability...\n');
  
  const check = spawnSync('docker', ['ps', '--filter', 'name=k6-influxdb', '--format', '{{.Names}}'], {
    encoding: 'utf-8',
    shell: false
  });
  
  if (check.error || !check.stdout.includes('k6-influxdb')) {
    console.error('❌ InfluxDB container is not running.');
    console.error('   Start monitoring stack first: npm run monitoring:up\n');
    process.exit(1);
  }
  
  console.log('✅ InfluxDB container is running\n');
}

/**
 * Execute InfluxDB query and return results
 */
function executeInfluxQuery(query) {
  // Pipe the query via stdin instead of `-execute`. On Windows, passing a
  // multi-line / quoted query as a CLI arg through spawnSync gets mangled
  // (newlines truncate the arg → influx reports "empty input"). Stdin is safe.
  const result = spawnSync('docker', [
    'exec',
    '-i',
    'k6-influxdb',
    'influx',
    '-database', database,
    '-format', 'csv'
  ], {
    input: query,
    encoding: 'utf-8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large datasets
  });

  if (result.error) {
    throw new Error(`Failed to execute InfluxDB query: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`InfluxDB query failed: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Check if database has data
 */
function checkDatabaseHasData() {
  try {
    const measurements = executeInfluxQuery('SHOW MEASUREMENTS');
    
    if (!measurements || measurements.trim() === '' || measurements.includes('ERR:')) {
      console.error('❌ No data found in InfluxDB database:', database);
      console.error('   Run a test with Grafana output first:');
      console.error('   npm run load:shared:grafana\n');
      process.exit(1);
    }
    
    console.log('✅ Database has metrics data\n');
    return true;
  } catch (err) {
    console.error('❌ Failed to check database:', err.message);
    process.exit(1);
  }
}

/**
 * Export HTTP request duration metrics with URLs
 */
function exportHttpRequestDuration() {
  console.log('📊 Exporting HTTP request durations with URLs...');
  
  const query = 'SELECT time, "value", "url", "name", "method", "status", "expected_response" FROM http_req_duration ORDER BY time ASC';
  
  try {
    const data = executeInfluxQuery(scoped(query));
    const outputFile = customOutput || path.join(REPORTS_DIR, `grafana-http-requests-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    // Parse and clean CSV data
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('⚠️  No HTTP request data found in InfluxDB\n');
      return null;
    }
    
    // Write cleaned data
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`✅ Exported ${lines.length - 1} HTTP requests`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export HTTP requests:', err.message, '\n');
    return null;
  }
}

/**
 * Export all key metrics summary
 */
function exportMetricsSummary() {
  console.log('📊 Exporting metrics summary...');
  
  const metrics = [
    'http_reqs',
    'http_req_failed', 
    'http_req_duration',
    'http_req_blocked',
    'http_req_connecting',
    'http_req_sending',
    'http_req_waiting',
    'http_req_receiving',
    'data_received',
    'data_sent',
    'vus',
    'vus_max',
    'iterations',
    'checks'
  ];
  
  const summaryFile = path.join(REPORTS_DIR, `grafana-metrics-summary-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  const summaryData = ['Metric,Count,Mean,Min,Max,Sum'];
  
  for (const metric of metrics) {
    try {
      const query = `
        SELECT COUNT(value) as count, MEAN(value) as mean, MIN(value) as min, MAX(value) as max, SUM(value) as sum
        FROM ${metric}
      `;
      
      const result = executeInfluxQuery(query);
      const lines = result.split('\n').filter(line => line.trim() && !line.startsWith('name,'));
      
      if (lines.length > 0) {
        const values = lines[0].split(',');
        if (values.length >= 6) {
          summaryData.push(`${metric},${values[2]},${values[3]},${values[4]},${values[5]},${values[6]}`);
        }
      }
    } catch (err) {
      // Metric might not exist, skip
      continue;
    }
  }
  
  if (summaryData.length > 1) {
    fs.writeFileSync(summaryFile, summaryData.join('\n') + '\n', 'utf-8');
    console.log(`✅ Exported ${summaryData.length - 1} metrics`);
    console.log(`📄 File: ${path.basename(summaryFile)}\n`);
    return summaryFile;
  }
  
  return null;
}

/**
 * Export VUs over time (for load pattern visualization)
 */
function exportVUsTimeSeries() {
  console.log('📊 Exporting VUs time series...');
  
  const query = `
    SELECT time, value
    FROM vus
    ORDER BY time ASC
  `;
  
  try {
    const data = executeInfluxQuery(scoped(query));
    const outputFile = path.join(REPORTS_DIR, `grafana-vus-timeseries-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('⚠️  No VUs data found\n');
      return null;
    }
    
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`✅ Exported ${lines.length - 1} VU data points`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export VUs:', err.message, '\n');
    return null;
  }
}

/**
 * Export error rate over time
 */
function exportErrorRate() {
  console.log('📊 Exporting error rate time series...');
  
  const query = 'SELECT time, "value", "url", "name", "status" FROM http_req_failed WHERE "value" = 1 ORDER BY time ASC';
  
  try {
    const data = executeInfluxQuery(scoped(query));
    const outputFile = path.join(REPORTS_DIR, `grafana-errors-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
    
    const lines = data.split('\n').filter(line => line.trim());
    if (lines.length <= 1) {
      console.log('✅ No errors found (100% success rate)\n');
      return null;
    }
    
    fs.writeFileSync(outputFile, data, 'utf-8');
    console.log(`⚠️  Exported ${lines.length - 1} failed requests`);
    console.log(`📄 File: ${path.basename(outputFile)}\n`);
    
    return outputFile;
  } catch (err) {
    console.error('⚠️  Failed to export errors:', err.message, '\n');
    return null;
  }
}

/**
 * ── InfluxDB CSV parsing helpers ─────────────────────────────────────────────
 * `influx -format csv` returns grouped results shaped like (one header per series):
 *
 *   name,tags,time,samples,avg
 *   http_req_duration,name=Login - Client Admin,0,10,123.4
 *   name,tags,time,samples,avg
 *   http_req_duration,name=Get Assigned Activities,0,8,200.1
 *
 * The first column `name` is the measurement name; the `tags` column holds
 * `key=value,key=value` (comma-separated, quoted when values contain commas).
 * For ungrouped queries (no GROUP BY) there is no `tags` column:
 *
 *   name,time,value
 *   http_reqs,1791445565002253400,1
 *
 * We parse that into { tags, values } records so we can aggregate per `name`
 * tag (and read the full `url` tag) for a JMeter-style report.
 */

// Split a CSV row, honouring double-quoted fields (tag strings / URLs may contain commas).
function splitCsvRow(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Parse an influx `tags` cell `k=v,k=v` into an object (handles \, and \\ escapes).
function parseTagPairs(tagStr) {
  const pairs = [];
  let cur = '';
  let escaped = false;
  let inQuotes = false;
  for (let i = 0; i < tagStr.length; i++) {
    const c = tagStr[i];
    if (escaped) { cur += c; escaped = false; continue; }
    if (c === '\\') { cur += c; escaped = true; continue; }
    if (c === '"') { inQuotes = !inQuotes; cur += c; continue; }
    if (c === ',' && !inQuotes) { pairs.push(cur); cur = ''; continue; }
    cur += c;
  }
  pairs.push(cur);

  const tags = {};
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    let val = pair.slice(idx + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    val = val.replace(/\\(.)/g, '$1');
    tags[key] = val;
  }
  return tags;
}

// Parse influx CSV (grouped or ungrouped) into [{ tags, values }].
// A header row is any row whose FIRST cell === 'name' (the measurement column).
// Data rows follow the most recent header; `tags` column (if present) is parsed.
function querySeries(query) {
  const csv = executeInfluxQuery(scoped(query));
  const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const groups = [];
  let columns = null;

  for (const line of lines) {
    const cells = splitCsvRow(line);
    if (cells[0] === 'name') {
      // Header row for the next series (repeated per series in grouped output).
      columns = cells;
      continue;
    }
    if (!columns) continue;
    const values = {};
    columns.forEach((col, i) => {
      if (values[col] === undefined) values[col] = cells[i]; // first wins (dup 'name' col)
    });
    const tags = values.tags ? parseTagPairs(values.tags) : {};
    groups.push({ tags, values });
  }

  return groups;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round(value, digits = 2) {
  return num(Number(value).toFixed(digits));
}

// Derive the test window (seconds) from first/last http_reqs timestamps.
// Influx returns `time` as a nanosecond-epoch string (e.g. 1791445565002253400).
function queryTestDurationSeconds() {
  try {
    const first = querySeries('SELECT first("value") FROM http_reqs');
    const last = querySeries('SELECT last("value") FROM http_reqs');
    const t0 = Number(first[0] && first[0].values.time) / 1e9;
    const t1 = Number(last[0] && last[0].values.time) / 1e9;
    if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) return t1 - t0;
  } catch (err) { /* fall through */ }
  return 0;
}

/**
 * Build JMeter-style reports directly from InfluxDB:
 *   1) *-jmeter-summary.csv — Label, # Samples, Average, Min, Max, Std. Dev.,
 *      Error %, Throughput, Received KB/sec, Sent KB/sec, Avg. Bytes (+ TOTAL)
 *   2) *-url-details.csv    — full URL breakdown per label (method/status/URL)
 *
 * Unlike the k6 JSON summary (which does NOT emit http_req_duration{name:...}
 * sub-metrics unless a threshold forces them), InfluxDB stores every request
 * tagged with both `name` and the full `url`, so we get real per-endpoint rows.
 */
function exportJMeterReports() {
  console.log('📊 Building JMeter-style per-endpoint report from InfluxDB...\n');

  const durationSec = queryTestDurationSeconds();

  // Per-label aggregates (group by name only — matches the JMeter summary view).
  const durations = querySeries(
    'SELECT count("value") as "samples", mean("value") as "avg", min("value") as "min", ' +
    'max("value") as "max", stddev("value") as "stddev", percentile("value",90) as "p90", ' +
    'percentile("value",95) as "p95", percentile("value",99) as "p99" ' +
    'FROM http_req_duration GROUP BY "name"'
  );
  if (!durations.length) {
    console.log('⚠️  No http_req_duration data in InfluxDB — run a test with --out influxdb first.\n');
    return [];
  }

  const fails = querySeries('SELECT sum("value") as "fails", count("value") as "total" FROM http_req_failed GROUP BY "name"');
  // Use the suite's custom recv_bytes/sent_bytes counters (tagged with `name`);
  // the built-in data_received/data_sent have no `name` tag, so they can't be
  // joined per-endpoint.
  const recv = querySeries('SELECT sum("value") as "bytes" FROM recv_bytes GROUP BY "name"');
  const sent = querySeries('SELECT sum("value") as "bytes" FROM sent_bytes GROUP BY "name"');

  // Overall (TOTAL row) — ungrouped query over the same window.
  const totalDur = querySeries(
    'SELECT count("value") as "samples", mean("value") as "avg", min("value") as "min", ' +
    'max("value") as "max", stddev("value") as "stddev" FROM http_req_duration'
  )[0];
  const totalFail = querySeries('SELECT sum("value") as "fails", count("value") as "total" FROM http_req_failed')[0];
  const totalRecv = querySeries('SELECT sum("value") as "bytes" FROM recv_bytes')[0];
  const totalSent = querySeries('SELECT sum("value") as "bytes" FROM sent_bytes')[0];

  const byName = (arr) => {
    const map = {};
    for (const item of arr) {
      const key = item.tags.name || 'UNNAMED';
      map[key] = item.values;
    }
    return map;
  };
  const failMap = byName(fails);
  const recvMap = byName(recv);
  const sentMap = byName(sent);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const summaryFile = path.join(REPORTS_DIR, `jmeter-endpoint-summary-${ts}.csv`);

  const header = ['Label', '# Samples', 'Average', 'Min', 'Max', 'Std. Dev.', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec', 'Avg. Bytes'];
  const rows = [header];

  const effDur = durationSec > 0 ? durationSec : 1;

  for (const item of durations) {
    const label = item.tags.name || 'UNNAMED';
    const v = item.values;
    const samples = num(v.samples);
    const failInfo = failMap[label] || {};
    const failsN = num(failInfo.fails);
    const totalReq = num(failInfo.total) || samples;
    const errorPct = totalReq > 0 ? (failsN / totalReq) * 100 : 0;
    const recvBytes = num((recvMap[label] || {}).bytes);
    const sentBytes = num((sentMap[label] || {}).bytes);

    rows.push([
      label,
      samples,
      round(v.avg),
      round(v.min),
      round(v.max),
      round(v.stddev),
      round(errorPct),
      round(samples / effDur, 5),
      round((recvBytes / 1024) / effDur),
      round((sentBytes / 1024) / effDur),
      samples > 0 ? round(recvBytes / samples, 1) : 0
    ]);
  }

  // TOTAL row (accurate, from ungrouped aggregates).
  const tSamples = num(totalDur && totalDur.values.samples);
  const tFailN = num(totalFail && totalFail.values.fails);
  const tTotalReq = num(totalFail && totalFail.values.total) || tSamples;
  const tError = tTotalReq > 0 ? (tFailN / tTotalReq) * 100 : 0;
  const tRecv = num(totalRecv && totalRecv.values.bytes);
  const tSent = num(totalSent && totalSent.values.bytes);
  rows.push([
    'TOTAL',
    tSamples,
    round(totalDur && totalDur.values.avg),
    round(totalDur && totalDur.values.min),
    round(totalDur && totalDur.values.max),
    round(totalDur && totalDur.values.stddev),
    round(tError),
    round(tSamples / effDur, 5),
    round((tRecv / 1024) / effDur),
    round((tSent / 1024) / effDur),
    tSamples > 0 ? round(tRecv / tSamples, 1) : 0
  ]);

  fs.writeFileSync(summaryFile, rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n', 'utf-8');
  console.log(`✅ JMeter summary: ${path.basename(summaryFile)}  (${rows.length - 2} labels + TOTAL)`);
  console.log(`   Test window: ${round(durationSec)}s${durationSec ? '' : ' (duration fallback = 1s)'}\n`);

  // ── URL details (full URLs) ────────────────────────────────────────────────
  const urlFile = path.join(REPORTS_DIR, `url-details-${ts}.csv`);
  const urlDur = querySeries(
    'SELECT count("value") as "samples", mean("value") as "avg", min("value") as "min", ' +
    'max("value") as "max", percentile("value",90) as "p90", percentile("value",95) as "p95", ' +
    'percentile("value",99) as "p99" FROM http_req_duration GROUP BY "name","url","method","status"'
  );
  const urlFail = querySeries(
    'SELECT sum("value") as "fails", count("value") as "total" FROM http_req_failed GROUP BY "name","url","method","status"'
  );
  const failByKey = {};
  for (const f of urlFail) {
    failByKey[`${f.tags.name}|${f.tags.url}|${f.tags.method}|${f.tags.status}`] = f.values;
  }

  const urlHeader = ['Label', 'Method', 'Status', 'URL', '# Samples', 'Avg (ms)', 'Min (ms)', 'Max (ms)', 'P90 (ms)', 'P95 (ms)', 'P99 (ms)', 'Error %'];
  const urlRows = [urlHeader];
  for (const item of urlDur) {
    const key = `${item.tags.name}|${item.tags.url}|${item.tags.method}|${item.tags.status}`;
    const f = failByKey[key] || {};
    const totalReq = num(f.total) || num(item.values.samples);
    const errorPct = totalReq > 0 ? (num(f.fails) / totalReq) * 100 : 0;
    urlRows.push([
      item.tags.name || 'UNNAMED',
      item.tags.method || '',
      item.tags.status || '',
      item.tags.url || '',
      num(item.values.samples),
      round(item.values.avg),
      round(item.values.min),
      round(item.values.max),
      round(item.values.p90),
      round(item.values.p95),
      round(item.values.p99),
      round(errorPct)
    ]);
  }
  fs.writeFileSync(urlFile, urlRows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n', 'utf-8');
  console.log(`✅ URL details (full URLs): ${path.basename(urlFile)}  (${urlRows.length - 1} rows)\n`);

  return [summaryFile, urlFile];
}

// Quote a CSV cell when needed (URLs often contain commas / quotes).
function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Main execution
 */
function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║       InfluxDB Data Exporter - Grafana Metrics            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  checkInfluxDB();
  checkDatabaseHasData();
  
  const exportedFiles = [];
  
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('Starting data export...\n');
  
  // Export all metrics
  const httpFile = exportHttpRequestDuration();
  if (httpFile) exportedFiles.push(httpFile);
  
  const summaryFile = exportMetricsSummary();
  if (summaryFile) exportedFiles.push(summaryFile);
  
  const vusFile = exportVUsTimeSeries();
  if (vusFile) exportedFiles.push(vusFile);
  
  const errorsFile = exportErrorRate();
  if (errorsFile) exportedFiles.push(errorsFile);
  
  // JMeter-style per-endpoint report + full URL breakdown (from name/url tags).
  try {
    const jmeterFiles = exportJMeterReports();
    jmeterFiles.forEach((f) => exportedFiles.push(f));
  } catch (err) {
    console.warn('⚠️  JMeter report generation failed (non-fatal):', err.message, '\n');
  }
  
  // Summary
  console.log('═══════════════════════════════════════════════════════════════\n');
  console.log('✅ Export Complete!\n');
  console.log(`📁 Location: ${REPORTS_DIR}\n`);
  
  if (exportedFiles.length > 0) {
    console.log('📄 Generated files:');
    exportedFiles.forEach(file => {
      console.log(`   - ${path.basename(file)}`);
    });
    console.log('');
  } else {
    console.log('⚠️  No files were generated. Database might be empty.\n');
  }
  
  console.log('💡 Tip: Open CSV files in Excel to analyze Grafana chart data\n');
}

// Run if called directly
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('\n❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { exportHttpRequestDuration, exportMetricsSummary, exportVUsTimeSeries, exportErrorRate, exportJMeterReports };
