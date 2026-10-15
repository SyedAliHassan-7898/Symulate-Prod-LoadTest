#!/usr/bin/env node
// scripts/run-shared-project-load.js
//
// Automated 2-phase shared-project load test:
//
//   Phase 1 — k6 provisions one project with NUM_CANDIDATES candidates,
//              collects all invitation hrefs, prints them as base64 JSON.
//
//   Phase 2 — k6 runs LOAD_VUS concurrent VUs, each logging in via their
//              invitation href and performing all assigned activities against
//              the SAME shared project.
//
// Usage:
//   node scripts/run-shared-project-load.js
//   npm run load:shared

'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const ENVFILE = path.join(ROOT, '.env');

// ─── Helpers ────────────────────────────────────────────────────────────────

function readEnv() {
  const env = {};
  if (!fs.existsSync(ENVFILE)) return env;
  fs.readFileSync(ENVFILE, 'utf-8').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const sep = line.indexOf('=');
    if (sep === -1) return;
    const key = line.slice(0, sep).trim();
    let val = line.slice(sep + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  });
  return env;
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function k6(script, env, extraArgs = []) {
  const args = ['run'];
  const MAX_ARG_LEN = 4000;
  const tempFiles = [];
  const safeEnv = { ...env };

  // Write oversized values to temp files (avoids Windows ENAMETOOLONG)
  for (const key of Object.keys(safeEnv)) {
    if (safeEnv[key] && String(safeEnv[key]).length > MAX_ARG_LEN) {
      const tmp = path.join(require('os').tmpdir(), `k6-${key}-${Date.now()}.txt`);
      fs.writeFileSync(tmp, String(safeEnv[key]), 'utf-8');
      safeEnv[`${key}_FILE`] = tmp;
      delete safeEnv[key];
      tempFiles.push(tmp);
    }
  }

  Object.entries(safeEnv).forEach(([k, v]) => {
    if (v == null) return;
    if (!ENV_KEY_RE.test(k)) return; // skip invalid keys silently
    args.push('-e', `${k}=${v}`);
  });
  
  // Add extra args (like Grafana output)
  args.push(...extraArgs);

  args.push(script);
  console.log(`\n>>> k6 run ${script} (${Object.keys(safeEnv).length} env keys${extraArgs.length ? ' + ' + extraArgs.length + ' extra args' : ''})\n`);

  const result = spawnSync('k6', args, {
    cwd: ROOT,
    stdio: [null, 'pipe', 'pipe'],
    shell: false,
    encoding: 'utf-8'
  });

  for (const tmp of tempFiles) { try { fs.unlinkSync(tmp); } catch (_) {} }

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  process.stdout.write(redactSessionSecrets(output));
  if (result.error) console.error(`k6 spawn error: ${result.error.message}`);
  return { code: result.status == null ? 1 : result.status, out: output };
}

// Parse Phase 1 outputs — handles both plain KEY=VALUE and k6 log-wrapped KEY=VALUE
function parseVar(output, key) {
  // Try plain match first
  const m = output.match(new RegExp(`\\b${key}\\s*=\\s*([^\\s"\\n]+)`));
  return m ? m[1] : null;
}

// Parse long base64 values that may be inside k6 log msg="..." wrappers
function parseLongVar(output, key) {
  // Matches: KEY=<anything up to end of line or closing quote>
  const patterns = [
    new RegExp(`${key}=([A-Za-z0-9+/=]+)`),      // plain base64
    new RegExp(`${key}=([^\\s"\\n\\\\]+)`)          // general non-whitespace
  ];
  for (const pat of patterns) {
    const m = output.match(pat);
    if (m && m[1] && m[1].length > 10) return m[1];
  }
  return null;
}

