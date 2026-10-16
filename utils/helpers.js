// utils/helpers.js
//
// Small, dependency-free helpers shared across scenarios/tests.

// Unique-enough suffix per VU/iteration so parallel VUs never collide on
// names/emails during a load run (mirrors the `Date.now()` timestamp trick
// already used by the Playwright factories, plus __VU/__ITER for extra
// uniqueness under concurrent load).
export function uniqueSuffix() {
  return `${Date.now()}_${__VU}_${__ITER}`;
}

export function log(step, message) {
  console.log(`[${new Date().toISOString()}] [VU ${__VU}] ${step}: ${message}`);
}

export function logStep(step, res) {
  const ok = res.status >= 200 && res.status < 300;
  const marker = ok ? 'OK' : 'FAIL';
  console.log(`[${new Date().toISOString()}] [VU ${__VU}] ${marker} ${step} -> ${res.status} (${res.timings.duration.toFixed(0)}ms)`);
  if (!ok && res.body) {
    const body = String(res.body);
    console.log(`[${new Date().toISOString()}] [VU ${__VU}] ${step} response: ${body.slice(0, 1000)}`);
  }
}

// Builds a report filename tagged with scenario/mode so runs never overwrite
// each other and are easy to tell apart afterwards.
//
// The Anam tag is applied ONLY to anum-outage / situation runs — not merely
// because ANUM_API_ENABLED is false. This whole project runs with the Anum API
// disabled, so tagging on the flag alone marked EVERY report "without-anam".
// We now tag when the run is a situation-only scenario or one of the dedicated
// no-anum scripts (prefix contains "anam"/"anum"); normal runs carry no tag.
export function reportName(prefix, { SCENARIO, LOAD_MODE, ANUM_API_ENABLED }) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const isAnamOutageRun = SCENARIO === 'situation-only' || /anam|anum/i.test(prefix);
  const anamTag = isAnamOutageRun ? (ANUM_API_ENABLED ? '-with-anam' : '-without-anam') : '';
  return `${prefix}-${LOAD_MODE}-${SCENARIO}${anamTag}-${ts}`;
}
