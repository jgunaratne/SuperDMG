import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikeZip, romFromZip } from '../src/ui/unzip.js';
import { demoRom, makeZip } from './helpers.mjs';

const text = (s) => new TextEncoder().encode(s);

test('finds and inflates the ROM inside an archive', async () => {
  const rom = demoRom();
  const zip = makeZip([
    { name: 'readme.txt', data: text('hello') },
    { name: 'games/Gem Garden.gb', data: rom },
  ]);
  assert.equal(looksLikeZip(zip), true);
  assert.equal(looksLikeZip(rom), false);
  const entry = await romFromZip(new Uint8Array(zip));
  assert.equal(entry.name, 'Gem Garden.gb', 'folder names are dropped');
  assert.ok(Buffer.from(entry.bytes).equals(rom));
});

test('stored (uncompressed) entries and .gbc names work too', async () => {
  const data = new Uint8Array(4096).map((_, i) => i * 7);
  const entry = await romFromZip(new Uint8Array(makeZip([{ name: 'COLOR.GBC', data, store: true }])));
  assert.equal(entry.name, 'COLOR.GBC');
  assert.deepEqual([...entry.bytes], [...data]);
});

test('archives without a ROM, or that cannot be read, are reported', async () => {
  assert.equal(await romFromZip(new Uint8Array(makeZip([{ name: 'notes.txt', data: text('x') }]))), null);
  await assert.rejects(romFromZip(new Uint8Array(makeZip([{ name: 'a.gb', data: text('x'), encrypted: true }]))), /password protected/);
  await assert.rejects(romFromZip(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0])), /damaged or incomplete/);
});

test('reads archives written by the system zip tool', { skip: hasZip() ? false : 'no zip command' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-zip-'));
  try {
    fs.writeFileSync(path.join(dir, 'demo.gb'), demoRom());
    execFileSync('zip', ['-q', '-9', 'rom.zip', 'demo.gb'], { cwd: dir });
    const entry = await romFromZip(new Uint8Array(fs.readFileSync(path.join(dir, 'rom.zip'))));
    assert.equal(entry.name, 'demo.gb');
    assert.ok(Buffer.from(entry.bytes).equals(demoRom()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function hasZip() {
  try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
}
