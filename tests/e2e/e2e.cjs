#!/usr/bin/env node
/**
 * GrantFinder end-to-end browser test (Playwright + Chromium).
 *
 * Drives the REAL production build (website + engine in one Next.js app) the
 * way a person would. Run it through run_e2e.sh, which builds the app and
 * starts it with a mock Claude and a fake parish website.
 *
 *   node tests/e2e/e2e.cjs <phase> <state.json>
 *
 * Phases (run_e2e.sh runs them in this order):
 *   journey  sign in as guest, API key, grant database, website scan, questions,
 *            documents, matching, results + exports, the full application writer
 *            for the Kenedy grant, back to the dashboard, reload
 *   basics   a second guest: AI web discovery, Excel upload, "Enter the basics by
 *            hand", "Skip to questions" via the step bar, matching without documents,
 *            "Keep my saved key", guidelines read from the grant's web page, sign out
 *   errors   a third guest: out-of-credits key, replacing the key, Claude overloaded
 *            while matching, drafting that partly fails, reloading mid-draft
 *   expired  broken / foreign / stale session tokens -> back to sign-in with a notice
 *   persist  (after a server restart) sessions, saved key, grants, results,
 *            application and AI steps all still work
 *   locked   (guest sign-in off) landing explains sign-in isn't set up
 *   down     (engine unreachable) landing explains it can't reach the engine
 *
 * Every check prints PASS/FAIL; a step that breaks takes a screenshot into
 * tests/e2e/artifacts/ and the run continues wherever it still can.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const { FRONTEND, makePdf, makeDocx, makeXlsx, readZipEntry, wordXmlText } = require('./lib/files.cjs');
const FX = require('./lib/fixtures.cjs');

const BASE = (process.env.E2E_BASE_URL || 'http://127.0.0.1:3199').replace(/\/+$/, '');
const MOCK = (process.env.E2E_MOCK_URL || 'http://127.0.0.1:4999').replace(/\/+$/, '');
const PROXY = (process.env.E2E_PROXY_URL || '').replace(/\/+$/, '');
const SITE = (process.env.E2E_SITE_URL || 'http://127.0.0.1:4998').replace(/\/+$/, '');
const ARTIFACTS = process.env.E2E_ARTIFACTS || path.join(__dirname, 'artifacts');
const JOB_TIMEOUT = Number(process.env.E2E_JOB_TIMEOUT_MS || 240000);
const HEADED = process.env.E2E_HEADED === '1';
const SECRET = process.env.E2E_SECRET_KEY || '';

const phase = process.argv[2];
const statePath = process.argv[3] || path.join(ARTIFACTS, 'state.json');
const storagePath = statePath.replace(/\.json$/, '') + '.storage.json';
const DOWNLOADS = path.join(ARTIFACTS, 'downloads', phase || 'none');
fs.mkdirSync(DOWNLOADS, { recursive: true });

const VALID_KEY = 'sk-ant-test-e2e-1';
/** A Claude API key (not the "starts with sk-ant-" hint text). */
const KEY_RE = /sk-ant-[A-Za-z0-9_]/;
const SECOND_KEY = 'sk-ant-test-e2e-2';
const KENEDY = 'Kenedy Memorial Foundation Grants';

// =============================================================================
// Results
// =============================================================================

const results = [];
let currentStep = 'setup';
let stepFailures = 0;
let shotCounter = 0;
let activePage = null;

function fmt(detail) {
  if (detail === undefined) return '';
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return String(text).replace(/\s+/g, ' ').slice(0, 900);
}

function check(name, ok, detail) {
  results.push({ step: currentStep, name, status: ok ? 'PASS' : 'FAIL', detail: ok ? undefined : fmt(detail) });
  if (!ok) stepFailures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${!ok && detail !== undefined ? `\n      :: ${fmt(detail)}` : ''}`);
  return Boolean(ok);
}

function skip(name, why) {
  results.push({ step: currentStep, name, status: 'SKIP', detail: why });
  console.log(`SKIP [${phase}] ${name} :: ${why}`);
}

function info(line) {
  console.log(`     ${line}`);
}

const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function shot(label, page = activePage) {
  if (!page || page.isClosed()) return null;
  shotCounter += 1;
  const file = path.join(ARTIFACTS, `${phase}-${String(shotCounter).padStart(2, '0')}-${slug(label)}.png`);
  try {
    await page.screenshot({ path: file, fullPage: true, timeout: 15000 });
    info(`screenshot: ${path.relative(process.cwd(), file)}`);
    return file;
  } catch (error) {
    info(`(screenshot failed: ${error.message.split('\n')[0]})`);
    return null;
  }
}

/**
 * Run one named step. A crash is a FAIL (with screenshot) and the run goes on.
 * Returns true when the step finished without crashing AND without failed checks.
 */
async function step(name, fn) {
  currentStep = name;
  stepFailures = 0;
  console.log(`\n-- ${name}`);
  let crashed = false;
  try {
    await fn();
  } catch (error) {
    crashed = true;
    check(`${name}: finished without errors`, false, (error && error.message ? error.message : String(error)).split('\n').slice(0, 4).join(' | '));
  }
  flushBrowserProblems();
  if (crashed || stepFailures > 0) await shot(`fail-${name}`);
  return !crashed && stepFailures === 0;
}

function finish() {
  flushBrowserProblems();
  const unexpectedConsole = browserProblems.filter((p) => p.kind === 'console' && !p.expected);
  const serverErrors = browserProblems.filter((p) => p.kind === 'http5xx' && !p.expected);
  currentStep = 'phase checks';
  check('no unexpected browser console errors or page errors', unexpectedConsole.length === 0,
    unexpectedConsole.slice(0, 8).map((p) => `[${p.step}] ${p.text}${p.url ? ` @ ${p.url}` : ''}`).join(' || '));
  check('no 5xx responses from /api/*', serverErrors.length === 0,
    serverErrors.slice(0, 8).map((p) => `[${p.step}] ${p.text}`).join(' || '));
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  fs.writeFileSync(path.join(ARTIFACTS, `results-${phase}.json`), JSON.stringify({ phase, pass, fail, skip: skipped, results, api: apiLog }, null, 2));
  console.log(`\nSUMMARY phase=${phase} pass=${pass} fail=${fail} skip=${skipped}`);
  return fail > 0 || skipped > 0 ? 1 : 0;
}

// =============================================================================
// Browser monitoring: console errors, page errors, 5xx from /api/*
// =============================================================================

const browserProblems = [];
let flushedProblems = 0;
const apiLog = [];

/** Always-expected noise: "none yet" answers the app asks for on purpose. */
const ALWAYS_EXPECTED = [
  { url: /\/api\/processing\/profile$/, text: /status of 404/ },
  { url: /\/api\/processing\/match-results\/latest$/, text: /status of 404/ },
  { url: /\/api\/processing\/questionnaire$/, text: /status of 404/ }, // no saved questions yet
];
let expectedWindows = [];

/** Errors matching these patterns are expected while fn runs (e.g. the deliberate bad API key). */
async function expectingErrors(patterns, fn) {
  const window = { patterns };
  expectedWindows.push(window);
  try {
    return await fn();
  } finally {
    // Late console lines (job polling) can trail the action; keep the window briefly.
    setTimeout(() => {
      expectedWindows = expectedWindows.filter((w) => w !== window);
    }, 1500);
  }
}

function isExpected(text, url) {
  const all = [...ALWAYS_EXPECTED, ...expectedWindows.flatMap((w) => w.patterns)];
  return all.some((p) => (!p.text || p.text.test(text)) && (!p.url || p.url.test(url || '')));
}

function monitor(page, label) {
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const url = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    browserProblems.push({ kind: 'console', step: currentStep, page: label, text: text.slice(0, 400), url, expected: isExpected(text, url) });
  });
  page.on('pageerror', (error) => {
    browserProblems.push({ kind: 'console', step: currentStep, page: label, text: `pageerror: ${error.message}`.slice(0, 400), url: '', expected: isExpected(`pageerror: ${error.message}`, '') });
  });
  page.on('response', (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (url.origin !== BASE || !url.pathname.startsWith('/api/')) return;
    const status = response.status();
    const entry = { step: currentStep, method: response.request().method(), path: url.pathname, status };
    apiLog.push(entry);
    if (status >= 500) {
      const text = `${status} ${entry.method} ${entry.path}`;
      browserProblems.push({ kind: 'http5xx', step: currentStep, page: label, text, url: url.href, expected: isExpected(text, url.href) });
    }
  });
  page.on('requestfailed', (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (url.origin !== BASE) return;
    const failure = (request.failure() && request.failure().errorText) || 'failed';
    if (/ERR_ABORTED/.test(failure) && !url.pathname.startsWith('/api/')) return; // navigation cancelled a prefetch
    const text = `request failed: ${request.method()} ${url.pathname} (${failure})`;
    browserProblems.push({ kind: 'console', step: currentStep, page: label, text, url: url.href, expected: isExpected(text, url.href) || /ERR_ABORTED/.test(failure) });
  });
}

function flushBrowserProblems() {
  const fresh = browserProblems.slice(flushedProblems);
  flushedProblems = browserProblems.length;
  for (const problem of fresh) {
    if (!problem.expected) info(`!! unexpected ${problem.kind} during "${problem.step}": ${problem.text}${problem.url ? ` @ ${problem.url}` : ''}`);
  }
}

// =============================================================================
// Helpers: engine API (with the browser's session token), mock Claude, fake site
// =============================================================================

async function http(method, url, { token, json, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (form) {
    init.body = form;
  }
  const response = await fetch(url, init);
  const buf = Buffer.from(await response.arrayBuffer());
  const text = buf.toString('utf8');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data, text, buf, headers: response.headers };
}

const api = (method, p, options) => http(method, BASE + p, options);

/** Like the website: follow a 202 {job_id} to the job's result. */
async function apiJob(method, p, options = {}, timeoutMs = JOB_TIMEOUT) {
  const first = await api(method, p, options);
  if (first.status !== 202 || !first.data || !first.data.job_id) return first;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(500);
    const poll = await api('GET', `/api/jobs/${first.data.job_id}`, { token: options.token });
    if (poll.status !== 200) return { ...poll, job: first.data.job_id };
    if (poll.data.status === 'done') return { status: 200, data: poll.data.result, job: first.data.job_id };
    if (poll.data.status === 'failed') return { status: poll.data.error ? poll.data.error.status : 500, data: { detail: poll.data.error && poll.data.error.detail }, job: first.data.job_id };
  }
  return { status: 0, data: { detail: `job did not finish in ${timeoutMs} ms` }, job: first.data.job_id };
}

const mock = {
  reset: () => http('POST', `${MOCK}/__reset`),
  requests: async () => (await http('GET', `${MOCK}/__requests`)).data || [],
  fixtures: (map) => http('POST', `${MOCK}/__fixtures`, { json: map }),
  latency: (map) => (PROXY ? http('POST', `${PROXY}/__latency`, { json: map }) : Promise.resolve(null)),
};

const site = {
  reset: () => http('POST', `${SITE}/__reset`),
  hits: async () => (await http('GET', `${SITE}/__hits`)).data || [],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(fn, timeoutMs, what) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(250);
  }
}

async function tokenOf(page) {
  return page.evaluate(() => localStorage.getItem('auth_token'));
}

/** Prompts the mock received for one prompt id since `since` (index into the request log). */
async function promptsFor(promptId, since = 0) {
  const all = await mock.requests();
  return all.slice(since).filter((r) => r.prompt_id === promptId);
}

async function requestCount() {
  return (await mock.requests()).length;
}

/** Collect the distinct texts of the [role=status] busy banner while `fn` runs. */
async function watchStatus(page, fn) {
  const seen = [];
  let running = true;
  const poller = (async () => {
    while (running) {
      try {
        const texts = await page.locator('[role=status]').allInnerTexts();
        for (const text of texts.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
          if (!seen.includes(text)) seen.push(text);
        }
      } catch {
        // Page navigating; keep polling.
      }
      await sleep(150);
    }
  })();
  try {
    return { value: await fn(), seen };
  } finally {
    running = false;
    await poller;
  }
}

/** Click something that should download a file; resolves with the file, or throws with the on-screen error. */
async function downloadFrom(page, click, errorLocator, timeout = 60000) {
  const downloadPromise = page.waitForEvent('download', { timeout });
  const alertAlreadyShown = errorLocator ? (await errorLocator.count()) > 0 : true;
  const errorPromise = errorLocator && !alertAlreadyShown
    ? errorLocator.first().waitFor({ state: 'visible', timeout }).then(async () => {
      throw new Error(`no download; the page shows: ${(await errorLocator.first().innerText()).trim()}`);
    })
    : new Promise(() => {});
  downloadPromise.catch(() => {});
  errorPromise.catch(() => {});
  await click();
  const download = await Promise.race([downloadPromise, errorPromise]);
  const name = download.suggestedFilename();
  const file = path.join(DOWNLOADS, name);
  await download.saveAs(file);
  return { name, file, buf: fs.readFileSync(file) };
}

/** Hash of an exported Markdown file, ignoring its "Exported:" date line. */
function mdHash(text) {
  return require('crypto').createHash('sha1').update(text.replace(/^\*\*Exported:\*\*.*$/m, '')).digest('hex');
}

/** Minimal RFC 4180 CSV parser (quoted fields, embedded commas/newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim()));
}

/** The next "Annual: October 15" in Central time and whether it is within 10 days (writer urgency rule). */
function kenedyUrgency() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.GRANTFINDER_TIMEZONE || 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const year = Number(today.slice(0, 4));
  let due = `${year}-10-15`;
  if (due < today) due = `${year + 1}-10-15`;
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  return { today, due, days, urgent: days <= 10 };
}

async function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    current = {};
  }
  fs.writeFileSync(statePath, JSON.stringify({ ...current, ...patch }, null, 2));
}

async function newContext(browser, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    ...options,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  context.setDefaultTimeout(30000);
  return context;
}

async function newPage(context, label) {
  const page = await context.newPage();
  monitor(page, label);
  activePage = page;
  return page;
}

const card = (page, heading) => page.locator('.card').filter({ has: page.getByRole('heading', { name: heading }) }).first();

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One drafted section's card in the writer, found by its title. */
const sectionCard = (scope, title) => {
  const page = typeof scope.page === 'function' ? scope.page() : scope; // inner locators must come from the page
  return scope.locator('[data-section-id]').filter({ has: page.locator('h3', { hasText: new RegExp(`^\\s*${escapeRe(title)}`) }) }).first();
};

/** One stakeholder request's card in the writer. */
const intakeCards = (page) => page.locator('[data-intake-id]');

/** Wait until the dashboard has finished reopening saved work and shows a step. */
async function waitForDashboard(page, timeout = 30000) {
  await page.getByText('Opening your saved work...').first().waitFor({ state: 'detached', timeout }).catch(() => {});
  await page.getByRole('heading', { name: /Enter Your Claude API Key|Build Your Grant Database|Enter Website URLs|Answer a Few Questions|Upload Documents \(Optional\)|Finding Your Grants|Match Results/ }).first().waitFor({ timeout });
}

/** The page's error box (Next.js also has an empty role=alert route announcer, which is not an error). */
const alertBox = (page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const STEP_HEADINGS = {
  'api-key': 'Enter Your Claude API Key',
  grants: 'Build Your Grant Database',
  website: 'Enter Website URLs',
  questionnaire: 'Answer a Few Questions',
  documents: 'Upload Documents (Optional)',
  results: 'Match Results',
};
const STEP_LABELS = { 'api-key': 'API Key', grants: 'Grant Database', website: 'Website', questionnaire: 'Questions', documents: 'Documents', results: 'Results' };

async function onStep(page, stepId) {
  return (await page.getByRole('heading', { name: STEP_HEADINGS[stepId] }).count()) > 0;
}

/**
 * Make sure the dashboard shows this setup step, so one failed step doesn't
 * fail every step after it. Saves the key / uses the step bar as a person would.
 */
async function goToStep(page, stepId, key = VALID_KEY) {
  if (await onStep(page, stepId)) return;
  info(`(recovering: moving to the "${STEP_LABELS[stepId]}" step)`);
  if (!/\/dashboard$/.test(page.url())) {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  }
  await waitForDashboard(page);
  if (await onStep(page, stepId)) return;
  if (await onStep(page, 'api-key')) {
    await saveKey(page, key);
    await page.getByRole('heading', { name: /Build Your Grant Database|Enter Website URLs/ }).waitFor({ timeout: 30000 });
    if (await onStep(page, stepId)) return;
  }
  let button = page.getByRole('button', { name: STEP_LABELS[stepId], exact: true });
  await button.waitFor({ timeout: 10000 });
  if (!(await button.isEnabled())) {
    info('(the step bar is locked; reloading the dashboard)');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForDashboard(page);
    await sleep(1000);
    if (await onStep(page, stepId)) return;
    button = page.getByRole('button', { name: STEP_LABELS[stepId], exact: true });
    if (!(await button.isEnabled())) throw new Error(`the "${STEP_LABELS[stepId]}" step can't be opened from here`);
  }
  await button.click();
  await page.getByRole('heading', { name: STEP_HEADINGS[stepId] }).waitFor({ timeout: 15000 });
}

