# Deploying GrantFinder on Netlify

GrantFinder has two parts, and Netlify can host only one of them:

| Part | What it is | Where it runs | Why |
|---|---|---|---|
| Website | Next.js app in `frontend/` | **Netlify** | This is the address people visit |
| Engine | Python FastAPI app in `backend/` | **Railway** | Netlify Functions run JavaScript, TypeScript, and Go, not Python |

People only ever see the Netlify address. The website calls the engine behind the scenes.
Railway's Hobby plan is about $5 a month; Netlify's free plan is enough for the website.

Do the steps in this order: the website needs the engine's address, and the engine needs the
website's address. Deploy from `main` after you merge this branch on GitHub.

Total time: about 30 minutes, plus 10 for Google sign-in.

---

## Step 1. Make a secret key (on your Mac)

```bash
cd ~/grantfinder
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Copy the long line it prints. That is your `SECRET_KEY`. It must be at least 32 characters, and
it signs every sign-in session, so keep it private.

## Step 2. Deploy the engine on Railway

1. Go to [railway.com](https://railway.com) and sign in with GitHub.
2. Click **New Project**, then **Deploy from GitHub repo**, then pick `christreadaway/grantfinder`.
3. Click the new service and open **Settings**:
   - Under **Source**, set **Root Directory** to `backend`.
   - Under **Deploy**, set **Custom Start Command** to exactly:

     ```
     python -m uvicorn main:app --host 0.0.0.0 --port $PORT
     ```

   (`backend/.python-version` asks for Python 3.13. The same command is in `backend/Procfile` for hosts that read it.)
4. Open **Variables** and add these. Use **Raw Editor** to paste them in one go:

   ```
   SECRET_KEY=<the line from Step 1>
   ALLOW_GUEST_LOGIN=true
   FORWARDED_ALLOW_IPS=*
   LOG_LEVEL=info
   CLAUDE_MODEL=claude-sonnet-5
   ```

   `ALLOW_GUEST_LOGIN=true` lets you try the site before Google sign-in exists. Step 5 turns it off.
   `FORWARDED_ALLOW_IPS=*` lets the engine see each visitor's real address behind Railway's proxy,
   which its sign-in rate limit relies on.
5. Under **Settings**, then **Networking**, click **Generate Domain**. If Railway asks for a port,
   accept the one it suggests. Copy the address, for example `https://grantfinder-production.up.railway.app`.
6. Optional but recommended: under **Settings**, then **Deploy**, set **Healthcheck Path** to `/api/health`.
7. Check it: open `https://<your-railway-address>/api/health` in your browser. You should see
   `{"status":"healthy",...}`. If not, open **Deployments**, then **View logs**.

Keep the engine at **one replica** and don't add `--workers` to the start command. Sessions and data
live in the engine's memory, so a second copy would not share them.

## Step 3. Deploy the website on Netlify

1. Go to [app.netlify.com](https://app.netlify.com), click **Add new site** (Netlify may label it
   **Add new project**), then **Import an existing project**, then **GitHub**, then pick
   `christreadaway/grantfinder`. Where these steps say "site," your screen may say "project."
2. Branch to deploy: `main`. Leave the build settings alone: `netlify.toml` already sets the base
   directory (`frontend`), the build command, and the Next.js runtime.
3. Before deploying, open **Add environment variables** (or later: **Site configuration**, then
   **Environment variables**) and add:

   ```
   NEXT_PUBLIC_API_URL=https://<your-railway-address>
   ```

   Use the `https://` address from Step 2, with no trailing path. The build refuses to finish without
   it, or with an `http://` address, and the error tells you exactly what to fix.
4. Click **Deploy**. When it finishes, copy your site address, for example `https://grantfinder-abc123.netlify.app`.
   You can rename it under **Site configuration**, then **Change site name**.

## Step 4. Let the engine accept calls from the website

Back in Railway, open **Variables** and add the Netlify address, exactly like this (square brackets
and quotes included, no trailing slash):

```
CORS_ORIGINS=["https://grantfinder-abc123.netlify.app","http://localhost:3000"]
```

