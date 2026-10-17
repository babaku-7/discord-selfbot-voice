'use strict';

// Menjalankan semua smoke test (*.smoke.js) secara berurutan, masing-masing
// di proses terpisah supaya terisolasi (timer/listener dari satu test tidak
// bocor ke test lain).
// Jalankan: npm test

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TESTS_DIR = __dirname;
const TIMEOUT_MS = 60000;

const testFiles = fs
  .readdirSync(TESTS_DIR)
  .filter((file) => file.endsWith('.smoke.js'))
  .sort();

if (testFiles.length === 0) {
  console.error('Tidak ada file *.smoke.js ditemukan.');
  process.exit(1);
}

let failed = 0;

for (const file of testFiles) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [path.join(TESTS_DIR, file)], {
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
  });

  if (result.error) {
    console.error(`GAGAL: ${file} (${result.error.message})`);
    failed += 1;
  } else if (result.status !== 0) {
    console.error(`GAGAL: ${file} (exit code ${result.status})`);
    failed += 1;
  } else {
    console.log(`OK: ${file}`);
  }
}

console.log(`\n${testFiles.length - failed}/${testFiles.length} smoke test file lulus.`);
if (failed > 0) process.exitCode = 1;
