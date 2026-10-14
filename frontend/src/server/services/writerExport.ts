/**
 * GrantWriter export builders: a port of backend/services/writer_export.py (PRD 4.8).
 *
 * Formats: Word (.docx), Markdown, plain text with per-field word/char counts
 * (for portal paste-in), and a JSON form-field map. PDF is intentionally not
 * generated; Word and Markdown print cleanly to PDF.
 *
 * Hard rule enforced by the caller (routes/writer.ts): nothing over a
 * section's word/char limit, and nothing with a banned phrase, is exported.
 *
 * Only the web route imports this module: it pulls in the `docx` package,
 * which the background worker must not bundle (see jobHandlers.ts).
 */
import { Document, HeadingLevel, Packer, PageBreak, Paragraph, TextRun } from 'docx';

import { todayIso } from '../deadlines';
import type { Application, GrantSpec, RequiredSection, SectionDraft, WriterExportFormat } from '../types';

export const EXPORT_FORMATS: WriterExportFormat[] = ['docx', 'md', 'txt', 'form_map'];

export interface ExportFile {
  body: Uint8Array | string;
  filename: string;
  contentType: string;
}

/** Order drafts to match the grant spec's section order (unknown sections last). */
function ordered(drafts: SectionDraft[], spec: GrantSpec): SectionDraft[] {
  const order = new Map(spec.required_sections.map((section, index) => [section.id, index]));
  return [...drafts].sort((a, b) => (order.get(a.section_id) ?? 999) - (order.get(b.section_id) ?? 999));
}

function submissionChecklist(spec: GrantSpec): string[] {
  return [...spec.format_constraints.map((c) => `Format: ${c}`), ...spec.deliverables.map((d) => `Deliverable: ${d}`)];
}

function sectionsById(spec: GrantSpec): Map<string, RequiredSection> {
  return new Map(spec.required_sections.map((section) => [section.id, section]));
}

export function buildMarkdown(app: Application, spec: GrantSpec, drafts: SectionDraft[], exportedOn = todayIso()): string {
  const lines = [
    `# ${app.grant_name}`,
    `**Funder:** ${app.funder}  `,
    `**Deadline:** ${app.deadline || 'Check guidelines'}  `,
    `**Exported:** ${exportedOn}`,
    '',
  ];
  for (const d of ordered(drafts, spec)) {
    lines.push(`## ${d.title}`, '', d.current_draft, '');
  }
  const checklist = submissionChecklist(spec);
  if (checklist.length) {
    lines.push('---', '## Submission Checklist', ...checklist.map((item) => `- [ ] ${item}`));
  }
  return lines.join('\n');
}

/** Portal paste-in format: each field labeled with its counts. */
export function buildPlainText(app: Application, spec: GrantSpec, drafts: SectionDraft[]): string {
  const blocks = [`${app.grant_name} - ${app.funder}`, `Deadline: ${app.deadline || 'Check guidelines'}`, '='.repeat(60)];
  const limits = sectionsById(spec);
  for (const d of ordered(drafts, spec)) {
    const section = limits.get(d.section_id);
    const limitBits: string[] = [];
    if (section?.word_limit) limitBits.push(`limit ${section.word_limit} words`);
    if (section?.char_limit) limitBits.push(`limit ${section.char_limit} chars`);
    const limitNote = limitBits.length ? ` (${limitBits.join('; ')})` : '';
    blocks.push('', `FIELD: ${d.title}${limitNote}`, `[${d.word_count} words / ${d.char_count} characters]`, '-'.repeat(60), d.current_draft);
  }
  return blocks.join('\n');
}

/** Field-by-field JSON map for form-based portals (transcribe now, auto-populate later). */
export function buildFormMap(app: Application, spec: GrantSpec, drafts: SectionDraft[]): string {
  const limits = sectionsById(spec);
  const fields = ordered(drafts, spec).map((d) => {
    const section = limits.get(d.section_id);
    return {
      field: d.title,
      prompt: section ? section.prompt : '',
      word_limit: section ? section.word_limit ?? null : null,
      char_limit: section ? section.char_limit ?? null : null,
      word_count: d.word_count,
      char_count: d.char_count,
      content: d.current_draft,
    };
  });
  return JSON.stringify(
    {
      grant: app.grant_name,
      funder: app.funder,
      deadline: app.deadline ?? null,
      exported_at: new Date().toISOString(),
      fields,
      submission_checklist: submissionChecklist(spec),
    },
    null,
    2,
  );
}

/** One paragraph's runs; single newlines become line breaks, as python-docx's run.text does. */
function bodyRuns(text: string): TextRun[] {
  return text.split('\n').map((line, index) => new TextRun({ text: line, size: 22, break: index > 0 ? 1 : undefined }));
}

/** Clean, formatted Word document ready to attach (mirrors the python-docx layout). */
export async function buildDocx(app: Application, spec: GrantSpec, drafts: SectionDraft[]): Promise<Uint8Array> {
  const children: Paragraph[] = [
    new Paragraph({ text: app.grant_name, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({ text: `Funder: ${app.funder}    Deadline: ${app.deadline || 'Check guidelines'}`, italics: true })],
    }),
  ];
  for (const d of ordered(drafts, spec)) {
    children.push(new Paragraph({ text: d.title, heading: HeadingLevel.HEADING_1 }));
    for (const para of d.current_draft.split('\n\n')) {
      if (para.trim()) children.push(new Paragraph({ children: bodyRuns(para.trim()) }));
    }
  }
  const checklist = submissionChecklist(spec);
  if (checklist.length) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({ text: 'Submission Checklist', heading: HeadingLevel.HEADING_1 }));
    for (const item of checklist) children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
  }
  const doc = new Document({
    creator: 'GrantFinder',
    title: app.grant_name,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return new Uint8Array(await Packer.toBuffer(doc));
}

/** The Python's safe_name: letters, digits, "-", "_" and spaces (first 50), spaces as underscores. */
export function safeFileStem(grantName: string): string {
  return Array.from(grantName)
    .filter((ch) => /[\p{L}\p{N}_\- ]/u.test(ch))
    .slice(0, 50)
    .join('')
    .trim()
    .replace(/ /g, '_');
}

/** The file for one export format: body, download name, and content type. */
export async function buildExport(format: WriterExportFormat, app: Application, spec: GrantSpec, drafts: SectionDraft[]): Promise<ExportFile> {
  const stem = safeFileStem(app.grant_name);
  const today = todayIso();
  const stamp = today.replace(/-/g, '');
  if (format === 'docx') {
    return {
      body: await buildDocx(app, spec, drafts),
      filename: `${stem}_application_${stamp}.docx`,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
  }
  if (format === 'md') {
    return { body: buildMarkdown(app, spec, drafts, today), filename: `${stem}_application_${stamp}.md`, contentType: 'text/markdown; charset=utf-8' };
  }
  if (format === 'txt') {
    return { body: buildPlainText(app, spec, drafts), filename: `${stem}_application_${stamp}.txt`, contentType: 'text/plain; charset=utf-8' };
  }
  return { body: buildFormMap(app, spec, drafts), filename: `${stem}_form_map_${stamp}.json`, contentType: 'application/json' };
}
