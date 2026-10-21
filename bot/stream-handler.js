'use strict';

/**
 * Screenshare (Go Live) handler per akun.
 *
 * Tujuan: menyalakan badge LIVE di voice channel dengan beban seminimal mungkin.
 * Implementasi memakai StreamConnection bawaan library (Go Live / screenshare),
 * bukan camera (selfVideo), karena badge LIVE di daftar member berasal dari stream.
 *
 * Catatan beban: satu proses ffmpeg per akun yang streaming. Default dibuat
 * ringan (480p, 10 fps, bitrate kecil, preset ultrafast) supaya aman di VPS
 * kecil. Naikkan fps/bitrate lewat accounts.json kalau perlu.
 */

const DEFAULT_FPS = 10;
const DEFAULT_BITRATE = 200; // kbps
const RESTART_DELAY_MS = 5000;

function logPrefix(accountName) {
  return accountName ? `[ACCOUNT: ${accountName}]` : '[STREAM]';
}

/**
 * Normalisasi konfigurasi stream dari accounts.json.
 * @param {object} raw Konfigurasi mentah (account.stream)
 * @param {string} [accountName] Nama akun untuk prefix log
 * @returns {?{source: string, fps: number, bitrate: number}}
 */
function normalizeStreamConfig(raw, accountName) {
  const prefix = logPrefix(accountName);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.enabled !== true) return null;

  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  if (!source) {
    console.warn(`${prefix} stream.enabled=true tapi "source" kosong, stream dilewati.`);
    return null;
  }

  const fps = Number.isFinite(raw.fps) && raw.fps > 0 && raw.fps <= 30 ? Math.floor(raw.fps) : DEFAULT_FPS;
  const bitrate = Number.isFinite(raw.bitrate) && raw.bitrate > 0 ? Math.floor(raw.bitrate) : DEFAULT_BITRATE;

  return { source, fps, bitrate };
}

/**
 * Hentikan screenshare yang sedang berjalan untuk satu client (jika ada).
 * @param {Client} client
 */
function stopScreenshare(client) {
  const current = client && client._screenShare;
  if (!current) return;
  client._screenShare = null;
  try {
    current.stop();
  } catch {
    // Diabaikan: koneksi sudah mati.
  }
}

/**
 * Mulai screenshare (Go Live) di voice channel tempat client sudah terhubung.
 * @param {Client} client Discord client (satu instance per akun)
 * @param {object} rawConfig Konfigurasi stream (account.stream)
 * @param {string} [accountName] Nama akun untuk prefix log
 * @returns {Promise<?{stop: Function}>} Handle, atau null kalau dilewati/gagal
 */
