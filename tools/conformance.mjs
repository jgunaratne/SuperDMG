#!/usr/bin/env node
// Runs the hardware-conformance test ROMs in test-roms/ (see tools/fetch_test_roms.sh)
// and compares the outcome with the committed baseline of tests that are known to pass.
//
//   node tools/conformance.mjs                  all suites, fail on regressions
//   node tools/conformance.mjs mooneye acid2    only these suites (blargg, mooneye,
//                                               wilbertpol, acid2, age, mealybug, mbc3,
//                                               gambatte, gbmicrotest)
//   node tools/conformance.mjs -v gbmicrotest   also list every failing test
//   node tools/conformance.mjs --update         rewrite the baseline from this run
//
// The emulated model is the original Game Boy (DMG-CPU B/C), so tests written for
// other models are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boot, runSeconds, runUntilBreak, runBlargg, mooneyePassed, microtestResult,
  compareScreen, registers, hex,
} from './harness.mjs';
import { CYCLES_PER_SECOND } from '../src/core/gameboy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROMS = path.join(ROOT, 'test-roms');
const BASELINE = path.join(ROOT, 'tests', 'conformance-baseline.json');

function findRoms(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.gbc?$/.test(entry.name)) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const rel = (file, base) => path.relative(base, file).replace(/\.gbc?$/, '');

// Mooneye names tests after the models they pass on: no suffix means every model,
// "dmgABC" and the group letter G include the original Game Boy.
function mooneyeAppliesToDmg(file) {
  const name = path.basename(file).replace(/\.gb$/, '');
  const dash = name.lastIndexOf('-');
  if (dash < 0) return true;
  const models = name.slice(dash + 1);
  return /dmgABC/.test(models) || /^G/.test(models);
}

function mooneyeCase(file, base) {
  return {
    name: rel(file, base),
    run() {
      const gb = boot(file);
      if (!runUntilBreak(gb, 120)) return { passed: false, detail: `no breakpoint; ${registers(gb)}` };
      return { passed: mooneyePassed(gb), detail: registers(gb) };
    },
  };
}

function blarggCase(file, base, seconds = 60) {
  return {
    name: rel(file, base),
    run() {
      const result = runBlargg(boot(file), seconds);
      return { passed: result.passed, detail: result.output.replace(/\s+/g, ' ').slice(-70) };
    },
  };
}

function screenshotCase(name, file, reference, prepare) {
  return {
    name,
    run() {
      const gb = boot(file);
      prepare(gb);
      const cmp = compareScreen(gb, reference);
      return { passed: cmp.match, detail: cmp.match ? '' : `${cmp.different} pixels differ, first at (${cmp.first.x},${cmp.first.y})` };
    },
  };
}

