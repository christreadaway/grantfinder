# GrantFinder app (`frontend/`)

This folder is the whole application: the website and the engine API it calls. It deploys to
Netlify as one site (see `../netlify.toml` and `../docs/deployment.md`).

| Folder | What's in it |
|---|---|
| `src/app/` | Screens: landing/sign-in (`page.tsx`), setup and matching (`dashboard/`), the grant writer (`writer/`), and the `/api/*` entry point (`api/[...path]/route.ts`) |
| `src/lib/api.ts` | The website's API client: same-origin calls, background-job polling, live progress |
| `src/server/` | The engine: routes, services, background job handlers, storage, Claude client. Start with `../docs/engine.md` |
| `netlify/functions/` | The background function that runs AI jobs (up to 15 minutes each) |

## Run it locally

```bash
cd ~/grantfinder/frontend
sfw npm install
cp .env.example .env.local
npm run dev
```

If `sfw` isn't installed, use `npm install`. Open [http://localhost:3000](http://localhost:3000) and
click **Continue as guest**. Local data lives in `.data/`; logs in `~/logs/grantfinder/grantfinder.log`.

## Tests

```bash
cd ~/grantfinder
bash tests/engine/run_all.sh
bash tests/e2e/run_e2e.sh
```

The engine suites use a mock Claude (no API key needed). The browser test's one-time setup is at
the top of `tests/e2e/run_e2e.sh`.
