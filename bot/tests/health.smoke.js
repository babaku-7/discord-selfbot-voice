'use strict';

// Smoke test health endpoint:
// - readiness: 200 kalau minimal 1 akun ready, 503 kalau tidak ada.
// - liveness: /health/live selalu 200.
// - route selain itu: 404.
// - HEALTH_TOKEN opsional: 401 tanpa/salah token saat diaktifkan.
// - binding: non-loopback tanpa token -> fallback ke 127.0.0.1.
// - response TIDAK pernah mengandung token/credential.

const assert = require('node:assert');
const { STATUS } = require('../account-manager.js');
const { createHealthServer, isLoopbackHost, resolveHealthBinding } = require('../health.js');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

(async () => {
  // 1. Ada akun ready -> 200; isi response aman.
  {
    const registry = new Map([
      ['ready-acc', { status: STATUS.VOICE_CONNECTED, account: { token: 'RAHASIA-SUPER' }, client: {} }],
      ['login-acc', { status: STATUS.LOGGING_IN, account: { token: 'RAHASIA-SUPER' }, client: {} }],
    ]);
    const server = createHealthServer(registry);
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(res.status, 200, 'ada akun ready -> 200');
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
      assert.strictEqual(body.ready, 1);
      assert.strictEqual(body.total, 2);
      assert.deepStrictEqual(
        body.accounts.map((account) => account.name).sort(),
        ['login-acc', 'ready-acc'],
      );
      assert.ok(!JSON.stringify(body).includes('RAHASIA-SUPER'), 'response tidak boleh membocorkan token');
      assert.ok(!JSON.stringify(body).includes('token'), 'field token tidak boleh ada di response');

      const live = await fetch(`http://127.0.0.1:${port}/health/live`);
      assert.strictEqual(live.status, 200, 'liveness selalu 200');
      const liveBody = await live.json();
      assert.strictEqual(liveBody.alive, true);

      const notFound = await fetch(`http://127.0.0.1:${port}/`);
      assert.strictEqual(notFound.status, 404, 'route selain /health -> 404');
      const notFound2 = await fetch(`http://127.0.0.1:${port}/debug`);
      assert.strictEqual(notFound2.status, 404, 'route selain /health -> 404');

      console.log('PASS 1: /health 200 saat ada akun ready, /health/live 200, route lain 404, tanpa token');
    } finally {
      await close(server);
    }
  }

  // 2. Semua akun belum ready / error -> 503.
  {
    const registry = new Map([
      ['a', { status: STATUS.ERROR }],
      ['b', { status: STATUS.STARTING }],
      ['c', { status: STATUS.VOICE_CONNECTING }],
    ]);
    const server = createHealthServer(registry);
    const port = await listen(server);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(res.status, 503, 'tidak ada akun ready -> 503');
      const body = await res.json();
      assert.strictEqual(body.status, 'unavailable');
      assert.strictEqual(body.ready, 0);
      assert.strictEqual(body.total, 3);
      console.log('PASS 2: /health 503 saat tidak ada akun ready (starting/logging_in/voice_connecting belum dihitung)');
    } finally {
      await close(server);
    }
  }

  // 3. HEALTH_TOKEN: proteksi opsional.
  {
    const registry = new Map([['a', { status: STATUS.READY }]]);
    const server = createHealthServer(registry, { token: 'secret-token' });
    const port = await listen(server);
    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(noToken.status, 401, 'tanpa token -> 401');

      const wrongToken = await fetch(`http://127.0.0.1:${port}/health/live`, {
        headers: { authorization: 'Bearer salah' },
      });
      assert.strictEqual(wrongToken.status, 401, 'token salah -> 401');

      const noTokenUnknownRoute = await fetch(`http://127.0.0.1:${port}/debug`);
      assert.strictEqual(noTokenUnknownRoute.status, 401, 'semua route tertutup token (bukan hanya /health)');

      const withToken = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      assert.strictEqual(withToken.status, 200, 'token benar -> 200');

      const liveWithToken = await fetch(`http://127.0.0.1:${port}/health/live`, {
        headers: { authorization: 'Bearer secret-token' },
      });
      assert.strictEqual(liveWithToken.status, 200, 'liveness dengan token -> 200');

      console.log('PASS 3: HEALTH_TOKEN (401 tanpa/salah token, 200 dengan token, semua route terlindungi)');
    } finally {
      await close(server);
    }
  }

  // 4. resolveHealthBinding: non-loopback tanpa token -> fallback 127.0.0.1.
  {
    assert.deepStrictEqual(resolveHealthBinding('0.0.0.0', null), { host: '127.0.0.1', downgraded: true });
    assert.deepStrictEqual(resolveHealthBinding('0.0.0.0', '   '), { host: '127.0.0.1', downgraded: true });
    assert.deepStrictEqual(resolveHealthBinding(' 0.0.0.0 ', undefined), { host: '127.0.0.1', downgraded: true });
    assert.deepStrictEqual(resolveHealthBinding('0.0.0.0', 'secret-token'), { host: '0.0.0.0', downgraded: false });
    assert.deepStrictEqual(resolveHealthBinding('127.0.0.1', null), { host: '127.0.0.1', downgraded: false });
    assert.deepStrictEqual(resolveHealthBinding('localhost', null), { host: 'localhost', downgraded: false });
    assert.deepStrictEqual(resolveHealthBinding('::1', null), { host: '::1', downgraded: false });
    assert.deepStrictEqual(resolveHealthBinding('', null), { host: '127.0.0.1', downgraded: false });
    assert.strictEqual(isLoopbackHost('127.0.0.1'), true);
    assert.strictEqual(isLoopbackHost('localhost'), true);
    assert.strictEqual(isLoopbackHost('::1'), true);
    assert.strictEqual(isLoopbackHost('0.0.0.0'), false);
    console.log('PASS 4: resolveHealthBinding — non-loopback tanpa token di-fallback ke 127.0.0.1');
  }

  console.log('Semua smoke test health lulus.');
})().catch((error) => {
  console.error('SMOKE TEST GAGAL:', error.message);
  process.exitCode = 1;
});
