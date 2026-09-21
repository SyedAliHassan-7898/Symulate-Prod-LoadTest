// playwright/no-anum-e2e-validation.js
//
// Browser-level Anam validation / resilience harness.
// Supports disabled, healthy, outage503 and network modes while retaining the
// historical filename for compatibility.
//
// Run everything in one go:
//   npm run e2e:anam:disabled
//   npm run e2e:anam:healthy
//   npm run e2e:anam:outage503
//   npm run e2e:anam:network
//
// Manual:
//   CANDIDATE_ACCESS_TOKEN=eyJ... NOANUMTEST_PROJECT_ID=<id> npm run e2e:no-anum:browser
//
// ── BUGS FIXED ───────────────────────────────────────────────────────────────
//
// FIX 1 — apiBase() produced wrong URL
//   BEFORE: hostname.replace(/^symulate-ai-/, 'api.symulate.')
//     'symulate-ai-dev.weuno.co' → 'api.symulate.dev.weuno.co'  ← WRONG
//   AFTER:  strip first subdomain entirely, prepend 'api.symulate.'
//     'symulate-ai-dev.weuno.co' → 'api.symulate.weuno.co'       ← CORRECT
//
// FIX 2 — page.evaluate() fetch fails (CORS / browser network isolation)
//   BEFORE: preBookViaApi() and waitForEntryViaApiThenClick() called
//     page.evaluate(async ({apiUrl,...}) => fetch(apiUrl,...)) — the browser
//     sandbox blocks cross-origin fetches to the backend API, producing
//     "TypeError: Failed to fetch" for every call. This killed both the
//     API pre-book AND the entry-check polling, leaving the test falling
//     back to 15-minute button polling with no booking ever made.
//   AFTER:  all API calls use Node.js https.request() in the main process,
//     completely outside the browser. No CORS, no sandbox, no browser at all.
//
// FIX 3 — "Verify booking" false-fail on /booking/confirmed  (previous fix kept)
//   /booking/confirmed URL = success. Only throw when still on /booking
//   (without /confirmed) AND slot-picker elements are still visible.
//
// FIX 4 — Booking UI detection heuristic too narrow  (previous fix kept)
//   Detect booking page by URL (/booking path) OR visible text — URL is
//   authoritative and doesn't depend on heading copy.
//
// FIX 5 — duplicate booking caused reschedule-cutoff errors
//   API booking is now idempotent (/my-booking first), and once a booking
//   exists the UI slot selection / Confirm booking path is skipped.
//
// FIX 6 — browser state was stale after out-of-band API booking
//   The page is reloaded after booking and again when entry-check first says
//   canEnter=true, forcing the SPA to re-fetch booking state.
//
// FIX 7 — 409 is no longer blindly treated as "already booked"
//   A 409 is accepted only after /my-booking confirms a real BOOKED record.
//
// FIX 8 — Data Protection Notice blocked the browser flow
//   The portal can show the Data Protection Notice directly after the entry
//   window opens. The old flow only waited for a Start/Enter button and then
//   tried to click Continue without checking the required confirmation box.
//   The test now detects the notice as a valid entry state, checks the required
//   consent checkbox, waits for Continue to assessment to enable, clicks it,
//   and verifies that the notice closes before activities begin.

//
// FIX 9 — Playwright browser had no microphone permission/device
//   A physical microphone connected to Windows is not automatically available
//   inside a fresh Playwright BrowserContext. The role-play UI therefore showed
//   "Please allow access to your microphone" even though the host machine had a
//   working microphone. The harness now grants microphone permission for the
//   candidate origin and, by default, uses Chromium's deterministic fake media
//   device. Set PLAYWRIGHT_MICROPHONE_MODE=system with HEADLESS=false to use the
//   host microphone instead, or disabled to intentionally test denial behavior.

const { chromium } = require('playwright');
const https  = require('https');
const http   = require('http');
const path   = require('path');
const { createRun, shot, writeEvidence, buildHtml, renderPdf } = require('./lib/reporter.js');

const CANDIDATE_URL          = process.env.CANDIDATE_URL;
const EXPLICIT_API_URL        = process.env.API_URL || '';
const CANDIDATE_ACCESS_TOKEN  = process.env.CANDIDATE_ACCESS_TOKEN;
const CANDIDATE_REFRESH_TOKEN = process.env.CANDIDATE_REFRESH_TOKEN || '';
const CANDIDATE_ORG_ID        = process.env.CANDIDATE_ORG_ID        || '';
const CANDIDATE_PARENT_ORG_ID = process.env.CANDIDATE_PARENT_ORG_ID || '';
const CANDIDATE_ID            = process.env.NOANUMTEST_CANDIDATE_ID  || '';
const PROJECT_ID              = process.env.NOANUMTEST_PROJECT_ID    || '';
const ANUM_API_ENABLED        = String(process.env.ANUM_API_ENABLED || 'false').toLowerCase() === 'true';
const ANAM_MODE               = String(process.env.ANAM_MODE || (ANUM_API_ENABLED ? 'healthy' : 'disabled')).toLowerCase();
const SIMULATE_ANAM_MID_SESSION_OUTAGE =
  String(process.env.SIMULATE_ANAM_MID_SESSION_OUTAGE || 'false').toLowerCase() === 'true';
const ANAM_OUTAGE_MODE        = String(process.env.ANAM_OUTAGE_MODE || (ANAM_MODE === 'network' ? 'network' : '503')).toLowerCase();
const ANAM_OUTAGE_AUTO_RECOVER =
  String(process.env.ANAM_OUTAGE_AUTO_RECOVER || 'true').toLowerCase() !== 'false';
const ANAM_OUTAGE_RECOVER_AFTER_MS = Number(process.env.ANAM_OUTAGE_RECOVER_AFTER_MS || 15000);
const OUTAGE_AUTO_COMPLETE_ACTIVITY =
  String(process.env.OUTAGE_AUTO_COMPLETE_ACTIVITY || 'true').toLowerCase() !== 'false';
const ANAM_REQUIRE_POST_RECOVERY_RETRY =
  String(process.env.ANAM_REQUIRE_POST_RECOVERY_RETRY || 'false').toLowerCase() === 'true';
const HEADLESS               = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const PLAYWRIGHT_MICROPHONE_MODE = String(
  process.env.PLAYWRIGHT_MICROPHONE_MODE || 'fake'
).trim().toLowerCase();
const STEP_TIMEOUT           = Number(process.env.STEP_TIMEOUT_MS   || 20000);
const TIMER_WAIT             = Number(process.env.TIMER_MAX_WAIT_MIN || 15) * 60 * 1000;
const MAX_ACTIVITIES         = Number(process.env.MAX_ACTIVITIES     || 10);
const BOOKING_START_SETTLE_MS = Math.max(0, Number(process.env.BOOKING_START_SETTLE_MS || 3000));
const ANAM                   = /(?:^|\.)anam\.ai/i;
const ANAM_ENGINE_SESSION_URL = 'https://api.anam.ai/v1/engine/session';
const ANAM_METRICS_URL        = 'https://api.anam.ai/v1/metrics/client';

// ── FIX 1: Correct apiBase derivation ────────────────────────────────────────
// Portal: https://symulate-ai-dev.weuno.co
// API:    https://api.symulate.weuno.co/dev/api
// Strategy: drop the first subdomain (symulate-ai-dev), prepend 'api.symulate.'
function apiBase() {
  if (EXPLICIT_API_URL) return EXPLICIT_API_URL.replace(/\/$/, '');
  if (!CANDIDATE_URL) return null;
  try {
    const u = new URL(CANDIDATE_URL);
    const parts = u.hostname.split('.');
    const domain = parts.slice(1).join('.');
    return `${u.protocol}//api.symulate.${domain}/dev/api`;
  } catch (_) {
    return null;
  }
}

