# Symulate AI Load Testing & Monitoring Suite

**Production-grade k6 + Playwright load testing framework** for Symulate AI platform with real-time Grafana monitoring.

## 🎯 What This Project Does

This is a complete load testing infrastructure that simulates real users interacting with the Symulate AI assessment platform. It covers:

- ✅ **Smoke Testing** - Quick validation that everything works
- ✅ **Concurrent Load Testing** - Simulate 1-150+ users simultaneously on shared projects
- ✅ **Isolated Load Testing** - Test multiple independent projects
- ✅ **Anam AI Resilience** - Validate system behavior during AI service outages
- ✅ **Real-time Monitoring** - Live Grafana dashboards with InfluxDB metrics
- ✅ **Admin + Candidate Flow** - Full end-to-end lifecycle testing

---

## 📊 Project Architecture

```
symulate-load-tests/
├── 📁 tests/              # k6 test scripts (the actual load tests)
│   ├── smoke.js                        # Single-user validation
│   ├── smoke-no-anum-setup.js          # Project provisioning (Phase 1)
│   ├── smoke-no-anum-perform.js        # Activity execution (Phase 2)
│   ├── shared-project-admin-candidate-load.js  # Concurrent users on same project
│   ├── load-client-project.js          # Isolated project load tests
│   └── load-candidate-assessment.js    # Candidate-focused load tests
│
├── 📁 scripts/            # Node.js orchestration & automation
│   ├── run.js                          # Generic k6 runner with .env integration
│   ├── run-shared-project-load.js      # 2-phase shared-project orchestrator
│   ├── e2e-no-anum-full.js             # Playwright + k6 E2E automation
│   ├── generate-csv-report.js          # 6-file CSV report generator
│   ├── generate-professional-report.js # Professional HTML report
│   ├── export-influxdb-data.js         # InfluxDB → CSV (JMeter summary + URLs)
│   ├── report-utils.js                 # Shared report/naming helpers
│   ├── failure-utils.js                # Per-request failure capture
│   └── validate-project.js             # Environment validator
│
├── 📁 scenarios/          # Reusable k6 scenario modules
│   ├── login.js                        # Authentication flows
│   ├── clientcreation.js               # Organization provisioning
│   ├── taskcreation.js                 # Activity setup
│   ├── taskassign.js                   # Activity assignment
│   └── projectcreation.js              # Project lifecycle
│
├── 📁 utils/              # Shared utilities & helpers
│   ├── http.js                         # HTTP wrapper: retries, tags, failure capture
│   ├── helpers.js                      # Shared logic (report naming, IDs)
│   ├── routes.js                       # API route builders
│   ├── socketConversation.js           # WebSocket conversation flow
│   └── ...more utilities (data, cleanup, local-report, run-logger, webmAudio)
│
├── 📁 data/               # Test data & fixtures
│   ├── candidates.csv                  # Pre-defined candidate pool
│   ├── personas.js                     # AI persona definitions
│   ├── taskTemplates.js                # Activity templates
│   └── conversationScripts.js          # Conversation simulation data
│
├── 📁 config/             # Environment configurations
│   ├── environments.js                 # API endpoints per environment
│   └── thresholds.js                   # Performance thresholds
│
├── 📁 monitoring/         # Grafana + InfluxDB setup
│   ├── docker-compose.yml              # Monitoring stack
│   ├── dashboards/
│   │   └── symulate-k6-live-dashboard.json  # Pre-configured dashboard
│   ├── grafana-provisioning/           # Auto-provisioning configs
│   └── GRAFANA_SETUP.md                # Detailed monitoring guide
│
├── 📁 playwright/         # Browser automation tests
│   ├── no-anum-e2e-validation.js       # Full E2E with real browser
│   └── lib/reporter.js                 # Custom test reporter
│
├── 📁 reports/            # Generated test reports (git-ignored)
│
├── .env                   # ⚠️ Your secrets (NEVER commit this)
├── .env.example           # Template for .env setup
├── package.json           # All npm scripts defined here
└── README.md              # You are here
```

### 🔄 How It Works

**For Reviewers: The Complete Flow**

1. **Configuration**: Everything starts from `.env` file (single source of truth)
2. **Test Selection**: Run specific npm command based on test goal
3. **Orchestration**: `scripts/run.js` or `run-shared-project-load.js` prepare environment
4. **Execution**: k6 runs the test scripts with injected environment variables
5. **Monitoring**: (Optional) Metrics stream to InfluxDB → visualized in Grafana
6. **Reporting**: Results saved to `reports/` directory

