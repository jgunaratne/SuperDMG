#!/usr/bin/env node
// Runs a ROM without a browser and reports what happened. Useful for debugging the
// core and for poking at test ROMs.
//
//   node tools/run_rom.mjs game.gb --seconds 10 --png out/shot.png
//   node tools/run_rom.mjs test.gb --break            # stop at LD B,B (Mooneye style)
//   node tools/run_rom.mjs game.gb --press "start@120+6,a@200+6" --frames 400 --text

import path from 'node:path';
import fs from 'node:fs';
import {
  boot, runSeconds, runUntilBreak, mooneyePassed, blarggMemoryResult, microtestResult,
  screenHash, writeScreenshot, compareScreen, screenText, registers, hex,
} from './harness.mjs';

function usage() {
  console.error(`usage: node tools/run_rom.mjs <rom> [options]
  --seconds N     emulated seconds to run (default 5)
  --frames N      run exactly N frames instead
  --break         run until the ROM executes LD B,B (max --seconds, default 120)
  --press SPEC    scripted input, comma separated "button@frame+hold" (needs --frames)
  --png FILE      write a screenshot of the final frame
  --scale N       screenshot scale (default 2)
  --expect FILE   compare the final frame with a reference PNG
  --text          print the final frame as text`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (!args.length || args[0].startsWith('--')) usage();
const rom = args[0];
const opt = {};
for (let i = 1; i < args.length; i++) {
  const key = args[i].replace(/^--/, '');
  if (key === 'break' || key === 'text') opt[key] = true;
  else opt[key] = args[++i];
}

const gb = boot(rom);
const { header } = gb.cart;
console.log(`${path.basename(rom)}: "${header.title}" ${gb.cart.typeName}, ` +
    `${gb.cart.romBanks * 16} KiB ROM, ${gb.cart.ram.length} bytes RAM` +
    (header.cgbOnly ? ' (Game Boy Color only)' : ''));

let reachedBreak = null;
if (opt.break) {
  reachedBreak = runUntilBreak(gb, Number(opt.seconds || 120));
  gb.runFrame(); // let the frame in progress finish so the screenshot is complete
} else if (opt.frames) {
  const presses = (opt.press || '').split(',').filter(Boolean).map((spec) => {
    const m = /^(\w+)@(\d+)(?:\+(\d+))?$/.exec(spec.trim());
    if (!m) throw new Error(`bad --press entry "${spec}"`);
    return { button: m[1], from: Number(m[2]), to: Number(m[2]) + Number(m[3] || 4) };
  });
  for (let frame = 0; frame < Number(opt.frames); frame++) {
    for (const p of presses) {
      if (frame === p.from) gb.setButton(p.button, true);
      if (frame === p.to) gb.setButton(p.button, false);
    }
    gb.runFrame();
  }
} else {
  runSeconds(gb, Number(opt.seconds || 5));
}

console.log(`cycles: ${gb.cycles}  frames: ${gb.ppu.frameCount}  screen: ${screenHash(gb)}`);
console.log(registers(gb));
if (gb.serialText) console.log(`serial: ${JSON.stringify(gb.serialText)}`);
if (reachedBreak !== null) {
  console.log(reachedBreak
    ? `breakpoint reached: registers ${mooneyePassed(gb) ? 'signal PASS' : 'do not signal a pass'}`
    : 'breakpoint not reached');
}
const mem = gb.cart.ram.length ? blarggMemoryResult(gb) : null;
if (mem) console.log(`result block: status $${hex(mem.status)} ${JSON.stringify(mem.text)}`);
const micro = microtestResult(gb);
if (micro.verdict === 0x01 || micro.verdict === 0xff) {
  console.log(`microtest: actual $${hex(micro.actual)} expected $${hex(micro.expected)} ` +
      `${micro.passed ? 'PASS' : 'FAIL'}`);
}
if (opt.text) console.log(screenText(gb));
if (opt.png) {
  fs.mkdirSync(path.dirname(path.resolve(opt.png)), { recursive: true });
  writeScreenshot(gb, opt.png, Number(opt.scale || 2));
  console.log(`wrote ${opt.png}`);
}
if (opt.expect) {
  const cmp = compareScreen(gb, opt.expect);
  console.log(cmp.match ? 'screen matches reference'
    : `screen differs from reference: ${cmp.different} pixels, first at (${cmp.first.x}, ${cmp.first.y})`);
  if (!cmp.match) process.exitCode = 1;
}
