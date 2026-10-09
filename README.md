# Symulate AI Load Testing & Monitoring Suite

Production-oriented k6 + Playwright validation suite for the Symulate AI platform. Covers smoke testing, isolated load testing, shared-project concurrent load testing, Anam AI validation, and optional Grafana/InfluxDB live monitoring.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [Environment Setup](#3-environment-setup)
4. [Test Commands Overview](#4-test-commands-overview)
5. [Smoke Test](#5-smoke-test)
6. [Isolated Load Test (`npm run load`)](#6-isolated-load-test)
7. [Shared-Project Concurrent Load Test (`npm run load:shared`)](#7-shared-project-concurrent-load-test) ⭐ **Primary Load Command**
8. [Pre-Provisioned Candidate Load (`npm run load:candidate`)](#8-pre-provisioned-candidate-load)
9. [Anam AI Validation](#9-anam-ai-validation)
10. [Activity-Specific Load Commands](#10-activity-specific-load-commands)
11. [Project Invitation Lifecycle](#11-project-invitation-lifecycle)
12. [Candidate Provisioning](#12-candidate-provisioning)
13. [Performance Profiles](#13-performance-profiles)
14. [Reports](#14-reports)
15. [Grafana / InfluxDB Monitoring](#15-grafana--influxdb-monitoring)
16. [Key `.env` Variables Reference](#16-key-env-variables-reference)
17. [Troubleshooting](#17-troubleshooting)
18. [Recommended Configurations](#18-recommended-configurations)

---

## 1. Prerequisites

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| Node.js | 20+ | Runner scripts |
| npm | bundled with Node | Package management |
| k6 | latest | Load test execution |
| Docker Desktop | latest | Grafana/InfluxDB monitoring (optional) |
| Chromium | via Playwright | Browser validation |

Verify installation:

```bat
node --version
npm --version
k6 version
```

Install Playwright browsers:

```bat
npm run playwright:install
```

---

## 2. Installation

```bat
npm install
copy .env.example .env
```

Edit `.env` with real credentials. Never commit `.env` — it is Git-ignored.

Validate the repository setup:

```bat
npm run validate
```

---

## 3. Environment Setup

Copy `.env.example` to `.env` and fill in:

```env
# Platform URLs
ENV=dev
API_URL=https://api.symulate.weuno.co/dev/api
SUPER_ADMIN_URL=https://superadmin.symulate-dev.weuno.co
CLIENT_ADMIN_URL=https://client-admin.symulate-dev.weuno.co
CANDIDATE_URL=https://symulate-ai-dev.weuno.co
ACTIVITY_IMAGE_URL=https://d5uk4ljnw67gt.cloudfront.net/create_task/images-...

# Admin credentials
SUPER_ADMIN_EMAIL=superadmin@yopmail.com
SUPER_ADMIN_PASSWORD=...

# Load test settings
NUM_CANDIDATES=10          # candidates to provision per project
LOAD_VUS=10                # concurrent virtual users in Phase 2
LOAD_MAX_DURATION=10m      # max duration for Phase 2

# Dev environment flags
ENFORCE_BOOKING=false      # set true when booking API is available
SEND_PROJECT_INVITATIONS=false
ANAM_MODE=disabled
ANUM_API_ENABLED=false
```

> **Note:** `npm run load:shared` reads `NUM_CANDIDATES` and `LOAD_VUS` directly from `.env`. The values in the npm script definition are overridden by your `.env` file.

---

## 4. Test Commands Overview

| Command | What it does | VUs | Projects | Candidates |
|---------|-------------|-----|----------|------------|
| `npm run smoke` | Full smoke: provision + 1 candidate | 1 | 1 | NUM_CANDIDATES |
| `npm run load` | Isolated load: N VUs, each own project | LOAD_VUS | LOAD_VUS | LOAD_VUS × NUM_CANDIDATES |
| **`npm run load:shared`** | **Shared-project: N concurrent candidates** | **LOAD_VUS** | **1** | **NUM_CANDIDATES** |
| `npm run load:candidate` | Pre-provisioned candidate only | 1 | existing | existing |
| `npm run e2e:anam:outage503` | Anam outage + recovery E2E | 1 | 1 | NUM_CANDIDATES |

---

## 5. Smoke Test

```bat
npm run smoke
```

Runs 1 VU through the full lifecycle:

1. Super Admin login
2. Create organization (Client)
3. Create 6 activity types (Role Play, Interview, Case, Situation, Board Meeting, Welcome)
4. Create project + stage + assign activities
5. Provision `NUM_CANDIDATES` candidates from `data/candidates.csv`
6. Send project invitations → verify project becomes `ACTIVE`
7. Candidate logs in via invitation href → accepts agreement → performs all 6 activities
8. Each activity: start session → WebSocket transcript → mark `COMPLETED`

Recommended smoke config:

```env
NUM_CANDIDATES=10
LOAD_VUS=1
SEND_PROJECT_INVITATIONS=false
ENFORCE_BOOKING=false
```

---

## 6. Isolated Load Test

```bat
npm run load
```

Each VU independently provisions its own project with its own candidates.

**With `LOAD_VUS=10`, `NUM_CANDIDATES=10`:**

```
VU 1  → creates Client A → Project A → 10 candidates → performs activities
VU 2  → creates Client B → Project B → 10 candidates → performs activities
...
VU 10 → creates Client J → Project J → 10 candidates → performs activities
```

Total: 10 projects, 100 candidates.

> ⚠️ **Warning:** High VU counts (e.g. 150) cause 429 rate limiting on concurrent `Create Client` calls. Use `npm run load:shared` for large concurrent tests.

---

## 7. Shared-Project Concurrent Load Test

> ⭐ **This is the primary command for testing concurrent user load on a single project.**

```bat
npm run load:shared
```

### What it does

A 2-phase orchestrated test:

**Phase 1 — Provision (sequential, 1 VU):**

```
Super Admin
  → Create 1 Client (organization)
  → Create 6 activities
  → Create 1 Project with stage + activities
  → Provision NUM_CANDIDATES unique candidates
  → Send invitations → verify project ACTIVE
  → Capture all invitation hrefs → write to temp file
```

**Phase 2 — Concurrent load (LOAD_VUS VUs simultaneously):**

```
VU 1   → john1@ invitation href → login → 6 activities ✓
VU 2   → john2@ invitation href → login → 6 activities ✓
VU 3   → john3@ invitation href → login → 6 activities ✓
...
VU N   → johnN@ invitation href → login → 6 activities ✓
```

All VUs start at the same time. Each VU has its own unique candidate identity — no shared credentials.

### How load is controlled

The load is determined **exclusively by `.env`**:

```env
NUM_CANDIDATES=10    # how many candidates to provision in Phase 1
LOAD_VUS=10         # how many concurrent VUs in Phase 2
LOAD_MAX_DURATION=10m
```

> The npm script sets `NUM_CANDIDATES=150 LOAD_VUS=150` as defaults, but your `.env` values always take priority because the runner reads `.env` directly.

### Scale examples

| `.env` setting | Server load |
|----------------|-------------|
| `NUM_CANDIDATES=10, LOAD_VUS=10` | 10 concurrent candidate sessions |
| `NUM_CANDIDATES=50, LOAD_VUS=50` | 50 concurrent candidate sessions |
| `NUM_CANDIDATES=150, LOAD_VUS=150` | 150 concurrent candidate sessions |

### Why shared-project instead of isolated?

| Approach | Projects | Rate limit risk | Realistic? |
|----------|----------|-----------------|------------|
| `load` (isolated) | 150 | High — 150 concurrent Create Client calls → 429 | No |
| `load:shared` | 1 | Low — 1 provisioning, then burst | Yes ✓ |

Real users all work on the same project. `load:shared` simulates that accurately.

### Running for 150 concurrent users

1. Update `.env`:

```env
NUM_CANDIDATES=150
LOAD_VUS=150
LOAD_MAX_DURATION=30m
ENFORCE_BOOKING=false
```

2. Run:

```bat
npm run load:shared
```

3. Phase 1 takes ~3-5 minutes to provision 150 candidates (rate-limit retries included).

4. Phase 2 fires 150 VUs simultaneously — each performs all 6 activities.

### Expected output

**Phase 1 complete:**
```
Phase 1 complete:
  Project ID  : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Candidates  : 150 hrefs captured
  Hrefs file  : C:\Users\...\AppData\Local\Temp\shared-hrefs-<ts>.b64
```

**Phase 2 summary:**
```
checks.........................: 98%+ ✓ 
http_req_duration..............: p(95)<5000
ws_sessions....................: 900   (150 VUs × 6 activities)
iterations.....................: 150
```

### Known dev-environment behaviors

| Behavior | Cause | Impact |
|----------|-------|--------|
| `candidate portal theme: 500` (4/150) | Duplicate key race condition on first portal access | Non-blocking — activities still complete |
| `Accept Agreement: timeout` | Dev server overwhelmed at 10+ concurrent calls | Some VUs retry and succeed; reflects actual server capacity |
| `http_req_failed > 10%` | Dev environment rate limits | Expected; threshold is set at 10% for dev |
| `portal-tokens: 404` | Not available on dev env | Auto-fallback to invitation-href login |

These are **server-side findings** from the load test — exactly what load testing is meant to reveal.

---

## 8. Pre-Provisioned Candidate Load

```bat
npm run load:candidate
```

Runs a single pre-provisioned candidate against an existing project.

> ⚠️ **Dev environment limitation:** This command uses email+password login, but the dev API returns `403 Candidates are not allowed to access this resource` when accessing project details via password login. Candidate project access requires invitation href tokens on this environment. Use `npm run load:shared` instead for concurrent testing.

Configure in `.env`:

```env
CANDIDATE_EMAIL=your.candidate@yopmail.com
CANDIDATE_PASSWORD=...
ASSESSMENT_CANDIDATE_ID=...
ASSESSMENT_PROJECT_ID=...
```

---

## 9. Anam AI Validation

Full 3-phase E2E with Playwright browser automation:

```bat
npm run e2e:anam:disabled     # Anam disabled flow
npm run e2e:anam:healthy      # Anam enabled, healthy
npm run e2e:anam:outage503    # Anam 503 mid-session outage + recovery
npm run e2e:anam:network      # Anam network failure simulation
```

Each command runs:
- **Phase 1:** k6 provisions project + candidates, emits session data
- **Phase 2:** k6 audit candidates perform activities via API
- **Phase 3:** Playwright browser candidate completes activities with UI validation

Minimum `NUM_CANDIDATES=7` required (1 browser + 6 audit candidates).

Mid-session outage test (`outage503`):
1. Anam sessions start successfully
2. HTTP 503 injected mid-session
3. WebSocket traffic interrupted
4. Recovery window re-allows traffic
5. Session resumes and completes

---

## 10. Activity-Specific Load Commands

```bat
npm run load:situation        # Situation + Welcome activities only
npm run load:role-play        # Role Play + Welcome
npm run load:interview        # Interview + Welcome
npm run load:case             # Case Study + Welcome
npm run load:board-meeting    # Board Meeting + Welcome
npm run load:welcome          # Welcome only
npm run load:10               # Full scenario, 10 VUs
npm run load:client-project:10 # Client + Project creation only, 10 VUs
```

> Every stage requires exactly one Welcome activity. Focused scenarios automatically include Welcome alongside the target activity type.

---

## 11. Project Invitation Lifecycle

`SEND_PROJECT_INVITATIONS` controls whether invitation emails are sent.

| Value | Behavior |
|-------|----------|
| `true` | Full lifecycle: create → invite → ACTIVE → candidate can access |
| `false` | Provisioning only: project stays DRAFT, no candidate execution |

`npm run load:shared` always sets `SEND_PROJECT_INVITATIONS=true` internally for its Phase 1 provisioning, regardless of your `.env` value. This is required because candidates need valid invitation hrefs.

> The dev environment's `portal-tokens` endpoint returns 404. The suite automatically falls back to invitation-href login (access_token in URL) — this is expected and handled transparently.

---

## 12. Candidate Provisioning

All managed flows use `data/candidates.csv` as the seed file.

**Flow:**
```
data/candidates.csv
  → select NUM_CANDIDATES rows
  → generate unique per-run emails: john1.load.<timestamp>.1@yopmail.com
  → POST /candidate/create-for-project?projectId=...
  → bulk-assign returned IDs to project
  → verify all expected emails visible on project
```

The async CSV-upload endpoint (`/candidate/upload-candidates`) is intentionally not used — it does not return candidate IDs required for project assignment.

Email pattern: `john{N}.load.{timestamp}.{N}@yopmail.com`

`data/candidates.csv` contains 20 seed rows. `NUM_CANDIDATES` must not exceed the seed count.

---

## 13. Performance Profiles

```env
PERFORMANCE_PROFILE=auto      # strict for smoke, baseline for load (default)
PERFORMANCE_PROFILE=strict    # tight p95/p99 gates — low-concurrency validation
PERFORMANCE_PROFILE=baseline  # concurrency-aware — dev/load gate
PERFORMANCE_PROFILE=functional # correctness only — latency not gated
```

Baseline thresholds (dev environment):
- Global p95 < 2s
- Global p99 < 12s
- `Create Client` p95 < 3s
- Activity operations p95 < 5s

A run can complete all operations successfully but still exit non-zero if latency thresholds are crossed. This is intentional — correctness and performance are separate signals.

---

## 14. Reports

All managed runs write to `reports/`:

| File | Content |
|------|---------|
| `*.html` | Interactive HTML report |
| `*.json` | Raw k6 metrics data |
| `*-overview.csv` | High-level summary |
| `*-summary.csv` | Per-check summary |
| `*-aggregate.csv` | Aggregated metrics |
| `*-checks.csv` | Individual check results |

Playwright artifacts: `playwright/artifacts/`

All report files are Git-ignored.

---

## 15. Grafana / InfluxDB Monitoring

Start monitoring stack:

```bat
npm run monitoring:up
npm run monitoring:status
```

Run tests with live dashboard:

```bat
npm run smoke:grafana
npm run load:grafana
```

Access Grafana: `http://localhost:3000`

Stop monitoring:

```bat
npm run monitoring:down
```

The runner verifies InfluxDB connectivity before launching k6 and fails fast with a clear error if monitoring is unavailable.

---

## 16. Key `.env` Variables Reference

### Load control

| Variable | Default | Description |
|----------|---------|-------------|
| `NUM_CANDIDATES` | `10` | Candidates to provision per project |
| `LOAD_VUS` | `10` | Concurrent VUs in load phase |
| `LOAD_MAX_DURATION` | `10m` | Max Phase 2 duration |
| `LOAD_ITERATIONS_PER_VU` | `1` | Iterations per VU |

### Feature flags

| Variable | Default | Description |
|----------|---------|-------------|
| `SEND_PROJECT_INVITATIONS` | `false` | Send invitation emails |
| `ENFORCE_BOOKING` | `false` | Require booking before activities |
| `ANAM_MODE` | `disabled` | Anam AI mode |
| `ANUM_API_ENABLED` | `false` | Enable Anam API calls |

### Candidate execution

| Variable | Default | Description |
|----------|---------|-------------|
| `CANDIDATE_EXECUTION_SOURCE` | `auto` | `auto` / `generated` / `preprovisioned` / `both` / `none` |
| `SCENARIO` | `full` | Activity scenario (full / role-play-only / etc.) |

### Dev environment notes

- `portal-tokens` endpoint returns 404 — invitation-href login is used automatically
- `ENFORCE_BOOKING=false` — booking API returns 404 on dev
- `candidateAccess` project flag may show `false` even when project is ACTIVE — treated as diagnostic only

---

## 17. Troubleshooting

### `load:shared` shows `NUM_CANDIDATES=10` even with `npm run load:shared`

The runner reads `.env` directly. The `cross-env` values in the npm script are overridden by `.env`.

**Fix:** Update `.env`:
```env
NUM_CANDIDATES=150
LOAD_VUS=150
```

### `SHARED_CANDIDATE_HREFS is empty or invalid`

Phase 1 failed to emit hrefs. Check Phase 1 output for errors. Usually caused by:
- `NUM_CANDIDATES` exceeds seed rows in `data/candidates.csv` (max 20)
- Network timeout during provisioning
- Rate limiting (add retry delay)

### `Get Project Details → 403` in `load:candidate`

Dev environment requires invitation-href login. Email+password login succeeds but cannot access project APIs.

**Use `npm run load:shared` instead** — it uses invitation-href login automatically.

### `accept agreement: timeout` in Phase 2

Dev server is overwhelmed by concurrent agreement calls. This is a **server finding** — the test is doing its job.

Expected at 10+ concurrent VUs on dev. The suite retries and most VUs recover.

### `candidate portal theme: 500` (duplicate key error)

Race condition in backend on first portal access when multiple candidates log in simultaneously. Non-blocking — activities still complete. This is a backend issue revealed by load testing.

### `portal-tokens → 404`

Expected on dev. The suite automatically falls back to invitation-href login. No action needed.

### Phase 1 takes a long time (150 candidates)

Normal. The suite includes exponential backoff retries for 429 rate limits. Expect 3-5 minutes for 150 candidates on dev.

### `load:10` exits non-zero despite 100% checks

A latency threshold was crossed. Set `PERFORMANCE_PROFILE=baseline` or `PERFORMANCE_PROFILE=functional` for dev environment runs.

### `CommonProgramFiles(x86)` k6 error

Runners forward only `.env` variables to k6, not the full Windows environment. Run `npm run validate:e2e-runner` to diagnose.

### `candidate session → 403 assessment has not started yet`

Keep retry settings:
```env
BOOKING_START_SETTLE_MS=3000
SESSION_START_RETRY_ATTEMPTS=3
SESSION_START_RETRY_DELAY_MS=2500
```

---

## 18. Recommended Configurations

### Quick smoke test (verify everything works)

```env
NUM_CANDIDATES=10
LOAD_VUS=1
SEND_PROJECT_INVITATIONS=false
ENFORCE_BOOKING=false
ANAM_MODE=disabled
```

```bat
npm run smoke
```

### Verify 10 concurrent users (development check)

```env
NUM_CANDIDATES=10
LOAD_VUS=10
LOAD_MAX_DURATION=10m
SEND_PROJECT_INVITATIONS=false
ENFORCE_BOOKING=false
```

```bat
npm run load:shared
```

### Full 150 concurrent users (load test)

```env
NUM_CANDIDATES=150
LOAD_VUS=150
LOAD_MAX_DURATION=30m
SEND_PROJECT_INVITATIONS=false
ENFORCE_BOOKING=false
PERFORMANCE_PROFILE=baseline
```

```bat
npm run load:shared
```

> Phase 1 (~3-5 min) provisions 150 candidates. Phase 2 fires 150 VUs simultaneously — each performs all 6 activities against the same project.

### Anam outage validation

```env
NUM_CANDIDATES=10
SEND_PROJECT_INVITATIONS=true
ANAM_MODE=outage503
SIMULATE_ANAM_MID_SESSION_OUTAGE=true
ANAM_OUTAGE_AUTO_RECOVER=true
ANAM_OUTAGE_RECOVER_AFTER_MS=15000
```

```bat
npm run e2e:anam:outage503
```

### With live Grafana monitoring

```bat
npm run monitoring:up
npm run load:shared
```

Access dashboard at `http://localhost:3000`.

---

## Architecture Notes

### Why invitation-href login (not email+password)?

The dev environment's `portal-tokens` API (`/auth/candidate/portal-tokens`) returns 404. Invitation hrefs embed a signed `access_token` in the URL query string. The suite parses this token from the href and uses it directly — no password required, no portal-tokens call needed.

### Why temp file for hrefs (not CLI args)?

With 150 candidates, the base64-encoded hrefs JSON exceeds 4000 characters. Windows has a CLI argument length limit (ENAMETOOLONG). The runner writes the hrefs to a temp `.b64` file and passes the file path as `SHARED_CANDIDATE_HREFS_FILE`. k6's `open()` reads the file at init time.

### Why shared-project for concurrent load?

Isolated load (one project per VU) triggers 150 concurrent `Create Client` API calls → mass 429 rate limiting. Shared-project load uses 1 provisioning operation then fires all VUs against the same project — matching real-world usage where many candidates work in one hiring project simultaneously.