// =============================================================================
// Shared UI flows
// =============================================================================

async function signInAsGuest(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const guest = page.getByRole('button', { name: /continue as guest/i });
  await guest.waitFor({ timeout: 30000 });
  await guest.click();
  await page.waitForURL(/\/dashboard$/, { timeout: 30000 });
}

async function saveKey(page, key) {
  await page.getByPlaceholder('sk-ant-...').fill(key);
  await card(page, 'Enter Your Claude API Key').getByRole('button', { name: /^Continue/ }).click();
}

/** Open the "Enter the basics by hand" form (it may already be open after a failed scan). */
async function openBasicsForm(page) {
  if (await page.getByRole('button', { name: 'Save basics and continue' }).count()) return;
  await page.getByRole('button', { name: 'Enter the basics by hand' }).click();
  await page.getByRole('button', { name: 'Save basics and continue' }).waitFor({ timeout: 10000 });
}

/** Read the five tier counts from the results summary. */
async function tierCounts(page) {
  const summary = card(page, 'Match Results');
  const read = async (label) => {
    const cell = summary.locator('div.text-center').filter({ has: page.getByText(label, { exact: true }) }).first();
    return Number((await cell.locator('div').first().innerText()).trim());
  };
  return {
    excellent: await read('Excellent'),
    good: await read('Good'),
    possible: await read('Possible'),
    weak: await read('Weak'),
    not_eligible: await read('Not Eligible'),
  };
}

/** Answer every rendered question by type; returns what was answered. */
async function answerQuestionnaire(page, notes) {
  const qcard = card(page, 'Answer a Few Questions');
  const blocks = qcard.locator('.space-y-6 > div');
  const count = await blocks.count();
  const types = { boolean: 0, select: 0, multiselect: 0, text: 0 };
  const answered = [];
  for (let i = 0; i < count; i++) {
    const block = blocks.nth(i);
    const label = ((await block.locator('label').first().innerText().catch(() => '')) || '').replace(/\s*\*$/, '').trim();
    if (await block.locator('textarea').count()) {
      await block.locator('textarea').fill(notes);
      continue;
    }
    const yes = block.getByRole('button', { name: 'Yes', exact: true });
    if (await yes.count()) {
      const pickYes = !/food pantry/i.test(label);
      await block.getByRole('button', { name: pickYes ? 'Yes' : 'No', exact: true }).click();
      const pressed = await block.getByRole('button', { name: pickYes ? 'Yes' : 'No', exact: true }).getAttribute('class');
      check(`boolean question shows the chosen answer: "${label.slice(0, 50)}"`, /btn-primary/.test(pressed || ''), pressed);
      types.boolean += 1;
      answered.push({ label, answer: pickYes });
      continue;
    }
    if (await block.locator('select').count()) {
      const options = await block.locator('select option').allInnerTexts();
      const choice = options.find((o) => /with school|\$500,000/.test(o)) || options[1];
      await block.locator('select').selectOption({ label: choice });
      types.select += 1;
      answered.push({ label, answer: choice });
      continue;
    }
    const boxes = block.locator('input[type=checkbox]');
    if (await boxes.count()) {
      const n = Math.min(2, await boxes.count());
      for (let j = 0; j < n; j++) await boxes.nth(j).check();
      // Uncheck/recheck the first one to prove toggling works.
      await boxes.nth(0).uncheck();
      await boxes.nth(0).check();
      types.multiselect += 1;
      answered.push({ label, answer: `${n} options` });
      continue;
    }
    const input = block.locator('input[type=text]');
    if (await input.count()) {
      const value = /students/i.test(label) ? '240' : 'Diocesan school grant (2024); parish capital campaign match (2025)';
      await input.fill(value);
      types.text += 1;
      answered.push({ label, answer: value });
    }
  }
  return { types, answered, blocks: count };
}

// =============================================================================
// Phase: journey
// =============================================================================

