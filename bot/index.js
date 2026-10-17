'use strict';

require('dotenv').config();

const process = require('node:process');
const {
  loadAccountsFile,
  resolveAccountsPath,
  validateAccount,
  accountFromEnv,
  startAll,
  stopAll,
} = require('./account-manager.js');
const { createHealthServer } = require('./health.js');

function validateLegacyEnvVars() {
  const requiredEnvVars = ['DISCORD_TOKEN', 'VOICE_CHANNEL_ID'];
  const missingVars = requiredEnvVars.filter((variable) => !process.env[variable]);

  if (missingVars.length > 0) {
    console.error(`Environment variable belum diatur: ${missingVars.join(', ')}`);
    process.exit(1);
  }
}

/**
 * Jika accounts.json tersedia (lokal, root service, atau /etc/secrets) -> MULTI ACCOUNT MODE.
 * Jika tidak ada -> LEGACY SINGLE ACCOUNT MODE (.env).
 */
function resolveAccounts() {
  let raw;
  try {
    raw = loadAccountsFile();
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    process.exit(1);
  }

  if (raw === null) {
    validateLegacyEnvVars();
    console.log('[INFO] accounts.json tidak ditemukan, memakai mode single-account (.env).');
    return { mode: 'single', accounts: [accountFromEnv()] };
  }

  console.log(`[INFO] Multi-account mode: ${raw.length} akun ditemukan di ${resolveAccountsPath()}.`);
  const usedNames = new Set();
  const accounts = [];
  raw.forEach((rawAccount, index) => {
    try {
      const result = validateAccount(rawAccount, index, usedNames);
      if (!result.skipped) accounts.push(result.account);
    } catch (error) {
      console.error(`[ACCOUNT: ?] Validasi gagal: ${error.message}`);
    }
  });

  if (accounts.length === 0) {
    console.error('[ERROR] Tidak ada account valid di accounts.json, process dihentikan.');
    process.exit(1);
  }

  return { mode: 'multi', accounts };
}

const { accounts } = resolveAccounts();
const registry = startAll(accounts);

// Satu HTTP health check untuk seluruh process (bukan per account).
// Default bind ke 127.0.0.1 (localhost) supaya tidak terekspos publik tanpa
// autentikasi; set HOST=0.0.0.0 hanya kalau memang perlu (mis. lewat proxy).
const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';
const server = createHealthServer(registry);
server.listen(port, host, () => {
  console.log(`[INFO] Health check server listening on http://${host}:${port}/health`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.warn(
      '[WARN] Health check di-bind ke non-loopback tanpa autentikasi. Pastikan port tidak terekspos publik.',
    );
  }
});

// Graceful shutdown: bersihkan voice handler + client supaya tidak ada
// timer/socket menggantung saat proses dihentikan (pm2 stop/restart).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[INFO] Menerima ${signal}, menghentikan bot...`);
  server.close();
  stopAll(registry);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
