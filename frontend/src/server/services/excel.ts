/**
 * Excel grant database parser: the 5-category workbook (spec v2.6).
 * Port of backend/services/excel_parser.py, using exceljs.
 *
 * Sheets are matched to categories by name ("Church/Parish Grants",
 * "Category 2", "Catholic Foundations"...). Row 1 holds the column names, which
 * are matched flexibly (the Python names plus the ones in
 * docs/grant-template-format.md). Category 5 rows become foundations.
 *
 * Route-side only: the background job function must never import exceljs.
 */
import crypto from 'node:crypto';

import { Workbook, type Cell, type CellValue, type Row, type Worksheet } from 'exceljs';

import { HttpError } from '../errors';
import { assertZipWithinLimits } from '../zipguard';
import { logger } from '../log';
import {
  GRANT_CATEGORIES,
  type Foundation,
  type FoundationBase,
  type GeoQualified,
  type Grant,
  type GrantBase,
  type GrantCategory,
  type GrantStatus,
} from '../types';
import { cleanUrl, dedupKey, newFoundationId, newGrantId, tagList } from './discovery';

/** Bigger than any real grant list; keeps one upload from producing a giant record. */
export const MAX_UPLOAD_ROWS = 5000;

// =============================================================================
// Sheets and columns
// =============================================================================

/** Sheet-name patterns (case-insensitive substring), as in the Python. */
const CATEGORY_SHEETS: Array<[string, GrantCategory]> = [
  ['Church/Parish Grants', 'church_parish'],
  ['Category 1', 'church_parish'],
  ['Parish Grants', 'church_parish'],
  ['Catholic School Grants', 'catholic_school'],
  ['Category 2', 'catholic_school'],
  ['School Grants', 'catholic_school'],
  ['Mixed Church-School', 'mixed'],
  ['Category 3', 'mixed'],
  ['Mixed', 'mixed'],
  ['Non-Catholic Qualifying', 'non_catholic'],
  ['Category 4', 'non_catholic'],
  ['Non-Catholic', 'non_catholic'],
  ['Secular Grants', 'non_catholic'],
  ['Catholic Foundations', 'foundations'],
  ['Category 5', 'foundations'],
  ['Foundations', 'foundations'],
];

/** Excel does not allow "/" in sheet names, so the message never suggests "Church/Parish Grants". */
export const EXPECTED_SHEET_NAMES =
  '"Parish Grants", "Catholic School Grants", "Mixed Church-School", "Non-Catholic Qualifying" and "Catholic Foundations" (or "Category 1" to "Category 5")';