async function journey(browser) {
  const S = { appId: null, token: null, grants: [], counts: null, matchesShown: 0, kenedyId: null };
  const urgency = kenedyUrgency();
  info(`today ${urgency.today} (Central); next Kenedy deadline ${urgency.due} in ${urgency.days} day(s): urgent=${urgency.urgent}`);

  await mock.reset();
  await mock.fixtures(FX.journeyFixtures());
  await mock.latency({ default: 250, website_scan_v1: 1200, grant_match_batch_v1: 4000, section_draft_v1: 1600, voice_enforce_v1: 400, self_score_v1: 1200 });
  await site.reset();

  const context = await newContext(browser);
  const page = await newPage(context, 'journey');

  // ---------------------------------------------------------------- landing
  const landed = await step('Landing page offers guest sign-in', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const guest = page.getByRole('button', { name: /continue as guest/i });
    await guest.waitFor({ timeout: 30000 });
    check('landing shows "Continue as guest"', await guest.isVisible());
    check('no "Sign-in isn\'t set up yet" message', (await page.getByText(/sign-in isn.t set up yet/i).count()) === 0);
    check('no "Can\'t reach the engine" message', (await page.getByText(/can.t reach the grantfinder engine/i).count()) === 0);
    check('no Google button when Google is not configured', (await page.locator('iframe[src*="accounts.google.com"]').count()) === 0);
    check('no "Demo mode" leftovers', (await page.getByText(/demo mode/i).count()) === 0);
    await guest.click();
    await page.waitForURL(/\/dashboard$/, { timeout: 30000 });
    check('"Continue as guest" opens the dashboard', page.url().endsWith('/dashboard'), page.url());
    await page.getByText('Guest', { exact: true }).first().waitFor({ timeout: 15000 });
    check('header shows the signed-in guest', true);
    S.token = await tokenOf(page);
    check('session token stored in the browser', typeof S.token === 'string' && S.token.length > 20, S.token);
  });
  if (!landed && !S.token) {
    skip('rest of the journey', 'could not sign in');
    await context.close();
    return;
  }

  // ---------------------------------------------------------------- API key
  await step('API key: format check, rejected key, valid key', async () => {
    const keyCard = card(page, 'Enter Your Claude API Key');
    await keyCard.waitFor({ timeout: 20000 });
    const continueButton = keyCard.getByRole('button', { name: /^Continue/ });
    check('Continue is disabled until a key is typed', await continueButton.isDisabled());
    check('"Results" step is not clickable before matching', await page.getByRole('button', { name: 'Results', exact: true }).isDisabled());

    await expectingErrors([{ text: /Saving your API key failed/ }], async () => {
      await page.getByPlaceholder('sk-ant-...').fill('not-a-claude-key');
      await continueButton.click();
      const alert = alertBox(page);
      await alert.waitFor({ timeout: 10000 });
      check('typo key: inline format error', /start with "sk-ant-"/i.test(await alert.innerText()), await alert.innerText());
    });

    await expectingErrors([
      { url: /\/api\/auth\/api-key$/, text: /status of 400/ },
      { text: /Saving your API key failed/ },
    ], async () => {
      await page.getByPlaceholder('sk-ant-...').fill('sk-ant-invalid-1');
      await continueButton.click();
      const alert = alertBox(page);
      await page.getByText(/rejected|authentication/i).first().waitFor({ timeout: 30000 });
      const text = await alert.innerText();
      check('invalid key: inline "rejected" error from Anthropic', /rejected/i.test(text), text);
      check('invalid key: stays on the API key step', await keyCard.isVisible());
      check('invalid key: never stored', (await api('GET', '/api/auth/api-key/status', { token: S.token })).data?.is_set === false);
    });

    await saveKey(page, VALID_KEY);
    await page.getByRole('heading', { name: 'Build Your Grant Database' }).waitFor({ timeout: 30000 });
    check('valid key: advances to the grant database step', true);
    check('valid key: the inline error is gone', (await alertBox(page).count()) === 0);
    const status = await api('GET', '/api/auth/api-key/status', { token: S.token });
    check('valid key: saved on the server', status.data?.is_set === true, status.data);
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    check('the API key is never kept in the browser', !KEY_RE.test(stored), stored.slice(0, 200));
  });

  // ---------------------------------------------------------------- grants
  await step('Grant database: starter database (24 grants)', async () => {
    await goToStep(page, 'grants');
    const grantsCard = card(page, 'Build Your Grant Database');
    const continueButton = grantsCard.getByRole('button', { name: /^Continue with/ });
    check('Continue is disabled while the database is empty', await continueButton.isDisabled());
    await grantsCard.getByRole('button', { name: /Load Starter Database/ }).click();
    const status = page.getByText(/Starter database loaded|Discovery failed/).first();
    await status.waitFor({ timeout: 60000 });
    const text = await status.innerText();
    check('starter database loads 24 grants', /24 grants added \(24 total\)/.test(text), text);

    await grantsCard.getByRole('button', { name: /Load Starter Database/ }).click();
    await page.getByText(/0 grants added \(24 total\)|Discovery failed/).first().waitFor({ timeout: 60000 });
    const again = await page.getByText(/grants added|Discovery failed/).first().innerText();
    check('loading it twice adds no duplicates', /0 grants added \(24 total\)/.test(again), again);

    const grants = await api('GET', '/api/grants', { token: S.token });
    S.grants = Array.isArray(grants.data) ? grants.data : [];
    check('GET /api/grants returns 24 grants', S.grants.length === 24, `${grants.status} ${S.grants.length}`);
    const kenedy = S.grants.find((g) => g.grant_name === KENEDY);
    S.kenedyId = kenedy && kenedy.id;
    check('Kenedy grant present with deadline "Annual: October 15"', kenedy && kenedy.deadline === 'Annual: October 15', kenedy);
    const stats = await api('GET', '/api/grants/stats', { token: S.token });
    check('grant stats total 24', stats.data?.total_grants === 24, stats.data);

    await continueButton.click();
    await page.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 20000 });
    check('Continue opens the website step', true);
    check('website step shows "24 grants in your database"', await page.getByText(/24 grants in your database/).isVisible());
  });

  // ---------------------------------------------------------------- website
  await step('Website: a site that blocks robots (403) offers the basics form', async () => {
    await goToStep(page, 'website');
    const before = await requestCount();
    await expectingErrors([
      { text: /Scanning your website failed|website.*failed|scan.*failed/i },
      { url: /\/api\/processing\/scan-website$/, text: /status of (400|422|502)/ },
    ], async () => {
      await page.getByPlaceholder('https://yourparish.org').fill(`${SITE}/blocked`);
      await page.getByRole('button', { name: 'Scan Website' }).click();
      const alert = alertBox(page);
      await alert.waitFor({ timeout: JOB_TIMEOUT });
      const text = await alert.innerText();
      info(`blocked-site message: ${text}`);
      check('blocked site: inline error explains the site blocked reading', /403|block/i.test(text), text);
      check('blocked site: error offers the basics form or skipping', /basics below|skip this step|Enter the basics by hand|Skip to questions/i.test(text), text);
      check('blocked site: basics form is open', await page.getByRole('button', { name: 'Save basics and continue' }).isVisible());
    });
    const scans = await promptsFor('website_scan_v1', before);
    check('blocked site: no AI call was spent on an unreadable site', scans.length === 0, scans.map((s) => s.prompt.slice(0, 120)));
  });

  let scanned = false;
  await step('Website: scan the parish site, then the questions appear', async () => {
    await goToStep(page, 'website');
    const before = await requestCount();
    await site.reset();
    await page.getByPlaceholder('https://yourparish.org').fill(`${SITE}/`);
    await page.getByPlaceholder('https://yourschool.org').fill(`${SITE}/school-home`);
    const { seen } = await watchStatus(page, async () => {
      await page.getByRole('button', { name: 'Scan Website' }).click();
      await page.getByRole('heading', { name: 'Answer a Few Questions' }).waitFor({ timeout: JOB_TIMEOUT });
      await card(page, 'Answer a Few Questions').locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    });
    scanned = true;
    info(`busy banner showed: ${seen.join(' | ')}`);
    check('busy banner said it was scanning', seen.some((t) => /Scanning your website/.test(t)), seen);
    check('busy banner said it was writing questions', seen.some((t) => /Writing your questions/.test(t)), seen);

    const hits = (await site.hits()).map((h) => h.path);
    info(`fake site pages fetched: ${hits.join(', ')}`);
    for (const p of ['/', '/about', '/school', '/news/bulletin-2026-10.pdf', '/giving', '/ministries', '/school-home', '/school-home/academics', '/school-home/admissions']) {
      check(`crawler read ${p}`, hits.includes(p), hits);
    }
    check('crawler skipped the irrelevant /mass-times page', !hits.includes('/mass-times'), hits);
    const scans = await promptsFor('website_scan_v1', before);
    check('one website_scan_v1 AI call', scans.length === 1, scans.length);
    const prompt = scans[0] ? scans[0].prompt : '';
    for (const marker of ['HOME-MARKER-7731', 'ABOUT-MARKER-5512', 'SCHOOL-MARKER-3390', 'GIVING-MARKER-1209', 'MINISTRY-MARKER-6650']) {
      check(`scan prompt includes ${marker}`, prompt.includes(marker));
    }
    check('scan prompt includes the PDF bulletin text (BULLETIN-MARKER-4410)', prompt.includes('BULLETIN-MARKER-4410'));
    check('scan prompt left out scripts and footers', !prompt.includes('SCRIPT-SHOULD-BE-STRIPPED') && !prompt.includes('NAV-FOOTER-SHOULD-BE-STRIPPED'));
    check('scan prompt has the parish website block', /=== CHURCH WEBSITE \(/.test(prompt));
    check('scan prompt has the school website block', /=== SCHOOL WEBSITE \(/.test(prompt));
    for (const marker of ['SCHOOLSITE-MARKER-2468', 'ACADEMICS-MARKER-1357', 'ADMISSIONS-MARKER-8642']) {
      check(`school website read: ${marker}`, prompt.includes(marker));
    }
    const questionnaires = await promptsFor('questionnaire_v1', before);
    check('questionnaire prompt lists the grant database (mentions Kenedy)', questionnaires.length >= 1 && questionnaires[0].prompt.includes('Kenedy'), questionnaires.length);

    const profile = await api('GET', '/api/processing/profile', { token: S.token });
    const p = profile.data || {};
    check('profile saved from the scan: name', p.organization_name === FX.ORG.name, p.organization_name);
    check('profile saved from the scan: state TX, city', p.state === 'TX' && p.city === FX.ORG.city, `${p.state} ${p.city}`);
    check('profile saved from the scan: diocese, students', p.diocese === FX.ORG.diocese && p.student_count === 240, `${p.diocese} ${p.student_count}`);
    check('profile remembers the website URL', String(p.website_url || '').startsWith(SITE), p.website_url);
    check('profile remembers the school website URL', p.school_website_url === `${SITE}/school-home`, p.school_website_url);
    check('profile lists the website scan as a source', (p.sources || []).some((s) => /website scan/i.test(s)), p.sources);
  });

  if (!scanned) {
    await step('Fallback: enter the basics by hand so the journey can continue', async () => {
    await goToStep(page, 'website');
      await openBasicsForm(page);
      await page.getByPlaceholder('[Parish Name] Catholic Church and School').fill(FX.ORG.name);
      await page.getByPlaceholder('TX').fill('TX');
      await page.getByRole('button', { name: 'Save basics and continue' }).click();
      await page.getByRole('heading', { name: 'Answer a Few Questions' }).waitFor({ timeout: JOB_TIMEOUT });
    });
  }

  // ---------------------------------------------------------------- questionnaire
  const NOTES = 'FREEFORM-MARKER The gym roof leaks and the playground equipment is 30 years old. We want to apply to the Kenedy Memorial Foundation this cycle.';
  await step('Questionnaire: answer every question type and add notes', async () => {
    await goToStep(page, 'questionnaire');
    const qcard = card(page, 'Answer a Few Questions');
    if (await page.getByRole('button', { name: 'Write my questions' }).count()) {
      await page.getByRole('button', { name: 'Write my questions' }).click();
      await qcard.locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    }
    if (!(await qcard.locator('.space-y-6 > div').count())) {
      throw new Error('no questions are showing');
    }
    const { types, answered, blocks } = await answerQuestionnaire(page, NOTES);
    info(`rendered ${blocks} blocks; answered ${JSON.stringify(types)}`);
    check('questionnaire rendered a yes/no question', types.boolean > 0, types);
    check('questionnaire rendered a dropdown question', types.select > 0, types);
    check('questionnaire rendered a multiple-choice question', types.multiselect > 0, types);
    check('questionnaire rendered a free-text question', types.text > 0, types);
    S.answered = answered.length;

    await qcard.getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: 'Upload Documents (Optional)' }).waitFor({ timeout: 30000 });
    check('Continue opens the documents step', true);

    const profile = (await api('GET', '/api/processing/profile', { token: S.token })).data || {};
    const qa = profile.questionnaire_answers || [];
    check('every answer saved to the profile', qa.length === answered.length, `${qa.length} saved vs ${answered.length} answered`);
    check('answers keep their question text (not "Question 1")', qa.length > 0 && qa.every((item) => item.question && !/^Question \d+$/.test(item.question)), qa.slice(0, 2));
    check('free-form notes saved', profile.free_form_notes === NOTES, profile.free_form_notes);
    check('"501(c)(3)" yes mapped to is_501c3', profile.is_501c3 === true, profile.is_501c3);
    check('scan facts survive the questionnaire (name, state)', profile.organization_name === FX.ORG.name && profile.state === 'TX', `${profile.organization_name} ${profile.state}`);
  });

  // ---------------------------------------------------------------- documents + matching
  const files = {
    txt: { name: 'october-bulletin.txt', mimeType: 'text/plain', buffer: Buffer.from('TXT-MARKER-1180 Parish bulletin, October.\nThe playground equipment is 30 years old and two families reported injuries.\nMass times: Saturday 5 PM.\n') },
    docx: { name: 'facilities-report.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await makeDocx('Facilities Report', ['DOCX-MARKER-6604 The gym roof leaks over the bleachers every time it rains.', 'The parish hall HVAC failed twice this fall.']) },
    pdf: { name: 'council-minutes.pdf', mimeType: 'application/pdf', buffer: makePdf(['PARISH COUNCIL MINUTES', 'PDF-MARKER-2201 Two break-ins at the school this year; council approved a security review.']) },
  };

  let matched = false;
  await step('Documents: reject a wrong file type, upload .txt .docx .pdf, find matches', async () => {
    await goToStep(page, 'documents');
    await page.setInputFiles('#doc-files', [{ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }]);
    const alert = alertBox(page);
    await alert.waitFor({ timeout: 10000 });
    check('wrong file type is skipped with a clear message', /photo\.png is not a PDF, DOCX, or TXT/.test(await alert.innerText()), await alert.innerText());

    await page.setInputFiles('#doc-files', [files.txt, files.docx, files.pdf]);
    for (const f of Object.values(files)) {
      check(`document listed: ${f.name}`, await page.getByText(f.name, { exact: true }).isVisible());
    }
    check('the skipped-file message clears after a good upload', (await alertBox(page).count()) === 0);

    // Give the mock real grant ids so scores look like Claude's (unknown ids are ignored).
    const grants = (await api('GET', '/api/grants', { token: S.token })).data || S.grants;
    const foundations = (await api('GET', '/api/grants/foundations', { token: S.token })).data || [];
    await mock.fixtures({ grant_match_batch_v1: FX.matchFixture(grants, Array.isArray(foundations) ? foundations : []) });

    const before = await requestCount();
    const processButton = page.getByRole('button', { name: /Process Documents & Find Matches/ });
    check('button says "Process Documents & Find Matches"', await processButton.isVisible());
    const terminalProgress = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        const t = await page.locator('.terminal-body .terminal-line').last().innerText().catch(() => '');
        if (t && !terminalProgress.includes(t.trim())) terminalProgress.push(t.trim());
        await sleep(200);
      }
    })();
    try {
      await processButton.click();
      await page.getByRole('heading', { name: 'Finding Your Grants' }).waitFor({ timeout: 20000 });
      await page.getByText(/=== MATCHING COMPLETE ===|✗/).first().waitFor({ timeout: JOB_TIMEOUT });
    } finally {
      polling = false;
      await poller;
    }
    const lines = (await page.locator('.terminal-body .terminal-line').allInnerTexts()).map((l) => l.replace(/\s+/g, ' ').trim());
    info(`terminal:\n       ${lines.join('\n       ')}`);
    info(`terminal live lines seen: ${terminalProgress.slice(0, 12).join(' | ')}`);
    check('terminal: processing 3 documents', lines.some((l) => /Processing 3 document/.test(l)), lines);
    for (const f of Object.values(files)) {
      check(`terminal: ${f.name} extracted (not failed)`, lines.some((l) => l.includes(`${f.name}:`) && /grant-relevant item/.test(l)) && !lines.some((l) => l.includes(`${f.name}: extraction failed`)), lines.filter((l) => l.includes(f.name)));
    }
    check('terminal: shows extracted items (→ lines)', lines.some((l) => /→\s+\S/.test(l) && /roof|HVAC|break-in|tuition/i.test(l)), lines);
    check('terminal: === MATCHING COMPLETE ===', lines.some((l) => /MATCHING COMPLETE/.test(l)), lines);
    check('terminal: no error lines', !lines.some((l) => l.startsWith('✗') || /\[\d\d:\d\d:\d\d\]\s*✗/.test(l)), lines.filter((l) => /✗/.test(l)));
    check('terminal: live job progress was shown while matching', terminalProgress.some((t) => /scor|grant|batch|match|working|starting/i.test(t) && !/MATCHING COMPLETE/.test(t)), terminalProgress);
    check('terminal: progress said which grants were being scored ("Scoring grants x-y of n")', terminalProgress.some((t) => /Scoring grants \d+-\d+ of \d+/.test(t)), terminalProgress);

    const docs = await promptsFor('document_signals_v1', before);
    check('three document_signals_v1 AI calls', docs.length === 3, docs.length);
    check('.txt text reached Claude', docs.some((d) => d.prompt.includes('TXT-MARKER-1180')));
    check('.docx text reached Claude (Word extraction works)', docs.some((d) => d.prompt.includes('DOCX-MARKER-6604')));
    check('.pdf text reached Claude (PDF extraction works)', docs.some((d) => d.prompt.includes('PDF-MARKER-2201')));
    const batches = await promptsFor('grant_match_batch_v1', before);
    check('matching made grant_match_batch_v1 AI calls', batches.length >= 1, batches.length);
    check('matching prompt includes the profile and document findings', batches.some((b) => b.prompt.includes(FX.ORG.name) && /Gym roof leaks/.test(b.prompt)), batches.map((b) => b.prompt.slice(0, 80)));
    check('matching prompt includes the questionnaire notes', batches.some((b) => b.prompt.includes('FREEFORM-MARKER')));

    await page.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 30000 });
    matched = true;
    check('results appear after matching', true);

    const profile = (await api('GET', '/api/processing/profile', { token: S.token })).data || {};
    check('document findings added to the profile (facility needs)', (profile.facility_needs || []).some((n) => /gym roof/i.test(n)), profile.facility_needs);
    check('documents listed as profile sources', ['october-bulletin.txt', 'facilities-report.docx', 'council-minutes.pdf'].every((n) => (profile.sources || []).some((s) => s.includes(n))), profile.sources);
    const dupes = (profile.facility_needs || []).length - new Set(profile.facility_needs || []).size;
    if (dupes > 0) info(`note: profile.facility_needs has ${dupes} duplicate item(s) after 3 documents: ${JSON.stringify(profile.facility_needs)}`);
  });

  // ---------------------------------------------------------------- results
  let kenedyCard = null;
  await step('Results: counts, Kenedy match, CSV and Markdown exports', async () => {
    if (!matched) throw new Error('no results to check (matching did not finish)');
    S.counts = await tierCounts(page);
    const total = Object.values(S.counts).reduce((a, b) => a + b, 0);
    const cards = page.getByRole('button', { name: /Write Application/ });
    S.matchesShown = await cards.count();
    const latest = await api('GET', '/api/processing/match-results/latest', { token: S.token });
    const L = latest.data || {};
    info(`tiers ${JSON.stringify(S.counts)}; ${S.matchesShown} match cards; evaluated ${L.total_grants_evaluated}`);
    check('tier counts add up to the number of match cards', total === S.matchesShown, `${total} vs ${S.matchesShown}`);
    check('saved results match the screen (GET match-results/latest)', latest.status === 200 && (L.matches || []).length === S.matchesShown && L.excellent_matches === S.counts.excellent, `${latest.status} ${(L.matches || []).length}`);
    check('every grant was evaluated (total_grants_evaluated = matches)', L.total_grants_evaluated === (L.matches || []).length, `${L.total_grants_evaluated} vs ${(L.matches || []).length}`);
    check('at least 24 grants scored', S.matchesShown >= 24, S.matchesShown);
    check('one excellent match (Kenedy 92%)', S.counts.excellent >= 1, S.counts);
    check('grants outside the area are "Not Eligible"', S.counts.not_eligible >= 2, S.counts);
    const scores = (L.matches || []).map((m) => m.score);
    check('matches sorted best first', scores.every((s, i) => i === 0 || scores[i - 1] >= s), scores.slice(0, 10));

    kenedyCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: KENEDY, exact: true }) }).first();
    const kenedyVisible = await kenedyCard.count() > 0;
    check('Kenedy Memorial Foundation is in the match list', kenedyVisible);
    if (kenedyVisible) {
      const text = await kenedyCard.innerText();
      check('Kenedy shows its AI score (92%)', /92%/.test(text), text.slice(0, 200));
      check('Kenedy shows the "Annual: October 15" deadline', /Annual: October 15/.test(text), text.slice(0, 300));
      check('Kenedy (Texas-only) was not ruled out for a Texas parish', !/^0%$/m.test(text));
    }
    const kenedyMatch = (L.matches || []).find((m) => m.grant_name === KENEDY);
    check('Kenedy is "excellent" in the saved results', kenedyMatch && kenedyMatch.score_tier === 'excellent', kenedyMatch && kenedyMatch.score_tier);
    const cabrini = (L.matches || []).find((m) => /Mother Cabrini/.test(m.grant_name));
    check('a "geo: No" grant is Not Eligible with a reason', cabrini && cabrini.score === 0 && /geographic/i.test(cabrini.explanation || ''), cabrini && `${cabrini.score} ${cabrini.explanation}`);
    const fallbacks = (L.matches || []).filter((m) => /review manually|not ai-scored|unable to/i.test(m.explanation || ''));
    info(`${fallbacks.length} match(es) carry a "not AI-scored" fallback explanation (expected for foundations the mock did not score)`);

    const errorBox = alertBox(page);
    const csv = await downloadFrom(page, () => page.getByRole('button', { name: 'Export CSV' }).click(), errorBox);
    const rows = parseCsv(csv.buf.toString('utf8').replace(/^\uFEFF/, ''));
    check('CSV export downloads (grant_matches.csv)', csv.name === 'grant_matches.csv', csv.name);
    check('CSV has a header row with Grant Name and Score', /Grant Name/.test((rows[0] || []).join(',')) && /Score/.test((rows[0] || []).join(',')), rows[0]);
    check('CSV has one row per match', rows.length - 1 === S.matchesShown, `${rows.length - 1} rows vs ${S.matchesShown}`);
    check('CSV includes the Kenedy row', rows.some((r) => r.includes(KENEDY)));
    const md = await downloadFrom(page, () => page.getByRole('button', { name: /Export Report \(Markdown\)/ }).click(), errorBox);
    const mdText = md.buf.toString('utf8');
    check('Markdown export downloads (grant_matches.md)', md.name === 'grant_matches.md', md.name);
    check('Markdown report has a title, summary and Kenedy', /^# /m.test(mdText) && /Excellent/i.test(mdText) && mdText.includes(KENEDY), mdText.slice(0, 200));
    await shot('results');
  });

  // ---------------------------------------------------------------- writer handoff
  await step('"Write Application" on the Kenedy match opens the writer', async () => {
    if (kenedyCard && (await kenedyCard.count())) {
      await kenedyCard.getByRole('button', { name: /Write Application/ }).click();
    } else {
      info('Kenedy card missing; creating the application through the API so the writer can still be tested');
      const created = await api('POST', '/api/writer/applications', { token: S.token, json: { grant_id: S.kenedyId } });
      check('fallback: POST /api/writer/applications', created.status === 200, created.data);
      await page.goto(`${BASE}/writer?id=${created.data && created.data.id}`);
    }
    await page.waitForURL(/\/writer\?id=/, { timeout: 30000 });
    S.appId = new URL(page.url()).searchParams.get('id');
    check('writer URL carries the application id', /^app_/.test(S.appId || ''), S.appId);
    await page.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 30000 });
    check('writer header shows the Kenedy grant', true);
    const header = await page.locator('.card').first().innerText();
    check('writer header shows the funder and the deadline', /Kenedy/.test(header) && /Deadline: Annual: October 15/.test(header), header.slice(0, 300));
    const urgentShown = (await page.getByText(/Deadline soon/).count()) > 0;
    check(`urgency banner ${urgency.urgent ? 'shown' : 'hidden'} (next deadline ${urgency.due}, ${urgency.days} day(s) away)`, urgentShown === urgency.urgent, `shown=${urgentShown}`);
    const appRecord = await api('GET', `/api/writer/applications/${S.appId}`, { token: S.token });
    check('GET application: urgent flag matches the calendar', appRecord.data?.application?.urgent === urgency.urgent, appRecord.data?.application);
    const again = await api('POST', '/api/writer/applications', { token: S.token, json: { grant_id: S.kenedyId } });
    check('"Write Application" twice reopens the same application', again.status === 200 && again.data?.id === S.appId, again.data);
    writeState({ appId: S.appId, kenedyId: S.kenedyId });
    await shot('writer-start');
  });

  if (!S.appId) {
    skip('application writer', 'no application was opened');
  } else {
    await writerFlow(page, S, urgency);
  }

  // ---------------------------------------------------------------- back to the dashboard
  await step('Dashboard: "Your applications", reload restores everything, debug report', async () => {
    await page.getByRole('button', { name: /Back to dashboard/ }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 20000 });
    const apps = card(page, /Your applications/);
    await apps.waitFor({ timeout: 20000 });
    await waitForDashboard(page);
    await sleep(1500); // let the dashboard finish restoring saved state
    const keyPrompt = (await page.getByRole('heading', { name: 'Enter Your Claude API Key' }).count()) > 0;
    const keySavedNote = (await page.getByText(/A key is already saved/).count()) > 0;
    check('back from the writer: dashboard does not ask for the API key again', !keyPrompt, keyPrompt ? `API key step shown${keySavedNote ? ' (with "A key is already saved")' : ' with NO "already saved" note'}` : '');
    const onResults = await onStep(page, 'results');
    const resultsEnabled = onResults || (await page.getByRole('button', { name: 'Results', exact: true }).isEnabled());
    check('back from the writer: Results step is open or one click away', resultsEnabled, 'Results step disabled');
    await shot('back-from-writer');
    const appsText = await apps.innerText();
    check('"Your applications" lists the Kenedy application', appsText.includes(KENEDY), appsText);
    check('application row shows the funder and status', /Kenedy Memorial Foundation/.test(appsText) && /·\s*(Ready to export|Reviewing the draft|Drafting|Gathering information|Reading requirements|Getting started)/i.test(appsText), appsText);
    if (urgency.urgent) check('application row says "deadline soon"', /deadline soon/i.test(appsText), appsText);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Guest', { exact: true }).first().waitFor({ timeout: 20000 });
    await waitForDashboard(page);
    check('after reload with results: the Results step opens (not a new scan)', await onStep(page, 'results'));
    check('after reload: no API key prompt (saved key remembered)', (await page.getByRole('heading', { name: 'Enter Your Claude API Key' }).count()) === 0);
    await goToStep(page, 'website');
    check('after reload: grant database remembered (24)', await page.getByText(/24 grants in your database/).isVisible());
    check('after reload: website URL remembered', (await page.getByPlaceholder('https://yourparish.org').inputValue()).startsWith(SITE));
    check('after reload: school website URL remembered', (await page.getByPlaceholder('https://yourschool.org').inputValue()) === `${SITE}/school-home`);
    check('after reload: "Your applications" still listed', (await card(page, /Your applications/).innerText()).includes(KENEDY));
    const questionsBefore = await requestCount();
    await goToStep(page, 'questionnaire');
    const qcard = card(page, 'Answer a Few Questions');
    check('after reload: the saved questions are shown (no new "Write my questions")',
      (await qcard.getByRole('button', { name: 'Write my questions' }).count()) === 0 && (await qcard.locator('input[type=text], select, input[type=checkbox]').count()) > 0);
    const filled = await qcard.locator('input[type=text]').evaluateAll((els) => els.filter((el) => el.value.trim()).length);
    check('after reload: earlier answers are filled in', filled > 0, `${filled} text answer(s) filled`);
    check('after reload: no new AI call to write questions', (await promptsFor('questionnaire_v1', questionsBefore)).length === 0);
    const resultsStep = page.getByRole('button', { name: 'Results', exact: true });
    check('after reload: Results step is clickable', await resultsStep.isEnabled());
    await resultsStep.click();
    await page.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 20000 });
    const counts = await tierCounts(page);
    check('after reload: match results restored with the same counts', JSON.stringify(counts) === JSON.stringify(S.counts), `${JSON.stringify(counts)} vs ${JSON.stringify(S.counts)}`);

    await page.getByRole('button', { name: /Copy debug report/ }).click();
    const notice = page.getByText(/Debug report (copied|downloaded)|Could not get the debug report/).first();
    await notice.waitFor({ timeout: 20000 });
    const noticeText = await notice.innerText();
    check('"Copy debug report" copies to the clipboard', /copied/.test(noticeText), noticeText);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard error: ${e.message}`);
    check('debug report is the markdown report', clip.includes('# GrantFinder debug report'), clip.slice(0, 200));
    check('debug report shows the saved key and the grants', /Claude key saved: yes/.test(clip) && /Grants in database: 24/.test(clip), clip.slice(0, 600));
    check('debug report lists recent steps', /## Recent steps/.test(clip) && /###/.test(clip), clip.slice(0, 600));
    const recentJobs = ((await api('GET', '/api/jobs', { token: S.token })).data || {}).jobs || [];
    if (recentJobs.slice(0, 15).some((job) => /scan_website/.test(job.kind) && job.status === 'failed')) {
      check('debug report shows the failed website scan and why', /scan_website: FAILED/.test(clip) && /Couldn't read any text from the website/.test(clip), clip.slice(0, 1200));
    } else {
      info('(the failed website scan is older than the 15 steps the debug report lists)');
    }
    check('debug report never contains the API key', !KEY_RE.test(clip));
    fs.writeFileSync(path.join(ARTIFACTS, 'debug-report-journey.md'), clip);
  });

  await context.storageState({ path: storagePath });
  writeState({ token: S.token, appId: S.appId, kenedyId: S.kenedyId, counts: S.counts, matchesShown: S.matchesShown, writer: S.writer || null });
  await context.close();
}

// =============================================================================
// The application writer (part of the journey)
// =============================================================================

async function writerFlow(page, S, urgency) {
  const W = { sections: [], score: null };
  S.writer = W;
  const appApi = async () => (await api('GET', `/api/writer/applications/${S.appId}`, { token: S.token })).data || {};
  const blockedNote = page.getByText(/high-severity gap\(s\) must be answered/);
  const blockedCount = async () => {
    if (!(await blockedNote.count())) return 0;
    const m = /(\d+) high-severity/.exec(await blockedNote.innerText());
    return m ? Number(m[1]) : -1;
  };

  await step('Writer gates: nothing to export or draft yet', async () => {
    const exportEarly = await api('POST', `/api/writer/applications/${S.appId}/export`, { token: S.token, json: { format: 'md' } });
    check('export before drafting is refused (400)', exportEarly.status === 400, `${exportEarly.status} ${exportEarly.text.slice(0, 200)}`);
    const draftEarly = await apiJob('POST', `/api/writer/applications/${S.appId}/draft`, { token: S.token, json: { section_id: null } });
    check('drafting before the requirements exist is refused (400)', draftEarly.status === 400, `${draftEarly.status} ${JSON.stringify(draftEarly.data).slice(0, 200)}`);
  });

  const GUIDELINES = 'GUIDELINES-PASTE-MARKER Kenedy Memorial Foundation grant guidelines (test copy). Eligible: Catholic organizations in Texas. '
    + 'Required sections: Organization Background (300 words max); Statement of Need (400 words max); Project Description (500 words max); '
    + 'Portal Summary (1000 characters max). Scoring: mission alignment 30, need 30, feasibility 25, sustainability 15.';

  await step('Writer 1: paste guidelines, Analyze Requirements', async () => {
    const before = await requestCount();
    await page.getByPlaceholder('Paste guidelines / RFP text here (optional)...').fill(GUIDELINES);
    const { seen } = await watchStatus(page, async () => {
      await page.getByRole('button', { name: 'Analyze Requirements' }).click();
      await page.getByText(/\d+ required sections/).waitFor({ timeout: JOB_TIMEOUT });
    });
    info(`banner: ${seen.join(' | ')}`);
    check('busy banner: "Reading the grant requirements"', seen.some((t) => /Reading the grant requirements/.test(t)), seen);
    const reqText = await card(page, /1 · Grant Requirements/).innerText();
    check('4 required sections listed', /4 required sections/.test(reqText), reqText.slice(0, 200));
    for (const s of FX.SECTIONS) check(`section listed: ${s.title}`, reqText.includes(s.title), reqText.slice(0, 400));
    check('word limits shown (max 300 words)', /max 300 words/.test(reqText), reqText);
    check('character limit shown (max 1000 chars)', /max 1000 chars/.test(reqText), reqText);
    check('deliverables shown', /Deliverables: .*Project budget/.test(reqText), reqText);
    check('explicit rubric is not flagged as inferred', !/rubric INFERRED/.test(reqText), reqText);
    const specs = await promptsFor('grant_spec_v1', before);
    check('one grant_spec_v1 AI call', specs.length === 1, specs.length);
    check('pasted guidelines reached Claude', specs[0] && specs[0].prompt.includes('GUIDELINES-PASTE-MARKER'));
    check('the grant record reached Claude (deadline)', specs[0] && specs[0].prompt.includes('Annual: October 15'));
  });

  await step('Writer 2: Run Fit Analysis', async () => {
    const before = await requestCount();
    await page.getByRole('button', { name: 'Run Fit Analysis' }).click();
    await page.getByText('Narrative strategy (edit before confirming)').waitFor({ timeout: JOB_TIMEOUT });
    const fitText = await card(page, /2 · Fit, Gaps/).innerText();
    check('fit map shows each rubric criterion', FX.RUBRIC.every((c) => fitText.includes(c.name)), fitText.slice(0, 500));
    check('fit map shows ratings (strong / partial / weak / missing)', /strong/i.test(fitText) && /missing/i.test(fitText), fitText.slice(0, 300));
    check('fit map shows evidence', /Evidence: Parish and school in Exampleville/.test(fitText), fitText.slice(0, 500));
    check('honesty ledger shown', /Name honestly/.test(fitText) && /No audited financial statements/.test(fitText), fitText.slice(0, 600));
    const strategy = await page.locator('textarea').evaluateAll((els) => els.map((e) => e.value));
    check('strategy box pre-filled with the recommended strategy', strategy.some((v) => v.includes(FX.MARKERS.strategy)), strategy);
    const gapsText = await card(page, /3 · Missing Info/).innerText();
    check('gaps listed with severity and owner', /Letters of support/.test(gapsText) && /Finance/.test(gapsText) && /high/i.test(gapsText), gapsText.slice(0, 500));
    check('every open gap can be waived', (await page.getByRole('button', { name: 'waive', exact: true }).count()) === FX.GAPS.length);
    const fits = await promptsFor('fit_gap_v1', before);
    check('fit prompt grounded in the profile (documents + questionnaire)', fits.length === 1 && fits[0].prompt.includes('Gym roof leaks') && fits[0].prompt.includes('FREEFORM-MARKER'), fits.length);
    const draftNow = await apiJob('POST', `/api/writer/applications/${S.appId}/draft`, { token: S.token, json: { section_id: null } });
    check('drafting before the strategy is confirmed is refused (409)', draftNow.status === 409 && /strategy/i.test(draftNow.data?.detail || ''), `${draftNow.status} ${draftNow.data?.detail}`);
  });

  await step('Writer 3: edit and Confirm Strategy; Draft is blocked by open high gaps', async () => {
    const box = page.locator('textarea').nth(0);
    const values = await page.locator('textarea').evaluateAll((els) => els.map((e) => e.value));
    const index = values.findIndex((v) => v.includes(FX.MARKERS.strategy));
    const strategyBox = index >= 0 ? page.locator('textarea').nth(index) : box;
    await strategyBox.fill(`${values[index] || ''} EDITED-STRATEGY-MARKER Lead with the families we serve.`);
    await page.getByRole('button', { name: 'Confirm Strategy' }).click();
    await page.getByText('Strategy confirmed').waitFor({ timeout: 30000 });
    check('"Strategy confirmed" shown', true);
    const app = await appApi();
    check('the edited strategy was saved', /EDITED-STRATEGY-MARKER/.test(app.application?.strategy || ''), app.application?.strategy);
    await page.getByRole('heading', { name: /4 · Draft/ }).waitFor({ timeout: 10000 });
    const n = await blockedCount();
    check('Draft section explains 3 high-severity gaps block drafting', n === 3, n);
    check('"Draft All Sections" is disabled while high gaps are open', await page.getByRole('button', { name: /Draft All Sections/ }).isDisabled());
    const bypass = await apiJob('POST', `/api/writer/applications/${S.appId}/draft`, { token: S.token, json: { section_id: null } });
    check('the engine also refuses to draft with open high gaps (409)', bypass.status === 409 && /gap/i.test(bypass.data?.detail || ''), `${bypass.status} ${bypass.data?.detail}`);
    check('voice card appears after the strategy is confirmed', await page.getByRole('heading', { name: /Your Voice/ }).isVisible());
  });

  await step('Writer 4: waive one gap', async () => {
    const row = page.locator('div.border').filter({ hasText: 'Letters of support' }).filter({ has: page.getByRole('button', { name: 'waive' }) }).first();
    await row.getByRole('button', { name: 'waive' }).click();
    await page.locator('div.border').filter({ hasText: 'Letters of support' }).filter({ hasText: /waived/ }).first().waitFor({ timeout: 30000 });
    check('waived gap shows "waived"', true);
    check('blocked count drops to 2', (await blockedCount()) === 2, await blockedCount());
    const app = await appApi();
    const gap = (app.gaps || []).find((g) => /Letters of support/.test(g.description));
    check('waived gap saved with a reason', gap && gap.status === 'waived' && /Waived/i.test(gap.answer || ''), gap);
  });

  await step('Writer 5: Generate Stakeholder Requests', async () => {
    const app = await appApi();
    await mock.fixtures({ intake_packets_v1: FX.intakeFixture(app.gaps || []) });
    await page.getByRole('button', { name: 'Generate Stakeholder Requests' }).click();
    await page.getByText('Copy-paste email packet').first().waitFor({ timeout: JOB_TIMEOUT });
    const intakeCard = card(page, /3 · Missing Info/);
    const text = await intakeCard.innerText();
    check('a request for Finance', /Finance/.test(text), text.slice(0, 400));
    check('a request for the Principal', /Principal/.test(text), text.slice(0, 400));
    await intakeCard.getByText('Copy-paste email packet').first().click();
    check('email packet is copy-paste ready (never sent)', await intakeCard.getByText(FX.MARKERS.emailFinance, { exact: false }).first().isVisible());
    const after = await appApi();
    const routed = (after.gaps || []).filter((g) => g.status === 'routed').length;
    check('the three open gaps are now "routed"', routed === 3, (after.gaps || []).map((g) => `${g.description.slice(0, 20)}=${g.status}`));
    check('still blocked (2 high gaps routed, not answered)', (await blockedCount()) === 2, await blockedCount());
  });

  await step('Writer 6: record an answer, mark one "They don\'t have it"', async () => {
    const requests = intakeCards(page).filter({ has: page.getByPlaceholder("Paste the stakeholder's answer here...") });
    const finance = requests.filter({ hasText: 'Finance' }).first();
    const recordButton = finance.getByRole('button', { name: 'Record Answer' });
    check('"Record Answer" disabled until an answer is pasted', await recordButton.isDisabled());
    await finance.getByPlaceholder("Paste the stakeholder's answer here...").fill('ANSWER-MARKER Operating budget this year: see attached statements dated June 30. 41 students receive tuition assistance.');
    await recordButton.click();
    await page.getByText(/Answer: ANSWER-MARKER/).first().waitFor({ timeout: 30000 });
    check('answered gaps show the answer', true);
    check('blocked count drops to 1', (await blockedCount()) === 1, await blockedCount());
    const profile = (await api('GET', '/api/processing/profile', { token: S.token })).data || {};
    check('the answer was added to the shared profile as evidence', (profile.evidence || []).some((e) => /ANSWER-MARKER/.test(e.summary || JSON.stringify(e))), profile.evidence);

    const principal = intakeCards(page).filter({ hasText: 'Principal' }).first();
    await principal.getByRole('button', { name: /They don.t have it/ }).click();
    await page.getByText(/confirmed_gap/).first().waitFor({ timeout: 30000 });
    check('"They don\'t have it" marks the gap confirmed', true);
    await page.waitForFunction(() => !/high-severity gap\(s\) must be answered/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {});
    check('no blocking gaps remain', (await blockedCount()) === 0, await blockedCount());
    check('"Draft All Sections" is now enabled', await page.getByRole('button', { name: /Draft All Sections/ }).isEnabled());
    const app = await appApi();
    check('engine agrees: open_blocking_gaps is empty', Array.isArray(app.open_blocking_gaps) && app.open_blocking_gaps.length === 0, app.open_blocking_gaps);
  });

  await step('Writer 7: Capture Voice', async () => {
    const sample = 'VOICE-SAMPLE-MARKER Every Saturday morning, our parish hall fills with families picking up groceries. Our volunteers know each child by name.';
    const button = page.getByRole('button', { name: 'Capture Voice' });
    check('"Capture Voice" disabled until a sample is pasted', await button.isDisabled());
    await page.getByPlaceholder('Paste a writing sample here...').fill(sample);
    const before = await requestCount();
    await button.click();
    await page.getByText(/✓ captured/).waitFor({ timeout: JOB_TIMEOUT });
    check('voice captured and its guidelines shown', await page.getByText(FX.MARKERS.voice, { exact: false }).first().isVisible());
    const calls = await promptsFor('voice_profile_v1', before);
    check('voice sample reached Claude', calls.length === 1 && calls[0].prompt.includes('VOICE-SAMPLE-MARKER'), calls.length);
  });

  await step('Writer 8: Draft All Sections (live progress, enforce banned phrases)', async () => {
    const strategyBoxes = await page.locator('textarea').evaluateAll((els) => els.map((e) => e.value));
    const strategyIndex = strategyBoxes.findIndex((v) => v.includes('EDITED-STRATEGY-MARKER'));
    const strategyBox = page.locator('textarea').nth(Math.max(0, strategyIndex));
    const lateEditPossible = strategyIndex >= 0 && (await strategyBox.isEditable());
    if (lateEditPossible) await strategyBox.fill(`${strategyBoxes[strategyIndex]} LATE-EDIT-MARKER`);
    const before = await requestCount();
    const { seen } = await watchStatus(page, async () => {
      await page.getByRole('button', { name: /Draft All Sections/ }).click();
      await page.getByRole('button', { name: /Redraft All Sections/ }).waitFor({ timeout: JOB_TIMEOUT });
    });
    info(`draft banner lines: ${seen.join(' | ')}`);
    check('banner: "Drafting (a few minutes for a full application)"', seen.some((t) => /Drafting \(a few minutes/.test(t)), seen);
    const progress = seen.filter((t) => /Drafting \(a few minutes/.test(t)).map((t) => t.replace(/^.*?full application\)\.\.\.\s*/, '')).filter(Boolean);
    check('banner showed live job progress beyond "Starting..."', progress.some((p) => !/^(Starting|Waiting to start|Working)\.\.\.$/.test(p)), progress);
    const draftCard = card(page, /4 · Draft/);
    const text = await draftCard.innerText();
    for (const s of FX.SECTIONS) check(`drafted: ${s.title}`, text.includes(s.title), text.slice(0, 300));
    check('word counts shown against limits ("/ 300 max")', /\d+ words \/ 300 max/.test(text), text.slice(0, 600));
    const portalHeader = await sectionCard(draftCard, 'Portal Summary').innerText();
    check('a character-limited section shows its character count against the limit (1000 chars)', /\d+\s*\/\s*1000\s*(chars|characters)/i.test(portalHeader),
      `the Portal Summary card says "${portalHeader.replace(/\s+/g, ' ').trim().slice(0, 300)}"`);
    check('no section over its limit', !/OVER LIMIT/.test(text));
    const sectionTexts = (await draftCard.locator('pre').allInnerTexts()).join('\n');
    check('banned phrase ("We are thrilled") was rewritten by Enforce', !/we are thrilled/i.test(sectionTexts) && sectionTexts.includes(FX.MARKERS.enforced), sectionTexts.slice(0, 600));
    check('the section notes that Enforce rewrote a banned phrase', /Voice enforcement rewrote banned phrases/i.test(text), text.slice(0, 600));
    check('no "Banned phrases present" warnings', !/Banned phrases present/.test(text));
    check('unsupported claim flagged for review', /Unsupported claims: .*Enrollment grew 12 percent/.test(text), text.slice(0, 900));
    const drafts = await promptsFor('section_draft_v1', before);
    const enforces = await promptsFor('voice_enforce_v1', before);
    check('one section_draft_v1 call per section', drafts.length === FX.SECTIONS.length, drafts.length);
    check('Enforce ran for the banned phrase', enforces.length >= 1, enforces.length);
    check('draft prompts carry the confirmed (edited) strategy', drafts.every((d) => d.prompt.includes('EDITED-STRATEGY-MARKER')), drafts.length);
    check('a strategy edited after confirming is either locked or used (never silently ignored)',
      !lateEditPossible || drafts.every((d) => d.prompt.includes('LATE-EDIT-MARKER')),
      'the strategy box stays editable after "Strategy confirmed", but the edit is not saved or used by drafting');
    check('draft prompts carry the captured voice', drafts.every((d) => d.prompt.includes(FX.MARKERS.voice)), drafts.length);
    check('draft prompts say what the org does NOT have (confirmed gap)', drafts.every((d) => d.prompt.includes('Name and qualifications of the project lead') && /does NOT have/i.test(d.prompt)), drafts.length);
    check('draft prompts carry the stakeholder answer', drafts.every((d) => d.prompt.includes('ANSWER-MARKER')), drafts.length);
    const app = await appApi();
    W.sections = (app.sections || []).map((s) => ({ id: s.section_id, title: s.title, words: s.word_count }));
    check('engine saved 4 section drafts', W.sections.length === 4, W.sections);
  });

  await step('Writer 9: Refine one section', async () => {
    const draftCard = card(page, /4 · Draft/);
    const section = sectionCard(draftCard, 'Statement of Need');
    const input = section.getByPlaceholder(/Refine: e\.g\./);
    await input.fill('tighten and lead with the families');
    const before = await requestCount();
    await section.getByRole('button', { name: /Refine/ }).click();
    await sectionCard(page, 'Statement of Need').filter({ hasText: FX.MARKERS.refined }).waitFor({ timeout: JOB_TIMEOUT });
    check('refined text replaces the Statement of Need draft', true);
    const other = await sectionCard(draftCard, 'Organization Background').innerText();
    check('other sections untouched by the refinement', !other.includes(FX.MARKERS.refined), other.slice(0, 200));
    const calls = await promptsFor('section_refine_v1', before);
    check('the instruction reached Claude', calls.length >= 1 && calls[0].prompt.includes('tighten and lead with the families'), calls.length);
    const app = await appApi();
    const need = (app.sections || []).find((s) => s.title === 'Statement of Need');
    check('previous version kept (version history)', need && Array.isArray(need.versions) && need.versions.length >= 1, need && need.versions);
  });

  await step('Writer 9b: edit a section by hand, then restore the earlier version', async () => {
    const title = 'Organization Background';
    const before = ((await appApi()).sections || []).find((x) => x.title === title);
    await sectionCard(page, title).getByRole('button', { name: 'Edit', exact: true }).click();
    const box = page.getByRole('textbox', { name: `Edit ${title}` });
    await box.waitFor({ timeout: 10000 });
    check('the edit box starts with the current text', before && (await box.inputValue()) === before.current_draft);
    const edited = 'HAND-EDIT-MARKER Our parish school has served families on the east side of town since 1952.';
    await box.fill(edited);
    check('live word count shown while editing', /Your edit: \d+ words/.test(await sectionCard(page, title).innerText()), (await sectionCard(page, title).innerText()).slice(0, 300));
    await sectionCard(page, title).getByRole('button', { name: 'Save', exact: true }).click();
    await sectionCard(page, title).filter({ hasText: 'HAND-EDIT-MARKER' }).locator('pre').waitFor({ timeout: 30000 });
    const after = ((await appApi()).sections || []).find((x) => x.title === title);
    check('the hand edit is saved on the server', after && after.current_draft === edited, after && after.current_draft);
    check('the text before the edit is kept in the history', after && (after.versions || []).includes(before.current_draft), after && after.versions);
    check('counts recomputed for the edited text', after && after.word_count > 0 && after.word_count < before.word_count, after && [before.word_count, after.word_count]);

    const history = sectionCard(page, title).locator('details').filter({ hasText: /Earlier versions/ });
    if (!(await history.evaluate((el) => el.open))) await history.locator('summary').click();
    let asked = '';
    page.once('dialog', (dialog) => {
      asked = dialog.message();
      dialog.accept().catch(() => {});
    });
    await history.getByRole('button', { name: /Restore this version/ }).first().click();
    await waitUntil(async () => (((await appApi()).sections || []).find((x) => x.title === title) || {}).current_draft === before.current_draft, 30000, 'the earlier version to be restored');
    check('"Restore this version" asks first', /Put this earlier version back/i.test(asked), asked);
    const restored = ((await appApi()).sections || []).find((x) => x.title === title);
    check('the newest earlier version is restored, and the hand edit is kept in the history', restored.current_draft === before.current_draft && (restored.versions || []).includes(edited), restored.versions);
    await waitUntil(async () => !(await sectionCard(page, title).locator('pre').innerText()).includes('HAND-EDIT-MARKER'), 15000, 'the page to show the restored text');
  });

  await step('Writer 10: Score Draft', async () => {
    await page.getByRole('button', { name: /^Score Draft$/ }).click();
    await page.getByText('Biggest lever:').waitFor({ timeout: JOB_TIMEOUT });
    const scoreCard = card(page, /5 · Self-Score/);
    const text = await scoreCard.innerText();
    check('overall score shown (72/100)', /72\s*\/100/.test(text), text.slice(0, 200));
    check('top fix shown', text.includes(FX.MARKERS.topFix), text.slice(0, 400));
    check('per-criterion scores shown', FX.RUBRIC.every((c) => text.includes(c.name)), text.slice(0, 600));
    check('compliance checks shown (limits, banned phrases)', /✓ .*word\/char limit/.test(text) || /word\/char limit/.test(text), text.slice(-600));
    check('button now says "Re-Score Draft"', await page.getByRole('button', { name: 'Re-Score Draft' }).isVisible());
    W.score = 72;
  });

  await step('Writer 11: export Word, Markdown, portal text, form map', async () => {
    const errorBox = alertBox(page);
    const docx = await downloadFrom(page, () => page.getByRole('button', { name: 'Word (.docx)' }).click(), errorBox);
    check('Word export downloads a .docx', /\.docx$/.test(docx.name), docx.name);
    check('.docx is a real zip (PK header)', docx.buf.slice(0, 2).toString('latin1') === 'PK', docx.buf.slice(0, 4).toString('hex'));
    const xml = await readZipEntry(docx.buf, 'word/document.xml');
    const wordText = wordXmlText(xml);
    check('.docx contains word/document.xml', Boolean(xml));
    check('.docx contains the section titles', FX.SECTIONS.every((s) => wordText.includes(s.title)), wordText.slice(0, 300));
    check('.docx contains the refined text', wordText.includes(FX.MARKERS.refined), wordText.slice(0, 300));
    check('.docx has no "We are thrilled"', !/we are thrilled/i.test(wordText));

    const md = await downloadFrom(page, () => page.getByRole('button', { name: 'Markdown', exact: true }).click(), errorBox);
    const mdText = md.buf.toString('utf8');
    check('Markdown export downloads a .md', /\.md$/.test(md.name), md.name);
    check('Markdown has the grant name and every section', mdText.includes('Kenedy') && FX.SECTIONS.every((s) => mdText.includes(s.title)), mdText.slice(0, 300));
    S.mdExport = mdText;
    writeState({ mdExportSha: mdHash(mdText) });

    const txt = await downloadFrom(page, () => page.getByRole('button', { name: /Portal paste-in/ }).click(), errorBox);
    const txtText = txt.buf.toString('utf8');
    check('portal text export downloads a .txt', /\.txt$/.test(txt.name), txt.name);
    check('portal text has every section', FX.SECTIONS.every((s) => txtText.toUpperCase().includes(s.title.toUpperCase())), txtText.slice(0, 300));
    check('portal text is plain (no markdown headings)', !/^#{1,3} /m.test(txtText), txtText.slice(0, 200));

    const map = await downloadFrom(page, () => page.getByRole('button', { name: /Form-field map/ }).click(), errorBox);
    let parsed = null;
    try {
      parsed = JSON.parse(map.buf.toString('utf8'));
    } catch {
      parsed = null;
    }
    check('form map downloads valid JSON', parsed !== null && /\.json$/.test(map.name), `${map.name} ${map.buf.toString('utf8').slice(0, 120)}`);
    const flat = JSON.stringify(parsed || {});
    check('form map has every section', FX.SECTIONS.every((s) => flat.includes(s.title)), flat.slice(0, 300));
    check('form map carries limits for portal fields', /1000/.test(flat) && /300/.test(flat), flat.slice(0, 400));
    const app = await appApi();
    check('application status becomes "export"', app.application?.status === 'export', app.application?.status);
  });

  await step('Writer 12: Copy debug bundle', async () => {
    await page.getByRole('button', { name: /Copy debug bundle/ }).click();
    const notice = page.getByText(/Debug bundle copied|Could not copy the debug bundle/).first();
    await notice.waitFor({ timeout: 20000 });
    const noticeText = await notice.innerText();
    check('"Copy debug bundle" reports success', /copied/.test(noticeText), noticeText);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch((e) => `clipboard error: ${e.message}`);
    check('clipboard has the GrantFinder Debug Bundle', clip.includes('GrantFinder Debug Bundle'), clip.slice(0, 200));
    check('bundle names the application and correlation id', clip.includes(S.appId) && /corr_/.test(clip), clip.slice(0, 400));
    for (const id of ['grant_spec_v1', 'fit_gap_v1', 'intake_packets_v1', 'section_draft_v1', 'voice_enforce_v1', 'section_refine_v1', 'self_score_v1']) {
      check(`bundle AI timeline includes ${id}`, clip.includes(id), clip.slice(0, 200));
    }
    check('bundle never contains the API key', !KEY_RE.test(clip));
    fs.writeFileSync(path.join(ARTIFACTS, 'debug-bundle-journey.md'), clip);
    await shot('writer-done');
  });
}

// =============================================================================
// Phase: basics (second guest)
// =============================================================================

async function basics(browser) {
  await mock.reset();
  await mock.fixtures(FX.journeyFixtures());
  await mock.latency({ default: 200, web_discovery_v1: 3000, grant_match_batch_v1: 800 });
  const context = await newContext(browser);
  const page = await newPage(context, 'basics');
  let token = null;

  const ready = await step('Second guest: sign in, key, starter database', async () => {
    await signInAsGuest(page);
    token = await tokenOf(page);
    await card(page, 'Enter Your Claude API Key').waitFor({ timeout: 20000 });
    await saveKey(page, SECOND_KEY);
    await page.getByRole('heading', { name: 'Build Your Grant Database' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /Load Starter Database/ }).click();
    await page.getByText(/Starter database loaded: 24 grants added/).waitFor({ timeout: 60000 });
    check('second guest gets their own 24 starter grants', true);
  });
  if (!ready) {
    await context.close();
    return;
  }

  await step('AI Web Discovery adds grants', async () => {
    const before = await requestCount();
    const { seen } = await watchStatus(page, async () => {
      await page.getByRole('button', { name: /AI Web Discovery/ }).click();
      await page.getByText(/AI web discovery: found|Discovery failed/).first().waitFor({ timeout: JOB_TIMEOUT });
    });
    const text = await page.getByText(/AI web discovery: found|Discovery failed/).first().innerText();
    info(`web discovery: ${text} | banner: ${seen.join(' | ')}`);
    check('web discovery finished with a summary', /AI web discovery: found \d+, added \d+ new \(\d+ total\)/.test(text), text);
    check('web discovery showed "Claude is searching the web"', seen.some((t) => /searching the web/i.test(t)), seen);
    check('web discovery showed the job\'s own progress line', seen.some((t) => /searching the web for grants that fit|usually 1-3 minutes/i.test(t)), seen);
    const calls = await promptsFor('web_discovery_v1', before);
    check('web discovery used the web search tool', calls.length >= 1 && calls.every((c) => (c.tools || []).some((t) => /web_search/.test(t))), calls.map((c) => c.tools));
    const total = Number((/\((\d+) total\)/.exec(text) || [])[1] || 0);
    const continueButton = page.getByRole('button', { name: new RegExp(`Continue with ${total} Discovered Grants`) });
    check('Continue button counts the discovered grants', total >= 24 && (await continueButton.count()) === 1, `${total}`);
  });

  const CUSTOM = 'Exampleville Community Foundation Grant';
  const BLOCKED_GRANT = 'Example Parish Renewal Grant';
  await step('Upload your own Excel grant list ("Upload and Continue")', async () => {
    await goToStep(page, 'grants', SECOND_KEY);
    const before = (await api('GET', '/api/grants', { token })).data || [];
    const xlsx = await makeXlsx({
      'Mixed Church-School': [{
        'Grant Name': BLOCKED_GRANT,
        Funder: 'Example Parish Renewal Fund',
        Deadline: '2027-03-01',
        Description: 'Supports parish facility renewal in Texas.',
        URL: `${SITE}/blocked/guidelines`,
        Status: 'OPEN',
        'Geo Qualified': 'TX',
      }, {
        'Grant Name': CUSTOM,
        Funder: 'Exampleville Community Foundation',
        Deadline: '2026-12-01',
        Description: 'Funds facility repairs for faith-based schools in Example County.',
        Contact: 'grants@example.org',
        URL: `${SITE}/grant-guidelines`,
        Status: 'OPEN',
        'Geo Qualified': 'TX',
      }],
      'Catholic Foundations': [{ 'Foundation Name': 'Example Catholic Fund', 'Application Cycle': 'Annual - spring', 'Focus Areas': 'Catholic schools', Website: 'https://example.org' }],
    });
    await page.setInputFiles('#grant-file', { name: 'our-grants.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
    check('chosen Excel file is shown', await page.getByText('our-grants.xlsx', { exact: true }).isVisible());
    const upload = page.getByRole('button', { name: /Upload and Continue/ });
    check('button changes to "Upload and Continue"', await upload.isVisible());
    await upload.click();
    await page.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 30000 });
    const after = (await api('GET', '/api/grants', { token })).data || [];
    check('uploaded grants added to the database', after.length === before.length + 2, `${before.length} -> ${after.length}`);
    const custom = after.find((g) => g.grant_name === CUSTOM);
    check('uploaded grant keeps its fields (category, Texas-only, deadline, URL, status)',
      custom && custom.category === 'mixed' && custom.geo_qualified === 'Yes - TX Only' && custom.deadline === '2026-12-01' && custom.url === `${SITE}/grant-guidelines` && custom.status === 'OPEN', custom);
    check('website step shows the new total', await page.getByText(new RegExp(`${after.length} grants in your database`)).isVisible());
    const foundations = (await api('GET', '/api/grants/foundations', { token })).data || [];
    check('uploaded foundation added', Array.isArray(foundations) && foundations.some((f) => f.foundation_name === 'Example Catholic Fund'), Array.isArray(foundations) ? foundations.map((f) => f.foundation_name) : foundations);
  });

  await step('"Enter the basics by hand" saves a profile without a website', async () => {
    await goToStep(page, 'website', SECOND_KEY);
    await openBasicsForm(page);
    const save = page.getByRole('button', { name: 'Save basics and continue' });
    await expectingErrors([{ text: /Saving your organization basics failed/ }], async () => {
      await save.click();
      const alert = alertBox(page);
      await alert.waitFor({ timeout: 10000 });
      check('name and state are required', /organization name and state/i.test(await alert.innerText()), await alert.innerText());
    });
    await page.getByPlaceholder('[Parish Name] Catholic Church and School').fill('St. Testwell Mission Chapel');
    await page.getByPlaceholder('TX').fill('TX');
    await page.locator('div:has(> label:text-is("City")) > input').fill('Exampleville');
    await page.locator('div:has(> label:text-is("Diocese")) > input').fill('Diocese of Example');
    await page.locator('div:has(> label:text-is("Number of students")) > input').fill('120');
    await page.locator('div:has(> label:text-is("Type")) > select').selectOption('school');
    await save.click();
    await page.getByRole('heading', { name: 'Answer a Few Questions' }).waitFor({ timeout: JOB_TIMEOUT });
    await card(page, 'Answer a Few Questions').locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    check('saving the basics opens the questions', true);
    const p = (await api('GET', '/api/processing/profile', { token })).data || {};
    check('profile has the typed name and state', p.organization_name === 'St. Testwell Mission Chapel' && p.state === 'TX', `${p.organization_name} ${p.state}`);
    check('profile has city, diocese, students, type', p.city === 'Exampleville' && p.diocese === 'Diocese of Example' && p.student_count === 120 && p.organization_type === 'school', p);
    check('profile marks the school', p.has_school === true, p.has_school);
    check('profile source says "Entered by hand"', (p.sources || []).includes('Entered by hand'), p.sources);
  });

  await step('Step bar back to Website, then back to the saved questions', async () => {
    if (await onStep(page, 'questionnaire')) {
      const websiteStep = page.getByRole('button', { name: 'Website', exact: true });
      check('step bar: "Website" is clickable from the questions', await websiteStep.isEnabled());
      await websiteStep.click();
      await page.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 10000 });
    } else {
      await goToStep(page, 'website', SECOND_KEY);
    }
    check('website step says the saved profile is kept', await page.getByText(/your saved profile is kept/).isVisible());
    const before = await requestCount();
    // "Save basics and continue" already wrote this guest's questions, so the button
    // goes back to them instead of paying for a new set.
    const goBack = page.getByRole('button', { name: 'Go to my questions' });
    const reuse = (await goBack.count()) > 0;
    check('with saved questions, the Website step offers "Go to my questions" (not a new set)', reuse);
    await (reuse ? goBack : page.getByRole('button', { name: 'Skip to questions' })).click();
    await page.getByRole('heading', { name: 'Answer a Few Questions' }).waitFor({ timeout: JOB_TIMEOUT });
    await card(page, 'Answer a Few Questions').locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    check('the button shows the questions', true);
    check(reuse ? 'the saved questions are reused (no new questionnaire_v1 call)' : 'questions were written by Claude (questionnaire_v1)',
      (await promptsFor('questionnaire_v1', before)).length === (reuse ? 0 : 1));
    const p = (await api('GET', '/api/processing/profile', { token })).data || {};
    check('skipping kept the hand-entered profile', p.organization_name === 'St. Testwell Mission Chapel', p.organization_name);
  });

  await step('Questions, then "Skip & Find Matches" without documents', async () => {
    await goToStep(page, 'questionnaire', SECOND_KEY);
    if (await page.getByRole('button', { name: 'Write my questions' }).count()) {
      await page.getByRole('button', { name: 'Write my questions' }).click();
      await card(page, 'Answer a Few Questions').locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    }
    await answerQuestionnaire(page, 'Second guest notes.');
    await card(page, 'Answer a Few Questions').getByRole('button', { name: /^Continue/ }).click();
    await page.getByRole('heading', { name: 'Upload Documents (Optional)' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: /Skip & Find Matches/ }).click();
    await page.getByText(/=== MATCHING COMPLETE ===|✗/).first().waitFor({ timeout: JOB_TIMEOUT });
    const lines = await page.locator('.terminal-body .terminal-line').allInnerTexts();
    check('matching without documents completes', lines.some((l) => /MATCHING COMPLETE/.test(l)), lines);
    check('no document lines when none were uploaded', !lines.some((l) => /Processing \d+ document/.test(l)), lines);
    await page.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 30000 });
    const counts = await tierCounts(page);
    const cards = await page.getByRole('button', { name: /Write Application/ }).count();
    check('results render for the second guest', cards >= 24 && Object.values(counts).reduce((a, b) => a + b, 0) === cards, `${JSON.stringify(counts)} cards=${cards}`);
    check('Kenedy listed for the second guest too', (await page.getByRole('heading', { name: KENEDY, exact: true }).count()) === 1);
    check('second guest has no applications yet', (await page.getByRole('heading', { name: /Your applications/ }).count()) === 0);
    check('grants Claude did not score say so plainly ("Not AI-scored")', (await page.getByText(/Not AI-scored/).count()) > 0);
    check('the uploaded grant is in the results', (await page.getByRole('heading', { name: CUSTOM, exact: true }).count()) === 1);
  });

  await step('Saved key: the API Key step offers "Keep my saved key"', async () => {
    await page.getByRole('button', { name: 'API Key', exact: true }).click();
    await page.getByText(/A key is already saved/).waitFor({ timeout: 10000 });
    check('API Key step says a key is already saved', true);
    await page.getByRole('button', { name: 'Keep my saved key' }).click();
    await page.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 10000 });
    check('"Keep my saved key" continues without typing it again', true);
  });

  await step('Writer: with no guidelines pasted, the grant\'s own web page is read', async () => {
    await goToStep(page, 'results', SECOND_KEY);
    const customCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: CUSTOM, exact: true }) }).first();
    await customCard.getByRole('button', { name: /Write Application/ }).click();
    await page.waitForURL(/\/writer\?id=/, { timeout: 30000 });
    await page.getByRole('heading', { name: CUSTOM }).waitFor({ timeout: 20000 });
    check('no urgency banner for a December deadline', (await page.getByText(/Deadline soon/).count()) === 0);
    const before = await requestCount();
    await site.reset();
    await page.getByRole('button', { name: 'Analyze Requirements' }).click();
    await page.getByText(/\d+ required sections/).waitFor({ timeout: JOB_TIMEOUT });
    const hits = (await site.hits()).map((h) => h.path);
    check('the grant\'s web page was fetched', hits.includes('/grant-guidelines'), hits);
    const specs = await promptsFor('grant_spec_v1', before);
    check('the fetched guidelines reached Claude', specs.length === 1 && specs[0].prompt.includes('GUIDELINES-MARKER-9090'), specs.length ? specs[0].prompt.slice(0, 300) : 'no call');
    await page.getByRole('button', { name: /Back to dashboard/ }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 20000 });
  });

  await step('Writer: when the grant\'s web page can\'t be read, the person is told', async () => {
    await goToStep(page, 'results', SECOND_KEY);
    const blockedCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: BLOCKED_GRANT, exact: true }) }).first();
    await blockedCard.getByRole('button', { name: /Write Application/ }).click();
    await page.waitForURL(/\/writer\?id=/, { timeout: 30000 });
    await page.getByRole('heading', { name: BLOCKED_GRANT }).waitFor({ timeout: 20000 });
    // Like real Claude with no guidelines: an inferred rubric and sections marked INFERRED.
    const inferred = JSON.parse(FX.journeyFixtures().grant_spec_v1);
    inferred.rubric_source = 'inferred';
    inferred.required_sections = inferred.required_sections.map((section) => ({ ...section, notes: 'INFERRED - verify against actual guidelines' }));
    await mock.fixtures({ grant_spec_v1: JSON.stringify(inferred) });
    const before = await requestCount();
    try {
      await page.getByRole('button', { name: 'Analyze Requirements' }).click();
      await page.getByText(/\d+ required sections/).waitFor({ timeout: JOB_TIMEOUT });
    } finally {
      await mock.fixtures({ grant_spec_v1: FX.journeyFixtures().grant_spec_v1 });
    }
    const specs = await promptsFor('grant_spec_v1', before);
    check('with nothing readable, Claude is told to infer conservatively', specs.length === 1 && /No full guidelines provided/.test(specs[0].prompt), specs.length);
    check('the page warns that the requirements are inferred', (await page.getByText(/INFERRED/).count()) > 0);
    const told = (await page.getByText(/could not read|couldn.t read|paste the guidelines/i).count()) > 0;
    check('the page says why: the funder\'s page could not be read, paste the guidelines', told,
      'the engine returns a note ("Could not read ... (HTTP 403); requirements were inferred. Paste the guidelines for an exact spec.") but the writer page never shows it');
    await page.getByRole('button', { name: /Back to dashboard/ }).click();
    await page.waitForURL(/\/dashboard$/, { timeout: 20000 });
  });

  await step('Second guest cannot see the first guest\'s data', async () => {
    const state = await readState();
    if (!state.appId) {
      skip('cross-account isolation', 'journey created no application');
      return;
    }
    const other = await api('GET', `/api/writer/applications/${state.appId}`, { token });
    check('another account\'s application is not found (404)', other.status === 404, `${other.status} ${other.text.slice(0, 120)}`);
    const otherBundle = await api('GET', `/api/writer/applications/${state.appId}/debug-bundle`, { token });
    check('another account\'s debug bundle is not found (404)', otherBundle.status === 404, otherBundle.status);
    const apps = await api('GET', '/api/writer/applications', { token });
    check('application list is per account (only its own)', Array.isArray(apps.data) && !apps.data.some((a) => a.id === state.appId), apps.data);
  });

  await step('Sign out returns to sign-in and forgets the session', async () => {
    let signOutAsked = '';
    page.once('dialog', (dialog) => {
      signOutAsked = dialog.message();
      dialog.accept().catch(() => {});
    });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(/127\.0\.0\.1:\d+\/$/, { timeout: 20000 });
    await page.getByRole('button', { name: /continue as guest/i }).waitFor({ timeout: 20000 });
    check('signing out a guest warns that the work can\'t be opened again', /guest/i.test(signOutAsked) && /can.t be opened again/i.test(signOutAsked), signOutAsked);
    check('sign-in page shown after signing out', true);
    check('session token removed from the browser', (await tokenOf(page)) === null);
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/127\.0\.0\.1:\d+\/(\?.*)?$/, { timeout: 20000 });
    check('dashboard without a session goes to sign-in', !/\/dashboard/.test(page.url()), page.url());
    const still = await api('GET', '/api/auth/me', { token });
    info(`(the signed-out token still works on the server for its 30 days: HTTP ${still.status}; sign-out only forgets it in this browser)`);
  });

  await context.close();
}

// =============================================================================
// Phase: errors (what happens when Claude or the account has a problem)
// =============================================================================

async function errors(browser) {
  await mock.reset();
  await mock.fixtures(FX.journeyFixtures());
  await mock.latency({ default: 150, section_draft_v1: 300 });
  const failNext = (promptId, times, status = 529, type = 'overloaded_error') =>
    http('POST', `${MOCK}/__fail`, { json: { prompt_id: promptId, status, type, times } });
  const clearFailures = async () => {
    await mock.reset();
    await mock.fixtures(FX.journeyFixtures());
  };
  const context = await newContext(browser);
  const page = await newPage(context, 'errors');
  let token = null;
  let appId = null;

  const started = await step('Out of API credits: the first AI step says so plainly', async () => {
    await signInAsGuest(page);
    token = await tokenOf(page);
    await card(page, 'Enter Your Claude API Key').waitFor({ timeout: 20000 });
    await saveKey(page, 'sk-ant-nocredit-e2e1');
    await page.getByRole('heading', { name: 'Build Your Grant Database' }).waitFor({ timeout: 30000 });
    check('a key with no credits is accepted when saved (only checked when used)', true);
    await page.getByRole('button', { name: /Load Starter Database/ }).click();
    await page.getByText(/Starter database loaded/).waitFor({ timeout: 60000 });
    await page.getByRole('button', { name: /^Continue with/ }).click();
    await page.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 20000 });
    await expectingErrors([{ text: /scan.*failed|website.*failed/i }], async () => {
      await page.getByPlaceholder('https://yourparish.org').fill(`${SITE}/`);
      await page.getByRole('button', { name: 'Scan Website' }).click();
      const alert = alertBox(page);
      await alert.waitFor({ timeout: JOB_TIMEOUT });
      const text = await alert.innerText();
      info(`no-credit message: ${text}`);
      check('message says the account is out of API credits', /credit/i.test(text), text);
      check('message says where to add credits (console.anthropic.com)', /console\.anthropic\.com/i.test(text), text);
    });
  });
  if (!started) {
    await context.close();
    return;
  }

  await step('Replace the saved key from the API Key step', async () => {
    await page.getByRole('button', { name: 'API Key', exact: true }).click();
    await page.getByText(/A key is already saved/).waitFor({ timeout: 10000 });
    check('API Key step says a key is already saved', true);
    await saveKey(page, 'sk-ant-test-e2e-3');
    await page.getByRole('heading', { name: /Enter Website URLs|Build Your Grant Database/ }).waitFor({ timeout: 30000 });
    check('new key saved and the setup continues', true);
    const before = await requestCount();
    await goToStep(page, 'website', 'sk-ant-test-e2e-3');
    await openBasicsForm(page);
    await page.getByPlaceholder('[Parish Name] Catholic Church and School').fill(FX.ORG.name);
    await page.getByPlaceholder('TX').fill('TX');
    await page.getByRole('button', { name: 'Save basics and continue' }).click();
    await card(page, 'Answer a Few Questions').locator('.space-y-6 > div').first().waitFor({ timeout: JOB_TIMEOUT });
    const calls = await promptsFor('questionnaire_v1', before);
    check('the next AI step uses the new key', calls.length === 1 && calls[0].key_suffix === 'sk-ant-test-e2e-3'.slice(-4), calls.map((c) => c.key_suffix));
  });

  await step('Claude overloaded during matching: results still arrive, honestly labeled', async () => {
    if ((await api('GET', '/api/processing/profile', { token })).status === 404) {
      info('(setting up: no profile yet, saving the basics through the API)');
      await api('PUT', '/api/processing/profile', { token, json: { organization_name: FX.ORG.name, organization_type: 'both', city: FX.ORG.city, state: 'TX' } });
    }
    await goToStep(page, 'documents', 'sk-ant-test-e2e-3');
    await failNext('grant_match_batch_v1', 1000);
    try {
      await page.getByRole('button', { name: /Skip & Find Matches/ }).click();
      await page.getByText(/=== MATCHING COMPLETE ===|✗/).first().waitFor({ timeout: JOB_TIMEOUT });
      await page.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 30000 });
    } finally {
      await clearFailures();
    }
    const labeled = await page.getByText(/Not AI-scored: Claude was unavailable \(overloaded\)/).count();
    const cards = await page.getByRole('button', { name: /Write Application/ }).count();
    info(`${labeled} of ${cards} match cards say Claude was unavailable`);
    check('grants Claude could not score say "Not AI-scored: Claude was unavailable (overloaded)"', labeled > 0, `${labeled} of ${cards}`);
    check('hard-filter results still work while Claude is down (Not Eligible grants)', (await tierCounts(page)).not_eligible >= 2, await tierCounts(page));
  });

  await step('Drafting while Claude keeps failing: finished sections are kept, the error says what to do', async () => {
    const kenedyCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: KENEDY, exact: true }) }).first();
    if (await kenedyCard.count()) {
      await kenedyCard.getByRole('button', { name: /Write Application/ }).click();
    } else {
      info('(setting up: no results on screen, opening the Kenedy application through the API)');
      const grants = (await api('GET', '/api/grants', { token })).data || [];
      const kenedy = grants.find((g) => g.grant_name === KENEDY);
      const created = await api('POST', '/api/writer/applications', { token, json: { grant_id: kenedy && kenedy.id } });
      await page.goto(`${BASE}/writer?id=${created.data && created.data.id}`);
    }
    await page.waitForURL(/\/writer\?id=/, { timeout: 30000 });
    appId = new URL(page.url()).searchParams.get('id');
    await page.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 20000 });
    await page.getByPlaceholder('Paste guidelines / RFP text here (optional)...').fill('Test guidelines: four sections with limits.');
    await page.getByRole('button', { name: 'Analyze Requirements' }).click();
    await page.getByText(/\d+ required sections/).waitFor({ timeout: JOB_TIMEOUT });
    await page.getByRole('button', { name: 'Run Fit Analysis' }).click();
    await page.getByText('Narrative strategy (edit before confirming)').waitFor({ timeout: JOB_TIMEOUT });
    await page.getByRole('button', { name: 'Confirm Strategy' }).click();
    await page.getByText('Strategy confirmed').waitFor({ timeout: 30000 });
    for (let i = 0; i < 10 && (await page.getByRole('button', { name: 'waive', exact: true }).count()); i++) {
      const count = await page.getByRole('button', { name: 'waive', exact: true }).count();
      await page.getByRole('button', { name: 'waive', exact: true }).first().click();
      await waitUntil(async () => (await page.getByRole('button', { name: 'waive', exact: true }).count()) < count, 30000, 'the gap to be waived');
    }
    check('all gaps waived; drafting allowed', await page.getByRole('button', { name: /Draft All Sections/ }).isEnabled());

    // Each section call is tried 3 times (client retries), then failed sections get one more
    // pass. 15 failures: all 4 sections fail the first pass (12), the first one retried fails
    // again (3), the other 3 succeed -> "Drafted and saved 3 of 4 sections".
    await failNext('section_draft_v1', 15);
    try {
      await expectingErrors([{ text: /writer\.draft failed|writer step "draft" failed/ }], async () => {
        await page.getByRole('button', { name: /Draft All Sections/ }).click();
        const alert = alertBox(page);
        await alert.waitFor({ timeout: JOB_TIMEOUT });
        await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 'the page to finish refreshing');
        const text = await alert.innerText();
        info(`partial-draft message: ${text}`);
        const onScreen = await alert.first().evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.bottom > 0 && r.top < window.innerHeight;
        });
        check('the error is on screen where the person is looking (not scrolled off the top)', onScreen,
          'the error box is at the top of the page while the Draft button (and the view) is further down');
        check('error says how many sections were saved', /Drafted and saved [1-3] of 4 sections/.test(text), text);
        check('error says why (Claude overloaded)', /overloaded/i.test(text), text);
        check('error says what to do next (run drafting again)', /run drafting again/i.test(text), text);
      });
    } finally {
      await clearFailures();
    }
    const state = (await api('GET', `/api/writer/applications/${appId}`, { token })).data || {};
    const saved = (state.sections || []).length;
    const shown = await card(page, /4 · Draft/).locator('[data-section-id]').count();
    check('sections finished before the failure are saved and shown', saved >= 1 && saved <= 3 && shown === saved, `saved=${saved} shown=${shown}`);
    const finishButton = page.getByRole('button', { name: 'Draft missing sections' });
    check('after a partial failure, "Draft missing sections" is offered', (await finishButton.count()) === 1);
    const beforeFinish = await requestCount();
    await finishButton.click();
    await waitUntil(async () => ((await api('GET', `/api/writer/applications/${appId}`, { token })).data?.sections || []).length === 4, JOB_TIMEOUT, 'all 4 sections');
    await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 'drafting to finish');
    check('drafting again fills in the missing sections (4 of 4)', (await card(page, /4 · Draft/).locator('[data-section-id]').count()) === 4);
    const finishCalls = await promptsFor('section_draft_v1', beforeFinish);
    check('"Draft missing sections" drafts only the unfinished section(s)', finishCalls.length === 4 - saved, `${finishCalls.length} draft call(s) for ${4 - saved} missing section(s)`);

    check('no error left on the page', (await alertBox(page).count()) === 0, (await alertBox(page).allInnerTexts()).join(' '));
  });

  await step('Export hard rules: over-limit or banned-phrase text never exports', async () => {
    if (!appId) throw new Error('no application from the previous step');
    const portal = () => sectionCard(page, 'Portal Summary');
    const refinePortal = async (instruction) => {
      const before = await requestCount();
      await portal().getByPlaceholder(/Refine: e\.g\./).fill(instruction);
      await portal().getByRole('button', { name: /Refine/ }).click();
      await waitUntil(async () => (await promptsFor('section_refine_v1', before)).length >= 1, JOB_TIMEOUT, 'the refine call');
      await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 'the refinement to finish');
      return promptsFor('section_refine_v1', before);
    };
    const exportMarkdown = async () => {
      const before = await alertBox(page).count();
      await page.getByRole('button', { name: 'Markdown', exact: true }).click();
      if (before === 0) await alertBox(page).first().waitFor({ timeout: 30000 }).catch(() => {});
      return (await alertBox(page).count()) ? (await alertBox(page).first().innerText()) : '';
    };

    // 1) A revision far over the 1000-character portal limit (the auto-tighten retry gets the same long text).
    const long = `${'Our parish school serves families who rely on it every day. '.repeat(20)}LONG-MARKER`;
    await mock.fixtures({ section_refine_v1: JSON.stringify({ draft: long }) });
    const calls = await refinePortal('expand this with more detail');
    check('an over-limit revision is retried once with "Tighten to at most 1000 characters"', calls.length === 2 && /Tighten to at most 1000 characters/.test(calls[1].prompt), calls.map((c) => c.prompt.slice(-200)));
    check('the over-limit section is flagged OVER LIMIT', /OVER LIMIT/.test(await portal().innerText()), (await portal().innerText()).slice(0, 200));
    await expectingErrors([{ url: /\/export$/, text: /status of 409/ }], async () => {
      const text = await exportMarkdown();
      check('export is refused while a section is over its limit, naming it', /Cannot export: section\(s\) over their hard limit: Portal Summary/.test(text), text);
      check('the refusal says how to fix it ("tighten to the limit")', /tighten/i.test(text), text);
    });

    // 2) A revision whose banned phrase survives the Enforce rewrite.
    await mock.fixtures({
      section_refine_v1: JSON.stringify({ draft: 'We are thrilled to serve 240 students in Exampleville.' }),
      voice_enforce_v1: JSON.stringify({ draft: 'We are thrilled to serve 240 students in Exampleville, Texas.' }),
    });
    await refinePortal('make it shorter');
    check('a banned phrase that survives Enforce is shown on the section', /Banned phrases present: .*we are thrilled/i.test(await portal().innerText()), (await portal().innerText()).slice(0, 300));
    await expectingErrors([{ url: /\/export$/, text: /status of 409/ }], async () => {
      const text = await exportMarkdown();
      check('export is refused while banned phrases remain, naming the section', /Cannot export: banned phrases remain in: Portal Summary/.test(text), text);
    });

    // 3) A clean revision: export works again.
    await mock.fixtures({ section_refine_v1: FX.journeyFixtures().section_refine_v1, voice_enforce_v1: FX.journeyFixtures().voice_enforce_v1 });
    await refinePortal('lead with the families');
    const md = await downloadFrom(page, () => page.getByRole('button', { name: 'Markdown', exact: true }).click(), null);
    check('after a clean revision the export works again', /\.md$/.test(md.name) && md.buf.toString('utf8').includes(FX.MARKERS.refined), md.name);
  });

  await step('Reloading the page while drafting', async () => {
    if (!appId) throw new Error('no application from the previous step');
    await mock.latency({ default: 150, section_draft_v1: 5000 });
    const portalBefore = (((await api('GET', `/api/writer/applications/${appId}`, { token })).data || {}).sections || []).find((x) => x.title === 'Portal Summary');
    const jobsBefore = (((await api('GET', '/api/jobs', { token })).data || {}).jobs || []).map((job) => job.id);
    let redraftAsked = '';
    page.once('dialog', (dialog) => {
      redraftAsked = dialog.message();
      dialog.accept().catch(() => {});
    });
    await page.getByRole('button', { name: /Redraft All Sections/ }).click();
    await page.locator('[role=status]').waitFor({ timeout: 10000 });
    await sleep(1500);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 20000 });
    await sleep(1500);
    check('"Redraft All Sections" asks before replacing every section', /Redraft every section/i.test(redraftAsked), redraftAsked);
    const busyShown = (await page.locator('[role=status]').count()) > 0;
    const redraftEnabled = await page.getByRole('button', { name: /Redraft All Sections/ }).isEnabled();
    check('after a reload, the page shows drafting is still running (and does not offer to start it again)', busyShown && !redraftEnabled,
      `status banner shown: ${busyShown}; "Redraft All Sections" clickable: ${redraftEnabled}`);
    const job = await (async () => {
      let found = null;
      await waitUntil(async () => {
        const jobs = (((await api('GET', '/api/jobs', { token })).data || {}).jobs || []).filter((j) => !jobsBefore.includes(j.id) && j.kind === 'writer.draft');
        found = jobs[0] || null;
        return Boolean(found && (found.status === 'done' || found.status === 'failed'));
      }, JOB_TIMEOUT, 'the draft job to finish on the server');
      return found;
    })();
    check('the draft keeps running on the server after a reload and finishes', job && job.status === 'done', job);
    await mock.latency({ default: 150 });
    const portalAfter = (((await api('GET', `/api/writer/applications/${appId}`, { token })).data || {}).sections || []).find((x) => x.title === 'Portal Summary');
    if (portalBefore && portalAfter && portalBefore.current_draft !== portalAfter.current_draft) {
      const kept = (portalAfter.versions || []).includes(portalBefore.current_draft);
      check('"Redraft All Sections" keeps the refined text in the section\'s history (nothing lost)', kept,
        `before redraft: refined text + ${(portalBefore.versions || []).length} earlier version(s); after: ${(portalAfter.versions || []).length} version(s), refined text ${kept ? 'kept' : 'gone'}`);
    } else {
      info('(Portal Summary text did not change on redraft; history check not applicable)');
    }
  });

  await step('Writer extras: one-section Redraft, "Re-run fit analysis" asks first, re-analyze after drafting', async () => {
    if (!appId) throw new Error('no application from the previous steps');
    await page.goto(`${BASE}/writer?id=${appId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 20000 });
    const draftCard = card(page, /4 · Draft/);
    await draftCard.locator('[data-section-id]').first().waitFor({ timeout: 20000 });

    // One-section Redraft: only that section is drafted again.
    const oneSection = sectionCard(draftCard, 'Project Description');
    if (await oneSection.getByRole('button', { name: /^Redraft$/ }).count()) {
      const before = await requestCount();
      await oneSection.getByRole('button', { name: /^Redraft$/ }).click();
      await waitUntil(async () => (await promptsFor('section_draft_v1', before)).length >= 1, JOB_TIMEOUT, 'the one-section draft call');
      await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 'the one-section draft to finish');
      const calls = await promptsFor('section_draft_v1', before);
      check('one-section "Redraft" drafts only that section', calls.length === 1 && calls[0].prompt.includes('SECTION: Project Description'), calls.map((c) => (/SECTION: (.*)/.exec(c.prompt) || [])[1]));
    } else {
      info('(no per-section Redraft button on this build)');
    }

    // "Re-run fit analysis" replaces the gap list, so it must ask first; cancelling changes nothing.
    const rerun = page.getByRole('button', { name: /Re-run fit analysis/ });
    if (await rerun.count()) {
      const gapsBefore = JSON.stringify(((await api('GET', `/api/writer/applications/${appId}`, { token })).data || {}).gaps || []);
      let asked = '';
      page.once('dialog', (dialog) => {
        asked = dialog.message();
        dialog.dismiss().catch(() => {});
      });
      await rerun.click();
      await sleep(1000);
      const gapsAfter = JSON.stringify(((await api('GET', `/api/writer/applications/${appId}`, { token })).data || {}).gaps || []);
      check('"Re-run fit analysis" asks before replacing the gap list', /replaces the current gap list/i.test(asked), asked);
      check('cancelling the re-run keeps the gaps as they were', gapsBefore === gapsAfter);
    }

    // New guidelines after drafting: Project Description and Portal Summary are no longer asked for; Budget Narrative is new.
    const changed = JSON.parse(FX.journeyFixtures().grant_spec_v1);
    changed.required_sections = [
      changed.required_sections[0],
      changed.required_sections[1],
      { id: 's5', title: 'Budget Narrative', prompt: 'Explain how the funds will be used.', word_limit: 250, char_limit: null, notes: '' },
    ];
    await mock.fixtures({ grant_spec_v1: JSON.stringify(changed) });
    try {
      const details = page.locator('details').filter({ hasText: 'Paste guidelines and re-analyze' }).first();
      if (!(await details.count())) throw new Error('no "Paste guidelines and re-analyze" on this build');
      await details.locator('summary').click();
      await details.getByPlaceholder('Paste guidelines / RFP text here...').fill('REANALYZE-MARKER Updated guidelines: Organization Background, Statement of Need, Budget Narrative.');
      await details.getByRole('button', { name: 'Re-analyze Requirements' }).click();
      await card(page, /1 · Grant Requirements/).getByText(/Budget Narrative/).waitFor({ timeout: JOB_TIMEOUT });
      await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 're-analysis to finish');
      check('re-analysis with pasted guidelines updates the requirements (Budget Narrative listed)', true);
      const draftText = await card(page, /4 · Draft/).innerText();
      check('the Draft step shows that "Budget Narrative" has no draft yet', /Budget Narrative/.test(draftText),
        'after re-analysis the new required section is not mentioned in the Draft step');
      const md = await downloadFrom(page, () => page.getByRole('button', { name: 'Markdown', exact: true }).click(), alertBox(page)).catch((error) => ({ error }));
      if (md.error) {
        check('export after re-analysis says what is missing', /Budget Narrative|not drafted|re-?draft/i.test(md.error.message), md.error.message);
      } else {
        const text = md.buf.toString('utf8');
        const stale = (text.match(/^## (Project Description|Portal Summary)$/gm) || []).map((line) => line.slice(3));
        const missing = /^## Budget Narrative$/m.test(text) ? [] : ['Budget Narrative'];
        check('export after re-analysis matches the new requirements (no stale sections, none silently missing)', !stale.length && !missing.length,
          `exported without a warning; still contains no-longer-required: ${stale.join(', ') || 'none'}; missing required: ${missing.join(', ') || 'none'}`);
      }
    } finally {
      await mock.fixtures({ grant_spec_v1: FX.journeyFixtures().grant_spec_v1 });
    }
  });

  await step('Debug report explains the credit and overload problems', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Copy debug report/ }).click();
    await page.getByText(/Debug report (copied|downloaded)|Could not get the debug report/).first().waitFor({ timeout: 20000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    fs.writeFileSync(path.join(ARTIFACTS, 'debug-report-errors.md'), clip);
    check('debug report shows the out-of-credits failure', /out of API credits/i.test(clip), clip.slice(0, 800));
    check('debug report shows the partial drafting failure', /Drafted and saved [1-3] of 4 sections/.test(clip), clip.slice(0, 800));
    check('debug report shows the AI calls that failed (overloaded)', /overloaded/i.test(clip), clip.slice(0, 800));
  });

  await context.close();
}

