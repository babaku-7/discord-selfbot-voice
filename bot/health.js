'use strict';

const http = require('node:http');
const { STATUS } = require('./account-manager.js');

// Status akun yang dianggap ready untuk readiness check.
// starting/logging_in/voice_connecting BELUM ready; error tentu tidak.
const READY_STATUSES = new Set([STATUS.READY, STATUS.VOICE_CONNECTED]);

/**
 * Ringkasan status registry per akun. Hanya nama + status yang diserialisasi;
 * token/credential tidak pernah ikut.
 */
function summarizeRegistry(registry) {
  const accounts = [];
  let ready = 0;
  for (const [name, entry] of registry.entries()) {
    const status = entry && entry.status ? entry.status : 'unknown';
    if (READY_STATUSES.has(status)) ready += 1;
    accounts.push({ name, status });
  }
  return { total: accounts.length, ready, accounts };
}

/**
 * HTTP health server:
 * - GET /health      : readiness -> 200 kalau minimal 1 akun ready, 503 kalau tidak
 * - GET /health/live : liveness  -> selalu 200 selama process hidup
 * - route lain       : 404
 *
 * Bind default 127.0.0.1 (lihat bot/index.js) supaya tidak terekspos publik
 * tanpa autentikasi.
 * @param {Map} registry Registry hasil startAll()
 */
function createHealthServer(registry) {
  return http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // URL tidak valid -> route tidak dikenal (404).
    }

    if (pathname === '/health/live') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`${JSON.stringify({ status: 'ok', alive: true })}\n`);
      return;
    }

    if (pathname !== '/health') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(`${JSON.stringify({ error: 'not_found' })}\n`);
      return;
    }

    const summary = summarizeRegistry(registry);
    const ok = summary.ready > 0;
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify({ status: ok ? 'ok' : 'unavailable', ...summary })}\n`);
  });
}

module.exports = {
  READY_STATUSES,
  summarizeRegistry,
  createHealthServer,
};
