#!/usr/bin/env node
/**
 * A fake parish + school website for the end-to-end test (fictional names only).
 *
 *   node tests/e2e/fake-site.cjs --port 4998
 *
 *   /                      homepage linking to about, school, news, giving, ministries, a PDF bulletin
 *   /about /school /giving /ministries /mass-times    HTML pages, each with a unique MARKER string
 *   /news/bulletin-2026-10.pdf                        a real PDF (the crawler reads PDFs too)
 *   /blocked  (and /blocked/...)                      403, like a Cloudflare bot challenge
 *   /school-home (+ /academics, /admissions)          a separate school website
 *   /grant-guidelines                                 funder guidelines page (writer fallback fetch)
 *   GET /__hits    every path requested, in order      POST /__reset   clear it
 *
 * The test checks which pages the engine crawled and that each page's MARKER
 * reached the Claude prompt.
 */
const http = require('http');
const { makePdf } = require('./lib/files.cjs');

const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.FAKE_SITE_PORT || 4998);

const NAME = 'St. Testwell Catholic Parish and School';

function page(title, body, extraHead = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} | ${NAME}</title>${extraHead}
<style>body{font-family:sans-serif}</style><script>window.__analytics = "SCRIPT-SHOULD-BE-STRIPPED";</script></head>
<body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/school">School</a></nav></header>
<main><h1>${title}</h1>${body}</main>
<footer>NAV-FOOTER-SHOULD-BE-STRIPPED &copy; ${NAME}</footer>
</body></html>`;
}

const PAGES = {
  '/': page('Welcome', `
    <p>HOME-MARKER-7731 Welcome to ${NAME} in Exampleville, Texas, part of the Diocese of Example.</p>
    <p>We are a parish family of about 1,100 households with a parish school serving grades PK-8.</p>
    <ul>
      <li><a href="/about">About our parish</a></li>
      <li><a href="/school">Our school</a></li>
      <li><a href="/news/bulletin-2026-10.pdf">This week's bulletin (PDF)</a></li>
      <li><a href="/giving">Giving and stewardship</a></li>
      <li><a href="/ministries">Ministries</a></li>
      <li><a href="/mass-times">Mass times</a></li>
      <li><a href="https://example.org/elsewhere">An outside link</a></li>
      <li><a href="#top">Back to top</a></li>
    </ul>`),
  '/about': page('About Us', `
    <p>ABOUT-MARKER-5512 ${NAME} was founded in 1952 to serve families on the east side of Exampleville.</p>
    <p>Our parish hall, built in 1961, hosts the food pantry every Saturday and needs a new HVAC system.</p>`),
  '/school': page('Our School', `
    <p>SCHOOL-MARKER-3390 St. Testwell Catholic School serves 240 students in grades PK-8.</p>
    <p>About 38 percent of our families receive tuition assistance. The school is accredited by the regional Catholic accreditation body.</p>
    <p>The playground equipment is 30 years old and no longer meets safety standards.</p>`),
  '/giving': page('Giving', `
    <p>GIVING-MARKER-1209 Our capital campaign is raising funds to repair the school roof and replace the playground.</p>`),
  '/ministries': page('Ministries', `
    <p>MINISTRY-MARKER-6650 Ministries include a food pantry serving 300 families a month, youth ministry, and a St. Vincent de Paul conference.</p>`),
  '/mass-times': page('Mass Times', `
    <p>MASSTIMES-MARKER-0001 Saturday 5:00 PM, Sunday 8:00 AM and 10:30 AM. (Not grant-relevant; the crawler should skip this page.)</p>`),
  // A separate school website (same host, own path), linked only from its own homepage.
  '/school-home': page('St. Testwell Catholic School', `
    <p>SCHOOLSITE-MARKER-2468 Welcome to St. Testwell Catholic School, a PK-8 school of the Diocese of Example.</p>
    <ul>
      <li><a href="/school-home/academics">Academics</a></li>
      <li><a href="/school-home/admissions">Admissions and tuition assistance</a></li>
    </ul>`),
  '/school-home/academics': page('Academics', `
    <p>ACADEMICS-MARKER-1357 Our K-3 teachers want structured literacy training; the science lab has no working equipment.</p>`),
  '/school-home/admissions': page('Admissions', `
    <p>ADMISSIONS-MARKER-8642 Tuition assistance reaches 38 percent of families; the waiting list for aid has 22 families.</p>`),
  '/grant-guidelines': page('Grant Guidelines', `
    <p>GUIDELINES-MARKER-9090 The foundation funds Catholic organizations in Texas. Applications are due annually.</p>`),
};

const BULLETIN_PDF = makePdf([
  'ST. TESTWELL PARISH BULLETIN - OCTOBER 2026',
  'BULLETIN-MARKER-4410: Parish council approved a security review after two break-ins at the school.',
  'Second collection next week supports the roof repair fund.',
], 'Parish bulletin');

let hits = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const pathName = url.pathname.replace(/\/+$/, '') || '/';
  if (pathName === '/__hits') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(hits));
  }
  if (pathName === '/__reset' && req.method === 'POST') {
    hits = [];
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"ok":true}');
  }
  hits.push({ path: pathName, method: req.method, ua: String(req.headers['user-agent'] || ''), at: new Date().toISOString() });

  if (pathName === '/blocked' || pathName.startsWith('/blocked/')) {
    // What a Cloudflare bot challenge looks like to a server-side fetch.
    res.writeHead(403, { 'content-type': 'text/html; charset=UTF-8', server: 'cloudflare', 'cf-ray': '8d0e2e2e2e2e2e2e-DFW' });
    return res.end('<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>You are unable to access this website.</p></body></html>');
  }
  if (pathName === '/news/bulletin-2026-10.pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': BULLETIN_PDF.length });
    return res.end(BULLETIN_PDF);
  }
  const html = PAGES[pathName];
  if (html) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(html);
  }
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end(page('Not found', '<p>Page not found.</p>'));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-site] listening on http://127.0.0.1:${port}`);
});
