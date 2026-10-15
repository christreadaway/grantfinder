/**
 * Every background job kind, by name. Imported lazily by jobs.ts (and by the
 * Netlify background function) so the web routes stay light.
 *
 * Job handler modules must not import exceljs, docx, or mammoth: those are
 * only needed by web routes, and the background function should stay small.
 */
import type { JobHandler } from './jobs';
import { discoveryJobs } from './handlers/discovery';
import { processingJobs } from './handlers/processing';
import { writerJobs } from './handlers/writer';

export const JOB_HANDLERS: Record<string, JobHandler> = {
  ...processingJobs,
  ...discoveryJobs,
  ...writerJobs,
};
