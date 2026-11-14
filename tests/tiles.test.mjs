import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTile, tileNumber, tileAddress, applyPalette, renderTileSheet, renderTilemap,
  readSprites, renderSprite, tileUsage, IDENTITY_PALETTE,
} from '../src/core/tiles.js';
import { disassemble } from '../src/core/disasm.js';

const COLORS = Uint32Array.of(10, 11, 12, 13); // stand-ins for four packed pixels

test('decodeTile combines the two bit planes', () => {
  // Row 0: low plane 0b11001100, high plane 0b10101010 -> colours 3 1 2 0 3 1 2 0
  const bytes = new Uint8Array(16);
  bytes[0] = 0b11001100;
  bytes[1] = 0b10101010;
  bytes[14] = 0xff; // last row: colour 1 throughout
  const pixels = decodeTile(bytes, 0);
  assert.deepEqual([...pixels.subarray(0, 8)], [3, 1, 2, 0, 3, 1, 2, 0]);
  assert.deepEqual([...pixels.subarray(56, 64)], [1, 1, 1, 1, 1, 1, 1, 1]);
});

test('tile numbering follows the LCDC addressing mode', () => {
  assert.equal(tileNumber(0x00, true), 0);
  assert.equal(tileNumber(0xff, true), 255);
  assert.equal(tileNumber(0x00, false), 256, 'IDs 0-127 live at $9000 in $8800 mode');
  assert.equal(tileNumber(0x7f, false), 383);
  assert.equal(tileNumber(0x80, false), 128, 'IDs 128-255 are shared');
  assert.equal(tileAddress(0), 0x8000);
  assert.equal(tileAddress(256), 0x9000);
  assert.equal(tileAddress(383), 0x97f0);
});

test('palettes map colour numbers to shades', () => {
  assert.deepEqual([0, 1, 2, 3].map((c) => applyPalette(IDENTITY_PALETTE, c)), [0, 1, 2, 3]);
  assert.deepEqual([0, 1, 2, 3].map((c) => applyPalette(0b00011011, c)), [3, 2, 1, 0]);
});

test('renderTileSheet lays tiles out in a grid', () => {
  const bytes = new Uint8Array(3 * 16);
  bytes.fill(0xff, 16, 32);          // tile 1: colour 3
  for (let i = 32; i < 48; i += 2) bytes[i] = 0xff; // tile 2: colour 1
  const target = new Uint32Array(16 * 16);
  renderTileSheet(bytes, 0, 3, 2, IDENTITY_PALETTE, COLORS, target);
  assert.equal(target[0], 10);       // tile 0 at (0,0)
  assert.equal(target[8], 13);       // tile 1 at (8,0)
  assert.equal(target[7 * 16 + 15], 13);
  assert.equal(target[8 * 16], 11);  // tile 2 wraps to the second row
  assert.equal(target[8 * 16 + 8], 0, 'cells past the last tile are untouched');
});

test('renderTilemap resolves each cell through the map', () => {
  const vram = new Uint8Array(0x2000);
  vram.fill(0xff, 16, 32);           // tile 1: colour 3
  vram.fill(0xff, 0x1000, 0x1010);   // tile 256: colour 3
  vram[0x1800 + 33] = 1;             // cell (1,1)
  const target = new Uint32Array(256 * 256);
  renderTilemap(vram, 0x1800, true, IDENTITY_PALETTE, COLORS, target);
  assert.equal(target[8 * 256 + 8], 13);
  assert.equal(target[0], 10);
  // In $8800 mode ID 0 is tile 256 (solid) and ID 1 is tile 257 (blank).
  renderTilemap(vram, 0x1800, false, IDENTITY_PALETTE, COLORS, target);
  assert.equal(target[0], 13);
  assert.equal(target[8 * 256 + 8], 10);
});

test('readSprites decodes OAM entries', () => {
  const oam = new Uint8Array(160);
  oam.set([16 + 40, 8 + 72, 0x25, 0xb0], 4); // sprite 1
  const small = readSprites(oam, 0x00)[1];
  assert.deepEqual(small, {
    index: 1, x: 72, y: 40, tile: 0x25, attr: 0xb0, height: 8,
    behind: true, flipY: false, flipX: true, palette: 1, onScreen: true,
  });
  const tall = readSprites(oam, 0x04)[1];
  assert.equal(tall.height, 16);
  assert.equal(tall.tile, 0x24, 'bit 0 of the tile number is ignored for 8x16 sprites');
  assert.equal(readSprites(oam, 0)[0].onScreen, false, 'an all-zero entry is off screen');
});

test('renderSprite applies flips and leaves colour 0 transparent', () => {
  const vram = new Uint8Array(0x2000);
  vram[0] = 0x80; // tile 0, row 0: leftmost pixel colour 1
  const sprite = { tile: 0, height: 8, flipX: false, flipY: false };
  const target = new Uint32Array(64);
  renderSprite(vram, sprite, IDENTITY_PALETTE, COLORS, 99, target);
  assert.equal(target[0], 11);
  assert.equal(target[1], 99);
  renderSprite(vram, { ...sprite, flipX: true, flipY: true }, IDENTITY_PALETTE, COLORS, 99, target);
  assert.equal(target[63], 11);
  assert.equal(target[0], 99);
});

test('tileUsage counts references in the maps and the sprite table', () => {
  const vram = new Uint8Array(0x2000);
  const oam = new Uint8Array(160);
  vram[0x1800] = 5;
  vram[0x1801] = 5;
  vram[0x1c00] = 7;
  oam.set([16, 8, 9, 0], 0);
  const lcdc = 0x80 | 0x40 | 0x20 | 0x10 | 0x02 | 0x01; // window on, map $9C00, tiles $8000
  const usage = tileUsage(vram, oam, lcdc);
  assert.equal(usage.bg[5], 2);
  assert.equal(usage.bg[0], 1022);
  assert.equal(usage.window[7], 1);
  assert.equal(usage.sprites[9], 1);
  assert.equal(tileUsage(vram, oam, lcdc & ~0x20).window[7], 0, 'window off: nothing counted');
});

test('disassembler spot checks', () => {
  const dis = (...bytes) => disassemble((a) => bytes[a] ?? 0, 0);
  assert.deepEqual(dis(0x00), { text: 'NOP', length: 1 });
  assert.deepEqual(dis(0x3e, 0x42), { text: 'LD A,$42', length: 2 });
  assert.deepEqual(dis(0xc3, 0x50, 0x01), { text: 'JP $0150', length: 3 });
  assert.deepEqual(dis(0x20, 0xfe), { text: 'JR NZ,$0000', length: 2 });
  assert.deepEqual(dis(0xe0, 0x40), { text: 'LDH ($FF40),A', length: 2 });
  assert.deepEqual(dis(0xcb, 0x7e), { text: 'BIT 7,(HL)', length: 2 });
  assert.deepEqual(dis(0xf8, 0xfe), { text: 'LD HL,SP-2', length: 2 });
  assert.deepEqual(dis(0xd3), { text: 'DB $D3', length: 1 });
});
