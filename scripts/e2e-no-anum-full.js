#!/usr/bin/env node

// scripts/e2e-no-anum-full.js
//
// One command, three phases:
//   1) k6 setup (org/project/candidates)
//   2) k6 backend session-token audit using dedicated candidates
//   3) Playwright browser validation / Anam resilience scenario
//
// Supported modes:
//   ANAM_MODE=disabled   -> Talent Intelligence off, expect zero Anam calls
//   ANAM_MODE=healthy    -> Talent Intelligence on, Anam stays reachable
//   ANAM_MODE=outage503  -> Anam starts healthy, then subsequent HTTP gets 503
//   ANAM_MODE=network    -> Anam starts healthy, then requests are network-aborted

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENVFILE = path.join(ROOT, '.env');

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DRY_RUN = String(process.env.E2E_RUNNER_DRY_RUN || 'false').toLowerCase() === 'true';

const VALID_MODES = new Set([
  'disabled',
  'healthy',
  'outage503',
  'network'
]);

const REQUIRED_BASE_ENV = [
  'API_URL',
  'SUPER_ADMIN_URL',
  'CLIENT_ADMIN_URL',
  'CANDIDATE_URL',
  'SUPER_ADMIN_EMAIL',
  'SUPER_ADMIN_PASSWORD'
];

