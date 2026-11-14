// Tile graphics helpers: decoding the Game Boy's 2-bits-per-pixel tile format and
// rasterising tile sheets, tilemaps and sprites for the explorer. Everything here is
// pure and works on plain byte arrays, so it runs the same in the browser and in tests.
//
// Pixels are produced as packed 32-bit values for a Uint32Array view of ImageData.

import {
  SCREEN_W, INFO_VALID, INFO_TILE_MASK, INFO_WINDOW, INFO_MAP_SHIFT, INFO_MAP_MASK,
  INFO_OAM_SHIFT, INFO_OAM_MASK, INFO_OBJ_HIDDEN,
} from './ppu.js';

export const TILE_BYTES = 16;
export const VRAM_TILES = 384;       // $8000-$97FF
export const MAP_SIZE = 32;          // tilemaps are 32x32 tiles
export const MAP_BASES = [0x1800, 0x1c00]; // VRAM offsets of $9800 and $9C00

/**
 * Decodes one 8x8 tile. Each row is two bytes: the first holds the low bit of every
 * pixel's colour number, the second the high bit, leftmost pixel in bit 7.
 * @return {Uint8Array} 64 colour numbers (0-3), row by row
 */
export function decodeTile(bytes, offset, out = new Uint8Array(64)) {
  for (let row = 0; row < 8; row++) {
    const lo = bytes[offset + row * 2] ?? 0;
    const hi = bytes[offset + row * 2 + 1] ?? 0;
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col;
      out[row * 8 + col] = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
    }
  }
  return out;
}

/**
 * Tile number (0-383, an index into VRAM tile data) for a tilemap entry. With LCDC
 * bit 4 set, entries index $8000 directly; otherwise entries 0-127 live at $9000.
 */
export function tileNumber(entry, lowTiles) {
  return lowTiles || entry >= 0x80 ? entry : entry + 0x100;
}

/** Address of a tile's first byte in the CPU address space. */
export function tileAddress(tile) {
  return 0x8000 + tile * TILE_BYTES;
}

/** Runs a colour number through a palette register (BGP, OBP0, OBP1). */
export function applyPalette(palette, color) {
  return (palette >> (color << 1)) & 3;
}

/** Palette register value that maps every colour number to itself. */
export const IDENTITY_PALETTE = 0xe4;

/**
 * Draws a grid of consecutive tiles.
 * @param {Uint8Array} bytes tile data source (VRAM, or a ROM image)
 * @param {number} offset byte offset of the first tile
 * @param {number} count number of tiles to draw
 * @param {number} columns tiles per row
 * @param {number} palette palette register value
 * @param {Uint32Array} colors packed pixel value for each of the four shades
 * @param {Uint32Array} target destination, `columns * 8` pixels wide
 */
export function renderTileSheet(bytes, offset, count, columns, palette, colors, target) {
  const width = columns * 8;
  const lut = [0, 1, 2, 3].map((c) => colors[applyPalette(palette, c)]);
  for (let t = 0; t < count; t++) {
    const src = offset + t * TILE_BYTES;
    const x0 = (t % columns) * 8;
    const y0 = ((t / columns) | 0) * 8;
    for (let row = 0; row < 8; row++) {
      const lo = bytes[src + row * 2] ?? 0;
      const hi = bytes[src + row * 2 + 1] ?? 0;
      let out = (y0 + row) * width + x0;
      for (let bit = 7; bit >= 0; bit--) {
        target[out++] = lut[(((hi >> bit) & 1) << 1) | ((lo >> bit) & 1)];
      }
    }
  }
}

/**
 * Draws a whole 32x32 tilemap (256x256 pixels).
 * @param {Uint8Array} vram
 * @param {number} mapBase VRAM offset of the map, one of MAP_BASES
 * @param {boolean} lowTiles tile addressing mode (LCDC bit 4)
 * @param {Uint32Array} target 256x256 destination
 */
export function renderTilemap(vram, mapBase, lowTiles, palette, colors, target) {
  const lut = [0, 1, 2, 3].map((c) => colors[applyPalette(palette, c)]);
  for (let cell = 0; cell < MAP_SIZE * MAP_SIZE; cell++) {
    const src = tileNumber(vram[mapBase + cell], lowTiles) * TILE_BYTES;
    const x0 = (cell % MAP_SIZE) * 8;
    const y0 = ((cell / MAP_SIZE) | 0) * 8;
    for (let row = 0; row < 8; row++) {
      const lo = vram[src + row * 2];
      const hi = vram[src + row * 2 + 1];
      let out = (y0 + row) * 256 + x0;
      for (let bit = 7; bit >= 0; bit--) {
        target[out++] = lut[(((hi >> bit) & 1) << 1) | ((lo >> bit) & 1)];
      }
    }
  }
}