// ── FIX 2: Node.js HTTP helper — runs in main process, no browser sandbox ────
// Returns { status, body } where body is parsed JSON or raw string.
function nodeRequest(method, urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try { parsedUrl = new URL(urlStr); } catch (e) { return reject(e); }

    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method,
      headers:  {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch (_) { body = raw; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function getExpectedProjectActivityCount(projectId, accessToken, api) {
  if (!projectId || !accessToken || !api) return null;

  try {
    const result = await nodeRequest(
      'GET',
      `${api}/project/get-project-by-id/${projectId}`,
      accessToken
    );
    if (result.status < 200 || result.status >= 300) return null;

    const project = result.body && result.body.data ? result.body.data : result.body;
    const stages = project && Array.isArray(project.stages) ? project.stages : [];
    const ids = new Set();

    stages.forEach((stage) => {
      const items = Array.isArray(stage.stageActivities)
        ? stage.stageActivities
        : (Array.isArray(stage.activities) ? stage.activities : []);
      items.forEach((item) => {
        const activity = item && (item.activity || item);
        const id = (activity && activity.id) || (item && item.activityId);
        if (id) ids.add(String(id));
      });
    });

    return ids.size || null;
  } catch (_) {
    return null;
  }
}

// Button text patterns — adjust here if portal text differs
const BTN = {
  bookSlot:       [/book/i, /select.*slot/i],
  confirmBooking: [/confirm/i, /yes/i],
  enter:          [/start/i, /enter/i, /join/i, /begin/i],
  agree:          [/accept/i, /agree/i, /i understand/i, /continue/i],
  startActivity:  [/start/i, /begin/i, /play/i, /open/i],
  submit:         [/submit/i, /finish/i, /complete/i, /done/i, /next/i]
};

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

async function tryClick(page, patterns, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const pat of patterns) {
      try {
        const btn = page.getByRole('button', { name: pat }).first();
        if (await btn.isVisible({ timeout: 500 }) && await btn.isEnabled().catch(() => true)) {
          await btn.click({ timeout: 2000 });
          return true;
        }
      } catch (_) {}
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function tryClickWithProgress(page, patterns, timeout, progressEveryMs, label) {
  const deadline = Date.now() + timeout;
  let nextLog = Date.now() + progressEveryMs;
  while (Date.now() < deadline) {
    for (const pat of patterns) {
      try {
        const btn = page.getByRole('button', { name: pat }).first();
        if (await btn.isVisible({ timeout: 500 }) && await btn.isEnabled().catch(() => true)) {
          await btn.click({ timeout: 2000 });
          return true;
        }
      } catch (_) {}
    }
    if (Date.now() >= nextLog) {
      const remainingMin = Math.max(0, Math.round((deadline - Date.now()) / 60000));
      log('Wait', `${label} — still waiting, ~${remainingMin} min left before timeout`);
      nextLog = Date.now() + progressEveryMs;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function isDataProtectionNoticeVisible(page, timeout = 500) {
  try {
    const heading = page.getByText(/Data Protection Notice/i).first();
    const continueBtn = page.getByRole('button', { name: /Continue to assessment/i }).first();
    return (
      await heading.isVisible({ timeout }).catch(() => false) &&
      await continueBtn.isVisible({ timeout }).catch(() => false)
    );
  } catch (_) {
    return false;
  }
}

async function acceptDataProtectionNotice(page, timeout = 15000) {
  const deadline = Date.now() + timeout;

  // Give the modal a short opportunity to render. If it is not present, this
  // helper returns present=false so a different/legacy agreement flow can be
  // handled by the generic fallback.
  let present = false;
  while (Date.now() < Math.min(deadline, Date.now() + 2500)) {
    if (await isDataProtectionNoticeVisible(page, 300)) {
      present = true;
      break;
    }
    await page.waitForTimeout(200);
  }

  if (!present) return { present: false, accepted: false, note: 'Data Protection Notice not present' };

  log('Policy', 'Data Protection Notice detected — accepting required confirmation');

  const labelText = /I confirm that I have read and understood/i;
  let checkbox = null;

  // Preferred semantic selector: works when the checkbox is correctly wrapped
  // by, or associated with, the label provided by the portal.
  try {
    const byLabel = page.getByLabel(labelText).first();
    if (await byLabel.count()) checkbox = byLabel;
  } catch (_) {}

  // Fallback to the actual DOM shape supplied from the portal:
  // label.flex.cursor-pointer -> input[type=checkbox]
  if (!checkbox) {
    try {
      const label = page.locator('label.flex.cursor-pointer').filter({ hasText: labelText }).first();
      if (await label.count()) {
        const nested = label.locator('input[type="checkbox"]').first();
        if (await nested.count()) checkbox = nested;
      }
    } catch (_) {}
  }

  // Broader fallback for minor Tailwind/class changes while retaining the
  // required label text as the anchor.
  if (!checkbox) {
    try {
      const label = page.locator('label').filter({ hasText: labelText }).first();
      if (await label.count()) {
        const nested = label.locator('input[type="checkbox"]').first();
        if (await nested.count()) checkbox = nested;
      }
    } catch (_) {}
  }

  if (checkbox) {
    const alreadyChecked = await checkbox.isChecked().catch(() => false);
    if (!alreadyChecked) {
      await checkbox.check({ force: true, timeout: 3000 }).catch(async () => {
        // Some custom checkbox implementations hide the native input. Clicking
        // the label is the safest fallback because it triggers the same React
        // onChange path as a real user.
        const label = page.locator('label').filter({ hasText: labelText }).first();
        await label.click({ force: true, timeout: 3000 });
      });
    }

    const checked = await checkbox.isChecked().catch(() => false);
    if (!checked) {
      throw new Error('Data Protection Notice confirmation checkbox could not be checked');
    }
  } else {
    // If the native checkbox cannot be resolved, click the supplied label and
    // then rely on the button enabled-state as the verification signal.
    const label = page.locator('label.flex.cursor-pointer').filter({ hasText: labelText }).first();
    if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) {
      throw new Error('Data Protection Notice confirmation label/checkbox not found');
    }
    await label.click({ force: true, timeout: 3000 });
  }

  const continueBtn = page.getByRole('button', { name: /Continue to assessment/i }).first();
  await continueBtn.waitFor({ state: 'visible', timeout: 5000 });

  while (Date.now() < deadline) {
    if (await continueBtn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(200);
  }

  if (!(await continueBtn.isEnabled().catch(() => false))) {
    throw new Error('Continue to assessment remained disabled after confirming the Data Protection Notice');
  }

  await continueBtn.click({ timeout: 5000 });

  // Do not silently continue with the overlay still blocking the page.
  const closed = await page.getByRole('button', { name: /Continue to assessment/i }).first()
    .waitFor({ state: 'hidden', timeout: 8000 })
    .then(() => true)
    .catch(() => false);

  if (!closed && await isDataProtectionNoticeVisible(page, 500)) {
    throw new Error('Data Protection Notice remained open after clicking Continue to assessment');
  }

  await page.waitForTimeout(500);
  return { present: true, accepted: true, note: 'confirmation checked and Continue to assessment clicked' };
}

// Three-strategy slot radio selector
async function trySelectSlotRadio(page, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const radios = page.locator('input[type="radio"]');
      if ((await radios.count()) > 0) {
        await radios.first().check({ timeout: 1500, force: true });
        if (await radios.first().isChecked().catch(() => false)) {
          return { ok: true, strategy: 'native radio input' };
        }
      }
    } catch (_) {}
    try {
      const ariaRadios = page.locator('[role="radio"]');
      if ((await ariaRadios.count()) > 0) {
        const first = ariaRadios.first();
        await first.click({ timeout: 1500, force: true });
        const checkedAttr = await first.getAttribute('aria-checked').catch(() => null);
        if (checkedAttr === 'true') return { ok: true, strategy: 'role="radio" element' };
      }
    } catch (_) {}
    try {
      const row = page.getByText(/Time:\s*\d/i).first();
      if (await row.isVisible({ timeout: 500 })) {
        await row.click({ timeout: 1500 });
        return { ok: true, strategy: 'clicked slot row text (unverified)' };
      }
    } catch (_) {}
    await page.waitForTimeout(500);
  }
  return { ok: false, strategy: null };
}

// ── API pre-book via Node.js (FIX 2) ─────────────────────────────────────────
// GET /projects/{id}/bookings/slots → POST /projects/{id}/bookings { slotStart }
async function preBookViaApi(projectId, accessToken, api) {
  if (!projectId || !accessToken || !api) {
    return { ok: false, note: 'missing projectId / token / apiUrl — cannot establish booking' };
  }

  try {
    // 1. Always check whether this candidate is already booked first.
    //    This makes the operation idempotent and prevents a second POST from
    //    being interpreted by the backend as a reschedule.
    const existingRes = await nodeRequest(
      'GET',
      `${api}/projects/${projectId}/bookings/my-booking`,
      accessToken
    );

    if (existingRes.status >= 200 && existingRes.status < 300) {
      const data = (existingRes.body && existingRes.body.data) || {};
      const booking = data.booking || null;
      const existingBookingId = (booking && booking.id) || data.id || null;
      const existingSlotStart = (booking && booking.bookedStartAt) || data.slotStart || null;
      const existingStatus = (booking && booking.status) || data.status || null;

      if (existingBookingId && (existingStatus === 'BOOKED' || data.status === 'CONFIRMED')) {
        return {
          ok: true,
          alreadyBooked: true,
          projectTitle: data.projectTitle || null,
          bookingId: existingBookingId,
          slotStart: existingSlotStart,
          note: `existing booking detected${data.projectTitle ? ` for "${data.projectTitle}"` : ''} — bookingId=${existingBookingId}, slotStart=${existingSlotStart || 'n/a'}`
        };
      }
    } else if (existingRes.status !== 404) {
      return {
        ok: false,
        note: `GET /bookings/my-booking → HTTP ${existingRes.status}: ${JSON.stringify(existingRes.body)}`
      };
    } else {
      const message = String(existingRes.body && existingRes.body.message || '');
      if (/not assigned to this project/i.test(message)) {
        return { ok: false, note: `candidate/project assignment invalid: ${message}` };
      }
    }

    // 2. No active booking exists — fetch a fresh slot list.
    const slotsRes = await nodeRequest(
      'GET',
      `${api}/projects/${projectId}/bookings/slots`,
      accessToken
    );

    if (slotsRes.status < 200 || slotsRes.status >= 300) {
      return {
        ok: false,
        note: `GET /bookings/slots → HTTP ${slotsRes.status}: ${JSON.stringify(slotsRes.body)}`
      };
    }

    const slotsData = (slotsRes.body && slotsRes.body.data) || {};
    const slots = slotsData.availableSlots || [];
    if (slots.length === 0) {
      return {
        ok: false,
        projectTitle: slotsData.projectTitle || null,
        note: `no available slots returned${slotsData.projectTitle ? ` for "${slotsData.projectTitle}"` : ''}; availabilityStart=${slotsData.config && slotsData.config.availabilityStart || 'n/a'}, availabilityEnd=${slotsData.config && slotsData.config.availabilityEnd || 'n/a'}`
      };
    }

    const slotStart = slots[0].startAt;

    // 3. Create the booking once. Never submit the UI booking again after this.
    const bookRes = await nodeRequest(
      'POST',
      `${api}/projects/${projectId}/bookings`,
      accessToken,
      { slotStart }
    );

    if (bookRes.status >= 200 && bookRes.status < 300) {
      const bookingId = bookRes.body && bookRes.body.data && bookRes.body.data.id;
      return {
        ok: true,
        alreadyBooked: false,
        projectTitle: slotsData.projectTitle || null,
        bookingId,
        slotStart,
        note: `booked${slotsData.projectTitle ? ` "${slotsData.projectTitle}"` : ''} — bookingId=${bookingId || 'n/a'}, slotStart=${slotStart}`
      };
    }

    // A 409 is not automatically success. It can be a reschedule-cutoff
    // conflict. Re-read my-booking and only accept 409 when a real BOOKED
    // record already exists for this candidate/project.
    if (bookRes.status === 409) {
      const verifyRes = await nodeRequest(
        'GET',
        `${api}/projects/${projectId}/bookings/my-booking`,
        accessToken
      );
      const verifyData = (verifyRes.body && verifyRes.body.data) || {};
      const verifyBooking = verifyData.booking || null;
      if (verifyRes.status >= 200 && verifyRes.status < 300 && verifyBooking && verifyBooking.id && verifyBooking.status === 'BOOKED') {
        return {
          ok: true,
          alreadyBooked: true,
          projectTitle: verifyData.projectTitle || slotsData.projectTitle || null,
          bookingId: verifyBooking.id,
          slotStart: verifyBooking.bookedStartAt || verifyData.slotStart || null,
          note: `booking already existed after POST conflict — bookingId=${verifyBooking.id}, slotStart=${verifyBooking.bookedStartAt || verifyData.slotStart || 'n/a'}`
        };
      }
    }

    return {
      ok: false,
      note: `POST /bookings → HTTP ${bookRes.status}: ${JSON.stringify(bookRes.body)}`
    };
  } catch (e) {
    return { ok: false, note: `API booking threw: ${e.message}` };
  }
}

async function hasVisibleButton(page, patterns, timeout = 250) {
  for (const pat of patterns) {
    try {
      const button = page.getByRole('button', { name: pat }).first();
      if (await button.isVisible({ timeout }).catch(() => false)) return true;
    } catch (_) {}
  }
  return false;
}

async function assessmentEntryTransitionReached(page) {
  if (await isDataProtectionNoticeVisible(page, 300)) return true;
  try {
    const pathname = new URL(page.url()).pathname;
    return !pathname.startsWith('/booking');
  } catch (_) {
    return !/\/booking(?:\/|$)/i.test(page.url());
  }
}

async function waitForAssessmentActivityControls(page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let stageNavigationAttempted = false;

  while (Date.now() < deadline) {
    if (await hasVisibleButton(page, BTN.startActivity, 300)) return true;

    // Some portal builds land on a stage overview before rendering the first
    // activity. Only click explicit stage/resume controls; avoid broad button
    // matching here so booking controls cannot be mistaken for assessment entry.
    if (!stageNavigationAttempted) {
      const stagePatterns = [/^stage\s*1$/i, /continue assessment/i, /resume assessment/i, /view assessment/i];
      for (const pat of stagePatterns) {
        try {
          const control = page.getByRole('button', { name: pat }).first();
          if (await control.isVisible({ timeout: 250 }).catch(() => false) && await control.isEnabled().catch(() => true)) {
            await control.click({ timeout: 2000 });
            stageNavigationAttempted = true;
            await page.waitForTimeout(1000);
            break;
          }
          const link = page.getByRole('link', { name: pat }).first();
          if (await link.isVisible({ timeout: 250 }).catch(() => false)) {
            await link.click({ timeout: 2000 });
            stageNavigationAttempted = true;
            await page.waitForTimeout(1000);
            break;
          }
        } catch (_) {}
      }
    }

    await page.waitForTimeout(500);
  }

  return false;
}

// ── entry-check polling via Node.js (FIX 2) ──────────────────────────────────
// Polls GET /projects/{id}/bookings/entry-check until canEnter=true,
// then clicks the entry button in the browser.
async function waitForEntryViaApiThenClick(page, projectId, accessToken, api, timeout, progressEveryMs) {
  // Some portal versions transition directly to the Data Protection Notice
  // instead of rendering a separate Start assessment button. Treat that as a
  // successful entry-state transition; the next step will accept the notice.
  if (await isDataProtectionNoticeVisible(page, 500)) {
    log('EntryWait', 'Data Protection Notice is already visible — entry gate reached');
    return true;
  }

  if (!projectId || !accessToken || !api) {
    log('EntryWait', 'No API params — falling back to button/policy polling');
    const deadline = Date.now() + timeout;
    let nextLog = Date.now() + progressEveryMs;
    while (Date.now() < deadline) {
      if (await isDataProtectionNoticeVisible(page, 300)) return true;
      if (await tryClick(page, BTN.enter, 1000)) return true;
      if (Date.now() >= nextLog) {
        const remainingMin = Math.max(0, Math.round((deadline - Date.now()) / 60000));
        log('EntryWait', `No entry button / policy notice yet — ~${remainingMin} min remaining`);
        nextLog = Date.now() + progressEveryMs;
      }
      await page.waitForTimeout(1000);
    }
    return false;
  }

  const deadline = Date.now() + timeout;
  let nextLog = Date.now() + progressEveryMs;
  let lastReason = 'not yet checked';
  let syncedAfterCanEnter = false;

  log('EntryWait', 'Polling entry-check API (Node.js) until canEnter=true...');

  while (Date.now() < deadline) {
    if (await isDataProtectionNoticeVisible(page, 300)) {
      log('EntryWait', 'Data Protection Notice became visible — entry gate reached');
      return true;
    }

    try {
      const currentTime = new Date().toISOString();
      const res = await nodeRequest(
        'GET',
        `${api}/projects/${projectId}/bookings/entry-check?currentTime=${encodeURIComponent(currentTime)}`,
        accessToken
      );
      const data = (res.body && res.body.data) || {};

      if (data.canEnter) {
        if (!syncedAfterCanEnter) {
          log('EntryWait', 'entry-check: canEnter=true — reloading browser so SPA re-fetches my-booking / entry state');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
          await page.waitForTimeout(1500);
          if (BOOKING_START_SETTLE_MS > 0) {
            log('EntryWait', `Booking gate is open; waiting ${BOOKING_START_SETTLE_MS}ms for session services to observe the booked start time`);
            await page.waitForTimeout(BOOKING_START_SETTLE_MS);
          }
          syncedAfterCanEnter = true;
        }

        if (await isDataProtectionNoticeVisible(page, 500)) {
          log('EntryWait', 'entry-check canEnter=true and Data Protection Notice is visible — continuing to policy acceptance');
          return true;
        }

        if (await assessmentEntryTransitionReached(page)) {
          log('EntryWait', `entry-check canEnter=true and browser already left booking flow (${page.url()})`);
          return true;
        }

        const clicked = await tryClick(page, BTN.enter, 5000);
        if (clicked) {
          await page.waitForTimeout(1000);
          if (await assessmentEntryTransitionReached(page)) return true;
          lastReason = `entry control was clicked but browser remained in booking flow (url=${page.url()})`;
        } else {
          lastReason = `canEnter=true but entry button not rendered after browser refresh (url=${page.url()})`;
        }
      } else {
        lastReason = data.reason || `HTTP ${res.status}`;
      }
    } catch (e) {
      lastReason = `nodeRequest/browser sync error: ${e.message}`;
    }

    if (Date.now() >= nextLog) {
      const remainingMin = Math.max(0, Math.round((deadline - Date.now()) / 60000));
      log('EntryWait', `${lastReason} — ~${remainingMin} min remaining`);
      nextLog = Date.now() + progressEveryMs;
    }

    await page.waitForTimeout(3000);
  }

  log('EntryWait', `Timed out: ${lastReason}`);
  return false;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!CANDIDATE_URL || !CANDIDATE_ACCESS_TOKEN) {
    console.error([
      '',
      'ABORTED — set these env vars:',
      '  CANDIDATE_URL           = https://symulate-ai-dev.weuno.co',
      '  CANDIDATE_ACCESS_TOKEN  = (from validation setup output)',
      '',
      'Shortcut: npm run e2e:no-anum:full  (all automatic)',
      ''
    ].join('\n'));
    process.exitCode = 2;
    return;
  }

  const validModes = new Set(['disabled', 'healthy', 'outage503', 'network']);
  if (!validModes.has(ANAM_MODE)) {
    console.error(`ABORTED — unsupported ANAM_MODE=${ANAM_MODE}`);
    process.exitCode = 2;
    return;
  }

  const outageScenario = SIMULATE_ANAM_MID_SESSION_OUTAGE && (ANAM_MODE === 'outage503' || ANAM_MODE === 'network');
  const runDir = createRun(path.join(__dirname, 'artifacts'));
  log('Setup', `Artifacts → ${runDir}`);

  const API_BASE = apiBase();
  log('Setup', `API base → ${API_BASE || '(could not derive — API pre-book disabled)'}`);
  log('Setup', `ANAM_MODE=${ANAM_MODE}, ANUM_API_ENABLED=${ANUM_API_ENABLED}, outageScenario=${outageScenario}`);

  const anamHits = [];
  const anamBlockedRequests = [];
  const anamSuccessfulRequests = [];
  const expectedOutageErrors = [];
  const unexpectedConsoleErrors = [];
  const autoCompletedActivities = [];
  const steps = [];

  let overallResult = 'PASS';
  let videoPath = null;
  let pageCrashed = false;
  let apiBookingSecured = false;
  let apiBookingResult = null;
  let engineSessionSucceeded = false;
  let initialMetricsSucceeded = false;
  let postRecoveryAnamSuccess = false;
  let anamOutageActive = false;
  let outageCycleCompleted = false;
  let outageActivatedAt = null;
  let outageRecoveredAt = null;
  let recoveryTimer = null;
  let lastStartedActivity = null;
  let activityStartEpochMs = 0;

  const activeAnamSockets = new Set();

  const validMicrophoneModes = new Set(['fake', 'system', 'disabled']);
  if (!validMicrophoneModes.has(PLAYWRIGHT_MICROPHONE_MODE)) {
    throw new Error(
      `Unsupported PLAYWRIGHT_MICROPHONE_MODE=${PLAYWRIGHT_MICROPHONE_MODE}. ` +
      'Use fake | system | disabled.'
    );
  }

  const launchArgs = [];
  if (PLAYWRIGHT_MICROPHONE_MODE === 'fake') {
    // Deterministic CI/E2E media stream. This does not depend on the Windows
    // default microphone and works in both headed and headless Chromium.
    launchArgs.push(
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream'
    );
  } else if (PLAYWRIGHT_MICROPHONE_MODE === 'system') {
    // Permission is still granted through BrowserContext below; this suppresses
    // Chromium's native permission prompt while retaining the real input device.
    launchArgs.push('--use-fake-ui-for-media-stream');
  }

  const browser = await chromium.launch({
    headless: HEADLESS,
    args: launchArgs
  });
  const context = await browser.newContext({
    recordVideo: { dir: path.join(runDir, 'video'), size: { width: 1280, height: 800 } },
    viewport: { width: 1280, height: 800 }
  });

  if (PLAYWRIGHT_MICROPHONE_MODE !== 'disabled') {
    let candidateOrigin;
    try {
      candidateOrigin = new URL(CANDIDATE_URL).origin;
    } catch (_) {
      throw new Error(`Invalid CANDIDATE_URL for microphone permission: ${CANDIDATE_URL}`);
    }

    await context.grantPermissions(['microphone'], { origin: candidateOrigin });
    log(
      'Setup',
      `Microphone access granted for ${candidateOrigin}; mode=${PLAYWRIGHT_MICROPHONE_MODE}`
    );
  } else {
    log('Setup', 'Microphone permission intentionally disabled for this run');
  }

  const page = await context.newPage();

  function isAnamUrl(url) {
    try {
      return ANAM.test(new URL(url).hostname);
    } catch (_) {
      return ANAM.test(String(url || ''));
    }
  }

  function recordBlockedAnam(entry) {
    const item = { ...entry, when: new Date().toISOString(), whenMs: Date.now() };
    anamBlockedRequests.push(item);
    return item;
  }

  async function closeAnamSocketPair(pair, reason) {
    const options = { code: 1013, reason };
    try { await pair.client.close(options); } catch (_) {}
    try { await pair.server.close(options); } catch (_) {}
    activeAnamSockets.delete(pair);
  }

  function recoverAnamOutage() {
    if (!anamOutageActive) return;
    anamOutageActive = false;
    outageRecoveredAt = new Date().toISOString();
    log('AnamOutage', `SERVICE RESTORED — Anam traffic is allowed again (${outageRecoveredAt})`);
    writeEvidence(runDir, 'anam-outage-recovered', {
      mode: ANAM_MODE,
      recoveredAt: outageRecoveredAt,
      blockedCount: anamBlockedRequests.length
    });
  }

  async function activateAnamOutage() {
    if (!outageScenario || anamOutageActive || outageCycleCompleted) return;
    if (!engineSessionSucceeded || !initialMetricsSucceeded) return;

    outageCycleCompleted = true;
    anamOutageActive = true;
    outageActivatedAt = new Date().toISOString();

    log('AnamOutage', '===================================================');
    log('AnamOutage', 'SIMULATED ANAM MID-SESSION OUTAGE ACTIVATED');
    log('AnamOutage', `mode=${ANAM_OUTAGE_MODE}`);
    log('AnamOutage', 'engine/session already succeeded');
    log('AnamOutage', 'metrics/client already succeeded');
    log('AnamOutage', 'subsequent Anam HTTP/WebSocket traffic will fail');
    log('AnamOutage', '===================================================');

    writeEvidence(runDir, 'anam-outage-activated', {
      mode: ANAM_MODE,
      outageMode: ANAM_OUTAGE_MODE,
      activatedAt: outageActivatedAt,
      initialSuccessfulRequests: anamSuccessfulRequests
    });

    for (const pair of Array.from(activeAnamSockets)) {
      recordBlockedAnam({ type: 'websocket-disconnect', url: pair.url });
      log('AnamOutage', `DROP active websocket ${pair.url}`);
      await closeAnamSocketPair(pair, 'Simulated Anam service outage');
    }

    if (ANAM_OUTAGE_AUTO_RECOVER && ANAM_OUTAGE_RECOVER_AFTER_MS > 0) {
      recoveryTimer = setTimeout(recoverAnamOutage, ANAM_OUTAGE_RECOVER_AFTER_MS);
    }
  }

  async function waitForCondition(predicate, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await page.waitForTimeout(intervalMs);
    }
    return !!predicate();
  }

  async function autoCompleteLastBrowserActivity() {
    if (!OUTAGE_AUTO_COMPLETE_ACTIVITY) {
      return { ok: false, skipped: true, note: 'OUTAGE_AUTO_COMPLETE_ACTIVITY=false' };
    }
    if (!API_BASE || !PROJECT_ID || !lastStartedActivity || !lastStartedActivity.activityId) {
      return { ok: false, skipped: true, note: 'activityId/API/project context not available for cleanup' };
    }
    if (lastStartedActivity.capturedAtMs < activityStartEpochMs - 1000) {
      return { ok: false, skipped: true, note: 'captured activity belongs to an earlier browser activity' };
    }

    const activityId = lastStartedActivity.activityId;
    const projectId = lastStartedActivity.projectId || PROJECT_ID;
    const res = await nodeRequest(
      'PATCH',
      `${API_BASE}/activities/candidate-activity/update-status/${activityId}`,
      CANDIDATE_ACCESS_TOKEN,
      { status: 'COMPLETED', projectId, endedAt: new Date().toISOString() }
    );

    const ok = res.status >= 200 && res.status < 300;
    if (ok) {
      const evidence = {
        activityId,
        projectId,
        status: res.status,
        when: new Date().toISOString(),
        reason: 'browser outage cleanup after service recovery / retry window'
      };
      autoCompletedActivities.push(evidence);
      writeEvidence(runDir, `activity-${activityId}-auto-completed`, evidence);
      log('OutageCleanup', `Marked browser activity ${activityId} COMPLETED after recovery (HTTP ${res.status})`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT }).catch(() => {});
      await page.waitForTimeout(1000);
    }

    return {
      ok,
      skipped: false,
      note: ok
        ? `activity ${activityId} marked COMPLETED via real candidate-activity endpoint after recovery`
        : `activity completion PATCH returned HTTP ${res.status}: ${JSON.stringify(res.body)}`
    };
  }

  // HTTP outage interceptor. Initial Anam calls pass through. Only after both
  // initial engine/session and metrics/client have returned 2xx do we enter
  // outage state and start failing subsequent requests.
  await context.route('https://api.anam.ai/**', async (route) => {
    if (!outageScenario || !anamOutageActive) {
      await route.continue();
      return;
    }

    const req = route.request();
    recordBlockedAnam({ type: 'http', method: req.method(), url: req.url(), outageMode: ANAM_OUTAGE_MODE });
    log('AnamOutage', `BLOCK HTTP ${req.method()} ${req.url()} (${ANAM_OUTAGE_MODE})`);

    if (ANAM_OUTAGE_MODE === 'network') {
      await route.abort('failed');
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({
        error: 'SIMULATED_ANAM_SERVICE_OUTAGE',
        message: 'Anam service intentionally unavailable during resilience test'
      })
    });
  });

  // WebSocket interceptor. Healthy traffic is transparently proxied. When the
  // outage activates, existing Anam sockets are dropped immediately and new
  // Anam sockets are rejected until recovery.
  await context.routeWebSocket(/wss:\/\/.*anam\.ai\/.*/i, async (ws) => {
    const url = ws.url();
    log('AnamWS', `WebSocket requested: ${url}`);

    if (outageScenario && anamOutageActive) {
      recordBlockedAnam({ type: 'websocket', url, outageMode: ANAM_OUTAGE_MODE });
      log('AnamOutage', `BLOCK websocket ${url}`);
      await ws.close({ code: 1013, reason: 'Simulated Anam service outage' });
      return;
    }

    const server = ws.connectToServer();
    const pair = { client: ws, server, url };
    activeAnamSockets.add(pair);
    const remove = () => activeAnamSockets.delete(pair);
    ws.onClose(remove);
    server.onClose(remove);

    if (outageRecoveredAt) {
      postRecoveryAnamSuccess = true;
      log('AnamOutage', `Post-recovery Anam WebSocket reconnect observed: ${url}`);
    }
  });

  page.on('request', (req) => {
    const url = req.url();

    if (isAnamUrl(url)) {
      anamHits.push({
        url,
        method: req.method(),
        status: null,
        when: new Date().toISOString(),
        outageActiveAtRequest: anamOutageActive
      });
      log('AnamWatch', `${ANUM_API_ENABLED ? 'Anam' : 'UNEXPECTED Anam'} request: ${req.method()} ${url}`);
    }

    // Capture the real Symulate activity id so the outage test can cleanly
    // mark the activity COMPLETED after Anam comes back if the UI has no
    // explicit submit button.
    if (req.method() === 'POST' && /\/activities\/session-token(?:\?|$)/i.test(url)) {
      try {
        const body = req.postDataJSON();
        if (body && body.activityId) {
          lastStartedActivity = {
            activityId: body.activityId,
            projectId: body.projectId || PROJECT_ID,
            capturedAt: new Date().toISOString(),
            capturedAtMs: Date.now(),
            source: 'session-token-request'
          };
        }
      } catch (_) {}
    } else if (req.method() === 'POST') {
      const boardMatch = url.match(/\/activities\/([^/]+)\/board-meeting\/[^/]+\/session-token/i);
      if (boardMatch) {
        lastStartedActivity = {
          activityId: boardMatch[1],
          projectId: PROJECT_ID,
          capturedAt: new Date().toISOString(),
          capturedAtMs: Date.now(),
          source: 'board-meeting-session-token-request'
        };
      }
    }
  });

  page.on('response', (res) => {
    const url = res.url();
    if (!isAnamUrl(url)) return;

    const hit = [...anamHits].reverse().find((item) => item.url === url && item.status === null);
    if (hit) hit.status = res.status();

    const method = res.request().method();
    const success = res.status() >= 200 && res.status() < 300;

    if (success) {
      if (method === 'POST' && url.startsWith(ANAM_ENGINE_SESSION_URL) && !engineSessionSucceeded) {
        engineSessionSucceeded = true;
        anamSuccessfulRequests.push({ type: 'engine-session', status: res.status(), url, when: new Date().toISOString() });
        log('AnamOutage', `Initial engine/session succeeded → HTTP ${res.status()}`);
      }
      if (method === 'POST' && url.startsWith(ANAM_METRICS_URL) && !initialMetricsSucceeded) {
        initialMetricsSucceeded = true;
        anamSuccessfulRequests.push({ type: 'metrics', status: res.status(), url, when: new Date().toISOString() });
        log('AnamOutage', `Initial metrics/client succeeded → HTTP ${res.status()}`);
      }
      if (outageRecoveredAt) {
        postRecoveryAnamSuccess = true;
      }
    }

    if (outageScenario && engineSessionSucceeded && initialMetricsSucceeded && !outageCycleCompleted) {
      activateAnamOutage().catch((error) => {
        unexpectedConsoleErrors.push({
          text: `outage activation error: ${error.message}`,
          when: new Date().toISOString(),
          source: 'harness'
        });
      });
    }
  });

  function classifyConsoleError(message) {
    const text = message.text();
    const location = message.location ? message.location() : {};
    const locationUrl = location && location.url ? location.url : '';
    const now = Date.now();
    const recentBlocked = anamBlockedRequests.some((item) => now - item.whenMs <= 5000);
    const explicitlyAnam = isAnamUrl(locationUrl) || /anam\.ai|\banam\b/i.test(text);
    const outageLike = /503|service unavailable|failed to fetch|websocket|networkerror|err_failed|connection/i.test(text);
    const expected = outageScenario && (explicitlyAnam || (recentBlocked && outageLike));

    const entry = {
      text,
      location: locationUrl || undefined,
      when: new Date().toISOString()
    };

    console.log(`[BrowserConsole:error] ${text}${locationUrl ? ` @ ${locationUrl}` : ''}`);
    if (expected) expectedOutageErrors.push(entry);
    else unexpectedConsoleErrors.push(entry);
  }

  page.on('console', (message) => {
    if (message.type() === 'error') classifyConsoleError(message);
  });
  page.on('pageerror', (error) => {
    const entry = { text: `pageerror: ${error.message}`, when: new Date().toISOString() };
    unexpectedConsoleErrors.push(entry);
    console.log(`[BrowserPageError] ${error.message}`);
  });
  page.on('crash', () => {
    pageCrashed = true;
    const entry = { text: 'PAGE CRASHED', when: new Date().toISOString() };
    unexpectedConsoleErrors.push(entry);
    console.log('[BrowserCrash] PAGE CRASHED');
  });

  async function step(name, fn, { critical = false } = {}) {
    log('Step', `→ ${name}`);
    try {
      const note = (await fn()) || '';
      const sc = await shot(page, runDir, name);
      steps.push({ name, ok: true, note, screenshot: sc });
      log('Step', `✓ ${name}${note ? ` — ${note}` : ''}`);
      return true;
    } catch (e) {
      const sc = await shot(page, runDir, `FAILED-${name}`);
      steps.push({ name, ok: false, note: e.message, screenshot: sc });
      log('Step', `✗ ${name} — ${e.message}`);
      if (critical) throw e;
      return false;
    }
  }

  const startedAt = new Date().toISOString();

  try {
    // 1. Inject the API-minted candidate session into the real SPA.
    await step('Inject candidate session into browser', async () => {
      const base = CANDIDATE_URL.replace(/\/$/, '');
      const portalTokensUrl = '**/auth/candidate/portal-tokens';
      const mockResponse = {
        statusCode: 201,
        success: true,
        message: 'Candidate portal tokens generated successfully',
        data: {
          accessToken: CANDIDATE_ACCESS_TOKEN,
          refreshToken: CANDIDATE_REFRESH_TOKEN || CANDIDATE_ACCESS_TOKEN,
          candidateId: CANDIDATE_ID || null,
          projectId: PROJECT_ID || null,
          organizationId: CANDIDATE_ORG_ID || null,
          parentOrganizationId: CANDIDATE_PARENT_ORG_ID || null
        }
      };

      await page.route(portalTokensUrl, async (route) => {
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(mockResponse) });
      });

      await page.goto(`${base}/login?portalToken=playwright-injected`, {
        waitUntil: 'domcontentloaded',
        timeout: STEP_TIMEOUT
      });
      await page.waitForFunction(
        () => !window.location.pathname.startsWith('/login'),
        { timeout: 15000 }
      ).catch(() => {});
      await page.unroute(portalTokensUrl);
      await page.waitForTimeout(2000);

      const finalUrl = page.url();
      if (finalUrl.includes('/login')) {
        const ss = await page.evaluate(() => {
          const out = {};
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            out[key] = sessionStorage.getItem(key);
          }
          return out;
        });
        throw new Error(`SPA still on /login after mock auth — sessionStorage: ${JSON.stringify(ss)}`);
      }
      return `mock portal-tokens intercepted — SPA self-authenticated — landed on ${finalUrl}`;
    }, { critical: true });

    await step('Verify browser microphone permission', async () => {
      const mediaState = await page.evaluate(async () => {
        const result = {
          secureContext: window.isSecureContext,
          mediaDevicesAvailable: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
          permission: 'unknown'
        };

        try {
          if (navigator.permissions && navigator.permissions.query) {
            const status = await navigator.permissions.query({ name: 'microphone' });
            result.permission = status.state;
          } else {
            result.permission = 'permissions-api-unavailable';
          }
        } catch (error) {
          result.permission = `query-unavailable:${error && error.name ? error.name : 'unknown'}`;
        }

        return result;
      });

      if (PLAYWRIGHT_MICROPHONE_MODE !== 'disabled') {
        if (!mediaState.secureContext) {
          throw new Error('candidate portal is not a secure context; microphone access requires HTTPS');
        }
        if (!mediaState.mediaDevicesAvailable) {
          throw new Error('navigator.mediaDevices.getUserMedia is unavailable in this browser context');
        }
        if (mediaState.permission === 'denied') {
          throw new Error('microphone permission is denied in the Playwright browser context');
        }
      }

      return `mode=${PLAYWRIGHT_MICROPHONE_MODE}; permission=${mediaState.permission}; ` +
        `mediaDevices=${mediaState.mediaDevicesAvailable ? 'available' : 'unavailable'}`;
    }, { critical: PLAYWRIGHT_MICROPHONE_MODE !== 'disabled' });

    // 2. Establish booking exactly once through the backend.
    if (API_BASE && PROJECT_ID) {
      await step('Ensure booking via API', async () => {
        apiBookingResult = await preBookViaApi(PROJECT_ID, CANDIDATE_ACCESS_TOKEN, API_BASE);
        if (!apiBookingResult.ok) throw new Error(apiBookingResult.note);
        apiBookingSecured = true;
        await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT });
        await page.waitForTimeout(1500);
        return `${apiBookingResult.note}; browser booking state refreshed`;
      }, { critical: true });
    } else {
      steps.push({
        name: 'Ensure booking via API',
        ok: true,
        note: 'skipped — no API base or project ID; UI booking fallback will be used',
        screenshot: null
      });
    }

    // 3. UI booking is only a fallback. Never submit a second booking after
    // API booking because the backend treats it as a reschedule.
    const currentUrl = page.url();
    const onBookingPath = currentUrl.includes('/booking') && !currentUrl.includes('/confirmed');
    const bookingTextVisible = await page.getByText(/book.*slot|select.*time|available.*slot|book your slot/i)
      .first().isVisible({ timeout: 4000 }).catch(() => false);
    const bookingPageVisible = onBookingPath || bookingTextVisible;

    if (apiBookingSecured) {
      steps.push({
        name: 'Skip duplicate UI booking',
        ok: true,
        note: `API booking is authoritative${apiBookingResult && apiBookingResult.projectTitle ? ` for "${apiBookingResult.projectTitle}"` : ''}; slot selection / Confirm booking intentionally skipped`,
        screenshot: await shot(page, runDir, 'Skip-duplicate-UI-booking')
      });
      log('Flow', 'API booking already exists — skipping UI slot selection and Confirm booking');
    } else if (bookingPageVisible) {
      await step('Select booking slot', async () => {
        const result = await trySelectSlotRadio(page, 8000);
        if (!result.ok) throw new Error('no slot radio/row could be selected');
        return `slot selected via ${result.strategy}`;
      }, { critical: true });

      await step('Confirm booking', async () => {
        const ok = await tryClick(page, BTN.confirmBooking, 6000);
        if (!ok) throw new Error('Confirm booking button not found');
        return 'confirm button clicked';
      }, { critical: true });

      await step('Verify booking actually went through', async () => {
        await page.waitForTimeout(2000);
        const url = page.url();
        if (url.includes('/booking/confirmed') || url.includes('/confirmed')) return `booking confirmed — landed on ${url}`;
        if (!url.includes('/booking')) return `booking screen no longer showing (url=${url}) — booking succeeded`;
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const errorMatch = bodyText.match(/.{0,80}(reschedule[^\n]*|no slots[^\n]*|please select[^\n]*|failed[^\n]*|error[^\n]*).{0,80}/i);
        throw new Error(`booking UI remained on ${url}${errorMatch ? ` — ${errorMatch[0]}` : ''}`);
      }, { critical: true });
    } else {
      steps.push({ name: 'Skip booking UI', ok: true, note: 'No booking UI visible', screenshot: null });
    }

    // 4. Wait for assessment entry.
    await step('Wait for assessment entry window', async () => {
      log('EntryWait', `Current URL: ${page.url()} — checking authoritative booking entry state`);
      if (await isDataProtectionNoticeVisible(page, 1000)) {
        return 'Data Protection Notice already visible — entry gate reached';
      }

      // When API context is available, never click a generic Start/Enter button
      // before entry-check says canEnter=true. The booking confirmation page can
      // contain unrelated controls whose labels also match those broad patterns.
      if (PROJECT_ID && CANDIDATE_ACCESS_TOKEN && API_BASE) {
        const ok = await waitForEntryViaApiThenClick(
          page,
          PROJECT_ID,
          CANDIDATE_ACCESS_TOKEN,
          API_BASE,
          TIMER_WAIT,
          30000
        );
        if (!ok) throw new Error(`Assessment entry did not become available within ${TIMER_WAIT / 60000} min (url=${page.url()})`);
        return `entry window reached through booking entry-check; url=${page.url()}`;
      }

      const immediateClick = await tryClick(page, BTN.enter, 5000);
      if (!immediateClick) throw new Error(`Entry control not found and API entry-check is unavailable (url=${page.url()})`);
      await page.waitForTimeout(1000);
      if (!(await assessmentEntryTransitionReached(page))) {
        throw new Error(`Entry control click did not leave the booking flow (url=${page.url()})`);
      }
      return `entry control clicked; url=${page.url()}`;
    }, { critical: true });

    // 5. Accept the required Data Protection Notice confirmation.
    await step('Accept agreement / policy modal', async () => {
      const notice = await acceptDataProtectionNotice(page, 15000);
      if (notice.present) return `Data Protection Notice accepted — ${notice.note}`;
      const ok = await tryClick(page, BTN.agree, 10000);
      return ok ? 'alternate agreement accepted' : 'no agreement modal — may not be required';
    }, { critical: true });

    await step('Wait for assessment activity controls', async () => {
      const ready = await waitForAssessmentActivityControls(page, 30000);
      if (!ready) {
        const bodyText = await page.locator('body').innerText().catch(() => '');
        const excerpt = bodyText.replace(/\s+/g, ' ').slice(0, 500);
        throw new Error(`No assessment activity start control became visible (url=${page.url()}, body=${excerpt})`);
      }
      return `assessment activity controls are ready; url=${page.url()}`;
    }, { critical: true });

    // 6. Activity loop. Prefer the authoritative project activity count over
    // MAX_ACTIVITIES so a broad Start/Next selector cannot repeatedly reopen
    // the same screen and manufacture phantom activity iterations.
    const expectedProjectActivities = await getExpectedProjectActivityCount(
      PROJECT_ID,
      CANDIDATE_ACCESS_TOKEN,
      API_BASE
    );
    const activityLoopLimit = expectedProjectActivities
      ? Math.min(MAX_ACTIVITIES, expectedProjectActivities)
      : MAX_ACTIVITIES;
    log(
      'Flow',
      `Activity loop limit=${activityLoopLimit}` +
        `${expectedProjectActivities ? ` (project reports ${expectedProjectActivities} activities)` : ' (project count unavailable; using MAX_ACTIVITIES fallback)'}`
    );

    for (let i = 1; i <= activityLoopLimit; i++) {
      const hitsBefore = anamHits.length;
      activityStartEpochMs = Date.now();
      lastStartedActivity = null;

      const started = await tryClick(page, BTN.startActivity, i === 1 ? 15000 : 5000);
      if (!started) {
        log('Flow', `No more activities after ${i - 1} — done`);
        break;
      }

      await step(`Start activity #${i}`, async () => `activity ${i} opened`);
      await page.waitForTimeout(4000);

      const newHits = anamHits.length - hitsBefore;
      if (ANAM_MODE === 'disabled' && newHits > 0) {
        overallResult = 'FAIL';
        const violating = anamHits.slice(hitsBefore);
        writeEvidence(runDir, `activity-${i}-unexpected-anam-hit`, {
          activity: i,
          anamMode: ANAM_MODE,
          requests: violating
        });
        steps.push({
          name: `Unexpected Anam hit during activity #${i}`,
          ok: false,
          note: `${newHits} request(s) to Anam while Talent Intelligence is disabled`,
          screenshot: await shot(page, runDir, `anam-hit-activity-${i}`)
        });
      }

      // The outage is injected only once, after the first successful engine
      // and metrics requests. Wait for that transition and then allow the
      // configured recovery window so the SDK can retry when service is back.
      if (outageScenario && !outageActivatedAt) {
        await step('Validate Anam outage activation', async () => {
          const activated = await waitForCondition(() => !!outageActivatedAt, 20000, 200);
          if (!activated) {
            throw new Error(
              `outage never activated: engineSuccess=${engineSessionSucceeded}, metricsSuccess=${initialMetricsSucceeded}`
            );
          }
          return `initial Anam calls succeeded, then ${ANAM_OUTAGE_MODE} outage activated`;
        }, { critical: true });
      }

      if (outageScenario && ANAM_OUTAGE_AUTO_RECOVER && outageActivatedAt && !outageRecoveredAt) {
        await step('Wait for simulated Anam service recovery', async () => {
          const recovered = await waitForCondition(
            () => !!outageRecoveredAt,
            Math.max(ANAM_OUTAGE_RECOVER_AFTER_MS + 10000, 15000),
            250
          );
          if (!recovered) throw new Error('Anam outage did not recover inside configured recovery window');
          await page.waitForTimeout(2500);
          return `service restored after ${ANAM_OUTAGE_RECOVER_AFTER_MS}ms; SDK retry window opened`;
        }, { critical: true });
      }

      await step(`Submit / complete activity #${i}`, async () => {
        const clicked = await tryClick(page, BTN.submit, 10000);
        if (clicked) return 'UI submit/complete button clicked';

        if (outageScenario && outageRecoveredAt && OUTAGE_AUTO_COMPLETE_ACTIVITY) {
          const cleanup = await autoCompleteLastBrowserActivity();
          if (cleanup.ok) return cleanup.note;
          throw new Error(`UI completion control was not found and API completion fallback could not run: ${cleanup.note}`);
        }

        throw new Error('UI submit/complete control was not found; activity completion cannot be verified.');
      }, { critical: true });

      await page.waitForTimeout(1000);
    }
  } catch (fatal) {
    overallResult = 'FAIL';
    log('Flow', `FATAL — ${fatal.message}`);
  }

  if (recoveryTimer) clearTimeout(recoveryTimer);

  // Mode-specific assertions.
  const modeChecks = {
    mode: ANAM_MODE,
    talentIntelligenceEnabled: ANUM_API_ENABLED,
    initialEngineSessionSucceeded: engineSessionSucceeded,
    initialMetricsSucceeded,
    outageActivated: !!outageActivatedAt,
    outageRecovered: !!outageRecoveredAt,
    blockedAnamTrafficCount: anamBlockedRequests.length,
    postRecoveryAnamSuccess,
    unexpectedConsoleErrors: unexpectedConsoleErrors.length,
    expectedOutageErrors: expectedOutageErrors.length,
    pageCrashed,
    autoCompletedActivities: autoCompletedActivities.length
  };

  if (ANAM_MODE === 'disabled' && anamHits.length !== 0) overallResult = 'FAIL';

  if (ANAM_MODE === 'healthy') {
    if (!engineSessionSucceeded || !initialMetricsSucceeded) overallResult = 'FAIL';
    if (anamBlockedRequests.length !== 0) overallResult = 'FAIL';
  }

  if (outageScenario) {
    if (!engineSessionSucceeded || !initialMetricsSucceeded) overallResult = 'FAIL';
    if (!outageActivatedAt) overallResult = 'FAIL';
    if (anamBlockedRequests.length === 0) overallResult = 'FAIL';
    if (ANAM_OUTAGE_AUTO_RECOVER && ANAM_OUTAGE_RECOVER_AFTER_MS > 0 && !outageRecoveredAt) overallResult = 'FAIL';
    if (ANAM_REQUIRE_POST_RECOVERY_RETRY && !postRecoveryAnamSuccess) overallResult = 'FAIL';
  }

  if (unexpectedConsoleErrors.length > 0 || pageCrashed) overallResult = 'FAIL';

  const finishedAt = new Date().toISOString();
  const vid = page.video();
  await context.close();
  try { videoPath = vid ? await vid.path() : null; } catch (_) {}

  const summary = {
    anamMode: ANAM_MODE,
    anumApiEnabled: String(ANUM_API_ENABLED),
    candidateUrl: CANDIDATE_URL,
    startedAt,
    finishedAt,
    overallResult,
    modeChecks,
    anamHits,
    anamSuccessfulRequests,
    anamBlockedRequests: anamBlockedRequests.map(({ whenMs, ...rest }) => rest),
    expectedOutageErrors,
    unexpectedConsoleErrors,
    consoleErrors: unexpectedConsoleErrors,
    autoCompletedActivities,
    steps,
    videoPath
  };
  writeEvidence(runDir, 'summary', summary);

  const htmlPath = buildHtml(runDir, summary);
  const pdfPath = await renderPdf(browser, htmlPath, runDir);
  await browser.close();

  console.log('\n==================== RESULT ====================');
  console.log(`Overall                  : ${overallResult}`);
  console.log(`ANAM_MODE                : ${ANAM_MODE}`);
  console.log(`Anam requests observed   : ${anamHits.length}`);
  console.log(`Initial engine/session   : ${engineSessionSucceeded ? 'PASS' : 'NOT OBSERVED'}`);
  console.log(`Initial metrics/client   : ${initialMetricsSucceeded ? 'PASS' : 'NOT OBSERVED'}`);
  if (outageScenario) {
    console.log(`Outage activated          : ${outageActivatedAt ? 'YES' : 'NO'}`);
    console.log(`Anam traffic blocked      : ${anamBlockedRequests.length}`);
    console.log(`Outage recovered          : ${outageRecoveredAt ? 'YES' : 'NO'}`);
    console.log(`Post-recovery retry       : ${postRecoveryAnamSuccess ? 'OBSERVED' : 'NOT OBSERVED'}`);
    console.log(`Activities auto-completed : ${autoCompletedActivities.length}`);
    console.log(`Expected outage errors    : ${expectedOutageErrors.length}`);
  }
  console.log(`Unexpected console errors : ${unexpectedConsoleErrors.length}`);
  console.log(`Page crash                : ${pageCrashed ? 'YES' : 'NO'}`);
  console.log(`HTML report               : ${htmlPath}`);
  console.log(`PDF report                : ${pdfPath}`);
  console.log(`Video                     : ${videoPath || 'n/a'}`);
  console.log(`All artifacts             : ${runDir}`);
  console.log('==================================================\n');

  process.exitCode = overallResult === 'PASS' ? 0 : 1;
}

run().catch((e) => { console.error('FATAL:', e); process.exitCode = 2; });