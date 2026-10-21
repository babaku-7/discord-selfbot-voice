'use strict';

// Smoke test screenshare handler:
// - normalize: clamp fps/bitrate, default, source wajib.
// - start: playVideo dipanggil sekali + stream di-unpause (paused=false).
// - stop: dispatcher dihancurkan, disconnect() dipanggil, dan
//   sendStopScreenshare() TIDAK dipanggil (kalau dipanggil, disconnect()
//   berikutnya jadi no-op dan WS stream jadi zombie).
// - start kedua: stream lama dihentikan dulu (tidak menumpuk ffmpeg).
// - ffmpeg 'close': restart otomatis, dengan batas MAX_RESTARTS.

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { startScreenshare, stopScreenshare, normalizeStreamConfig, MAX_RESTARTS } = require('../stream-handler.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeClient() {
  const created = [];
  const streamConnection = new EventEmitter();
  streamConnection.status = 0;
  streamConnection.sockets = { udp: {} };
  streamConnection.disconnectCalls = 0;
  streamConnection.stopScreenshareCalls = 0;
  streamConnection.pauseStates = [];
  streamConnection.disconnect = () => {
    streamConnection.disconnectCalls += 1;
  };
  streamConnection.sendStopScreenshare = () => {
    streamConnection.stopScreenshareCalls += 1;
  };
  streamConnection.sendScreenshareState = (paused) => {
    streamConnection.pauseStates.push(paused);
  };
  streamConnection.playVideo = () => {
    const ffmpeg = new EventEmitter();
    ffmpeg.destroyed = false;
    ffmpeg.destroy = () => {
      ffmpeg.destroyed = true;
    };
    const dispatcher = new EventEmitter();
    dispatcher.streams = { ffmpeg };
    dispatcher.destroyed = false;
    dispatcher.destroy = () => {
      dispatcher.destroyed = true;
      ffmpeg.destroy();
    };
    created.push({ dispatcher, ffmpeg });
    return dispatcher;
  };

  const connection = new EventEmitter();
  connection.channel = { id: 'chan-1', guild: { voiceStates: { cache: new Map() } } };
  connection.createStreamConnection = async () => streamConnection;

  const client = {
    user: { id: 'user-1' },
    voice: { connection },
    voiceStates: { cache: new Map() },
  };

  return { client, connection, streamConnection, created };
}

const baseConfig = { enabled: true, source: '/tmp/video.mp4', fps: 5, bitrate: 100, restartDelayMs: 1 };

