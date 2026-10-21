'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { setupVoiceChannel, resolveVoiceChannelId } = require('./voice-handler.js');
const { startScreenshare, stopScreenshare } = require('./stream-handler.js');
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
  RECONNECTING: 'reconnecting',
  ERROR: 'error',
};

// Status yang dianggap "sehat" untuk mulai menghitung grace period reconnect.
const HEALTHY_STATUSES = new Set([STATUS.READY, STATUS.VOICE_CONNECTED, STATUS.VOICE_CONNECTING]);

const DEFAULT_RECONNECT_GRACE_MS = 60000;

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
 *
 * Catatan fallback voice channel: di mode multi-account, voiceChannelId kosong
 * berarti voice dilewati untuk akun tersebut (allowEnvFallback: false) dan
 * TIDAK fallback ke env VOICE_CHANNEL_ID global.
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

  // Screenshare (Go Live) opsional per akun. Tanpa stream.enabled=true,
  // tidak ada ffmpeg yang dijalankan sama sekali.
  let stream = rawAccount && rawAccount.stream !== undefined ? rawAccount.stream : null;
  if (stream !== null && (typeof stream !== 'object' || Array.isArray(stream))) {
    console.warn(`[ACCOUNT: ${name}] Format stream tidak valid, screenshare dinonaktifkan.`);
    stream = null;
  } else if (stream && stream.enabled === true && !(typeof stream.source === 'string' && stream.source.trim())) {
    console.warn(`[ACCOUNT: ${name}] stream.enabled=true tapi source kosong, screenshare dinonaktifkan.`);
    stream = null;
  }

  return {
    skipped: false,
    account: { name, token, voiceChannelId, allowEnvFallback: false, rpc, stream },
  };
}

/**
 * Membangun satu account dari environment variable (mode legacy single-account).
 * Di mode ini fallback ke env VOICE_CHANNEL_ID tetap diizinkan.
 */
