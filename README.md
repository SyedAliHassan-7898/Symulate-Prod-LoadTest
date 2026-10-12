# Symulate AI Load Testing & Monitoring Suite

k6 + Playwright based load testing suite for Symulate AI platform. Covers smoke testing, concurrent shared-project load testing, Anam AI outage validation, and optional Grafana/InfluxDB live monitoring.

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

| Tool | Purpose |
|------|---------|
| Node.js 20+ | Runner scripts |
| npm | Package management |
| k6 | Load test execution |
| Docker Desktop | Grafana/InfluxDB (optional) |
| Chromium | Playwright browser tests |

```bat
node --version
npm --version
k6 version
```

---

## 2. Installation

```bat
npm install
copy .env.example .env
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
SUPER_ADMIN_PASSWORD=Test@123

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

---

## 4. Quick Start — Which Command to Use

| Goal | Command | What to set in .env |
|------|---------|-------------------|
| Verify everything works | `npm run smoke` | `LOAD_MODE=smoke`, `SEND_PROJECT_INVITATIONS=true`, `CANDIDATE_EXECUTION_SOURCE=generated` |
| **Test N concurrent users** | **`npm run load:shared`** | `NUM_CANDIDATES=N`, `LOAD_VUS=N` |
| Test N isolated projects | `npm run load` | `LOAD_MODE=load`, `LOAD_VUS=N`, `LOAD_ITERATIONS_PER_VU=1` |
| Anam outage test | `npm run e2e:anam:outage503` | `NUM_CANDIDATES=10` |

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
```

```bat
npm run load:shared
```

### Two-phase flow:

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

**Phase 2 — Concurrent load (all VUs fire simultaneously):**
```
VU 1  → john1@ → invitation href login → 6 activities ✓
VU 2  → john2@ → invitation href login → 6 activities ✓
VU 3  → john3@ → invitation href login → 6 activities ✓
...
VU N  → johnN@ → invitation href login → 6 activities ✓
```

### Scale examples:

| `.env` | Concurrent users | Phase 1 time |
|--------|-----------------|-------------|
| `NUM_CANDIDATES=5, LOAD_VUS=5` | 5 | ~30s |
| `NUM_CANDIDATES=10, LOAD_VUS=10` | 10 | ~1 min |
| `NUM_CANDIDATES=50, LOAD_VUS=50` | 50 | ~2 min |
| `NUM_CANDIDATES=150, LOAD_VUS=150` | 150 | ~5 min |

### Why not `npm run load` for 150 users?

`npm run load` creates one project per VU — 150 VUs = 150 concurrent `Create Client` calls = **mass 429 rate limiting**. `load:shared` creates 1 project then fires all VUs against it — no rate limit on provisioning.

### Expected output for 10 VUs:
```
Phase 1 complete:
  Project ID  : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  Candidates  : 10 hrefs captured
  Hrefs file  : C:\Users\...\AppData\Local\Temp\shared-hrefs-<ts>.b64

checks: 98%+
ws_sessions: 60   (10 VUs × 6 activities)
iterations: 10
```

### Known dev-environment behaviors (not script bugs):

| Log message | Cause | Impact |
|------------|-------|--------|
| `candidate portal theme: 500` | DB race condition on first concurrent portal access | Non-blocking |
| `portal-tokens: 404` | Not available on dev | Auto-fallback to invitation-href login |
| `Accept Agreement: timeout` | Server overwhelmed at 10+ concurrent | Some VUs retry and succeed |
| `http_req_failed > 10%` | Dev server rate limits | Expected finding |

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

This tells you exactly which endpoint is being rate-limited. The suite retries up to 3 times with backoff.

---

## 11. Reports

All runs write to `reports/`:

| File | Content |
|------|---------|
| `*.html` | Interactive HTML report |
| `*.json` | Raw k6 metrics |
| `*-overview.csv` | High-level summary |
| `*-checks.csv` | Per-check results |

Playwright artifacts: `playwright/artifacts/`

All report files are Git-ignored.

---

## 12. Grafana / InfluxDB Monitoring

```bat
npm run monitoring:up
npm run smoke:grafana
```

Access dashboard: `http://localhost:3000`

```bat
npm run monitoring:down
```

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
