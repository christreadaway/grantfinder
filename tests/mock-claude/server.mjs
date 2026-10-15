#!/usr/bin/env node
/**
 * Mock Anthropic API for GrantFinder tests. No dependencies.
 *
 *   node tests/mock-claude/server.mjs --port 4010
 *   GRANTFINDER_CLAUDE_BASE_URL=http://127.0.0.1:4010 GRANTFINDER_TEST_MODE=1 ...
 *
 * The engine sends header x-grantfinder-prompt-id on every call in test mode.
 * Answers come from tests/mock-claude/fixtures/*.json:
 *
 *   { "grant_spec_v1": "{...json text...}" }                       plain answer
 *   { "web_discovery_v1": { "turns": [ {...}, {...} ] } }          pause_turn, then answer
 *   { "x": { "text": "...", "stop_reason": "max_tokens" } }        custom stop reason
 *
 * Every answer is streamed (SSE) with a thinking block FIRST, like newer
 * models, so code that reads content[0].text is caught.
 *
 * API keys that simulate failures:
 *   sk-ant-invalid...   -> 401 authentication_error (messages and models)
 *   sk-ant-nocredit...  -> 400 "credit balance is too low"
 *   sk-ant-overload...  -> 529 overloaded_error on messages
 *   sk-ant-spendcap...  -> 429 monthly spend cap (error_code enforced_spend_limit_reached)
 *   sk-ant-userlimit... -> 400 "You have reached your specified API usage limits"
 *
 * Control endpoints:
 *   GET  /__requests            every call received (prompt id, key suffix, prompt text)
 *   POST /__reset               clear the request log and forced failures
 *   POST /__fail {"prompt_id": "...", "status": 529, "type": "overloaded_error", "times": 1}
 *   POST /__fixtures {"prompt_id": "answer"}   add/override answers at runtime
 *   POST /__delay {"prompt_id": "...", "ms": 1500}  answer that prompt slowly (0 clears)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.MOCK_CLAUDE_PORT || 4010);

const fixtures = {};
function loadFixtures() {
  const dir = path.join(here, 'fixtures');
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    Object.assign(fixtures, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  }
}
loadFixtures();

let requests = [];
let failures = {};
let delays = {};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function apiError(res, status, type, message) {
  send(res, status, { type: 'error', error: { type, message } }, { 'request-id': 'req_mock' });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function promptText(body) {
  const first = (body.messages || [])[0];
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return (first.content || []).map((b) => b.text || '').join('');
}

/** Pick the answer for this call: a string, or {text, stop_reason}. */
function answerFor(promptId, body) {
  let spec = fixtures[promptId];
  if (spec === undefined) {
    console.error(`[mock-claude] no fixture for prompt id "${promptId}"; answering {}`);
    spec = '{}';
  }
  if (spec && typeof spec === 'object' && Array.isArray(spec.turns)) {
    const assistantTurns = (body.messages || []).filter((m) => m.role === 'assistant').length;
    spec = spec.turns[Math.min(assistantTurns, spec.turns.length - 1)];
  }
  if (typeof spec === 'string') return { text: spec, stop_reason: 'end_turn' };
  return { text: String(spec.text ?? ''), stop_reason: spec.stop_reason || 'end_turn', web_searches: spec.web_searches || 0 };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamAnswer(res, model, answer, inputTokens) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
  const id = `msg_mock_${Math.random().toString(36).slice(2, 10)}`;
  const outputTokens = Math.max(1, Math.ceil(answer.text.length / 4));
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  // Thinking block first, like adaptive-thinking models.
  sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Considering the request.' } });
  sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'mock-signature' } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  for (let i = 0; i < answer.text.length; i += 400) {
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: answer.text.slice(i, i + 400) } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 1 });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: answer.stop_reason, stop_sequence: null },
    usage: { output_tokens: outputTokens, ...(answer.web_searches ? { server_tool_use: { web_search_requests: answer.web_searches } } : {}) },
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function keyProblem(res, apiKey, forMessages, authorization) {
  // The engine sends only the person's key (x-api-key). A bearer token here means an
  // ANTHROPIC_AUTH_TOKEN from the environment leaked into the request.
  if (authorization) return apiError(res, 401, 'authentication_error', 'unexpected Authorization header'), true;
  if (!apiKey) return apiError(res, 401, 'authentication_error', 'x-api-key header is required'), true;
  if (apiKey.startsWith('sk-ant-invalid')) return apiError(res, 401, 'authentication_error', 'invalid x-api-key'), true;
  if (forMessages && apiKey.startsWith('sk-ant-nocredit')) {
    return apiError(res, 400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'), true;
  }
  if (forMessages && apiKey.startsWith('sk-ant-overload')) return apiError(res, 529, 'overloaded_error', 'Overloaded'), true;
  if (forMessages && apiKey.startsWith('sk-ant-spendcap')) {
    res.writeHead(429, { 'content-type': 'application/json', 'request-id': 'req_mock' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'You have reached your API usage limits: your organization has crossed its monthly API usage threshold.', details: { error_code: 'enforced_spend_limit_reached' } } }));
    return true;
  }
  if (forMessages && apiKey.startsWith('sk-ant-userlimit')) {
    return apiError(res, 400, 'invalid_request_error', 'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.'), true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/__requests') return send(res, 200, requests);
    if (req.method === 'POST' && url.pathname === '/__reset') {
      requests = [];
      failures = {};
      delays = {};
      loadFixtures();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__fail') {
      const body = JSON.parse((await readBody(req)) || '{}');
      failures[body.prompt_id] = { status: body.status || 529, type: body.type || 'overloaded_error', times: body.times ?? 1 };
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__delay') {
      const body = JSON.parse((await readBody(req)) || '{}');
      delays[body.prompt_id] = Number(body.ms) || 0;
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/__fixtures') {
      Object.assign(fixtures, JSON.parse((await readBody(req)) || '{}'));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      if (keyProblem(res, req.headers['x-api-key'], false, req.headers.authorization)) return;
      return send(res, 200, {
        data: [{ id: 'claude-sonnet-5', type: 'model', display_name: 'Claude Sonnet 5', created_at: '2026-01-01T00:00:00Z' }],
        has_more: false, first_id: 'claude-sonnet-5', last_id: 'claude-sonnet-5',
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const promptId = String(req.headers['x-grantfinder-prompt-id'] || 'unknown');
      const apiKey = String(req.headers['x-api-key'] || '');
      requests.push({
        at: new Date().toISOString(),
        prompt_id: promptId,
        key_suffix: apiKey.slice(-4),
        model: body.model,
        max_tokens: body.max_tokens,
        stream: Boolean(body.stream),
        tools: (body.tools || []).map((t) => t.type),
        turns: (body.messages || []).length,
        prompt: promptText(body),
      });
      if (keyProblem(res, apiKey, true, req.headers.authorization)) return;
      const forced = failures[promptId];
      if (forced && forced.times !== 0) {
        forced.times -= 1;
        return apiError(res, forced.status, forced.type, `forced ${forced.type} for ${promptId}`);
      }
      if (delays[promptId]) await new Promise((resolve) => setTimeout(resolve, delays[promptId]));
      const answer = answerFor(promptId, body);
      const inputTokens = Math.max(1, Math.ceil(raw.length / 4));
      if (body.stream) return streamAnswer(res, body.model, answer, inputTokens);
      return send(res, 200, {
        id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'thinking', thinking: 'Considering the request.', signature: 'mock' }, { type: 'text', text: answer.text }],
        stop_reason: answer.stop_reason, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: Math.ceil(answer.text.length / 4) },
      });
    }
    send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `mock has no ${req.method} ${url.pathname}` } });
  } catch (error) {
    send(res, 500, { type: 'error', error: { type: 'api_error', message: String(error) } });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[mock-claude] listening on http://127.0.0.1:${port} with ${Object.keys(fixtures).length} fixtures`);
});