// =============================================================================
// Phase: expired
// =============================================================================

async function forgeToken(sub, secret) {
  const { SignJWT } = await import(require('url').pathToFileURL(require.resolve('jose', { paths: [FRONTEND] })).href);
  return new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1d').sign(new TextEncoder().encode(secret));
}

async function expired(browser) {
  const cases = [
    { label: 'garbage token', token: async () => 'garbage-token-not-a-jwt' },
    { label: 'token signed with another secret', token: async () => forgeToken('guest_000000000000', 'some-other-secret-0123456789-0123456789-xyz') },
  ];
  if (SECRET) cases.push({ label: 'valid signature, user no longer exists', token: async () => forgeToken('guest_deadbeef0000', SECRET) });
  for (const c of cases) {
    const context = await newContext(browser);
    const page = await newPage(context, `expired-${slug(c.label)}`);
    await step(`Expired session (${c.label}) returns to sign-in`, async () => {
      await expectingErrors([{ url: /\/api\/auth\/me$/, text: /status of 401/ }], async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('button', { name: /continue as guest/i }).waitFor({ timeout: 30000 });
        const token = await c.token();
        await page.evaluate((t) => localStorage.setItem('auth_token', t), token);
        await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
        await page.waitForURL(/\/\?expired=1$/, { timeout: 30000 });
        check('redirected to /?expired=1', page.url().endsWith('/?expired=1'), page.url());
        await page.getByText(/Your session ended/).waitFor({ timeout: 15000 });
        check('sign-in page explains the session ended', true);
        check('the bad token was cleared', (await page.evaluate(() => localStorage.getItem('auth_token'))) === null);
        check('guest sign-in offered again', await page.getByRole('button', { name: /continue as guest/i }).isVisible());
      });
    });
    await context.close();
  }

  const context = await newContext(browser);
  const page = await newPage(context, 'expired-writer');
  await step('Writer with a broken session also returns to sign-in', async () => {
    const state = await readState();
    await expectingErrors([{ url: /\/api\/writer\/applications\//, text: /status of 401/ }, { text: /Failed to load application/ }], async () => {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => localStorage.setItem('auth_token', 'garbage-token-not-a-jwt'));
      await page.goto(`${BASE}/writer?id=${state.appId || 'app_missing'}`, { waitUntil: 'domcontentloaded' });
      await page.waitForURL(/\/\?expired=1$/, { timeout: 30000 });
      check('writer with a bad session goes to /?expired=1', true);
    });
  });
  await context.close();
}

