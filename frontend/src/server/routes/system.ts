/**
 * /api/health, /api/jobs, /api/debug/report.
 */
import { hasApiKey } from '../auth';
import { allowGuestLogin, APP_VERSION, claudeModel, googleClientId, jobMode, onNetlify, storeKind } from '../config';
import { HttpError } from '../errors';
import { listJobs, getJob, runDirectJob, toPublicJob, type Job } from '../jobs';
import { logger } from '../log';
import { getGrants, getProfile, listApplications } from '../repo';
import type { Router } from '../router';
import { kv } from '../store';

function fence(text: string): string {
  return '```\n' + text.replace(/```/g, "'''") + '\n```';
}

function describeJob(job: Job): string {
  const lines: string[] = [];
  const ms = job.started_at && job.finished_at ? Date.parse(job.finished_at) - Date.parse(job.started_at) : null;
  lines.push(`### ${job.kind}: ${job.status.toUpperCase()}`);
  lines.push(`- Job: \`${job.id}\` | correlation \`${job.correlation_id}\`${job.application_id ? ` | application \`${job.application_id}\`` : ''}`);
  lines.push(`- Created ${job.created_at}${ms !== null ? ` | ran ${(ms / 1000).toFixed(1)}s` : ''}${job.progress ? ` | last status: ${job.progress}` : ''}`);
  if (job.error) lines.push(`- Error shown to user (HTTP ${job.error.status}): ${job.error.detail}`);
  if (job.error_debug) lines.push(`- Internal error:\n${fence(job.error_debug)}`);
  if (job.ai_calls.length) {
    const cost = job.ai_calls.reduce((sum, call) => sum + call.cost_estimate_usd, 0);
    const tokensIn = job.ai_calls.reduce((sum, call) => sum + call.input_tokens, 0);
    const tokensOut = job.ai_calls.reduce((sum, call) => sum + call.output_tokens, 0);
    lines.push(`- AI calls: ${job.ai_calls.length} | tokens in/out ${tokensIn}/${tokensOut} | est. cost $${cost.toFixed(4)}`);
    for (const call of job.ai_calls.slice(-12)) {
      lines.push(
        `  - ${call.timestamp} ${call.stage}/${call.prompt_id} ${call.model} ${call.status} ` +
          `${call.latency_ms}ms in=${call.input_tokens} out=${call.output_tokens}` +
          `${call.web_searches ? ` searches=${call.web_searches}` : ''}` +
          `${call.stop_reason && call.stop_reason !== 'end_turn' ? ` stop=${call.stop_reason}` : ''}` +
          `${call.error ? ` error="${call.error}"` : ''}`,
      );
    }
  }
  if (job.notes.length) {
    lines.push('- Notes:');
    for (const note of job.notes.slice(-15)) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}

export function registerSystemRoutes(router: Router): void {
  router.get('/api/health', async () => {
    let storeOk = true;
    try {
      await kv().get('health/ping');
    } catch (error) {
      storeOk = false;
      logger.error('health_store_failed', { error: (error as Error).message });
    }
    return {
      status: storeOk ? 'healthy' : 'degraded',
      version: APP_VERSION,
      runtime: onNetlify() ? 'netlify' : 'local',
      store: storeKind(),
      // direct: every AI step runs inside a normal request (any Netlify plan);
      // background: Netlify background functions (GRANTFINDER_BACKGROUND_JOBS=true).
      jobs: jobMode(),
      model: claudeModel(),
      services: { api: true, database: storeOk },
    };
  });

  router.get('/api/jobs/:jobId', async (ctx) => {
    const user = await ctx.user();
    const job = await getJob(user.id, ctx.params.jobId);
    if (!job) throw new HttpError(404, 'Job not found');
    return toPublicJob(job);
  });

  /** Direct mode: run a queued job inside this request (see jobs.ts runDirectJob). */
  router.post('/api/jobs/:jobId/run', async (ctx) => {
    const user = await ctx.user();
    const job = await runDirectJob(user.id, ctx.params.jobId);
    if (!job) throw new HttpError(404, 'Job not found');
    return toPublicJob(job);
  });

  router.get('/api/jobs', async (ctx) => {
    const user = await ctx.user();
    const jobs = await listJobs(user.id, 25);
    return { jobs: jobs.map((job) => ({ ...toPublicJob(job), result: null })) };
  });

  /**
   * Paste-ready markdown for Claude Code: environment, recent steps, every
   * error with its internal detail, and the AI calls behind each step.
   * Contains no keys or secrets.
   */
  router.get('/api/debug/report', async (ctx) => {
    const user = await ctx.user();
    const [jobs, profile, grants, applications, keySaved] = await Promise.all([
      listJobs(user.id, 15),
      getProfile(user.id),
      getGrants(user.id),
      listApplications(user.id),
      hasApiKey(user.id),
    ]);
    const lines: string[] = [
      '# GrantFinder debug report',
      '',
      `- Generated: ${new Date().toISOString()}`,
      `- Version ${APP_VERSION} | runtime ${onNetlify() ? 'Netlify' : 'local'} | AI steps run ${jobMode()} | storage ${storeKind()} | model ${claudeModel()}`,
      `- Sign-in options: Google ${googleClientId() ? 'on' : 'off'}, guest ${allowGuestLogin() ? 'on' : 'off'}`,
      `- User \`${user.id}\` | Claude key saved: ${keySaved ? 'yes' : 'NO'}`,
      `- Profile: ${profile ? `yes (${profile.sources.length} sources, ${profile.questionnaire_answers.length} questionnaire answers, ${profile.evidence.length} evidence items)` : 'NO'}`,
      `- Grants in database: ${grants.length} | Applications: ${applications.length}`,
      `- Website: ${ctx.req.headers.get('user-agent') || 'unknown browser'}`,
      '',
      `## Recent steps (newest first, ${jobs.length})`,
      '',
    ];
    if (!jobs.length) lines.push('_No background steps yet._');
    for (const job of jobs) {
      lines.push(describeJob(job), '');
    }
    const markdown = lines.join('\n');
    if (ctx.query.get('format') === 'json') return { markdown };
    return new Response(markdown, { headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' } });
  });
}