function accountFromEnv() {
  return {
    name: 'default',
    token: (process.env.DISCORD_TOKEN || '').trim(),
    voiceChannelId: (process.env.VOICE_CHANNEL_ID || '').trim() || null,
    allowEnvFallback: true,
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
 * @param {object} account Account tervalidasi
 * @param {Map} registry Registry status per akun
 * @param {object} [deps] Dependency injection untuk testing
 * @param {Function} [deps.Client] Class client pengganti
 * @param {number} [deps.reconnectGraceMs] Grace period reconnect gateway (default 60000)
 */
function startAccount(account, registry, deps = {}) {
  const ClientClass = deps.Client || Client;
  const reconnectGraceMs =
    Number.isFinite(deps.reconnectGraceMs) && deps.reconnectGraceMs > 0
      ? deps.reconnectGraceMs
      : DEFAULT_RECONNECT_GRACE_MS;
  const { name } = account;

  registry.set(name, {
    account,
    client: null,
    status: STATUS.STARTING,
    voiceHandler: null,
    lastError: null,
    lastReadyAt: null,
    reconnectGraceTimer: null,
    destroyed: false,
  });

  let client;
  try {
    client = new ClientClass({ checkUpdate: false });
  } catch (error) {
    console.error(`[ACCOUNT: ${name}] Gagal membuat Client: ${error.message}`);
    setStatus(registry, name, STATUS.ERROR);
    return null;
  }
  registry.get(name).client = client;

  const clearReconnectGrace = () => {
    const entry = registry.get(name);
    if (entry && entry.reconnectGraceTimer) {
      clearTimeout(entry.reconnectGraceTimer);
      entry.reconnectGraceTimer = null;
    }
  };

  // Gateway putus sementara: jangan langsung turunkan status (reconnect normal
  // butuh beberapa detik). Mulai grace period; kalau tidak pulih, baru error.
  const beginReconnectGrace = () => {
    const entry = registry.get(name);
    if (!entry || entry.destroyed) return;
    // Hanya mulai dari status sehat; fase startup/login tidak diganggu.
    if (!HEALTHY_STATUSES.has(entry.status)) return;
    if (entry.reconnectGraceTimer) return;

    console.warn(
      `[ACCOUNT: ${name}] Gateway terputus, menunggu reconnect (maksimal ${Math.round(
        reconnectGraceMs / 1000,
      )} detik)...`,
    );
    setStatus(registry, name, STATUS.RECONNECTING);

    entry.reconnectGraceTimer = setTimeout(() => {
      const current = registry.get(name);
      if (!current || current.destroyed) return;
      current.reconnectGraceTimer = null;
      if (current.status === STATUS.RECONNECTING) {
        setStatus(registry, name, STATUS.ERROR);
        console.error(
          `[ACCOUNT: ${name}] Tidak pulih setelah ${Math.round(
            reconnectGraceMs / 1000,
          )} detik, status diturunkan ke error.`,
        );
      }
    }, reconnectGraceMs);
    entry.reconnectGraceTimer.unref?.();
  };

  const markGatewayRecovered = () => {
    const entry = registry.get(name);
    if (!entry || entry.destroyed) return;
    clearReconnectGrace();
    // Pulih dari reconnecting, atau pulih setelah grace sempat habis (error).
    const recoveredFromReconnecting = entry.status === STATUS.RECONNECTING;
    const recoveredAfterTimeout = entry.status === STATUS.ERROR && entry.lastReadyAt;
    if (recoveredFromReconnecting || recoveredAfterTimeout) {
      // Jangan timpa voice_connected dengan ready kalau voice masih nyambung:
      // /health adalah sumber otoritatif kondisi voice per akun.
      const voiceConnection = client.voice ? client.voice.connection : null;
      const targetChannelId = account.voiceChannelId;
      const voiceConnected = Boolean(
        voiceConnection &&
          targetChannelId &&
          voiceConnection.channel &&
          voiceConnection.channel.id === targetChannelId &&
          voiceConnection.status !== 4,
      );
      setStatus(registry, name, voiceConnected ? STATUS.VOICE_CONNECTED : STATUS.READY);
      console.log(
        `[ACCOUNT: ${name}] Gateway pulih, status kembali ${voiceConnected ? 'voice_connected' : 'ready'}.`,
      );
    }
  };

  const markGatewayFatal = (reason) => {
    const entry = registry.get(name);
    if (!entry || entry.destroyed) return;
    clearReconnectGrace();
    setStatus(registry, name, STATUS.ERROR);
    console.error(`[ACCOUNT: ${name}] ${reason}`);
  };

  client.once('ready', () => {
    const entry = registry.get(name);
    if (entry) {
      entry.lastReadyAt = Date.now();
      clearReconnectGrace();
    }
    setStatus(registry, name, STATUS.READY);
    console.log(`[ACCOUNT: ${name}] Ready as ${client.user.tag}`);

    try {
      const rpc = setupRichPresence(client, account.rpc, name);
      if (rpc) console.log(`[ACCOUNT: ${name}] RPC enabled`);
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Failed to setup Rich Presence: ${error.message}`);
    }

    const voiceOptions = {
      accountName: name,
      allowEnvFallback: account.allowEnvFallback === true,
      onVoiceConnected: () => {
        const current = registry.get(name);
        // Jangan timpa status reconnecting/error dengan voice_connected;
        // health harus mencerminkan kondisi gateway juga.
        if (current && (current.status === STATUS.VOICE_CONNECTING || current.status === STATUS.READY)) {
          setStatus(registry, name, STATUS.VOICE_CONNECTED);
        }
        // Screenshare (Go Live) hanya untuk akun yang mengaktifkannya.
        // Dipanggil ulang setiap rejoin; startScreenshare() membersihkan
        // stream lama lebih dulu supaya tidak menumpuk proses ffmpeg.
        if (account.stream && account.stream.enabled === true) {
          startScreenshare(client, account.stream, name).catch((streamError) => {
            console.error(`[ACCOUNT: ${name}] Screenshare gagal: ${streamError.message}`);
          });
        }
      },
    };

    try {
      const voiceTarget = resolveVoiceChannelId(account.voiceChannelId, voiceOptions);
      if (!voiceTarget) {
        // Akun multi-account tanpa voiceChannelId: voice dilewati secara sengaja.
        console.log(`[ACCOUNT: ${name}] Voice dilewati: voiceChannelId kosong.`);
      } else {
        setStatus(registry, name, STATUS.VOICE_CONNECTING);
        console.log(`[ACCOUNT: ${name}] Joining voice channel...`);
        registry.get(name).voiceHandler = setupVoiceChannel(client, account.voiceChannelId, voiceOptions);
      }
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Voice setup gagal: ${error.message}`);
    }
  });

  // Error runtime per akun: dicatat saja (lastError), tidak mematikan akun lain
  // dan tidak langsung menurunkan status — sinyal penurunan status datang dari
  // event lifecycle gateway di bawah ini.
  client.on('error', (error) => {
    const message = error && error.message ? error.message : String(error);
    const entry = registry.get(name);
    if (entry) entry.lastError = { message, at: Date.now() };
    console.error(`[ACCOUNT: ${name}] Client error: ${message}`);
  });

  // Gateway disconnect permanen (close code unrecoverable): library tidak akan
  // reconnect sendiri -> status harus turun supaya /health tidak stale.
  client.on('shardDisconnect', () => {
    if (client.ws?.destroyed) return;
    markGatewayFatal('Gateway disconnect permanen (tidak akan reconnect otomatis), status error.');
  });

  // Sesi invalid (mis. token dicabut): library berhenti reconnect dan menyerahkan
  // penanganan ke aplikasi; kita tandai error dan hentikan client.
  client.on('invalidated', () => {
    if (client.ws?.destroyed) return;
    markGatewayFatal('Sesi Discord invalid (kemungkinan token dicabut), client dihentikan.');
    // Client.destroy() tidak menyentuh voice/stream: matikan dulu supaya
    // ffmpeg + stream WS tidak hidup lebih lama dari client.
    try {
      stopScreenshare(client);
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal stop screenshare saat invalidated: ${error.message}`);
    }
    try {
      const handler = registry.get(name) && registry.get(name).voiceHandler;
      if (handler && typeof handler.stop === 'function') handler.stop();
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal stop voice handler saat invalidated: ${error.message}`);
    }
    try {
      client.destroy();
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal destroy client setelah invalidated: ${error.message}`);
    }
  });

  // Gateway putus sementara -> tunggu reconnect dengan batas waktu.
  client.on('shardReconnecting', () => {
    if (client.ws?.destroyed) return;
    beginReconnectGrace();
  });

  client.on('shardResume', () => markGatewayRecovered());
  client.on('shardReady', () => markGatewayRecovered());

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

/**
 * Menghentikan semua akun dengan bersih: cleanup timer/voice handler (termasuk
 * memutus koneksi voice aktif) lalu destroy client. Dipakai saat shutdown
 * (SIGINT/SIGTERM).
 * @param {Map} registry Registry hasil startAll()
 */
function stopAll(registry) {
  for (const [name, entry] of registry.entries()) {
    entry.destroyed = true;
    if (entry.reconnectGraceTimer) {
      clearTimeout(entry.reconnectGraceTimer);
      entry.reconnectGraceTimer = null;
    }
    try {
      if (entry.voiceHandler && typeof entry.voiceHandler.stop === 'function') {
        entry.voiceHandler.stop();
      }
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal stop voice handler: ${error.message}`);
    }
    // Matikan ffmpeg screenshare supaya tidak ada proses menggantung.
    try {
      if (entry.client) stopScreenshare(entry.client);
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal stop screenshare: ${error.message}`);
    }
    try {
      if (entry.client && typeof entry.client.destroy === 'function') {
        entry.client.destroy();
      }
    } catch (error) {
      console.error(`[ACCOUNT: ${name}] Gagal destroy client: ${error.message}`);
    }
  }
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
  stopAll,
};
