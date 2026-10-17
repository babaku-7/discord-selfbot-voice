'use strict';

const process = require('node:process');
const { setTimeout } = require('node:timers');

function logPrefix(accountName) {
  return accountName ? `[ACCOUNT: ${accountName}]` : null;
}

/**
 * Resolusi ID voice channel target untuk satu akun.
 *
 * Aturan fallback ke env VOICE_CHANNEL_ID:
 * - Hanya berlaku untuk pemanggilan legacy tanpa argumen channel sama sekali
 *   (mis. setupVoiceChannel(client) / joinVoiceChannel(client)), atau
 * - saat options.allowEnvFallback === true secara eksplisit (mode single-account).
 *
 * Akun multi-account selalu mengirim voiceChannelId eksplisit (null jika kosong)
 * + allowEnvFallback: false, sehingga channel kosong berarti voice dilewati dan
 * TIDAK pernah fallback ke VOICE_CHANNEL_ID global.
 * @param {?string} voiceChannelId ID voice channel (null/'' = kosong)
 * @param {object} [options]
 * @param {boolean} [options.allowEnvFallback] Izinkan fallback ke env VOICE_CHANNEL_ID
 * @returns {?string} ID channel efektif, atau null jika voice harus dilewati
 */
function resolveVoiceChannelId(voiceChannelId, options = {}) {
  if (typeof voiceChannelId === 'string' && voiceChannelId.trim()) return voiceChannelId.trim();

  const allowEnvFallback = options.allowEnvFallback ?? voiceChannelId === undefined;
  if (!allowEnvFallback) return null;

  const envChannelId =
    typeof process.env.VOICE_CHANNEL_ID === 'string' ? process.env.VOICE_CHANNEL_ID.trim() : '';
  return envChannelId || null;
}

/**
 * Bergabung ke voice channel untuk satu client.
 * @param {Client} client Discord client (satu instance per akun)
 * @param {string} [voiceChannelId] ID voice channel; fallback ke env hanya untuk pemanggilan legacy (lihat resolveVoiceChannelId)
 * @param {object} [options] Opsi tambahan
 * @param {string} [options.accountName] Nama akun untuk prefix log
 * @param {boolean} [options.allowEnvFallback] Izinkan fallback ke env VOICE_CHANNEL_ID
 * @param {Function} [options.onVoiceConnected] Dipanggil setelah berhasil bergabung (channel)
 */
