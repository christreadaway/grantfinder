/**
 * Fetching other websites safely (parish/school sites, grant guidelines).
 *
 * SSRF protection ported from backend/services/ai_service.py: only http(s),
 * never localhost or private/link-local addresses, checked again on every
 * redirect hop.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';

import { WEBSITE_CRAWL_MAX_PAGES } from './config';
import { logger } from './log';
import { extractPdfText } from './pdf';

const BLOCKED = new net.BlockList();
BLOCKED.addSubnet('10.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('172.16.0.0', 12, 'ipv4');
BLOCKED.addSubnet('192.168.0.0', 16, 'ipv4');
BLOCKED.addSubnet('127.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('169.254.0.0', 16, 'ipv4');
BLOCKED.addSubnet('0.0.0.0', 8, 'ipv4');
BLOCKED.addSubnet('100.64.0.0', 10, 'ipv4');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');

function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

/** http(s) to a public host only. DNS failure counts as unsafe. */
export async function isSafeUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    logger.warn('url_blocked', { url, reason: 'unparseable' });
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    logger.warn('url_blocked', { url, reason: 'scheme' });
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') {
    logger.warn('url_blocked', { url, reason: 'localhost' });
    return false;
  }
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) {
      logger.warn('url_blocked', { url, reason: 'private_ip' });
      return false;
    }
    return true;
  }
  try {
    const addresses = await dns.lookup(host, { all: true });
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) {
        logger.warn('url_blocked', { url, reason: 'resolves_private', address });
        return false;
      }
    }
    return addresses.length > 0;
  } catch {
    logger.warn('url_blocked', { url, reason: 'dns_failed' });
    return false;
  }
}

/** Add https:// when someone types "stmary.org". */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  ok: boolean;
  status: number | null;
  text: string;
  links: string[];
  /** Why nothing came back, in plain English. */
  error?: string;
}

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 GrantFinder/3.0',
  accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'accept-language': 'en-US,en;q=0.9',
};

const MAX_BYTES = 8 * 1024 * 1024;
const STRIP_TAGS = new Set(['script', 'style', 'nav', 'footer', 'header', 'noscript', 'svg', 'template', 'iframe']);

/** Text nodes joined by newlines, like BeautifulSoup get_text('\n', strip=True). */
function visibleText(nodes: AnyNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === 'text') {
      const value = (node as unknown as { data: string }).data.replace(/\s+/g, ' ').trim();
      if (value) out.push(value);
    } else if ('children' in node && Array.isArray((node as { children?: AnyNode[] }).children)) {
      const name = (node as { name?: string }).name?.toLowerCase();
      if (name && STRIP_TAGS.has(name)) continue;
      visibleText((node as { children: AnyNode[] }).children, out);
    }
  }
}