// =============================================================================
// Phase: persist (after a server restart)
// =============================================================================

async function persist(browser) {
  const state = await readState();
  if (!state.token || !fs.existsSync(storagePath)) {
    skip('persistence checks', 'the journey did not save a session');
    return;
  }
  await mock.reset();
  await mock.fixtures(FX.journeyFixtures());
  await mock.latency({ default: 200, self_score_v1: 800 });

  await step('Engine: session, key, grants, profile, results, application survive the restart', async () => {
    const me = await api('GET', '/api/auth/me', { token: state.token });
    check('old session token still valid after restart', me.status === 200 && me.data?.name === 'Guest', `${me.status} ${me.text.slice(0, 120)}`);
    check('saved API key still there after restart', me.data?.claude_api_key_set === true, me.data);
    const grants = await api('GET', '/api/grants', { token: state.token });
    check('grants still there after restart (24)', Array.isArray(grants.data) && grants.data.length === 24, grants.data && grants.data.length);
    const profile = await api('GET', '/api/processing/profile', { token: state.token });
    check('profile still there after restart', profile.status === 200 && profile.data?.organization_name === FX.ORG.name, profile.status);
    const latest = await api('GET', '/api/processing/match-results/latest', { token: state.token });
    check('match results still there after restart', latest.status === 200 && (latest.data?.matches || []).length === state.matchesShown, `${latest.status} ${(latest.data?.matches || []).length}`);
    const apps = await api('GET', '/api/writer/applications', { token: state.token });
    check('application still listed after restart', Array.isArray(apps.data) && apps.data.some((a) => a.id === state.appId), apps.data);
    const fresh = await api('POST', '/api/auth/guest');
    check('new guest sign-in still works after restart', fresh.status === 200, fresh.status);
  });

  const context = await newContext(browser, { storageState: storagePath });
  const page = await newPage(context, 'persist');

  await step('Browser: the saved session opens the dashboard where the user left off', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/dashboard$/, { timeout: 30000 });
    check('landing forwards a signed-in user to the dashboard', true);
    await page.getByText('Guest', { exact: true }).first().waitFor({ timeout: 20000 });
    await waitForDashboard(page);
    check('a returning user with results lands on Results', await onStep(page, 'results'));
    check('no API key prompt after restart', (await page.getByRole('heading', { name: 'Enter Your Claude API Key' }).count()) === 0);
    await goToStep(page, 'website');
    check('grant count after restart (24)', await page.getByText(/24 grants in your database/).isVisible());
    const appsText = await card(page, /Your applications/).innerText();
    check('"Your applications" after restart', appsText.includes(KENEDY), appsText);
    await page.getByRole('button', { name: 'Results', exact: true }).click();
    await page.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 20000 });
    const counts = await tierCounts(page);
    check('results after restart have the same counts', JSON.stringify(counts) === JSON.stringify(state.counts), `${JSON.stringify(counts)} vs ${JSON.stringify(state.counts)}`);
  });

  await step('Browser: the application writer picks up where it was', async () => {
    await card(page, /Your applications/).getByRole('button', { name: /Open/ }).first().click();
    await page.waitForURL(/\/writer\?id=/, { timeout: 20000 });
    await page.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 20000 });
    check('writer opens from "Your applications"', new URL(page.url()).searchParams.get('id') === state.appId, page.url());
    check('strategy still confirmed', await page.getByText('Strategy confirmed').isVisible());
    check('voice still captured', await page.getByText(/✓ captured/).isVisible());
    const draftText = await card(page, /4 · Draft/).innerText();
    check('all 4 drafted sections still there', FX.SECTIONS.every((s) => draftText.includes(s.title)), draftText.slice(0, 300));
    check('refined section text still there', draftText.includes(FX.MARKERS.refined));
    check('scorecard still there (72/100)', /72\s*\/100/.test(await card(page, /5 · Self-Score/).innerText()));
    const before = await requestCount();
    await page.getByRole('button', { name: 'Re-Score Draft' }).click();
    await waitUntil(async () => (await promptsFor('self_score_v1', before)).length >= 1, JOB_TIMEOUT, 'the re-score AI call');
    await waitUntil(async () => (await page.locator('[role=status]').count()) === 0, JOB_TIMEOUT, 'the re-score to finish');
    const calls = await promptsFor('self_score_v1', before);
    check('an AI step works after restart (saved key decrypts)', calls.length === 1 && calls[0].key_suffix === VALID_KEY.slice(-4), calls.map((c) => c.key_suffix));
    check('no error after re-scoring', (await alertBox(page).count()) === 0, (await alertBox(page).allInnerTexts()).join(' '));
    const md = await downloadFrom(page, () => page.getByRole('button', { name: 'Markdown', exact: true }).click(), alertBox(page));
    const sha = mdHash(md.buf.toString('utf8'));
    check('Markdown export after restart is identical', !state.mdExportSha || sha === state.mdExportSha, `${sha} vs ${state.mdExportSha}`);
    await page.getByRole('button', { name: /Copy debug bundle/ }).click();
    await page.getByText(/Debug bundle copied|Could not copy/).first().waitFor({ timeout: 20000 });
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    check('debug bundle still has the AI calls from before the restart', clip.includes('section_draft_v1') && clip.includes('grant_spec_v1'), clip.slice(0, 300));
  });
  await step('Writer: a wrong or missing application id shows a clear message', async () => {
    await expectingErrors([{ url: /\/api\/writer\/applications\/app_doesnotexist$/, text: /status of 404/ }], async () => {
      await page.goto(`${BASE}/writer?id=app_doesnotexist`, { waitUntil: 'domcontentloaded' });
      await page.getByText(/Application not found/).waitFor({ timeout: 20000 });
      check('unknown application id: "Application not found"', true);
    });
    await page.goto(`${BASE}/writer`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/No application selected/).waitFor({ timeout: 20000 });
    check('no application id: says to start from the dashboard', true);
  });

  await context.close();

  const phone = await newContext(browser, { storageState: storagePath, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await newPage(phone, 'persist-phone');
  await step('Phone-sized screen: dashboard and writer fit without sideways scrolling', async () => {
    // Mobile emulation can widen window.innerWidth to fit the page, so compare with the phone's real width.
    const overflow = () => mobile.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - 390);
    await mobile.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
    await waitForDashboard(mobile);
    if (await onStep(mobile, 'results')) {
      await mobile.getByRole('button', { name: 'Website', exact: true }).evaluate((el) => el.click());
      await mobile.getByRole('heading', { name: 'Enter Website URLs' }).waitFor({ timeout: 20000 });
    }
    const setup = await overflow();
    await shot('phone-dashboard', mobile);
    check('dashboard fits a phone screen (no sideways scroll)', setup <= 1, `page is ${setup}px wider than the 390px screen (the 7-step bar does not fit; "Results" is off-screen)`);
    check('step bar buttons have names a screen reader can read on a phone', (await mobile.getByRole('button', { name: 'Results', exact: true }).count()) === 1,
      'on narrow screens the step labels are display:none and the icon-only buttons have no aria-label');
    // The step bar's 7th button is Results (by position, since it has no accessible name on phones).
    await mobile.locator('header + div button').nth(6).evaluate((el) => el.click()); // it is off-screen on a phone
    await mobile.getByRole('heading', { name: 'Match Results' }).waitFor({ timeout: 20000 });
    const results = await overflow();
    await shot('phone-results', mobile);
    check('match results fit a phone screen', results <= 1, `page is ${results}px wider than the screen`);
    await mobile.goto(`${BASE}/writer?id=${state.appId}`, { waitUntil: 'domcontentloaded' });
    await mobile.getByRole('heading', { name: KENEDY }).waitFor({ timeout: 20000 });
    const writer = await overflow();
    await shot('phone-writer', mobile);
    check('writer fits a phone screen', writer <= 1, `page is ${writer}px wider than the screen`);
  });
  await phone.close();
}

