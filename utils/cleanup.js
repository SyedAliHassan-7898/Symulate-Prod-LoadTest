// utils/cleanup.js
//
// Teardown helpers — called from the k6 teardown() lifecycle function in
// load test entry points to delete all resources created during a run.
//
// DESIGN PRINCIPLES:
//   - All deletions use the real Super Admin token (passed in from teardown),
//     never the load-test admin token, because the load-test admin account
//     may not have org-level delete permissions.
//   - Every delete call is best-effort: a failed deletion is logged and
//     counted but never throws, so one failure never aborts the cleanup of
//     the remaining resources.
//   - The registry pattern (see below) is the recommended usage: each VU
//     records its created resource IDs into the data object returned by
//     setup(), which is then passed into teardown() by k6 automatically.
//
// USAGE IN TEST FILES:
//
//   import { cleanupRunResources } from '../utils/cleanup.js';
//
//   export function teardown(data) {
//     if (!data || !data.registry) return;
//     cleanupRunResources(data.registry, data.superAdminToken);
//   }
//
// REGISTRY SHAPE:
//
//   registry = {
//     orgIds:       string[]  — organization IDs to delete
//     projectIds:   string[]  — project IDs to delete (deleted before orgs)
//     candidateIds: string[]  — candidate user IDs to delete
//   }
//
// VU functions add IDs via the push helpers:
//
//   import { registerOrg, registerProject, registerCandidate } from '../utils/cleanup.js';
//   registerOrg(registry, orgId);
//   registerProject(registry, projectId);
//   registerCandidate(registry, candidateId);
//
// NOTE: k6 does not allow cross-VU shared mutable state. VU functions cannot
// write directly into a shared registry. Instead, each VU returns its created
// IDs through the k6 metric system (using custom Trend/Counter metrics tagged
// with the IDs) OR — more simply — through the approach used here: the test
// uses setup() to create a SINGLE shared provisioning pass (1 VU), and all
// IDs are collected in setup()'s return value. For multi-VU provisioning
// (load-client-project.js pattern) where each VU creates its own resources,
// IDs are tracked via a SharedArray written by setup() and read by teardown().
// See tests/load-client-project.js for the concrete implementation.

import { check, sleep } from 'k6';
import http from 'k6/http';
import { log } from './helpers.js';
import { API_URL } from '../config/environments.js';

