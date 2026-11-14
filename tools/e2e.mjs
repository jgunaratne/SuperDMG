#!/usr/bin/env node
// End-to-end test: drives the real app in headless Chrome with real mouse and keyboard
// events, and checks what a player would see. Screenshots land in out/e2e/.
//
//   npm run test:e2e
//
// Needs Google Chrome (set CHROME to its path if it is not `google-chrome`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, startServer } from './browser.mjs';
import { assemble, finishRom } from './asm.mjs';
import { makeZip } from '../tests/helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'e2e');
const DEMO = path.join(ROOT, 'roms', 'demo.gb');

const failures = [];
let checks = 0;
function check(condition, message) {
  checks++;
  if (!condition) {
    failures.push(message);
    console.log(`  FAIL ${message}`);
  }
}
const near = (value, target, tolerance) => Math.abs(value - target) <= target * tolerance;

/** A cartridge with battery RAM that counts how many times it has been started. */
function buildSaveRom(file) {
  const { bytes } = assemble(`
  org $0100
  nop
  jp $0150
  org $0150
  ld a,$0A
  ld ($0000),a       ; enable cartridge RAM
  ld a,($A000)
  ld ($C000),a       ; what was in the save when we started
  inc a
  ld ($A000),a
.spin:
  halt
  jr .spin
`);
  fs.writeFileSync(file, finishRom(bytes, { title: 'SAVE TEST', type: 0x03, ramSize: 0x02 }));
}