async function startScreenshare(client, rawConfig, accountName) {
  const prefix = logPrefix(accountName);
  const config = normalizeStreamConfig(rawConfig, accountName);
  if (!config) return null;

  const connection = client.voice ? client.voice.connection : null;
  if (!connection) {
    console.warn(`${prefix} Belum terhubung ke voice, stream dilewati.`);
    return null;
  }

  // Satu stream per client: bersihkan sisa percobaan sebelumnya.
  stopScreenshare(client);

  let streamConnection;
  let dispatcher;
  let restartTimer = null;
  let stopped = false;
  let frameCount = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    try {
      streamConnection?.sendStopScreenshare();
    } catch {
      // Diabaikan.
    }
    try {
      dispatcher?.destroy();
    } catch {
      // Diabaikan: ffmpeg mungkin sudah mati.
    }
    try {
      streamConnection?.disconnect();
    } catch {
      // Diabaikan.
    }
  };

  const play = () => {
    dispatcher = streamConnection.playVideo(config.source, {
      fps: config.fps,
      bitrate: config.bitrate,
      presetH26x: 'ultrafast',
      highWaterMark: 2,
      // Loop tanpa henti + baca sesuai kecepatan asli supaya CPU tidak dipaksa.
      inputFFmpegArgs: ['-stream_loop', '-1', '-re'],
    });
    // Diagnostik: jumlah frame yang benar-benar keluar dari ffmpeg + status
    // dispatcher, supaya kelihatan apakah paket video benar-benar terkirim.
    frameCount = 0;
    const videoStream = dispatcher && dispatcher.streams ? dispatcher.streams.video : null;
    if (videoStream && typeof videoStream.on === 'function') {
      videoStream.on('data', () => {
        frameCount += 1;
      });
    }
    dispatcher.on('start', () => console.log(`${prefix} Video dispatcher mulai mengirim frame.`));
    // Event ini terpicu tiap paket video; log hanya saat nilainya berubah supaya
    // log tidak banjir (~10 baris/detik).
    let lastVideoStatus = null;
    let lastStreamStatus = null;
    dispatcher.on('videoStatus', (value) => {
      if (value === lastVideoStatus) return;
      lastVideoStatus = value;
      console.log(`${prefix} videoStatus=${value}`);
    });
    dispatcher.on('streamStatus', (value) => {
      if (value === lastStreamStatus) return;
      lastStreamStatus = value;
      console.log(`${prefix} streamStatus(paused)=${value}`);
    });
    dispatcher.on('error', (error) => {
      const message = error && error.message ? error.message : String(error);
      console.warn(`${prefix} Video dispatcher error: ${message}`);
      if (stopped) return;
      if (restartTimer) return;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (stopped) return;
        try {
          play();
        } catch (restartError) {
          console.error(`${prefix} Gagal restart stream: ${restartError.message}`);
        }
      }, RESTART_DELAY_MS);
      restartTimer.unref?.();
    });
    // createStreamConnection() mengirim state awal paused=true; buka supaya
    // penonton benar-benar melihat frame (tanpa ini badge bisa tetap "paused").
    streamConnection.sendScreenshareState(false);
    console.log(
      `${prefix} Screenshare aktif: ${config.source} (${config.fps}fps, ${config.bitrate}kbps)`,
    );
  };

  try {
    streamConnection = await connection.createStreamConnection();
  } catch (error) {
    console.error(`${prefix} Gagal membuat stream connection: ${error.message}`);
    return null;
  }

  if (!streamConnection) {
    console.error(`${prefix} Stream connection tidak tersedia.`);
    return null;
  }

  try {
    play();
  } catch (error) {
    console.error(`${prefix} Gagal memutar video: ${error.message}`);
    try {
      streamConnection.disconnect();
    } catch {
      // Diabaikan.
    }
    return null;
  }

  const handle = { stop, streamConnection, get dispatcher() { return dispatcher; } };
  client._screenShare = handle;

  // Verifikasi nyata dari sisi Discord: saat Go Live aktif, gateway mengirim
  // VOICE_STATE_UPDATE dengan self_stream=true. Ini bukti badge LIVE menyala,
  // bukan cuma "ffmpeg jalan".
  const verifyTimer = setTimeout(() => {
    if (stopped) return;
    try {
      const guildState = connection.channel?.guild?.voiceStates?.cache?.get(client.user.id);
      const clientState = client.voiceStates?.cache?.get(client.user.id);
      // VoiceState menyimpan flag ini sebagai `.streaming`, bukan `.selfStream`.
      const selfStream = Boolean(guildState?.streaming ?? clientState?.streaming);
      console.log(
        `${prefix} Cek badge LIVE: self_stream=${selfStream} | frame terkirim=${frameCount} | udp=${
          streamConnection?.sockets?.udp ? 'ada' : 'tidak ada'
        } | status=${streamConnection?.status}`,
      );
    } catch {
      // Diabaikan: cache belum siap.
    }
  }, 12000);
  verifyTimer.unref?.();

  // Bersihkan otomatis saat voice putus (mis. rejoin/watchdog) supaya proses
  // ffmpeg tidak menggantung.
  connection.once('disconnect', stop);
  streamConnection.once('disconnect', () => {
    if (client._screenShare === handle) client._screenShare = null;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  });

  return handle;
}

module.exports = {
  startScreenshare,
  stopScreenshare,
  normalizeStreamConfig,
};
