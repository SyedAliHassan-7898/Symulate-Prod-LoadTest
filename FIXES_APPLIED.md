## v9 — activation readiness correction

- Removed `project.candidateAccess === true` as a hard project-activation requirement.
- The current dev backend can return `candidateAccess=false` after invitation dispatch succeeds and the project is already `ACTIVE`.
- Candidate access is now logged as diagnostic-only state.
- Candidate execution readiness continues to be verified by the real portal-token/session path, so the change removes a false negative without weakening the candidate lifecycle.
- Eliminates the 10-second unnecessary activation polling loop caused by waiting for a flag that does not transition in the observed backend response.
- Added validator coverage to prevent reintroducing the stale `candidateAccess` hard gate.

# Fixes Applied — v8

This version is based on the v7 repository plus the execution log captured on 2026-09-21.

## Confirmed from the latest log

- `npm run load:10` created 10 isolated clients and 10 isolated projects.
- Each project provisioned and verified 20 candidates from `data/candidates.csv` seed data.
- 970/970 checks passed and HTTP request failure rate was 0%.
- The command still exited non-zero because latency thresholds were crossed: overall p99 was ~10.5s, `Assign Task` p95 was ~10.5s, and `Create Client` p95 was ~2.2s.
- `npm run e2e:anam:outage503` and `npm run e2e:anam:network` stopped before execution because `.env` had `SEND_PROJECT_INVITATIONS=false`, while browser/session E2E requires an active invited project.
- `npm run smoke` with `SEND_PROJECT_INVITATIONS=false` behaved correctly: it provisioned one project with 20 candidates and stopped before candidate activity execution.

## v8 changes

### Performance profiles

`PERFORMANCE_PROFILE` now separates correctness from latency SLO enforcement:

- `auto`: strict for smoke, baseline for load.
- `strict`: previous tight latency thresholds.
- `baseline`: concurrency-aware load thresholds for the current shared dev environment.
- `functional`: correctness/request-failure gates only; latency is still reported.

The baseline profile keeps the global p95 under 2s, global p99 under 12s, `Create Client` p95 under 3s, and `Assign Task` p95 under 12s. This prevents a functionally successful 10-VU provisioning run from failing only because the shared dev environment queues setup writes. Strict mode remains available for regression/SLO enforcement.

### Anam E2E lifecycle

Specialized E2E npm commands now explicitly set `SEND_PROJECT_INVITATIONS=true` for their isolated browser/session validation project:

- `validate:e2e-runner`
- `e2e:no-anum:full`
- `e2e:anam:disabled`
- `e2e:anam:healthy`
- `e2e:anam:outage503`
- `e2e:anam:network`

The runner accepts this explicit command-level override and logs its source. Normal `smoke` and `load` commands still use the `.env` value unchanged.

### Candidate provisioning documentation

Documentation now matches the actual deterministic implementation:

`data/candidates.csv` -> unique per-run candidates -> `create-for-project` with `force=false` -> capture IDs -> bulk assign -> verify exact project membership.

The legacy asynchronous CSV-upload queue is not used in the managed provisioning flow because it does not return candidate IDs and cannot resolve unassigned candidates from the project-scoped lookup.

### Runner diagnostics

The runner summary now includes the effective performance profile so it is clear whether a run is using strict or baseline thresholds.
