/**
 * Zip-bomb guard for .docx and .xlsx uploads (both are zip archives).
 *
 * exceljs and mammoth unzip everything into memory before any of our own
 * limits apply, so a 4 MB file built to inflate to gigabytes would exhaust
 * the function's memory. This walks the archive's central directory and
 * actually inflates each entry with a hard output cap, before the real
 * parser ever sees the file.
 */
import zlib from 'node:zlib';

import { HttpError } from './errors';

const MAX_ENTRIES = 5000;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

function tooBig(): HttpError {
  return new HttpError(
    400,
    'This file expands to more than 120 MB when opened, which is too large to read. Save a smaller copy (fewer images or sheets) and upload it again.',
  );
}

/**
 * Throws a 400 HttpError when the archive inflates beyond the cap. A file that
 * isn't a well-formed zip is left alone: the real parser rejects it with its
 * own, more specific message (and can't unzip it either).
 */
export function assertZipWithinLimits(data: Uint8Array): void {
  try {
    checkArchive(data);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Not a readable zip; the parser will say so.
  }
}

class NotAZip extends Error {}

function damaged(): NotAZip {
  return new NotAZip('not a well-formed zip');
}

function checkArchive(data: Uint8Array): void {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // End of central directory: signature 0x06054b50, within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw damaged();
  const entries = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES || entries === 0xffff || dirOffset === 0xffffffff) throw tooBig();

  let total = 0;
  let pos = dirOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw damaged();
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw tooBig(); // ZIP64: never needed for a 4 MB upload
    pos += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw damaged();
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buf.length) throw damaged();
    const compressed = buf.subarray(dataStart, dataStart + compressedSize);

    let size: number;
    if (method === 0) {
      size = compressedSize;
    } else if (method === 8) {
      try {
        size = zlib.inflateRawSync(compressed, { maxOutputLength: MAX_TOTAL_BYTES - total + 1 }).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw tooBig();
        throw damaged();
      }
    } else {
      throw damaged();
    }
    total += size;
    if (total > MAX_TOTAL_BYTES) throw tooBig();
  }
}