const SUITES = {
  blargg() {
    const base = path.join(ROMS, 'blargg');
    const dirs = ['cpu_instrs/individual', 'mem_timing/individual', 'mem_timing-2/rom_singles',
      'dmg_sound/rom_singles', 'oam_bug/rom_singles'];
    const cases = dirs.flatMap((d) => findRoms(path.join(base, d)).map((f) => blarggCase(f, base)));
    cases.push(blarggCase(path.join(base, 'instr_timing/instr_timing.gb'), base));
    cases.push(screenshotCase('halt_bug', path.join(base, 'halt_bug.gb'),
      path.join(base, 'halt_bug-dmg-cgb.png'), (gb) => runSeconds(gb, 2)));
    return cases;
  },

  mooneye() {
    const base = path.join(ROMS, 'mooneye-test-suite');
    const files = [...findRoms(path.join(base, 'acceptance')), ...findRoms(path.join(base, 'emulator-only'))];
    const cases = files.filter(mooneyeAppliesToDmg).map((f) => mooneyeCase(f, base));
    cases.push(screenshotCase('manual-only/sprite_priority', path.join(base, 'manual-only/sprite_priority.gb'),
      path.join(base, 'manual-only/sprite_priority-dmg.png'), (gb) => { runUntilBreak(gb, 10); gb.runFrame(); }));
    return cases;
  },

  acid2() {
    const base = path.join(ROMS, 'dmg-acid2');
    return [screenshotCase('dmg-acid2', path.join(base, 'dmg-acid2.gb'), path.join(base, 'dmg-acid2-dmg.png'),
      (gb) => { runUntilBreak(gb, 10); gb.runFrame(); })];
  },

  // The older Mooneye fork: same idea, more PPU tests. These end on an undefined
  // opcode instead of LD B,B.
  wilbertpol() {
    const base = path.join(ROMS, 'mooneye-test-suite-wilbertpol');
    return findRoms(path.join(base, 'acceptance')).filter((file) => {
      const name = path.basename(file, '.gb');
      const dash = name.lastIndexOf('-');
      return dash < 0 || /dmg|^G/.test(name.slice(dash + 1));
    }).map((file) => ({
      name: rel(file, base),
      run() {
        const gb = boot(file);
        const limit = 60 * CYCLES_PER_SECOND;
        while (!gb.cpu.locked && gb.cycles < limit) gb.cpu.step();
        if (!gb.cpu.locked) return { passed: false, detail: `did not finish; ${registers(gb)}` };
        return { passed: mooneyePassed(gb), detail: registers(gb) };
      },
    }));
  },

  // AGE: register-signalled tests named for the models they pass on, plus a few
  // screenshot tests of mid-scanline register changes.
  age() {
    const base = path.join(ROMS, 'age-test-roms');
    const cases = [];
    for (const file of findRoms(base)) {
      const name = path.basename(file).replace(/\.gbc?$/, '');
      const reference = path.join(path.dirname(file), `${name}-dmgC.png`);
      if (fs.existsSync(reference)) {
        cases.push(screenshotCase(rel(file, base), file, reference, (gb) => { runUntilBreak(gb, 10); gb.runFrame(); }));
      } else if (/dmgC/.test(name)) {
        cases.push(mooneyeCase(file, base));
      }
    }
    return cases;
  },

  // Mealybug Tearoom: register changes in the middle of a scanline, judged by
  // screenshot. These need a dot-exact pixel pipeline.
  mealybug() {
    const base = path.join(ROMS, 'mealybug-tearoom-tests');
    return findRoms(path.join(base, 'ppu')).map((file) => {
      const reference = file.replace(/\.gb$/, '_dmg_blob.png');
      if (!fs.existsSync(reference)) return null;
      return screenshotCase(rel(file, base), file, reference, (gb) => { runUntilBreak(gb, 10); gb.runFrame(); });
    }).filter(Boolean);
  },

  mbc3() {
    const base = path.join(ROMS, 'mbc3-tester');
    // The test finishes after about 42 frames here and then keeps showing its result.
    return [screenshotCase('mbc3-tester', path.join(base, 'mbc3-tester.gb'), path.join(base, 'mbc3-tester-dmg.png'),
      (gb) => { for (let i = 0; i < 60; i++) gb.runFrame(); })];
  },

  // Gambatte: each ROM runs for 15 frames and prints a hex result, which the file
  // name spells out for the original Game Boy ("dmg08_out<hex>"). The digits are
  // written to the background map as tile numbers, so they are read from there.
  // "outaudio0/1" tests instead expect silence or sound in the final frame.
  gambatte() {
    const base = path.join(ROMS, 'gambatte');
    const cases = [];
    for (const file of findRoms(base)) {
      const m = /_dmg08(?:_cgb04c)?_out(audio[01]|[0-9A-F]+)/.exec(path.basename(file));
      if (!m) continue;
      const expected = m[1];
      cases.push({
        name: rel(file, base),
        run() {
          const gb = boot(file);
          gb.apu.setSampleRate(48000);
          for (let i = 0; i < 14; i++) { gb.runFrame(); gb.apu.sampleCount = 0; }
          // Watch the mixer through the last frame.
          const levels = new Set();
          const ppu = gb.ppu;
          ppu.frameReady = false;
          const limit = gb.cycles + 17556;
          while (!ppu.frameReady && gb.cycles < limit) {
            gb.cpu.step();
            if (gb.apu.dirty) gb.apu.mix();
            levels.add(gb.apu.outL);
            gb.apu.sampleCount = 0;
          }
          if (expected.startsWith('audio')) {
            const sounding = levels.size > 1;
            return { passed: sounding === (expected === 'audio1'), detail: sounding ? 'sound' : 'silence' };
          }
          let shown = '';
          for (let i = 0; i < expected.length; i++) shown += (ppu.vram[0x1800 + i] & 0x0f).toString(16).toUpperCase();
          return { passed: shown === expected, detail: `shows ${shown}, want ${expected}` };
        },
      });
    }
    return cases;
  },

  gbmicrotest() {
    const base = path.join(ROMS, 'gbmicrotest');
    return findRoms(base).map((file) => ({
      name: rel(file, base),
      run() {
        const gb = boot(file);
        // Two frames are enough for all but one test, which needs ~0.4 s.
        runSeconds(gb, /is_if_set_during_ime0/.test(file) ? 0.5 : 0.07);
        const r = microtestResult(gb);
        // Some ROMs in the suite are scratch programs that never report a verdict.
        if (r.verdict !== 0x01 && r.verdict !== 0xff) return { skipped: true, detail: 'not self-checking' };
        return { passed: r.passed, detail: `got $${hex(r.actual)} want $${hex(r.expected)}` };
      },
    }));
  },
};

