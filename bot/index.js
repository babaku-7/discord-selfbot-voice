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
const { createHealthServer, isLoopbackHost, resolveHealthBinding } = require('./health.js');

function validateLegacyEnvVars() {
  const requiredEnvVars = ['DISCORD_TOKEN', 'VOICE_CHANNEL_ID'];
  const missingVars = requiredEnvVars.filter((variable) => !process.env[variable]);

  if (missingVars.length > 0) {
    console.error(`Environment variable belum diatur: ${missingVars.join(', ')}`);
    return false;
  }
  return true;
}

/**
 * Jika accounts.json tersedia (lokal, root service, atau /etc/secrets) -> MULTI ACCOUNT MODE.
 * Jika tidak ada -> LEGACY SINGLE ACCOUNT MODE (.env).
 * @returns {?{ mode: string, accounts: Array }} null jika fatal (pesan sudah dicatat)
 */
function resolveAccounts() {
  let raw;
  try {
    raw = loadAccountsFile();
  } catch (error) {
    console.error(`[ERROR] ${error.message}`);
    return null;
  }

  if (raw === null) {
    if (!validateLegacyEnvVars()) return null;
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
    return null;
  }

  return { mode: 'multi', accounts };
}

function startBot(accounts) {
  const registry = startAll(accounts);

  // Satu HTTP health check untuk seluruh process (bukan per account).
  // Default bind ke 127.0.0.1 (localhost). HOST non-loopback hanya diizinkan
  // kalau HEALTH_TOKEN diaktifkan; tanpa token, binding otomatis fallback ke
  // 127.0.0.1 supaya endpoint tidak pernah terbuka publik tanpa autentikasi.
  const port = process.env.PORT || 3000;
  const requestedHost = process.env.HOST || '127.0.0.1';
  const healthToken = process.env.HEALTH_TOKEN;
  const binding = resolveHealthBinding(requestedHost, healthToken);
  const server = createHealthServer(registry, { token: healthToken });

  server.listen(port, binding.host, () => {
    console.log(`[INFO] Health check server listening on http://${binding.host}:${port}/health`);
    if (binding.downgraded) {
      console.warn(
        `[WARN] HOST=${requestedHost} tanpa HEALTH_TOKEN ditolak demi keamanan: health server di-bind ke 127.0.0.1 (tidak terekspos). Set HEALTH_TOKEN untuk bind ke ${requestedHost}.`,
      );
    } else if (!isLoopbackHost(binding.host)) {
      console.log('[INFO] Health check dilindungi HEALTH_TOKEN (header: Authorization: Bearer <token>).');
    }
  });

  // Graceful shutdown: bersihkan voice handler (termasuk disconnect voice) +
  // client supaya tidak ada timer/socket menggantung saat proses dihentikan
  // (pm2 stop/restart).
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[INFO] Menerima ${signal}, menghentikan bot...`);
    server.close();
    stopAll(registry);
    // Jangan panggil process.exit() langsung: itu bisa memotong output log yang
    // belum ter-flush dan memutus socket secara kasar. Biarkan event loop
    // selesai natural; failsafe 2 detik kalau masih ada handle menggantung.
    setTimeout(() => process.exit(0), 2000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const resolved = resolveAccounts();
if (resolved) {
  startBot(resolved.accounts);
} else {
  // Fatal saat resolve: pesan sudah dicatat. Biarkan event loop kosong supaya
  // proses keluar natural dengan exit code 1 dan log ikut ter-flush
  // (process.exit() langsung bisa memotong tulisan ke pipe pm2).
  process.exitCode = 1;
}
