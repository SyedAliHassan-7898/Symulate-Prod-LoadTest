# Symulate AI Load, Smoke, and Browser Validation Suite

Production-oriented k6 + Playwright validation for the Symulate AI dev environment.

The repository covers:

- isolated Super Admin → Client → Project provisioning;
- activity creation and stage assignment;
- mandatory Welcome-stage composition;
- CSV-backed candidate provisioning and project assignment;
- project invitation / activation lifecycle;
- generated and pre-provisioned candidate execution;
- candidate booking, transcript persistence, and activity completion;
- project review checks;
- Anam enabled/disabled/resilience browser validation;
- optional InfluxDB/Grafana output;
- local HTML/JSON/CSV reports.

## 1. Prerequisites

Install:

- Node.js 20+ (Node 24 is supported by the project scripts);
- npm;
- k6;
- Docker Desktop only when Grafana/InfluxDB monitoring is required;
- Chromium for Playwright (`npm run playwright:install`).

Verify:

```bat
node --version
npm --version
k6 version
```

## 2. Installation

```bat
npm install
copy .env.example .env
```

Populate the real environment credentials in `.env`.

Do not commit `.env`. It is ignored by Git and is intentionally excluded from distributable ZIPs. Set `RUNNER_VERBOSE=true` only when you need the full redacted k6 command; normal runs print a concise configuration summary.

Then validate the repository:

```bat
npm run validate
```

## 3. Environment contract

### Required platform values

```env
ENV=dev
API_URL=https://api.symulate.weuno.co/dev/api
SUPER_ADMIN_URL=https://superadmin.symulate-dev.weuno.co
CLIENT_ADMIN_URL=https://client-admin.symulate-dev.weuno.co
CANDIDATE_URL=https://symulate-ai-dev.weuno.co
ACTIVITY_IMAGE_URL=https://symulate-ai-dev.weuno.co/favicon.ico

SUPER_ADMIN_EMAIL=...
SUPER_ADMIN_PASSWORD=...
```

### Generated project candidate count

```env
NUM_CANDIDATES=20
```

Every managed project provisions exactly 20 generated candidates by default from the canonical seed file `data/candidates.csv`.

The repository contains 20 seed rows. If `NUM_CANDIDATES` is higher than the number of seed rows, the run fails immediately instead of silently reducing the count.

Candidate emails are made unique per VU and iteration, for example:

```text
john1.load.<run-id>.1@yopmail.com
john2.load.<run-id>.2@yopmail.com
...
john20.load.<run-id>.20@yopmail.com
```

`data/candidates.csv` is the source of truth for names and email seeds. The managed flow does **not** call the asynchronous `/candidate/upload-candidates` queue, because that endpoint only returns a queue summary and does not return the candidate IDs required by project assignment. Using that queue and then calling `create-for-project` created duplicate organization users in earlier versions.

The production flow now reads the CSV, generates collision-safe per-run email addresses, creates each candidate once with the confirmed `create-for-project` API (`force=false`), bulk-assigns the returned IDs, and verifies all expected emails through the project detail endpoint.

## 4. Project invitation lifecycle

`SEND_PROJECT_INVITATIONS` is the single source of truth.

No runner silently overrides it.

### Invitations enabled

```env
SEND_PROJECT_INVITATIONS=true
```

The managed flow:

1. creates the client and project;
2. creates the selected activities;
3. creates the project stage;
4. reads `NUM_CANDIDATES` rows from `data/candidates.csv`;
5. creates each project candidate exactly once through the confirmed candidate API;
6. bulk-assigns all returned candidate IDs to the project;
7. verifies all expected candidate emails are visible on that exact project;
8. selects an email template;
9. sends project invitations;
10. verifies the project becomes `ACTIVE`;
11. only then allows candidate activity execution.

A failed invitation or failure to reach `ACTIVE` blocks candidate execution.

The backend project payload also exposes a `candidateAccess` field. In the current dev API this field can remain `false` even after invitation dispatch succeeds, the project is `ACTIVE`, all expected candidates are attached, and candidate portal-token login succeeds. v9 therefore treats `candidateAccess` as diagnostic only. Real candidate readiness is proven by the candidate authentication/session path rather than by that stale project flag.

### Invitations disabled

```env
SEND_PROJECT_INVITATIONS=false
```

`npm run smoke` becomes a provisioning-only run.

It may create the organization, activities, project, stage, and candidates, but it does **not**:

- create a candidate portal session;
- accept the candidate agreement;
- create a booking;
- start an activity session;
- open the transcript socket;
- mark an activity `COMPLETED`.

This behavior is intentional because a project that has not passed the invitation/activation lifecycle can remain `DRAFT`.

