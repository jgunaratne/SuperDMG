#!/usr/bin/env node
// Builds a "what does real hardware show, and when" table from GBMicrotest ROMs.
//
// Most of these tests share one shape: do something (boot, or switch the LCD on),
// wait an exact number of machine cycles, read one register, compare it with a
// constant. This tool prints, for each test, how many cycles after the reference
// event the measuring access happens and what value the hardware returned there
// (the constant the ROM compares against), next to what this emulator returned.
//
//   node tools/microtable.mjs poweron_stat lcdon_to_stat
//
// Cycle counts are "machine cycles elapsed when the access completes", counted from
// reset, or from the LCDC write that turned the LCD on if the test does that.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, microtestResult, hex } from './harness.mjs';
import { CYCLES_PER_SECOND } from '../src/core/gameboy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test-roms', 'gbmicrotest');

function measure(file) {
  const gb = boot(file);
  let done = false;
  let lcdOnAt = null;
  let last = null;
  const watched = (addr) => (addr >= 0x8000 && addr < 0xa000) || (addr >= 0xfe00 && addr < 0xff80) || addr === 0xffff;
  const read = gb.read.bind(gb);
  const write = gb.write.bind(gb);
  const where = () => `line=${String(gb.ppu.line).padStart(3)} dot=${String(gb.ppu.dot).padStart(3)}`;
  gb.read = (addr) => {
    const v = read(addr);
    if (watched(addr)) last = { kind: 'R', addr, v, at: gb.cycles, where: where() };
    return v;
  };
  gb.write = (addr, v) => {
    if (addr === 0xff82) done = true;
    else if (addr === 0xff40) {
      if ((v & 0x80) && !(gb.ppu.lcdc & 0x80)) lcdOnAt = gb.cycles;
    } else if (addr !== 0xff80 && addr !== 0xff81 && watched(addr)) {
      last = { kind: 'W', addr, v, at: gb.cycles, where: where() };
    }
    write(addr, v);
  };
  const dispatch = gb.cpu.dispatchInterrupt.bind(gb.cpu);
  gb.cpu.dispatchInterrupt = () => {
    last = { kind: 'IRQ', addr: gb.cpu.pc, v: gb.iflag & gb.ie, at: gb.cycles, where: where() };
    dispatch();
  };
  const limit = (/is_if_set_during_ime0/.test(file) ? 0.5 : 0.07) * CYCLES_PER_SECOND;
  while (!done && gb.cycles < limit && !gb.cpu.locked) gb.cpu.step();
  return { result: microtestResult(gb), done, lcdOnAt, last };
}

const prefixes = process.argv.slice(2);
const names = fs.readdirSync(DIR).filter((f) => f.endsWith('.gb'))
  .filter((f) => !prefixes.length || prefixes.some((p) => f.startsWith(p))).sort();
for (const name of names) {
  const { result, done, lcdOnAt, last } = measure(path.join(DIR, name));
  const status = result.passed ? 'ok  ' : done ? 'FAIL' : 'none';
  let access = '(no access)';
  if (last) {
    const since = lcdOnAt !== null && last.at >= lcdOnAt ? `lcd+${last.at - lcdOnAt}` : `boot+${last.at}`;
    access = `${since.padEnd(10)} ${last.kind} ${hex(last.addr, 4)}=${hex(last.v)} ${last.where}`;
  }
  console.log(`${status} ${name.replace('.gb', '').padEnd(32)} got ${hex(result.actual)} want ${hex(result.expected)} | ${access}`);
}
