'use strict';

const process = require('node:process');
const { setTimeout } = require('node:timers');

const ENV_VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID;

function logPrefix(accountName) {
  return accountName ? `[ACCOUNT: ${accountName}]` : null;
}

/**
 * Bergabung ke voice channel untuk satu client.
 * @param {Client} client Discord client (satu instance per akun)
 * @param {string} [voiceChannelId] ID voice channel; jika dihilangkan, dipakai process.env.VOICE_CHANNEL_ID
 * @param {object} [options] Opsi tambahan
 * @param {string} [options.accountName] Nama akun untuk prefix log
 * @param {Function} [options.onVoiceConnected] Dipanggil setelah berhasil bergabung (channel)
 */
async function joinVoiceChannel(client, voiceChannelId, options = {}) {
  const channelId = voiceChannelId || ENV_VOICE_CHANNEL_ID;
  const prefix = logPrefix(options.accountName);
  const log = (message) => console.log(prefix ? `${prefix} ${message}` : message);
  const warn = (message) => console.warn(prefix ? `${prefix} ${message}` : message);
  const error = (message) => console.error(prefix ? `${prefix} ${message}` : message);

  if (!channelId) {
    warn('Voice channel ID kosong, voice dilewati.');
    return;
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
    if (!channel?.isVoice()) {
      // Pesan legacy dipertahankan untuk mode single-account (.env).
      if (prefix) warn(`Voice channel dengan ID ${channelId} tidak ditemukan atau bukan saluran suara.`);
      else {
        console.warn(
          `[WARN] Voice channel dengan ID ${channelId} tidak ditemukan atau bukan saluran suara.`,
        );
      }
      return;
    }
    const connection = await client.voice.joinChannel(channel, { selfMute: true });
    if (prefix) log(`Joining voice channel... Berhasil bergabung: ${channel.name} (Muted)`);
    else console.log(`[INFO] Berhasil bergabung ke voice channel: ${channel.name} (Muted)`);
    if (typeof options.onVoiceConnected === 'function') {
      try {
        options.onVoiceConnected(channel);
      } catch (callbackError) {
        error(`onVoiceConnected gagal: ${callbackError.message}`);
      }
    }
    return connection;
  } catch (err) {
    if (channel && err.message.includes('Connection not established within 15 seconds')) {
      if (prefix) error(`Koneksi ke voice channel timeout: ${channel.name}.`);
      else console.error(`[ERROR] Koneksi ke voice channel timeout: ${channel.name}.`);
    } else {
      if (prefix) error(`Gagal bergabung ke voice channel: ${err.message}`);
      else console.error(`[ERROR] Gagal bergabung ke voice channel: ${err.message}`);
    }
    return null;
  }
}

/**
 * Menyiapkan voice channel untuk satu client, termasuk auto-rejoin
 * saat koneksi terputus. Rejoin hanya berlaku untuk akun tersebut.
 */
function setupVoiceChannel(client, voiceChannelId, options = {}) {
  // Kompatibilitas: setupVoiceChannel(client) memakai VOICE_CHANNEL_ID dari env.
  if (typeof voiceChannelId === 'object' && voiceChannelId !== null) {
    options = voiceChannelId;
    voiceChannelId = undefined;
  }
  const prefix = logPrefix(options.accountName);
  const targetChannelId = voiceChannelId || ENV_VOICE_CHANNEL_ID;

  if (!targetChannelId) {
    return;
  }

  const delay = options.reconnectDelay ?? 5000;
  let reconnectTimer = null;
  let joining = false;
  let activeConnection = null;

  const isConnectedToTarget = () => {
    const connection = client.voice?.connection;
    return Boolean(connection) && connection.channel?.id === targetChannelId && connection.status !== 4;
  };

  const scheduleReconnect = (reason) => {
    if (reconnectTimer || joining || isConnectedToTarget()) return;

    if (prefix) console.log(`${prefix} ${reason} Mencoba bergabung kembali dalam ${delay / 1000} detik...`);
    else console.log(`[WARN] ${reason} Mencoba bergabung kembali dalam ${delay / 1000} detik...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptJoin(true);
    }, delay);
    reconnectTimer.unref?.();
  };

  const attemptJoin = async (retryOnFailure = false) => {
    if (joining || isConnectedToTarget()) return;

    joining = true;
    const connection = await joinVoiceChannel(client, voiceChannelId, options);
    joining = false;

    if (connection) {
      activeConnection = connection;
      connection.once('disconnect', () => {
        if (activeConnection === connection) activeConnection = null;
        if (client.voice.connection === connection) client.voice.connection = null;
        scheduleReconnect('Koneksi voice terputus.');
      });
    } else if (retryOnFailure) {
      scheduleReconnect('Gagal menyambungkan ke voice channel.');
    }
  };

  // Initial join tidak menunggu event voiceStateUpdate supaya tidak race dengan
  // state update yang dikirim Discord saat proses autentikasi voice.
  attemptJoin();

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member?.id !== client.user?.id) return;

    const leftTarget = oldState.channelId === targetChannelId && newState.channelId !== targetChannelId;
    const joinedAnotherChannel = newState.channelId && newState.channelId !== targetChannelId;

    if (leftTarget || joinedAnotherChannel) {
      scheduleReconnect('Koneksi voice channel berubah atau terputus.');
    }
  });

  // Gateway reconnect tidak selalu menghasilkan VOICE_STATE_UPDATE untuk akun
  // sendiri. Cek ulang saat READY diterima kembali.
  client.on('ready', () => {
    if (!isConnectedToTarget()) scheduleReconnect('Gateway tersambung kembali.');
  });
}

module.exports = {
  setupVoiceChannel,
  joinVoiceChannel,
};
