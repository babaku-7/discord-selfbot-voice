'use strict';

const process = require('node:process');
const { RichPresence } = require('../src/index.js');

// Timestamp start disimpan per client (WeakMap) agar setiap akun memiliki
// elapsed time sendiri. Dibuat sekali saat RPC pertama aktif per client.
const startTimestamps = new WeakMap();

function isTruthy(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function emptyToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return isTruthy(value);
  return fallback;
}

function maskApplicationId(applicationId) {
  if (!applicationId || applicationId.length <= 4) return '********';
  return `${'*'.repeat(4)}${applicationId.slice(-4)}`;
}

function logPrefix(accountName) {
  return accountName ? `[ACCOUNT: ${accountName}]` : '[RPC]';
}

function getRpcConfig() {
  return {
    enabled: isTruthy(process.env.RPC_ENABLED || ''),
    applicationId: emptyToNull(process.env.RPC_APPLICATION_ID),
    name: emptyToNull(process.env.RPC_NAME),
    details: emptyToNull(process.env.RPC_DETAILS),
    state: emptyToNull(process.env.RPC_STATE),
    largeImage: emptyToNull(process.env.RPC_LARGE_IMAGE),
    largeText: emptyToNull(process.env.RPC_LARGE_TEXT),
    smallImage: emptyToNull(process.env.RPC_SMALL_IMAGE),
    smallText: emptyToNull(process.env.RPC_SMALL_TEXT),
    button1Name: emptyToNull(process.env.RPC_BUTTON1_NAME),
    button1Url: emptyToNull(process.env.RPC_BUTTON1_URL),
    button2Name: emptyToNull(process.env.RPC_BUTTON2_NAME),
    button2Url: emptyToNull(process.env.RPC_BUTTON2_URL),
    startTimestamp: isTruthy(process.env.RPC_START_TIMESTAMP || ''),
  };
}

/**
 * Normalisasi konfigurasi RPC gaya account (camelCase, dari accounts.json)
 * ke bentuk internal yang sama seperti getRpcConfig().
 * Jika rpcConfig tidak diberikan, fallback ke environment variable (.env).
 * @param {object} [rpcConfig] Konfigurasi RPC per account
 * @returns {object} Konfigurasi RPC ternormalisasi
 */
function normalizeRpcConfig(rpcConfig) {
  if (!rpcConfig || typeof rpcConfig !== 'object') return getRpcConfig();
  return {
    enabled: toBool(rpcConfig.enabled, false),
    applicationId: emptyToNull(rpcConfig.applicationId),
    name: emptyToNull(rpcConfig.name),
    details: emptyToNull(rpcConfig.details),
    state: emptyToNull(rpcConfig.state),
    largeImage: emptyToNull(rpcConfig.largeImage),
    largeText: emptyToNull(rpcConfig.largeText),
    smallImage: emptyToNull(rpcConfig.smallImage),
    smallText: emptyToNull(rpcConfig.smallText),
    button1Name: emptyToNull(rpcConfig.button1Name),
    button1Url: emptyToNull(rpcConfig.button1Url),
    button2Name: emptyToNull(rpcConfig.button2Name),
    button2Url: emptyToNull(rpcConfig.button2Url),
    startTimestamp: toBool(rpcConfig.startTimestamp, false),
  };
}

function collectButtonsFromConfig(config, prefix) {
  const buttons = [];
  if (config.button1Name && config.button1Url) {
    buttons.push({ name: config.button1Name, url: config.button1Url });
  } else if (config.button1Name || config.button1Url) {
    console.warn(`${prefix} Button 1 tidak lengkap (butuh nama dan URL), dilewati.`);
  }
  if (config.button2Name && config.button2Url) {
    buttons.push({ name: config.button2Name, url: config.button2Url });
  } else if (config.button2Name || config.button2Url) {
    console.warn(`${prefix} Button 2 tidak lengkap (butuh nama dan URL), dilewati.`);
  }
  return buttons;
}

function applyAssets(rpc, config, prefix) {
  try {
    if (config.largeImage) rpc.setAssetsLargeImage(config.largeImage);
    if (config.largeText) rpc.setAssetsLargeText(config.largeText);
    if (config.smallImage) rpc.setAssetsSmallImage(config.smallImage);
    if (config.smallText) rpc.setAssetsSmallText(config.smallText);
  } catch (error) {
    console.warn(`${prefix} Asset dilewati karena tidak valid: ${error.message}`);
  }
}

function applyButtons(rpc, buttons, prefix) {
  if (buttons.length === 0) return;
  try {
    // Validasi URL + batas 2 button ditangani oleh RichPresence.setButtons().
    rpc.setButtons(...buttons);
  } catch (error) {
    console.warn(`${prefix} Button dilewati karena tidak valid: ${error.message}`);
  }
}

function getStartTimestamp(client) {
  if (!startTimestamps.has(client)) startTimestamps.set(client, Date.now());
  return startTimestamps.get(client);
}

