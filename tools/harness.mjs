// Shared helpers for running ROMs headlessly: used by tools/run_rom.mjs and the tests.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GameBoy, CYCLES_PER_SECOND } from '../src/core/gameboy.js';
import { decodePng, encodePng, shadesToRgba, REFERENCE_GREYS } from './png.mjs';

/** Creates a machine with the given ROM file inserted. Serial output is collected. */
export function boot(romPath, options) {
  const gb = new GameBoy();
  gb.loadRom(fs.readFileSync(romPath), options);
  gb.serialText = '';
  gb.serial.onByte = (byte) => { gb.serialText += String.fromCharCode(byte); };
  return gb;
}

/** Runs for a number of emulated seconds, or until `stop()` returns true. */
export function runSeconds(gb, seconds, stop) {
  const limit = gb.cycles + Math.round(seconds * CYCLES_PER_SECOND);
  while (gb.cycles < limit) {
    gb.runFrame();
    if (gb.cpu.locked || (stop && stop())) break;
  }
}

/**
 * Runs until the program executes LD B,B, the breakpoint convention used by the
 * Mooneye, acid2 and Mealybug test ROMs.
 * @return {boolean} whether the breakpoint was reached within the time limit
 */
export function runUntilBreak(gb, maxSeconds = 120) {
  let hit = false;
  const previous = gb.cpu.onBreak;
  gb.cpu.onBreak = () => { hit = true; };
  const cpu = gb.cpu;
  const limit = gb.cycles + Math.round(maxSeconds * CYCLES_PER_SECOND);
  while (!hit && gb.cycles < limit && !cpu.locked) cpu.step();
  gb.cpu.onBreak = previous;
  return hit;
}

/** Mooneye tests report success by leaving Fibonacci numbers in the registers. */
export function mooneyePassed(gb) {
  const c = gb.cpu;
  return c.b === 3 && c.c === 5 && c.d === 8 && c.e === 13 && c.h === 21 && c.l === 34;
}

/**
 * Blargg's newer tests publish their result in cartridge RAM: a signature at $A001,
 * a status byte at $A000 ($80 while running, 0 for success) and text from $A004.
 */
export function blarggMemoryResult(gb) {
  const ram = gb.cart.ram;
  if (ram.length < 8 || ram[1] !== 0xde || ram[2] !== 0xb0 || ram[3] !== 0x61) return null;
  let text = '';
  for (let i = 4; i < ram.length && ram[i] !== 0; i++) text += String.fromCharCode(ram[i]);
  return { status: ram[0], running: ram[0] === 0x80, passed: ram[0] === 0, text };
}

/**
 * Runs one of Blargg's tests to completion, using whichever result channel it has
 * (serial text or the cartridge RAM block).
 */
export function runBlargg(gb, maxSeconds = 60) {
  let seenMemory = false;
  runSeconds(gb, maxSeconds, () => {
    if (/Passed|Failed/.test(gb.serialText)) return true;
    const mem = blarggMemoryResult(gb);
    if (mem) {
      if (mem.running) seenMemory = true;
      else if (seenMemory) return true;
    }
    return false;
  });
  const mem = blarggMemoryResult(gb);
  if (mem && seenMemory && !mem.running) return { passed: mem.passed, output: mem.text.trim() };
  return { passed: /Passed/.test(gb.serialText), output: gb.serialText.trim() };
}

/** GBMicrotest ROMs leave actual / expected / verdict at $FF80-$FF82. */
export function microtestResult(gb) {
  return { actual: gb.hram[0], expected: gb.hram[1], verdict: gb.hram[2], passed: gb.hram[2] === 0x01 };
}

export function screenHash(gb) {
  return crypto.createHash('sha1').update(gb.ppu.display).digest('hex').slice(0, 12);
}

export function writeScreenshot(gb, file, scale = 2, colors = REFERENCE_GREYS) {
  const rgba = shadesToRgba(gb.ppu.display, colors, scale);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, encodePng(160 * scale, 144 * scale, rgba));
}

/**
 * Compares the screen with a reference screenshot that uses the standard four greys.
 * @return {{match: boolean, different: number, first: ?{x: number, y: number}}}
 */
export function compareScreen(gb, pngPath) {
  const ref = decodePng(fs.readFileSync(pngPath));
  if (ref.width !== 160 || ref.height !== 144) throw new Error(`${pngPath}: expected a 160x144 image`);
  const display = gb.ppu.display;
  let different = 0;
  let first = null;
  for (let i = 0; i < 160 * 144; i++) {
    const want = 3 - Math.round(ref.data[i * 4] / 85); // white = shade 0
    if (display[i] !== want) {
      different++;
      if (!first) first = { x: i % 160, y: (i / 160) | 0 };
    }
  }
  return { match: different === 0, different, first };
}

/** Renders the screen as text, handy for eyeballing failures in a terminal. */
export function screenText(gb) {
  const glyphs = [' ', '.', 'o', '#'];
  const rows = [];
  for (let y = 0; y < 144; y += 2) {
    let row = '';
    for (let x = 0; x < 160; x++) {
      row += glyphs[Math.max(gb.ppu.display[y * 160 + x], gb.ppu.display[(y + 1) * 160 + x])];
    }
    rows.push(row.replace(/\s+$/, ''));
  }
  return rows.join('\n');
}

export const hex = (v, digits = 2) => v.toString(16).toUpperCase().padStart(digits, '0');

export function registers(gb) {
  const c = gb.cpu;
  return `AF=${hex(c.af, 4)} BC=${hex(c.bc, 4)} DE=${hex(c.de, 4)} HL=${hex(c.hl, 4)} ` +
      `SP=${hex(c.sp, 4)} PC=${hex(c.pc, 4)} IME=${c.ime ? 1 : 0}` +
      (c.halted ? ' HALT' : '') + (c.locked ? ` LOCKED(op ${hex(c.lockedOpcode)})` : '');
}
