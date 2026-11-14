#!/usr/bin/env node
// Debugging aids for the core.
//
//   node tools/debug.mjs disasm <rom> <addr> [count]     static disassembly of ROM bytes
//   node tools/debug.mjs trace <rom> [maxInstructions]   execution trace with cycle stamps
//
// The trace collapses runs of identical instructions (NOP sleds) and stops at LD B,B,
// a locked CPU, or the instruction limit.

import fs from 'node:fs';
import { disassemble } from '../src/core/disasm.js';
import { boot, registers, hex } from './harness.mjs';

const [mode, rom, ...rest] = process.argv.slice(2);
if (!mode || !rom) {
  console.error('usage: debug.mjs disasm <rom> <addr> [count] | trace <rom> [maxInstructions]');
  process.exit(2);
}

if (mode === 'disasm') {
  const bytes = fs.readFileSync(rom);
  let pc = parseInt(rest[0] ?? '0x100', 16);
  const count = Number(rest[1] ?? 40);
  for (let i = 0; i < count; i++) {
    const { text, length } = disassemble((a) => bytes[a] ?? 0xff, pc);
    const raw = [...bytes.subarray(pc, pc + length)].map((b) => hex(b)).join(' ');
    console.log(`${hex(pc, 4)}  ${raw.padEnd(9)} ${text}`);
    pc += length;
  }
} else if (mode === 'trace') {
  const gb = boot(rom);
  const max = Number(rest[0] ?? 400);
  let stop = false;
  gb.cpu.onBreak = () => { stop = true; };
  let last = '';
  let repeats = 0;
  const flush = () => {
    if (repeats > 0) console.log(`            ... x${repeats} more`);
    repeats = 0;
  };
  for (let i = 0; i < max && !stop && !gb.cpu.locked; i++) {
    const cpu = gb.cpu;
    const ppu = gb.ppu;
    if (!cpu.halted) {
      const { text } = disassemble((a) => gb.peek(a), cpu.pc);
      if (text === last) {
        repeats++;
      } else {
        flush();
        console.log(`c=${String(gb.cycles).padStart(7)} ${hex(cpu.pc, 4)} ${text.padEnd(18)} ` +
            `A=${hex(cpu.a)} F=${hex(cpu.f)} BC=${hex(cpu.bc, 4)} DE=${hex(cpu.de, 4)} HL=${hex(cpu.hl, 4)} ` +
            `| ly=${ppu.ly} line=${ppu.line} dot=${ppu.dot} m=${ppu.mode} IF=${hex(gb.iflag)} IE=${hex(gb.ie)}`);
        last = text;
      }
    } else if (last !== '(halted)') {
      flush();
      console.log(`c=${String(gb.cycles).padStart(7)}      (halted)`);
      last = '(halted)';
    }
    cpu.step();
  }
  flush();
  console.log(`end: c=${gb.cycles} ${registers(gb)}`);
  console.log(`hram: ${[...gb.hram.subarray(0, 4)].map((b) => hex(b)).join(' ')}`);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