The expected log is similar to:

```text
SEND_PROJECT_INVITATIONS=false: invitation dispatch is disabled...
Provisioning-only completion ... candidate activity execution skipped.
```

## 5. Which candidate performs during `npm run smoke`

Configure:

```env
CANDIDATE_EXECUTION_SOURCE=auto
```

Supported values:

| Value | Behavior |
|---|---|
| `auto` | Smoke: run the generated candidate plus the pre-provisioned candidate when the latter is fully configured. Load: generated candidate only. |
| `generated` | Run the first candidate from the newly-created project. |
| `preprovisioned` | Run only the candidate configured by `CANDIDATE_*` / `ASSESSMENT_*`. |
| `both` | Run generated and pre-provisioned candidates. |
| `none` | Do not execute candidate activities after activation. |

Candidate execution is still blocked when `SEND_PROJECT_INVITATIONS=false`.

### Pre-provisioned candidate

```env
CANDIDATE_EMAIL=performer35@yopmail.com
CANDIDATE_PASSWORD=...
ASSESSMENT_CANDIDATE_ID=...
ASSESSMENT_PROJECT_ID=...
ASSESSMENT_BOOKING_ID=...
ASSESSMENT_BOOKING_START_AT=...
```

The smoke flow resolves the candidate against the configured project using the Super Admin session. It does not use the newly-created client admin session to read an unrelated pre-provisioned project.

For a deterministic managed-project check, use:

```env
CANDIDATE_EXECUTION_SOURCE=generated
```

For the original combined smoke behavior, use:

```env
CANDIDATE_EXECUTION_SOURCE=both
```

## 6. Smoke test

```bat
npm run smoke
```

Smoke always uses one VU and one iteration.

The `.env` `LOAD_VUS` value does not change smoke concurrency. `LOAD_VUS=10` is used only when `LOAD_MODE=load` (for example `npm run load:10`).

With `CANDIDATE_EXECUTION_SOURCE=auto` and a complete pre-provisioned candidate configuration, smoke runs the generated managed-project candidate first and then the configured pre-provisioned candidate. The run contains explicit checks so either path cannot be silently skipped.

Recommended complete smoke configuration:

```env
LOAD_MODE=smoke
NUM_CANDIDATES=20
SEND_PROJECT_INVITATIONS=true
CANDIDATE_EXECUTION_SOURCE=auto
```

## 7. Isolated load behavior

Managed resource-creation load uses `per-vu-iterations`.

```env
LOAD_MODE=load
LOAD_VUS=10
LOAD_ITERATIONS_PER_VU=1
NUM_CANDIDATES=20
```

Then:

```bat
npm run load
```

means:

```text
10 VUs
x 1 isolated provisioning iteration per VU
= 10 clients
= 10 projects
= 200 generated candidates total
```

Each VU owns its own client, activity set, project, candidate set, booking state, and managed candidate execution. VUs do not share mutable generated project state.

**Email volume note:** when `SEND_PROJECT_INVITATIONS=true`, a 10-project load with 20 candidates per project can request up to 200 candidate invitation emails. Set the toggle to `false` for provisioning/performance runs where email delivery is not the system under test; candidate activity execution will then be intentionally skipped for those managed projects.

Useful commands:

```bat
npm run load:10
npm run load:client-project:10
npm run load:situation
npm run load:role-play
npm run load:interview
npm run load:case
npm run load:board-meeting
npm run load:welcome
```

## 8. Performance profiles and load exit codes

Functional correctness and latency SLOs are separate concerns. A load run can create all expected resources with zero failed HTTP requests but still exit non-zero when a latency threshold is crossed.

Use:

```env
PERFORMANCE_PROFILE=auto
```

Profiles:

```text
auto       -> strict for smoke; baseline for load
strict     -> p95/p99 regression gate used for low-concurrency validation
baseline   -> concurrency-aware dev/load gate; all latency percentiles are still reported
functional -> correctness/request-failure gates only; latency is reported but does not fail the run
```

The baseline load profile keeps the global p95 below 2s, allows global p99 up to 12s, `Create Client` p95 up to 3s, and `Assign Task` p95 up to 12s. These bounds reflect the shared dev environment behavior observed under 10 concurrent provisioning VUs; they are not a production SLO. Set `PERFORMANCE_PROFILE=strict` whenever you want the tighter gate to fail the run.

## 9. Welcome dependency

The backend requires exactly one Welcome activity in every stage.

The suite composes focused scenarios automatically:

```text
role-play-only      -> ROLE_PLAY + WELCOME
interview-only      -> INTERVIEW + WELCOME
case-only           -> CASE + WELCOME
situation-only      -> SITUATIONS + WELCOME
board-meeting-only  -> BOARD_MEETING + WELCOME
welcome-only        -> WELCOME
full                -> all activity types, including one WELCOME
```

