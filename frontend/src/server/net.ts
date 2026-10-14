/**
 * Fetching other websites safely (parish/school sites, grant guidelines).
 *
 * SSRF protection ported from backend/services/ai_service.py: only http(s),
 * never localhost or private/link-local addresses, checked again on every
 * redirect hop.
 */
import dnsCallback from 'node:dns';
import dns from 'node:dns/promises';
import net from 'node:net';

import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Agent, fetch as undiciFetch } from 'undici';

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
BLOCKED.addSubnet('192.0.0.0', 24, 'ipv4');
BLOCKED.addSubnet('192.0.2.0', 24, 'ipv4');
BLOCKED.addSubnet('198.18.0.0', 15, 'ipv4');
BLOCKED.addSubnet('198.51.100.0', 24, 'ipv4');
BLOCKED.addSubnet('203.0.113.0', 24, 'ipv4');
BLOCKED.addSubnet('224.0.0.0', 4, 'ipv4');
BLOCKED.addSubnet('240.0.0.0', 4, 'ipv4');
BLOCKED.addAddress('::1', 'ipv6');
BLOCKED.addAddress('::', 'ipv6');
BLOCKED.addSubnet('::', 96, 'ipv6'); // IPv4-compatible (::a.b.c.d)
BLOCKED.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64 (embeds an IPv4 address)
BLOCKED.addSubnet('2002::', 16, 'ipv6'); // 6to4 (embeds an IPv4 address)
BLOCKED.addSubnet('fc00::', 7, 'ipv6');
BLOCKED.addSubnet('fec0::', 10, 'ipv6');
BLOCKED.addSubnet('fe80::', 10, 'ipv6');
BLOCKED.addSubnet('ff00::', 8, 'ipv6'); // multicast

const allowLocalForTests = () =>
  process.env.GRANTFINDER_TEST_MODE === '1' && process.env.GRANTFINDER_ALLOW_LOCAL_FETCH === '1';

export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return BLOCKED.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family === 6) return BLOCKED.check(address, 'ipv6');
  return true;
}

export type UrlProblem = 'unparseable' | 'scheme' | 'localhost' | 'private_ip' | 'dns_failed';

/**
 * Is this an http(s) address of a public website? Returns the reason when
 * not, so callers can tell a typo ("no such website") from a blocked address.
 */
export async function checkUrl(url: string): Promise<{ ok: true } | { ok: false; reason: UrlProblem }> {
  const blocked = (reason: UrlProblem, extra: Record<string, unknown> = {}) => {
    logger.warn('url_blocked', { url, reason, ...extra });
    return { ok: false as const, reason };
  };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return blocked('unparseable');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return blocked('scheme');
  // Tests serve a fake parish website on localhost. Needs BOTH switches, so a
  // production deploy can never turn SSRF protection off by accident.
  if (allowLocalForTests()) return { ok: true };
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return blocked('localhost');
  if (net.isIP(host)) {
    return isBlockedAddress(host) ? blocked('private_ip') : { ok: true };
  }
  try {
    const addresses = await dns.lookup(host, { all: true });
    for (const { address } of addresses) {
      if (isBlockedAddress(address)) return blocked('private_ip', { address });
    }
    return addresses.length > 0 ? { ok: true } : blocked('dns_failed');
  } catch {
    return blocked('dns_failed');
  }
}

/** http(s) to a public host only. DNS failure counts as unsafe. */
export async function isSafeUrl(url: string): Promise<boolean> {
  return (await checkUrl(url)).ok;
}

function urlProblemMessage(reason: UrlProblem, url: string): string {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    // keep the raw text
  }
  switch (reason) {
    case 'dns_failed':
      return `Couldn't find a website at ${host} (check the address for typos)`;
    case 'unparseable':
      return `"${url}" is not a website address`;
    case 'scheme':
      return `Only http:// and https:// addresses can be read (got ${url})`;
    default:
      return `Blocked: ${host} is a private or local address`;
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

/**
 * Connection-time DNS check. checkUrl() validates a hostname before the
 * request, but the HTTP client resolves it again when connecting; a hostname
 * that switches to a private address in between (DNS rebinding) would slip
 * through. This lookup runs for the real connection and refuses private
 * addresses there, so the address checked is the address used.
 */
function safeLookup(
  hostname: string,
  options: dnsCallback.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | dnsCallback.LookupAddress[], family?: number) => void,
): void {
  dnsCallback.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, []);
      return;
    }
    const list = addresses as dnsCallback.LookupAddress[];
    const blocked = allowLocalForTests() ? undefined : list.find((entry) => isBlockedAddress(entry.address));
    if (blocked || list.length === 0) {
      logger.warn('url_blocked', { host: hostname, reason: 'connect_private', address: blocked?.address });
      callback(Object.assign(new Error(`Blocked: ${hostname} points to a private or local address`), { code: 'EBLOCKED' }), []);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  });
}

const safeAgent = new Agent({ connect: { lookup: safeLookup as never } });

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
      const check = await checkUrl(current);
      if (!check.ok) {
        return { url, finalUrl: current, ok: false, status: null, text: '', links: [], error: urlProblemMessage(check.reason, current) };
      }
      const response = await undiciFetch(current, { headers: BROWSER_HEADERS, redirect: 'manual', signal: deadline, dispatcher: safeAgent });
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
      // Read with a running cap: a server can omit content-length and stream forever.
      const chunks: Uint8Array[] = [];
      let received = 0;
      let tooLarge = false;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_BYTES) {
            tooLarge = true;
            await reader.cancel().catch(() => undefined);
            break;
          }
          chunks.push(value);
        }
      }
      if (tooLarge) {
        return { url, finalUrl: current, ok: false, status: response.status, text: '', links: [], error: 'Page is too large to read' };
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
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
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    const message = (error as Error).name === 'TimeoutError'
      ? 'Timed out after 30 seconds'
      : cause?.code === 'EBLOCKED'
        ? cause.message || 'Blocked: that address points to a private or local network'
        : `${(error as Error).message}${cause?.code ? ` (${cause.code})` : ''}`;
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
