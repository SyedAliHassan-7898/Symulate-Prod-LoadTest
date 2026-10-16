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

const { parseFailedRequestLines } = require('../utils/failed-request-line');

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
  collectFailedRequests(output);
  writeFailuresSidecar();
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

// reports/failures-latest.json — per-request failures (status + message) for
// every phase of this run. Accumulated across phases; rewritten after each k6
// invocation so a crash still leaves a usable sidecar behind.
const failedRequests = [];

function collectFailedRequests(output) {
  // k6 v1/v2 wraps console output as `time=... level=info msg="[FAILED_REQUEST] {...}"`;
  // the util accepts both that envelope and the bare line (see
  // utils/failed-request-line.js).
  for (const record of parseFailedRequestLines(String(output).split(/\r?\n/))) {
    failedRequests.push(record);
  }
}

function writeFailuresSidecar() {
  try {
    const dir = path.join(ROOT, 'reports');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'failures-latest.json'),
      `${JSON.stringify(failedRequests, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    console.error(`[runner] Could not write reports/failures-latest.json: ${error.message}`);
  }
}

// ─── CLI argument parsing ───────────────────────────────────────────────────
//
// The runner used to honour only `--grafana`, so the documented
// `npm run load:shared:grafana` (which passes `--out influxdb=...` and
// `K6_INFLUXDB_PUSH_INTERVAL=3s`) silently did nothing: neither phase ever got
// an InfluxDB output. Now every npm-style argument is understood:
//   --grafana                 → InfluxDB output for both phases
//   --out <k6-output>         → forwarded verbatim to k6
//   KEY=VALUE                 → project env override (same as scripts/run.js)
//   --no-cleanup | --keep     → skip Phase 3 cleanup
//   --cleanup-only            → run Phase 3 only (cleanup leftovers)
// (ENV_KEY_RE is declared above, next to the k6() helper.)

function parseRunnerArgs(argv) {
  const parsed = {
    k6Args: [],
    envOverrides: {},
    grafana: false,
    cleanup: true,
    cleanupOnly: false,
    unknown: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--grafana') { parsed.grafana = true; continue; }
    if (arg === '--no-cleanup' || arg === '--keep') { parsed.cleanup = false; continue; }
    if (arg === '--cleanup-only') { parsed.cleanupOnly = true; continue; }

    if (arg === '--out' || arg === '-o') {
      const value = argv[index + 1];
      if (value) {
        parsed.k6Args.push(arg, value);
        if (value.startsWith('influxdb=')) parsed.grafana = true;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--out=') || arg.startsWith('-o=')) {
      parsed.k6Args.push(arg);
      if (arg.includes('influxdb=')) parsed.grafana = true;
      continue;
    }

    // KEY=VALUE — npm scripts pass these through as positional arguments.
    const eq = arg.indexOf('=');
    if (!arg.startsWith('-') && eq > 0 && ENV_KEY_RE.test(arg.slice(0, eq))) {
      parsed.envOverrides[arg.slice(0, eq)] = arg.slice(eq + 1);
      continue;
    }

    if (arg.startsWith('-')) { parsed.k6Args.push(arg); continue; }
    parsed.unknown.push(arg);
  }

  return parsed;
}

// ─── Ramp telemetry ─────────────────────────────────────────────────────────
//
// tests/shared-project-admin-candidate-load.js logs WORK_START / WORK_END per
// VU. Overlapping those windows gives the *real* number of concurrently
// executing VUs. k6's builtin `vus` gauge counts sleeping (still-staggering)
// VUs too, so it always reads the full VU count and cannot answer "how many
// users were really in flight".
function computePeakExecutingVus(output) {
  const events = [];
  const pattern = /\[([\d]{4}-[\d\-:.TZ]+)\][^\n]*?WORK_(START|END)\s+vu=(\d+)/g;
  let match = pattern.exec(String(output));
  while (match) {
    const time = Date.parse(match[1]);
    if (Number.isFinite(time)) {
      events.push({ time, type: match[2], vu: Number(match[3]) });
    }
    match = pattern.exec(String(output));
  }

  if (!events.length) return null;

  const endByVu = new Map();
  const startByVu = new Map();
  events.forEach((event) => {
    if (event.type === 'START') startByVu.set(event.vu, event.time);
    else endByVu.set(event.vu, event.time);
  });

  // Close windows whose VU never reached WORK_END (killed by maxDuration /
  // graceful stop) at the last observed event — dropping them would undercount.
  const lastTime = events.reduce((latest, event) => Math.max(latest, event.time), 0);
  startByVu.forEach((start, vu) => {
    if (!endByVu.has(vu)) endByVu.set(vu, Math.max(lastTime, start));
  });

  const sweep = [];
  startByVu.forEach((time) => sweep.push({ time, delta: 1 }));
  endByVu.forEach((time) => sweep.push({ time, delta: -1 }));
  // At identical timestamps close first so ties don't inflate the peak.
  sweep.sort((a, b) => (a.time - b.time) || (a.delta - b.delta));

  let active = 0;
  let peak = 0;
  sweep.forEach((point) => {
    active += point.delta;
    if (active > peak) peak = active;
  });

  return { peak, started: startByVu.size };
}

// k6 exits 99 on threshold breach; normalise it to 1 so both runners report the
// same documented pipeline exit codes (0 pass / 1 fail / 2 infra error).
function mapK6ExitCode(code) {
  if (code === null || code === undefined) return 1;
  return code === 99 ? 1 : code;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const fileEnv = readEnv();
  const runnerArgs = parseRunnerArgs(process.argv.slice(2));
  const enableGrafana = runnerArgs.grafana;

  if (runnerArgs.unknown.length) {
    console.warn(`[runner] Ignoring unrecognised argument(s): ${runnerArgs.unknown.join(' ')}`);
  }

  // Config — .env is the source of truth; KEY=VALUE arguments (npm script
  // pass-throughs such as `NUM_CANDIDATES=150`) override it.
  const env = { ...fileEnv, ...runnerArgs.envOverrides };

  const NUM_CANDIDATES    = Number(env.NUM_CANDIDATES    || 10);
  const LOAD_VUS          = Number(env.LOAD_VUS          || 10);
  const LOAD_MAX_DURATION =        env.LOAD_MAX_DURATION || '10m';
  const PHASE_GAP_SECONDS = Math.max(0, Number(env.LOAD_TEST_PHASE_GAP_SECONDS || 65));
  const INITIAL_GAP_SECONDS = Math.max(0, Number(env.LOAD_TEST_INITIAL_GAP_SECONDS || 65));

  console.log('\n============================================================');
  console.log(`Shared-Project Load Test`);
  console.log(`  NUM_CANDIDATES = ${NUM_CANDIDATES}  (project provisioning)`);
  console.log(`  LOAD_VUS       = ${LOAD_VUS}  (concurrent assessment VUs)`);
  console.log(`  MAX_DURATION   = ${LOAD_MAX_DURATION}`);
  if (enableGrafana) {
    console.log(`  GRAFANA        = ENABLED (live metrics for both phases)`);
  }
  console.log(`  CLEANUP        = ${cleanupEnabled() ? 'ON — Phase 3 deletes this run\'s org/project/candidates' : 'OFF — resources kept (ENABLE_TEARDOWN=false or --no-cleanup)'}`);
  console.log('============================================================\n');

  // ── Phase 3 helpers (cleanup) ─────────────────────────────────────────────
  //
  // The shared runner used to force ENABLE_TEARDOWN=false in Phase 1 and never
  // delete anything afterwards, so every run leaked one org, one project and
  // NUM_CANDIDATES candidates into the environment.
  function cleanupEnabled() {
    if (!runnerArgs.cleanup) return false;
    return String(env.ENABLE_TEARDOWN ?? 'true').trim().toLowerCase() !== 'false';
  }

  async function runCleanupPhase({ projectId, orgId, hrefsTmpPath }) {
    if (!cleanupEnabled()) {
      console.warn(
        '[cleanup] SKIPPED — ENABLE_TEARDOWN=false (or --no-cleanup). ' +
        'The organisation, project and candidates from this run remain in the environment.'
      );
      return true;
    }
    if (!projectId && !orgId) {
      console.warn('[cleanup] SKIPPED — no org/project id available to delete.');
      return false;
    }

    console.log('\n=== Phase 3/3 — k6: delete project, org and candidates ===\n');

    const cleanupEnv = {
      ...env,
      SHARED_PROJECT_ID: projectId || '',
      SHARED_ORG_ID:     orgId || ''
    };
    if (hrefsTmpPath && fs.existsSync(hrefsTmpPath)) {
      cleanupEnv.SHARED_CANDIDATE_HREFS_FILE = hrefsTmpPath;
    }

    const cleanup = k6('tests/shared-project-teardown.js', cleanupEnv, []);
    const ok = cleanup.code === 0;
    if (ok) {
      console.log('[cleanup] OK — this run left no data behind.');
    } else {
      console.error(
        '[cleanup] FAILED — some resources may remain in the environment. ' +
        'Re-run with: npm run cleanup:shared SHARED_PROJECT_ID=<id> SHARED_ORG_ID=<id>'
      );
    }
    return ok;
  }

  // --cleanup-only: operator-driven sweep of leftovers from an earlier run.
  if (runnerArgs.cleanupOnly) {
    const cleanupOk = await runCleanupPhase({
      projectId: env.SHARED_PROJECT_ID || '',
      orgId:     env.SHARED_ORG_ID || '',
      hrefsTmpPath: null
    });
    process.exit(cleanupOk ? 0 : 1);
  }

  // ── PHASE 1: provision one project with all candidates ─────────────────────
  console.log('=== Phase 1/3 — k6: provision shared project + candidates ===\n');

  // Clear requests from earlier local runs; the IP limiter bucket is shared
  // across scripts and does not reset when a new k6 process starts.
  if (INITIAL_GAP_SECONDS > 0) {
    console.log(`Waiting ${INITIAL_GAP_SECONDS}s for the previous rate-limit window to clear...`);
    await new Promise((resolve) => setTimeout(resolve, INITIAL_GAP_SECONDS * 1000));
  }

  const phase1Env = {
    ...env,
    LOAD_MODE:                  'smoke',
    LOAD_VUS:                   '1',
    LOAD_ITERATIONS_PER_VU:     '1',
    NUM_CANDIDATES:             String(NUM_CANDIDATES),
    SEND_PROJECT_INVITATIONS:   'true',
    SEND_CLIENT_EMAIL:          'false',
    // Do not multiply setup traffic after a 429; size the staging limiter for
    // the planned capacity test and keep throttling tests separate.
    HTTP_429_MAX_RETRIES:       env.HTTP_429_MAX_RETRIES || '0',
    CANDIDATE_EXECUTION_SOURCE: 'none',    // provision only — no candidate runs
    ENABLE_TEARDOWN:            'false',   // keep resources for Phase 2 (Phase 3 deletes them)
    E2E_EMIT_SESSION_SECRETS:   'false'    // links are parsed from the invitation response; don't emit raw tokens
  };

  // InfluxDB output args, shared by Phase 1 and Phase 2. Previously only
  // Phase 1 received them and only with the `--grafana` flag, so the documented
  // `npm run load:shared:grafana` produced no live metrics at all.
  const hasExplicitOut = runnerArgs.k6Args.includes('--out') || runnerArgs.k6Args.includes('-o');
  const grafanaArgs = [...runnerArgs.k6Args];
  if (enableGrafana && !hasExplicitOut) {
    grafanaArgs.push('--out', 'influxdb=http://localhost:8087/k6');
  }
  if (grafanaArgs.length && !env.K6_INFLUXDB_PUSH_INTERVAL) {
    phase1Env.K6_INFLUXDB_PUSH_INTERVAL = '3s';
  }

  const phase1 = k6('tests/smoke-no-anum-setup.js', phase1Env, grafanaArgs);

  if (phase1.code !== 0) {
    // Phase 1 may have created the org/project before failing — still try to
    // clean up below if we could parse their ids.
    console.error('\nPhase 1 failed.\n');
  }

  // Parse outputs
  const projectId = parseVar(phase1.out, 'NOANUMTEST_PROJECT_ID');
  const orgId     = parseVar(phase1.out, 'NOANUMTEST_ORG_ID');
  const auditHrefsB64 = parseVar(phase1.out, 'NOANUMTEST_AUDIT_INVITATION_HREFS');

  if (phase1.code !== 0) {
    // Phase 1 can create the org/project and *then* fail (threshold breach,
    // 429 storm, missing hrefs). Clean up whatever it managed to create so a
    // failed provisioning run doesn't leak data either.
    await runCleanupPhase({ projectId, orgId, hrefsTmpPath: null });
    console.error('\nPhase 1 failed. Aborting.\n');
    process.exit(mapK6ExitCode(phase1.code));
  }

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
  console.log('\n=== Phase 2/3 — k6:  concurrent candidate assessments ===\n');

  const actualVUs = Math.min(LOAD_VUS, candidateCount);
  if (actualVUs < LOAD_VUS) {
    console.warn(`Note: Only ${candidateCount} candidates provisioned; using ${actualVUs} VUs.`);
  }

  const startIntervalSeconds = env.LOAD_VU_START_INTERVAL_SECONDS || '1.5';
  const phase2Env = {
    ...env,
    SHARED_PROJECT_ID:            projectId,
    SHARED_ORG_ID:                orgId || '',     // for admin portal calls
    SHARED_CANDIDATE_HREFS_FILE:  hrefsTmpPath,
    LOAD_VUS:                     String(actualVUs),
    LOAD_MAX_DURATION,
    // Invitations were sent in Phase 1 to obtain candidate links.
    SEND_PROJECT_INVITATIONS: 'false',
    SEND_CLIENT_EMAIL:        'false',
    ENFORCE_BOOKING:          env.ENFORCE_BOOKING || 'false',
    // Keep 429s visible instead of amplifying them with retries. Capacity
    // tests should tune the staging limiter separately from abuse tests.
    HTTP_429_MAX_RETRIES: env.HTTP_429_MAX_RETRIES || '0',
    // Read by the test — this is what actually paces the ramp.
    LOAD_VU_START_INTERVAL_SECONDS: startIntervalSeconds,
    ANUM_API_ENABLED:         env.ANUM_API_ENABLED || 'false',
    ANAM_MODE:                env.ANAM_MODE || 'disabled'
  };
  if (grafanaArgs.length && !env.K6_INFLUXDB_PUSH_INTERVAL) {
    phase2Env.K6_INFLUXDB_PUSH_INTERVAL = '3s';
  }

  console.log(`  RAMP: VU start interval = ${startIntervalSeconds}s (LOAD_VU_START_INTERVAL_SECONDS)`);

  const phase2 = k6('tests/shared-project-admin-candidate-load.js', phase2Env, grafanaArgs);

  // ── Ramp telemetry ────────────────────────────────────────────────────────
  // Report measured concurrency instead of inferring it from the ramp formula.
  const ramp = computePeakExecutingVus(phase2.out);
  if (ramp) {
    const interval = Number(startIntervalSeconds);
    const scheduledSpan = Number.isFinite(interval) ? `${(interval * Math.max(0, ramp.started - 1)).toFixed(0)}s` : 'n/a';
    console.log(`\n[peak] executing VUs: peak=${ramp.peak} of ${ramp.started} started (ramp span ~${scheduledSpan})`);
    console.log(`PEAK_CONCURRENT_VUS=${ramp.peak} STARTED_VUS=${ramp.started}`);
    console.log(
      '[peak] NOTE — k6\'s builtin "vus" metric counts staggered VUs that are only sleeping; ' +
      'use this measured number for capacity claims.'
    );
  } else {
    console.warn('[peak] WORK_START/WORK_END telemetry not found in Phase 2 output; peak concurrency unavailable.');
  }

  // ── PHASE 3: cleanup ──────────────────────────────────────────────────────
  const cleanupOk = await runCleanupPhase({ projectId, orgId, hrefsTmpPath });

  // Cleanup temp file
  try { fs.unlinkSync(hrefsTmpPath); } catch (_) {}

  const phase2Failed = phase2.code !== 0;
  const finalCode = phase2Failed || !cleanupOk ? 1 : 0;
  console.log(
    `\n=== All phases complete — Phase1=${phase1.code}, Phase2=${phase2.code}, ` +
    `cleanup=${cleanupOk ? 'ok' : 'FAILED'}, final=${finalCode} ===`
  );
  if (phase2Failed && !cleanupOk) {
    console.error('Both the load test and the cleanup failed — check the output above for leftovers.');
  } else if (phase2Failed) {
    console.error('Load test failed (threshold breach or runtime error); cleanup still ran.');
  } else if (!cleanupOk) {
    console.error('Load test passed but cleanup failed — data from this run may remain in the environment.');
  }
  process.exit(finalCode);
}

// Exported for tests / ad-hoc inspection (scripts/run-shared-project-load.js
// stays a CLI entry point when invoked directly).
module.exports = {
  parseRunnerArgs,
  computePeakExecutingVus,
  mapK6ExitCode
};

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e);
    process.exit(2);
  });
}
