#!/usr/bin/env node
// Shows what a GBMicrotest ROM actually measures: every access to video memory and
// I/O registers up to the point where it stores its verdict, stamped with the machine
// cycle and the PPU position at that moment. This is the tool for lining the
// emulator's timing up with hardware-verified tests.
//
//   node tools/microprobe.mjs <test names or .gb paths...>   (names are relative to
//                                                              test-roms/gbmicrotest)
//   node tools/microprobe.mjs --all-failing [prefix]          one line per failing test
//   TAIL=30 node tools/microprobe.mjs <test>                  show more of the log

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, microtestResult, hex } from './harness.mjs';
import { CYCLES_PER_SECOND } from '../src/core/gameboy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test-roms', 'gbmicrotest');

function probe(file) {
  const gb = boot(file);
  const log = [];
  let done = false;
  const interesting = (addr) => (addr >= 0x8000 && addr < 0xa000) || (addr >= 0xfe00 && addr < 0xff80) || addr === 0xffff;
  const stamp = () => {
    const p = gb.ppu;
    return `c=${String(gb.cycles).padStart(6)} line=${String(p.line).padStart(3)} dot=${String(p.dot).padStart(3)} m=${p.mode}`;
  };
  const read = gb.read.bind(gb);
  const write = gb.write.bind(gb);
  gb.read = (addr) => {
    const v = read(addr);
    if (interesting(addr)) log.push(`${stamp()}  R ${hex(addr, 4)} -> ${hex(v)}`);
    return v;
  };
  gb.write = (addr, v) => {
    if (addr === 0xff82) done = true;
    else if (addr !== 0xff80 && addr !== 0xff81 && interesting(addr)) log.push(`${stamp()}  W ${hex(addr, 4)} <- ${hex(v)}`);
    write(addr, v);
  };
  // Also note when interrupt handlers start, which is what the *_int_* tests time.
  const dispatch = gb.cpu.dispatchInterrupt.bind(gb.cpu);
  gb.cpu.dispatchInterrupt = () => {
    log.push(`${stamp()}  IRQ dispatch (IF=${hex(gb.iflag)} IE=${hex(gb.ie)} pc=${hex(gb.cpu.pc, 4)})`);
    dispatch();
  };
  const limit = (/is_if_set_during_ime0/.test(file) ? 0.5 : 0.07) * CYCLES_PER_SECOND;
  while (!done && gb.cycles < limit && !gb.cpu.locked) gb.cpu.step();
  return { gb, log, result: microtestResult(gb), done };
}

const args = process.argv.slice(2);
if (args[0] === '--all-failing') {
  const prefix = args[1] || '';
  for (const name of fs.readdirSync(DIR).filter((f) => f.endsWith('.gb') && f.startsWith(prefix)).sort()) {
    const { log, result, done } = probe(path.join(DIR, name));
    if (result.passed) continue;
    const last = log.slice(-1)[0] || '(no accesses)';
    console.log(`${name.replace('.gb', '').padEnd(32)} ${done ? `got ${hex(result.actual)} want ${hex(result.expected)}` : 'no verdict     '} | ${last}`);
  }
} else {
  for (const arg of args) {
    const file = fs.existsSync(arg) ? arg : path.join(DIR, arg.endsWith('.gb') ? arg : arg + '.gb');
    const { log, result, done } = probe(file);
    console.log(`=== ${path.basename(file)}: got ${hex(result.actual)} want ${hex(result.expected)} ` +
        `${result.passed ? 'PASS' : done ? 'FAIL' : 'no verdict'}`);
    for (const line of log.slice(-Number(process.env.TAIL || 14))) console.log('  ' + line);
  }
}