/** Lowercase, with "/", "-" and "_" read as spaces: "Church-Parish Grants" matches "Church/Parish Grants". */
function sheetKey(name: string): string {
  return name.toLowerCase().replace(/[/_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The category a sheet holds, or null. The longest matching pattern wins, so
 * "Mixed Church-School Grants" is mixed (the Python's first match made it a
 * school sheet because "School Grants" was checked first).
 */
export function sheetCategory(sheetName: string): GrantCategory | null {
  const name = sheetKey(sheetName);
  let best: { length: number; category: GrantCategory } | null = null;
  for (const [pattern, category] of CATEGORY_SHEETS) {
    const key = sheetKey(pattern);
    if (name.includes(key) && (!best || key.length > best.length)) {
      best = { length: key.length, category };
    }
  }
  return best ? best.category : null;
}

/** Column name -> field. The Python map, plus the names docs/grant-template-format.md promises. */
const COLUMN_MAP: Record<string, string> = {
  // Grant columns (Python)
  'grant name': 'grant_name',
  grant_name: 'grant_name',
  name: 'grant_name',
  deadline: 'deadline',
  'due date': 'deadline',
  due_date: 'deadline',
  amount: 'amount',
  'grant amount': 'amount',
  award: 'amount',
  funder: 'funder',
  'funding org': 'funder',
  organization: 'funder',
  description: 'description',
  desc: 'description',
  details: 'description',
  contact: 'contact',
  'contact info': 'contact',
  email: 'contact',
  url: 'url',
  link: 'url',
  website: 'url',
  'application url': 'url',
  status: 'status',
  'grant status': 'status',
  'geo qualified': 'geo_qualified',
  geo_qualified: 'geo_qualified',
  geographic: 'geo_qualified',
  geography: 'geo_qualified',
  'funder stats': 'funder_stats',
  funder_stats: 'funder_stats',
  stats: 'funder_stats',

  // Grant columns from docs/grant-template-format.md
  grant: 'grant_name',
  title: 'grant_name',
  'grant title': 'grant_name',
  'granting authority': 'funder',
  'funding organization': 'funder',
  grantor: 'funder',
  'application deadline': 'deadline',
  'amount min': 'amount_min',
  'min amount': 'amount_min',
  minimum: 'amount_min',
  'minimum amount': 'amount_min',
  'amount max': 'amount_max',
  'max amount': 'amount_max',
  maximum: 'amount_max',
  'maximum amount': 'amount_max',
  'up to': 'amount_max',
  eligibility: 'eligibility_notes',
  'eligibility notes': 'eligibility_notes',
  eligibility_notes: 'eligibility_notes',
  'eligibility requirements': 'eligibility_notes',
  requirements: 'eligibility_notes',
  'apply url': 'url',
  'apply link': 'url',
  'application link': 'url',
  'geographic restriction': 'geo_restriction',
  'geographic restrictions': 'geo_restriction',
  'geo restriction': 'geo_restriction',
  categories: 'funds_for',
  tags: 'funds_for',
  'funds for': 'funds_for',
  funds_for: 'funds_for',

  // Foundation columns (Python)
  'foundation name': 'foundation_name',
  foundation_name: 'foundation_name',
  'application cycle': 'application_cycle',
  application_cycle: 'application_cycle',
  cycle: 'application_cycle',
  'focus areas': 'focus_areas',
  focus_areas: 'focus_areas',
  focus: 'focus_areas',
  location: 'location',
  city: 'location',
  'annual giving': 'annual_giving',
  annual_giving: 'annual_giving',
  giving: 'annual_giving',
  notes: 'notes',
};

/** Normalize a header for matching (lowercase, trimmed; unknown names get underscores). */
export function normalizeColumnName(name: string): string {
  const normalized = name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s*:]+$/, '')
    .toLowerCase();
  if (!normalized) return '';
  return COLUMN_MAP[normalized] ?? normalized.replace(/ /g, '_');
}

// =============================================================================
// Cell values
// =============================================================================

type Primitive = string | number | boolean | Date | null;

interface CellData {
  value: Primitive;
  /** Link target of a hyperlink cell (preferred for URL columns). */
  hyperlink: string | null;
}

function richTextOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && Array.isArray((value as { richText?: unknown }).richText)) {
    return ((value as { richText: Array<{ text?: unknown }> }).richText)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('');
  }
  return null;
}

/** A cell's value like openpyxl's data_only=True: cached formula results, plain text for rich text. */
function primitiveOf(value: CellValue): Primitive {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if ('richText' in value) return richTextOf(value);
    if ('hyperlink' in value) return richTextOf((value as { text?: unknown }).text) ?? (value.hyperlink || null);
    if ('error' in value) return null;
    if ('result' in value) return primitiveOf(value.result as CellValue);
  }
  return null;
}

function cellData(cell: Cell): CellData {
  // openpyxl reports merged cells' value only on the top-left cell.
  if (cell.isMerged && cell.master && cell.master.address !== cell.address) return { value: null, hyperlink: null };
  const value = cell.value;
  const hyperlink =
    value && typeof value === 'object' && !(value instanceof Date) && 'hyperlink' in value && typeof value.hyperlink === 'string'
      ? value.hyperlink
      : null;
  return { value: primitiveOf(value), hyperlink };
}