// Invitation hrefs contain bearer credentials. Keep raw output in memory for
// parsing, but never print those credentials to the terminal/log file.
function redactSessionSecrets(output) {
  return String(output)
    .replace(/(NOANUMTEST_CANDIDATE_INVITATION_HREF=)[^\s"\\]+/g, '$1<redacted>')
    .replace(/(NOANUMTEST_AUDIT_INVITATION_HREFS=)[A-Za-z0-9+/=]+/g, '$1<redacted>')
    .replace(/(CANDIDATE_ACCESS_TOKEN=)[^\s"\\]+/g, '$1<redacted>')
    .replace(/(CANDIDATE_REFRESH_TOKEN=)[^\s"\\]+/g, '$1<redacted>');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const fileEnv = readEnv();
  
  // Check for --grafana flag
  const enableGrafana = process.argv.includes('--grafana');

  // Config — always read from .env file; cross-env / npm script defaults are ignored
  const NUM_CANDIDATES    = Number(fileEnv.NUM_CANDIDATES    || 10);
  const LOAD_VUS          = Number(fileEnv.LOAD_VUS          || 10);
  const LOAD_MAX_DURATION =        fileEnv.LOAD_MAX_DURATION || '10m';
  const PHASE_GAP_SECONDS = Math.max(0, Number(fileEnv.LOAD_TEST_PHASE_GAP_SECONDS || 65));
  const INITIAL_GAP_SECONDS = Math.max(0, Number(fileEnv.LOAD_TEST_INITIAL_GAP_SECONDS || 65));

  console.log('\n============================================================');
  console.log(`Shared-Project Load Test`);
  console.log(`  NUM_CANDIDATES = ${NUM_CANDIDATES}  (project provisioning)`);
  console.log(`  LOAD_VUS       = ${LOAD_VUS}  (concurrent assessment VUs)`);
  console.log(`  MAX_DURATION   = ${LOAD_MAX_DURATION}`);
  if (enableGrafana) {
    console.log(`  GRAFANA        = ENABLED (live monitoring)`);
  }
  console.log('============================================================\n');

  // ── PHASE 1: provision one project with all candidates ─────────────────────
  console.log('=== Phase 1/2 — k6: provision shared project + candidates ===\n');

  // Clear requests from earlier local runs; the IP limiter bucket is shared
  // across scripts and does not reset when a new k6 process starts.
  if (INITIAL_GAP_SECONDS > 0) {
    console.log(`Waiting ${INITIAL_GAP_SECONDS}s for the previous rate-limit window to clear...`);
    await new Promise((resolve) => setTimeout(resolve, INITIAL_GAP_SECONDS * 1000));
  }

  const phase1Env = {
    ...fileEnv,
    LOAD_MODE:                  'smoke',
    LOAD_VUS:                   '1',
    LOAD_ITERATIONS_PER_VU:     '1',
    NUM_CANDIDATES:             String(NUM_CANDIDATES),
    SEND_PROJECT_INVITATIONS:   'true',
    SEND_CLIENT_EMAIL:          'false',
    // Do not multiply setup traffic after a 429; size the staging limiter for
    // the planned capacity test and keep throttling tests separate.
    HTTP_429_MAX_RETRIES:       fileEnv.HTTP_429_MAX_RETRIES || '0',
    CANDIDATE_EXECUTION_SOURCE: 'none',    // provision only — no candidate runs
    ENABLE_TEARDOWN:            'false',   // keep resources for Phase 2
    E2E_EMIT_SESSION_SECRETS:   'false'    // links are parsed from the invitation response; don't emit raw tokens
  };
  
  // Grafana output args for both phases
  const grafanaArgs = enableGrafana 
    ? ['--out', 'influxdb=http://localhost:8087/k6', '-e', 'K6_INFLUXDB_PUSH_INTERVAL=3s']
    : [];

  const phase1 = k6('tests/smoke-no-anum-setup.js', phase1Env, grafanaArgs);

  if (phase1.code !== 0) {
    console.error('\nPhase 1 failed. Aborting.\n');
    process.exit(phase1.code || 1);
  }

  // Parse outputs
  const projectId = parseVar(phase1.out, 'NOANUMTEST_PROJECT_ID');
  const orgId     = parseVar(phase1.out, 'NOANUMTEST_ORG_ID');
  const auditHrefsB64 = parseVar(phase1.out, 'NOANUMTEST_AUDIT_INVITATION_HREFS');

  if (!projectId) {
    console.error('Could not parse NOANUMTEST_PROJECT_ID from Phase 1 output.');
    process.exit(1);
  }

  // Decode hrefs map to get all candidate hrefs (including browser candidate)
  let allHrefs = {};
  try {
    if (auditHrefsB64 && auditHrefsB64 !== 'FETCH_FAILED') {
      allHrefs = JSON.parse(Buffer.from(auditHrefsB64, 'base64').toString('utf-8'));
    }
  } catch (e) {
    console.error(`Failed to decode NOANUMTEST_AUDIT_INVITATION_HREFS: ${e.message}`);
  }

  // Also try to get browser candidate href
  const browserHref = parseVar(phase1.out, 'NOANUMTEST_CANDIDATE_INVITATION_HREF');
  const browserCandidateId = parseVar(phase1.out, 'NOANUMTEST_CANDIDATE_ID');
  if (browserHref && browserCandidateId && browserHref !== 'FETCH_FAILED') {
    allHrefs[browserCandidateId] = browserHref;
  }

  // Filter to candidateId-keyed entries only (exclude email duplicates)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const candidateHrefs = {};
  for (const [k, v] of Object.entries(allHrefs)) {
    if (uuidRe.test(k)) candidateHrefs[k] = v;
  }

  const candidateCount = Object.keys(candidateHrefs).length;
  console.log(`\nPhase 1 complete:`);
  console.log(`  Project ID  : ${projectId}`);
  console.log(`  Candidates  : ${candidateCount} hrefs captured`);

  if (candidateCount === 0) {
    console.error('No candidate hrefs captured from Phase 1. Cannot run Phase 2.');
    process.exit(1);
  }

  // Write hrefs to a temp file — base64 string is too long for k6 -e flag on Windows
  const hrefsB64 = Buffer.from(JSON.stringify(candidateHrefs)).toString('base64');
  const hrefsTmpPath = require('path').join(require('os').tmpdir(), `shared-hrefs-${Date.now()}.b64`);
  fs.writeFileSync(hrefsTmpPath, hrefsB64, 'utf-8');
  console.log(`  Hrefs file  : ${hrefsTmpPath}`);

  // Phase 1 shares the same source IP and global limiter bucket as Phase 2.
  // Let that window expire before measuring candidate/admin traffic.
  if (PHASE_GAP_SECONDS > 0) {
    console.log(`\nWaiting ${PHASE_GAP_SECONDS}s for the provisioning rate-limit window to clear...`);
    await new Promise((resolve) => setTimeout(resolve, PHASE_GAP_SECONDS * 1000));
  }

  // ── PHASE 2: concurrent VUs perform activities ───────────────────────────
  console.log('\n=== Phase 2/2 — k6:  concurrent candidate assessments ===\n');

  const actualVUs = Math.min(LOAD_VUS, candidateCount);
  if (actualVUs < LOAD_VUS) {
    console.warn(`Note: Only ${candidateCount} candidates provisioned; using ${actualVUs} VUs.`);
  }

  const phase2Env = {
    ...fileEnv,
    SHARED_PROJECT_ID:            projectId,
    SHARED_ORG_ID:                orgId || '',     // for admin portal calls
    SHARED_CANDIDATE_HREFS_FILE:  hrefsTmpPath,
    LOAD_VUS:                     String(actualVUs),
    LOAD_MAX_DURATION,
    // Invitations were sent in Phase 1 to obtain candidate links.
    SEND_PROJECT_INVITATIONS: 'false',
    SEND_CLIENT_EMAIL:        'false',
    ENFORCE_BOOKING:          fileEnv.ENFORCE_BOOKING || 'false',
    // Keep 429s visible instead of amplifying them with retries. Capacity
    // tests should tune the staging limiter separately from abuse tests.
    HTTP_429_MAX_RETRIES: fileEnv.HTTP_429_MAX_RETRIES || '0',
    LOAD_VU_START_INTERVAL_SECONDS: fileEnv.LOAD_VU_START_INTERVAL_SECONDS || '1.5',
    ANUM_API_ENABLED:         fileEnv.ANUM_API_ENABLED || 'false',
    ANAM_MODE:                fileEnv.ANAM_MODE || 'disabled'
  };

  const phase2 = k6('tests/shared-project-admin-candidate-load.js', phase2Env);

  // Cleanup temp file
  try { fs.unlinkSync(hrefsTmpPath); } catch (_) {}

  // Generate CSV reports automatically
  console.log('\n=== Generating CSV reports ===\n');
  try {
    const reportGenScript = path.join(ROOT, 'scripts', 'generate-csv-report.js');
    const reportResult = spawnSync('node', [reportGenScript], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false
    });
    if (reportResult.status === 0) {
      console.log('\n✓ CSV reports generated successfully');
    } else {
      console.warn('\n⚠ CSV report generation failed (non-fatal)');
    }
  } catch (err) {
    console.warn(`⚠ Could not generate CSV reports: ${err.message}`);
  }

  // Generate Professional HTML report automatically
  console.log('\n=== Generating Professional HTML Report ===\n');
  try {
    const professionalReportScript = path.join(ROOT, 'scripts', 'generate-professional-report.js');
    const htmlReportResult = spawnSync('node', [professionalReportScript], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false
    });
    if (htmlReportResult.status === 0) {
      console.log('\n✓ Professional HTML report generated successfully');
    } else {
      console.warn('\n⚠ Professional HTML report generation failed (non-fatal)');
    }
  } catch (err) {
    console.warn(`⚠ Could not generate professional HTML report: ${err.message}`);
  }

  const finalCode = phase2.code !== 0 ? 1 : 0;
  console.log(`\n=== All phases complete — Phase1=${phase1.code}, Phase2=${phase2.code}, final=${finalCode} ===`);
  process.exit(finalCode);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(2);
});
