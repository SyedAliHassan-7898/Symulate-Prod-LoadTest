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

function main() {
  const { sourceReport, data } = loadLatestReport();
  const metrics = data.metrics || {};
  const rows = requestRows(data);
  const baseName = sourceReport.name.replace(/^report-/, 'symulate-report-').replace(/\.json$/i, '');
  const generatedAt = new Date().toISOString();

  const overviewPath = path.join(reportsDir, `${baseName}-overview.csv`);
  const summaryPath = path.join(reportsDir, `${baseName}-summary.csv`);
  const aggregatePath = path.join(reportsDir, `${baseName}-aggregate.csv`);
  const checksPath = path.join(reportsDir, `${baseName}-checks.csv`);

  const checksMetric = metrics.checks || {};

  const overviewRows = [
    ['Metric', 'Value'],
    ['Report Type', 'Symulate Load Test Report'],
    ['Source JSON', sourceReport.name],
    ['Generated At', generatedAt],
    ['Test Name', baseName.replace(/^symulate-report-/, '')],
    ['Total Requests', metricValue(metrics.http_reqs, 'count')],
    ['Failed Requests', metricValue(metrics.http_req_failed, 'count')],
    ['Failed Request %', round(metricValue(metrics.http_req_failed, 'rate') * 100, 4)],
    ['Total Checks', round(metricValue(checksMetric, 'passes') + metricValue(checksMetric, 'fails'))],
    ['Checks Passed %', round(metricValue(metrics.checks, 'rate') * 100, 2)],
    ['Total Iterations', metricValue(metrics.iterations, 'count')],
    ['Total VUs', round(metricValue(metrics.vus, 'max') || metricValue(metrics.vus_max, 'max'))],
    ['Avg Response Time (ms)', round(metricValue(metrics.http_req_duration, 'avg'))],
    ['P95 Response Time (ms)', round(metricValue(metrics.http_req_duration, 'p(95)'))],
    ['P99 Response Time (ms)', round(metricValue(metrics.http_req_duration, 'p(99)'))],
    ['Total Data Received (bytes)', round(metricValue(metrics.data_received, 'count'))],
    ['Total Data Sent (bytes)', round(metricValue(metrics.data_sent, 'count') || metricValue(metrics.sent_bytes, 'count'))]
  ];

  // WebSocket rows only when the run actually opened sockets — an empty row
  // would otherwise read as "zero sessions" instead of "not applicable".
  [
    ['WebSocket Sessions', 'ws_sessions'],
    ['WS Messages Sent', 'ws_msgs_sent'],
    ['WS Messages Received', 'ws_msgs_received']
  ].forEach(([label, metricName]) => {
    if (metrics[metricName]) {
      overviewRows.push([label, round(metricValue(metrics[metricName], 'count') || metricValue(metrics[metricName], 'max'))]);
    }
  });

  writeCsv(overviewPath, overviewRows);

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

  writeCsv(checksPath, [
    ['Group', 'Check', 'Passes', 'Fails', 'Pass %'],
    ...checkRows(data).map((row) => [row.group, row.check, row.passes, row.fails, row.passRate])
  ]);

  // url-details.csv — "which endpoints were hit, and how fast".
  // The README documented this file long before the generator produced it.
  const urlDetailsPath = path.join(reportsDir, `${baseName}-url-details.csv`);
  writeCsv(urlDetailsPath, [
    ['URL/Endpoint', '# Requests', 'Avg (ms)', 'Median (ms)', 'Min (ms)', 'Max (ms)', 'P90 (ms)', 'P95 (ms)', 'P99 (ms)'],
    ...rows.map((row) => [
      row.label,
      row.samples,
      row.average,
      row.median,
      row.min,
      row.max,
      row.p90,
      row.p95,
      row.p99
    ])
  ]);

  // all-metrics.csv — every metric k6 emitted, one row each. Useful as the
  // raw artifact a run-over-run diff can be built on.
  const allMetricsPath = path.join(reportsDir, `${baseName}-all-metrics.csv`);
  writeCsv(allMetricsPath, [
    ['Metric Name', 'Count', 'Rate (%)', 'Avg', 'Min', 'Median', 'Max', 'P90', 'P95', 'P99'],
    ...Object.entries(metrics)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, metric]) => [
        name,
        round(metricValue(metric, 'count')),
        round(metricValue(metric, 'rate') * 100, 4),
        round(metricValue(metric, 'avg')),
        round(metricValue(metric, 'min')),
        round(metricValue(metric, 'med')),
        round(metricValue(metric, 'max')),
        round(metricValue(metric, 'p(90)')),
        round(metricValue(metric, 'p(95)')),
        round(metricValue(metric, 'p(99)'))
      ])
  ]);

  console.log(`CSV reports generated:`);
  console.log(`- ${overviewPath}`);
  console.log(`- ${summaryPath}`);
  console.log(`- ${aggregatePath}`);
  console.log(`- ${checksPath}`);
  console.log(`- ${urlDetailsPath}`);
  console.log(`- ${allMetricsPath}`);
}

main();