/**
 * Decodes the 40 sprite entries in OAM.
 * @return {Array<{index: number, x: number, y: number, tile: number, attr: number,
 *     height: number, behind: boolean, flipX: boolean, flipY: boolean, palette: number,
 *     onScreen: boolean}>} x/y are screen coordinates of the top-left corner
 */
export function readSprites(oam, lcdc) {
  const height = lcdc & 0x04 ? 16 : 8;
  const sprites = [];
  for (let index = 0; index < 40; index++) {
    const base = index * 4;
    const y = oam[base] - 16;
    const x = oam[base + 1] - 8;
    const attr = oam[base + 3];
    sprites.push({
      index, x, y,
      tile: height === 16 ? oam[base + 2] & 0xfe : oam[base + 2],
      attr, height,
      behind: (attr & 0x80) !== 0,
      flipY: (attr & 0x40) !== 0,
      flipX: (attr & 0x20) !== 0,
      palette: (attr >> 4) & 1,
      onScreen: x > -8 && x < 160 && y > -height && y < 144,
    });
  }
  return sprites;
}

/**
 * Draws one sprite as it appears on screen (flips applied, colour 0 transparent).
 * @param {Uint32Array} target `8 * height` pixels, 8 wide
 * @param {number} transparent packed pixel value for colour 0
 */
export function renderSprite(vram, sprite, palette, colors, transparent, target) {
  for (let y = 0; y < sprite.height; y++) {
    const row = sprite.flipY ? sprite.height - 1 - y : y;
    const src = (sprite.tile + (row >> 3)) * TILE_BYTES + (row & 7) * 2;
    const lo = vram[src];
    const hi = vram[src + 1];
    for (let x = 0; x < 8; x++) {
      const bit = sprite.flipX ? x : 7 - x;
      const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
      target[y * 8 + x] = color === 0 ? transparent : colors[applyPalette(palette, color)];
    }
  }
}

/**
 * Counts where each VRAM tile is referenced right now.
 * @return {{bg: Uint16Array, window: Uint16Array, sprites: Uint16Array}} per-tile
 *     counts: cells in the background map, cells in the window map, sprites
 */
export function tileUsage(vram, oam, lcdc) {
  const bg = new Uint16Array(VRAM_TILES);
  const window = new Uint16Array(VRAM_TILES);
  const sprites = new Uint16Array(VRAM_TILES);
  const lowTiles = (lcdc & 0x10) !== 0;
  const bgBase = lcdc & 0x08 ? 0x1c00 : 0x1800;
  const winBase = lcdc & 0x40 ? 0x1c00 : 0x1800;
  for (let cell = 0; cell < MAP_SIZE * MAP_SIZE; cell++) {
    bg[tileNumber(vram[bgBase + cell], lowTiles)]++;
    if (lcdc & 0x20) window[tileNumber(vram[winBase + cell], lowTiles)]++;
  }
  for (const sprite of readSprites(oam, lcdc)) {
    if (!sprite.onScreen) continue;
    sprites[sprite.tile]++;
    if (sprite.height === 16) sprites[sprite.tile + 1]++;
  }
  return { bg, window, sprites };
}

/**
 * Explains one pixel of the last rendered frame: which background or window tile is
 * there, and which sprite (if any) covers it.
 * @return {{x: number, y: number,
 *     bg: ?{tile: number, window: boolean, mapAddress: number, col: number, row: number},
 *     sprite: ?{tile: number, index: number, hidden: boolean}}}
 *     `bg` is null where the background is switched off; `sprite.hidden` means the
 *     sprite pixel lost to the background.
 */
export function describePixel(ppu, x, y) {
  const i = y * SCREEN_W + x;
  const bgInfo = ppu.bgInfo[i];
  const objInfo = ppu.objInfo[i];
  let bg = null;
  let sprite = null;
  if (bgInfo & INFO_VALID) {
    const offset = (bgInfo >> INFO_MAP_SHIFT) & INFO_MAP_MASK;
    bg = {
      tile: bgInfo & INFO_TILE_MASK,
      window: (bgInfo & INFO_WINDOW) !== 0,
      mapAddress: 0x9800 + offset,
      col: offset & 31,
      row: (offset >> 5) & 31,
    };
  }
  if (objInfo & INFO_VALID) {
    sprite = {
      tile: objInfo & INFO_TILE_MASK,
      index: (objInfo >> INFO_OAM_SHIFT) & INFO_OAM_MASK,
      hidden: (objInfo & INFO_OBJ_HIDDEN) !== 0,
    };
  }
  return { x, y, bg, sprite };
}

/** The tile whose pixel is actually visible at this spot, or -1 for none. */
export function visibleTileAt(ppu, i) {
  const objInfo = ppu.objInfo[i];
  if ((objInfo & INFO_VALID) && !(objInfo & INFO_OBJ_HIDDEN)) return objInfo & INFO_TILE_MASK;
  const bgInfo = ppu.bgInfo[i];
  return bgInfo & INFO_VALID ? bgInfo & INFO_TILE_MASK : -1;
}