async function joinVoiceChannel(client, voiceChannelId, options = {}) {
  const channelId = resolveVoiceChannelId(voiceChannelId, options);
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
 * @param {object} [options]
 * @param {string} [options.accountName] Nama akun untuk prefix log
 * @param {boolean} [options.allowEnvFallback] Izinkan fallback ke env VOICE_CHANNEL_ID
 * @param {Function} [options.onVoiceConnected] Dipanggil setelah berhasil bergabung
 * @param {number} [options.reconnectDelay] Jeda awal rejoin dalam ms (default 5000, naik eksponensial saat gagal berulang)
 * @param {number} [options.maxReconnectDelay] Batas maksimum jeda rejoin dalam ms (default 300000)
 * @param {number} [options.watchdogInterval] Interval watchdog dalam ms (default 60000)
 * @returns {{ stop: Function }} Handle cleanup: menghentikan timer rejoin/watchdog
 *   dan melepas seluruh listener yang dipasang.
 */
function setupVoiceChannel(client, voiceChannelId, options = {}) {
  // Kompatibilitas: setupVoiceChannel(client) memakai VOICE_CHANNEL_ID dari env.
  if (typeof voiceChannelId === 'object' && voiceChannelId !== null) {
    options = voiceChannelId;
    voiceChannelId = undefined;
  }
  const prefix = logPrefix(options.accountName);
  const targetChannelId = resolveVoiceChannelId(voiceChannelId, options);

  if (!targetChannelId) {
    return { stop() {} };
  }

  const baseDelay = options.reconnectDelay ?? 5000;
  const maxDelay = options.maxReconnectDelay ?? 300000;
  let currentDelay = baseDelay;
  let reconnectTimer = null;
  let joining = false;
  let activeConnection = null;
  let stopped = false;

  const isConnectedToTarget = () => {
    const connection = client.voice?.connection;
    return Boolean(connection) && connection.channel?.id === targetChannelId && connection.status !== 4;
  };

  const scheduleReconnect = (reason) => {
    if (stopped || reconnectTimer || joining || isConnectedToTarget()) return;

    // Backoff eksponensial: kegagalan berulang (mis. voice state update
    // di-throttle Discord) tidak boleh di-spam terus tiap 5 detik.
    const seconds = currentDelay / 1000;
    if (prefix) console.log(`${prefix} ${reason} Mencoba bergabung kembali dalam ${seconds} detik...`);
    else console.log(`[WARN] ${reason} Mencoba bergabung kembali dalam ${seconds} detik...`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptJoin(true);
    }, currentDelay);
    reconnectTimer.unref?.();
    currentDelay = Math.min(currentDelay * 2, maxDelay);
  };

  const handleConnectionDisconnect = () => {
    const connection = activeConnection;
    activeConnection = null;
    if (connection && client.voice && client.voice.connection === connection) {
      client.voice.connection = null;
    }
    if (!stopped) scheduleReconnect('Koneksi voice terputus.');
  };

  const attemptJoin = async (retryOnFailure = false) => {
    if (stopped || joining || isConnectedToTarget()) return;

    joining = true;
    let retryNeeded = false;
    try {
      // Putuskan koneksi voice basi sebelum rejoin. Library memakai ulang objek
      // VoiceConnection yang sama, sehingga websocket/UDP socket dan listener
      // 'closing' dari percobaan yang gagal menumpuk dan memori terus tumbuh
      // (penyebab proses kena OOM). disconnect() menutup semuanya dengan bersih.
      const stale = client.voice ? client.voice.connection : null;
      if (stale && !(stale.channel && stale.channel.id === targetChannelId && stale.status !== 4)) {
        if (stale.status !== 4) {
          try {
            stale.disconnect();
          } catch {
            // Diabaikan: koneksi basi, referensinya tetap dibuang di bawah.
          }
        }
        if (client.voice.connection === stale) client.voice.connection = null;
      }

      const connection = await joinVoiceChannel(client, voiceChannelId, options);
      if (stopped) {
        // Proses sedang dihentikan: jangan tinggalkan koneksi menggantung.
        if (connection && typeof connection.disconnect === 'function') {
          try {
            connection.disconnect();
          } catch {
            // Diabaikan: proses sedang shutdown.
          }
        }
        return;
      }

      if (connection) {
        currentDelay = baseDelay;
        activeConnection = connection;
        connection.once('disconnect', handleConnectionDisconnect);
      } else if (retryOnFailure) {
        // Retry dijadwalkan SETELAH `joining` di-reset (lihat di bawah) supaya
        // guard di scheduleReconnect() tidak memblokir percobaan ulang.
        retryNeeded = true;
      }
    } catch (error) {
      if (!stopped) {
        if (prefix) console.error(`${prefix} Join voice gagal: ${error.message}`);
        else console.error(`[ERROR] Join voice gagal: ${error.message}`);
        if (retryOnFailure) retryNeeded = true;
      }
    } finally {
      joining = false;
    }

    if (retryNeeded && !stopped) {
      scheduleReconnect('Gagal menyambungkan ke voice channel.');
    }
  };

  const handleVoiceStateUpdate = (oldState, newState) => {
    if (oldState.member?.id !== client.user?.id) return;

    const leftTarget = oldState.channelId === targetChannelId && newState.channelId !== targetChannelId;
    const joinedAnotherChannel = newState.channelId && newState.channelId !== targetChannelId;

    if (leftTarget || joinedAnotherChannel) {
      scheduleReconnect('Koneksi voice channel berubah atau terputus.');
    }
  };

  // Gateway reconnect tidak selalu menghasilkan VOICE_STATE_UPDATE untuk akun
  // sendiri. Cek ulang saat READY diterima kembali.
  const handleReady = () => {
    if (!isConnectedToTarget()) scheduleReconnect('Gateway tersambung kembali.');
  };

  // Initial join tidak menunggu event voiceStateUpdate supaya tidak race dengan
  // state update yang dikirim Discord saat proses autentikasi voice.
  // Retry diaktifkan: kegagalan join pertama (mis. timeout) tidak boleh
  // meninggalkan bot "online tapi tidak berada di voice" tanpa percobaan ulang.
  attemptJoin(true);

  client.on('voiceStateUpdate', handleVoiceStateUpdate);
  client.on('ready', handleReady);

  // Watchdog: jaring pengaman terakhir. Kalau tidak ada event apa pun yang
  // terpicu (koneksi mati diam-diam), paksa rejoin secara berkala.
  const watchdog = setInterval(() => {
    if (!joining && !isConnectedToTarget()) {
      scheduleReconnect('Watchdog: tidak terhubung ke voice channel.');
    }
  }, options.watchdogInterval ?? 60000);
  watchdog.unref?.();

  const stop = () => {
    if (stopped) return;
    stopped = true;

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearInterval(watchdog);

    if (typeof client.off === 'function') {
      client.off('voiceStateUpdate', handleVoiceStateUpdate);
      client.off('ready', handleReady);
    }
    if (activeConnection && typeof activeConnection.off === 'function') {
      activeConnection.off('disconnect', handleConnectionDisconnect);
    }
  };

  return { stop };
}

module.exports = {
  setupVoiceChannel,
  joinVoiceChannel,
  resolveVoiceChannelId,
};
