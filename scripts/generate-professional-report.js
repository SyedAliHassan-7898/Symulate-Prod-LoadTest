#!/usr/bin/env node
/**
 * Professional Load Test Report Generator
 * 
 * Generates a comprehensive, industry-standard load testing report with:
 * 1. Executive Summary
 * 2. Test Configuration
 * 3. Summary Graphs & Charts
 * 4. Performance Metrics
 * 5. Endpoint Analysis
 * 6. Detailed Findings
 * 7. Test Validation
 * 8. Methodology
 * 9. Appendices
 */

const fs = require('fs');
const path = require('path');
const { reportsDir, loadLatestReport, metricValue, round, readProjectEnv, resolveConfig, requestRows, stripReportPrefixes } = require('./report-utils');
const { LATEST_FAILURES } = require('./failure-utils');

// Load per-request failures captured by the runner (reports/failures-latest.json).
// k6's summary JSON only carries the aggregated http_req_failed rate, so the
// status code + response-body message come from the runner's stderr scrape.
function loadFailures() {
  try {
    if (!fs.existsSync(LATEST_FAILURES)) return [];
    const parsed = JSON.parse(fs.readFileSync(LATEST_FAILURES, 'utf-8'));
    return Array.isArray(parsed.failures) ? parsed.failures : [];
  } catch (err) {
    return [];
  }
}

// HTML-escape a string so failure messages (which can contain <, >, &) render
// safely inside the report table.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Severity classification based on performance thresholds
function classifyIssue(metric, threshold) {
  if (metric >= threshold.critical) return { level: 'CRITICAL', color: '#dc3545' };
  if (metric >= threshold.high) return { level: 'HIGH', color: '#fd7e14' };
  if (metric >= threshold.medium) return { level: 'MEDIUM', color: '#ffc107' };
  return { level: 'LOW', color: '#28a745' };
}

// Analyze performance and identify issues
function analyzePerformance(data) {
  const metrics = data.metrics || {};
  const findings = [];

  // Error rate analysis
  const errorRate = metricValue(metrics.http_req_failed, 'rate') * 100;
  if (errorRate > 0) {
    const severity = classifyIssue(errorRate, { critical: 5, high: 2, medium: 1 });
    findings.push({
      title: 'HTTP Request Failures Detected',
      severity: severity.level,
      color: severity.color,
      description: `${round(errorRate, 2)}% of HTTP requests failed during the test.`,
      evidence: `Failed Requests: ${Math.round(metricValue(metrics.http_reqs, 'count') * metricValue(metrics.http_req_failed, 'rate'))} out of ${Math.round(metricValue(metrics.http_reqs, 'count'))}`,
      recommendation: errorRate > 5 
        ? 'Critical: Investigate server errors immediately. Check application logs and server resources.'
        : 'Monitor error patterns and investigate root cause. Review failed request details.'
    });
  }

  // Response time analysis
  const p95 = metricValue(metrics.http_req_duration, 'p(95)');
  if (p95 > 1000) {
    const severity = classifyIssue(p95, { critical: 3000, high: 2000, medium: 1000 });
    findings.push({
      title: 'High Response Time (P95)',
      severity: severity.level,
      color: severity.color,
      description: `95th percentile response time is ${round(p95)}ms, exceeding acceptable thresholds.`,
      evidence: `P95: ${round(p95)}ms, P99: ${round(metricValue(metrics.http_req_duration, 'p(99)'))}ms, Max: ${round(metricValue(metrics.http_req_duration, 'max'))}ms`,
      recommendation: 'Optimize slow endpoints. Consider caching, database indexing, or scaling resources.'
    });
  }

  // Check failures
  const checkRate = metricValue(metrics.checks, 'rate') * 100;
  if (checkRate < 100) {
    const failRate = 100 - checkRate;
    const severity = classifyIssue(failRate, { critical: 10, high: 5, medium: 2 });
    findings.push({
      title: 'Test Assertions Failed',
      severity: severity.level,
      color: severity.color,
      description: `${round(failRate, 2)}% of test assertions failed.`,
      evidence: `Pass Rate: ${round(checkRate, 2)}%, Total Checks: ${Math.round(metricValue(metrics.checks, 'count'))}`,
      recommendation: 'Review failed assertions in detailed check report. Verify expected vs actual responses.'
    });
  }

  // WebSocket analysis (if applicable)
  const wsSessions = metricValue(metrics.ws_sessions, 'count');
  if (wsSessions > 0) {
    const wsAvgDuration = metricValue(metrics.ws_session_duration, 'avg');
    if (wsAvgDuration < 5000) {
      findings.push({
        title: 'Short WebSocket Session Duration',
        severity: 'MEDIUM',
        color: '#ffc107',
        description: `WebSocket sessions averaging ${round(wsAvgDuration / 1000, 2)}s, which may indicate connection issues.`,
        evidence: `Sessions: ${wsSessions}, Avg Duration: ${round(wsAvgDuration / 1000, 2)}s, Messages: ${Math.round(metricValue(metrics.ws_msgs_sent, 'count'))}`,
        recommendation: 'Investigate WebSocket connection stability. Check for premature disconnections.'
      });
    }
  }

  return findings;
}

