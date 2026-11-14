// Shared helpers for the unit tests.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { assemble, finishRom } from '../tools/asm.mjs';
import { GameBoy } from '../src/core/gameboy.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Assembles a test program into a ROM image. The source starts at $0150; the entry
 * point at $0100 jumps there. Interrupt vectors can be placed with `org`.
 */
export function buildRom(source, header = {}) {
  const { bytes } = assemble(`
  org $0100
  nop
  jp $0150
  org $0150
${source}
`, { size: header.size || 0x8000 });
  return finishRom(bytes, { title: 'TEST', ...header });
}

/** A machine running the given assembly program. */
export function machine(source, header) {
  const gb = new GameBoy();
  gb.loadRom(buildRom(source, header));
  return gb;
}

/** Runs until the CPU reaches `LD B,B` (the test programs' "done" marker). */
export function runToBreak(gb, maxCycles = 2_000_000) {
  let done = false;
  gb.cpu.onBreak = () => { done = true; };
  const limit = gb.cycles + maxCycles;
  while (!done && gb.cycles < limit) gb.cpu.step();
  if (!done) throw new Error('program did not reach its breakpoint');
  return gb;
}

export function demoRom() {
  return fs.readFileSync(path.join(ROOT, 'roms/demo.gb'));
}

/** A blank ROM image of the given size with a valid header, for mapper tests. */
export function blankRom({ type = 0x00, banks = 2, ramSize = 0 } = {}) {
  const bytes = new Uint8Array(banks * 0x4000);
  // Stamp every bank with its own number so tests can tell which one is mapped.
  for (let bank = 0; bank < banks; bank++) {
    bytes[bank * 0x4000 + 0x2000] = bank & 0xff;
    bytes[bank * 0x4000 + 0x2001] = bank >> 8;
  }
  finishRom(bytes, { title: 'MAPPER', type, ramSize });
  return bytes;
}

/**
 * Writes a minimal .zip archive.
 * @param {Array<{name: string, data: Uint8Array, store?: boolean, encrypted?: boolean}>} entries
 * @return {Buffer}
 */
export function makeZip(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const packed = entry.store ? data : zlib.deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.encrypted ? 1 : 0, 6);
    header.writeUInt16LE(entry.store ? 0 : 8, 8);
    header.writeUInt32LE(zlib.crc32(data), 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    header.copy(central, 8, 6, 30); // flags .. name length share the same layout
    central.writeUInt32LE(offset, 42);
    locals.push(header, name, packed);
    directory.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directorySize = directory.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...directory, end]);
}
