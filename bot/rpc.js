'use strict';

const process = require('node:process');
const { RichPresence } = require('../src/index.js');

let cachedStartTimestamp = null;

function isTruthy(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

function emptyToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function maskApplicationId(applicationId) {
  if (!applicationId || applicationId.length <= 4) return '********';
  return `${'*'.repeat(4)}${applicationId.slice(-4)}`;
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

function collectButtonsFromConfig(config) {
  const buttons = [];
  if (config.button1Name && config.button1Url) {
    buttons.push({ name: config.button1Name, url: config.button1Url });
  } else if (config.button1Name || config.button1Url) {
    console.warn('[RPC] Button 1 tidak lengkap (butuh nama dan URL), dilewati.');
  }
  if (config.button2Name && config.button2Url) {
    buttons.push({ name: config.button2Name, url: config.button2Url });
  } else if (config.button2Name || config.button2Url) {
    console.warn('[RPC] Button 2 tidak lengkap (butuh nama dan URL), dilewati.');
  }
  return buttons;
}

function applyAssets(rpc, config) {
  try {
    if (config.largeImage) rpc.setAssetsLargeImage(config.largeImage);
    if (config.largeText) rpc.setAssetsLargeText(config.largeText);
    if (config.smallImage) rpc.setAssetsSmallImage(config.smallImage);
    if (config.smallText) rpc.setAssetsSmallText(config.smallText);
  } catch (error) {
    console.warn(`[RPC] Asset dilewati karena tidak valid: ${error.message}`);
  }
}

function applyButtons(rpc, buttons) {
  if (buttons.length === 0) return;
  try {
    // Validasi URL + batas 2 button ditangani oleh RichPresence.setButtons().
    rpc.setButtons(...buttons);
  } catch (error) {
    console.warn(`[RPC] Button dilewati karena tidak valid: ${error.message}`);
  }
}

function applyStartTimestamp(rpc, enabled) {
  if (!enabled) return;
  // Dibuat sekali saat RPC pertama aktif; Discord menghitung elapsed time dari nilai ini.
  if (cachedStartTimestamp === null) cachedStartTimestamp = Date.now();
  rpc.setStartTimestamp(cachedStartTimestamp);
}

function sendPresence(client, rpc) {
  // API existing repository: ClientUser#setPresence -> ClientPresence#set
  // -> broadcast STATUS_UPDATE melalui websocket. Tidak ada interval refresh.
  client.user.setPresence({ activities: [rpc], status: 'online', afk: false });
}

function buildPresenceFromConfig(client, config) {
  const rpc = new RichPresence(client)
    .setApplicationId(config.applicationId)
    .setName(config.name || 'Custom RPC');

  if (config.details) rpc.setDetails(config.details);
  if (config.state) rpc.setState(config.state);

  applyAssets(rpc, config);
  applyButtons(rpc, collectButtonsFromConfig(config));
  applyStartTimestamp(rpc, config.startTimestamp);

  return rpc;
}

function setupRichPresence(client) {
  const config = getRpcConfig();

  if (!config.enabled) {
    console.log('[RPC] Disabled');
    return null;
  }

  if (!config.applicationId) {
    console.warn('[RPC] RPC_ENABLED=true tetapi RPC_APPLICATION_ID kosong. Rich Presence dilewati.');
    return null;
  }

  console.log('[RPC] Starting Rich Presence...');

  const rpc = buildPresenceFromConfig(client, config);
  sendPresence(client, rpc);

  console.log('[RPC] Rich Presence enabled');
  console.log(`[RPC] Application ID: ${maskApplicationId(config.applicationId)}`);
  return rpc;
}

function updateRichPresence(client, options = {}) {
  if (!client || !client.user) throw new Error('Client belum login (client.user tidak tersedia).');

  const config = getRpcConfig();
  const applicationId = emptyToNull(options.applicationId) || config.applicationId;
  if (!applicationId) throw new Error('Application ID wajib diisi (options.applicationId atau RPC_APPLICATION_ID).');

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
    console.warn(`[RPC] Asset dilewati karena tidak valid: ${error.message}`);
  }

  const buttons = Array.isArray(options.buttons) && options.buttons.length > 0
    ? options.buttons.filter((b) => b && b.name && b.url)
    : collectButtonsFromConfig(config);
  applyButtons(rpc, buttons.slice(0, 2));

  if (options.startTimestamp === true || (options.startTimestamp === undefined && config.startTimestamp)) {
    applyStartTimestamp(rpc, true);
  } else if (typeof options.startTimestamp === 'number' || options.startTimestamp instanceof Date) {
    rpc.setStartTimestamp(options.startTimestamp);
  }

  sendPresence(client, rpc);
  console.log('[RPC] Rich Presence updated');
  return rpc;
}

module.exports = {
  setupRichPresence,
  updateRichPresence,
  getRpcConfig,
};