// ---------------------------------------------------------------------------
// Low-level DELETE helper
//
// Uses k6/http directly (not the utils/http.js wrapper) to avoid the 429
// retry loop adding extra delay during teardown — we want fast best-effort
// cleanup, not careful retry semantics.
// ---------------------------------------------------------------------------
function deleteRequest(url, token, label) {
  try {
    const res = http.del(url, null, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      tags: { name: label }
    });
    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      log('Cleanup', `DELETE ${label} -> ${res.status} OK`);
    } else if (res.status === 404) {
      log('Cleanup', `DELETE ${label} -> 404 (already deleted or never created — skipping)`);
    } else {
      log('Cleanup', `DELETE ${label} -> ${res.status} FAILED (non-fatal — continuing cleanup)`);
    }
    return ok;
  } catch (e) {
    log('Cleanup', `DELETE ${label} -> ERROR: ${e && e.message ? e.message : e} (non-fatal)`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Individual resource deleters
// ---------------------------------------------------------------------------

// Deletes a single organization (client) by ID.
// Also removes all projects, users, and candidates that belong to it on the
// backend, so calling this is sufficient for a fully isolated org teardown.
export function deleteOrganization(superAdminToken, orgId) {
  if (!orgId) return false;
  return deleteRequest(
    `${API_URL}/organizations/${orgId}`,
    superAdminToken,
    `Delete Organization (${orgId})`
  );
}

// Deletes a single project by ID.
// Call this before deleteOrganization() if the backend requires projects to
// be removed independently (some backends cascade, some don't).
export function deleteProject(superAdminToken, projectId) {
  if (!projectId) return false;
  return deleteRequest(
    `${API_URL}/project/${projectId}`,
    superAdminToken,
    `Delete Project (${projectId})`
  );
}

// Deletes a single candidate user by ID.
export function deleteCandidate(superAdminToken, candidateId) {
  if (!candidateId) return false;
  return deleteRequest(
    `${API_URL}/candidate/${candidateId}`,
    superAdminToken,
    `Delete Candidate (${candidateId})`
  );
}

// ---------------------------------------------------------------------------
// createRegistry() — builds an empty resource registry for a test run.
// ---------------------------------------------------------------------------
export function createRegistry() {
  return {
    orgIds: [],
    projectIds: [],
    candidateIds: []
  };
}

// ---------------------------------------------------------------------------
// Register helpers — called inside VU functions or setup() to record IDs.
// ---------------------------------------------------------------------------
export function registerOrg(registry, orgId) {
  if (registry && orgId && !registry.orgIds.includes(orgId)) {
    registry.orgIds.push(orgId);
  }
}

export function registerProject(registry, projectId) {
  if (registry && projectId && !registry.projectIds.includes(projectId)) {
    registry.projectIds.push(projectId);
  }
}

export function registerCandidate(registry, candidateId) {
  if (registry && candidateId && !registry.candidateIds.includes(candidateId)) {
    registry.candidateIds.push(candidateId);
  }
}

// ---------------------------------------------------------------------------
// cleanupRunResources()
//
// Main teardown entry point. Deletes all resources in the registry using the
// provided Super Admin token.
//
// Deletion order:
//   1. Candidates first (no dependencies on them from other resources)
//   2. Projects next  (depend on orgs but may block org deletion if present)
//   3. Organizations last (cascade-deletes any remaining child resources)
//
// A small sleep between batches gives the backend time to process deletes
// before the next set arrives, avoiding 409 conflicts on cascaded FK cleanup.
// ---------------------------------------------------------------------------
export function cleanupRunResources(registry, superAdminToken) {
  if (!superAdminToken) {
    log('Cleanup', 'SKIPPED — no Super Admin token available for teardown');
    return { deleted: 0, failed: 0, skipped: true };
  }

  if (!registry) {
    log('Cleanup', 'SKIPPED — no resource registry provided');
    return { deleted: 0, failed: 0, skipped: true };
  }

  const { orgIds = [], projectIds = [], candidateIds = [] } = registry;
  const totalResources = orgIds.length + projectIds.length + candidateIds.length;

  if (totalResources === 0) {
    log('Cleanup', 'Nothing to clean up — registry is empty');
    return { deleted: 0, failed: 0, skipped: false };
  }

  log(
    'Cleanup',
    `Starting teardown: ${candidateIds.length} candidate(s), ` +
    `${projectIds.length} project(s), ${orgIds.length} org(s)`
  );

  let deleted = 0;
  let failed = 0;

  // 1. Candidates
  candidateIds.forEach((id) => {
    if (deleteCandidate(superAdminToken, id)) {
      deleted++;
    } else {
      failed++;
    }
    sleep(0.1); // brief pause — avoid overwhelming the delete endpoint
  });

  if (candidateIds.length > 0) sleep(0.5);

  // 2. Projects
  projectIds.forEach((id) => {
    if (deleteProject(superAdminToken, id)) {
      deleted++;
    } else {
      failed++;
    }
    sleep(0.1);
  });

  if (projectIds.length > 0) sleep(0.5);

  // 3. Organizations
  orgIds.forEach((id) => {
    if (deleteOrganization(superAdminToken, id)) {
      deleted++;
    } else {
      failed++;
    }
    sleep(0.1);
  });

  log(
    'Cleanup',
    `Teardown complete — deleted: ${deleted}/${totalResources}, failed: ${failed}/${totalResources}`
  );

  check(null, {
    'teardown: all resources deleted': () => failed === 0
  });

  return { deleted, failed, skipped: false };
}
