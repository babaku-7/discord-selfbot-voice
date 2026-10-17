'use strict';

// Smoke test voice-handler tanpa koneksi Discord nyata.
// Jalankan: node bot/tests/voice-handler.smoke.js
//
// Menguji enam perilaku penting (regression test):
// 1. Join awal yang gagal di-retry otomatis (bukan zombie).
// 2. Koneksi voice basi di-disconnect sebelum rejoin (anti-leak/OOM).
// 3. Watchdog memaksa rejoin walaupun tidak ada event yang terpicu.
// 4. Backoff memperlambat retry (bukan spam tiap 5 detik).
// 5. stop() membersihkan timer + listener (lifecycle tidak bocor).
// 6. Channel kosong di mode multi-account TIDAK fallback ke env VOICE_CHANNEL_ID.

const assert = require('node:assert');
const { setupVoiceChannel } = require('../voice-handler.js');

const CHANNEL_ID = '123456789012345678';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient() {
  const state = { attempts: 0, staleDisconnects: 0, fetchCalls: [] };
  const channel = { id: CHANNEL_ID, name: 'test-voice', isVoice: () => true };
  const listeners = new Map();

  const client = {
    user: { id: '1' },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    off(event, handler) {
      const handlers = listeners.get(event) || [];
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    },
    listenerCount(event) {
      return (listeners.get(event) || []).length;
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) || [])]) handler(...args);
    },
    channels: {
      fetch: async (id) => {
        state.fetchCalls.push(id);
        return channel;
      },
    },
    voice: { connection: null },
  };

  client.voice.joinChannel = async () => {
    state.attempts += 1;
    const connection = {
      channel,
      status: 0,
      once() {},
      disconnect() {},
    };
    client.voice.connection = connection;
    return connection;
  };

  return { client, state };
}

