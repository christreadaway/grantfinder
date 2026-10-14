/**
 * Text extraction for uploaded documents (PDF, Word .docx, plain text).
 * Port of backend/services/document_processor.py.
 *
 * Runs inside the upload route, before any background job starts, so an
 * unreadable or empty document is reported at once with a clear 400.
 * Imports mammoth, so background job handlers must never import this file.
 */
import mammoth from 'mammoth';

import { ALLOWED_DOCUMENT_EXTENSIONS } from '../config';
import { HttpError } from '../errors';
import { assertZipWithinLimits } from '../zipguard';
import { logger } from '../log';
import { extractPdfText } from '../pdf';

/** Same wording as the Python router. */
export const INVALID_DOCUMENT_TYPE = `Invalid file type. Allowed: ${ALLOWED_DOCUMENT_EXTENSIONS.join(', ')}`;

/** ".pdf"-style extension, computed exactly like the Python: '.' + filename.split('.')[-1].lower() */
export function documentExtension(filename: string): string {
  const parts = filename.split('.');
  return `.${parts[parts.length - 1].toLowerCase()}`;
}

export function isAllowedDocument(filename: string): boolean {
  return ALLOWED_DOCUMENT_EXTENSIONS.includes(documentExtension(filename));
}

function shortReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0].slice(0, 160);
}

async function pdfText(content: Uint8Array, filename: string): Promise<string> {
  try {
    return await extractPdfText(content);
  } catch (error) {
    logger.warn('document_pdf_unreadable', { filename, error: shortReason(error) });
    if (/password/i.test(shortReason(error))) {
      throw new HttpError(
        400,
        `"${filename}" is password-protected, so its text can't be read. Open it, save or print it as a new PDF without a password, and upload that copy.`,
      );
    }
    throw new HttpError(
      400,
      `Couldn't read "${filename}" as a PDF (${shortReason(error)}). The file may be damaged. Try saving it again as a PDF, or upload a Word (.docx) or text (.txt) version.`,
    );
  }
}

async function docxText(content: Uint8Array, filename: string): Promise<string> {
  // A small .docx built to inflate to gigabytes would exhaust memory inside mammoth.
  assertZipWithinLimits(content);
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(content) });
    return result.value;
  } catch (error) {
    logger.warn('document_docx_unreadable', { filename, error: shortReason(error) });
    throw new HttpError(
      400,
      `Couldn't open "${filename}" as a Word document. Make sure it is a real .docx file (an older .doc file must be re-saved as .docx in Word), or upload a PDF or .txt version.`,
    );
  }
}

/**
 * Decode a text file. The Python tried utf-8, then utf-16 (which "succeeds"
 * on almost any even-length file and produced garbage for Windows text), then
 * latin-1. Here: byte-order marks first, then strict UTF-8, then Windows-1252.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes);
    } catch {
      // Runtime without UTF-16BE support: fall through to the other encodings.
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/**
 * Extract the readable text of an uploaded document, or throw a 400 that
 * tells the person what to do instead.
 */
export async function extractDocumentText(content: Uint8Array, filename: string): Promise<string> {
  const ext = documentExtension(filename);
  let text: string;
  if (ext === '.pdf') text = await pdfText(content, filename);
  else if (ext === '.docx') text = await docxText(content, filename);
  else if (ext === '.txt') text = decodeText(content);
  else throw new HttpError(400, INVALID_DOCUMENT_TYPE);

  // Windows line endings and stray NUL characters confuse nothing useful downstream.
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
  if (!text) {
    const hint = ext === '.pdf'
      ? ' It looks like a scanned image without a text layer. Upload a Word (.docx) or text (.txt) version, or run it through text recognition first (for example, open it with Google Docs in Google Drive and download that).'
      : ' Check that you picked the right file.';
    throw new HttpError(400, `No readable text found in "${filename}".${hint}`);
  }
  logger.info('document_text_extracted', { filename, ext, bytes: content.byteLength, chars: text.length });
  return text;
}
