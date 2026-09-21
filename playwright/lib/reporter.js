// playwright/lib/reporter.js
// Screenshot, evidence, HTML + PDF report helper.
// No extra npm packages — PDF is rendered via Chromium.

const fs = require('fs');
const path = require('path');

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

function createRun(base) {
  const dir = path.join(base, ts());
  ['screenshots', 'evidence', 'video'].forEach((d) => fs.mkdirSync(path.join(dir, d), { recursive: true }));
  return dir;
}

async function shot(page, runDir, name) {
  const file = path.join(runDir, 'screenshots', `${Date.now()}-${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch (e) {
    console.warn(`[screenshot] failed: ${e.message}`);
    return null;
  }
}

function writeEvidence(runDir, name, data) {
  const file = path.join(runDir, 'evidence', `${Date.now()}-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildRows(items, render, emptyCols, emptyText) {
  if (!items || !items.length) {
    return `<tr><td colspan="${emptyCols}" class="empty">${esc(emptyText)}</td></tr>`;
  }
  return items.map(render).join('');
}

function buildHtml(runDir, summary) {
  const s = summary || {};
  const color = s.overallResult === 'PASS' ? '#0a7d2c' : '#b3261e';
  const mode = s.anamMode || (String(s.anumApiEnabled) === 'true' ? 'healthy' : 'disabled');
  const checks = s.modeChecks || {};

  const stepsRows = buildRows(
    s.steps,
    (x) =>
      `<tr><td>${esc(x.name)}</td><td style="color:${x.ok ? '#0a7d2c' : '#b3261e'};font-weight:600">${x.ok ? 'OK' : 'FAIL'}</td>` +
      `<td>${esc(x.note || '')}</td><td>${x.screenshot ? `<a href="${esc(path.relative(runDir, x.screenshot))}" target="_blank">view</a>` : ''}</td></tr>`,
    4,
    'No steps'
  );

  const anamRows = buildRows(
    s.anamHits,
    (h) =>
      `<tr><td>${esc(h.when)}</td><td>${esc(h.method)}</td><td>${h.status == null ? '' : esc(h.status)}</td>` +
      `<td>${h.outageActiveAtRequest ? 'outage' : 'healthy'}</td><td style="word-break:break-all">${esc(h.url)}</td></tr>`,
    5,
    mode === 'disabled' ? 'None detected (expected)' : 'No Anam HTTP requests captured'
  );

  const blockedRows = buildRows(
    s.anamBlockedRequests,
    (h) =>
      `<tr><td>${esc(h.when)}</td><td>${esc(h.type)}</td><td>${esc(h.method || '')}</td>` +
      `<td>${esc(h.outageMode || '')}</td><td style="word-break:break-all">${esc(h.url)}</td></tr>`,
    5,
    'No Anam traffic blocked'
  );

  const expectedErrRows = buildRows(
    s.expectedOutageErrors,
    (e) => `<tr><td>${esc(e.when)}</td><td>${esc(e.location || '')}</td><td style="word-break:break-all">${esc(e.text)}</td></tr>`,
    3,
    'None'
  );

  const unexpectedErrRows = buildRows(
    s.unexpectedConsoleErrors || s.consoleErrors,
    (e) => `<tr><td>${esc(e.when)}</td><td>${esc(e.location || '')}</td><td style="word-break:break-all">${esc(e.text)}</td></tr>`,
    3,
    'None'
  );

  const autoCompleteRows = buildRows(
    s.autoCompletedActivities,
    (e) => `<tr><td>${esc(e.when)}</td><td>${esc(e.activityId)}</td><td>${esc(e.status)}</td><td>${esc(e.reason)}</td></tr>`,
    4,
    'No browser activity required API cleanup'
  );

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Anam Resilience Validation</title>
<style>
body{font-family:-apple-system,Segoe UI,Arial,sans-serif;margin:32px;color:#1a1a1a}
h1{margin-bottom:4px}.badge{display:inline-block;padding:4px 14px;border-radius:6px;color:#fff;background:${color};font-weight:700}
table{border-collapse:collapse;width:100%;margin:12px 0 28px;font-size:13px}
th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f4f4}
.meta td{border:none;padding:2px 6px 2px 0}.empty{color:#777;font-style:italic}.yes{color:#0a7d2c;font-weight:600}.no{color:#b3261e;font-weight:600}
</style></head><body>
<h1>Anam Resilience Validation &nbsp;<span class="badge">${esc(s.overallResult)}</span></h1>
<table class="meta">
<tr><td><b>Candidate URL</b></td><td>${esc(s.candidateUrl)}</td></tr>
<tr><td><b>ANAM_MODE</b></td><td>${esc(mode)}</td></tr>
<tr><td><b>Talent Intelligence enabled</b></td><td>${esc(s.anumApiEnabled)}</td></tr>
<tr><td><b>Started</b></td><td>${esc(s.startedAt)}</td></tr>
<tr><td><b>Finished</b></td><td>${esc(s.finishedAt)}</td></tr>
<tr><td><b>Video</b></td><td>${s.videoPath ? esc(path.relative(runDir, s.videoPath)) : 'n/a'}</td></tr>
</table>

<h2>Mode assertions</h2>
<table><tr><th>Check</th><th>Value</th></tr>
<tr><td>Initial engine/session succeeded</td><td>${esc(checks.initialEngineSessionSucceeded)}</td></tr>
<tr><td>Initial metrics/client succeeded</td><td>${esc(checks.initialMetricsSucceeded)}</td></tr>
<tr><td>Outage activated</td><td>${esc(checks.outageActivated)}</td></tr>
<tr><td>Blocked Anam traffic</td><td>${esc(checks.blockedAnamTrafficCount)}</td></tr>
<tr><td>Outage recovered</td><td>${esc(checks.outageRecovered)}</td></tr>
<tr><td>Post-recovery Anam success</td><td>${esc(checks.postRecoveryAnamSuccess)}</td></tr>
<tr><td>Page crashed</td><td>${esc(checks.pageCrashed)}</td></tr>
<tr><td>Unexpected console errors</td><td>${esc(checks.unexpectedConsoleErrors)}</td></tr>
<tr><td>Expected outage errors</td><td>${esc(checks.expectedOutageErrors)}</td></tr>
<tr><td>Activities auto-completed after recovery</td><td>${esc(checks.autoCompletedActivities)}</td></tr>
</table>

<h2>Flow steps</h2>
<table><tr><th>Step</th><th>Status</th><th>Note</th><th>Screenshot</th></tr>${stepsRows}</table>

<h2>Anam HTTP requests observed</h2>
<table><tr><th>When</th><th>Method</th><th>Status</th><th>Phase</th><th>URL</th></tr>${anamRows}</table>

<h2>Traffic intentionally blocked during outage</h2>
<table><tr><th>When</th><th>Type</th><th>Method</th><th>Mode</th><th>URL</th></tr>${blockedRows}</table>

<h2>Expected outage console errors</h2>
<table><tr><th>When</th><th>Location</th><th>Message</th></tr>${expectedErrRows}</table>

<h2>Unexpected console/page errors</h2>
<table><tr><th>When</th><th>Location</th><th>Message</th></tr>${unexpectedErrRows}</table>

<h2>Browser activity cleanup after service recovery</h2>
<table><tr><th>When</th><th>Activity ID</th><th>HTTP status</th><th>Reason</th></tr>${autoCompleteRows}</table>
</body></html>`;

  const htmlPath = path.join(runDir, 'report.html');
  fs.writeFileSync(htmlPath, html);
  return htmlPath;
}

async function renderPdf(browser, htmlPath, runDir) {
  const pdfPath = path.join(runDir, 'report.pdf');
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath}`);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    margin: { top: '16px', bottom: '16px', left: '16px', right: '16px' }
  });
  await page.close();
  return pdfPath;
}

module.exports = { createRun, shot, writeEvidence, buildHtml, renderPdf };