// --- main ------------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes('-v') || args.includes('--verbose');
const update = args.includes('--update');
const wanted = args.filter((a) => !a.startsWith('-'));
const unknown = wanted.filter((s) => !SUITES[s]);
if (unknown.length) {
  console.error(`unknown suite: ${unknown.join(', ')} (have: ${Object.keys(SUITES).join(', ')})`);
  process.exit(2);
}
if (!fs.existsSync(ROMS)) {
  console.error('test-roms/ is missing. Run: npm run roms:fetch');
  process.exit(2);
}

const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const names = wanted.length ? wanted : Object.keys(SUITES);
let regressions = 0;

for (const suite of names) {
  const cases = SUITES[suite]();
  const passed = [];
  const failed = [];
  let skipped = 0;
  const started = Date.now();
  for (const test of cases) {
    let result;
    try {
      result = test.run();
    } catch (err) {
      result = { passed: false, detail: `threw: ${err.message}` };
    }
    if (result.skipped) skipped++;
    else (result.passed ? passed : failed).push({ name: test.name, detail: result.detail });
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n${suite}: ${passed.length}/${passed.length + failed.length} passed` +
      (skipped ? `, ${skipped} skipped (not self-checking)` : '') + ` (${secs}s)`);

  const expected = new Set(baseline[suite] || []);
  const regressed = failed.filter((t) => expected.has(t.name));
  const gained = passed.filter((t) => !expected.has(t.name));
  // A baseline test that did not run at all (ROM missing or renamed) must not pass
  // unnoticed either.
  const ran = new Set([...passed, ...failed].map((t) => t.name));
  const missing = [...expected].filter((name) => !ran.has(name));
  for (const name of missing.slice(0, 10)) console.log(`  MISSING ${name}`);
  if (missing.length > 10) console.log(`  ... and ${missing.length - 10} more missing`);
  for (const t of regressed) console.log(`  REGRESSION ${t.name}  ${t.detail}`);
  if (verbose) {
    for (const t of failed) if (!expected.has(t.name)) console.log(`  fail ${t.name}  ${t.detail}`);
  }
  if (gained.length && !update && expected.size) {
    console.log(`  ${gained.length} newly passing (run with --update to record): ` +
        gained.slice(0, 8).map((t) => t.name).join(', ') + (gained.length > 8 ? ', ...' : ''));
  }
  regressions += regressed.length + (update ? 0 : missing.length);
  if (update) baseline[suite] = passed.map((t) => t.name).sort();
}

if (update) {
  fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
  fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + '\n');
  console.log(`\nbaseline written to ${path.relative(ROOT, BASELINE)}`);
} else if (regressions) {
  console.log(`\n${regressions} baseline test(s) regressed or did not run`);
  process.exitCode = 1;
}
