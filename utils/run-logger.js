// utils/run-logger.js
//
// Per-VU run logger — collects every step, failure detail, and warning
// that happens during a k6 VU execution so handleSummary can write a
// complete step-by-step log report alongside the usual HTML/CSV files.
//
// Usage (in any scenario file):
//   import { RunLogger } from '../utils/run-logger.js';
//   const logger = new RunLogger();
//   logger.step('Login - Super Admin', loginRes);          // auto OK/FAIL
//   logger.info('Project Review', 'Starting review flow'); // free-form info
//   logger.warn('Transcript', 'No ack received');          // warning
//   ...
//   // In handleSummary — pass collected entries from __ENV or a shared array.
//   // See note below on cross-VU collection.
//
// Because k6 VUs are isolated JS runtimes, the logger writes its entries
// to a per-VU JSON file under reports/run-logs/ during the run.
// The post-run report builder (scripts/build-run-report.js) merges them.

// File writing is handled by k6's built-in handleSummary — no xk6 extension needed.

export class RunLogger {
  constructor(label) {
    this._label = label || 'Run';
    this._entries = [];
    this._startedAt = new Date().toISOString();
    this._vu = __VU;
    this._iter = __ITER;
  }

  // Record an HTTP response step — automatically marks OK or FAIL and
  // captures URL + status + truncated body on failures.
  step(name, res) {
    const ok = res && res.status >= 200 && res.status < 300;
    const entry = {
      ts: new Date().toISOString(),
      vu: this._vu,
      iter: this._iter,
      level: ok ? 'OK' : 'FAIL',
      step: name,
      status: res ? res.status : null,
      duration_ms: res && res.timings ? Math.round(res.timings.duration) : null,
      url: res ? res.url : null,
      body: null,
    };

    if (!ok && res && res.body) {
      // Capture up to 2 000 chars of the response body for failure diagnosis.
      entry.body = String(res.body).slice(0, 2000);
    }

    this._entries.push(entry);
    this._consoleLog(entry);
    return entry;
  }

  // Free-form informational message (flow milestones, resolved IDs, etc.)
  info(section, message) {
    const entry = {
      ts: new Date().toISOString(),
      vu: this._vu,
      iter: this._iter,
      level: 'INFO',
      step: section,
      message,
    };
    this._entries.push(entry);
    this._consoleLog(entry);
  }

  // Warning — something unexpected happened but execution continued.
  warn(section, message) {
    const entry = {
      ts: new Date().toISOString(),
      vu: this._vu,
      iter: this._iter,
      level: 'WARN',
      step: section,
      message,
    };
    this._entries.push(entry);
    this._consoleLog(entry);
  }

  // Returns all entries collected so far — call at end of VU function and
  // attach to handleSummary data via a shared k6 metric trick or ENV export.
  entries() {
    return this._entries;
  }

  // Serialise to a JSON string suitable for writing to a report file.
  toJson() {
    return JSON.stringify(
      {
        label: this._label,
        startedAt: this._startedAt,
        finishedAt: new Date().toISOString(),
        vu: this._vu,
        iter: this._iter,
        entries: this._entries,
      },
      null,
      2
    );
  }

  _consoleLog(entry) {
    const tag = entry.level.padEnd(4);
    const step = entry.step || '';
    if (entry.status !== undefined && entry.status !== null) {
      console.log(
        `[${entry.ts}] [VU ${entry.vu}] ${tag} ${step} -> ${entry.status} (${entry.duration_ms}ms)${entry.url ? ' ' + entry.url : ''}`
      );
      if (entry.body) {
        console.log(`[${entry.ts}] [VU ${entry.vu}] FAIL body: ${entry.body}`);
      }
    } else {
      console.log(`[${entry.ts}] [VU ${entry.vu}] ${tag} ${step}: ${entry.message || ''}`);
    }
  }
}