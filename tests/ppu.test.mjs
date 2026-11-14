import test from 'node:test';
import assert from 'node:assert/strict';
import { machine, runToBreak } from './helpers.mjs';
import { CYCLES_PER_FRAME } from '../src/core/gameboy.js';
import { describePixel } from '../src/core/tiles.js';

// Shared set-up: LCD off, a few tiles, then LCD on with the given LCDC value.
const SETUP = `
  ld sp,$D000
.wait:
  ldh a,($FF44)
  cp 144
  jr nz,.wait
  xor a
  ldh ($FF40),a      ; LCD off so video memory can be written freely
  ld hl,$8000
  ld bc,$2000
.clear:
  xor a
  ld (hl+),a
  dec bc
  ld a,b
  or c
  jr nz,.clear
  ld hl,$FE00
  ld b,160
.oam:
  xor a
  ld (hl+),a
  dec b
  jr nz,.oam
  ; tile 1: solid colour 3; tile 2: solid colour 1; tile 3: left half colour 2
  ld hl,$8010
  ld b,16
.t1:
  ld a,$FF
  ld (hl+),a
  dec b
  jr nz,.t1
  ld b,8
.t2:
  ld a,$FF
  ld (hl+),a
  xor a
  ld (hl+),a
  dec b
  jr nz,.t2
  ld b,8
.t3:
  xor a
  ld (hl+),a
  ld a,$F0
  ld (hl+),a
  dec b
  jr nz,.t3
  ld a,%11100100
  ldh ($FF47),a
  ldh ($FF48),a
  ldh ($FF49),a
`;

function frames(gb, count) {
  for (let i = 0; i < count; i++) gb.runFrame();
  return gb;
}

/** Runs a program to its LD B,B marker, then long enough for a frame to be shown. */
function render(source) {
  return frames(runToBreak(machine(source)), 3);
}

test('a frame is 154 lines of 456 dots', () => {
  const gb = machine('.spin:\n  jr .spin');
  gb.runFrame();
  const first = gb.cycles;
  gb.runFrame();
  // Frames end on an instruction boundary, so allow a few cycles either way.
  assert.ok(Math.abs(gb.cycles - first - CYCLES_PER_FRAME) <= 3, `${gb.cycles - first}`);
  const start = gb.ppu.frameCount;
  frames(gb, 60);
  assert.equal(gb.ppu.frameCount - start, 60);
});

test('each visible line goes through modes 2, 3, 0 and VBlank raises its interrupt', () => {
  const gb = machine('.spin:\n  jr .spin');
  gb.runFrame();
  gb.iflag = 0;
  const seen = [];
  let last = -1;
  while (gb.ppu.line !== 2) gb.cpu.step();
  while (gb.ppu.line === 2) {
    const mode = gb.peek(0xff41) & 3;
    if (mode !== last) { seen.push(mode); last = mode; }
    gb.cpu.step();
  }
  assert.deepEqual(seen.slice(-3), [2, 3, 0]);
  assert.equal(gb.iflag & 1, 0);
  gb.runFrame();
  assert.equal(gb.iflag & 1, 1, 'VBlank interrupt requested');
  assert.equal(gb.peek(0xff44), 144);
  assert.equal(gb.peek(0xff41) & 3, 1);
});

test('video memory is locked away from the CPU while the LCD is drawing', () => {
  const gb = machine('.spin:\n  jr .spin');
  gb.runFrame();
  gb.ppu.vram[0] = 0x5a;
  gb.ppu.oam[0] = 0xa5;
  while (!(gb.ppu.line === 5 && gb.ppu.mode === 3)) gb.cpu.step();
  assert.equal(gb.read(0x8000), 0xff);
  assert.equal(gb.read(0xfe00), 0xff);
  gb.write(0x8000, 0x11);
  assert.equal(gb.ppu.vram[0], 0x5a, 'write ignored');
  while (gb.ppu.mode !== 0) gb.cpu.step();
  assert.equal(gb.read(0x8000), 0x5a);
  assert.equal(gb.read(0xfe00), 0xa5);
});

