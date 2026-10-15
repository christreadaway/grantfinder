/**
 * Netlify background function: runs one GrantFinder job (AI work) for up to
 * 15 minutes. The "-background" suffix in the file name is what makes Netlify
 * run it in the background: callers get 202 immediately.
 *
 * OPTIONAL: scripts/netlify-functions.mjs copies this file into
 * netlify/functions/ only when GRANTFINDER_BACKGROUND_JOBS=true, because a
 * deploy containing a background function fails on Netlify plans without them
 * (e.g. legacy Starter). Without it, jobs run in direct mode (src/server/jobs.ts).
 *
 * Only the engine's own API routes can start it: each request carries an
 * HMAC signature made with SECRET_KEY (see src/server/jobs.ts).
 */
import { runJob, verifyJobSignature } from '../../src/server/jobs';
import { logger } from '../../src/server/log';

export default async (req: Request): Promise<Response> => {
  let body: { user_id?: string; job_id?: string; signature?: string } = {};
  try {
    body = await req.json();
  } catch {
    logger.warn('background_bad_body');
    return new Response('bad request', { status: 400 });
  }
  const { user_id: userId, job_id: jobId, signature } = body;
  if (!userId || !jobId || !signature || !verifyJobSignature(userId, jobId, signature)) {
    logger.warn('background_rejected', { job_id: jobId });
    return new Response('forbidden', { status: 403 });
  }
  try {
    await runJob(userId, jobId);
  } catch (error) {
    // runJob records failures on the job itself; this is a last resort.
    // Returning normally stops Netlify from retrying a job that already failed.
    logger.error('background_crashed', { job_id: jobId, error });
  }
  return new Response('ok');
};
