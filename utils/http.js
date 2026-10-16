// utils/http.js
//
// Thin wrapper around k6/http so every scenario gets: consistent headers,
// per-step metric tagging (so the HTML/JSON report and thresholds break
// results down per real step instead of one lumped bucket), byte counters,
// and a single place to add retry/backoff later if needed.

import http from 'k6/http';
import { sleep } from 'k6';
import { Counter } from 'k6/metrics';

export const recvBytes = new Counter('recv_bytes');
export const sentBytes = new Counter('sent_bytes');

// Retry configuration for 429 (Too Many Requests) responses.
// Retries up to MAX_RETRIES times with exponential backoff.
const MAX_RETRIES = Math.max(0, Number(__ENV.HTTP_429_MAX_RETRIES ?? 3));
const BASE_BACKOFF_SEC = 2;

function recordBytes(res, name) {
  const received = res && res.body ? res.body.length : 0;
  const sent = res && res.request && res.request.body ? res.request.body.length : 0;
  recvBytes.add(received, { name });
  sentBytes.add(sent, { name });
}

function headers(token, extra = {}) {
  const base = { 'Content-Type': 'application/json' };
  if (token) base.Authorization = `Bearer ${token}`;
  const merged = { ...base, ...extra };
  Object.keys(merged).forEach((key) => {
    if (merged[key] === undefined) delete merged[key];
  });
  return merged;
}

// Executes an HTTP call and retries on 429 (rate limit) with exponential backoff.
// Returns the final response (which may still be 429 if all retries exhausted).
//
// Every *final* failure (status >= 400, or a network error) is also emitted as a
// machine-readable line:
//   [FAILED_REQUEST] {"name":...,"method":...,"url":...,"status":...,
//                     "errorCode":...,"message":...,"at":"ISO-8601"}
// Both runners (scripts/run.js and scripts/run-shared-project-load.js) tee k6's
// output, collect these lines, and write reports/failures-latest.json — k6's own
// summary only reports an aggregate failure *rate*, never which call failed or
// why. Intermediate 429s that later retry successfully are not reported here.
function emitFailedRequest(name, url, res, networkError) {
  const request = res && res.request ? res.request : {};
  const status = res && typeof res.status === 'number' ? res.status : null;

  let message = networkError || '';
  if (res && res.body) {
    const body = String(res.body);
    try {
      const parsed = JSON.parse(body);
      message = parsed.message || parsed.error || parsed.errorMessage || body;
    } catch (_) {
      message = body;
    }
  }

  const record = {
    name,
    method: (request.method || 'GET').toUpperCase(),
    url: (res && res.url) || url,
    status,
    errorCode: res && res.errorCode !== undefined ? res.errorCode : null,
    message: String(message || '').slice(0, 300),
    at: new Date().toISOString()
  };

  console.log(`[FAILED_REQUEST] ${JSON.stringify(record)}`);
}

function requestWithRetry(fn, name, url) {
  // Guard against thrown transport errors (DNS failure, refused connection,
  // timeout) so they are recorded as failures instead of only crashing the step.
  const guarded = () => {
    try {
      return fn();
    } catch (error) {
      emitFailedRequest(name, url, null, error && error.message ? error.message : String(error));
      throw error;
    }
  };

  let res = guarded();
  if (res && res.status === 429) {
    console.log(`[429 RATE LIMIT] flow="${name}" url="${url}" — Too Many Requests from this IP`);
  }
  for (let attempt = 1; attempt <= MAX_RETRIES && res && res.status === 429; attempt++) {
    const waitSec = BASE_BACKOFF_SEC * attempt; // 2s, 4s, 6s
    console.log(`[RETRY] ${name} — 429 rate limited on ${url}, retry ${attempt}/${MAX_RETRIES} after ${waitSec}s`);
    sleep(waitSec);
    res = guarded();
    if (res && res.status === 429 && attempt === MAX_RETRIES) {
      console.log(`[429 EXHAUSTED] flow="${name}" url="${url}" — all ${MAX_RETRIES} retries failed, still rate limited`);
    }
  }

  if (res && typeof res.status === 'number' && res.status >= 400) {
    emitFailedRequest(name, url, res);
  }
  return res;
}

export function getJson(url, token, name) {
  const res = requestWithRetry(
    () => http.get(url, { headers: headers(token), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function getJsonWithHeaders(url, token, name, extraHeaders = {}) {
  const res = requestWithRetry(
    () => http.get(url, { headers: headers(token, extraHeaders), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function postJson(url, body, token, name) {
  const res = requestWithRetry(
    () => http.post(url, JSON.stringify(body), { headers: headers(token), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function postJsonWithHeaders(url, body, token, name, extraHeaders = {}) {
  const res = requestWithRetry(
    () => http.post(url, JSON.stringify(body), { headers: headers(token, extraHeaders), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function patchJson(url, body, token, name) {
  const res = requestWithRetry(
    () => http.patch(url, JSON.stringify(body), { headers: headers(token), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function patchJsonWithHeaders(url, body, token, name, extraHeaders = {}) {
  const res = requestWithRetry(
    () => http.patch(url, JSON.stringify(body), { headers: headers(token, extraHeaders), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

export function postMultipart(url, fields, token, name) {
  const res = requestWithRetry(
    () => http.post(url, fields, { headers: headers(token, { 'Content-Type': undefined }), tags: { name } }),
    name, url
  );
  recordBytes(res, name);
  return res;
}

// Safely pulls a token out of a few common response shapes, so the suite
// keeps working regardless of which one the real API uses. Adjust here if
// the real shape differs.
export function extractToken(res) {
  try {
    const body = res.json();
    return (
      body.token ||
      body.accessToken ||
      body.access_token ||
      (body.data && (body.data.token || body.data.accessToken || body.data.access_token)) ||
      null
    );
  } catch (e) {
    return null;
  }
}

// Safely pulls a resource id out of a few common response shapes.
export function extractId(res, key = 'id') {
  try {
    const body = res.json();
    return body[key] || (body.data && body.data[key]) || null;
  } catch (e) {
    return null;
  }
}
