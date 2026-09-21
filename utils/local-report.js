function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function metricValue(metric, key) {
  return metric && metric.values && metric.values[key] !== undefined ? metric.values[key] : 0;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Number(value).toFixed(2) : '0.00';
}

function metricRows(data) {
  const metrics = data && data.metrics ? data.metrics : {};
  return Object.keys(metrics)
    .sort()
    .map((name) => {
      const metric = metrics[name];
      return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(metric.type || '')}</td><td>${formatNumber(metricValue(metric, 'count'))}</td><td>${formatNumber(metricValue(metric, 'avg'))}</td><td>${formatNumber(metricValue(metric, 'p(95)'))}</td></tr>`;
    })
    .join('');
}

function checkRows(group, prefix) {
  const rows = [];
  const groupName = group && group.name ? `${prefix || ''}${group.name}` : prefix || 'default';

  (group && group.checks ? group.checks : []).forEach((check) => {
    rows.push(`<tr><td>${escapeHtml(groupName)}</td><td>${escapeHtml(check.name)}</td><td>${check.passes || 0}</td><td>${check.fails || 0}</td></tr>`);
  });
  (group && group.groups ? group.groups : []).forEach((nested) => {
    rows.push(checkRows(nested, `${groupName} / `));
  });
  return rows.join('');
}

export function htmlReport(data) {
  const metrics = data && data.metrics ? data.metrics : {};
  const checks = checkRows(data && data.root_group ? data.root_group : {}, '');
  const failedRequests = metricValue(metrics.http_req_failed, 'rate') * 100;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>k6 Load Test Report</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; }
    body { margin: 2rem auto; max-width: 1200px; padding: 0 1rem; color: #1f2937; }
    h1 { margin-bottom: .25rem; }
    .summary { display: flex; flex-wrap: wrap; gap: 1rem; margin: 1.5rem 0; }
    .stat { border: 1px solid #d1d5db; border-radius: 6px; padding: 1rem; min-width: 10rem; }
    .stat strong { display: block; font-size: 1.4rem; }
    table { border-collapse: collapse; margin: 1rem 0 2rem; width: 100%; }
    th, td { border: 1px solid #d1d5db; padding: .5rem; text-align: left; }
    th { background: #f3f4f6; }
    td:nth-child(n+3) { text-align: right; }
  </style>
</head>
<body>
  <h1>k6 Load Test Report</h1>
  <p>Generated ${escapeHtml(new Date().toISOString())}</p>
  <div class="summary">
    <div class="stat">Requests<strong>${formatNumber(metricValue(metrics.http_reqs, 'count'))}</strong></div>
    <div class="stat">Failed requests<strong>${formatNumber(failedRequests)}%</strong></div>
    <div class="stat">Iterations<strong>${formatNumber(metricValue(metrics.iterations, 'count'))}</strong></div>
    <div class="stat">Duration<strong>${formatNumber(metricValue(metrics.iteration_duration, 'avg'))} ms avg</strong></div>
  </div>
  <h2>Metrics</h2>
  <table><thead><tr><th>Metric</th><th>Type</th><th>Count</th><th>Average</th><th>p95</th></tr></thead><tbody>${metricRows(data)}</tbody></table>
  <h2>Checks</h2>
  <table><thead><tr><th>Group</th><th>Check</th><th>Passes</th><th>Fails</th></tr></thead><tbody>${checks || '<tr><td colspan="4">No checks recorded</td></tr>'}</tbody></table>
</body>
</html>`;
}