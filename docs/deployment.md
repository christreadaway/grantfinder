# Deploying GrantFinder

GrantFinder is two deployables:

| Piece | What it is | Where it runs |
|---|---|---|
| Frontend | Next.js app (`/frontend`) | **Netlify** |
| Backend | Python FastAPI app (`/backend`) | **Railway** (or Render) - Netlify cannot run Python servers |

Deploy the backend first so you have its URL for the frontend.

## 1. Backend → Railway (or Render)

1. In Railway: **New Project → Deploy from GitHub repo**, pick `grantfinder`,
   set the **root directory to `backend/`**. Railway auto-detects Python and
   uses the `Procfile` (`uvicorn main:app --host 0.0.0.0 --port $PORT`).
2. Set environment variables:

   ```
   SECRET_KEY=<random 32+ character string>
   GOOGLE_CLIENT_ID=<from Google Cloud Console>
   GOOGLE_CLIENT_SECRET=<from Google Cloud Console>
   CLAUDE_MODEL=claude-sonnet-5
   LOG_LEVEL=info
   CORS_ORIGINS=["https://YOUR-SITE.netlify.app","http://localhost:3000"]
   ```

   `CORS_ORIGINS` must be a JSON array and must include your Netlify domain,
   or every browser request from the deployed frontend will be blocked.
3. Note the public URL Railway assigns (e.g. `https://grantfinder-production.up.railway.app`).

Render works the same way: root dir `backend`, start command
`uvicorn main:app --host 0.0.0.0 --port $PORT`, same env vars.

## 2. Frontend → Netlify

1. In Netlify: **Add new site → Import from Git**, pick `grantfinder`.
   The repo-root `netlify.toml` already sets base `frontend`, build
   `npm run build`, and the Next.js plugin - the defaults it fills in are correct.
2. Set one environment variable:

   ```
   NEXT_PUBLIC_API_URL=https://<your-backend-url>
   ```

3. Deploy. The app serves `/` (landing), `/dashboard` (discovery + matching),
   and `/writer` (application writer).

## 3. Google OAuth

In Google Cloud Console → Credentials → your OAuth client, add your Netlify
domain to **Authorized JavaScript origins** (e.g. `https://YOUR-SITE.netlify.app`).

## Things to know

- **Storage is in-memory.** Grants, profiles, applications, and drafts reset
  whenever the backend restarts or redeploys. Supabase persistence is the
  next milestone - until then, treat deployed sessions as work-in-one-sitting
  and export anything you want to keep.
- **File logs** land on the backend host at `~/logs/grantfinder/`; on Railway
  use `railway logs` (stdout carries the same structured lines).
- **Users bring their own Claude API key** through the UI; no Anthropic key
  is needed in the deploy environment.
