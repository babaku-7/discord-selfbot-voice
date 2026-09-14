'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { setupVoiceChannel } = require('./voice-handler.js');
const { setupRichPresence, getRpcConfig } = require('./rpc.js');
const { Client } = require('../src/index.js');

const LOCAL_ACCOUNTS_PATH = path.join(__dirname, 'accounts.json');
const ROOT_ACCOUNTS_PATH = path.join(process.cwd(), 'accounts.json');
const RENDER_ACCOUNTS_PATH = '/etc/secrets/accounts.json';

/** @deprecated Gunakan LOCAL_ACCOUNTS_PATH. Disimpan untuk kompatibilitas. */
const ACCOUNTS_PATH = LOCAL_ACCOUNTS_PATH;

const STATUS = {
  STARTING: 'starting',
  LOGGING_IN: 'logging_in',
  READY: 'ready',
  VOICE_CONNECTING: 'voice_connecting',
  VOICE_CONNECTED: 'voice_connected',
  ERROR: 'error',
};

/**
 * Urutan pencarian accounts.json (prioritas tertinggi dulu):
 * 1. Override via env ACCOUNTS_PATH (opsional, untuk host lain/testing)
 * 2. bot/accounts.json (repository lokal)
 * 3. accounts.json di root service (Render Secret File non-Docker)
 * 4. /etc/secrets/accounts.json (Render Secret File)
 * @returns {string[]} Daftar path kandidat
 */
function getAccountsSearchPaths() {
  const candidates = [];
  if (process.env.ACCOUNTS_PATH && process.env.ACCOUNTS_PATH.trim()) {
    candidates.push(process.env.ACCOUNTS_PATH.trim());
  }
  candidates.push(LOCAL_ACCOUNTS_PATH, ROOT_ACCOUNTS_PATH, RENDER_ACCOUNTS_PATH);
  return candidates;
}

/**
 * Mencari file accounts.json di lokasi yang didukung.
 * @returns {?string} Path pertama yang ada, atau null jika tidak ada satupun
 */
function resolveAccountsPath() {
  for (const candidate of getAccountsSearchPaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Abaikan kandidat yang tidak bisa dicek, lanjut ke berikutnya.
    }
  }
  return null;
}

/**
 * Membaca accounts.json dari lokasi pertama yang ditemukan.
 * @param {string} [accountsPath] Path eksplisit (melewati pencarian); jika dihilangkan, dicari berurutan
 * @returns {?Array} Daftar account mentah, atau null jika file tidak ada (mode legacy .env)
 * @throws Jika JSON corrupt atau bukan array (fatal, hentikan startup)
 */
