/**
 * PDF text extraction (uploaded documents and PDF grant guidelines).
 */
import { extractText, getDocumentProxy } from 'unpdf';

export async function extractPdfText(data: Uint8Array): Promise<string> {
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: true });
  return (text || '').replace(/[ \t]+\n/g, '\n').trim();
}
