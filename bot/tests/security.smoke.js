'use strict';

// Memastikan credential material tidak pernah masuk ke event debug.
// Regression: Client.login() dulu meng-emit potongan token (part 1 & 2 utuh,
// sisanya dimask) sehingga "Provided token: abc.def.***" muncul di log.

const assert = require('node:assert');
const { Client } = require('../../src/index.js');

(async () => {
  const token = 'ODk4NzY1NDMy.MTk4NzY1.abcdefghijklmnopqrstuvwxyz';
  const client = new Client({ checkUpdate: false });
  // Jangan benar-benar connect ke gateway Discord.
  client.ws.connect = async () => {};

  const debugEvents = [];
  client.on('debug', (message) => debugEvents.push(String(message)));

  await client.login(token);

  const joined = debugEvents.join('\n');
  for (const part of token.split('.')) {
    assert.ok(
      !joined.includes(part),
      `event debug tidak boleh mengandung bagian token (${part.slice(0, 4)}...)`,
    );
  }
  assert.ok(!joined.includes(token), 'event debug tidak boleh mengandung token utuh');

  try {
    client.destroy();
  } catch {
    // Diabaikan: client belum benar-benar terhubung.
  }

  console.log('PASS: token tidak pernah muncul (walau sebagian) di event debug');
})().catch((error) => {
  console.error('SMOKE TEST GAGAL:', error.message);
  process.exitCode = 1;
});
