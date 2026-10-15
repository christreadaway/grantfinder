/**
 * Test files for the end-to-end run: a real PDF, a real Word document, and a
 * zip reader for checking exported .docx files. No extra installs: the Word
 * and zip libraries come from frontend/node_modules (the app already uses them).
 */
const path = require('path');

const FRONTEND = path.resolve(__dirname, '..', '..', '..', 'frontend');
const fromFrontend = (name) => require(require.resolve(name, { paths: [FRONTEND] }));

/** PDF string literal escaping: backslash and parentheses. */
function pdfEscape(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * A minimal, valid one-page PDF (Helvetica text, correct xref offsets) that
 * pdf.js / unpdf and pdftotext can read.
 */
function makePdf(lines, title = 'GrantFinder test document') {
  const content = [
    'BT',
    '/F1 12 Tf',
    '14 TL',
    '72 740 Td',
    ...lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${pdfEscape(line)}) Tj`),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Title (${pdfEscape(title)}) /Producer (GrantFinder e2e) >>`,
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A real .docx built with the same `docx` library the app uses for exports. */
async function makeDocx(title, paragraphs) {
  const { Document, Packer, Paragraph, HeadingLevel } = fromFrontend('docx');
  const doc = new Document({
    creator: 'GrantFinder e2e',
    title,
    sections: [{
      children: [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
        ...paragraphs.map((text) => new Paragraph({ text })),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

/**
 * A grant database workbook in the documented 5-category format, built with
 * the same exceljs the app parses it with. sheets: {"Sheet name": [{column: value}]}.
 */
async function makeXlsx(sheets) {
  const ExcelJS = fromFrontend('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(name);
    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
    sheet.addRow(columns);
    for (const row of rows) sheet.addRow(columns.map((column) => (row[column] === undefined ? null : row[column])));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Read one file out of a zip (e.g. word/document.xml from a .docx). Null when absent or not a zip. */
async function readZipEntry(buffer, entryName) {
  const JSZip = fromFrontend('jszip');
  try {
    const zip = await JSZip.loadAsync(buffer);
    const entry = zip.file(entryName);
    return entry ? entry.async('string') : null;
  } catch {
    return null;
  }
}

/** Visible text of a WordprocessingML document.xml (joins <w:t> runs). */
function wordXmlText(xml) {
  return (String(xml || '').match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || [])
    .map((run) => run.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

module.exports = { FRONTEND, makePdf, makeDocx, makeXlsx, readZipEntry, wordXmlText };
