/**
 * Every /api/* request goes to the GrantFinder engine (src/server).
 * On Netlify this runs as a normal (60-second) function. AI steps run inside
 * POST /api/jobs/{id}/run requests by default (any Netlify plan), or in the
 * optional background function (netlify/background/, 15 minutes) when
 * GRANTFINDER_BACKGROUND_JOBS=true. See src/server/jobs.ts.
 */
import { handleRequest } from '@/server/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const PATCH = handleRequest;
