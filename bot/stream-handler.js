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
const MIN_FPS = 1;
const MAX_FPS = 30;
const MIN_BITRATE = 1;
const MAX_BITRATE = 8000;
const DEFAULT_RESTART_DELAY_MS = 5000;
const MAX_RESTART_DELAY_MS = 60000;
const MAX_RESTARTS = 10;

function logPrefix(accountName) {
  return accountName ? `[ACCOUNT: ${accountName}]` : '[STREAM]';
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Normalisasi konfigurasi stream dari accounts.json.
 * fps/bitrate di-clamp eksplisit supaya nilai aneh (0.5, 31, 999999) tidak
 * menghasilkan dispatcher rusak (mis. TIMESTAMP_INC = 90000/0 = Infinity).
 * @param {object} raw Konfigurasi mentah (account.stream)
 * @param {string} [accountName] Nama akun untuk prefix log
 * @returns {?{source: string, fps: number, bitrate: number, restartDelayMs: number}}
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

  const fps = Number.isFinite(raw.fps) ? clampInt(raw.fps, MIN_FPS, MAX_FPS) : DEFAULT_FPS;
  const bitrate = Number.isFinite(raw.bitrate)
    ? clampInt(raw.bitrate, MIN_BITRATE, MAX_BITRATE)
    : DEFAULT_BITRATE;
  const restartDelayMs = Number.isFinite(raw.restartDelayMs)
    ? clampInt(raw.restartDelayMs, 1, MAX_RESTART_DELAY_MS)
    : DEFAULT_RESTART_DELAY_MS;

  return { source, fps, bitrate, restartDelayMs };
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
  let statsTimer = null;
  let restartCount = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
    // Matikan encoder lebih dulu supaya ffmpeg tidak hidup lebih lama dari stream.
    try {
      dispatcher?.destroy();
    } catch {
      // Diabaikan: ffmpeg mungkin sudah mati.
    }
    // JANGAN panggil sendStopScreenshare() di sini. Method itu men-set flag
    // internal (#requestDisconnect) yang membuat disconnect() berikutnya
    // langsung return, sehingga WS/UDP tidak pernah ditutup dan WS rekonek
    // sendiri (zombie). disconnect() sudah mengirim STREAM_DELETE.
    try {
      streamConnection?.disconnect();
    } catch {
      // Diabaikan.
    }
  };

  const scheduleRestart = (reason) => {
    if (stopped || restartTimer) return;
    if (restartCount >= MAX_RESTARTS) {
      console.error(`${prefix} Stream berhenti (${reason}) setelah ${restartCount}x restart, menyerah.`);
      return;
    }
    const delay = Math.min(config.restartDelayMs * 2 ** restartCount, MAX_RESTART_DELAY_MS);
    restartCount += 1;
    console.warn(`${prefix} Stream berhenti (${reason}). Restart ke-${restartCount} dalam ${delay} ms.`);
    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopped) return;
      try {
        play();
      } catch (restartError) {
        console.error(`${prefix} Gagal restart stream: ${restartError.message}`);
        scheduleRestart('restart gagal');
      }
    }, delay);
    restartTimer.unref?.();
  };

  function play() {
    dispatcher = streamConnection.playVideo(config.source, {
      fps: config.fps,
      bitrate: config.bitrate,
      presetH26x: 'ultrafast',
      highWaterMark: 2,
      // Loop tanpa henti + baca sesuai kecepatan asli supaya CPU tidak dipaksa.
      inputFFmpegArgs: ['-stream_loop', '-1', '-re'],
      // Library hanya memaksa keyframe sekali di detik ke-2 (`-force_key_frames
      // 00:02`), sehingga penonton yang bergabung belakangan tidak pernah dapat
      // keyframe dan layarnya hitam. Paksa GOP pendek (~2 detik) supaya tiap
      // penonton baru bisa decode dalam ~2 detik.
      outputFFmpegArgs: ['-g', String(config.fps * 2), '-keyint_min', String(config.fps)],
    });

    // BaseDispatcher merutekan error stream video ke event 'debug' (bukan
    // 'error') karena tidak ada audio dispatcher, jadi restart dipicu oleh
    // 'close' dari proses ffmpeg.
    const ffmpegStream = dispatcher && dispatcher.streams ? dispatcher.streams.ffmpeg : null;
    if (ffmpegStream && typeof ffmpegStream.once === 'function') {
      ffmpegStream.once('close', () => scheduleRestart('ffmpeg berhenti'));
    }
    if (typeof dispatcher.on === 'function') {
      dispatcher.on('error', (error) => {
        const message = error && error.message ? error.message : String(error);
        console.warn(`${prefix} Video dispatcher error: ${message}`);
      });
      dispatcher.once('start', () => console.log(`${prefix} Video dispatcher mulai mengirim frame.`));
      // Event ini terpicu tiap paket video; log hanya saat nilainya berubah
      // supaya log tidak banjir (~fps baris/detik).
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
    }

    // createStreamConnection() mengirim state awal paused=true; buka supaya
    // penonton benar-benar melihat frame (tanpa ini badge bisa tetap "paused").
    streamConnection.sendScreenshareState(false);
    console.log(`${prefix} Screenshare aktif: ${config.source} (${config.fps}fps, ${config.bitrate}kbps)`);

    // Diagnostik penonton: Discord mengirim STREAM_UPDATE berisi viewer_ids tiap
    // kali ada yang (berhenti) menonton. Tanpa log ini "tidak bisa ditonton"
    // tidak bisa dibedakan antara penonton tidak pernah tersambung atau
    // tersambung tapi frame tidak ter-decode.
    if (typeof streamConnection.on === 'function') {
      streamConnection.on('streamUpdate', (oldData, newData) => {
        const viewers = newData && Array.isArray(newData.viewerIds) ? newData.viewerIds : [];
        const before = oldData && Array.isArray(oldData.viewerIds) ? oldData.viewerIds.length : 0;
        console.log(
          `${prefix} Stream update: viewer=${viewers.length} (sebelum ${before}) | region=${
            newData && newData.region ? newData.region : '-'
          } | paused=${newData ? newData.isPaused : '-'}`,
        );
      });
    }

    // Bukti paket benar-benar dikirim library (dispatcher.count naik per paket
    // RTP). Kalau angka ini diam sementara ffmpeg hidup, masalahnya di
    // dispatcher, bukan di encoder.
    if (typeof streamConnection.on === 'function') {
      streamConnection.on('debug', (message) => {
        const text = String(message);
        // Hanya kejadian penting: WS ditutup / error / negosiasi DAVE.
        if (/\[WS\]|dave|error|closed/i.test(text)) console.log(`${prefix} stream debug: ${text}`);
      });
    }

    statsTimer = setInterval(() => {
      if (stopped) return;
      const packets = dispatcher && Number.isFinite(dispatcher.count) ? dispatcher.count : -1;
      const viewers = streamConnection && Array.isArray(streamConnection.viewerIds)
        ? streamConnection.viewerIds.length
        : 0;
      const dave = streamConnection && streamConnection.dave ? streamConnection.dave : null;
      const daveReady = Boolean(dave && dave.session && dave.session.ready);
      console.log(
        `${prefix} stat stream: paket=${packets} | viewer=${viewers} | status=${streamConnection?.status}` +
          ` | dave_neg=${dave ? dave.negotiated : '-'} dave_v=${dave ? dave.version : '-'} dave_ready=${daveReady}` +
          ` | mode=${streamConnection?.authentication?.mode ?? '-'}`,
      );
    }, 30000);
    statsTimer.unref?.();
  }

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

  const handle = {
    stop,
    streamConnection,
    get dispatcher() {
      return dispatcher;
    },
  };
  client._screenShare = handle;

  // Bersihkan otomatis saat voice putus (mis. rejoin/watchdog) supaya proses
  // ffmpeg tidak menggantung. stop() idempotent, jadi aman dipanggil berlapis.
  connection.once('disconnect', stop);
  streamConnection.once('disconnect', () => {
    if (client._screenShare === handle) client._screenShare = null;
    stop();
  });

  // Verifikasi nyata dari sisi Discord: saat Go Live aktif, gateway mengirim
  // VOICE_STATE_UPDATE dengan self_stream=true (dipetakan sebagai `.streaming`).
  const verifyTimer = setTimeout(() => {
    if (stopped) return;
    try {
      const guildState = connection.channel?.guild?.voiceStates?.cache?.get(client.user.id);
      const clientState = client.voiceStates?.cache?.get(client.user.id);
      const selfStream = Boolean(guildState?.streaming ?? clientState?.streaming);
      console.log(
        `${prefix} Cek badge LIVE: self_stream=${selfStream} | udp=${
          streamConnection?.sockets?.udp ? 'ada' : 'tidak ada'
        } | status=${streamConnection?.status} | restart=${restartCount}`,
      );
    } catch {
      // Diabaikan: cache belum siap.
    }
  }, 12000);
  verifyTimer.unref?.();

  return handle;
}

module.exports = {
  startScreenshare,
  stopScreenshare,
  normalizeStreamConfig,
  MAX_FPS,
  MAX_BITRATE,
  MAX_RESTARTS,
};