test('background, scrolling and palette', () => {
  const gb = render(`${SETUP}
  ld a,1
  ld ($9800),a       ; map cell (0,0) -> tile 1
  ld a,2
  ld ($9801),a       ; cell (1,0) -> tile 2
  ld a,3
  ldh ($FF43),a      ; SCX = 3
  ld a,$91
  ldh ($FF40),a
  ld b,b
.spin:
  jr .spin
`);
  const row = [...gb.ppu.display.subarray(0, 16)];
  // Tile 1 (shade 3) shows its last 5 columns, then tile 2 (shade 1), then tile 0.
  assert.deepEqual(row, [3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
  assert.equal(gb.ppu.display[8 * 160], 0, 'second tile row is blank');

  // The same picture through an inverted palette.
  gb.write(0xff47, 0b00011011);
  frames(gb, 2);
  assert.deepEqual([...gb.ppu.display.subarray(3, 7)], [0, 0, 2, 2]);
});

test('sprites: transparency, flipping and background priority', () => {
  const gb = render(`${SETUP}
  ld a,2
  ld ($9800),a       ; background cell (0,0): colour 1
  ld hl,$FE00
  ld a,16
  ld (hl+),a         ; sprite 0 at screen (4, 0), tile 3 (left half colour 2)
  ld a,12
  ld (hl+),a
  ld a,3
  ld (hl+),a
  xor a
  ld (hl+),a
  ld a,24
  ld (hl+),a         ; sprite 1 at screen (4, 8), same tile mirrored
  ld a,12
  ld (hl+),a
  ld a,3
  ld (hl+),a
  ld a,$20
  ld (hl+),a
  ld a,32
  ld (hl+),a         ; sprite 2 at screen (0, 16), behind the background
  ld a,8
  ld (hl+),a
  ld a,3
  ld (hl+),a
  ld a,$80
  ld (hl+),a
  ld a,2
  ld ($9840),a       ; background under sprite 2: colour 1
  ld a,$93
  ldh ($FF40),a
  ld b,b
.spin:
  jr .spin
`);
  const px = (x, y) => gb.ppu.display[y * 160 + x];
  // Row 0: background colour 1 for x 0-3, sprite colour 2 for x 4-7, then the
  // sprite's transparent half lets the background (tile 0 from x 8) through.
  assert.deepEqual([0, 3, 4, 7, 8, 11].map((x) => px(x, 0)), [1, 1, 2, 2, 0, 0]);
  // Row 8: mirrored, so the opaque half is on the right.
  assert.deepEqual([4, 7, 8, 11, 12].map((x) => px(x, 8)), [0, 0, 2, 2, 0]);
  // Row 16: the sprite hides behind non-zero background pixels.
  assert.deepEqual([0, 3, 4].map((x) => px(x, 16)), [1, 1, 1]);

  const top = describePixel(gb.ppu, 5, 0);
  assert.deepEqual(top.sprite, { tile: 3, index: 0, hidden: false });
  assert.deepEqual(top.bg, { tile: 2, window: false, mapAddress: 0x9800, col: 0, row: 0 });
  assert.equal(describePixel(gb.ppu, 1, 16).sprite.hidden, true);
  assert.equal(describePixel(gb.ppu, 9, 0).sprite, null);
});

test('the window covers the background from WX/WY and has its own line counter', () => {
  const gb = render(`${SETUP}
  ld hl,$9C00
  ld b,32
.w:
  ld a,1
  ld (hl+),a         ; first window row: tile 1 (shade 3)
  dec b
  jr nz,.w
  ld a,100
  ldh ($FF4A),a      ; WY
  ld a,87
  ldh ($FF4B),a      ; WX: window starts at screen x 80
  ld a,$F1           ; window on, window map $9C00, tiles $8000
  ldh ($FF40),a
  ld b,b
.spin:
  jr .spin
`);
  const px = (x, y) => gb.ppu.display[y * 160 + x];
  assert.deepEqual([px(79, 99), px(80, 99), px(79, 100), px(80, 100), px(159, 107), px(80, 108)],
    [0, 0, 0, 3, 3, 0]);
  const info = describePixel(gb.ppu, 85, 103);
  assert.equal(info.bg.window, true);
  assert.equal(info.bg.mapAddress, 0x9c00);
  assert.equal(describePixel(gb.ppu, 10, 103).bg.window, false);
});

test('switching the LCD off blanks the screen and frames keep coming', () => {
  const gb = frames(machine(`${SETUP}
  ld a,1
  ld ($9800),a
  ld a,$91
  ldh ($FF40),a
  ld b,b
.spin:
  jr .spin
`), 0);
  runToBreak(gb);
  frames(gb, 3);
  assert.equal(gb.ppu.display[0], 3);
  gb.write(0xff40, 0x11);
  assert.equal(gb.ppu.display[0], 0);
  assert.equal(gb.peek(0xff44), 0);
  const before = gb.cycles;
  for (let i = 0; i < 10; i++) assert.equal(gb.runFrame(), true);
  assert.ok(Math.abs(gb.cycles - before - 10 * CYCLES_PER_FRAME) < 40);
});

test('LYC raises the STAT interrupt on the matching line', () => {
  const gb = machine('.spin:\n  jr .spin');
  gb.runFrame();
  gb.write(0xff45, 50);
  gb.write(0xff41, 0x40);
  gb.iflag = 0;
  while (gb.ppu.line !== 49 || gb.ppu.dot < 400) gb.cpu.step();
  assert.equal(gb.iflag & 2, 0);
  while (gb.ppu.line !== 50 || gb.ppu.dot < 8) gb.cpu.step();
  assert.equal(gb.iflag & 2, 2);
  assert.equal(gb.peek(0xff41) & 4, 4, 'coincidence flag');
});
