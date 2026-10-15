# Deploying GrantFinder on Netlify

GrantFinder runs entirely on Netlify. There is no second server to host.

| Part | What it is | Where it lives in the repo |
|---|---|---|
| Website | The screens people use | `frontend/src/app/` |
| Engine | Sign-in, grants, profile, matching, the grant writer (at `/api/*` on the same site) | `frontend/src/server/` |
| AI steps | Every Claude step runs inside a normal Netlify request (up to about a minute each); long steps such as drafting a whole application continue on their own in parts | `frontend/src/server/jobs.ts` |
| Storage | Netlify Blobs: users, saved API keys, grants, profiles, applications. Survives every deploy | (set up by Netlify automatically) |

`netlify.toml` already tells Netlify how to build all of it. You add one secret and click deploy.

**Works on every Netlify plan**, including the older free (legacy Starter) plan, because it doesn't
need Netlify background functions. (A deploy that contains a background function fails on plans
without them, so GrantFinder only adds one when you ask for it; see "Optional: longer AI steps"
below.)

Total time: about 15 minutes, plus 10 for Google sign-in (optional).

---

## Step 1. Merge the branch on GitHub

On GitHub, open a pull request from `claude/relaxed-curie-sj0zvu` into `main` and merge it.
Netlify deploys from `main`.

## Step 2. Make a secret key (on your Mac)

```bash
cd ~/grantfinder
openssl rand -base64 48
```

Copy the line it prints. That is your `SECRET_KEY`. It signs every sign-in and encrypts each
person's saved Claude API key, so keep it private and don't change it later (changing it signs
everyone out and makes saved API keys unreadable, so people would re-enter them).

## Step 3. Create the site on Netlify

1. Go to [app.netlify.com](https://app.netlify.com), click **Add new site** (Netlify may say
   **Add new project**), then **Import an existing project**, then **GitHub**, then pick
   `christreadaway/grantfinder`. Where these steps say "site," your screen may say "project."
2. Branch to deploy: `main`. Leave the build settings alone; `netlify.toml` sets the base directory
   (`frontend`), the build command, the functions folder, and the Next.js runtime.
3. Before deploying, open **Add environment variables** (or later: **Site configuration**, then
   **Environment variables**) and add:

   ```
   SECRET_KEY=<the line from Step 2>
   ALLOW_GUEST_LOGIN=true
   ```

   Keep Netlify's defaults on each variable (all scopes, same value for every deploy context).

   Optional:

   ```
   CLAUDE_MODEL=claude-sonnet-5
   LOG_LEVEL=info
   ```

   `CLAUDE_MODEL` picks the Claude model for every AI step. `claude-sonnet-5` is the default and the
   right choice on most Netlify plans: each AI step has about a minute, and Sonnet finishes well
   inside it. `claude-opus-5-5` writes a little better but is slower and costs more; use it only
   with the background option below.
4. Click **Deploy**. The build takes 2 to 4 minutes. If `SECRET_KEY` is missing or too short, the
   build stops and the log tells you exactly what to fix.
5. When it finishes, copy your site address, for example `https://grantfinder-abc123.netlify.app`.
   You can rename it under **Site configuration**, then **Change site name**.

## Step 4. Check it

1. Open `https://<your-site>/api/health`. You should see
   `{"status":"healthy",...,"runtime":"netlify","store":"blobs","jobs":"direct",...,"claude_api":"api.anthropic.com",...}`.
   (`"jobs":"direct"` means AI steps run inside normal requests, which works on every plan.
   `"claude_api":"api.anthropic.com"` means your Claude key goes straight to Anthropic.)
