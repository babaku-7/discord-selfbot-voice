'use strict';

// Smoke test account-manager tanpa koneksi Discord nyata (pakai FakeClient):
// 1. Validasi account (token kosong, channel kosong, nama duplikat, rpc invalid).
// 2. Precedence path accounts.json via env ACCOUNTS_PATH.
// 3. Mode legacy (.env) -> allowEnvFallback true; multi-account -> false.
// 4. Startup multi-account: akun tanpa channel TIDAK fallback ke env; akun
//    dengan channel join normal; stopAll cleanup (termasuk disconnect voice).
// 5. Login gagal -> status error.
// 6. Lifecycle gateway: reconnecting -> pulih; timeout -> error; fatal
//    (shardDisconnect/invalidated) -> error; lastError & lastReadyAt tercatat.

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const {
  STATUS,
  validateAccount,
  accountFromEnv,
  getAccountsSearchPaths,
  startAll,
  stopAll,
} = require('../account-manager.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.user = { id: '1', tag: 'fake#0001' };
    this.destroyed = false;
    this.fetchCalls = [];
    this.joins = 0;
    this.connectionDisconnects = 0;
    this.voice = { connection: null };
    this.channels = {
      fetch: async (id) => {
        this.fetchCalls.push(id);
        return { id, name: 'voice-test', isVoice: () => true };
      },
    };
    this.voice.joinChannel = async (channel) => {
      this.joins += 1;
      const connection = {
        channel,
        status: 0,
        once() {},
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

class FailingLoginClient extends FakeClient {
  login() {
    return Promise.reject(new Error('token tidak valid'));
  }
}

(async () => {
  // 1. Validasi account.
  {
    const usedNames = new Set();

    const skipped = validateAccount({ name: 'a' }, 0, usedNames);
    assert.strictEqual(skipped.skipped, true, 'token kosong harus di-skip');

    const acc = validateAccount({ name: 'b', token: 'tok', voiceChannelId: '' }, 1, usedNames);
    assert.strictEqual(acc.skipped, false);
    assert.strictEqual(acc.account.voiceChannelId, null);
    assert.strictEqual(acc.account.allowEnvFallback, false, 'multi-account tidak boleh fallback env');

    const acc2 = validateAccount(
      { name: 'b', token: 'tok', voiceChannelId: 'ch-1', rpc: ['invalid'] },
      2,
      usedNames,
    );
    assert.strictEqual(acc2.account.name, 'b-3', 'nama duplikat harus di-unique-kan');
    assert.strictEqual(acc2.account.voiceChannelId, 'ch-1');
    assert.strictEqual(acc2.account.rpc, null, 'rpc invalid harus dinonaktifkan');

    console.log('PASS 1: validasi account (token kosong, channel kosong, nama duplikat, rpc invalid)');
  }

  // 2. Precedence path accounts.json.
  {
    const previous = process.env.ACCOUNTS_PATH;
    process.env.ACCOUNTS_PATH = '/custom/accounts.json';
    try {
      const paths = getAccountsSearchPaths();
      assert.strictEqual(paths[0], '/custom/accounts.json', 'ACCOUNTS_PATH harus jadi kandidat pertama');
      assert.ok(paths.length >= 4, 'path bawaan tetap disertakan sebagai fallback');
    } finally {
      if (previous === undefined) delete process.env.ACCOUNTS_PATH;
      else process.env.ACCOUNTS_PATH = previous;
    }
    console.log('PASS 2: precedence path accounts.json (ACCOUNTS_PATH dulu, lalu path bawaan)');
  }

  // 3. Mode legacy (.env) boleh fallback ke env.
  {
    const previousToken = process.env.DISCORD_TOKEN;
    const previousChannel = process.env.VOICE_CHANNEL_ID;
    process.env.DISCORD_TOKEN = 'env-token';
    process.env.VOICE_CHANNEL_ID = 'env-channel';
    try {
      const acc = accountFromEnv();
      assert.strictEqual(acc.voiceChannelId, 'env-channel');
      assert.strictEqual(acc.allowEnvFallback, true, 'mode legacy boleh fallback ke env');
    } finally {
      if (previousToken === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = previousToken;
      if (previousChannel === undefined) delete process.env.VOICE_CHANNEL_ID;
      else process.env.VOICE_CHANNEL_ID = previousChannel;
    }
    console.log('PASS 3: accountFromEnv (legacy) -> allowEnvFallback=true');
  }

  // 4. Multi-account: channel kosong tidak fallback ke env; channel ada join; stopAll cleanup.
  {
    const previousChannel = process.env.VOICE_CHANNEL_ID;
    process.env.VOICE_CHANNEL_ID = 'global-channel';
    try {
      TrackingClient.instances = [];
      const registry = startAll(
        [
          { name: 'no-voice', token: 't1', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } },
          { name: 'with-voice', token: 't2', voiceChannelId: 'ch-2', allowEnvFallback: false, rpc: { enabled: false } },
        ],
        { Client: TrackingClient },
      );
      const [noVoice, withVoice] = TrackingClient.instances;
      noVoice.emit('ready');
      withVoice.emit('ready');
      await sleep(100);

      assert.strictEqual(noVoice.fetchCalls.length, 0, 'akun tanpa channel tidak boleh fetch channel mana pun');
      assert.strictEqual(noVoice.joins, 0, 'akun tanpa channel tidak boleh join voice');
      assert.strictEqual(registry.get('no-voice').status, STATUS.READY, 'akun tanpa voice tetap ready (login sukses)');

      assert.ok(withVoice.fetchCalls.includes('ch-2'), 'akun dengan channel harus fetch channel sendiri');
      assert.ok(
        !withVoice.fetchCalls.includes('global-channel'),
        'tidak boleh fetch env channel di mode multi-account',
      );
      assert.strictEqual(registry.get('with-voice').status, STATUS.VOICE_CONNECTED);

      // stopAll: cleanup voice handler (disconnect voice aktif) + destroy client.
      stopAll(registry);
      assert.strictEqual(noVoice.destroyed, true);
      assert.strictEqual(withVoice.destroyed, true);
      assert.strictEqual(withVoice.listenerCount('voiceStateUpdate'), 0, 'listener voice harus dibersihkan saat stop');
      assert.strictEqual(withVoice.listenerCount('ready'), 0, 'listener ready harus dibersihkan saat stop');
      assert.strictEqual(withVoice.connectionDisconnects, 1, 'stopAll harus disconnect voice connection aktif');
      assert.strictEqual(withVoice.voice.connection, null, 'referensi voice connection harus dibersihkan');

      console.log('PASS 4: multi-account tanpa channel tidak fallback env + stopAll disconnect voice');
    } finally {
      if (previousChannel === undefined) delete process.env.VOICE_CHANNEL_ID;
      else process.env.VOICE_CHANNEL_ID = previousChannel;
    }
  }

  // 5. Login gagal -> status error (akun lain tidak terpengaruh).
  {
    const registry = startAll(
      [{ name: 'fail', token: 't', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } }],
      { Client: FailingLoginClient },
    );
    await sleep(50);
    assert.strictEqual(registry.get('fail').status, STATUS.ERROR, 'login gagal harus berstatus error');
    console.log('PASS 5: login gagal -> status error');
  }

  // 6. Lifecycle gateway: grace period, recovery, timeout, fatal.
  {
    TrackingClient.instances = [];
    const registry = startAll(
      [
        { name: 'life-a', token: 't1', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } },
        { name: 'life-b', token: 't2', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } },
        { name: 'life-c', token: 't3', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } },
        { name: 'life-d', token: 't4', voiceChannelId: null, allowEnvFallback: false, rpc: { enabled: false } },
      ],
      { Client: TrackingClient, reconnectGraceMs: 60 },
    );
    const [clientA, clientB, clientC, clientD] = TrackingClient.instances;
    clientA.emit('ready');
    clientB.emit('ready');
    clientC.emit('ready');
    clientD.emit('ready');
    await sleep(20);
    assert.strictEqual(registry.get('life-a').status, STATUS.READY);
    assert.ok(registry.get('life-a').lastReadyAt > 0, 'lastReadyAt harus tercatat');

    // Error runtime hanya dicatat; status belum turun (masih bisa pulih).
    clientA.emit('error', new Error('ws glitch sementara'));
    assert.strictEqual(registry.get('life-a').lastError.message, 'ws glitch sementara');
    assert.ok(registry.get('life-a').lastError.at > 0, 'lastError.at harus tercatat');
    assert.strictEqual(registry.get('life-a').status, STATUS.READY, 'error runtime tidak boleh langsung menurunkan status');

    // Gateway putus -> reconnecting; pulih sebelum grace -> ready lagi.
    clientA.emit('shardReconnecting');
    assert.strictEqual(registry.get('life-a').status, STATUS.RECONNECTING);
    clientA.emit('shardResume');
    assert.strictEqual(registry.get('life-a').status, STATUS.READY);
    await sleep(150); // melewati grace 60ms: timer harus sudah dibatalkan
    assert.strictEqual(registry.get('life-a').status, STATUS.READY, 'tidak boleh turun ke error setelah pulih');
    console.log('PASS 6: reconnecting -> resume -> ready (grace dibatalkan, error runtime tercatat)');

    // Gateway putus dan tidak pulih -> setelah grace turun ke error.
    clientB.emit('shardReconnecting');
    assert.strictEqual(registry.get('life-b').status, STATUS.RECONNECTING);
    await sleep(150);
    assert.strictEqual(registry.get('life-b').status, STATUS.ERROR, 'harus turun ke error setelah grace habis');

    // Recovery terlambat tetap memulihkan status.
    clientB.emit('shardReady');
    assert.strictEqual(registry.get('life-b').status, STATUS.READY, 'recovery terlambat harus memulihkan status');
    console.log('PASS 7: reconnect timeout -> error; recovery terlambat -> ready');

    // Fatal: shardDisconnect langsung error (tanpa menunggu grace).
    clientC.emit('shardDisconnect');
    assert.strictEqual(registry.get('life-c').status, STATUS.ERROR, 'shardDisconnect harus langsung error');

    // Fatal: sesi invalid -> error + client di-destroy.
    clientD.emit('invalidated');
    assert.strictEqual(registry.get('life-d').status, STATUS.ERROR, 'invalidated harus langsung error');
    assert.strictEqual(clientD.destroyed, true, 'invalidated harus men-destroy client');
    console.log('PASS 8: shardDisconnect & invalidated (fatal) -> error langsung');

    stopAll(registry);
  }

  console.log('Semua smoke test account-manager lulus.');
})().catch((error) => {
  console.error('SMOKE TEST GAGAL:', error.message);
  process.exitCode = 1;
});