(async () => {
  // 1. Join awal gagal -> retry otomatis -> sukses.
  {
    const { client, state } = makeClient();
    client.voice.joinChannel = async () => {
      state.attempts += 1;
      if (state.attempts < 2) throw new Error('Connection not established within 15 seconds');
      const connection = { channel: { id: CHANNEL_ID }, status: 0, once() {}, disconnect() {} };
      client.voice.connection = connection;
      return connection;
    };
    const handle = setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-retry',
      reconnectDelay: 50,
      watchdogInterval: 100000,
    });
    await sleep(300);
    assert.strictEqual(state.attempts, 2, `harus retry setelah gagal (attempts=${state.attempts})`);
    handle.stop();
    console.log('PASS 1: join awal gagal -> retry otomatis sampai sukses');
  }

  // 2. Koneksi basi (channel berbeda) di-disconnect sebelum join berikutnya.
  {
    const { client, state } = makeClient();
    client.voice.connection = {
      channel: { id: 'channel-lain' },
      status: 0,
      disconnect() {
        state.staleDisconnects += 1;
      },
    };
    const handle = setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-stale',
      reconnectDelay: 50,
      watchdogInterval: 100000,
    });
    await sleep(300);
    assert.ok(state.staleDisconnects >= 1, 'koneksi basi harus di-disconnect');
    handle.stop();
    console.log('PASS 2: koneksi basi di-disconnect sebelum rejoin');
  }

  // 3. Watchdog memicu rejoin tanpa event apa pun (koneksi "mati" status 4).
  {
    const { client, state } = makeClient();
    client.voice.joinChannel = async () => {
      state.attempts += 1;
      const dead = { channel: { id: CHANNEL_ID }, status: 4, once() {}, disconnect() {} };
      client.voice.connection = dead;
      return dead;
    };
    const handle = setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-watchdog',
      reconnectDelay: 50,
      watchdogInterval: 100,
    });
    await sleep(450);
    assert.ok(state.attempts >= 2, `watchdog harus memicu rejoin (attempts=${state.attempts})`);
    handle.stop();
    console.log('PASS 3: watchdog memicu rejoin tanpa event');
  }

  // 4. Backoff: kegagalan beruntun makin jarang, bukan spam tiap jeda awal.
  {
    const { client, state } = makeClient();
    client.voice.joinChannel = async () => {
      state.attempts += 1;
      throw new Error('Connection not established within 15 seconds');
    };
    const handle = setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-backoff',
      reconnectDelay: 50,
      maxReconnectDelay: 2000,
      watchdogInterval: 100000,
    });
    await sleep(1000);
    assert.ok(state.attempts >= 3, `harus ada beberapa percobaan (attempts=${state.attempts})`);
    assert.ok(
      state.attempts <= 9,
      `backoff harus memperlambat retry; tanpa backoff akan ~20 percobaan (attempts=${state.attempts})`,
    );
    handle.stop();
    console.log(`PASS 4: backoff memperlambat retry (attempts=${state.attempts} dalam 1 detik)`);
  }

  // 5. stop() melepas semua listener + mematikan timer (watchdog tidak jalan lagi).
  {
    const { client, state } = makeClient();
    const handle = setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-cleanup',
      reconnectDelay: 50,
      watchdogInterval: 50,
    });
    await sleep(200);
    assert.strictEqual(state.attempts, 1, 'join awal harus sukses sekali');
    assert.strictEqual(client.listenerCount('voiceStateUpdate'), 1);
    assert.strictEqual(client.listenerCount('ready'), 1);

    handle.stop();
    assert.strictEqual(client.listenerCount('voiceStateUpdate'), 0, 'listener voiceStateUpdate harus dilepas');
    assert.strictEqual(client.listenerCount('ready'), 0, 'listener ready harus dilepas');

    // Simulasikan koneksi hilang tanpa event + event yang dulu memicu rejoin.
    client.voice.connection = null;
    client.emit('voiceStateUpdate', { member: { id: '1' }, channelId: CHANNEL_ID }, { member: { id: '1' }, channelId: null });
    client.emit('ready');
    await sleep(250);
    assert.strictEqual(state.attempts, 1, 'setelah stop() tidak boleh ada join attempt (termasuk dari watchdog)');

    handle.stop(); // idempotent
    console.log('PASS 5: stop() membersihkan listener + timer (idempotent)');
  }

  // 6. Channel null: multi-account tidak fallback ke env; legacy tetap fallback.
  {
    const previousChannel = process.env.VOICE_CHANNEL_ID;
    process.env.VOICE_CHANNEL_ID = 'global-channel';
    try {
      // 6a. Multi-account (channel null eksplisit + allowEnvFallback false).
      const multi = makeClient();
      const multiHandle = setupVoiceChannel(multi.client, null, {
        accountName: 'test-null-multi',
        allowEnvFallback: false,
        reconnectDelay: 50,
        watchdogInterval: 100000,
      });
      await sleep(100);
      assert.strictEqual(
        multi.state.fetchCalls.length,
        0,
        'akun multi-account tanpa channel tidak boleh fetch channel apa pun (termasuk env)',
      );
      multiHandle.stop();

      // 6b. Mode legacy (allowEnvFallback true): fallback ke env.
      const legacy = makeClient();
      const legacyHandle = setupVoiceChannel(legacy.client, null, {
        accountName: 'test-null-legacy',
        allowEnvFallback: true,
        reconnectDelay: 50,
        watchdogInterval: 100000,
      });
      await sleep(100);
      assert.ok(legacy.state.fetchCalls.includes('global-channel'), 'mode legacy harus fallback ke env');
      legacyHandle.stop();

      // 6c. Kompat lama: setupVoiceChannel(client) tanpa argumen channel.
      const compat = makeClient();
      const compatHandle = setupVoiceChannel(compat.client, {
        accountName: 'test-compat',
        reconnectDelay: 50,
        watchdogInterval: 100000,
      });
      await sleep(100);
      assert.ok(
        compat.state.fetchCalls.includes('global-channel'),
        'kompat tanpa argumen channel harus tetap fallback ke env',
      );
      compatHandle.stop();

      console.log('PASS 6: channel null tidak fallback ke env (multi-account); legacy tetap fallback');
    } finally {
      if (previousChannel === undefined) delete process.env.VOICE_CHANNEL_ID;
      else process.env.VOICE_CHANNEL_ID = previousChannel;
    }
  }

  console.log('Semua smoke test lulus.');
})().catch((error) => {
  console.error('SMOKE TEST GAGAL:', error.message);
  process.exitCode = 1;
});