2. Open `https://<your-site>/`. You should see **Continue as guest**.
3. Click it, paste your Claude API key (from [console.anthropic.com](https://console.anthropic.com),
   it starts with `sk-ant-`), then **Load Starter Database**: 24 grants should load, including
   the Kenedy Memorial Foundation.

Each person brings their own Claude API key; it is encrypted before it is stored, and Netlify
needs no Anthropic key of its own.

## Optional: longer AI steps (only if your Netlify plan has background functions)

Netlify's current credit-based plans (Free, Personal, Pro; accounts created since September 2025)
include background functions, which let one AI step run for up to 15 minutes. Legacy plans
(accounts created before September 4, 2025, such as legacy Starter) don't, and a deploy containing
one fails there with "Background Functions not allowed by team plan". GrantFinder doesn't need them.
If your plan has them and you want each step to have more time (for example to use
`claude-opus-5-5`):

1. In Netlify, add `GRANTFINDER_BACKGROUND_JOBS=true`.
2. Open **Deploys**, click **Trigger deploy**, then **Deploy site**.
3. `https://<your-site>/api/health` now shows `"jobs":"background"`.

If that deploy fails with "Background Functions not allowed by team plan", delete the variable and
deploy again.

### If AI steps stop after a few seconds

Netlify's documentation gives every plan 60 seconds per request, and GrantFinder plans for that.
If an AI step (for example **Write my questions**) fails with **Netlify stopped this step after
about N seconds** and N is well under a minute, this Netlify account allows less time per request.
Two fixes, either one:

1. If your plan includes background functions, add `GRANTFINDER_BACKGROUND_JOBS=true` and redeploy
   (steps above).
2. Otherwise move to one of Netlify's current credit-based plans, which all include background
   functions (Free included): Netlify lets a legacy team switch from its billing settings (your
   team dashboard says whether the team is on a Legacy or credit-based plan). Then add
   `GRANTFINDER_BACKGROUND_JOBS=true` and redeploy. Switching changes billing for every site on
   that team, so read Netlify's plan page first.

## Step 5 (optional). Turn on Google sign-in

Guest sign-in is tied to one browser. Google sign-in follows you to any computer.

**Important:** a guest account and a Google account are separate. If you start an application as
a guest, finish it as that guest in the same browser, or export your work first. After you sign out
of a guest session, or start a new guest session in the same browser, the earlier guest work can't
be opened again from the screens; GrantFinder asks before either one.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or pick one).
2. Open **APIs & Services**, then **Credentials**. If Google asks you to configure the consent screen
   (it may be called **Google Auth Platform** or **OAuth consent screen**), choose **External**, enter an
   app name and your email, and save. You can stay in **Testing** mode and add yourself as a test user.
3. Click **Create Credentials**, then **OAuth client ID**, then **Web application**.
4. Under **Authorized JavaScript origins**, add your Netlify address and `http://localhost:3000`.
   No redirect URIs are needed.
5. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
6. In Netlify, add `NEXT_PUBLIC_GOOGLE_CLIENT_ID=<client id>`. To turn guests off, change
   `ALLOW_GUEST_LOGIN` to `false`.
7. Open **Deploys**, click **Trigger deploy**, then **Deploy site**. Netlify bakes `NEXT_PUBLIC_`
   values in at build time, so it needs a fresh build to pick them up.
8. Reload your site. You should see the Google button.

---

## If something is wrong

