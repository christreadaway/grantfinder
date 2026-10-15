/**
 * PDF text extraction (uploaded documents and PDF grant guidelines).
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  // Loaded on first use: pdf.js is large, and most requests never read a PDF.
  const { extractText, getDocumentProxy } = await import('unpdf');
  // pdf.js takes ownership of the buffer it is given, so hand it a copy.
  // verbosity 0 keeps pdf.js warnings ("Indexing all PDF objects") out of the logs.
  const pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const { text } = await extractText(pdf, { mergePages: true });
  return (text || '').replace(/[ \t]+\n/g, '\n').trim();
}
