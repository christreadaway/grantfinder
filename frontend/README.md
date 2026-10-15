# GrantFinder app (`frontend/`)

This folder is the whole application: the website and the engine API it calls. It deploys to
Netlify as one site (see `../netlify.toml` and `../docs/deployment.md`).

| Folder | What's in it |
|---|---|
| `src/app/` | Screens: landing/sign-in (`page.tsx`), setup and matching (`dashboard/`), the grant writer (`writer/`), and the `/api/*` entry point (`api/[...path]/route.ts`) |
| `src/lib/api.ts` | The website's API client: same-origin calls, job polling (keeps going through a Wi-Fi drop or a sleeping laptop; gives up only after 3 minutes online without an answer), live progress, plain-English error messages. On Netlify by default it also runs each AI step (`POST /api/jobs/{id}/run`) and follows a long step's next parts (`__continue`) on its own |
| `src/lib/download.ts` | File downloads and clipboard copies that also work in Safari |
| `src/server/` | The engine: routes, services, job handlers (every Claude call), storage, Claude client. Start with `../docs/engine.md` |
| `netlify/background/` | The optional background function that gives each AI step up to 15 minutes, for Netlify plans that include background functions. Deployed only when `GRANTFINDER_BACKGROUND_JOBS=true`; without it, AI steps run inside normal requests (about a minute each) on any plan |
| `scripts/netlify-functions.mjs` | Runs before every Netlify build: copies the background function into `netlify/functions/` when `GRANTFINDER_BACKGROUND_JOBS=true`, and removes it otherwise (a deploy containing one fails on plans without background functions) |

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

The engine tests use a mock Claude (no API key needed): 10 suites (693 checks), then the processing,
grants, writer, regressions and checklist suites again in direct job mode, the way Netlify runs AI
steps by default (567 more, 1,260 checks in all). The browser test (453 checks) has a one-time setup at the
top of `tests/e2e/run_e2e.sh`; put `E2E_JOB_MODE=direct` in front of it to run AI steps in direct
mode too.
