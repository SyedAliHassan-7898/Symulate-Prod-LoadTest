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

  writeCsv(overviewPath, [
    ['Metric', 'Value'],
    ['Report Type', 'Symulate Load Test Report'],
    ['Source JSON', sourceReport.name],
    ['Generated At', generatedAt],
    ['Test Name', baseName.replace(/^symulate-report-/, '')],
    ['Total Requests', metricValue(metrics.http_reqs, 'count')],
    ['Failed Request %', round(metricValue(metrics.http_req_failed, 'rate') * 100, 4)],
    ['Checks Passed %', round(metricValue(metrics.checks, 'rate') * 100, 2)],
    ['Iterations', metricValue(metrics.iterations, 'count')]
  ]);

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

  console.log(`CSV reports generated:`);
  console.log(`- ${overviewPath}`);
  console.log(`- ${summaryPath}`);
  console.log(`- ${aggregatePath}`);
  console.log(`- ${checksPath}`);
}

main();