**Example: `npm run load:shared` (10 concurrent users)**

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Read .env (NUM_CANDIDATES=10, LOAD_VUS=10)             │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. scripts/run-shared-project-load.js starts               │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: Provision (Sequential)                            │
│   • Super Admin login                                       │
│   • Create 1 Client org                                     │
│   • Create 6 activities (Role Play, Interview, etc.)        │
│   • Create 1 Project with all activities                    │
│   • Provision 10 unique candidates from candidates.csv      │
│   • Send invitations → Project becomes ACTIVE               │
│   • Capture all 10 invitation URLs                          │
│   ⏱️ Duration: ~1 minute                                    │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ Wait 65 seconds (rate limit cooldown)                      │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Concurrent Load (Parallel)                        │
│                                                             │
│   VU 1 (john1@) ──┐                                        │
│   VU 2 (john2@) ──┤                                        │
│   VU 3 (john3@) ──┤                                        │
│   VU 4 (john4@) ──┤ → All log in via invitation URL       │
│   VU 5 (john5@) ──┤ → Each performs 5-6 activities        │
│   VU 6 (john6@) ──┤ → WebSocket conversations             │
│   VU 7 (john7@) ──┤ → Mark activities COMPLETED           │
│   VU 8 (john8@) ──┤                                        │
│   VU 9 (john9@) ──┤                                        │
│   VU 10(john10@) ─┘                                        │
│                                                             │
│   ⏱️ Duration: ~2 minutes (concurrent execution)            │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. Results                                                  │
│   • 100% checks passed ✓                                    │
│   • 10 iterations completed                                 │
│   • 60 WebSocket sessions (10 VUs × 6 activities)          │
│   • Metrics in InfluxDB (if Grafana enabled)               │
│   • HTML report in reports/ directory                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Installation](#2-installation)
3. [Environment Setup (.env)](#3-environment-setup-env)
4. [Quick Start — Which Command to Use](#4-quick-start--which-command-to-use)
5. [Smoke Test (`npm run smoke`)](#5-smoke-test)
6. [Shared-Project Concurrent Load Test (`npm run load:shared`)](#6-shared-project-concurrent-load-test) ⭐
7. [Isolated Load Test (`npm run load`)](#7-isolated-load-test)
8. [Anam AI Validation](#8-anam-ai-validation)
9. [Key `.env` Variables Explained](#9-key-env-variables-explained)
10. [Common Mistakes & Fixes](#10-common-mistakes--fixes)
11. [Reports](#11-reports)
12. [Grafana / InfluxDB Monitoring](#12-grafana--influxdb-monitoring)

---

## 1. Prerequisites

| Tool           | Purpose                     |
| -------------- | --------------------------- |
| Node.js 20+    | Runner scripts              |
| npm            | Package management          |
| k6             | Load test execution         |
| Docker Desktop | Grafana/InfluxDB (optional) |
| Chromium       | Playwright browser tests    |

```bat
node --version
npm --version
k6 version
```

---

## 2. Installation

```bat
npm install
K6 Installation Windows
If you use the Chocolatey package manager you can install the unofficial k6 package with:

choco install k6
If you use the Windows Package Manager, install the official packages from the k6 manifests (created by the community):

winget install k6 --source winget
Alternatively, you can download and run the latest official installer.

Docker
Bash

docker pull grafana/k6
We also have a separate image you can use with chromium installed to run k6 browser tests.

Bash

docker pull grafana/k6:master-with-browser


Verify the Installation

Open a new terminal or command prompt window and check the installed version:
bash
k6 version
copy .env.example .env
winget install k6 --source winget
```

Fill `.env` with real credentials. Never commit `.env` — it is Git-ignored.

```bat
npm run validate
```

---

## 3. Environment Setup (.env)

This is the **single source of truth** for all test configuration. Every command reads from `.env` — no other place controls the test behavior.

### Minimal working `.env` for smoke test:

```env
ENV=dev
API_URL=https://api.symulate.weuno.co/dev/api
SUPER_ADMIN_URL=https://superadmin.symulate-dev.weuno.co
CLIENT_ADMIN_URL=https://client-admin.symulate-dev.weuno.co
CANDIDATE_URL=https://symulate-ai-dev.weuno.co

SUPER_ADMIN_EMAIL=superadmin@yopmail.com
SUPER_ADMIN_PASSWORD=

# Test behavior
LOAD_MODE=smoke                    # smoke = 1 VU | load = LOAD_VUS VUs
NUM_CANDIDATES=10                  # candidates per project
LOAD_VUS=10                        # concurrent VUs (only used in load mode)
LOAD_ITERATIONS_PER_VU=1          # ⚠️ keep at 1 — higher = multiplied orgs created
LOAD_MAX_DURATION=5m

SEND_PROJECT_INVITATIONS=true      # true = project ACTIVE | false = project stays DRAFT
CANDIDATE_EXECUTION_SOURCE=generated  # generated | preprovisioned | both | none

ENFORCE_BOOKING=false              # false on dev env (booking API returns 404)
ANAM_MODE=disabled
ANUM_API_ENABLED=false
```

### ⚠️ Critical settings that cause confusion:

| Setting | Wrong value | What happens | Correct value |
|---------|-------------|-------------|---------------|
| `LOAD_MODE` | `load` when running smoke | Creates `LOAD_VUS × LOAD_ITERATIONS_PER_VU` orgs | `smoke` |
| `LOAD_ITERATIONS_PER_VU` | `10` | 10 VUs × 10 iterations = 100 orgs in 1 run | `1` |
| `SEND_PROJECT_INVITATIONS` | `false` | Project stays DRAFT, candidates can't access | `true` |
| `CANDIDATE_EXECUTION_SOURCE` | empty or `none` | Activities never run | `generated` |
| `ANUM_API_ENABLED` / `ANAM_MODE` | `enable` / `enabled` / `yes` / `1` | Parsed as **false** silently (code checks `=== 'true'`) | `true` or `false` |

---

## 4. Quick Start — Which Command to Use

### 🎯 Common Test Scenarios

| Your Goal                | Command                       | Duration | What It Does                            |
| ------------------------ | ----------------------------- | -------- | --------------------------------------- |
| **Quick validation**     | `npm run smoke`               | ~30s     | 1 user completes full flow              |
| **10 users (concurrent)**| `npm run load:shared`         | ~3min    | 10 users on same project (~10 peak)     |
| **50 users (ramped)**    | `npm run load:shared`         | ~7min    | NUM_CANDIDATES=50 (~50 peak concurrent) |
| **150 users (ramped)**   | `npm run load:shared`         | ~12min   | NUM_CANDIDATES=150 (~64 peak — see note)|
| **Live monitoring**      | `npm run load:shared:grafana` | ~3min    | With real-time Grafana dashboard        |
| **Isolated projects**    | `npm run load`                | ~5min    | Each VU creates own project             |
| **AI outage test**       | `npm run e2e:anam:outage503`  | ~10min   | Validates resilience during AI downtime |

> **⚠️ "Concurrent users" vs. total users — read before quoting numbers.**
> `load:shared` provisions `NUM_CANDIDATES` users and starts them **paced** by
> `LOAD_VU_START_INTERVAL_SECONDS` (default **1.5s**), not all at once. This
> variable is read **by the test itself** (it used to be exported by the runner
> and ignored, while the test hardcoded 500 ms — which is why older peak numbers
> were wrong). With each VU running ~96s, the *estimated* peak running
> simultaneously is:
>
> ```
> peak concurrent ≈ VU duration ÷ start interval ≈ 96s ÷ 1.5s ≈ 64
> ```
>
> That is only an estimate — **every run measures the real value** from the
> per-VU `WORK_START`/`WORK_END` windows and prints it. Quote the measurement,
> not the formula:
>
> ```
> [peak] executing VUs: peak=64 of 150 started (ramp span ~225s)
> PEAK_CONCURRENT_VUS=64 STARTED_VUS=150
> ```
>
> (k6's builtin `vus` metric is *not* this number — it counts VUs that are only
> sleeping through their stagger, so it always reads the full VU count.)
>
> So **10 and 50 users are genuinely ~concurrent** (below the cap), but **150 users
> means 150 total ramped over ~225s with a ~64-user peak** — not 150 simultaneous.
> To actually hold 150 simultaneous, lower `LOAD_VU_START_INTERVAL_SECONDS`
> (e.g. `0.5` → ~190 peak), accepting the heavier burst the backend sees, and
> confirm it from `PEAK_CONCURRENT_VUS=`.

### 📋 All Available Commands

#### Core Testing

```bat
npm run smoke                    # Single-user validation (1 VU)
npm run load:shared              # Concurrent users on shared project (PRIMARY)
npm run load:shared:admin        # Same as load:shared (alias)
npm run load:shared:keep         # Same run, but skip Phase 3 cleanup
npm run cleanup:shared           # Delete leftovers from an earlier run
npm run load                     # Isolated projects (1 project per VU)
npm run load:client-project      # Client-specific load test
npm run load:candidate           # Candidate-focused load test
```

#### Grafana-Enabled Testing

```bat
npm run load:shared:grafana      # Shared load with live metrics ⭐
npm run admin:shared:grafana     # Same as above (alias)
npm run smoke:grafana            # Smoke test with live metrics
npm run load:grafana             # Isolated load with live metrics
npm run load:grafana:no-anum     # Without Anam API
```

#### Anam AI Validation

```bat
npm run e2e:anam:disabled        # Anam disabled flow
npm run e2e:anam:healthy         # Anam enabled & healthy
npm run e2e:anam:outage503       # Mid-session 503 outage simulation
npm run e2e:anam:network         # Network failure simulation
```

#### Monitoring

```bat
npm run monitoring:up            # Start Grafana + InfluxDB
npm run monitoring:down          # Stop monitoring stack
npm run monitoring:status        # Check container status
npm run monitoring:reset         # Clear all data & restart
```

#### Utilities

```bat
npm run validate                 # Validate .env configuration
npm run report:csv               # Generate CSV reports from results
npm run report:professional      # Generate professional HTML report
npm run report:grafana           # Export InfluxDB/Grafana data to CSV
```

> `report:professional` and `report:grafana` do **not** exist in `package.json` —
> the HTML report is written by every run automatically, and there is no
> InfluxDB→CSV exporter yet.

---

## 5. Smoke Test

**Purpose:** Verify the full lifecycle works end-to-end with 1 VU.

### Required `.env`:

```env
LOAD_MODE=smoke
SEND_PROJECT_INVITATIONS=true
CANDIDATE_EXECUTION_SOURCE=generated
NUM_CANDIDATES=10
LOAD_ITERATIONS_PER_VU=1
```

```bat
npm run smoke
```

### What runs:

```
1 Super Admin login
→ Create 1 Client (organization)
→ Create 6 activities (Role Play, Interview, Case, Situation, Board Meeting, Welcome)
→ Create 1 Project + Stage + assign activities
→ Provision NUM_CANDIDATES candidates from data/candidates.csv
→ Send invitations → Project becomes ACTIVE
→ 1 candidate logs in via invitation href
→ Accepts agreement → performs all 6 activities
→ Each activity: start session → WebSocket transcript → mark COMPLETED
→ Teardown (if ENABLE_TEARDOWN=true)
```

### Expected output:

```
checks: 100.00% ✓ 90  ✗ 0
managed_clients_created: 1
managed_projects_created: 1
project active: status ACTIVE ✓
```

### Project stays DRAFT?

```env
SEND_PROJECT_INVITATIONS=true   ← must be true
```

### Candidates not performing?

```env
CANDIDATE_EXECUTION_SOURCE=generated   ← must not be empty or none
```

---

## 6. Shared-Project Concurrent Load Test

> ⭐ **Primary command for concurrent user load testing**

**Purpose:** N unique candidates simultaneously perform all activities on the same project.

### Required `.env`:

```env
NUM_CANDIDATES=10          # set to how many concurrent users you want
LOAD_VUS=10                # must equal NUM_CANDIDATES
LOAD_MAX_DURATION=10m
SEND_PROJECT_INVITATIONS=false   # runner sets this to true internally
ENFORCE_BOOKING=false
LOAD_TEST_INITIAL_GAP_SECONDS=65  # let an earlier global-IP limiter window expire
LOAD_TEST_PHASE_GAP_SECONDS=65    # separate provisioning traffic from measured load
LOAD_VU_START_INTERVAL_SECONDS=1.5
HTTP_429_MAX_RETRIES=0             # don't amplify throttling during a load run
```

For a **local-only** backend started with `NODE_ENV=local`, add
`EXPOSE_CANDIDATE_PORTAL_LINKS=true` to the backend environment and restart it.
The invitation endpoint only includes candidate bearer links in its response
for `NODE_ENV=dev`, or for `NODE_ENV=local` when this explicit opt-in is true.
Do not enable this flag in UAT/production. The runner redacts returned links and
tokens from terminal output while retaining them in memory for Phase 2.

Capacity testing and rate-limit testing are separate runs. The backend's default
`RATE_LIMIT_MAX=100` can reject a full multi-activity run because all VUs share
one source IP. For local/staging **capacity testing only**, use a test-only
allowance such as `RATE_LIMIT_MAX=2000` with `RATE_LIMIT_WINDOW=60`; keep the
production limit and auth/invitation abuse limits unchanged. Restore the normal
staging value after the run. If you want to validate rate limiting, run that
scenario separately with the normal limits.

```bat
npm run load:shared
```

### Three-phase flow:

**Phase 1 — Provision (sequential, ~1-5 min):**

```
Super Admin
  → Create 1 Client
  → Create 6 activities
  → Create 1 Project with all activities assigned
  → Provision NUM_CANDIDATES unique candidates
  → Send invitations → Project ACTIVE
  → Capture all invitation hrefs → save to temp file
```

**Phase 2 — Concurrent load (VU starts are paced by the configured interval):**

```
VU 1  → john1@ → invitation href login → 6 activities ✓
VU 2  → john2@ → invitation href login → 6 activities ✓
VU 3  → john3@ → invitation href login → 6 activities ✓
...
VU N  → johnN@ → invitation href login → 6 activities ✓

[peak] executing VUs: peak=10 of 10 started (ramp span ~14s)
PEAK_CONCURRENT_VUS=10 STARTED_VUS=10
```

**Phase 3 — Cleanup (runs even when Phase 2 fails):**

```
Super Admin → DELETE 150 candidates → DELETE project → DELETE organisation
[cleanup] OK — this run left no data behind.
```

Phase 1 still sets `ENABLE_TEARDOWN=false` internally (so its own teardown does
not delete the project Phase 2 is about to use); **Phase 3 is what actually
deletes the run's organisation, project and candidates.** Control it with:

| You want                              | Use                                              |
| ------------------------------------- | ------------------------------------------------ |
| auto-clean after every run (default)  | `npm run load:shared`                            |
| keep the data for inspection          | `npm run load:shared:keep` or `ENABLE_TEARDOWN=false` |
| clean up leftovers from an older run  | `npm run cleanup:shared SHARED_PROJECT_ID=<id> SHARED_ORG_ID=<id>` |

### Scale examples:

| `.env`                             | Concurrent users | Phase 1 time |
| ---------------------------------- | ---------------- | ------------ |
| `NUM_CANDIDATES=5, LOAD_VUS=5`     | 5                | ~30s         |
| `NUM_CANDIDATES=10, LOAD_VUS=10`   | 10               | ~1 min       |
| `NUM_CANDIDATES=50, LOAD_VUS=50`   | 50               | ~2 min       |
| `NUM_CANDIDATES=150, LOAD_VUS=150` | 150              | ~5 min       |

### Why not `npm run load` for 150 users?

`npm run load` creates one project per VU — 150 VUs = 150 concurrent `Create Client` calls = **mass 429 rate limiting**. `load:shared` creates **one** project then paces all VUs against it, which **avoids the mass provisioning storm** (no 150 parallel `Create Client` calls). A global per-IP rate limit still applies to the backend, which is why the config uses `LOAD_TEST_INITIAL_GAP_SECONDS` / `LOAD_TEST_PHASE_GAP_SECONDS` cooldowns and a paced VU start — see the required `.env` above.

### Expected output for 10 VUs:

```
Phase 1 complete:
  Project ID  : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Candidates  : 10 hrefs captured
  Hrefs file  : C:\Users\...\AppData\Local\Temp\shared-hrefs-<ts>.b64
  RAMP: VU start interval = 1.5s (LOAD_VU_START_INTERVAL_SECONDS)

checks: 98%+
ws_sessions: 60   (10 VUs × 6 activities)
iterations: 10

[peak] executing VUs: peak=10 of 10 started (ramp span ~14s)
PEAK_CONCURRENT_VUS=10 STARTED_VUS=10

=== Phase 3/3 — k6: delete project, org and candidates ===
[cleanup] OK — this run left no data behind.
=== All phases complete — Phase1=0, Phase2=0, cleanup=ok, final=0 ===
```

### Known dev-environment behaviors (not script bugs):

| Log message                   | Cause                                                                                              | Impact                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `candidate portal theme: 500` | DB race condition on first concurrent portal access                                                | Non-blocking                                                                                             |
| `portal-tokens: 404`          | Deprecated endpoint; shared-load setup no longer calls it                                          | Candidate token comes from invitation response links                                                     |
| No candidate hrefs captured   | Backend is local without`EXPOSE_CANDIDATE_PORTAL_LINKS=true`, or invitation response omitted links | Enable the local-only opt-in and restart backend; the script now aborts before Phase 2 if no href exists |
| `Accept Agreement: timeout`   | Server overwhelmed at 10+ concurrent                                                               | Some VUs retry and succeed                                                                               |
| `http_req_failed > 10%`       | Dev server rate limits                                                                             | **Fails the run now** — `load:shared` is gated by `config/thresholds.js` (default `dev → baseline` = < 1%). Loosen deliberately with `PERFORMANCE_PROFILE=functional` if the environment is the known cause |

---

## 7. Isolated Load Test

**Purpose:** Each VU creates its own independent project + candidates.

### Required `.env`:

```env
LOAD_MODE=load
LOAD_VUS=5
LOAD_ITERATIONS_PER_VU=1      # ⚠️ always keep at 1
NUM_CANDIDATES=10
SEND_PROJECT_INVITATIONS=true
CANDIDATE_EXECUTION_SOURCE=generated
```

```bat
npm run load
```

**With `LOAD_VUS=5`:**

```
VU 1 → Client A → Project A → 10 candidates → activities
VU 2 → Client B → Project B → 10 candidates → activities
...
VU 5 → Client E → Project E → 10 candidates → activities
```

Total: 5 clients, 5 projects, 50 candidates.

> ⚠️ **`LOAD_ITERATIONS_PER_VU` warning:** Setting this to 10 with 10 VUs = 100 organizations in one run. Always keep at `1` unless you deliberately want iteration-based stress testing.

---

## 8. Anam AI Validation

Full E2E with Playwright browser automation + k6 API validation.

```bat
npm run e2e:anam:disabled       # Anam disabled flow
npm run e2e:anam:healthy        # Anam enabled, healthy
npm run e2e:anam:outage503      # Mid-session 503 outage + recovery
npm run e2e:anam:network        # Network failure simulation
```

Minimum `NUM_CANDIDATES=7` required for Anam E2E (1 browser + 6 audit candidates).

`load:shared` with any `NUM_CANDIDATES` works — the 7-minimum check is bypassed automatically in shared-load mode.

---

## 9. Key `.env` Variables Explained

### What controls what:

```
LOAD_MODE=smoke          → npm run smoke always uses 1 VU regardless of LOAD_VUS
LOAD_MODE=load           → npm run load uses LOAD_VUS concurrent VUs

NUM_CANDIDATES           → candidates provisioned per project
LOAD_VUS                 → concurrent VUs in Phase 2 (load:shared) or isolated load
LOAD_ITERATIONS_PER_VU  → how many times each VU repeats the full flow
                           (1 = safe, 10 with 10 VUs = 100 orgs created!)

SEND_PROJECT_INVITATIONS=true   → project becomes ACTIVE, candidates can log in
SEND_PROJECT_INVITATIONS=false  → project stays DRAFT, no candidate access

CANDIDATE_EXECUTION_SOURCE=generated     → use newly created candidate
CANDIDATE_EXECUTION_SOURCE=preprovisioned → use CANDIDATE_EMAIL from .env
CANDIDATE_EXECUTION_SOURCE=both          → run both
CANDIDATE_EXECUTION_SOURCE=none          → skip activities (provision only)
CANDIDATE_EXECUTION_SOURCE=             → empty = same as none ⚠️
```

### Dev environment specific:

```env
ENFORCE_BOOKING=false     # booking API returns 404 on dev — must be false
ANUM_API_ENABLED=false    # Anam API disabled on dev
```

> **⚠️ Known naming quirk — "Anam" vs "Anum".** The product feature is **"Anam"**
> (the AI service), but a legacy typo produced the env var **`ANUM_API_ENABLED`**
> and the `no-anum` npm-script/command suffix. Both spellings therefore appear in
> the codebase and CLI (`smoke:no-anum`, `ANUM_API_ENABLED`, ...). They refer to the
> **same thing**. Treat `ANUM_*` as an alias for `ANAM_*` — don't "fix" one without
> the other or the scripts will break.

---

## 10. Common Mistakes & Fixes

### Too many clients/organizations being created

**Cause:** `LOAD_ITERATIONS_PER_VU` set high (e.g. 10) with multiple VUs.

**Fix:**

```env
LOAD_ITERATIONS_PER_VU=1
```

### Project stays DRAFT

**Cause:** `SEND_PROJECT_INVITATIONS=false`

**Fix:**

```env
SEND_PROJECT_INVITATIONS=true
```

### Candidates not performing activities

**Cause:** `CANDIDATE_EXECUTION_SOURCE` is empty or `none`

**Fix:**

```env
CANDIDATE_EXECUTION_SOURCE=generated
```

### `load:shared` shows wrong NUM_CANDIDATES

**Cause:** `.env` is the only source of truth — `cross-env` in npm scripts is ignored.

**Fix:** Update `.env` directly:

```env
NUM_CANDIDATES=150
LOAD_VUS=150
```

### Phase 1 aborts: `requires at least 7 candidates`

**Cause:** Running `load:shared` with `NUM_CANDIDATES < 7` was blocked by Anam E2E check.

**Status:** Fixed — `load:shared` bypasses this check automatically via `CANDIDATE_EXECUTION_SOURCE=none`.

### `Get Project Details → 403` in `npm run load:candidate`

**Cause:** Dev environment requires invitation-href token for project access. Email+password login cannot access project APIs.

**Fix:** Use `npm run load:shared` instead — it uses invitation-href login automatically.

### 429 Rate Limiting

All HTTP calls now log:

```
[429 RATE LIMIT] flow="Create Project Candidate 3/10" url="https://api...."
[RETRY] ... retry 1/3 after 2s
```

This tells you exactly which endpoint is being rate-limited. **By default the suite retries up to 3 times with exponential backoff** (`HTTP_429_MAX_RETRIES=3`). Load runs (`load:shared`) deliberately set `HTTP_429_MAX_RETRIES=0` so retries don't amplify throttling during measurement.

### `href token not found ... expected access_token in the email login href` (prod / UAT)

**Cause:** The harness does **not** read the candidate's inbox. It gets the candidate login link from the `accessMyPortal` field that the **invitation API returns** (`scenarios/projectcreation.js` → `allInvitationHrefs`). The backend only populates that field when `EXPOSE_CANDIDATE_PORTAL_LINKS=true` — a local/dev-only opt-in. For `NODE_ENV=dev` the links are included automatically, but **UAT/prod intentionally omit them** (returning candidate bearer tokens in an API response is a security risk).

So pointing `API_URL` at `https://api.symulate.ai/prod/api` makes the invitation response come back **without** candidate portal links → no `access_token` → `candidateSessionFromInviteHref()` returns null → the candidate flow logs the message and returns zero activities. This is **expected in prod**, not a script bug.

**Fix options:**

- Run the candidate-assessment / `load:shared` flow against the **dev** backend (where links are exposed) — this is what the suite is designed for.
- If you must load-test prod, ask the backend team to enable `EXPOSE_CANDIDATE_PORTAL_LINKS=true` on the prod env **temporarily** (explicit security trade-off), restart it, then rerun Phase 1. Do **not** leave it on in prod.
- The harness prints this exact hint in shared-load mode when no href is captured, and aborts before Phase 2 rather than running a meaningless load.

### `href token not found ... expected access_token in the email login href` (prod / UAT)

**Cause:** The harness does **not** read the candidate's inbox. It gets the candidate login link from the `accessMyPortal` field that the **invitation API returns** (`scenarios/projectcreation.js` → `allInvitationHrefs`). The backend only populates that field when `EXPOSE_CANDIDATE_PORTAL_LINKS=true` — a local/dev-only opt-in. For `NODE_ENV=dev` the links are included automatically, but **UAT/prod intentionally omit them** (returning candidate bearer tokens in an API response is a security risk).

So pointing `API_URL` at `https://api.symulate.ai/prod/api` makes the invitation response come back **without** candidate portal links → no `access_token` → `candidateSessionFromInviteHref()` returns null → the candidate flow logs the message and returns zero activities. This is **expected in prod**, not a script bug.

**Fix options:**
- Run the candidate-assessment / `load:shared` flow against the **dev** backend (where links are exposed) — this is what the suite is designed for.
- If you must load-test prod, ask the backend team to enable `EXPOSE_CANDIDATE_PORTAL_LINKS=true` on the prod env **temporarily** (explicit security trade-off), restart it, then rerun Phase 1. Do **not** leave it on in prod.
- The harness prints this exact hint in shared-load mode when no href is captured, and aborts before Phase 2 rather than running a meaningless load.

---

## 11. Reports

All runs automatically generate comprehensive reports in `reports/`:

### Automatic Report Generation

Every test (smoke, load, grafana) automatically creates **6 CSV files + HTML + JSON**:

#### Generated Files:

| File Type | Content | Use Case |
|-----------|---------|----------|
| **HTML** | Interactive dashboard | Quick visual review in browser |
| **JSON** | Raw k6 metrics | Programmatic analysis, CI/CD integration |
| **-overview.csv** | High-level summary | Executive summary, quick metrics |
| **-summary.csv** | Per-endpoint JMeter-style | Performance comparison, SLA validation |
| **-aggregate.csv** | With percentiles (P90/P95/P99) | Detailed latency distribution |
| **-checks.csv** | All assertion results | Test validation, failure analysis |
| **-url-details.csv** ⭐ | Complete URL list with metrics | **"Which URLs were hit?"** analysis |
| **-all-metrics.csv** ⭐ | Every k6 metric | Complete test execution data |
| **failures-latest.json** | Per-request failures (code + message) | Feeds HTML *Failed Requests* table |
| **jmeter-endpoint-summary-*.csv** | JMeter-style per-endpoint (from InfluxDB) | SLA / capacity analysis |

### Report Naming Convention

All reports use a consistent **`symulate`** prefix (the separate "happening" project uses its own naming — never mix the two). The base name is built by `reportName()` in `utils/helpers.js`:

```
<prefix>-<LOAD_MODE>-<SCENARIO>[-<anam-tag>]-<timestamp>
```

- **Prefix is always `symulate...`** — e.g. `symulate-smoke-full`, `symulate-shared-admin-candidate-load`.
- **Anam tag** (`-with-anam` / `-without-anam`) is added **only** for Anam-outage runs: `SCENARIO=situation-only`, or the anam/anum commands (`smoke:no-anum:setup`, `smoke:no-anum:perform`, `smoke:no-anum:session-audit`). **Normal runs carry no tag.**

Derived filenames always start from a clean base (`report-utils.js` strips legacy `symulate-`/`symulate-report-`/`PROFESSIONAL-`/`report-` prefixes):

| Output | Pattern |
|--------|---------|
| k6 native HTML/JSON | `symulate-<base>.json` (written by the test) |
| Professional HTML | `symulate-<base>.html` |
| 6-file CSV set | `symulate-report-<base>-{overview,summary,aggregate,checks,url-details,all-metrics}.csv` |
| JMeter endpoint summary (InfluxDB) | `jmeter-endpoint-summary-<ts>.csv` |
| Full-URL detail (InfluxDB) | `url-details-<ts>.csv` |
| Failure sidecar | `failures-latest.json` |

### Failed Request Capture (status code + message)

k6's summary only reports the **aggregated** failure rate — never *which* request failed or *why*. This suite captures every failed request at the source:

1. **`utils/http.js`** — each wrapper routes through `finish()`, which for any response with **status ≥ 400** or a **network error** emits one structured line:
   ```
   [FAILED_REQUEST] {"name":"Login - Load Test Admin","method":"POST","url":"https://api.../auth/login","status":429,"errorCode":1429,"message":"Too many login attempts...","at":"2026-10-16T07:36:47Z"}
   ```
   The `message` is pulled from the JSON body's `message`/`error` field (else the raw body, else the network error text).
2. **`scripts/failure-utils.js`** — both runners (`run.js` and `run-shared-project-load.js`) tee k6's stderr, parse these lines, and write `reports/failures-latest.json` on **every** run (an empty array clears stale failures).
3. The **professional HTML report** renders them under *Detailed Findings → Failed Requests* as a table: Time · Label · Method · Status (color-coded 4xx/5xx) · Failure Message · URL.

> `failures-latest.json` is a sidecar, not a k6 report — the report picker (`latestJsonReport()`) explicitly excludes it so it's never mistaken for test data.

### CSV Report Details

**1. overview.csv** - Executive Summary
```csv
Metric,Value
Report Type,Symulate Load Test Report
Generated At,2026-10-15T12:17:39Z
Total Requests,171
Failed Requests,0
Failed Request %,0
Total Checks,282
Checks Passed %,100
Total Iterations,10
Total VUs,10
Avg Response Time (ms),237.01
P95 Response Time (ms),451.09
P99 Response Time (ms),620.57
Total Data Received (bytes),2447360
Total Data Sent (bytes),10660
WebSocket Sessions,50
WS Messages Sent,640
WS Messages Received,1190
```

**2. url-details.csv** ⭐ (NEW!)
```csv
URL/Endpoint,# Requests,Avg (ms),Median (ms),Min (ms),Max (ms),P90 (ms),P95 (ms),P99 (ms)
Login - Client Admin,10,315.2,310.5,290.1,355.8,340.2,350.0,355.0
Get Project Details,10,201.4,198.5,180.2,250.3,230.5,240.1,248.0
Create Project Candidate 1/10,10,277.0,270.0,240.0,310.0,295.0,305.0,309.0
...all endpoints listed...
```
**Shows exactly which APIs were called and their performance!**

**3. all-metrics.csv** ⭐ (NEW!)
```csv
Metric Name,Count,Rate (%),Avg,Min,Median,Max,P90,P95,P99
http_reqs,171,0,0,0,0,0,0,0,0
http_req_duration,171,0,237.01,146.7,198.07,1220,351.81,451.09,620.57
http_req_failed,0,0,0,0,0,0,0,0,0
ws_sessions,50,0,0,0,0,0,0,0,0
ws_msgs_sent,640,0,0,0,0,0,0,0,0
iterations,10,0,96000,79000,97000,113000,109000,111000,113000
vus_max,10,0,10,10,10,10,10,10,10
...complete metrics...
```
**Every metric k6 captured, in one file!**

### Example: After Running `npm run load:shared`

```
reports/
├── symulate-shared-admin-candidate-load-2026-10-15T12-17-39-676Z.json   (raw k6 data)
├── symulate-shared-admin-candidate-load-2026-10-15T12-17-39-676Z.html   (professional ⭐)
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-overview.csv
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-summary.csv
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-aggregate.csv
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-checks.csv
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-url-details.csv  ⭐
├── symulate-report-shared-admin-candidate-load-2026-10-15T12-17-39-676Z-all-metrics.csv  ⭐
└── failures-latest.json   (per-request failures → HTML Failed Requests table)
```

### Manual CSV Generation

If you need to regenerate CSVs from an existing JSON report:

```bat
npm run report:csv
```

This finds the latest JSON report and generates all 6 CSV files.

### Opening Reports

**HTML Report:**
```bat
# Open in browser (Windows)
start reports\shared-admin-candidate-load-*.html
```

**CSV Reports:**
```bat
# Open in Excel
start reports\symulate-report-*-url-details.csv
```

**Professional HTML Report:**
```bat
# Open comprehensive report in browser (Windows)
start reports\symulate-*.html
```

---

## Professional Load Test Reports

Every test automatically generates a **comprehensive, industry-standard HTML report** with:

### 9-Section Report Structure

#### 1. 📊 Executive Summary
- Test objective and scope
- Test duration and environment
- Key performance metrics (requests, throughput, response time)
- Critical issues count with severity breakdown

#### 2. ⚙️ Test Configuration
- Environment (staging/prod)
- Virtual Users (VUs)
- Test duration
- Scenario details

#### 3. 📈 Summary Graphs & Charts
- Response time distribution
- Data transfer visualization
- *Note: Charts show test totals; see Grafana for real-time graphs*

#### 4. 🎯 Performance Metrics

**HTTP Metrics:**
- Total requests
- Requests/sec rate
- Response time percentiles (p50, p90, p95, p99)
- Connection time breakdown (connecting, TLS handshaking, sending, waiting, receiving)

**WebSocket Metrics:**
- Active sessions
- Messages sent/received
- Session duration

**Throughput:**
- Data received/sent
- Network efficiency

#### 5. 🔍 Endpoint Analysis
- Per-URL performance breakdown
- Request counts per endpoint
- Response time statistics (avg/median/min/max/p90/p95/p99)
- *Links to detailed url-details.csv*

#### 6. ⚠️ Detailed Findings

**Automatic Issue Detection** with severity classification:

| Severity | Badge Color | Error Rate | p95 Response Time |
|----------|-------------|------------|-------------------|
| 🔴 **Critical** | Red | >5% | >3000ms |
| 🟠 **High** | Orange | >2% | >2000ms |
| 🟡 **Medium** | Yellow | >1% | >1000ms |
| 🟢 **Low** | Green | <1% | <1000ms |

**Each finding includes:**
- Description of the issue
- Evidence (actual metrics)
- Actionable recommendations

**Example Finding:**
```
⚠️ HIGH - High Error Rate (3.2%)

Evidence:
- Error rate: 3.2% (5 failed / 171 total)
- Threshold: 2%

Recommendations:
- Investigate server logs for 5xx errors
- Check database connection pool
- Review rate limiting configuration
```

#### 7. ✅ Test Validation
- Total checks performed
- Pass/fail counts
- Pass percentage

#### 8. 📋 Methodology
- Test approach and objectives
- Tools used (k6, Grafana, InfluxDB, Playwright)
- Test phases (provisioning, load execution)
- Load pattern description

#### 9. 📎 Appendices
- Links to all 6 CSV reports
- Raw JSON data reference
- Test script information
- Environment variables

### File Naming Convention

```
symulate-{original-report-name}.html
```

**Example:**
```
reports/
├── symulate-shared-admin-candidate-load-2026-10-15T12-17-39-676Z.json  (raw k6 data)
├── symulate-shared-admin-candidate-load-2026-10-15T12-17-39-676Z.html  ⭐ (professional)
├── symulate-report-...-overview.csv
├── symulate-report-...-summary.csv
├── symulate-report-...-aggregate.csv
├── symulate-report-...-checks.csv
├── symulate-report-...-url-details.csv
└── symulate-report-...-all-metrics.csv
```

### Auto-Generation

Professional reports are **automatically generated** after every test run:

```bat
npm run load:shared          # ✓ Auto-generates professional report
npm run smoke:grafana        # ✓ Auto-generates professional report
npm run load:shared:grafana  # ✓ Auto-generates professional report
```

### Manual Generation

Regenerate professional report from latest JSON:

```bat
npm run report:professional
```

### Report Features

**Responsive Design:**
- Mobile-friendly layout
- Print-optimized CSS
- Collapsible sections

**Color-Coded Severity:**
- Critical: Red (#dc3545)
- High: Orange (#fd7e14)
- Medium: Yellow (#ffc107)
- Low: Green (#28a745)

**Executive-Ready:**
- Non-technical executive summary
- Visual metric presentation
- Clear actionable findings
- Professional formatting

### Use Cases

1. **Stakeholder Reports** - Share with management/clients
2. **Performance Baseline** - Document performance benchmarks
3. **Regression Testing** - Compare against previous runs
4. **Capacity Planning** - Evidence for infrastructure decisions
5. **Post-Mortem Analysis** - Detailed incident investigation

### Playwright Artifacts

Browser automation artifacts stored separately:
```
playwright/artifacts/
├── screenshots/
├── videos/
└── traces/
```

All report files are Git-ignored for security and size.

---

## 12. Grafana / InfluxDB Monitoring

### Quick Start (3 steps)

```bat
# Step 1: Start monitoring stack
npm run monitoring:up

# Step 2: Run any test with Grafana output
npm run load:shared:grafana
# OR
npm run admin:shared:grafana
# OR
npm run smoke:grafana

# Step 3: Open dashboard
```

Access live dashboard: **http://localhost:3001** (admin/admin)

### Available Grafana Commands

| Command                        | Purpose                               |
| ------------------------------ | ------------------------------------- |
| `npm run monitoring:up`        | Start Grafana + InfluxDB containers   |
| `npm run monitoring:down`      | Stop monitoring stack                 |
| `npm run monitoring:status`    | Check if containers are running       |
| `npm run monitoring:reset`     | Remove all data & restart fresh       |
| `npm run load:shared:grafana`  | Shared-project load with live metrics |
| `npm run admin:shared:grafana` | Same as above (alias)                 |
| `npm run smoke:grafana`        | Smoke test with live metrics          |
| `npm run load:grafana`         | Isolated load test with live metrics  |

### What You'll See in Dashboard

The dashboard shows **8 live panels** during test execution:

1. **Virtual Users (VUs)** - Active concurrent users over time
2. **Requests/sec** - HTTP request rate
3. **p95/p99 Response Time** - 95th and 99th percentile latencies
4. **Error Rate (%)** - Failed requests percentage
5. **p95 Response Time by Step** - Latency breakdown by API endpoint
6. **Checks Pass Rate (%)** - Test assertion success rate
7. **Data Received/Sent** - Network throughput
8. **Total Stats** - Cumulative metrics (requests, data, checks)

### Metrics Flow

```
k6 Test Run
     ↓
InfluxDB (port 8087)
     ↓
Grafana Dashboard (port 3001)
     ↓
Real-time visualization
```

**Metrics push interval**: Every 3 seconds
**Data retention**: Persists until `npm run monitoring:reset`

### Troubleshooting

**Dashboard shows "No Data"?**

```bat
# Check containers are running
npm run monitoring:status

# Verify InfluxDB has data
docker exec k6-influxdb influx -execute "SHOW DATABASES"
docker exec k6-influxdb influx -database k6 -execute "SHOW MEASUREMENTS"
```

**Containers won't start?**

```bat
# Check Docker is running
docker --version

# Check ports are free
netstat -an | findstr "3001 8087"

# Reset everything
npm run monitoring:reset
npm run monitoring:up
```

For complete Grafana setup guide, see: **[monitoring/GRAFANA_SETUP.md](monitoring/GRAFANA_SETUP.md)**

### Exporting Grafana Data

**Automatic Export** (when using Grafana):
```bash
npm run load:shared:grafana    # ✅ Auto-exports InfluxDB data after test
npm run smoke:grafana           # ✅ Auto-exports InfluxDB data after test
```

**Manual Export:**
```bash
npm run report:grafana
```

**What Gets Exported:**

1. **grafana-http-requests-*.csv** ⭐
   - Every HTTP request with **actual full URLs**
   - Time, URL, Response Time, Status, Method
   - Complete request-level detail

2. **grafana-metrics-summary-*.csv**
   - Aggregated metrics (count, mean, min, max, sum)
   - All HTTP, WebSocket, VU, and iteration metrics

3. **grafana-vus-timeseries-*.csv**
   - Virtual Users over time (load pattern)
   - Time-series data for trend analysis

4. **grafana-errors-*.csv**
   - Failed requests with URLs and timestamps
   - Empty file = 100% success rate ✅

5. **jmeter-endpoint-summary-*.csv** ⭐
   - JMeter-style per-endpoint table:
     `Label, # Samples, Average, Min, Max, Std. Dev., Error %, Throughput, Received KB/sec, Sent KB/sec, Avg. Bytes`
   - Includes a **TOTAL** row aggregated across all endpoints

6. **url-details-*.csv** ⭐
   - Full request URL per label (method / status / URL), built from InfluxDB
     `http_req_duration{name=...}` plus the `recv_bytes`/`sent_bytes` counters

> **Run-window scoping:** InfluxDB accumulates metrics across *all* runs forever.
> The runner stamps each run's start time and passes it to the exporter as
> `INFLUX_SINCE_MS`, so every query is scoped to **the current run only** —
> without it, aggregates would silently span days of prior runs. Note also that
> `name` is a reserved InfluxQL word and is always quoted (`"name"`) in queries.

**Example HTTP Requests CSV:**
```csv
time,value,url,name,method,status
2026-10-15T13:45:01Z,245.3,https://superadmin.symulate-dev.weuno.co/organizations,Create Client,POST,200
2026-10-15T13:45:02Z,189.7,https://clientadmin.symulate-dev.weuno.co/projects,Create Project,POST,200
2026-10-15T13:45:03Z,312.5,https://api.symulate-dev.weuno.co/tasks,Create Task,POST,200
```

**Requirements:**
- ✅ Monitoring stack must be running (`npm run monitoring:up`)
- ✅ Test must use `--grafana` flag or `:grafana` npm script
- ✅ InfluxDB must contain data (test must complete successfully)

**Benefits:**
- 📊 Actual URLs captured (not just labels)
- ⏱️ Time-series data for trend analysis
- 🔍 Request-level granularity
- 📈 Compatible with Excel pivot tables
- 🎯 Same data Grafana visualizes

**📊 Excel Analysis Guide:**

For detailed Excel Pivot Table tutorials and data analysis techniques, see:
**[docs/EXCEL_ANALYSIS_GUIDE.md](docs/EXCEL_ANALYSIS_GUIDE.md)**

Learn how to:
- Create URLs by Response Time analysis
- Track Errors by Time Period
- Visualize Load Patterns
- Analyze Performance Trends
- Build automated dashboards

---

## Recommended Configurations

### Smoke test (verify full flow):

```env
LOAD_MODE=smoke
SEND_PROJECT_INVITATIONS=true
CANDIDATE_EXECUTION_SOURCE=generated
NUM_CANDIDATES=10
LOAD_ITERATIONS_PER_VU=1
ENFORCE_BOOKING=false
```

```bat
npm run smoke
```

### 10 concurrent users (verify load flow):

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

### 150 concurrent users (full load test):

```env
NUM_CANDIDATES=150
LOAD_VUS=150
LOAD_MAX_DURATION=30m
SEND_PROJECT_INVITATIONS=false
ENFORCE_BOOKING=false
```

```bat
npm run load:shared
```

---

## 🔍 For Code Reviewers

### Key Implementation Details

**1. Two-Phase Architecture (`scripts/run-shared-project-load.js`)**

- Phase 1 provisions project sequentially (avoids rate limits)
- Phase 2 runs concurrent load with pre-captured invitation URLs
- Base64 encoding used to pass large invitation data between phases
- Automatic cleanup of temporary files

**2. Environment Variable Injection**

- `scripts/run.js` reads `.env` and injects as k6 `-e` flags
- Oversized values (>4000 chars) written to temp files to avoid Windows ARG_MAX limits
- All tests use same environment abstraction

**3. WebSocket Handling (`utils/socketConversation.js`)**
- Simulates real AI conversation flow
- Staggered connection timing (prevents thundering herd)
- Automatic reconnection with exponential backoff
- Conversation state management per VU

**4. HTTP Wrapper (`utils/http.js`)**
- 429 rate limits: 3 retries with exponential backoff
- Detailed logging shows which endpoint is rate-limited
- Configurable via `HTTP_429_MAX_RETRIES` in .env
- Tags every request with `name` **and full `url`** (stored in InfluxDB for URL-level reports)
- Emits a structured `[FAILED_REQUEST] {json}` line per failed request
  (status code + response-body message), which the runner scrapes into
  `reports/failures-latest.json` for the HTML report's Failed Requests table

**5. Rate Limit Management**

- 65-second gaps between phases (global IP rate limit window)
- VU start interval: 1.5s (controlled candidate onboarding)
- Admin operations use shared token across all VUs

**6. Grafana Integration**

- `--grafana` flag adds InfluxDB output to k6 runs
- 3-second push interval for near-real-time metrics
- Dashboard auto-provisions via Docker volume mounts

**7. Data Isolation**

- Each test run uses unique timestamp-based IDs
- Candidates created with `john{N}.load.{timestamp}.{vu}@yopmail.com` pattern
- Projects tagged for easy identification

**8. Error Handling**

- Graceful degradation on booking API 404 (dev environment)
- Portal theme 500 errors logged but don't fail test
- WebSocket failures retry with circuit breaker pattern

### Performance Characteristics

| Scale   | Phase 1 Duration | Phase 2 Duration | Total Time | Peak Concurrent | Memory Usage |
| ------- | ---------------- | ---------------- | ---------- | --------------- | ------------ |
| 10 VUs  | ~60s             | ~120s            | ~3min      | ~10             | ~200MB       |
| 50 VUs  | ~120s            | ~180s            | ~7min      | ~50             | ~500MB       |
| 150 VUs | ~300s            | ~300s            | ~12min     | ~64 ⚠️          | ~1GB         |

> **Peak Concurrent ≠ VU count.** VUs are started paced by
> `LOAD_VU_START_INTERVAL_SECONDS` (1.5s). Because each VU runs ~96s, the number
> running at the *same instant* saturates at ≈ `96 ÷ 1.5 ≈ 64`. So `NUM_CANDIDATES=150`
> delivers **150 total users with a ~64-user peak**, ramped over ~225s — not 150
> simultaneous. **Confirm the actual number from the `PEAK_CONCURRENT_VUS=` line
> the runner prints at the end of every Phase 2** — the formula is only an
> estimate, and k6's builtin `vus` metric overstates it (it counts VUs sleeping
> through their stagger). See the note in [Quick Start](#4-quick-start--which-command-to-use).
>
> Phase 3 (cleanup) adds ~10–30s on top of these durations.

### Security Notes

- `.env` file is Git-ignored (contains credentials)
- Invitation tokens redacted in console output
- Session tokens logged but marked with `<redacted>` in reports
- No credentials hardcoded in source code

### Testing Philosophy

1. **Smoke first**: Always validate with `npm run smoke` before load testing
2. **Incremental scale**: Start with 10 VUs, then 50, then 150
3. **Monitor live**: Use Grafana during load tests to spot issues early
4. **Verify results**: Check `reports/` directory after each run
5. **Clean state**: Use `monitoring:reset` between major test runs

---

