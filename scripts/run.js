#!/usr/bin/env node

// scripts/run.js
//
// Safe k6 runner for Windows/macOS/Linux.
// - loads project variables from .env
// - applies explicit CLI KEY=VALUE overrides
// - forwards only project configuration to k6
// - never forwards the entire operating-system environment as k6 -e flags
// - redacts secrets from command logs
// - validates optional InfluxDB output before starting the test

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const ENV_PATH = path.join(ROOT, '.env');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_KEY_RE = /(PASSWORD|TOKEN|SECRET|CREDENTIAL|API_KEY)/i;

if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

function readEnvFile(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;

  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) return;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid environment variable name in ${path.basename(filePath)}: ${key}`);
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  });
  return env;
}

function redact(key, value) {
  return SECRET_KEY_RE.test(key) && value ? '<redacted>' : value;
}

function validateBaseConfiguration(env) {
  const required = [
    'API_URL',
    'SUPER_ADMIN_URL',
    'CLIENT_ADMIN_URL',
    'CANDIDATE_URL',
    'SUPER_ADMIN_EMAIL',
    'SUPER_ADMIN_PASSWORD'
  ];
  const missing = required.filter((key) => !String(env[key] || '').trim());
  if (missing.length) {
    throw new Error(
      `Missing required .env values: ${missing.join(', ')}. ` +
      `Copy ${path.basename(ENV_EXAMPLE_PATH)} to .env and populate the real environment values.`
    );
  }

  for (const key of ['API_URL', 'SUPER_ADMIN_URL', 'CLIENT_ADMIN_URL', 'CANDIDATE_URL']) {
    try {
      new URL(env[key]);
    } catch (_) {
      throw new Error(`Invalid URL in ${key}: ${env[key] || '<empty>'}`);
    }
  }
}

function parseArguments(argv, env) {
  const k6PassThrough = [];
  let expectValue = false;

  for (const arg of argv) {
    if (expectValue) {
      k6PassThrough.push(arg);
      expectValue = false;
      continue;
    }

    if (arg === '--out' || arg === '-o') {
      k6PassThrough.push(arg);
      expectValue = true;
      continue;
    }

    if (arg.startsWith('-')) {
      k6PassThrough.push(arg);
      continue;
    }

    if (arg.includes('=') && !arg.endsWith('.js')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(0, eq);
      const value = arg.slice(eq + 1);
      if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid CLI environment variable name: ${key}`);
      env[key] = value;
      continue;
    }

    k6PassThrough.push(arg);
  }

  return k6PassThrough;
}

function findInfluxOutput(args) {
  for (let index = 0; index < args.length; index += 1) {
    if ((args[index] === '--out' || args[index] === '-o') && args[index + 1]) {
      const value = args[index + 1];
      if (value.startsWith('influxdb=')) return value.slice('influxdb='.length);
    }
  }
  return null;
}

function checkHttpEndpoint(urlString, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(urlString);
    } catch (_) {
      resolve({ ok: false, reason: `Invalid monitoring URL: ${urlString}` });
      return;
    }

    // InfluxDB v1 exposes /ping. Preserve the configured host/port/database URL
    // but probe only the server-level ping endpoint.
    target.pathname = '/ping';
    target.search = '';
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(target, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `Monitoring endpoint timed out after ${timeoutMs}ms` });
    });
    req.on('error', (error) => resolve({ ok: false, reason: error.message }));
    req.end();
  });
}

function ensureCommandAvailable(command) {
  const probe = spawnSync(command, ['version'], { shell: false, stdio: 'ignore' });
  if (probe.error || probe.status !== 0) {
    throw new Error(`${command} is not available on PATH. Install it before running this command.`);
  }
}

async function main() {
  if (!fs.existsSync(ENV_PATH)) {
    throw new Error(`Missing ${ENV_PATH}. Create it from .env.example before running tests.`);
  }

  const env = readEnvFile(ENV_PATH);
  const args = process.argv.slice(2);
  const scriptArgs = parseArguments(args, env);

  if (!scriptArgs.length || !scriptArgs.some((value) => value.endsWith('.js'))) {
    throw new Error('No k6 JavaScript entry file was provided to scripts/run.js.');
  }

  validateBaseConfiguration(env);
  ensureCommandAvailable('k6');

  const influxUrl = findInfluxOutput(scriptArgs);
  if (influxUrl) {
    const monitoring = await checkHttpEndpoint(influxUrl);
    if (!monitoring.ok) {
      throw new Error(
        `InfluxDB is not reachable at ${influxUrl}. Start monitoring first with "npm run monitoring:up". ` +
        `Probe result: ${monitoring.reason || `HTTP ${monitoring.status}`}`
      );
    }
  }

  const k6Args = ['run'];
  const printable = ['run'];
  Object.entries(env).forEach(([key, value]) => {
    k6Args.push('-e', `${key}=${value}`);
    printable.push('-e', `${key}=${redact(key, value)}`);
  });
  k6Args.push(...scriptArgs);
  printable.push(...scriptArgs);

  const mode = env.LOAD_MODE || 'smoke';
  const configuredVus = env.LOAD_VUS || '10';
  const effectiveVus = mode === 'load' ? configuredVus : '1';
  const iterations = mode === 'load' ? (env.LOAD_ITERATIONS_PER_VU || '1') : '1';
  const anam = env.ANUM_API_ENABLED || 'true';
  const invitations = String(env.SEND_PROJECT_INVITATIONS || 'false').toLowerCase() === 'true';
  const configuredPerformanceProfile = String(env.PERFORMANCE_PROFILE || 'auto').toLowerCase();
  const effectivePerformanceProfile = configuredPerformanceProfile === 'auto'
    ? (mode === 'load' ? 'baseline' : 'strict')
    : configuredPerformanceProfile;

  const verbose = String(env.RUNNER_VERBOSE || 'false').toLowerCase() === 'true';
  const entryFile = scriptArgs.find((value) => value.endsWith('.js')) || '<unknown>';
  console.log(
    `[runner] mode=${mode} vus=${effectiveVus} iterations_per_vu=${iterations} ` +
    `Anam=${anam} projectInvitations=${invitations} performance=${effectivePerformanceProfile} entry=${entryFile}`
  );
  console.log(
    `[runner] project environment loaded: ${Object.keys(env).length} key(s); ` +
    'operating-system variables are not forwarded to k6.'
  );
  if (verbose) {
    console.log(`[runner] k6 ${printable.join(' ')}`);
  }

  const child = spawn('k6', k6Args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });

  child.on('error', (error) => {
    console.error(`[runner] Failed to start k6: ${error.message}`);
    process.exit(2);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

main().catch((error) => {
  console.error(`[runner] ${error.message || error}`);
  process.exit(2);
});