/** YYYY-MM-DD for a date cell (the Python wrote "2026-05-01 00:00:00", which no deadline check could read). */
function formatDate(date: Date): string {
  if (Number.isNaN(date.getTime())) return '';
  const iso = date.toISOString();
  return iso.slice(11, 19) === '00:00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function textOfPrimitive(value: Primitive): string {
  if (value === null) return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return value.replace(/\u00a0/g, ' ').trim();
}

function isBlank(value: Primitive): boolean {
  // Python: `if not any(row)` skips rows whose cells are all None, "", 0 or False.
  return value === null || value === '' || value === 0 || value === false;
}

const MONEY_TEXT = /^\$?\s*\d{1,3}(,\d{3})*(\.\d+)?$|^\$?\s*\d+(\.\d+)?$/;

/** 15000 or "15000" -> "$15,000"; other text stays as typed. */
function moneyText(value: Primitive): string {
  const text = textOfPrimitive(value);
  if (!text) return '';
  const numeric = typeof value === 'number' ? value : MONEY_TEXT.test(text) ? Number(text.replace(/[$,\s]/g, '')) : Number.NaN;
  if (!Number.isFinite(numeric)) return text;
  const digits = Number.isInteger(numeric) ? 0 : 2;
  return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

// =============================================================================
// Field parsers (the Python's excel variants)
// =============================================================================

export function parseUploadStatus(value: string): GrantStatus {
  const upper = value.toUpperCase().trim();
  if (upper.includes('OPEN')) return 'OPEN';
  if (upper.includes('ROLL')) return 'Rolling';
  if (upper.includes('CLOSE')) return 'CLOSED';
  return 'Check deadline';
}

export function parseUploadGeo(value: string): GeoQualified {
  const upper = value.toUpperCase().trim();
  if (upper.includes('TX') || upper.includes('TEXAS')) return 'Yes - TX Only';
  if (['YES', 'Y', 'TRUE', '1'].includes(upper)) return 'Yes';
  if (['NO', 'N', 'FALSE', '0'].includes(upper)) return 'No';
  return 'Check eligibility';
}

/** "Texas" -> TX only; "Nationwide"/"None" -> Yes; another state or region -> check. */
export function geoFromRestriction(value: string): GeoQualified {
  const text = value.trim();
  const upper = text.toUpperCase();
  if (upper.includes('TX') || upper.includes('TEXAS')) return 'Yes - TX Only';
  if (/^(nationwide|national|none|no restrictions?|all states|any state|all 50 states|united states|usa|us|u\.s\.(a\.)?|n\/a)\b/i.test(text)) {
    return 'Yes';
  }
  return 'Check eligibility';
}

// =============================================================================
// Rows
// =============================================================================

type RowData = Map<string, CellData>;

function field(row: RowData, key: string): string {
  const cell = row.get(key);
  return cell ? textOfPrimitive(cell.value) : '';
}

function urlField(row: RowData, key: string): string {
  const cell = row.get(key);
  if (!cell) return '';
  return cleanUrl(cell.hyperlink) || cleanUrl(textOfPrimitive(cell.value));
}

export interface UploadedGrant {
  grant: Grant;
  /** Fields the row actually filled in (the rest are defaults). */
  provided: Array<keyof GrantBase>;
}

export interface UploadedFoundation {
  foundation: Foundation;
  provided: Array<keyof FoundationBase>;
}

function parseGrantRow(row: RowData, userId: string, category: GrantCategory): UploadedGrant | null {
  const grantName = field(row, 'grant_name');
  if (!grantName) return null;
  const provided = new Set<keyof GrantBase>(['grant_name', 'category']);
  const take = (key: keyof GrantBase, value: string, fallback: string): string => {
    if (value) provided.add(key);
    return value || fallback;
  };

  let amount = moneyText(row.get('amount')?.value ?? null);
  if (!amount) {
    const min = moneyText(row.get('amount_min')?.value ?? null);
    const max = moneyText(row.get('amount_max')?.value ?? null);
    amount = min && max ? `${min} - ${max}` : max ? `Up to ${max}` : min ? `From ${min}` : '';
  }

  const statusText = field(row, 'status');
  const geoText = field(row, 'geo_qualified');
  const restriction = field(row, 'geo_restriction');
  const eligibility = field(row, 'eligibility_notes');
  const notes = field(row, 'notes');
  const eligibilityNotes = [eligibility, notes ? `Notes: ${notes}` : ''].filter(Boolean).join(' ');
  const fundsFor = tagList(field(row, 'funds_for'));
  const funderStats = field(row, 'funder_stats');

  if (statusText) provided.add('status');
  if (geoText || restriction) provided.add('geo_qualified');
  if (eligibilityNotes) provided.add('eligibility_notes');
  if (fundsFor.length) provided.add('funds_for');
  if (funderStats) provided.add('funder_stats');

  const grant: Grant = {
    grant_name: grantName,
    deadline: take('deadline', field(row, 'deadline'), 'Check website'),
    amount: take('amount', amount, 'Varies'),
    funder: take('funder', field(row, 'funder'), 'Unknown'),
    description: take('description', field(row, 'description'), ''),
    contact: take('contact', field(row, 'contact'), 'See website'),
    url: take('url', urlField(row, 'url'), ''),
    status: statusText ? parseUploadStatus(statusText) : 'Check deadline',
    geo_qualified: geoText ? parseUploadGeo(geoText) : restriction ? geoFromRestriction(restriction) : 'Check eligibility',
    funder_stats: funderStats || null,
    category,
    source: 'upload',
    eligibility_notes: eligibilityNotes || null,
    funds_for: fundsFor,
    id: newGrantId(),
    user_id: userId,
    created_at: new Date().toISOString(),
  };
  return { grant, provided: Array.from(provided) };
}

function parseFoundationRow(row: RowData, userId: string): UploadedFoundation | null {
  // A plain "Name" column maps to grant_name; accept it here too (the Python skipped every row).
  const name = field(row, 'foundation_name') || field(row, 'grant_name');
  if (!name) return null;
  const provided = new Set<keyof FoundationBase>(['foundation_name']);
  const take = (key: keyof FoundationBase, value: string, fallback: string): string => {
    if (value) provided.add(key);
    return value || fallback;
  };
  const notes = field(row, 'notes');
  if (notes) provided.add('notes');
  const foundation: Foundation = {
    foundation_name: name,
    application_cycle: take('application_cycle', field(row, 'application_cycle'), 'Check website'),
    focus_areas: take('focus_areas', field(row, 'focus_areas'), ''),
    location: take('location', field(row, 'location'), ''),
    contact: take('contact', field(row, 'contact'), 'See website'),
    website: take('website', urlField(row, 'website') || urlField(row, 'url'), ''),
    annual_giving: take('annual_giving', field(row, 'annual_giving'), ''),
    notes: notes || null,
    id: newFoundationId(),
    user_id: userId,
    created_at: new Date().toISOString(),
  };
  return { foundation, provided: Array.from(provided) };
}

// =============================================================================
// Workbook
// =============================================================================

export interface ParsedSheet {
  name: string;
  category: GrantCategory | null;
  rows: number;
}

export interface ParsedWorkbook {
  grants: UploadedGrant[];
  foundations: UploadedFoundation[];
  /** Uploaded grants per category (all five keys, like the Python). */
  categoryCounts: Record<string, number>;
  uploadId: string;
  sheets: ParsedSheet[];
  skippedSheets: string[];
}

/**
 * Row 1, normalized. Trailing unnamed columns are dropped: their values were
 * never used, and a sheet formatted out to column XFD would otherwise make
 * every row read 16,384 cells.
 */
function headerNames(sheet: Worksheet): string[] {
  const row = sheet.getRow(1);
  const width = Math.min(Math.max(sheet.columnCount, row.cellCount), 16384);
  const headers: string[] = [];
  for (let col = 1; col <= width; col++) {
    headers.push(normalizeColumnName(textOfPrimitive(cellData(row.getCell(col)).value)));
  }
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  return headers;
}

function rowData(row: Row, headers: string[]): RowData | null {
  const cells = headers.map((_, index) => cellData(row.getCell(index + 1)));
  if (cells.every((cell) => isBlank(cell.value))) return null;
  const data: RowData = new Map();
  cells.forEach((cell, index) => {
    const key = headers[index];
    if (!key) return;
    // With two columns for the same field ("Website" and "Link"), the first filled one wins.
    const existing = data.get(key);
    if (!existing || (isBlank(existing.value) && !isBlank(cell.value))) data.set(key, cell);
  });
  return data;
}

/** True for the old binary Excel format (.xls), which starts with the OLE2 signature. */
export function looksLikeXls(content: Uint8Array): boolean {
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return content.length >= 8 && ole.every((byte, index) => content[index] === byte);
}

export const XLS_MESSAGE =
  'This is an older Excel file (.xls). Save the file as .xlsx (Excel Workbook) and upload again: in Excel choose File > Save As > Excel Workbook (.xlsx).';

/**
 * Parse an uploaded workbook. Throws HttpError 400 with a plain-English fix
 * when the file can't be read or holds no grants.
 */
export async function parseGrantWorkbook(content: Uint8Array, userId: string): Promise<ParsedWorkbook> {
  if (looksLikeXls(content)) throw new HttpError(400, XLS_MESSAGE);
  // A 4 MB workbook built to inflate to gigabytes would exhaust memory inside exceljs.
  assertZipWithinLimits(content);

  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(content.buffer, content.byteOffset, content.byteLength) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (error) {
    const message = (error as Error).message || String(error);
    logger.warn('excel_unreadable', { user_id: userId, bytes: content.byteLength, error: message });
    throw new HttpError(
      400,
      `Failed to parse Excel file: it isn't a readable .xlsx workbook (${message.slice(0, 120)}). ` +
        'Open it in Excel, choose File > Save As > Excel Workbook (.xlsx), and upload again.',
    );
  }

  const uploadId = crypto.randomUUID();
  const grants: UploadedGrant[] = [];
  const foundations: UploadedFoundation[] = [];
  const categoryCounts: Record<string, number> = Object.fromEntries(GRANT_CATEGORIES.map((category) => [category, 0]));
  const sheets: ParsedSheet[] = [];
  const skippedSheets: string[] = [];
  const problems: string[] = [];

  try {
    const names = workbook.worksheets.map((sheet) => sheet.name);
    logger.info('excel_workbook_sheets', { user_id: userId, sheets: names });

    for (const sheet of workbook.worksheets) {
      const category = sheetCategory(sheet.name);
      if (category === null) {
        logger.warn('excel_sheet_skipped', { user_id: userId, sheet: sheet.name, reason: 'unknown category' });
        skippedSheets.push(sheet.name);
        sheets.push({ name: sheet.name, category: null, rows: 0 });
        continue;
      }
      const headers = headerNames(sheet);
      logger.info('excel_sheet_headers', { user_id: userId, sheet: sheet.name, category, headers });
      const nameKey = category === 'foundations' ? ['foundation_name', 'grant_name'] : ['grant_name'];
      if (!headers.some((header) => nameKey.includes(header))) {
        problems.push(
          `Sheet "${sheet.name}" has no "${category === 'foundations' ? 'Foundation Name' : 'Grant Name'}" column in row 1.`,
        );
      }

      let rows = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;
        const data = rowData(row, headers);
        if (!data) return;
        if (grants.length + foundations.length >= MAX_UPLOAD_ROWS) {
          throw new HttpError(
            400,
            `This workbook has more than ${MAX_UPLOAD_ROWS.toLocaleString('en-US')} rows. Split it into smaller files and upload them one at a time.`,
          );
        }
        if (category === 'foundations') {
          const foundation = parseFoundationRow(data, userId);
          if (foundation) {
            foundations.push(foundation);
            rows += 1;
          }
        } else {
          const grant = parseGrantRow(data, userId, category);
          if (grant) {
            grants.push(grant);
            categoryCounts[category] += 1;
            rows += 1;
          }
        }
      });
      sheets.push({ name: sheet.name, category, rows });
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error('excel_parse_failed', { user_id: userId, error });
    throw new HttpError(400, `Failed to parse Excel file: ${(error as Error).message || String(error)}`);
  }

  logger.info('excel_parsed', {
    user_id: userId,
    grants: grants.length,
    foundations: foundations.length,
    sheets: sheets.length,
    skipped_sheets: skippedSheets,
  });

  if (grants.length + foundations.length === 0) {
    if (sheets.every((sheet) => sheet.category === null)) {
      const found = skippedSheets.map((name) => `"${name}"`).join(', ') || 'none';
      throw new HttpError(
        400,
        `No grant sheets found in this workbook (its sheets: ${found}). Rename each sheet after its category: ${EXPECTED_SHEET_NAMES}, then upload again.`,
      );
    }
    throw new HttpError(
      400,
      'No grants found in this workbook. Put the column names in row 1 of each sheet (at least "Grant Name"; "Foundation Name" on the foundations sheet) and one grant per row below them. ' +
        problems.join(' '),
    );
  }

  return { grants, foundations, categoryCounts, uploadId, sheets, skippedSheets };
}

