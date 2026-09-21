#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const failures = [];
const warnings = [];

function fail(message) { failures.push(message); }
function warn(message) { warnings.push(message); }

function walk(dir) {
  const output = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'reports', '.git'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}

const sourceFiles = walk(ROOT);
const jsFiles = sourceFiles.filter((file) => file.endsWith('.js'));

for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`JavaScript syntax error in ${path.relative(ROOT, file)}: ${result.stderr || result.stdout}`);
  }
}

for (const [name, command] of Object.entries(packageJson.scripts || {})) {
  const jsTargets = [...String(command).matchAll(/(?:^|\s)([\w./-]+\.js)(?=\s|$)/g)].map((match) => match[1]);
  for (const target of jsTargets) {
    if (!fs.existsSync(path.join(ROOT, target))) fail(`npm script ${name} references missing file ${target}`);
  }
}

const taskTemplates = fs.readFileSync(path.join(ROOT, 'data', 'taskTemplates.js'), 'utf8');
for (const scenario of ['role-play-only', 'interview-only', 'case-only', 'situation-only', 'board-meeting-only']) {
  if (!taskTemplates.includes(`'${scenario}'`)) fail(`Scenario contract missing for ${scenario}`);
}
if (!taskTemplates.includes("'WELCOME'")) fail('Welcome activity dependency is not defined in taskTemplates.js');

const managedSmoke = fs.readFileSync(path.join(ROOT, 'tests', 'smoke.js'), 'utf8');
const managedClientProject = fs.readFileSync(path.join(ROOT, 'tests', 'load-client-project.js'), 'utf8');
for (const [name, text] of [
  ['tests/smoke.js', managedSmoke],
  ['tests/load-client-project.js', managedClientProject]
]) {
  if (!text.includes("executor: 'per-vu-iterations'")) {
    fail(`${name} must use per-vu-iterations for isolated provisioning loads`);
  }
  if (text.includes("executor: 'ramping-vus'")) {
    fail(`${name} must not use ramping-vus for resource-provisioning flows`);
  }
  if (!text.includes('managed_projects_created')) {
    fail(`${name} must expose the managed_projects_created counter`);
  }
}

if (!taskTemplates.includes("[...primaryTypes, 'WELCOME']")) {
  fail('Focused scenario composition does not explicitly add the required Welcome activity');
}

const e2eRunner = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e-no-anum-full.js'), 'utf8');
if (!e2eRunner.includes('ENV_KEY_RE')) {
  fail('Anam E2E runner does not validate k6 environment variable names');
}
if (!e2eRunner.includes('const merged = { ...fileEnv };')) {
  fail('Anam E2E runner must start k6 environment forwarding from project .env only');
}


const runnerSource = fs.readFileSync(path.join(ROOT, 'scripts', 'run.js'), 'utf8');
if (/env\.SEND_PROJECT_INVITATIONS\s*=/.test(runnerSource)) {
  fail('scripts/run.js must not override SEND_PROJECT_INVITATIONS; .env is the single source of truth.');
}

if (/SEND_PROJECT_INVITATIONS\s*:\s*['"](?:true|false)['"]/.test(e2eRunner)) {
  fail('Anam E2E runner must not hardcode SEND_PROJECT_INVITATIONS.');
}

const environmentSource = fs.readFileSync(path.join(ROOT, 'config', 'environments.js'), 'utf8');
if (!environmentSource.includes("positiveInt('NUM_CANDIDATES', 20)")) {
  fail('NUM_CANDIDATES production default must be 20 in config/environments.js.');
}

const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
if (!/^NUM_CANDIDATES=20$/m.test(envExample)) {
  fail('.env.example must configure NUM_CANDIDATES=20.');
}


if (!managedSmoke.includes("candidateSource === 'preprovisioned' || candidateSource === 'both'")) {
  fail('tests/smoke.js must preserve the configured pre-provisioned candidate path when candidateSource=both.');
}
if (!managedSmoke.includes('if (!SEND_PROJECT_INVITATIONS)')) {
  fail('tests/smoke.js must gate candidate activity execution when project invitations are disabled.');
}

const projectCreationSource = fs.readFileSync(path.join(ROOT, 'scenarios', 'projectcreation.js'), 'utf8');
if (!projectCreationSource.includes('createAndAssignCandidatesFromCsvSeed')) {
  fail('Managed project creation must provision candidates from the canonical data/candidates.csv seed.');
}
if (!projectCreationSource.includes('force: false')) {
  fail('Project candidate creation must use force=false so duplicate users are never deliberately created.');
}
if (/importCandidatesCsv\s*\(/.test(projectCreationSource) || /postMultipart\s*\(routes\.uploadCandidatesCsv/.test(projectCreationSource)) {
  fail('Managed project creation must not use the asynchronous CSV upload queue; it does not return candidate IDs and previously caused duplicate candidate creation.');
}
if (projectCreationSource.includes('resolveAndAssignImportedCandidates')) {
  fail('Legacy asynchronous import-resolution logic is still present.');
}
if (!projectCreationSource.includes('waitForAssignedProjectCandidates')) {
  fail('Managed project creation must verify all expected candidates are attached to the project after bulk assignment.');
}


if (projectCreationSource.includes("'project active: candidate access enabled'")) {
  fail(
    'Project activation must not require project.candidateAccess=true; the dev API can report false after activation while candidate portal access is already valid.'
  );
}
if (!projectCreationSource.includes('candidateAccessFlag=')) {
  fail('Project activation should log candidateAccess as diagnostic-only state.');
}

const candidateRows = fs.readFileSync(path.join(ROOT, 'data', 'candidates.csv'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .filter(Boolean);
if (candidateRows.length < 20) {
  fail(`data/candidates.csv must contain at least 20 candidate rows; found ${candidateRows.length}.`);
}

const disallowedLanguage = /\b(teeno|mein|nahi|hoga|hua|karo|dekho|wala|wapis|abhi|agar|kyun|hai|hain|karna|karke|mila|yahan|yeh|bas)\b/i;
for (const file of sourceFiles.filter((file) => /\.(js|md|example)$/.test(file) && path.basename(file) !== 'validate-project.js')) {
  const text = fs.readFileSync(file, 'utf8');
  if (disallowedLanguage.test(text)) {
    fail(`Non-English wording detected in ${path.relative(ROOT, file)}`);
  }
}

if (!fs.existsSync(path.join(ROOT, '.env'))) {
  warn('.env is not present. This is expected in the distributable ZIP; copy .env.example to .env before live runs.');
}

if (failures.length) {
  console.error('Project validation failed:');
  failures.forEach((message) => console.error(`  - ${message.trim()}`));
  process.exit(1);
}

console.log(`Project validation passed (${jsFiles.length} JavaScript files checked).`);
warnings.forEach((message) => console.warn(`Warning: ${message}`));
