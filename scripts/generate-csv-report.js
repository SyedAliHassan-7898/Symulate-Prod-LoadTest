const fs = require('fs');
const path = require('path');
const { reportsDir, loadLatestReport, metricValue, requestRows, checkRows, round } = require('./report-utils');

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const body = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n');
  fs.writeFileSync(filePath, `${body}\r\n`, 'utf8');
}

// Extract HTTP request details from metrics
function extractHttpRequests(data) {
  const rows = [];
  const metrics = data.metrics || {};
  
  // k6 JSON summary captures `name` tag (endpoint labels) but not full URLs by default
  // Full URLs would require custom tagging in k6 scripts or using --out csv during test
  for (const [metricName, metric] of Object.entries(metrics)) {
    const nameMatch = metricName.match(/^http_req_duration\{name:([^}]+)\}$/);
    
    if (nameMatch) {
      const endpointName = nameMatch[1];
      const samples = Math.round(metricValue(metric, 'count', 0));
      
      // Only add if there were actual requests
      if (samples > 0) {
        rows.push({
          endpoint: endpointName,
          samples: samples,
          avg_ms: round(metricValue(metric, 'avg')),
          median_ms: round(metricValue(metric, 'med')),
          min_ms: round(metricValue(metric, 'min')),
          max_ms: round(metricValue(metric, 'max')),
          p90_ms: round(metricValue(metric, 'p(90)')),
          p95_ms: round(metricValue(metric, 'p(95)')),
          p99_ms: round(metricValue(metric, 'p(99)'))
        });
      }
    }
  }
  
  return rows.sort((a, b) => b.samples - a.samples);
}

// Extract complete metrics summary
function extractMetricsSummary(data) {
  const metrics = data.metrics || {};
  const rows = [];
  
  const metricsToExtract = [
    'http_reqs',
    'http_req_failed',
    'http_req_duration',
    'http_req_blocked',
    'http_req_connecting',
    'http_req_sending',
    'http_req_receiving',
    'http_req_waiting',
    'http_req_tls_handshaking',
    'iterations',
    'iteration_duration',
    'vus',
    'vus_max',
    'data_received',
    'data_sent',
    'checks',
    'ws_sessions',
    'ws_msgs_sent',
    'ws_msgs_received',
    'ws_connecting',
    'ws_session_duration'
  ];
  
  for (const metricName of metricsToExtract) {
    const metric = metrics[metricName];
    if (!metric) continue;
    
    const values = metric.values || {};
    rows.push({
      metric: metricName,
      count: round(values.count || 0),
      rate: round((values.rate || 0) * 100, 4),
      avg: round(values.avg || 0),
      min: round(values.min || 0),
      med: round(values.med || 0),
      max: round(values.max || 0),
      p90: round(values['p(90)'] || 0),
      p95: round(values['p(95)'] || 0),
      p99: round(values['p(99)'] || 0)
    });
  }
  
  return rows;
}

