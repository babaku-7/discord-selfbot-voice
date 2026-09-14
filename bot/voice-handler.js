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
    await client.voice.joinChannel(channel, { selfMute: true });
    if (prefix) log(`Joining voice channel... Berhasil bergabung: ${channel.name} (Muted)`);
    else console.log(`[INFO] Berhasil bergabung ke voice channel: ${channel.name} (Muted)`);
    if (typeof options.onVoiceConnected === 'function') {
      try {
        options.onVoiceConnected(channel);
      } catch (callbackError) {
        error(`onVoiceConnected gagal: ${callbackError.message}`);
      }
    }
  } catch (err) {
    if (channel && err.message.includes('Connection not established within 15 seconds')) {
      if (prefix) log(`Berhasil bergabung ke voice channel: ${channel.name} (Muted), meskipun ada peringatan timeout.`);
      else {
        console.log(
          `[INFO] Berhasil bergabung ke voice channel: ${channel.name} (Muted), meskipun ada peringatan timeout.`,
        );
      }
    } else {
      if (prefix) error(`Gagal bergabung ke voice channel: ${err.message}`);
      else console.error(`[ERROR] Gagal bergabung ke voice channel: ${err.message}`);
    }
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

  joinVoiceChannel(client, voiceChannelId, options);

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member?.id === client.user.id && oldState.channelId && !newState.channelId) {
      if (prefix) console.log(`${prefix} Koneksi voice terputus. Mencoba bergabung kembali...`);
      else console.log('[WARN] Koneksi voice channel terputus. Mencoba untuk bergabung kembali...');
      setTimeout(() => joinVoiceChannel(client, voiceChannelId, options), 5000);
    }
  });
}

module.exports = {
  setupVoiceChannel,
  joinVoiceChannel,
};