// =============================================================================
// Phase: locked (guest sign-in off)
// =============================================================================

async function locked(browser) {
  const context = await newContext(browser);
  const page = await newPage(context, 'locked');
  await step('Guest sign-in off: landing explains sign-in is not set up', async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.getByText(/sign-in isn.t set up yet/i).waitFor({ timeout: 30000 });
    check('"Sign-in isn\'t set up yet" shown', true);
    check('message tells the owner how to fix it (ALLOW_GUEST_LOGIN / Google)', await page.getByText(/ALLOW_GUEST_LOGIN/).isVisible());
    check('no "Continue as guest" button', (await page.getByRole('button', { name: /continue as guest/i }).count()) === 0);
    const options = await api('GET', '/api/auth/options');
    check('engine reports no sign-in methods', options.data?.guest === false && options.data?.google === false, options.data);
    const direct = await api('POST', '/api/auth/guest');
    check('engine refuses guest sign-in (403)', direct.status === 403 && /turned off/i.test(direct.data?.detail || ''), `${direct.status} ${direct.text.slice(0, 120)}`);
  });
  await context.close();
}

// =============================================================================
// Phase: down (engine unreachable)
// =============================================================================

async function down(browser) {
  const variants = [
    { label: 'engine answers 502 (function crashed)', handler: (route) => route.fulfill({ status: 502, contentType: 'text/html', body: '<html><body>502 Bad Gateway</body></html>' }) },
    { label: 'engine unreachable (connection refused)', handler: (route) => route.abort('connectionrefused') },
    { label: 'engine function missing (Netlify 404 page)', handler: (route) => route.fulfill({ status: 404, contentType: 'text/html', body: '<!doctype html><html><body>Page not found</body></html>' }) },
  ];
  for (const variant of variants) {
    const context = await newContext(browser);
    const page = await newPage(context, `down-${slug(variant.label)}`);
    await step(`Engine down (${variant.label}): landing says it can't reach the engine`, async () => {
      await expectingErrors([
        { url: /\/api\//, text: /status of (502|404)|Failed to load resource/ },
        { text: /did not answer|ERR_CONNECTION_REFUSED|ERR_FAILED|Network Error|request failed/i },
        { text: /^502 /, url: /\/api\// },
      ], async () => {
        await page.route('**/api/**', variant.handler);
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        await page.getByText(/can.t reach the grantfinder engine/i).waitFor({ timeout: 30000 });
        check('"Can\'t reach the GrantFinder engine" shown', true);
        check('message explains where to look (Netlify logs / SECRET_KEY)', await page.getByText(/Netlify/).first().isVisible());
        check('no sign-in buttons while the engine is down', (await page.getByRole('button', { name: /continue as guest/i }).count()) === 0);
        check('not stuck on "Connecting to GrantFinder..."', (await page.getByText('Connecting to GrantFinder...').count()) === 0);
      });
    });
    await context.close();
  }
}

// =============================================================================
// Main
// =============================================================================

const PHASES = { journey, basics, errors, expired, persist, locked, down };

(async () => {
  if (!PHASES[phase]) {
    console.log(`Unknown phase "${phase}". Use one of: ${Object.keys(PHASES).join(', ')}`);
    process.exit(2);
  }
  fs.mkdirSync(ARTIFACTS, { recursive: true });
  let browser;
  let code = 1;
  try {
    browser = await chromium.launch({ headless: !HEADED });
    await PHASES[phase](browser);
  } catch (error) {
    check(`phase "${phase}" crashed`, false, (error && error.stack) || String(error));
  } finally {
    code = finish();
    if (browser) await browser.close().catch(() => {});
  }
  process.exit(code);
})();
