// The bundled demo game, played end to end by the test. This exercises the whole
// machine at once: CPU, interrupts, HALT, joypad, background/window/sprite rendering,
// video RAM writes and sound register writes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { GameBoy } from '../src/core/gameboy.js';
import { describePixel } from '../src/core/tiles.js';
import { buildDemo } from '../tools/build_demo.mjs';
import { demoRom } from './helpers.mjs';

const PLAYER_X = 0xc400, PLAYER_Y = 0xc401, GEMS = 0xc406, WON = 0xc407;
const TILE_GEM = 2, SOLID = 3, FONT_0 = 16;

function start() {
  const gb = new GameBoy();
  gb.loadRom(demoRom());
  for (let i = 0; i < 10; i++) gb.runFrame();
  return gb;
}

function hold(gb, button, frames) {
  gb.setButton(button, true);
  for (let i = 0; i < frames; i++) gb.runFrame();
  gb.setButton(button, false);
  gb.runFrame();
}

const hud = (gb) => [...gb.ppu.vram.subarray(0x1c00, 0x1c00 + 20)];

test('the committed ROM matches its source', () => {
  const { bytes } = buildDemo();
  assert.ok(Buffer.from(bytes).equals(demoRom()), 'roms/demo.gb is stale: run `npm run demo:build`');
});

test('boots to the garden with the HUD in the window layer', () => {
  const gb = start();
  assert.equal(gb.cart.header.title, 'GEM GARDEN');
  assert.equal(gb.peek(0xff40), 0xf7);
  assert.deepEqual([gb.peek(PLAYER_X), gb.peek(PLAYER_Y)], [8, 8]);
  // "GEMS 00/12": G E M S space 0 0 / 1 2
  assert.deepEqual(hud(gb).slice(0, 10), [26, 27, 28, 29, 38, 16, 16, 36, 17, 18]);
  // The bottom rows of the screen come from the window; the rest from the background.
  assert.equal(describePixel(gb.ppu, 4, 140).bg.window, true);
  assert.equal(describePixel(gb.ppu, 4, 100).bg.window, false);
  // The player sprite is drawn over its starting cell.
  const pixel = describePixel(gb.ppu, 11, 12);
  assert.equal(pixel.sprite.index, 0);
  assert.ok(pixel.sprite.tile >= 0x80 && pixel.sprite.tile <= 0x83);
});

test('the player walks, is stopped by walls, and the camera follows', () => {
  const gb = start();
  hold(gb, 'left', 30);
  hold(gb, 'up', 30);
  assert.deepEqual([gb.peek(PLAYER_X), gb.peek(PLAYER_Y)], [8, 8], 'walls on two sides');
  hold(gb, 'right', 40);
  assert.equal(gb.peek(PLAYER_X), 48);
  assert.equal(gb.ppu.oam[3], 0x00, 'facing right');
  hold(gb, 'left', 8);
  assert.equal(gb.peek(PLAYER_X), 40);
  assert.equal(gb.ppu.oam[3], 0x20, 'mirrored when facing left');
  assert.equal(gb.peek(0xff43), 0, 'no scrolling near the left edge');
  // Down the left-hand path to the open row, then across it.
  hold(gb, 'left', 40);
  hold(gb, 'down', 100);
  assert.equal(gb.peek(PLAYER_Y), 88, 'stopped by the wall below');
  hold(gb, 'right', 120);
  assert.equal(gb.peek(PLAYER_X), 128);
  assert.equal(gb.peek(0xff43), 128 - 76, 'the camera keeps the player near the middle');
  assert.equal(gb.peek(0xff42), 88 - 64);
  assert.equal(gb.ppu.oam[1] - 8, gb.peek(PLAYER_X) - gb.peek(0xff43), 'sprite tracks the player');
});

test('the water tile is animated by rewriting its pixels in video RAM', () => {
  const gb = start();
  const before = [...gb.ppu.vram.subarray(4 * 16, 5 * 16)];
  for (let i = 0; i < 20; i++) gb.runFrame();
  const after = [...gb.ppu.vram.subarray(4 * 16, 5 * 16)];
  assert.notDeepEqual(after, before);
  assert.deepEqual(after, before.map((b) => ((b << 1) | (b >> 7)) & 0xff), 'rotated one pixel left');
});

/** Breadth-first route over walkable cells from the player to the nearest gem. */
function routeToGem(gb) {
  const map = gb.wram.subarray(0, 1024);
  const from = (gb.peek(PLAYER_Y) >> 3) * 32 + (gb.peek(PLAYER_X) >> 3);
  const previous = new Map([[from, null]]);
  const queue = [from];
  const moves = [[1, 'right'], [-1, 'left'], [32, 'down'], [-32, 'up']];
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head];
    if (map[cell] === TILE_GEM) {
      const steps = [];
      for (let at = cell; previous.get(at); at = previous.get(at).cell) steps.unshift(previous.get(at).button);
      return steps;
    }
    for (const [delta, button] of moves) {
      const next = cell + delta;
      if (previous.has(next) || map[next] >= SOLID) continue;
      previous.set(next, { cell, button });
      queue.push(next);
    }
  }
  return null;
}

test('the whole game can be played to the end', () => {
  const gb = start();
  const total = 12;
  const chirps = [];
  const write = gb.write.bind(gb);
  gb.write = (addr, value) => { if (addr === 0xff14 && (value & 0x80)) chirps.push(gb.peek(GEMS)); write(addr, value); };

  for (let found = 1; found <= total; found++) {
    const steps = routeToGem(gb);
    assert.ok(steps, `a gem is reachable (${found})`);
    for (const button of steps) hold(gb, button, 8); // one cell is eight frames of walking
    for (let i = 0; i < 3; i++) gb.runFrame();
    assert.equal(gb.peek(GEMS), found);
    // The counter in the HUD follows, as two decimal digits.
    assert.deepEqual(hud(gb).slice(5, 7), [FONT_0 + Math.floor(found / 10), FONT_0 + (found % 10)]);
  }
  assert.equal(routeToGem(gb), null, 'no gems left in the map');
  assert.equal(gb.ppu.vram.subarray(0x1800, 0x1c00).includes(TILE_GEM), false, 'none left on screen either');
  assert.equal(gb.peek(WON), 1);
  // "YOU WIN!" appears in the HUD: Y O U space W I N !
  assert.deepEqual(hud(gb).slice(11, 19), [30, 31, 32, 38, 33, 34, 35, 37]);
  assert.equal(chirps.length, total, 'one sound effect per gem');

  // Start plays again from the top.
  hold(gb, 'start', 4);
  for (let i = 0; i < 10; i++) gb.runFrame();
  assert.equal(gb.peek(GEMS), 0);
  assert.equal(gb.peek(WON), 0);
  assert.deepEqual([gb.peek(PLAYER_X), gb.peek(PLAYER_Y)], [8, 8]);
});
