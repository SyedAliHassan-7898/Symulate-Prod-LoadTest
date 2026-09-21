// utils/data.js
//
// Loads the canonical candidate CSV once per test run (SharedArray caches it
// so every VU shares the same parsed array instead of re-reading/parsing
// the file per VU/iteration — standard k6 pattern for static test data).

import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

// `open()` is a k6 init-context global (no import needed) — must be called
// with a path relative to THIS file, and only ever from init context, which
// is exactly what SharedArray's loader function is.
export const candidates = new SharedArray('candidates', function () {
  const csv = open('../data/candidates.csv');
  const parsed = papaparse.parse(csv, { header: true, skipEmptyLines: true });
  return parsed.data;
});