function applyStartTimestamp(rpc, enabled, client) {
  if (!enabled) return;
  // Dibuat sekali saat RPC pertama aktif per client; Discord menghitung
  // elapsed time dari nilai ini.
  rpc.setStartTimestamp(getStartTimestamp(client));
}

function sendPresence(client, rpc) {
  // API existing repository: ClientUser#setPresence -> ClientPresence#set
  // -> broadcast STATUS_UPDATE melalui websocket. Tidak ada interval refresh.
  client.user.setPresence({ activities: [rpc], status: 'online', afk: false });
}

function buildPresenceFromConfig(client, config, prefix) {
  const rpc = new RichPresence(client)
    .setApplicationId(config.applicationId)
    .setName(config.name || 'Custom RPC');

  if (config.details) rpc.setDetails(config.details);
  if (config.state) rpc.setState(config.state);

  applyAssets(rpc, config, prefix);
  applyButtons(rpc, collectButtonsFromConfig(config, prefix), prefix);
  applyStartTimestamp(rpc, config.startTimestamp, client);

  return rpc;
}

/**
 * Memasang Custom Rich Presence ke client.
 * @param {Client} client Discord client (satu instance per akun)
 * @param {object} [rpcConfig] Konfigurasi RPC gaya account; jika dihilangkan, dibaca dari env (.env legacy)
 * @param {string} [accountName] Nama akun untuk prefix log; jika dihilangkan, memakai prefix [RPC]
 * @returns {?RichPresence} RichPresence yang dipasang, atau null jika dilewati
 */
function setupRichPresence(client, rpcConfig, accountName) {
  const prefix = logPrefix(accountName);
  const config = normalizeRpcConfig(rpcConfig);

  if (!config.enabled) {
    // Pesan legacy dipertahankan untuk mode single-account (.env).
    console.log(accountName ? `${prefix} RPC disabled` : '[RPC] Disabled');
    return null;
  }

  if (!config.applicationId) {
    console.warn(`${prefix} RPC enabled tetapi Application ID kosong, RPC dilewati.`);
    return null;
  }

  console.log(`${prefix} Starting Rich Presence...`);

  const rpc = buildPresenceFromConfig(client, config, prefix);
  sendPresence(client, rpc);

  console.log(accountName ? `${prefix} RPC enabled` : '[RPC] Rich Presence enabled');
  console.log(`${prefix} Application ID: ${maskApplicationId(config.applicationId)}`);
  return rpc;
}

/**
 * Memperbarui Rich Presence saat runtime tanpa me-reset timestamp
 * (kecuali timestamp eksplisit diberikan).
 */
function updateRichPresence(client, options = {}, fallbackConfig, accountName) {
  if (!client || !client.user) throw new Error('Client belum login (client.user tidak tersedia).');

  const prefix = logPrefix(accountName);
  const config = normalizeRpcConfig(fallbackConfig);
  const applicationId = emptyToNull(options.applicationId) || config.applicationId;
  if (!applicationId) throw new Error('Application ID wajib diisi (options.applicationId atau konfigurasi RPC).');

  const rpc = new RichPresence(client)
    .setApplicationId(applicationId)
    .setName(emptyToNull(options.name) || config.name || 'Custom RPC');

  const details = emptyToNull(options.details);
  if (details) rpc.setDetails(details);
  const state = emptyToNull(options.state);
  if (state) rpc.setState(state);
  if (options.type) rpc.setType(options.type);

  try {
    if (emptyToNull(options.largeImage)) rpc.setAssetsLargeImage(options.largeImage.trim());
    else if (config.largeImage) rpc.setAssetsLargeImage(config.largeImage);
    if (emptyToNull(options.largeText)) rpc.setAssetsLargeText(options.largeText.trim());
    else if (config.largeText) rpc.setAssetsLargeText(config.largeText);
    if (emptyToNull(options.smallImage)) rpc.setAssetsSmallImage(options.smallImage.trim());
    else if (config.smallImage) rpc.setAssetsSmallImage(config.smallImage);
    if (emptyToNull(options.smallText)) rpc.setAssetsSmallText(options.smallText.trim());
    else if (config.smallText) rpc.setAssetsSmallText(config.smallText);
  } catch (error) {
    console.warn(`${prefix} Asset dilewati karena tidak valid: ${error.message}`);
  }

  const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
    ? options.buttons.filter((b) => b && b.name && b.url)
    : collectButtonsFromConfig(config, prefix);
  applyButtons(rpc, buttons.slice(0, 2), prefix);

  if (options.startTimestamp === true || (options.startTimestamp === undefined && config.startTimestamp)) {
    applyStartTimestamp(rpc, true, client);
  } else if (typeof options.startTimestamp === 'number' || options.startTimestamp instanceof Date) {
    rpc.setStartTimestamp(options.startTimestamp);
  }

  sendPresence(client, rpc);
  console.log(`${prefix} Rich Presence updated`);
  return rpc;
}

module.exports = {
  setupRichPresence,
  updateRichPresence,
  getRpcConfig,
  normalizeRpcConfig,
};