function readEnv() {
  const env = {};

  if (!fs.existsSync(ENVFILE)) {
    return env;
  }

  fs.readFileSync(ENVFILE, 'utf-8')
    .split(/\r?\n/)
    .forEach((rawLine) => {
      const line = rawLine.trim();

      if (!line || line.startsWith('#')) {
        return;
      }

      const separatorIndex = line.indexOf('=');

      if (separatorIndex === -1) {
        return;
      }

      const key = line.slice(0, separatorIndex).trim();

      let value = line.slice(separatorIndex + 1).trim();

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

function validateBaseEnv(fileEnv) {
  if (!fs.existsSync(ENVFILE)) {
    throw new Error(
      [
        `Missing ${ENVFILE}.`,
        '',
        'Copy your working .env into the project root.',
        'Do not use .env.example unless the real URLs and credentials are filled in.'
      ].join(' ')
    );
  }

  /*
   * .env provides the normal project configuration.
   *
   * process.env is applied afterwards so command-line overrides such as:
   *
   *   cross-env ANAM_MODE=outage503 ...
   *
   * still take precedence.
   */
  // Only values declared in the project .env are forwarded to k6. Apply
  // process-level overrides for those project keys plus the Anam mode selected
  // by the npm command. Never merge the complete Windows/OS environment here:
  // names such as CommonProgramFiles(x86) are invalid k6 -e variable names.
  const merged = { ...fileEnv };
  const overrideKeys = new Set([
    ...Object.keys(fileEnv),
    'ANAM_MODE',
    'ANUM_API_ENABLED',
    'SIMULATE_ANAM_MID_SESSION_OUTAGE',
    'ANAM_OUTAGE_MODE',
    'ANAM_OUTAGE_AUTO_RECOVER',
    'ANAM_OUTAGE_RECOVER_AFTER_MS',
    'OUTAGE_AUTO_COMPLETE_ACTIVITY',
    'ANAM_REQUIRE_POST_RECOVERY_RETRY',
    'HEADLESS',
    'STEP_TIMEOUT_MS',
    'TIMER_MAX_WAIT_MIN',
    'MAX_ACTIVITIES',
    'PLAYWRIGHT_MICROPHONE_MODE',
    'SEND_PROJECT_INVITATIONS'
  ]);
  overrideKeys.forEach((key) => {
    if (process.env[key] !== undefined) merged[key] = process.env[key];
  });

  const missing = REQUIRED_BASE_ENV.filter((key) => {
    return !String(merged[key] || '').trim();
  });

  if (missing.length > 0) {
    throw new Error(
      [
        'Missing required environment values:',
        missing.join(', '),
        '',
        `Update ${ENVFILE} before running the E2E suite.`
      ].join(' ')
    );
  }

  const urlKeys = [
    'API_URL',
    'SUPER_ADMIN_URL',
    'CLIENT_ADMIN_URL',
    'CANDIDATE_URL'
  ];

  for (const key of urlKeys) {
    try {
      new URL(merged[key]);
    } catch (_) {
      throw new Error(
        `Invalid URL in ${key}: ${merged[key] || '<empty>'}`
      );
    }
  }

  return merged;
}

function resolveMode(env) {
  const raw = String(
    process.env.ANAM_MODE ||
    env.ANAM_MODE ||
    'disabled'
  )
    .trim()
    .toLowerCase();

  if (!VALID_MODES.has(raw)) {
    throw new Error(
      `Unsupported ANAM_MODE=${raw}. ` +
      'Use disabled | healthy | outage503 | network.'
    );
  }

  return raw;
}

function isAnamEnabled(mode) {
  return mode !== 'disabled';
}

function redactValue(key, value) {
  if (
    /PASSWORD|TOKEN|SECRET|CREDENTIAL|API_KEY/i.test(key)
  ) {
    return value ? '<redacted>' : '';
  }

  return value;
}

function redactSensitiveOutput(output) {
  return String(output || '')
    .replace(/(CANDIDATE_ACCESS_TOKEN\s*=\s*)([^\s"\n]+)/g, '$1<redacted>')
    .replace(/(CANDIDATE_REFRESH_TOKEN\s*=\s*)([^\s"\n]+)/g, '$1<redacted>')
    .replace(/(Authorization:\s*Bearer\s+)([^\s"\n]+)/gi, '$1<redacted>');
}

function k6(script, baseEnv, extra = {}) {
  const env = {
    ...baseEnv,
    ...extra
  };

  const args = ['run'];

  Object.entries(env).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Refusing to forward invalid k6 environment variable name: ${key}`);
    }

    args.push('-e', `${key}=${value}`);
  });

  args.push(script);

  /*
   * Print the command but redact credentials/tokens.
   */
  const printable = ['run'];

  Object.entries(env).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }

    printable.push(
      '-e',
      `${key}=${redactValue(key, value)}`
    );
  });

  printable.push(script);

  const verbose = String(env.RUNNER_VERBOSE || 'false').toLowerCase() === 'true';
  console.log(`\n>>> k6 run ${script} (${Object.keys(env).length} project env keys; secrets redacted)\n`);
  if (verbose) {
    console.log(`[E2E runner] k6 ${printable.join(' ')}`);
  }

  /*
   * shell:false:
   * - avoids DEP0190
   * - avoids shell quoting problems
   * - prevents credentials from being interpreted by cmd.exe
   */
  const result = spawnSync(
    'k6',
    args,
    {
      cwd: ROOT,
      stdio: [
        'inherit',
        'pipe',
        'pipe'
      ],
      shell: false,
      encoding: 'utf-8'
    }
  );

  const output =
    `${result.stdout || ''}${result.stderr || ''}`;

  process.stdout.write(redactSensitiveOutput(output));

  if (result.error) {
    console.error(
      `Unable to run k6: ${result.error.message}`
    );
  }

  return {
    code:
      result.status === null ||
      result.status === undefined
        ? 1
        : result.status,
    out: output
  };
}

function parseVars(output) {
  const vars = {};

  let match;

  /*
   * Quotes are excluded but commas are allowed.
   *
   * This is required for:
   *
   * NOANUMTEST_AUDIT_CANDIDATE_IDS=id1,id2,id3,...
   */
  const regex =
    /(NOANUMTEST_[A-Z_]+)\s*=\s*([^\s"\n]+)/g;

  while ((match = regex.exec(output))) {
    vars[match[1]] = match[2];
  }

  return vars;
}

function parseToken(output) {
  const match = output.match(
    /CANDIDATE_ACCESS_TOKEN=(eyJ[A-Za-z0-9._-]+)/
  );

  return match
    ? match[1]
    : null;
}

function parseSessionVars(output) {
  const pick = (key) => {
    const match = output.match(
      new RegExp(
        `${key}\\s*=\\s*([^\\s"\\n]+)`
      )
    );

    return match
      ? match[1].replace(/"$/, '')
      : '';
  };

  return {
    CANDIDATE_REFRESH_TOKEN:
      pick('CANDIDATE_REFRESH_TOKEN'),

    CANDIDATE_ORG_ID:
      pick('CANDIDATE_ORG_ID'),

    CANDIDATE_PARENT_ORG_ID:
      pick('CANDIDATE_PARENT_ORG_ID')
  };
}

function runPlaywright(env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        'playwright/no-anum-e2e-validation.js'
      ],
      {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
        env
      }
    );

    child.on('error', (error) => {
      console.error(
        `Unable to start Playwright validation: ${error.message}`
      );

      resolve(2);
    });

    child.on('exit', (code) => {
      resolve(
        code === null ||
        code === undefined
          ? 1
          : code
      );
    });
  });
}

async function main() {
  /*
   * ---------------------------------------------------------
   * Load + validate .env
   * ---------------------------------------------------------
   */

  const fileEnv = readEnv();

  const mergedEnv =
    validateBaseEnv(fileEnv);

  const mode =
    resolveMode(mergedEnv);

  const anamEnabled =
    isAnamEnabled(mode);

  // `mergedEnv` contains project configuration only; operating-system and npm
  // environment variables are intentionally excluded from k6 -e arguments.
  const shared = {
    ...mergedEnv,
    ANAM_MODE: mode,
    ANUM_API_ENABLED: anamEnabled ? 'true' : 'false'
  };

  const invitationsEnabled = String(shared.SEND_PROJECT_INVITATIONS || 'false').toLowerCase() === 'true';
  const configuredCandidateCount = Number(shared.NUM_CANDIDATES || 20);
  const invitationSource = process.env.SEND_PROJECT_INVITATIONS !== undefined
    ? 'npm command override'
    : '.env';

  if (DRY_RUN) {
    const invalidKeys = Object.keys(shared).filter((key) => !ENV_KEY_RE.test(key));
    if (invalidKeys.length) {
      throw new Error(`Dry-run validation found invalid k6 environment keys: ${invalidKeys.join(', ')}`);
    }
    console.log(`[E2E runner validation] ${Object.keys(shared).length} project environment variables are safe for k6 forwarding.`);
    console.log(`[E2E runner validation] ANAM_MODE=${mode}, ANUM_API_ENABLED=${shared.ANUM_API_ENABLED}, SEND_PROJECT_INVITATIONS=${shared.SEND_PROJECT_INVITATIONS} (${invitationSource})`);
    console.log(`[E2E runner validation] NUM_CANDIDATES=${configuredCandidateCount}`);
    return;
  }

  if (!invitationsEnabled) {
    throw new Error(
      'Anam browser/session E2E requires SEND_PROJECT_INVITATIONS=true. ' +
      'When SEND_PROJECT_INVITATIONS=false, the project is provisioning-only and no candidate activity is allowed to start.'
    );
  }

  if (!Number.isInteger(configuredCandidateCount) || configuredCandidateCount < 7) {
    throw new Error(
      `Anam E2E requires NUM_CANDIDATES>=7 (1 browser + 6 audit candidates); received ${shared.NUM_CANDIDATES}.`
    );
  }

  console.log('');
  console.log(
    '============================================================'
  );

  console.log(
    `Anam validation mode: ${mode}`
  );

  console.log(
    `Talent Intelligence:  ${
      anamEnabled
        ? 'ENABLED'
        : 'DISABLED'
    }`
  );

  console.log(
    `Project invitations:  ${invitationsEnabled ? 'ENABLED' : 'DISABLED'} (${invitationSource})`
  );

  if (
    mode === 'outage503' ||
    mode === 'network'
  ) {
    console.log(
      'Outage timing:        initial Anam engine + metrics succeed first, then outage is injected'
    );
  }

  console.log(
    '============================================================'
  );

  console.log('');

  /*
   * ---------------------------------------------------------
   * PHASE 1
   * ---------------------------------------------------------
   */

  console.log(
    '=== Phase 1/3 — k6: validation setup ' +
    '(org + project + isolated candidates) ==='
  );

  const setup = k6(
    'tests/smoke-no-anum-setup.js',
    shared,
    { E2E_EMIT_SESSION_SECRETS: 'true' }
  );

  const vars =
    parseVars(setup.out);

  if (setup.code !== 0) {
    console.error('');
    console.error(
      'Phase 1 failed. Phase 2/3 will not run because ' +
      'project/candidate state is not trustworthy.'
    );

    process.exit(
      setup.code || 1
    );

    return;
  }

  /*
   * Browser candidate:
   *
   * NOANUMTEST_CANDIDATE_ID
   *
   * Dedicated backend-audit candidates:
   *
   * NOANUMTEST_AUDIT_CANDIDATE_IDS
   */
  if (
    !vars.NOANUMTEST_PROJECT_ID ||
    !vars.NOANUMTEST_CANDIDATE_ID ||
    !vars.NOANUMTEST_AUDIT_CANDIDATE_IDS
  ) {
    console.error('');
    console.error(
      'Setup did not print the required NOANUMTEST_* variables.'
    );

    console.error(
      'Required: PROJECT_ID, browser CANDIDATE_ID, AUDIT_CANDIDATE_IDS.'
    );

    process.exit(1);
    return;
  }

  console.log(
    '\nParsed validation ids:',
    {
      NOANUMTEST_PROJECT_ID:
        vars.NOANUMTEST_PROJECT_ID,

      NOANUMTEST_ORG_ID:
        vars.NOANUMTEST_ORG_ID,

      NOANUMTEST_ADMIN_USER_ID:
        vars.NOANUMTEST_ADMIN_USER_ID,

      NOANUMTEST_CANDIDATE_ID:
        vars.NOANUMTEST_CANDIDATE_ID,

      NOANUMTEST_AUDIT_CANDIDATE_IDS:
        vars.NOANUMTEST_AUDIT_CANDIDATE_IDS
    }
  );

  /*
   * ---------------------------------------------------------
   * PHASE 2
   * ---------------------------------------------------------
   */

  console.log('');
  console.log(
    '=== Phase 2/3 — k6: backend session-token audit ' +
    'with dedicated candidates ==='
  );

  const audit = k6(
    'tests/no-anum-session-token-audit.js',
    shared,
    vars
  );

  if (audit.code !== 0) {
    console.warn('');
    console.warn(
      'Backend audit failed. Browser phase will still run ' +
      'so the report contains full evidence.'
    );
  }

  /*
   * ---------------------------------------------------------
   * PHASE 3
   * ---------------------------------------------------------
   */

  console.log('');
  console.log(
    '=== Phase 3/3 — Playwright: browser / ' +
    'Anam resilience validation ==='
  );

  const candidateUrl =
    mergedEnv.CANDIDATE_URL;

  const apiUrl =
    mergedEnv.API_URL || '';

  const token =
    process.env.CANDIDATE_ACCESS_TOKEN ||
    parseToken(setup.out);

  if (!token) {
    console.error('');
    console.error(
      'CANDIDATE_ACCESS_TOKEN was not found in setup output. ' +
      'Browser phase cannot authenticate.'
    );

    process.exit(
      audit.code || 1
    );

    return;
  }

  const sessionVars =
    parseSessionVars(setup.out);

  const playwrightEnv = {
    ...process.env,
    ...mergedEnv,

    /*
     * Scenario mode
     */
    ANAM_MODE:
      mode,

    ANUM_API_ENABLED:
      anamEnabled
        ? 'true'
        : 'false',

    /*
     * Mid-session outage is only enabled for
     * outage503/network modes.
     */
    SIMULATE_ANAM_MID_SESSION_OUTAGE:
      mode === 'outage503' ||
      mode === 'network'
        ? 'true'
        : 'false',

    /*
     * 503:
     * return Service Unavailable
     *
     * network:
     * abort request completely
     */
    ANAM_OUTAGE_MODE:
      mode === 'network'
        ? 'network'
        : '503',

    /*
     * Browser authentication/session information.
     */
    CANDIDATE_URL:
      candidateUrl,

    API_URL:
      apiUrl,

    CANDIDATE_ACCESS_TOKEN:
      token,

    CANDIDATE_REFRESH_TOKEN:
      sessionVars.CANDIDATE_REFRESH_TOKEN ||
      '',

    CANDIDATE_ORG_ID:
      sessionVars.CANDIDATE_ORG_ID ||
      '',

    CANDIDATE_PARENT_ORG_ID:
      sessionVars.CANDIDATE_PARENT_ORG_ID ||
      '',

    /*
     * Browser candidate is intentionally NOT one
     * of the Phase 2 audit candidates.
     */
    NOANUMTEST_PROJECT_ID:
      vars.NOANUMTEST_PROJECT_ID ||
      '',

    NOANUMTEST_CANDIDATE_ID:
      vars.NOANUMTEST_CANDIDATE_ID ||
      ''
  };

  const playwrightCode =
    await runPlaywright(
      playwrightEnv
    );

  /*
   * Full run fails if:
   *
   * - backend audit failed
   * OR
   * - browser validation failed
   */
  const finalCode =
    audit.code !== 0 ||
    playwrightCode !== 0
      ? 1
      : 0;

  console.log('');
  console.log(
    `All 3 phases complete — ` +
    `audit exit=${audit.code}, ` +
    `Playwright exit=${playwrightCode}, ` +
    `final=${finalCode}`
  );

  process.exit(
    finalCode
  );
}

main().catch((error) => {
  console.error(
    'FATAL:',
    error
  );

  process.exit(2);
});