If stage composition resolves zero or multiple Welcome activities, the test stops before assignment.

## 10. Candidate provisioning behavior

`data/candidates.csv` is the canonical seed file for managed project candidates. The suite reads the requested number of seed rows, generates a unique email for each VU/iteration, and provisions each candidate through the deterministic project-candidate API:

```text
data/candidates.csv
  -> select NUM_CANDIDATES seed rows
  -> generate unique per-run candidate emails
  -> POST /candidate/create-for-project?projectId=... with force=false
  -> capture every returned candidate ID
  -> bulk-assign those IDs to the project
  -> verify every expected generated email is visible on the project
```

The legacy asynchronous CSV-upload endpoint is intentionally not used by the managed load flow because its accepted response does not provide candidate IDs and the project-scoped lookup cannot resolve unassigned candidates. The older combination of CSV upload plus `create-for-project` was also removed because it could duplicate organization candidates.

For a 10-VU run with `NUM_CANDIDATES=20`, the suite therefore creates and verifies 200 unique candidates across 10 isolated projects.

## 11. Candidate activity completion

Candidate activity execution follows:

1. portal-token session using `{ candidateId, projectId }`;
2. agreement acceptance;
3. booking and entry gate;
4. activity session-token request;
5. transcript persistence over Socket.IO;
6. `PATCH /activities/candidate-activity/update-status/{activityId}` with `COMPLETED`.

The legacy `/sessions/{sessionId}/complete` endpoint is not used.

## 12. Focused pre-provisioned candidate load

```bat
npm run load:candidate
```

This command does not create a new project. Configure one candidate/project pair per VU:

```env
CANDIDATE_EMAIL=...
CANDIDATE_PASSWORD=...
ASSESSMENT_CANDIDATE_ID=...
ASSESSMENT_PROJECT_ID=...

CANDIDATE_EMAIL_2=...
CANDIDATE_PASSWORD_2=...
ASSESSMENT_CANDIDATE_ID_2=...
ASSESSMENT_PROJECT_ID_2=...
```

By default the suite refuses to share one pre-provisioned candidate across multiple VUs. Set `ALLOW_SHARED_CANDIDATES=true` only for an intentional contention test.

## 13. Anam validation

Modes:

```text
disabled
healthy
outage503
network
```

Commands:

```bat
npm run validate:e2e-runner
npm run playwright:install
npm run e2e:anam:disabled
npm run e2e:anam:healthy
npm run e2e:anam:outage503
npm run e2e:anam:network
```

The specialized `e2e:anam:*` and `e2e:no-anum:full` npm commands explicitly enable `SEND_PROJECT_INVITATIONS=true` for the isolated E2E project they create. This command-level override is intentional: these tests exercise browser/session activity execution and cannot run against a provisioning-only DRAFT project. It does **not** modify `.env`, and normal `smoke` / `load` commands continue to use the `.env` toggle exactly as configured.

At least seven candidates are required: one browser candidate plus one isolated audit candidate for each of six activities. The default `NUM_CANDIDATES=20` project satisfies this requirement.

Phase 1 now requires the project to be `ACTIVE`, the invitation template to be present, all expected candidates to be attached, and the reserved browser candidate to obtain a real portal token. The project-level `candidateAccess` flag is logged for diagnostics but is not used as a hard gate because the current backend can report it as `false` while portal-token access already works.

### Mid-session outage

`outage503` allows initial Anam engine/session and metrics calls to succeed, then injects HTTP 503 responses and interrupts Anam WebSocket traffic. The configured recovery window then re-allows Anam traffic.

## 14. Playwright microphone

Recommended automated mode:

```env
HEADLESS=true
PLAYWRIGHT_MICROPHONE_MODE=fake
```

This grants microphone permission to the candidate portal and launches Chromium with a deterministic fake media input.

To use the host microphone:

```env
HEADLESS=false
PLAYWRIGHT_MICROPHONE_MODE=system
```

Windows microphone permissions must also allow desktop applications.

## 15. Reports

Managed runs write reports under `reports/`:

- HTML;
- JSON;
- overview CSV;
- summary CSV;
- aggregate CSV;
- checks CSV.

Playwright writes browser artifacts below `playwright/artifacts/`.

Generated artifacts are ignored by Git.

## 16. Grafana / InfluxDB

Start monitoring:

```bat
npm run monitoring:up
npm run monitoring:status
```

Run:

```bat
npm run smoke:grafana
npm run load:grafana
```

Stop:

```bat
npm run monitoring:down
```