| What you see | What it means | Fix |
|---|---|---|
| Netlify build fails: `SECRET_KEY is not set` or `must be at least 32 characters` | The secret is missing or short | Step 2 and Step 3.3, then **Trigger deploy** |
| Site shows **Can't reach the GrantFinder engine** | The site's functions didn't start | Netlify > **Logs** > **Functions**, open `___netlify-server-handler`, read the error; check `SECRET_KEY`; redeploy |
| Site shows **Sign-in isn't set up yet** | Neither Google nor guest sign-in is on | Set `ALLOW_GUEST_LOGIN=true` (or do Step 5), then redeploy |
| Site says **Google sign-in is only half set up** | The engine has a Google client ID the website doesn't | Add `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in Netlify and redeploy |
| Google popup says the origin isn't allowed | Your Netlify address isn't in the Google client | Step 5.4 |
| **Anthropic rejected your Claude API key** | Typo or revoked key | Re-enter the key on the dashboard's API Key step |
| API Key step says **Anthropic rejected this API key** although the key is active in the Anthropic Console | The message quotes what Anthropic said. Before Oct 15, 2026, GrantFinder followed the `ANTHROPIC_BASE_URL` that Netlify's AI Gateway adds to every function on credit-based plans, so the key went to Netlify's gateway, which refused it | Redeploy the latest `main` (it always calls `api.anthropic.com`; `/api/health` shows `"claude_api":"api.anthropic.com"`), then paste the key again. If it still fails, copy the key with the Console's copy button |
| **Your Anthropic account is out of API credits** | No balance left | Add credits at console.anthropic.com (Billing), then retry |
| **Your Anthropic account reached its monthly API spending cap** (or **hit a spending limit that was set on it**) | A spending limit on the Anthropic account | Raise it at platform.claude.com/settings/billing (the message names the page), then try again |
| **Can't reach GrantFinder right now**, **Couldn't reach GrantFinder to reopen your saved work**, **Lost the connection to GrantFinder**, or **Lost contact with GrantFinder while this step was running** | The internet connection dropped, or Netlify had a brief error. Your sign-in and saved work are kept, and a step that was running keeps running on Netlify | Check your internet, then click **Try again** (or the same button again: a running step is picked back up, not started twice). Don't start a new guest session; it would be empty |
| Sign-in page says **Your session ended** | The sign-in expired (sessions last 30 days) or was refused, for example after `SECRET_KEY` changed | Sign in with Google again and your work is there. A guest session can't be reopened |
| Deploy fails: **Background Functions not allowed by team plan** | `GRANTFINDER_BACKGROUND_JOBS=true` is set, but the Netlify plan has no background functions | Delete that variable and deploy again. GrantFinder works without it |
| **Couldn't start the background worker** | `GRANTFINDER_BACKGROUND_JOBS=true` is set, but the worker isn't deployed or allowed | Delete that variable and redeploy (AI steps then run inside normal requests), or **Trigger deploy** if your plan has background functions |
| **This step was stopped by Netlify**, **This step ran out of time**, **Claude was still working when this step reached its time limit**, or **The background worker stopped unexpectedly** | An AI step reached Netlify's time limit (about a minute per step; 15 minutes with background functions), or its worker stopped | Try it again; anything that finished was saved. In the writer, **Draft missing sections** drafts only the sections with no draft yet. If one step keeps stopping, set `CLAUDE_MODEL=claude-sonnet-5` (faster) |
| Website scan says the site **blocks automated reading** | Many parish sites block bots | Use **Enter the basics by hand** or **Skip to questions**; upload documents for detail |
| Writer says **requirements were inferred** | The funder's page couldn't be read | Paste the guidelines under **Paste guidelines and re-analyze** |
| An upload says it is **larger than 4 MB** (or over the **limit 4 MB**) | Netlify's request size limit | Save a smaller copy (fewer images or pages) and upload again. For a big report, add a plain-text (.txt) copy instead; the Documents step explains how |

## Where the logs are

- **Easiest:** the dashboard's **Copy debug report** link (top right; only a bug icon on a phone)
  and the writer's **Copy debug bundle** button. Each copies a paste-ready report of recent steps,
  every error with its internal detail, and the AI calls behind it. No keys or secrets are included.
  If the browser blocks copying, the report downloads as a `.md` file instead.
- **Netlify:** **Logs**, then **Functions**. `___netlify-server-handler` is the engine API and,
  by default, also runs every AI step; `grantfinder-jobs-background` appears only with the
  background option. Every line is one JSON record.
- **Website build:** **Deploys**, then the deploy's log.
- **In the browser:** right-click, **Inspect**, **Console**. GrantFinder's own messages start with `[GrantFinder]`.

Paste any of these into Claude Code when something breaks.

## Known limits (today)

- **Each AI step gets about a minute** (Netlify stops a normal request at 60 seconds; GrantFinder
  stops its Claude calls at 50 so it can save). Drafting a whole application runs a few sections
  per request and continues on its own; matching scores its batches at the same time. With the
  background option, each step can run up to 15 minutes.
- **Uploads are limited to 4 MB** each, and Claude reads the first 60,000 characters of each
  document. For a long report, upload the later pages as a separate file.
- **Guest accounts live in one browser.** Clearing the browser's site data, or signing out, loses
  access to that guest's work. Use Google sign-in for anything you'll come back to on another
  computer.
- **Data stays in Netlify Blobs** across deploys. To wipe everything, delete the `grantfinder`
  store under **Blobs** in the Netlify site menu.
- **Netlify's free plan is enough** for one school (legacy or current). Each AI step's progress
  checks count as function calls.

## Run it on your Mac instead

```bash
cd ~/grantfinder/frontend
sfw npm install
cp .env.example .env.local
npm run dev
```

If `sfw` isn't installed, use `npm install`. Open [http://localhost:3000](http://localhost:3000)
and click **Continue as guest**. Data is kept in `~/grantfinder/frontend/.data/` and logs in
`~/logs/grantfinder/grantfinder.log`.
