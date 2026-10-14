/**
 * Pull JSON out of a model response, leniently.
 *
 * Models usually return bare JSON, sometimes fenced (```json ... ```), and
 * after web search sometimes with prose or citations around it. Tries, in
 * order: the whole text, each fenced block, then every balanced {...} / [...]
 * span (string-aware), preferring the largest so a stray "[1]" in prose never
 * wins over the real payload.
 */

type Kind = 'object' | 'array' | 'any';

function matchesKind(value: unknown, kind: Kind): boolean {
  if (kind === 'any') return value !== null && typeof value === 'object';
  if (kind === 'array') return Array.isArray(value);
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Escape raw line breaks and tabs inside JSON strings (models sometimes write
 * multi-paragraph text without escaping). Only call on text that starts at a
 * JSON value, so the in-string tracking starts in the right state.
 */
function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n') {
        out += '\\n';
        continue;
      } else if (ch === '\r') {
        out += '\\r';
        continue;
      } else if (ch === '\t') {
        out += '\\t';
        continue;
      }
    } else if (ch === '"') {
      inString = true;
    }
    out += ch;
  }
  return out;
}

/** Parse, and if that fails, parse again with raw control characters escaped. */
function tryParseRepaired(text: string): { ok: true; value: unknown } | { ok: false } {
  const direct = tryParse(text);
  if (direct.ok) return direct;
  const repaired = escapeControlCharsInStrings(text);
  return repaired === text ? direct : tryParse(repaired);
}

/** End index (inclusive) of the balanced container opening at `start`, or -1. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

export function extractJson<T = unknown>(text: string | null | undefined, kind: Kind = 'any'): T | null {
  if (!text) return null;
  const trimmed = text.trim();

  const whole = /^[[{]/.test(trimmed) ? tryParseRepaired(trimmed) : tryParse(trimmed);
  if (whole.ok && matchesKind(whole.value, kind)) return whole.value as T;

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    const parsed = tryParseRepaired(match[1].trim());
    if (parsed.ok && matchesKind(parsed.value, kind)) return parsed.value as T;
  }

  let best: { value: unknown; length: number } | null = null;
  let attempts = 0;
  for (let i = 0; i < text.length && attempts < 400; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    if (kind === 'object' && ch !== '{') continue;
    if (kind === 'array' && ch !== '[') continue;
    attempts++;
    const end = balancedEnd(text, i);
    if (end === -1) continue;
    const parsed = tryParseRepaired(text.slice(i, end + 1));
    if (parsed.ok && matchesKind(parsed.value, kind)) {
      const length = end + 1 - i;
      if (!best || length > best.length) best = { value: parsed.value, length };
      i = end; // skip past this span; nested candidates are smaller
    }
  }
  return best ? (best.value as T) : null;
}

export function extractJsonObject<T = Record<string, unknown>>(text: string | null | undefined): T | null {
  return extractJson<T>(text, 'object');
}

export function extractJsonArray<T = unknown>(text: string | null | undefined): T[] | null {
  return extractJson<T[]>(text, 'array');
}

// =============================================================================
// Coercion helpers for model output (models return loosely typed JSON)
// =============================================================================

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item : item === null || item === undefined ? '' : typeof item === 'object' ? JSON.stringify(item) : String(item)))
    .filter((item) => item.trim().length > 0);
}

export function asNumber(value: unknown, fallback: number | null = null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[%,$\s]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asInt(value: unknown, fallback: number | null = null): number | null {
  const n = asNumber(value, null);
  return n === null ? fallback : Math.round(n);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
