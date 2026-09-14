'use strict';

require('dotenv').config();

const http = require('http');
const process = require('node:process');
const {
  loadAccountsFile,
  resolveAccountsPath,
  validateAccount,
  accountFromEnv,
  startAll,
} = require('./account-manager.js');

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
const port = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    const running = [...registry.values()].filter((entry) => entry.status !== 'error').length;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Multi-account voice client is alive\nAccounts running: ${running}/${registry.size}\n`);
  })
  .listen(port, () => console.log(`[INFO] Health check server listening on port ${port}`));