function loadAccountsFile(accountsPath) {
  const resolved = accountsPath || resolveAccountsPath();
  if (!resolved) return null;

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`accounts.json corrupt (JSON tidak valid) di ${resolved}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) throw new Error(`accounts.json di ${resolved} harus berisi array of account.`);
  return parsed;
}

/**
 * Validasi satu account. Token TIDAK pernah ditulis ke log.
 * @returns {{ skipped: boolean, account?: object, reason?: string }}
 */
function validateAccount(rawAccount, index, usedNames) {
  const fallbackName = `akun${index + 1}`;
  let name = rawAccount && typeof rawAccount.name === 'string' ? rawAccount.name.trim() : '';

  if (!name) {
    console.warn(`[ACCOUNT: ${fallbackName}] Nama kosong, memakai nama default "${fallbackName}".`);
    name = fallbackName;
  }
  if (usedNames.has(name)) {
    const unique = `${name}-${index + 1}`;
    console.warn(`[ACCOUNT: ${name}] Nama duplikat, memakai nama "${unique}".`);
    name = unique;
  }
  usedNames.add(name);

  const token = rawAccount && typeof rawAccount.token === 'string' ? rawAccount.token.trim() : '';
  if (!token) {
    console.warn(`[ACCOUNT: ${name}] Token kosong, akun dilewati.`);
    return { skipped: true, reason: 'token kosong' };
  }

  const voiceChannelId =
    rawAccount && typeof rawAccount.voiceChannelId === 'string' && rawAccount.voiceChannelId.trim()
      ? rawAccount.voiceChannelId.trim()
      : null;
  if (!voiceChannelId) {
    console.warn(`[ACCOUNT: ${name}] voiceChannelId kosong, voice akan dilewati untuk akun ini.`);
  }

  let rpc = rawAccount && rawAccount.rpc !== undefined ? rawAccount.rpc : null;
  if (rpc !== null && (typeof rpc !== 'object' || Array.isArray(rpc))) {
    console.warn(`[ACCOUNT: ${name}] Format rpc tidak valid, RPC dinonaktifkan untuk akun ini.`);
    rpc = null;
  }

  return { skipped: false, account: { name, token, voiceChannelId, rpc } };
}

/**
 * Membangun satu account dari environment variable (mode legacy single-account).
 */
function accountFromEnv() {
  return {
    name: 'default',
    token: (process.env.DISCORD_TOKEN || '').trim(),
    voiceChannelId: (process.env.VOICE_CHANNEL_ID || '').trim() || null,
    // Bentuk internal getRpcConfig() kompatibel dengan normalizeRpcConfig().
    rpc: getRpcConfig(),
  };
}

function setStatus(registry, name, status) {
  const entry = registry.get(name);
  if (entry) entry.status = status;
}

/**
 * Menjalankan satu account dengan lifecycle dan error isolation sendiri.
 * Kegagalan akun ini tidak memengaruhi akun lain.
 */
function startAccount(account, registry, deps = {}) {
  const ClientClass = deps.Client || Client;
  const { name } = account;

  registry.set(name, { account, client: null, status: STATUS.STARTING });

  let client;
  try {
    client = new ClientClass({ checkUpdate: false });
  } catch (error) {
    console.error(`[ACCOUNT: ${name}] Gagal membuat Client: ${error.message}`);
    setStatus(registry, name, STATUS.ERROR);
    return null;
  }
  registry.get(name).client = client;

  client.once('ready', () => {
    setStatus(registry, name, STATUS.READY);
    console.log(`[ACCOUNT: ${name}] Ready as ${client.user.tag}`);

    try {
      const rpc = setupRichPresence(client, account.rpc, name);
      if (rpc) console.log(`[ACCOUNT: ${name}] RPC enabled`);
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Failed to setup Rich Presence: ${error.message}`);
    }

    try {
      setStatus(registry, name, STATUS.VOICE_CONNECTING);
      console.log(`[ACCOUNT: ${name}] Joining voice channel...`);
      setupVoiceChannel(client, account.voiceChannelId, {
        accountName: name,
        onVoiceConnected: () => setStatus(registry, name, STATUS.VOICE_CONNECTED),
      });
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Voice setup gagal: ${error.message}`);
    }
  });

  // Error runtime per akun: dicatat saja, tidak mematikan akun lain.
  // Reconnect gateway tetap ditangani oleh library (WebSocketManager).
  client.on('error', (error) => {
    console.error(`[ACCOUNT: ${name}] Client error: ${error && error.message ? error.message : error}`);
  });

  setStatus(registry, name, STATUS.LOGGING_IN);
  console.log(`[ACCOUNT: ${name}] Logging in...`);

  try {
    const result = client.login(account.token);
    if (result && typeof result.catch === 'function') {
      result.catch((error) => {
        console.error(`[ACCOUNT: ${name}] Login gagal: ${error && error.message ? error.message : error}`);
        setStatus(registry, name, STATUS.ERROR);
      });
    }
  } catch (error) {
    console.error(`[ACCOUNT: ${name}] Login gagal: ${error && error.message ? error.message : error}`);
    setStatus(registry, name, STATUS.ERROR);
  }

  return client;
}

/**
 * Menjalankan semua account, masing-masing terisolasi.
 * @returns {Map} Registry status per nama akun
 */
function startAll(accounts, deps = {}) {
  const registry = new Map();
  for (const account of accounts) {
    try {
      startAccount(account, registry, deps);
    } catch (error) {
      console.error(
        `[ACCOUNT: ${account && account.name ? account.name : '?'}] Gagal start: ${
          error && error.message ? error.message : error
        }`,
      );
      if (account && account.name) setStatus(registry, account.name, STATUS.ERROR);
    }
  }
  return registry;
}

module.exports = {
  STATUS,
  ACCOUNTS_PATH,
  LOCAL_ACCOUNTS_PATH,
  ROOT_ACCOUNTS_PATH,
  RENDER_ACCOUNTS_PATH,
  getAccountsSearchPaths,
  resolveAccountsPath,
  loadAccountsFile,
  validateAccount,
  accountFromEnv,
  startAccount,
  startAll,
};