(async () => {
  // 1. Normalisasi + clamp.
  {
    assert.strictEqual(normalizeStreamConfig({ enabled: false, source: 'x' }), null, 'enabled=false -> null');
    assert.strictEqual(normalizeStreamConfig({ enabled: true }), null, 'source kosong -> null');
    assert.deepStrictEqual(
      (({ fps, bitrate }) => ({ fps, bitrate }))(normalizeStreamConfig({ enabled: true, source: 'x', fps: 0.5, bitrate: 0.5 })),
      { fps: 1, bitrate: 1 },
      'fps/bitrate pecahan tidak boleh jadi 0',
    );
    assert.deepStrictEqual(
      (({ fps, bitrate }) => ({ fps, bitrate }))(normalizeStreamConfig({ enabled: true, source: 'x', fps: 31, bitrate: 999999 })),
      { fps: 30, bitrate: 8000 },
      'nilai di atas batas harus di-clamp',
    );
    const defaults = normalizeStreamConfig({ enabled: true, source: 'x' });
    assert.strictEqual(defaults.fps, 10);
    assert.strictEqual(defaults.bitrate, 200);
    console.log('PASS 1: normalize clamp + default');
  }

  // 2. Start: playVideo sekali, stream di-unpause.
  {
    const { client, streamConnection, created } = makeFakeClient();
    const handle = await startScreenshare(client, baseConfig, 'test-start');
    assert.ok(handle, 'handle harus ada');
    assert.strictEqual(created.length, 1, 'playVideo dipanggil sekali');
    assert.deepStrictEqual(streamConnection.pauseStates, [false], 'stream harus di-unpause');
    assert.strictEqual(client._screenShare, handle, 'handle tersimpan di client');
    handle.stop();
    console.log('PASS 2: start memutar video + unpause');
  }

  // 3. Stop: destroy dispatcher + disconnect sekali, TANPA sendStopScreenshare.
  {
    const { client, streamConnection, created } = makeFakeClient();
    const handle = await startScreenshare(client, baseConfig, 'test-stop');
    handle.stop();
    assert.strictEqual(created[0].dispatcher.destroyed, true, 'dispatcher harus dihancurkan');
    assert.strictEqual(streamConnection.disconnectCalls, 1, 'disconnect dipanggil sekali');
    assert.strictEqual(
      streamConnection.stopScreenshareCalls,
      0,
      'sendStopScreenshare tidak boleh dipanggil manual (penyebab zombie WS)',
    );
    handle.stop();
    assert.strictEqual(streamConnection.disconnectCalls, 1, 'stop() harus idempotent');
    console.log('PASS 3: stop bersih & idempotent tanpa zombie WS');
  }

  // 4. Start kedua menghentikan stream lama.
  {
    const { client, streamConnection, created } = makeFakeClient();
    const first = await startScreenshare(client, baseConfig, 'test-dup');
    const second = await startScreenshare(client, baseConfig, 'test-dup');
    assert.strictEqual(created.length, 2, 'dua kali playVideo');
    assert.strictEqual(streamConnection.disconnectCalls, 1, 'stream lama diputus dulu');
    assert.strictEqual(created[0].dispatcher.destroyed, true, 'dispatcher lama dihancurkan');
    assert.notStrictEqual(first, second, 'handle baru dibuat');
    second.stop();
    console.log('PASS 4: start ganda tidak menumpuk stream');
  }

  // 5. ffmpeg close -> restart otomatis (dengan delay config).
  {
    const { client, created } = makeFakeClient();
    const handle = await startScreenshare(client, baseConfig, 'test-restart');
    created[0].ffmpeg.emit('close');
    const deadline = Date.now() + 1000;
    while (created.length < 2 && Date.now() < deadline) await sleep(5);
    assert.strictEqual(created.length, 2, 'ffmpeg close harus memicu restart');
    handle.stop();
    console.log('PASS 5: restart saat ffmpeg berhenti');
  }

  // 6. Restart dibatasi MAX_RESTARTS.
  {
    const { client, created } = makeFakeClient();
    const handle = await startScreenshare(client, baseConfig, 'test-cap');
    for (let i = 0; i < MAX_RESTARTS + 3; i += 1) {
      const latest = created[created.length - 1];
      if (!latest) break;
      latest.ffmpeg.emit('close');
      const deadline = Date.now() + 1500;
      while (created.length === i + 1 && Date.now() < deadline) await sleep(5);
    }
    assert.ok(
      created.length <= 1 + MAX_RESTARTS,
      `restart harus dibatasi (${created.length} > ${1 + MAX_RESTARTS})`,
    );
    handle.stop();
    console.log(`PASS 6: restart dibatasi (total playVideo=${created.length}, maks=${1 + MAX_RESTARTS})`);
  }

  // 7. stopScreenshare melepas handle client.
  {
    const { client } = makeFakeClient();
    await startScreenshare(client, baseConfig, 'test-helper');
    assert.ok(client._screenShare, 'handle terpasang');
    stopScreenshare(client);
    assert.strictEqual(client._screenShare, null, 'handle dilepas');
    console.log('PASS 7: stopScreenshare melepas handle');
  }

  console.log('\nSemua smoke test stream-handler lulus.');
})().catch((error) => {
  console.error('GAGAL:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
