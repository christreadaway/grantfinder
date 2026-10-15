/**
 * Runs before every Netlify build (see netlify.toml).
 *
 * GrantFinder works on every Netlify plan: by default each AI step runs inside
 * a normal request (direct mode). Netlify background functions (15 minutes
 * per step) are used only when the site sets GRANTFINDER_BACKGROUND_JOBS=true,
 * because a deploy that contains a background function FAILS on Netlify plans
 * without them ("Background Functions not allowed by team plan", e.g. legacy
 * Starter). So the background function is copied into netlify/functions only
 * when it is wanted, and removed otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'netlify', 'background', 'grantfinder-jobs-background.mts');
const functionsDir = path.join(root, 'netlify', 'functions');
const target = path.join(functionsDir, 'grantfinder-jobs-background.mts');
const wanted = String(process.env.GRANTFINDER_BACKGROUND_JOBS || '').trim().toLowerCase() === 'true';

fs.mkdirSync(functionsDir, { recursive: true });
if (wanted) {
  fs.copyFileSync(source, target);
  console.log('[GrantFinder] GRANTFINDER_BACKGROUND_JOBS=true: deploying the background worker (AI steps can run up to 15 minutes).');
} else {
  fs.rmSync(target, { force: true });
  console.log('[GrantFinder] AI steps run inside normal requests (works on every Netlify plan). Set GRANTFINDER_BACKGROUND_JOBS=true only if your Netlify plan includes background functions.');
}
