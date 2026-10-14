/**
 * Structured logging.
 *
 * Every line is one JSON object, so it can be pasted straight into Claude Code.
 *   - Netlify: lines go to the function logs (Netlify > Logs > Functions).
 *   - Your Mac: lines also go to ~/logs/grantfinder/grantfinder.log, rotated
 *     daily and kept for 14 days (like the old Python engine).
 * LOG_LEVEL=debug adds debug lines.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logLevel, onNetlify } from './config';

type Level = 'debug' | 'info' | 'warn' | 'error';

const KEEP_DAYS = 14;
let fileLoggingBroken = false;
let currentDay = '';

function logDir(): string {
  return path.join(os.homedir(), 'logs', 'grantfinder');
}

function fileLoggingEnabled(): boolean {
  if (fileLoggingBroken) return false;
  if (onNetlify()) return false;
  return (process.env.GRANTFINDER_FILE_LOGS ?? '1') !== '0';
}

function rotateIfNeeded(file: string, today: string): void {
  if (currentDay === today) return;
  try {
    const stat = fs.statSync(file);
    const fileDay = stat.mtime.toISOString().slice(0, 10);
    if (fileDay !== today) {
      fs.renameSync(file, `${file}.${fileDay}`);
    }
  } catch {
    // No log file yet.
  }
  try {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(path.dirname(file))) {
      const match = /^grantfinder\.log\.(\d{4}-\d{2}-\d{2})$/.exec(name);
      if (match && Date.parse(match[1]) < cutoff) {
        fs.unlinkSync(path.join(path.dirname(file), name));
      }
    }
  } catch {
    // Pruning is best effort.
  }
  currentDay = today;
}

function writeToFile(line: string): void {
  if (!fileLoggingEnabled()) return;
  try {
    const dir = logDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'grantfinder.log');
    rotateIfNeeded(file, new Date().toISOString().slice(0, 10));
    fs.appendFileSync(file, line + '\n');
  } catch (error) {
    fileLoggingBroken = true;
    console.warn(`[GrantFinder] File logging disabled: ${(error as Error).message}`);
  }
}

function safe(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6).join('\n') };
  }
  return value;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (level === 'debug' && logLevel() !== 'debug') return;
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = safe(value);
  }
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({ ts: entry.ts, level, event, note: 'unserializable fields' });
  }
  // A Claude API key must never reach the logs, whatever field it hides in.
  line = line.replace(/sk-ant-[A-Za-z0-9_-]{4,}/g, 'sk-ant-[redacted]');
  // Tests set GRANTFINDER_LOG_STDOUT=0 to keep their output readable (errors still print).
  const quiet = process.env.GRANTFINDER_LOG_STDOUT === '0' && level !== 'error';
  if (!quiet) {
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
  writeToFile(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log('debug', event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log('error', event, fields),
};