function main() {
  const { sourceReport, data } = loadLatestReport();
  const metrics = data.metrics || {};
  
  // Validate that test has meaningful data (not just setup phase)
  const totalRequests = metricValue(metrics.http_reqs, 'count');
  const totalIterations = metricValue(metrics.iterations, 'count');
  
  if (totalRequests === 0 && totalIterations === 0) {
    console.log('\n⚠️  Skipping CSV report generation:');
    console.log(`   Test "${sourceReport.name}" has no HTTP requests or iterations.`);
    console.log('   This appears to be a setup-only or empty test run.');
    console.log('   CSV reports are generated only for tests with actual load data.\n');
    process.exit(0);
  }
  
  const rows = requestRows(data);
  const baseName = sourceReport.name.replace(/^report-/, 'symulate-report-').replace(/\.json$/i, '');
  const generatedAt = new Date().toISOString();

  const overviewPath = path.join(reportsDir, `${baseName}-overview.csv`);
  const summaryPath = path.join(reportsDir, `${baseName}-summary.csv`);
  const aggregatePath = path.join(reportsDir, `${baseName}-aggregate.csv`);
  const checksPath = path.join(reportsDir, `${baseName}-checks.csv`);
  const urlDetailsPath = path.join(reportsDir, `${baseName}-url-details.csv`);
  const metricsPath = path.join(reportsDir, `${baseName}-all-metrics.csv`);

  // Overview CSV
  writeCsv(overviewPath, [
    ['Metric', 'Value'],
    ['Report Type', 'Symulate Load Test Report'],
    ['Source JSON', sourceReport.name],
    ['Generated At', generatedAt],
    ['Test Name', baseName.replace(/^symulate-report-/, '')],
    ['Total Requests', metricValue(metrics.http_reqs, 'count')],
    ['Failed Requests', Math.round(metricValue(metrics.http_req_failed, 'rate') * metricValue(metrics.http_reqs, 'count'))],
    ['Failed Request %', round(metricValue(metrics.http_req_failed, 'rate') * 100, 4)],
    ['Total Checks', (metricValue(metrics.checks, 'count') || 0)],
    ['Checks Passed %', round(metricValue(metrics.checks, 'rate') * 100, 2)],
    ['Total Iterations', metricValue(metrics.iterations, 'count')],
    ['Total VUs', metricValue(metrics.vus_max, 'max')],
    ['Avg Response Time (ms)', round(metricValue(metrics.http_req_duration, 'avg'))],
    ['P95 Response Time (ms)', round(metricValue(metrics.http_req_duration, 'p(95)'))],
    ['P99 Response Time (ms)', round(metricValue(metrics.http_req_duration, 'p(99)'))],
    ['Total Data Received (bytes)', metricValue(metrics.data_received, 'count')],
    ['Total Data Sent (bytes)', metricValue(metrics.data_sent, 'count')],
    ['WebSocket Sessions', metricValue(metrics.ws_sessions, 'count') || 0],
    ['WS Messages Sent', metricValue(metrics.ws_msgs_sent, 'count') || 0],
    ['WS Messages Received', metricValue(metrics.ws_msgs_received, 'count') || 0]
  ]);

  // Summary CSV (JMeter-style)
  writeCsv(summaryPath, [
    ['Label', '# Samples', 'Average', 'Min', 'Max', 'Std. Dev.', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec', 'Avg. Bytes'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.min,
      row.max,
      row.stddev,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec,
      row.avgBytes
    ])
  ]);

  // Aggregate CSV (with percentiles)
  writeCsv(aggregatePath, [
    ['Label', '# Samples', 'Average', 'Median', '90% Line', '95% Line', '99% Line', 'Min', 'Max', 'Error %', 'Throughput', 'Received KB/sec', 'Sent KB/sec'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.median,
      row.p90,
      row.p95,
      row.p99,
      row.min,
      row.max,
      row.errorRate,
      row.throughput,
      row.receivedKbSec,
      row.sentKbSec
    ])
  ]);

  // Checks CSV
  writeCsv(checksPath, [
    ['Group', 'Check', 'Passes', 'Fails', 'Pass %'],
    ...checkRows(data).map((row) => [row.group, row.check, row.passes, row.fails, row.passRate])
  ]);

  // URL Details CSV
  // Note: k6 captures endpoint labels (name tags) not full URLs in JSON summary
  // For full URLs, use --out csv=file.csv during test execution
  const urlDetails = extractHttpRequests(data);
  writeCsv(urlDetailsPath, [
    ['API Endpoint / Operation', '# Requests', 'Avg (ms)', 'Median (ms)', 'Min (ms)', 'Max (ms)', 'P90 (ms)', 'P95 (ms)', 'P99 (ms)'],
    ...urlDetails.map((row) => [
      row.endpoint,
      row.samples,
      row.avg_ms,
      row.median_ms,
      row.min_ms,
      row.max_ms,
      row.p90_ms,
      row.p95_ms,
      row.p99_ms
    ])
  ]);

  // All Metrics CSV (NEW!)
  const allMetrics = extractMetricsSummary(data);
  writeCsv(metricsPath, [
    ['Metric Name', 'Count', 'Rate (%)', 'Avg', 'Min', 'Median', 'Max', 'P90', 'P95', 'P99'],
    ...allMetrics.map((row) => [
      row.metric,
      row.count,
      row.rate,
      row.avg,
      row.min,
      row.med,
      row.max,
      row.p90,
      row.p95,
      row.p99
    ])
  ]);

  console.log(`CSV reports generated:`);
  console.log(`  ✓ ${path.basename(overviewPath)}`);
  console.log(`  ✓ ${path.basename(summaryPath)}`);
  console.log(`  ✓ ${path.basename(aggregatePath)}`);
  console.log(`  ✓ ${path.basename(checksPath)}`);
  console.log(`  ✓ ${path.basename(urlDetailsPath)} (NEW - URL details)`);
  console.log(`  ✓ ${path.basename(metricsPath)} (NEW - All metrics)`);
  console.log(`\nAll reports saved to: ${reportsDir}`);
}

main();
