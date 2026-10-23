'use strict';

// Smoke test supervisor voice (tanpa koneksi Discord nyata):
// 1. Akun yang sehat di voice tidak pernah di-relogin.
// 2. Akun yang tidak pernah berhasil masuk voice di-relogin setelah stuckMs,
//    dan hanya akun itu yang disentuh (client lama di-destroy, listener dilepas).
// 3. Akun tanpa voiceChannelId diabaikan.
// 4. Relogin tidak terjadi berulang tanpa jeda (cooldown / timer di-reset).

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { startAll, stopAll, startVoiceSupervisor, isVoiceHealthy } = require('../account-manager.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OK_CHANNEL = '100';
const STUCK_CHANNEL = '200';

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: '1', tag: 'fake#0001' };
    this.destroyed = false;
    this.connectionDisconnects = 0;
    this.voice = { connection: null };
    this.channels = {
      fetch: async (id) => ({ id, name: 'voice-test', isVoice: () => true }),
    };
    this.voice.joinChannel = async (channel) => {
      // Channel "stuck" selalu gagal seperti join timeout 15 detik di produksi.
      if (channel.id === STUCK_CHANNEL) {
        throw new Error('Connection not established within 15 seconds.');
      }
      const connection = {
        channel,
        status: 0,
        once() {},
        off() {},
        disconnect: () => {
          this.connectionDisconnects += 1;
          if (this.voice.connection === connection) this.voice.connection = null;
        },
      };
      this.voice.connection = connection;
      return connection;
    };
  }

  login(token) {
    this.usedToken = token;
    return Promise.resolve(token);
  }

  destroy() {
    this.destroyed = true;
  }
}

class TrackingClient extends FakeClient {
  constructor() {
    super();
    TrackingClient.instances.push(this);
  }
}
TrackingClient.instances = [];

const accounts = [
  { name: 'ok', token: 'token-ok', voiceChannelId: OK_CHANNEL, rpc: { enabled: false } },
  { name: 'stuck', token: 'token-stuck', voiceChannelId: STUCK_CHANNEL, rpc: { enabled: false } },
  { name: 'novoice', token: 'token-novoice', rpc: { enabled: false } },
];

(async () => {
  const registry = startAll(accounts, { Client: TrackingClient });
  assert.strictEqual(TrackingClient.instances.length, 3, 'tiga client harus dibuat');

  // Simulasikan gateway ready untuk semua akun -> voice join dijalankan.
  for (const entry of registry.values()) {
    entry.client.emit('ready');
  }
  await sleep(10);

  const okEntry = registry.get('ok');
  const stuckEntryBefore = registry.get('stuck');
  const novoiceEntry = registry.get('novoice');
  const okClient = okEntry.client;
  const stuckClient = stuckEntryBefore.client;
  const novoiceClient = novoiceEntry.client;

  assert.strictEqual(isVoiceHealthy(okClient, accounts[0]), true, 'akun ok harus sehat');
  assert.strictEqual(isVoiceHealthy(stuckClient, accounts[1]), false, 'akun stuck tidak sehat');

  const supervisor = startVoiceSupervisor(registry, {
    Client: TrackingClient,
    intervalMs: 600000, // timer tidak boleh ikut campur; test memanggil check()
    stuckMs: 5,
  });

  // Tick pertama: hanya mencatat awal kondisi tidak sehat.
  supervisor.check();
  assert.strictEqual(registry.get('stuck').voiceUnhealthySince > 0, true);
  assert.strictEqual(registry.get('ok').voiceUnhealthySince, null);
  assert.strictEqual(TrackingClient.instances.length, 3, 'belum boleh ada relogin');

  await sleep(15);
  // Tick kedua: stuck sudah lewat stuckMs -> relogin akun itu saja.
  supervisor.check();

  assert.strictEqual(TrackingClient.instances.length, 4, 'harus ada satu client baru (relogin)');
  assert.strictEqual(stuckClient.destroyed, true, 'client lama akun stuck harus di-destroy');
  assert.strictEqual(
    stuckClient.listenerCount('error'),
    0,
    'listener client lama harus dilepas sebelum destroy',
  );
  const stuckEntryAfter = registry.get('stuck');
  assert.notStrictEqual(stuckEntryAfter, stuckEntryBefore, 'entri registry harus diganti');
  assert.notStrictEqual(stuckEntryAfter.client, stuckClient, 'client baru dipakai akun stuck');
  assert.strictEqual(okClient.destroyed, false, 'akun sehat tidak boleh disentuh');
  assert.strictEqual(registry.get('ok'), okEntry, 'entri akun sehat tetap sama');
  assert.strictEqual(novoiceClient.destroyed, false, 'akun tanpa voice tidak boleh disentuh');

  // Client baru langsung dicek lagi: harus menunggu window stuckMs baru,
  // tidak relogin berulang dalam satu waktu.
  supervisor.check();
  assert.strictEqual(TrackingClient.instances.length, 4, 'tidak boleh relogin dobel');

  // Akun sehat yang koneksinya putus diam-diam harus terdeteksi tidak sehat.
  okClient.voice.connection = null;
  assert.strictEqual(isVoiceHealthy(okClient, accounts[0]), false);
  supervisor.check();
  assert.strictEqual(registry.get('ok').voiceUnhealthySince > 0, true);

  supervisor.stop();
  stopAll(registry);

  console.log('voice-supervisor.smoke.js OK');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