if (!process.env.GEMINI_API_KEY) {
  process.env.HD_TILE_BACKEND ||= 'procedural';
  process.env.AI_PLAYER_BACKEND ||= 'heuristic';
}
const server = await startServer(ROOT);
const page = await launchBrowser({ width: 1440, height: 900 });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gameboy-e2e-'));
const shot = (name) => page.screenshot(path.join(OUT, `${name}.png`));
const frameCount = () => page.eval('gameboy.emulator.gb.ppu.frameCount');
const peek = (addr) => page.eval(`gameboy.emulator.gb.peek(${addr})`);
const text = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).textContent.trim()`);
const hidden = (selector) => page.eval(`document.querySelector(${JSON.stringify(selector)}).hidden`);

try {
  await page.setViewport(1440, 900);

  console.log('start-up');
  await page.goto(server.url);
  await page.waitFor('window.gameboy');
  check(await page.eval('document.title') === 'SuperDMG: AI tiles, MIDI and tile explorer', 'page title');
  check(!(await hidden('#lcd-empty')), 'empty screen invites loading a ROM');
  check(await page.eval('document.getElementById("btn-pause").disabled'), 'transport disabled with no cartridge');
  await shot('01-empty');

  // Record every block of sound the page schedules: when it starts, how long it is,
  // and how loud it gets.
  await page.eval(`(() => {
    window.__sound = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when) {
      let peak = 0;
      for (const sample of this.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      window.__sound.push([when, this.buffer.duration, peak]);
      return start.apply(this, arguments);
    };
  })()`);

  console.log('demo game');
  await page.clickOn('#btn-demo');
  await page.waitFor('gameboy.emulator.loaded');
  await page.waitFor('gameboy.emulator.gb.ppu.frameCount > 30');
  check(await text('#cart-title') === 'GEM GARDEN', 'cartridge title shown');
  check(await hidden('#lcd-empty'), 'empty state gone once a game runs');
  const shades = await page.eval(`(() => { const c = document.getElementById('lcd-canvas');
    const d = c.getContext('2d').getImageData(0, 0, 160, 144).data; const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return seen.size; })()`);
  check(shades === 4, `screen canvas shows the game in four shades (saw ${shades})`);

  // Speed: the emulated frame rate should be the Game Boy's 59.7 per second.
  let before = await frameCount();
  let t0 = Date.now();
  await page.sleep(3000);
  let rate = ((await frameCount()) - before) / ((Date.now() - t0) / 1000);
  check(near(rate, 59.73, 0.06), `runs at full speed (${rate.toFixed(1)} frames/s)`);
  check(await page.eval('gameboy.audio.running'), 'audio context running after a click');
  // The queue of scheduled sound should hover near its target: never empty (gaps),
  // never piling up (lag).
  const queue = [];
  for (let i = 0; i < 15; i++) { queue.push(await page.eval('gameboy.audio.queued')); await page.sleep(200); }
  const low = Math.min(...queue), high = Math.max(...queue);
  check(low > 0.005 && high < 0.2, `sound queue stays steady (${(low * 1000).toFixed(0)}-${(high * 1000).toFixed(0)} ms ahead)`);

  // Blocks must butt up against each other exactly: a gap is a click, an overlap a pop.
  const seams = await page.eval(`(() => {
    const blocks = window.__sound.slice(-150);
    let breaks = 0;
    for (let i = 1; i < blocks.length; i++) {
      if (Math.abs(blocks[i][0] - (blocks[i - 1][0] + blocks[i - 1][1])) > 1e-4) breaks++;
    }
    return { blocks: blocks.length, breaks };
  })()`);
  check(seams.blocks >= 100 && seams.breaks === 0, `sound blocks are scheduled back to back (${seams.breaks} breaks in ${seams.blocks})`);

  console.log('keyboard');
  const x0 = await peek(0xc400);
  await page.key('down', 'ArrowRight');
  await page.sleep(500);
  await page.key('up', 'ArrowRight');
  const x1 = await peek(0xc400);
  check(x1 > x0 + 15, `arrow key moves the player (${x0} -> ${x1})`);
  await page.sleep(100);
  check(await peek(0xc400) === x1, 'releasing the key stops the player');
  await page.key('down', 'KeyA', 'a'); // WASD alternative
  await page.sleep(300);
  await page.key('up', 'KeyA', 'a');
  check(await peek(0xc400) < x1, 'A (WASD) moves left');

  // Walk to the first gem with the keyboard: one cell right of the tree gap, one down.
  await page.eval('window.__sound.length = 0');
  await page.key('down', 'ArrowRight');
  await page.waitFor('gameboy.emulator.gb.peek(0xc400) >= 70', 5000);
  await page.key('up', 'ArrowRight');
  await page.key('down', 'ArrowDown');
  await page.waitFor('gameboy.emulator.gb.peek(0xc406) === 1', 5000);
  await page.key('up', 'ArrowDown');
  check(await peek(0xc406) === 1, 'the player can pick up a gem');
  await page.sleep(400);
  const loudest = await page.eval('Math.max(...window.__sound.map((b) => b[2]))');
  check(loudest > 0.05, `picking up a gem makes a sound (peak level ${loudest.toFixed(2)})`);
  const digits = await page.eval('[gameboy.emulator.gb.ppu.vram[0x1c05], gameboy.emulator.gb.ppu.vram[0x1c06]].join()');
  check(digits === '16,17', 'the counter on screen now reads 01');

  console.log('pause, step, speed');
  await page.press('KeyP', 'p');
  await page.sleep(150);
  before = await frameCount();
  await page.sleep(400);
  check(await frameCount() === before, 'P pauses');
  check(await text('#lcd-flag') === 'Paused', 'paused flag on the screen');
  await page.press('KeyN', 'n');
  await page.sleep(100);
  check(await frameCount() === before + 1, 'N advances exactly one frame');
  await page.clickOn('#btn-pause');
  await page.sleep(300);
  check(await frameCount() > before + 5, 'Resume button resumes');
  check(await page.eval('document.activeElement.id') === 'lcd', 'mouse clicks hand the keyboard back to the game');

  await page.clickOn('#speed [data-speed="2"]');
  before = await frameCount(); t0 = Date.now();
  await page.sleep(1500);
  rate = ((await frameCount()) - before) / ((Date.now() - t0) / 1000);
  check(near(rate, 119.5, 0.1), `2x speed (${rate.toFixed(1)} frames/s)`);
  await page.clickOn('#speed [data-speed="1"]');
  await page.key('down', 'Space', ' ');
  before = await frameCount(); t0 = Date.now();
  await page.sleep(1000);
  rate = ((await frameCount()) - before) / ((Date.now() - t0) / 1000);
  await page.key('up', 'Space', ' ');
  check(rate > 200, `holding Space fast-forwards (${rate.toFixed(0)} frames/s)`);

  console.log('explorer: tiles');
  await page.hoverOn('#tile-sheet .stack', 2.5 / 16, 0.5 / 24); // tile $002, the gem
  await page.sleep(150);
  check(await text('#insp-title') === 'Tile $002', 'hovering the sheet inspects that tile');
  check(await hidden('#insp-pin'), 'a hover is not a pin');
  check((await text('#insp-rows')).startsWith('00 00'), 'tile bytes listed');
  check(/BG map\s*×11/.test(await text('#insp-usage')), 'usage counts the 11 gems left in the map');
  await page.clickOn('#tile-sheet .stack', 2.5 / 16, 0.5 / 24);
  await page.hoverOn('#btn-load');
  await page.sleep(150);
  check(!(await hidden('#insp-pin')), 'clicking pins the tile');
  check(await text('#insp-title') === 'Tile $002', 'pinned tile stays after the pointer leaves');
  const highlighted = await page.eval(`(() => { const c = document.getElementById('lcd-overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()`);
  check(highlighted > 0, 'pinned tile is highlighted on the game screen');
  await shot('02-tiles-pinned');
  await page.press('Escape');
  await page.sleep(100);
  check(await hidden('#inspector-body'), 'Escape unpins');

  console.log('explorer: screen picking');
  await page.clickOn('#lcd', 0.5, 0.97); // the status bar, drawn by the window layer
  await page.sleep(150);
  check(/window cell/.test(await text('#insp-context')), 'clicking the HUD identifies the window layer');
  check(!(await hidden('#insp-pin')), 'clicking the screen pins');
  await page.press('Escape');

  console.log('explorer: maps and sprites');
  await page.clickOn('#tab-maps');
  await page.sleep(150);
  check(!(await hidden('#view-maps')) && (await hidden('#view-tiles')), 'tab switches the view');
  check(await text('#map-tag-0') === 'BG' && await text('#map-tag-1') === 'window', 'maps labelled by role');
  await page.hoverOn('#map-sheet .stack', 0.5 / 32, 0.5 / 32);
  await page.sleep(150);
  check(await text('#insp-title') === 'Tile $003', 'map cell (0,0) is a wall tile');
  check(/\$9800/.test(await text('#insp-context')), 'map address shown');
  await shot('03-maps');
  await page.clickOn('#tab-sprites');
  await page.sleep(150);
  check(await page.eval('document.querySelectorAll("#sprite-grid .sprite").length') === 40, '40 sprite slots');
  check(/^1 of 40 sprites on screen/.test(await text('#sprite-summary')), 'one sprite on screen (the player)');
  await page.hoverOn('#sprite-grid .sprite');
  await page.sleep(150);
  check(/^Sprite 0 at/.test(await text('#insp-context')), 'sprite details in the inspector');
  await shot('04-sprites');

  console.log('explorer: cartridge ROM view');
  await page.clickOn('#tab-tiles');
  await page.clickOn('#tile-source [data-source="rom"]');
  await page.sleep(150);
  check(!(await hidden('#rom-bar')), 'ROM controls appear');
  await page.hoverOn('#tile-sheet .stack', 2.5 / 16, 4.5 / 24); // $0400 + 2 tiles: the gem again
  await page.sleep(150);
  check(await text('#insp-title') === 'ROM $000420', 'ROM tiles are addressed by file offset');
  check((await text('#insp-rows')).startsWith('00 00'), 'same gem bytes found in the ROM');
  await page.clickOn('#rom-next');
  check(/file \$001800/.test(await text('#rom-range')), 'paging moves through the ROM');
  await shot('05-rom');
  await page.clickOn('#tile-source [data-source="vram"]');

  console.log('advanced tile mode');
  const apiStatus = await page.eval(`fetch('api/tiles/status').then((r) => r.json())`);
  check(apiStatus && apiStatus.available, `tile upgrade server ready (backend: ${apiStatus?.backend})`);
  await page.eval(`fetch('api/tiles/clear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cartId: 'GEM_GARDEN.' + gameboy.emulator.gb.cart.header.globalChecksum.toString(16).padStart(4, '0'), style: 'snes' }),
  })`);
  await page.clickOn('#btn-hd-mode');
  await page.waitFor('gameboy.hd.enabled && !gameboy.hd.busy && gameboy.hd.pack && gameboy.hd.pack.count >= 6', 110000);
  const hdCanvasSize = await page.eval(`(() => { const c = document.getElementById('lcd-canvas'); return [c.width, c.height].join('x'); })()`);
  check(hdCanvasSize === '640x576', `HD mode upgrades screen canvas to 640x576 (got ${hdCanvasSize})`);
  const hdColors = await page.eval(`(() => { const c = document.getElementById('lcd-canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const seen = new Set();
    for (let i = 0; i < d.length; i += 16) seen.add(d[i] << 16 | d[i + 1] << 8 | d[i + 2]); return seen.size; })()`);
  check(hdColors >= 20, `HD mode renders rich multi-colour tiles on screen (saw ${hdColors} colours)`);
  await page.hoverOn('#tile-sheet .stack', 2.5 / 16, 0.5 / 24);
  await page.sleep(150);
  check(!(await hidden('#insp-hd')), 'inspector shows upgraded 32x32 HD tile preview');
  await shot('05b-hd-tiles');
  await page.clickOn('#tab-maps');
  await page.sleep(150);
  const hdMapSize = await page.eval(`(() => { const c = document.querySelector('#map-sheet canvas'); return [c.width, c.height].join('x'); })()`);
  check(hdMapSize === '1024x1024', `Explorer tilemap renders at 1024x1024 HD (${hdMapSize})`);
  await shot('05c-hd-maps');
  await page.clickOn('#tab-tiles');
  await page.press('KeyH', 'h');
  await page.sleep(150);
  check(!(await page.eval('gameboy.hd.enabled')), 'H key leaves Advanced Tile Mode');
  const dmgCanvasSize = await page.eval(`(() => { const c = document.getElementById('lcd-canvas'); return [c.width, c.height].join('x'); })()`);
  check(dmgCanvasSize === '160x144', `leaving HD mode restores 160x144 LCD (${dmgCanvasSize})`);

  console.log('ai autoplay');
  const aiStatus = await page.eval(`fetch('api/ai/status').then((r) => r.json())`);
  check(aiStatus && aiStatus.available, `AI autoplay server ready (backend: ${aiStatus?.backend}, model: ${aiStatus?.model})`);
  check(await page.eval('Boolean(document.querySelector(".right-col #ai-panel") && !document.querySelector(".console #ai-panel"))'), 'AI Gameplay panel lives on the right column');
  check(!(await page.eval('document.getElementById("ai-play").checked')), 'AI Autoplay unchecked by default');
  await page.clickOn('#btn-reset');
  await page.sleep(200);
  const aiX0 = await peek(0xc400);
  const aiY0 = await peek(0xc401);
  // Type & paste assistance into #ai-assist-input and verify it neither moves the character nor triggers hotkeys
  await page.clickOn('#ai-assist-input');
  await page.eval(`(() => {
    const el = document.getElementById('ai-assist-input');
    el.value = 'Walk right along the top corridor toward the gem at (9, 2).';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await page.clickOn('#btn-ai-send');
  check(await page.eval('gameboy.ai.userNotes.length === 1 && !document.getElementById("ai-notes-bar").hidden'), 'submitted user hint is stored and shown in active hints bar');
  check(await page.eval('document.querySelectorAll("#ai-log .ai-entry-user").length === 1'), 'user hint appears in the thinking history log');
  await page.clickOn('#ai-play');
  check(await page.eval('gameboy.ai.enabled && document.getElementById("ai-play").checked'), 'checking #ai-play enables AI Autoplay');
  await page.waitFor(
    'gameboy.ai.turnCount >= 1 && (gameboy.emulator.gb.peek(0xc400) !== ' + aiX0 + ' || gameboy.emulator.gb.peek(0xc401) !== ' + aiY0 + ')',
    45000,
  );
  const aiGoal = await text('#ai-goal');
  check(aiGoal.length > 5 && !aiGoal.startsWith('Check AI Autoplay'), `AI Autoplay displays its decision (${aiGoal.slice(0, 60)})`);
  check(await page.eval('document.querySelectorAll("#ai-log .ai-entry").length >= 2'), 'thinking history log displays both user hint and AI turn entry');
  // Stress-test CSS containment with multiple long multi-paragraph thoughts + long unbroken tokens + long pasted note
  const cssContainment = await page.eval(`(() => {
    const longThought = Array.from({ length: 8 }, (_, i) =>
      'Step ' + (i + 1) + ': Evaluating corridor geometry and obstacle coordinates ' + 'X'.repeat(120)
    ).join('\\n\\n');
    for (let k = 0; k < 5; k++) {
      gameboy.ai.assist('Long walkthrough paragraph #' + (k + 1) + ': ' + 'Walk east along row 1 then south around the hedge wall. '.repeat(8) + 'TOKEN_' + 'A'.repeat(140));
    }
    // Also inject long thoughts onto existing turn entries and force re-render
    for (const entry of gameboy.ai.thinkingLog) {
      if (entry.kind === 'turn') entry.thought = longThought;
    }
    gameboy.ai.assist('Final stress hint check.');
    const panel = document.getElementById('ai-panel');
    const rightCol = document.querySelector('.right-col');
    const log = document.getElementById('ai-log');
    const entries = [...log.querySelectorAll('.ai-entry')];
    const pRect = panel.getBoundingClientRect();
    const rRect = rightCol.getBoundingClientRect();
    let overlaps = 0;
    let childOverflow = 0;
    for (let i = 0; i < entries.length; i++) {
      const eRect = entries[i].getBoundingClientRect();
      if (eRect.width > log.clientWidth + 1) childOverflow++;
      if (i > 0) {
        const prevRect = entries[i - 1].getBoundingClientRect();
        if (eRect.top < prevRect.bottom - 0.5) overlaps++;
      }
      for (const child of entries[i].children) {
        const cRect = child.getBoundingClientRect();
        if (cRect.bottom > eRect.bottom + 1 || cRect.right > eRect.right + 1) childOverflow++;
      }
    }
    return {
      panelFitsRightCol: pRect.width <= rRect.width + 1 && panel.scrollWidth <= panel.clientWidth + 1,
      logNoHorizOverflow: log.scrollWidth <= log.clientWidth + 1,
      overlaps,
      childOverflow,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);
  check(
    cssContainment.panelFitsRightCol && cssContainment.logNoHorizOverflow && cssContainment.overlaps === 0 && cssContainment.childOverflow === 0 && cssContainment.docOverflow <= 0,
    `AI Gameplay dialog contains long multi-turn thoughts and pasted hints without CSS overflow (${JSON.stringify(cssContainment)})`,
  );
  const aiX1 = await peek(0xc400);
  const aiY1 = await peek(0xc401);
  check(aiX1 !== aiX0 || aiY1 !== aiY0, `AI Autoplay moved the character ((${aiX0},${aiY0}) -> (${aiX1},${aiY1}))`);
  await shot('05d-ai-autoplay');
  await page.press('KeyG', 'g');
  await page.sleep(150);
  check(!(await page.eval('gameboy.ai.enabled')) && !(await page.eval('document.getElementById("ai-play").checked')), 'G key unchecks AI Autoplay');
  check((await page.eval('gameboy.emulator.gb.joypad.state')) === 0, 'stopping autoplay releases all AI joypad buttons');

  console.log('settings');
  const pixelBefore = await page.eval('[...document.getElementById("lcd-canvas").getContext("2d").getImageData(0,0,1,1).data].join()');
  await page.clickOn('#palettes [data-palette="grey"]');
  await page.sleep(200);
  const pixelAfter = await page.eval('[...document.getElementById("lcd-canvas").getContext("2d").getImageData(0,0,1,1).data].join()');
  check(pixelBefore !== pixelAfter, 'screen colours change with the palette');
  check(/"palette":"grey"/.test(await page.eval('localStorage.getItem("gameboy.settings")')), 'palette remembered');
  await page.press('KeyM', 'm');
  check(await text('#btn-mute') === 'Muted', 'M mutes');
  await page.press('KeyM', 'm');
  check(!(await page.eval('document.getElementById("midi-enabled").checked')), 'MIDI instruments unchecked by default');
  check(await page.eval('document.getElementById("midi-preset").disabled'), 'MIDI preset selector disabled while unchecked');
  await page.waitFor('gameboy.midi.samplesLoaded && gameboy.midi.sampleCount >= 26', 15000);
  const sampleCount = await page.eval('gameboy.midi.sampleCount');
  check(sampleCount === 28, `ElevenLabs studio instrument bank decoded (${sampleCount} samples)`);
  await page.clickOn('#midi-enabled');
  check(await page.eval('gameboy.midi.enabled && gameboy.emulator.gb.apu.midiEnabled'), 'checking MIDI instruments enables the MIDI synthesizer');
  check(!(await page.eval('document.getElementById("midi-preset").disabled')), 'MIDI preset selector enabled when checked');
  check(/"midiEnabled":true/.test(await page.eval('localStorage.getItem("gameboy.settings")')), 'MIDI setting remembered');
  await page.eval(`(() => {
    window.__sound.length = 0;
    const gb = gameboy.emulator.gb;
    gb.write(0xff10, 0x15);
    gb.write(0xff11, 0x80);
    gb.write(0xff12, 0xf2);
    gb.write(0xff13, 0x00);
    gb.write(0xff14, 0x87);
  })()`);
  await page.sleep(350);
  const midiPeak = await page.eval('Math.max(0, ...window.__sound.map((b) => b[2]))');
  check(midiPeak > 0.02, `MIDI synthesizer schedules audible instrument blocks (peak ${midiPeak.toFixed(3)})`);
  await page.waitFor('gameboy.emulator.gb.apu.midi.voices.some((v) => v.active && v.isArranger)', 5000);
  check(await page.eval('gameboy.emulator.gb.apu.midi.arranger.phraseScore >= 1.35'), 'HarmonicArranger orchestrates live accompaniment voices on the score');
  await page.press('KeyI', 'i');
  check(!(await page.eval('document.getElementById("midi-enabled").checked')) && !(await page.eval('gameboy.emulator.gb.apu.midiEnabled')), 'I key unchecks MIDI instruments');
  await page.clickOn('#palettes [data-palette="classic"]');

  console.log('loading files');
  await page.setFiles('#file-rom', [DEMO]);
  await page.waitFor('gameboy.emulator.romName === "demo.gb" && gameboy.emulator.gb.ppu.frameCount > 5 && gameboy.emulator.gb.ppu.frameCount < 200');
  check(await peek(0xc406) === 0, 'loading a file starts the game afresh');
  const dropShown = await page.eval(`(async () => {
    const bytes = new Uint8Array(await (await fetch('roms/demo.gb')).arrayBuffer());
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'dropped.gb'));
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    const shown = !document.getElementById('dropzone').hidden;
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    return shown;
  })()`);
  check(dropShown, 'dragging a file over the page shows the drop target');
  await page.waitFor('gameboy.emulator.romName === "dropped.gb"', 5000);
  check(await hidden('#dropzone'), 'drop target goes away after the drop');
  const zipped = path.join(temp, 'collection.zip');
  fs.writeFileSync(zipped, makeZip([
    { name: 'readme.txt', data: Buffer.from('not a game') },
    { name: 'roms/zipped.gb', data: fs.readFileSync(DEMO) },
  ]));
  await page.setFiles('#file-rom', [zipped]);
  await page.waitFor('gameboy.emulator.romName === "zipped.gb"', 5000);
  check(await text('#cart-title') === 'GEM GARDEN', 'a ROM inside a .zip loads');
  const emptyZip = path.join(temp, 'empty.zip');
  fs.writeFileSync(emptyZip, makeZip([{ name: 'readme.txt', data: Buffer.from('nothing here') }]));
  await page.setFiles('#file-rom', [emptyZip]);
  await page.waitFor('!document.getElementById("toast").hidden');
  check(/does not contain a \.gb/.test(await text('#toast')), 'a .zip without a ROM says so');
  await page.eval('document.getElementById("toast").hidden = true');
  const junk = path.join(temp, 'notes.gb');
  fs.writeFileSync(junk, 'this is not a ROM');
  await page.setFiles('#file-rom', [junk]);
  await page.waitFor('!document.getElementById("toast").hidden');
  check(/too small/.test(await text('#toast')), 'a bad file is refused with an explanation');
  check(await text('#cart-title') === 'GEM GARDEN', 'the running game is left alone');

  console.log('persistence');
  await page.goto(server.url);
  await page.waitFor('window.gameboy && gameboy.emulator.loaded', 5000);
  check(await text('#cart-title') === 'GEM GARDEN', 'the last game comes back after a reload');

  const saveRom = path.join(temp, 'savetest.gb');
  buildSaveRom(saveRom);
  await page.setFiles('#file-rom', [saveRom]);
  await page.waitFor('gameboy.emulator.romName === "savetest.gb"');
  await page.sleep(300);
  check(await peek(0xc000) === 0, 'battery RAM starts empty');
  check(/MBC1\+RAM\+BATTERY/.test(await text('#cart-meta')), 'cartridge type shown');
  await page.waitFor('/Saved in this browser/.test(document.getElementById("save-status").textContent)', 6000);
  await page.goto(server.url);
  await page.waitFor('window.gameboy && gameboy.emulator.romName === "savetest.gb"', 5000);
  await page.sleep(300);
  check(await peek(0xc000) === 1, 'battery RAM survives a reload');
  check(!(await page.eval('document.getElementById("btn-save-export").disabled')), 'save export offered for battery carts');

  console.log('phone layout');
  await page.setViewport(390, 844, { mobile: true });
  await page.goto(server.url);
  await page.waitFor('window.gameboy && gameboy.emulator.loaded', 5000);
  await page.eval('document.getElementById("btn-demo").click()');
  await page.waitFor('gameboy.emulator.romName === "demo.gb" && gameboy.emulator.gb.ppu.frameCount > 10');
  const overflow = await page.eval('document.documentElement.scrollWidth - innerWidth');
  check(overflow <= 0, `no sideways scrolling on a phone (overflow ${overflow}px)`);
  check(await page.eval('getComputedStyle(document.getElementById("pad")).display') !== 'none', 'touch controls shown');
  const px0 = await peek(0xc400);
  await page.eval(`document.querySelector('#pad [data-button="right"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))`);
  await page.sleep(400);
  await page.eval(`document.querySelector('#pad [data-button="right"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }))`);
  check(await peek(0xc400) > px0 + 10, 'touch D-pad moves the player');
  await shot('06-phone');

  check(page.problems.length === 0, `no errors or warnings in the console: ${page.problems.join(' | ')}`);
} catch (err) {
  failures.push(`aborted: ${err.message}`);
  console.log(`  ABORTED ${err.stack}`);
  try { await shot('99-failure'); } catch { /* browser gone */ }
} finally {
  await page.close();
  server.stop();
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failures.length ? 1 : 0);
