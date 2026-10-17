'use strict';

// Smoke test voice-handler tanpa koneksi Discord nyata.
// Jalankan: node bot/tests/voice-handler.smoke.js
//
// Menguji tiga perilaku penting (regression test):
// 1. Join awal yang gagal di-retry otomatis (bukan zombie).
// 2. Koneksi voice basi di-disconnect sebelum rejoin (anti-leak/OOM).
// 3. Watchdog memaksa rejoin walaupun tidak ada event yang terpicu.

const assert = require('node:assert');
const { setupVoiceChannel } = require('../voice-handler.js');

const CHANNEL_ID = '123456789012345678';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient() {
  const state = { attempts: 0, staleDisconnects: 0 };
  const channel = { id: CHANNEL_ID, name: 'test-voice', isVoice: () => true };

  const client = {
    user: { id: '1' },
    listeners: {},
    on(event, handler) {
      (this.listeners[event] = this.listeners[event] || []).push(handler);
    },
    channels: { fetch: async () => channel },
    voice: { connection: null },
  };

  client.voice.joinChannel = async () => {
    state.attempts += 1;
    if (state.attempts < 2) throw new Error('Connection not established within 15 seconds');
    const connection = {
      channel,
      status: 0,
      once() {},
      disconnect() {
        state.staleDisconnects += 1;
      },
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
    setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-retry',
      reconnectDelay: 50,
      watchdogInterval: 100000,
    });
    await sleep(300);
    assert.strictEqual(state.attempts, 2, `harus retry setelah gagal (attempts=${state.attempts})`);
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
    setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-stale',
      reconnectDelay: 50,
      watchdogInterval: 100000,
    });
    await sleep(300);
    assert.ok(state.staleDisconnects >= 1, 'koneksi basi harus di-disconnect');
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
    setupVoiceChannel(client, CHANNEL_ID, {
      accountName: 'test-watchdog',
      reconnectDelay: 50,
      watchdogInterval: 100,
    });
    await sleep(450);
    assert.ok(state.attempts >= 2, `watchdog harus memicu rejoin (attempts=${state.attempts})`);
    console.log('PASS 3: watchdog memicu rejoin tanpa event');
  }

  console.log('Semua smoke test lulus.');
})().catch((error) => {
  console.error('SMOKE TEST GAGAL:', error.message);
  process.exitCode = 1;
});