The runner checks InfluxDB before launching k6 and stops with a clear error if monitoring is unavailable.

## 17. Troubleshooting

### Anam Phase 1 fails on `project active: candidate access enabled`

This was a false-negative activation check in v8. The dev API can report `candidateAccess=false` after the project is already `ACTIVE` and candidate portal-token login succeeds. v9 no longer treats that field as the activation contract. If Phase 1 still fails, inspect the invitation response, project `ACTIVE` status, project candidate count, and the candidate portal-token login check.

### `SEND_PROJECT_INVITATIONS=false` but activities are starting

This should not occur in this version. `npm run validate` checks that the runners do not override the environment value and that `tests/smoke.js` contains the lifecycle gate.

Confirm the runner line contains:

```text
projectInvitations=false
```

The run should finish after provisioning without candidate activity logs.

### Only one candidate appears in the project

Confirm:

```env
NUM_CANDIDATES=20
```

The log must say:

```text
Creating isolated project data ... 20 unique candidate(s)
```

The log must then report `Candidate provisioning complete: 20/20 candidates assigned to project ...`.

### `Import Candidates (CSV) -> 201` but `resolved 0/20`

That was the v6 asynchronous-import defect. A `201` from `/candidate/upload-candidates` only confirmed queue acceptance; it did not provide candidate IDs. v8 keeps that queue out of managed provisioning. Candidate creation is now deterministic and sourced from `data/candidates.csv` through the confirmed `create-for-project` endpoint, followed by bulk assignment and direct project verification.

If you still see `Resolve Imported Candidates` in a run, you are executing an older project folder.

### Pre-provisioned candidate does not run during smoke

Confirm all of these are set:

```env
CANDIDATE_EXECUTION_SOURCE=auto
CANDIDATE_EMAIL=...
ASSESSMENT_CANDIDATE_ID=...
ASSESSMENT_PROJECT_ID=...
```

With a complete pre-provisioned candidate, `auto` resolves to `both` in smoke mode.

### Managed project shows no completed candidate activity

Use:

```env
SEND_PROJECT_INVITATIONS=true
CANDIDATE_EXECUTION_SOURCE=generated
```

The generated candidate is then executed against the same project that was created by the smoke run, so Client Admin completion state can be checked on that project.


### Browser reports `ERR_NAME_NOT_RESOLVED` for the activity cover

The old `cdn.symulate.ai` placeholder is no longer hardcoded. Configure a reachable image URL if your environment uses a different asset host:

```env
ACTIVITY_IMAGE_URL=https://symulate-ai-dev.weuno.co/favicon.ico
```


### `load:10` completes 10/10 iterations but exits with threshold errors

If the summary shows `checks=100%`, `http_req_failed=0%`, `managed_clients_created=10` and `managed_projects_created=10`, the functional load flow completed successfully. A non-zero exit can still be caused by latency SLO thresholds.

Use the default:

```env
PERFORMANCE_PROFILE=auto
```

which resolves to the concurrency-aware `baseline` profile in load mode. Use `PERFORMANCE_PROFILE=strict` when you intentionally want the tighter low-concurrency latency budget to fail the run. Do not use `functional` for performance sign-off; it is only for isolating correctness from latency.

### `CommonProgramFiles(x86)` k6 error

The runners forward only project variables from `.env`, not the entire Windows process environment. If this returns, run:

```bat
npm run validate:e2e-runner
```

### Candidate session returns `403 assessment has not started yet`

Keep:

```env
BOOKING_START_SETTLE_MS=3000
SESSION_START_RETRY_ATTEMPTS=3
SESSION_START_RETRY_DELAY_MS=2500
```

The suite retries only the known transient booking/start propagation case.

## 18. Recommended production-like configuration

```env
SCENARIO=full
LOAD_MODE=smoke
LOAD_VUS=10
LOAD_ITERATIONS_PER_VU=1
NUM_CANDIDATES=20

SEND_PROJECT_INVITATIONS=true
SEND_CLIENT_EMAIL=true
CANDIDATE_EXECUTION_SOURCE=auto

ENFORCE_BOOKING=true
ANAM_MODE=disabled
ANUM_API_ENABLED=false

HEADLESS=true
PLAYWRIGHT_MICROPHONE_MODE=fake
```

Then run:

```bat
npm install
npm run validate
npm run discover
npm run smoke
```

For isolated 10-project load:

```bat
npm run load:10
```

For Anam outage validation, run:

```bat
npm run validate:e2e-runner
npm run e2e:anam:outage503
```

Those specialized E2E npm commands enable invitations only for their isolated E2E project. Your `.env` value remains unchanged for normal smoke/load runs.
# Symulate-Prod-LoadTest
# Symulate-Prod-LoadTest