// =============================================================================
// Merging an upload into the saved database
// =============================================================================

/**
 * Upsert uploaded grants: a row whose name+funder matches a saved grant
 * updates the fields the row filled in (the grant keeps its id, so writer
 * applications that point at it keep working); other rows are added.
 * Nothing already in the database is removed.
 */
export function upsertGrants(current: Grant[], uploaded: UploadedGrant[]): { merged: Grant[]; added: number; updated: number } {
  const merged = [...current];
  const index = new Map<string, number>();
  merged.forEach((grant, position) => {
    const key = dedupKey(grant.grant_name, grant.funder);
    if (!index.has(key)) index.set(key, position);
  });
  const updated = new Set<number>();
  let added = 0;
  for (const item of uploaded) {
    const key = dedupKey(item.grant.grant_name, item.grant.funder);
    const position = index.get(key);
    if (position === undefined) {
      merged.push(item.grant);
      index.set(key, merged.length - 1);
      added += 1;
      continue;
    }
    const patch: Partial<Grant> = {};
    for (const name of item.provided) (patch as Record<string, unknown>)[name] = item.grant[name];
    merged[position] = { ...merged[position], ...patch };
    if (position < current.length) updated.add(position);
  }
  return { merged, added, updated: updated.size };
}

/** Same for foundations, matched by name (case-insensitive). */
export function upsertFoundations(
  current: Foundation[],
  uploaded: UploadedFoundation[],
): { merged: Foundation[]; added: number; updated: number } {
  const merged = [...current];
  const index = new Map<string, number>();
  merged.forEach((foundation, position) => {
    const key = foundation.foundation_name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, position);
  });
  const updated = new Set<number>();
  let added = 0;
  for (const item of uploaded) {
    const key = item.foundation.foundation_name.trim().toLowerCase();
    const position = index.get(key);
    if (position === undefined) {
      merged.push(item.foundation);
      index.set(key, merged.length - 1);
      added += 1;
      continue;
    }
    const patch: Partial<Foundation> = {};
    for (const name of item.provided) (patch as Record<string, unknown>)[name] = item.foundation[name];
    merged[position] = { ...merged[position], ...patch };
    if (position < current.length) updated.add(position);
  }
  return { merged, added, updated: updated.size };
}
