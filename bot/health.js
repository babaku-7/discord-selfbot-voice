'use strict';

const http = require('node:http');
const { STATUS } = require('./account-manager.js');

// Status akun yang dianggap ready untuk readiness check.
// starting/logging_in/voice_connecting/reconnecting BELUM ready; error tentu tidak.
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
 * Menentukan token health dari options/env. Kosong -> null (tanpa autentikasi).
 * @param {object} [options]
 * @param {string} [options.token] Override token (dipakai juga oleh test)
 * @returns {?string}
 */
function resolveHealthToken(options = {}) {
  for (const candidate of [options.token, process.env.HEALTH_TOKEN]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** @param {string} host */
function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(typeof host === 'string' ? host.trim() : '');
}

/**
 * Menentukan host binding health server. Demi keamanan, host non-loopback
 * hanya diizinkan kalau token aktif; tanpa token, bind fallback ke 127.0.0.1
 * supaya endpoint tidak pernah terbuka publik tanpa autentikasi.
 * @param {string} [host] Nilai HOST (env)
 * @param {?string} [token] Token health (lihat resolveHealthToken)
 * @returns {{ host: string, downgraded: boolean }}
 */
function resolveHealthBinding(host, token) {
  const requested = typeof host === 'string' && host.trim() ? host.trim() : '127.0.0.1';
  const hasToken = typeof token === 'string' && token.trim().length > 0;
  if (isLoopbackHost(requested) || hasToken) return { host: requested, downgraded: false };
  return { host: '127.0.0.1', downgraded: true };
}

function isAuthorized(req, token) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const [scheme, value] = header.split(' ');
  return typeof value === 'string' && scheme.toLowerCase() === 'bearer' && value === token;
}

/**
 * HTTP health server:
 * - GET /health      : readiness -> 200 kalau minimal 1 akun ready, 503 kalau tidak
 * - GET /health/live : liveness  -> selalu 200 selama process hidup
 * - route lain       : 404
 *
 * Kalau HEALTH_TOKEN diisi (atau options.token diberikan), semua request wajib
 * menyertakan header `Authorization: Bearer <token>` (401 kalau tidak).
 *
 * Bind default 127.0.0.1 (lihat bot/index.js) supaya tidak terekspos publik
 * tanpa autentikasi.
 * @param {Map} registry Registry hasil startAll()
 * @param {object} [options]
 * @param {string} [options.token] Token health (fallback ke env HEALTH_TOKEN)
 */
function createHealthServer(registry, options = {}) {
  const token = resolveHealthToken(options);

  return http.createServer((req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      // URL tidak valid -> route tidak dikenal (404).
    }

    if (token && !isAuthorized(req, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(`${JSON.stringify({ error: 'unauthorized' })}\n`);
      return;
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
  resolveHealthToken,
  isLoopbackHost,
  resolveHealthBinding,
  createHealthServer,
};
