/**
 * Downloads and clipboard copies that work in every browser.
 *
 * Safari ignores a click on a link that isn't in the page, and can cancel a
 * download whose object URL is revoked right away; FileSaver.js waits about
 * 40 seconds for the same reason. Safari also refuses clipboard writes that
 * happen after an await, so copyText falls back to the older copy command.
 */

/** Save data as a file named filename. */
export function saveFile(data: Blob | string | ArrayBuffer | Uint8Array, filename: string, type = 'application/octet-stream'): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Copy text to the clipboard. Returns false when the browser refused both ways. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused (Safari after an await, or no permission): try the older way.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