export function htmlToText(html: string, baseUrl: string): { text: string; links: string[] } {
  const $ = cheerio.load(html);
  let baseHost = '';
  try {
    baseHost = new URL(baseUrl).hostname;
  } catch {
    // Links stay empty.
  }
  const links: string[] = [];
  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    try {
      const absolute = new URL(href, baseUrl);
      if ((absolute.protocol === 'http:' || absolute.protocol === 'https:') && absolute.hostname === baseHost) {
        absolute.hash = '';
        links.push(absolute.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  });
  const parts: string[] = [];
  visibleText($.root().children().toArray(), parts);
  return { text: parts.join('\n'), links };
}

/**
 * Fetch one page and return its readable text (HTML, plain text, or PDF).
 * Never throws: failures come back as ok=false with a plain-English error.
 */
export async function fetchPage(url: string, options: { maxChars?: number; timeoutMs?: number } = {}): Promise<FetchedPage> {
  const maxChars = options.maxChars ?? 20000;
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 30000);
  let current = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      if (!(await isSafeUrl(current))) {
        return { url, finalUrl: current, ok: false, status: null, text: '', links: [], error: `Blocked unsafe address: ${current}` };
      }
      const response = await fetch(current, { headers: BROWSER_HEADERS, redirect: 'manual', signal: deadline });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: 'Redirect without a destination' };
        }
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        const hint = response.status === 403 || response.status === 429
          ? ' (the site blocks automated reading; paste the text instead)'
          : '';
        return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: `HTTP ${response.status}${hint}` };
      }
      const declared = Number(response.headers.get('content-length') || 0);
      if (declared > MAX_BYTES) {
        return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: 'Page is too large to read' };
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > MAX_BYTES) {
        return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: 'Page is too large to read' };
      }
      const type = (response.headers.get('content-type') || '').toLowerCase();
      let text = '';
      let links: string[] = [];
      if (type.includes('pdf') || current.toLowerCase().split('?')[0].endsWith('.pdf')) {
        text = await extractPdfText(buffer);
      } else if (type.includes('html') || type.includes('xml') || !type) {
        ({ text, links } = htmlToText(new TextDecoder().decode(buffer), current));
      } else if (type.startsWith('text/')) {
        text = new TextDecoder().decode(buffer);
      } else {
        return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: `Unsupported content type ${type}` };
      }
      return { url, finalUrl: current, ok: text.trim().length > 0, status: response.status, text: text.slice(0, maxChars), links, error: text.trim() ? undefined : 'Page had no readable text' };
    }
    return { url, finalUrl: current, ok: false, status: null, text: '', links: [], error: 'Too many redirects' };
  } catch (error) {
    const message = (error as Error).name === 'TimeoutError' ? 'Timed out after 30 seconds' : (error as Error).message;
    logger.warn('fetch_page_failed', { url: current, error: message });
    return { url, finalUrl: current, ok: false, status: null, text: '', links: [], error: message };
  }
}

/** Path keywords worth crawling on a parish/school website, in priority order. */
const PRIORITY_PATH_KEYWORDS = [
  'about', 'school', 'academic', 'admission', 'ministr', 'parish',
  'news', 'bulletin', 'giving', 'stewardship', 'capital', 'facilities',
];

export interface CrawlResult {
  text: string;
  pagesRead: string[];
  /** Per-URL problems, e.g. "https://x.org: HTTP 403 (the site blocks automated reading...)" */
  problems: string[];
}

/**
 * Homepage plus the most grant-relevant internal pages (about, school,
 * ministries, news, bulletins, giving...). Port of AIService._fetch_webpage.
 */
export async function crawlSite(url: string, maxPages = WEBSITE_CRAWL_MAX_PAGES): Promise<CrawlResult> {
  const start = normalizeUrl(url);
  const home = await fetchPage(start);
  if (!home.ok) {
    return { text: '', pagesRead: [], problems: [`${start}: ${home.error || 'no readable text'}`] };
  }
  const pages = [`=== PAGE: ${start} ===\n${home.text}`];
  const pagesRead = [start];
  const problems: string[] = [];
  const visited = new Set([start.replace(/\/+$/, ''), home.finalUrl.replace(/\/+$/, '')]);

  const scored: Array<{ score: number; link: string }> = [];
  const seen = new Set<string>();
  for (const link of home.links) {
    const normalized = link.replace(/\/+$/, '');
    if (visited.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    let pathName = '';
    try {
      pathName = new URL(link).pathname.toLowerCase();
    } catch {
      continue;
    }
    const score = PRIORITY_PATH_KEYWORDS.filter((keyword) => pathName.includes(keyword)).length;
    if (score > 0) scored.push({ score, link });
  }
  scored.sort((a, b) => b.score - a.score);
  const targets = scored.slice(0, Math.max(0, maxPages - 1)).map((item) => item.link);

  // Three at a time: quick, but polite to small parish web hosts.
  for (let i = 0; i < targets.length; i += 3) {
    const batch = await Promise.all(targets.slice(i, i + 3).map((link) => fetchPage(link)));
    batch.forEach((page, index) => {
      const link = targets[i + index];
      if (page.ok) {
        pages.push(`=== PAGE: ${link} ===\n${page.text}`);
        pagesRead.push(link);
      } else {
        problems.push(`${link}: ${page.error || 'no readable text'}`);
      }
    });
  }

  const combined = pages.join('\n\n').slice(0, 80000);
  logger.info('site_crawled', { url: start, pages: pagesRead.length, problems: problems.length });
  return { text: combined, pagesRead, problems };
}