// Extract test metadata
function extractTestConfig(data, sourceReport) {
  const metrics = data.metrics || {};
  const testName = sourceReport.name.replace(/^report-/, '').replace(/\.json$/i, '');
  const fileEnv = readProjectEnv();

  // Infer test type from the report name. The shared-project loader's Phase 2
  // report is named `shared-admin-candidate-load-load-...` (contains "load"),
  // while its Phase 1 provisioning report contains "smoke".
  let testType = 'Load Test';
  if (/\bsmoke\b/i.test(testName)) testType = 'Smoke Test';
  if (/\bstress\b/i.test(testName)) testType = 'Stress Test';
  if (/\bsoak\b/i.test(testName)) testType = 'Soak Test';
  if (/\bload\b/i.test(testName)) testType = 'Load Test';

  return {
    testName,
    testType,
    environment: resolveConfig('ENV', '') || resolveConfig('ENVIRONMENT', '') || 'Unknown',
    vus: Math.round(metricValue(metrics.vus_max, 'max')),
    duration: round(metricValue(metrics.iteration_duration, 'avg') / 1000, 2),
    iterations: Math.round(metricValue(metrics.iterations, 'count')),
    fileEnv
  };
}

// Generate HTML report
function generateHTML(data, sourceReport) {
  const metrics = data.metrics || {};
  const config = extractTestConfig(data, sourceReport);
  const findings = analyzePerformance(data);
  const failures = loadFailures();
  const generatedAt = new Date().toISOString();
  
  // Calculate key metrics
  const totalRequests = Math.round(metricValue(metrics.http_reqs, 'count'));
  const failedRequests = Math.round(totalRequests * metricValue(metrics.http_req_failed, 'rate'));
  const errorRate = metricValue(metrics.http_req_failed, 'rate') * 100;
  const avgResponse = round(metricValue(metrics.http_req_duration, 'avg'));
  const p95Response = round(metricValue(metrics.http_req_duration, 'p(95)'));
  const p99Response = round(metricValue(metrics.http_req_duration, 'p(99)'));
  const throughput = round(totalRequests / (config.duration || 1), 2);
  const checkRate = round(metricValue(metrics.checks, 'rate') * 100, 2);

  // Per-endpoint rows (from `name:`-tagged sub-metrics). Falls back to a
  // global TOTAL row when no per-endpoint tags exist, so this section is
  // never empty.
  let endpointRows = requestRows(data);
  if (endpointRows.length === 0 && totalRequests > 0) {
    endpointRows = [{
      label: 'TOTAL (all requests)',
      samples: totalRequests,
      average: avgResponse,
      median: round(metricValue(metrics.http_req_duration, 'med')),
      p90: round(metricValue(metrics.http_req_duration, 'p(90)')),
      p95: p95Response,
      p99: p99Response,
      min: round(metricValue(metrics.http_req_duration, 'min')),
      max: round(metricValue(metrics.http_req_duration, 'max')),
      errorRate: round(errorRate, 4)
    }];
  }
  
  // Overall status
  const overallPass = errorRate < 1 && checkRate > 99 && p95Response < 1000;
  const statusBadge = overallPass 
    ? '<span class="badge badge-success">✓ PASS</span>'
    : '<span class="badge badge-warning">⚠ ISSUES FOUND</span>';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Symulate-AI Load Test Report - ${config.testName}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            line-height: 1.6; 
            color: #333; 
            background: #f5f7fa;
            padding: 20px;
        }
        .container { max-width: 1200px; margin: 0 auto; background: white; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white; 
            padding: 40px; 
            text-align: center;
        }
        .header h1 { font-size: 2.5em; margin-bottom: 10px; }
        .header .subtitle { opacity: 0.9; font-size: 1.1em; }
        .section { padding: 40px; border-bottom: 1px solid #eee; }
        .section:last-child { border-bottom: none; }
        .section-title { 
            font-size: 1.8em; 
            color: #667eea; 
            margin-bottom: 20px; 
            padding-bottom: 10px;
            border-bottom: 3px solid #667eea;
        }
        .section-number { 
            display: inline-block;
            background: #667eea;
            color: white;
            width: 35px;
            height: 35px;
            line-height: 35px;
            border-radius: 50%;
            text-align: center;
            margin-right: 10px;
            font-weight: bold;
        }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 20px 0; }
        .metric-card {
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .metric-card h3 { font-size: 0.9em; color: #666; margin-bottom: 10px; text-transform: uppercase; }
        .metric-card .value { font-size: 2em; font-weight: bold; color: #667eea; }
        .metric-card .unit { font-size: 0.8em; color: #999; }
        .badge { 
            display: inline-block; 
            padding: 5px 15px; 
            border-radius: 20px; 
            font-size: 0.9em; 
            font-weight: bold;
        }
        .badge-success { background: #28a745; color: white; }
        .badge-warning { background: #ffc107; color: #000; }
        .badge-danger { background: #dc3545; color: white; }
        .config-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .config-table th, .config-table td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
        .config-table th { background: #f8f9fa; font-weight: 600; color: #495057; }
        .finding-card {
            background: white;
            border-left: 4px solid;
            padding: 20px;
            margin: 15px 0;
            border-radius: 4px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .finding-card h3 { margin-bottom: 10px; }
        .finding-card .severity { 
            display: inline-block;
            padding: 3px 10px;
            border-radius: 3px;
            font-size: 0.85em;
            font-weight: bold;
            color: white;
            margin-bottom: 10px;
        }
        .finding-card .description { margin: 10px 0; line-height: 1.8; }
        .finding-card .evidence { 
            background: #f8f9fa; 
            padding: 10px; 
            border-radius: 4px; 
            font-family: monospace; 
            font-size: 0.9em;
            margin: 10px 0;
        }
        .finding-card .recommendation { 
            background: #e7f3ff; 
            padding: 10px; 
            border-radius: 4px; 
            margin-top: 10px;
        }
        .methodology-box {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
        }
        .methodology-box h4 { margin-bottom: 10px; color: #667eea; }
        .methodology-box ul { margin-left: 20px; }
        .methodology-box li { margin: 5px 0; }
        .footer { 
            background: #2c3e50; 
            color: white; 
            padding: 20px 40px; 
            text-align: center; 
        }
        .footer p { margin: 5px 0; opacity: 0.8; }
        @media print {
            body { background: white; padding: 0; }
            .container { box-shadow: none; }
            .section { page-break-inside: avoid; }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <div class="header">
            <h1>📊 Symulate-AI Load Test Report</h1>
            <p class="subtitle">${config.testName}</p>
            <p style="margin-top: 10px; font-size: 0.9em;">Generated: ${new Date(generatedAt).toLocaleString()}</p>
        </div>

        <!-- 1. Executive Summary -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">1</span>Executive Summary</h2>
            <div style="margin: 20px 0;">
                <h3>Overall Result: ${statusBadge}</h3>
            </div>
            
            <h3 style="margin-top: 30px; color: #495057;">Test Objective</h3>
            <p style="margin: 10px 0; line-height: 1.8;">
                Validate system performance and stability under ${config.testType.toLowerCase()} conditions with ${config.vus} concurrent virtual users. 
                Measure response times, throughput, error rates, and identify potential bottlenecks.
            </p>

            <h3 style="margin-top: 20px; color: #495057;">Test Duration & Scope</h3>
            <p style="margin: 10px 0;">
                <strong>Duration:</strong> ${config.duration}s | 
                <strong>VUs:</strong> ${config.vus} | 
                <strong>Iterations:</strong> ${config.iterations} | 
                <strong>Total Requests:</strong> ${totalRequests.toLocaleString()}
            </p>

            <h3 style="margin-top: 20px; color: #495057;">Key Metrics</h3>
            <div class="grid">
                <div class="metric-card">
                    <h3>Avg Response Time</h3>
                    <div class="value">${avgResponse}<span class="unit">ms</span></div>
                </div>
                <div class="metric-card">
                    <h3>P95 Response Time</h3>
                    <div class="value">${p95Response}<span class="unit">ms</span></div>
                </div>
                <div class="metric-card">
                    <h3>Error Rate</h3>
                    <div class="value">${round(errorRate, 2)}<span class="unit">%</span></div>
                </div>
                <div class="metric-card">
                    <h3>Throughput</h3>
                    <div class="value">${throughput}<span class="unit">req/s</span></div>
                </div>
            </div>

            ${findings.length > 0 ? `
            <h3 style="margin-top: 20px; color: #495057;">Critical Issues</h3>
            <ul style="margin-left: 20px; line-height: 2;">
                ${findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').map(f => 
                    `<li><strong>[${f.severity}]</strong> ${f.title}</li>`
                ).join('')}
                ${findings.filter(f => f.severity === 'CRITICAL' || f.severity === 'HIGH').length === 0 ? 
                    '<li style="color: #28a745;">No critical or high severity issues detected.</li>' : ''}
            </ul>
            ` : `
            <h3 style="margin-top: 20px; color: #28a745;">✓ No Critical Issues Found</h3>
            <p>All metrics within acceptable thresholds.</p>
            `}
        </div>

        <!-- 2. Test Configuration -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">2</span>Test Configuration</h2>
            <table class="config-table">
                <tr><th>Parameter</th><th>Value</th></tr>
                <tr><td>Environment</td><td>${config.environment}</td></tr>
                <tr><td>Test Type</td><td>${config.testType}</td></tr>
                <tr><td>Virtual Users (VUs)</td><td>${config.vus}</td></tr>
                <tr><td>Test Duration</td><td>${config.duration}s</td></tr>
                <tr><td>Total Iterations</td><td>${config.iterations}</td></tr>
                <tr><td>Total HTTP Requests</td><td>${totalRequests.toLocaleString()}</td></tr>
                <tr><td>WebSocket Sessions</td><td>${Math.round(metricValue(metrics.ws_sessions, 'count'))}</td></tr>
                <tr><td>Scenario</td><td>${resolveConfig('SCENARIO', 'full')}</td></tr>
                <tr><td>Target API URL</td><td>${resolveConfig('API_URL', 'N/A')}</td></tr>
                <tr><td>Client Admin URL</td><td>${resolveConfig('CLIENT_ADMIN_URL', 'N/A')}</td></tr>
                <tr><td>Candidate URL</td><td>${resolveConfig('CANDIDATE_URL', 'N/A')}</td></tr>
                <tr><td>Super Admin URL</td><td>${resolveConfig('SUPER_ADMIN_URL', 'N/A')}</td></tr>
                <tr><td>Anam / ANUM API</td><td>${resolveConfig('ANUM_API_ENABLED', 'N/A')} (mode: ${resolveConfig('ANAM_MODE', 'N/A')})</td></tr>
                <tr><td>Configured LOAD_VUS</td><td>${resolveConfig('LOAD_VUS', 'N/A')}</td></tr>
                <tr><td>Configured MAX_DURATION</td><td>${resolveConfig('LOAD_MAX_DURATION', 'N/A')}</td></tr>
                <tr><td>Test Timestamp</td><td>${generatedAt}</td></tr>
            </table>

            <h3 style="margin-top: 20px; color: #495057;">Test Scenarios</h3>
            <div class="methodology-box">
                <p>This ${config.testType.toLowerCase()} executed a complete end-to-end workflow including:</p>
                <ul>
                    <li>User authentication and session management</li>
                    <li>Project provisioning and candidate assignment</li>
                    <li>Activity execution with WebSocket conversations</li>
                    <li>Concurrent multi-user scenarios</li>
                    <li>Admin and candidate portal operations</li>
                </ul>
            </div>
        </div>

        <!-- 3. Summary Graphs & Charts -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">3</span>Summary Graphs & Charts</h2>
            <p style="color: #666; font-style: italic;">
                📊 For real-time graphs and charts, access the Grafana dashboard during test execution.<br>
                Static charts will be added in future versions of this report.
            </p>
            <div class="grid" style="margin-top: 20px;">
                <div class="metric-card">
                    <h3>Response Time Distribution</h3>
                    <div style="margin-top: 10px; font-size: 0.9em;">
                        Min: ${round(metricValue(metrics.http_req_duration, 'min'))}ms<br>
                        Avg: ${avgResponse}ms<br>
                        P90: ${round(metricValue(metrics.http_req_duration, 'p(90)'))}ms<br>
                        P95: ${p95Response}ms<br>
                        P99: ${p99Response}ms<br>
                        Max: ${round(metricValue(metrics.http_req_duration, 'max'))}ms
                    </div>
                </div>
                <div class="metric-card">
                    <h3>Data Transfer</h3>
                    <div style="margin-top: 10px; font-size: 0.9em;">
                        Received: ${round(metricValue(metrics.data_received, 'count') / 1024 / 1024, 2)} MB<br>
                        Sent: ${round(metricValue(metrics.data_sent, 'count') / 1024, 2)} KB<br>
                        Throughput: ${throughput} req/s
                    </div>
                </div>
            </div>
        </div>

        <!-- 4. Performance Metrics -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">4</span>Performance Metrics</h2>
            
            <h3 style="color: #495057; margin-top: 20px;">HTTP Metrics</h3>
            <table class="config-table">
                <tr><th>Metric</th><th>Value</th></tr>
                <tr><td>Total Requests</td><td>${totalRequests.toLocaleString()}</td></tr>
                <tr><td>Failed Requests</td><td>${failedRequests} (${round(errorRate, 2)}%)</td></tr>
                <tr><td>Avg Response Time</td><td>${avgResponse}ms</td></tr>
                <tr><td>Min Response Time</td><td>${round(metricValue(metrics.http_req_duration, 'min'))}ms</td></tr>
                <tr><td>Max Response Time</td><td>${round(metricValue(metrics.http_req_duration, 'max'))}ms</td></tr>
                <tr><td>P90 Latency</td><td>${round(metricValue(metrics.http_req_duration, 'p(90)'))}ms</td></tr>
                <tr><td>P95 Latency</td><td>${p95Response}ms</td></tr>
                <tr><td>P99 Latency</td><td>${p99Response}ms</td></tr>
                <tr><td>Avg Connection Time</td><td>${round(metricValue(metrics.http_req_connecting, 'avg'))}ms</td></tr>
                <tr><td>Avg TLS Handshake</td><td>${round(metricValue(metrics.http_req_tls_handshaking, 'avg'))}ms</td></tr>
            </table>

            <h3 style="color: #495057; margin-top: 30px;">WebSocket Metrics</h3>
            <table class="config-table">
                <tr><th>Metric</th><th>Value</th></tr>
                <tr><td>Total Sessions</td><td>${Math.round(metricValue(metrics.ws_sessions, 'count'))}</td></tr>
                <tr><td>Messages Sent</td><td>${Math.round(metricValue(metrics.ws_msgs_sent, 'count'))}</td></tr>
                <tr><td>Messages Received</td><td>${Math.round(metricValue(metrics.ws_msgs_received, 'count'))}</td></tr>
                <tr><td>Avg Connection Duration</td><td>${round(metricValue(metrics.ws_session_duration, 'avg') / 1000, 2)}s</td></tr>
                <tr><td>Avg Connection Time</td><td>${round(metricValue(metrics.ws_connecting, 'avg'))}ms</td></tr>
            </table>

            <h3 style="color: #495057; margin-top: 30px;">Throughput Metrics</h3>
            <table class="config-table">
                <tr><th>Metric</th><th>Value</th></tr>
                <tr><td>Requests/sec</td><td>${throughput}</td></tr>
                <tr><td>Data Received</td><td>${round(metricValue(metrics.data_received, 'count') / 1024 / 1024, 2)} MB</td></tr>
                <tr><td>Data Sent</td><td>${round(metricValue(metrics.data_sent, 'count') / 1024, 2)} KB</td></tr>
                <tr><td>Received KB/sec</td><td>${round((metricValue(metrics.data_received, 'count') / 1024) / config.duration, 2)}</td></tr>
                <tr><td>Sent KB/sec</td><td>${round((metricValue(metrics.data_sent, 'count') / 1024) / config.duration, 2)}</td></tr>
            </table>
        </div>

        <!-- 5. Endpoint Analysis -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">5</span>Endpoint Analysis (URL Details)</h2>
            ${endpointRows.length > 0 ? `
            <p style="color: #666; margin-bottom: 20px;">
                Per-endpoint performance breakdown (from <code>name:</code>-tagged metrics). Full data also in <code>*-url-details.csv</code> and <code>*-aggregate.csv</code>.
            </p>
            <table class="config-table">
                <tr>
                    <th>Endpoint / Label</th>
                    <th>Samples</th>
                    <th>Avg (ms)</th>
                    <th>Median (ms)</th>
                    <th>P90 (ms)</th>
                    <th>P95 (ms)</th>
                    <th>P99 (ms)</th>
                    <th>Min (ms)</th>
                    <th>Max (ms)</th>
                    <th>Error %</th>
                </tr>
                ${endpointRows.map((row) => `
                <tr>
                    <td>${row.label}</td>
                    <td>${row.samples}</td>
                    <td>${row.average}</td>
                    <td>${row.median}</td>
                    <td>${row.p90}</td>
                    <td>${row.p95}</td>
                    <td>${row.p99}</td>
                    <td>${row.min}</td>
                    <td>${row.max}</td>
                    <td>${row.errorRate}</td>
                </tr>`).join('')}
            </table>
            ` : `
            <p style="color: #666; margin-bottom: 20px;">
                No per-endpoint (<code>name:</code>-tagged) metrics were captured for this run.
                Detailed performance breakdown is available in the CSV reports: <code>*-url-details.csv</code> and <code>*-aggregate.csv</code>.
            </p>
            `}
        </div>

        <!-- 6. Detailed Findings -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">6</span>Detailed Findings</h2>
            
            ${findings.length > 0 ? findings.map(finding => `
                <div class="finding-card" style="border-left-color: ${finding.color};">
                    <h3>${finding.title}</h3>
                    <span class="severity" style="background: ${finding.color};">${finding.severity}</span>
                    <p class="description">${finding.description}</p>
                    <div class="evidence">
                        <strong>Evidence:</strong><br>
                        ${finding.evidence}
                    </div>
                    <div class="recommendation">
                        <strong>💡 Recommendation:</strong><br>
                        ${finding.recommendation}
                    </div>
                </div>
            `).join('') : `
                <div class="finding-card" style="border-left-color: #28a745;">
                    <h3>✓ No Performance Issues Detected</h3>
                    <p class="description">
                        All performance metrics are within acceptable thresholds. 
                        The system handled the load successfully with no critical issues.
                    </p>
                </div>
            `}

            ${failures.length > 0 ? `
            <h3 style="margin: 30px 0 12px; font-size: 18px; color: #333;">
                Failed Requests (${failures.length})
            </h3>
            <p style="color: #666; margin-bottom: 12px; font-size: 13px;">
                Every request that returned an error status or failed at the network layer,
                with its response code and the server's failure message.
            </p>
            <div style="overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead>
                    <tr style="background: #f5f6fa; text-align: left;">
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">#</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">Time</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">Label</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">Method</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">Status</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">Failure Message</th>
                        <th style="padding: 10px; border-bottom: 2px solid #ddd;">URL</th>
                    </tr>
                </thead>
                <tbody>
                    ${failures.map((f, i) => {
                        const statusColor = f.status >= 500 ? '#dc3545' : (f.status >= 400 ? '#fd7e14' : '#6c757d');
                        const time = f.at ? new Date(f.at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
                        return `
                    <tr style="border-bottom: 1px solid #eee;">
                        <td style="padding: 8px 10px; color: #888;">${i + 1}</td>
                        <td style="padding: 8px 10px; white-space: nowrap; color: #666;">${escapeHtml(time)}</td>
                        <td style="padding: 8px 10px;">${escapeHtml(f.name)}</td>
                        <td style="padding: 8px 10px;">${escapeHtml(f.method)}</td>
                        <td style="padding: 8px 10px;"><span style="background: ${statusColor}; color: #fff; padding: 2px 8px; border-radius: 4px; font-weight: 600;">${escapeHtml(f.status)}${f.errorCode ? ` (${f.errorCode})` : ''}</span></td>
                        <td style="padding: 8px 10px; color: #b02a37; word-break: break-word; max-width: 380px;">${escapeHtml(f.message)}</td>
                        <td style="padding: 8px 10px; color: #666; word-break: break-all; max-width: 300px;">${escapeHtml(f.url)}</td>
                    </tr>`;
                    }).join('')}
                </tbody>
            </table>
            </div>
            ` : `
            <p style="color: #666; margin-top: 24px; font-size: 13px;">
                No per-request failures were captured for this run (either all requests succeeded,
                or per-request failure logging was unavailable).
            </p>
            `}
        </div>

        <!-- 7. Test Validation (Checks) -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">7</span>Test Validation (Checks)</h2>
            <div class="grid">
                <div class="metric-card">
                    <h3>Total Assertions</h3>
                    <div class="value">${Math.round(metricValue(metrics.checks, 'count'))}</div>
                </div>
                <div class="metric-card">
                    <h3>Pass Count</h3>
                    <div class="value">${Math.round(metricValue(metrics.checks, 'count') * metricValue(metrics.checks, 'rate'))}</div>
                </div>
                <div class="metric-card">
                    <h3>Fail Count</h3>
                    <div class="value">${Math.round(metricValue(metrics.checks, 'count') * (1 - metricValue(metrics.checks, 'rate')))}</div>
                </div>
                <div class="metric-card">
                    <h3>Pass Percentage</h3>
                    <div class="value">${checkRate}<span class="unit">%</span></div>
                </div>
            </div>
            <p style="margin-top: 20px; color: #666;">
                Detailed check results available in: <code>*-checks.csv</code>
            </p>
        </div>

        <!-- 8. Methodology -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">8</span>Methodology</h2>
            
            <div class="methodology-box">
                <h4>Test Approach</h4>
                <p>This ${config.testType.toLowerCase()} follows a two-phase approach:</p>
                <ul>
                    <li><strong>Phase 1:</strong> Sequential provisioning of test data (projects, candidates, activities)</li>
                    <li><strong>Phase 2:</strong> Concurrent execution with ${config.vus} virtual users performing realistic workflows</li>
                </ul>
            </div>

            <div class="methodology-box">
                <h4>Tools Used</h4>
                <ul>
                    <li><strong>k6:</strong> Open-source load testing tool for HTTP and WebSocket protocols</li>
                    <li><strong>Grafana:</strong> Real-time metrics visualization dashboard</li>
                    <li><strong>InfluxDB:</strong> Time-series database for metric storage</li>
                    <li><strong>Playwright:</strong> Browser automation for E2E validation</li>
                </ul>
            </div>

            <div class="methodology-box">
                <h4>Test Phases</h4>
                <ol>
                    <li><strong>Setup Phase:</strong> Environment validation and test data preparation</li>
                    <li><strong>Ramp-up:</strong> Gradual VU startup with ${round(1.5, 1)}s intervals to prevent thundering herd</li>
                    <li><strong>Sustained Load:</strong> ${config.vus} concurrent VUs maintaining steady traffic</li>
                    <li><strong>Measurement:</strong> Continuous metric collection at 3-second intervals</li>
                    <li><strong>Teardown:</strong> Graceful shutdown and report generation</li>
                </ol>
            </div>

            <div class="methodology-box">
                <h4>Load Pattern</h4>
                <p>
                    ${config.testType === 'Smoke Test' ? 
                        'Single virtual user executing complete workflow to validate basic functionality.' :
                        `${config.vus} concurrent virtual users with staggered start times executing realistic user journeys including authentication, activity execution, and WebSocket-based conversations.`
                    }
                </p>
            </div>
        </div>

        <!-- 9. Appendices -->
        <div class="section">
            <h2 class="section-title"><span class="section-number">9</span>Appendices</h2>
            
            <h3 style="color: #495057;">Raw Data (CSV Files)</h3>
            <p style="margin: 10px 0;">Complete test data available in multiple CSV formats for further analysis:</p>
            <ul style="margin-left: 20px; line-height: 2;">
                <li><code>*-overview.csv</code> - Executive summary metrics</li>
                <li><code>*-summary.csv</code> - Per-endpoint JMeter-style analysis</li>
                <li><code>*-aggregate.csv</code> - Percentile distribution data</li>
                <li><code>*-checks.csv</code> - Detailed assertion results</li>
                <li><code>*-url-details.csv</code> - Complete URL performance breakdown</li>
                <li><code>*-all-metrics.csv</code> - Every k6 metric captured</li>
            </ul>

            <h3 style="color: #495057; margin-top: 20px;">Complete Metrics</h3>
            <p style="margin: 10px 0;">Full metrics available in: <code>${sourceReport.name}</code></p>

            <h3 style="color: #495057; margin-top: 20px;">Test Scripts Info</h3>
            <ul style="margin-left: 20px; line-height: 2;">
                <li><strong>Test Script:</strong> ${(() => {
                  const n = config.testName;
                  if (n.includes('shared-admin-candidate')) return 'tests/shared-project-admin-candidate-load.js';
                  if (n.includes('anam-validation-setup')) return 'tests/smoke-no-anum-setup.js';
                  if (n.includes('candidate-assessment')) return 'tests/load-candidate-assessment.js';
                  if (n.includes('client-project')) return 'tests/load-client-project.js';
                  if (n.includes('project-review')) return 'tests/load-project-review.js';
                  return 'tests/smoke.js';
                })()}</li>
                <li><strong>Orchestrator:</strong> ${config.testName.includes('shared') || config.testName.includes('anam-validation-setup')
                  ? 'scripts/run-shared-project-load.js'
                  : 'scripts/run.js'}</li>
                <li><strong>Framework:</strong> k6 v0.45+</li>
            </ul>
        </div>

        <!-- Footer -->
        <div class="footer">
            <p><strong>Symulate AI Load Testing Suite</strong></p>
            <p>Professional Load Test Report | Generated: ${new Date(generatedAt).toLocaleString()}</p>
            <p>Source: ${sourceReport.name}</p>
        </div>
    </div>
</body>
</html>`;

  return html;
}

function main() {
  const { sourceReport, data } = loadLatestReport();
  const metrics = data.metrics || {};
  
  // Validate that test has meaningful data (not just setup phase)
  const totalRequests = metricValue(metrics.http_reqs, 'count');
  const totalIterations = metricValue(metrics.iterations, 'count');
  
  if (totalRequests === 0 && totalIterations === 0) {
    console.log('\n⚠️  Skipping professional report generation:');
    console.log(`   Test "${sourceReport.name}" has no HTTP requests or iterations.`);
    console.log('   This appears to be a setup-only or empty test run.');
    console.log('   Professional reports are generated only for tests with actual load data.\n');
    process.exit(0);
  }
  
  const htmlPath = path.join(reportsDir, `symulate-${stripReportPrefixes(sourceReport.name)}.html`);

  const html = generateHTML(data, sourceReport);
  fs.writeFileSync(htmlPath, html, 'utf8');

  console.log(`\n✅ Professional Load Test Report Generated!`);
  console.log(`📄 ${path.basename(htmlPath)}`);
  console.log(`\n📂 Location: ${reportsDir}`);
  console.log(`\nOpen in browser to view the complete report with all 9 sections.`);
}

main();
