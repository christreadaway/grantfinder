/**
 * Every /api/* request goes to the GrantFinder engine (src/server).
 * On Netlify this runs as a normal (60-second) function; long AI work is
 * handed to the background function in netlify/functions/.
 */
import { handleRequest } from '@/server/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handleRequest;
export const POST = handleRequest;
export const PUT = handleRequest;
export const DELETE = handleRequest;
export const PATCH = handleRequest;
