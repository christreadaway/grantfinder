// End-to-end browser test: frontend and backend on different origins, the same
// shape as Netlify + Railway. Run it through run_e2e.sh, which starts both servers.
const { chromium } = require('playwright');
const fs = require('fs');
const FRONT = process.env.E2E_FRONTEND_URL || 'http://127.0.0.1:3000';
const API = process.env.E2E_API_URL || 'http://localhost:8000';
const phase = process.argv[2];
const statePath = process.argv[3];
let failures = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} [${phase}] ${name}${extra ? ' :: ' + extra : ''}`);
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext(
    phase === 'expired' && fs.existsSync(statePath) ? { storageState: statePath } : {}
  );
  const page = await ctx.newPage();
  const consoleErrors = [];
  const apiCalls = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', (r) => {
    if (r.url().startsWith(API)) apiCalls.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });

  if (phase === 'guest') {
    await page.goto(FRONT + '/', { waitUntil: 'networkidle' });
    const guest = page.getByRole('button', { name: /continue as guest/i });
    check('landing shows "Continue as guest"', await guest.isVisible());
    check('old Demo Mode button is gone', (await page.getByText(/demo mode/i).count()) === 0);
    check('no Google button when Google is not configured', (await page.locator('iframe[src*="accounts.google.com"]').count()) === 0);
    await guest.click();
    await page.waitForURL('**/dashboard', { timeout: 15000 });
    check('guest sign-in lands on the dashboard', page.url().endsWith('/dashboard'));
    await page.getByText('Guest', { exact: true }).first().waitFor({ timeout: 10000 });
    check('header shows the guest name', true);

    await page.getByPlaceholder('sk-ant-...').fill('sk-ant-e2e-test-key-not-real');
    await page.getByRole('button', { name: /^continue/i }).click();
    await page.getByRole('button', { name: /load starter database/i }).waitFor({ timeout: 10000 });
    check('API key saves and the grants step opens', true);

    await page.getByRole('button', { name: /load starter database/i }).click();
    await page.getByText(/Starter database loaded/i).waitFor({ timeout: 20000 });
    const loaded = await page.getByText(/Starter database loaded/i).innerText();
    check('starter database loads 24 grants', /24 grants added/.test(loaded), loaded);

    // Writer handoff for the Kenedy grant, through the cross-origin API with the session token
    const result = await page.evaluate(async (api) => {
      const token = localStorage.getItem('auth_token');
      const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
      const grants = await (await fetch(`${api}/api/grants/`, { headers: h })).json();
      const kenedy = grants.find((g) => g.grant_name.startsWith('Kenedy'));
      const reset = await fetch(`${api}/api/profile/reset`, { method: 'POST', headers: h });
      const created = await fetch(`${api}/api/writer/applications`, {
        method: 'POST', headers: h, body: JSON.stringify({ grant_id: kenedy.id }),
      });
      return { kenedy, resetStatus: reset.status, createdStatus: created.status, app: await created.json() };
    }, API);
    check('Kenedy grant present with annual deadline', result.kenedy && result.kenedy.deadline === 'Annual: October 15', result.kenedy && result.kenedy.deadline);
    check('profile created without AI (reset)', result.resetStatus === 200, String(result.resetStatus));
    check('writer application created', result.createdStatus === 200, String(result.createdStatus));
    check('application flagged urgent (deadline within 10 days)', result.app.urgent === true, String(result.app.urgent));

    await page.goto(`${FRONT}/writer?id=${result.app.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: /Kenedy Memorial Foundation Grants/ }).waitFor({ timeout: 15000 });
    check('writer page renders the Kenedy application', true);
    check('writer page shows the urgent deadline banner', (await page.getByText(/Deadline soon/i).count()) > 0);

    await ctx.storageState({ path: statePath });
  }

  if (phase === 'expired') {
    await page.goto(FRONT + '/dashboard', { waitUntil: 'networkidle' });
    await page.waitForURL(/\/\?expired=1$/, { timeout: 15000 });
    check('stale session after a backend restart returns to sign-in', page.url().endsWith('/?expired=1'), page.url());
    check('sign-in page explains the session ended', (await page.getByText(/your session ended/i).count()) > 0);
    check('stale token cleared', (await page.evaluate(() => localStorage.getItem('auth_token'))) === null);
  }

  if (phase === 'locked') {
    await page.goto(FRONT + '/', { waitUntil: 'networkidle' });
    check('no guest button when guest sign-in is off', (await page.getByRole('button', { name: /continue as guest/i }).count()) === 0);
    check('setup message shown when no sign-in method exists', (await page.getByText(/sign-in isn.t set up yet/i).count()) > 0);
    const direct = await page.evaluate(async (api) => (await fetch(`${api}/api/auth/guest`, { method: 'POST' })).status, API);
    check('backend refuses guest sign-in when it is off', direct === 403, String(direct));
  }

  if (phase === 'down') {
    await page.goto(FRONT + '/', { waitUntil: 'networkidle' });
    await page.getByText(/can.t reach the grantfinder engine/i).waitFor({ timeout: 20000 });
    check('unreachable backend shows a clear message', true);
    check('message names the backend URL', (await page.getByText(API).count()) > 0);
  }

  const unexpected = consoleErrors.filter((t) =>
    !(phase === 'down' && /ERR_CONNECTION_REFUSED|Cannot reach the engine|Network Error|Failed to load resource/i.test(t)) &&
    !(phase === 'expired' && /401|Failed to load resource/i.test(t)) &&
    !(phase === 'locked' && /403|Failed to load resource/i.test(t)));
  check('no unexpected browser console errors', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
  console.log(`API calls [${phase}]: ${apiCalls.join(', ') || 'none'}`);
  console.log(`FAILURES [${phase}]: ${failures}`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log(`FAIL [${phase}] crashed: ${e.message}`); process.exit(1); });
