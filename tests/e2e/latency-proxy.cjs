#!/usr/bin/env node
/**
 * Adds realistic delay in front of the mock Claude server, so background jobs
 * take a few seconds (like real Claude) and the website's live progress lines
 * can be seen and tested. Streams pass straight through.
 *
 *   node tests/e2e/latency-proxy.cjs --port 4997 --target http://127.0.0.1:4999
 *
 *   POST /__latency {"default": 300, "section_draft_v1": 1500}   delay (ms) per prompt id
 *   GET  /__latency                                               current settings
 * Everything else is forwarded to the target unchanged.
 */
const http = require('http');

const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : fallback;
};
const port = Number(arg('--port', process.env.LATENCY_PROXY_PORT || 4997));
const target = new URL(arg('--target', process.env.LATENCY_PROXY_TARGET || 'http://127.0.0.1:4999'));

let latency = { default: 0 };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (req.url === '/__latency') {
      if (req.method === 'POST') latency = { default: 0, ...JSON.parse(body.toString('utf8') || '{}') };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(latency));
    }
    const promptId = String(req.headers['x-grantfinder-prompt-id'] || '');
    const isMessage = req.method === 'POST' && (req.url || '').startsWith('/v1/messages');
    const delay = isMessage ? Number(latency[promptId] ?? latency.default ?? 0) : 0;
    setTimeout(() => {
      const upstream = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host, 'content-length': String(body.length) },
        },
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (error) => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `latency proxy: ${error.message}` } }));
      });
      upstream.end(body);
    }, delay);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[latency-proxy] listening on http://127.0.0.1:${port} -> ${target.origin}`);
});