Railway redeploys on its own. Now open your Netlify address. You should see **Continue as guest**.
Click it, paste a Claude API key, and click **Load Starter Database**: 24 grants should load.

## Step 5. Turn on Google sign-in

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and create a project (or pick one).
2. Open **APIs & Services**, then **Credentials**. If Google asks you to configure the consent screen
   (it may be called **Google Auth Platform** or **OAuth consent screen**), choose **External**, enter an
   app name and your email, and save. You can stay in **Testing** mode and add yourself as a test user.
3. Click **Create Credentials**, then **OAuth client ID**, then **Web application**.
4. Under **Authorized JavaScript origins**, add your Netlify address and `http://localhost:3000`.
   No redirect URIs are needed.
5. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`).
6. Railway: add `GOOGLE_CLIENT_ID=<client id>`, and change `ALLOW_GUEST_LOGIN` to `false`.
7. Netlify: add `NEXT_PUBLIC_GOOGLE_CLIENT_ID=<client id>`, then open **Deploys**, click
   **Trigger deploy**, then **Deploy site**. Netlify bakes `NEXT_PUBLIC_` values in at build time, so
   it needs a fresh build to pick it up.
8. Reload your site. You should see the Google button and no guest button.

---

## If something is wrong

| What you see | What it means | Fix |
|---|---|---|
| Netlify build fails: `NEXT_PUBLIC_API_URL is not set` | The website doesn't know where the engine is | Step 3.3, then redeploy |
| Netlify build fails: `must start with https://` | The address is `http://` | Use the `https://` Railway address |
| Site shows **Can't reach the GrantFinder engine** | Wrong address, engine down, or the engine is refusing the website | Open `<railway-address>/api/health`; check `NEXT_PUBLIC_API_URL`; check `CORS_ORIGINS` has your exact Netlify address (Step 4) |
| Site shows **Sign-in isn't set up yet** | No Google and no guest sign-in | Step 5, or set `ALLOW_GUEST_LOGIN=true` on Railway to try it |
| Site says **Google sign-in is only half set up** | Netlify has the client ID, Railway doesn't | Add `GOOGLE_CLIENT_ID` on Railway |
| Google popup says the origin isn't allowed | Your Netlify address isn't in the Google client | Step 5.4 |
| **Your session ended** after a while | The engine restarted (every Railway deploy restarts it) | Sign in again. See "Known limits" below |
| Railway logs: `SECRET_KEY must be at least 32 characters` | Key too short | Redo Step 1 |

## Where the logs are

- **Engine:** Railway, then your service, then **Deployments**, then **View logs**. Every sign-in,
  AI call (with tokens, time, and cost), and error is there. Grant applications also have a
  paste-ready debug report at `GET /api/writer/applications/{id}/debug-bundle`.
- **Website build:** Netlify, then **Deploys**, then the failed deploy's log.
- **In the browser:** right-click, **Inspect**, **Console**. GrantFinder's own messages start with `[GrantFinder]`.

Paste any of these into Claude Code when something breaks.

## Known limits (today)

- **Data lives in memory.** Grants, profiles, applications, drafts, and sign-in sessions reset whenever
  the engine restarts, including every Railway deploy. Work in one sitting and export what you want to
  keep. Saving to a database (Supabase) is the next milestone.
- **Each user brings their own Claude API key.** No Anthropic key is needed on Railway.
- **One engine copy only** (see Step 2).

## Run it on your Mac instead

Terminal 1, the engine:

```bash
cd ~/grantfinder/backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Open `~/grantfinder/backend/.env` in a text editor: set `SECRET_KEY` to the line from Step 1 and
`ALLOW_GUEST_LOGIN=true`. Then:

```bash
cd ~/grantfinder/backend
source .venv/bin/activate
uvicorn main:app --reload
```

Terminal 2, the website:

```bash
cd ~/grantfinder/frontend
sfw npm install
cp .env.example .env.local
npm run dev
```

If `sfw` isn't installed, use `npm install`. Open [http://localhost:3000](http://localhost:3000)
and click **Continue as guest**.
