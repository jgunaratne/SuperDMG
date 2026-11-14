// Full 24-bit (16.7M-color) pixel-layout-locked colorization engine ("Advanced Tile Mode").
//
// Keeps 100% exact 8x8 Game Boy pixel positions and crisp square pixel boundaries
// (4x4 nearest-neighbor blocks at 640x576, zero Scale2x morphing or sub-pixel blur),
// while unlocking the full 24-bit RGB palette (64 x [R, G, B] = 192 bytes per 8x8 tile):
//   1. Pre-scans uncompressed 2bpp tiles across the Cartridge ROM + active VRAM (`tier: 'rom'`)
//      so newly entered screens have instant starter color with zero wait.
//   2. Automatically promotes visible rooms/towns/battles to scene-aware 24-bit color
//      (`tier: 'scene'`) via Gemini whole-screen guided color transfer so multi-tile
//      trees, roofs, grass, cliffs and character outfits get rich million-color shading
//      while staying 100% true to the pixel layout.

import {
  SCREEN_W, SCREEN_H, INFO_VALID, INFO_TILE_MASK, INFO_WINDOW, INFO_OBJ_HIDDEN,
} from './ppu.js';
import {
  TILE_BYTES, VRAM_TILES, MAP_SIZE, decodeTile, readSprites, tileNumber,
} from './tiles.js';

export const HD_SCALE = 4;
export const HD_TILE_PX = 8 * HD_SCALE;           // 32 (8x8 crisp 4x4 pixel blocks)
export const HD_SCREEN_W = SCREEN_W * HD_SCALE;   // 640
export const HD_SCREEN_H = SCREEN_H * HD_SCALE;   // 576

export const HD_STYLES = [
  {
    id: 'snes',
    name: '16-bit SNES',
    prompt: 'rich, vibrant 16-bit Super Nintendo pixel art (Chrono Trigger and Secret of Mana color richness: lush emerald greens, warm terracotta roofs and cedar wood, deep water, sunlit stone, and distinct character hair, skin, and outfit colors)',
  },
  {
    id: 'painted',
    name: 'Hand-Painted',
    prompt: 'richly colored 2D storybook gouache illustration with deep atmospheric hues, warm sunlight, lush foliage, natural shadows, and expressive multi-color character palettes',
  },
  {
    id: 'gbcdx',
    name: 'GBC DX',
    prompt: 'vibrant Game Boy Color DX deluxe remaster with saturated retro colors, lush green meadows, rich brick and wood tones, and multi-color character sprites',
  },
  {
    id: 'neon',
    name: 'Cyber Neon',
    prompt: 'vivid synthwave arcade art with glowing electric cyan, magenta, gold, emerald, and deep midnight indigo contrast',
  },
];

export const STYLE_CURVES = {
  snes:    { L: [0.92, 0.72, 0.50, 0.20], boost: [0.85, 1.25, 1.25, 0.45] },
  painted: { L: [0.93, 0.74, 0.52, 0.22], boost: [0.90, 1.18, 1.18, 0.50] },
  gbcdx:   { L: [0.94, 0.71, 0.47, 0.17], boost: [0.95, 1.40, 1.40, 0.40] },
  neon:    { L: [0.89, 0.69, 0.46, 0.15], boost: [1.05, 1.48, 1.48, 0.65] },
};

const HEX_BYTE = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const CHROMA_QUANT = 320;

// --- OKLab perceptual color space ------------------------------------------------------

const SRGB_TO_LIN = Float32Array.from({ length: 256 }, (_, c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

function linToSrgbByte(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * (v ** (1 / 2.4)) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

/** Converts 8-bit sRGB [0..255] into perceptual OKLab [L, a, b]. */
export function rgbToOklab(r, g, b) {
  const lr = SRGB_TO_LIN[r & 0xff], lg = SRGB_TO_LIN[g & 0xff], lb = SRGB_TO_LIN[b & 0xff];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/** Converts perceptual OKLab [L, a, b] into clamped 8-bit sRGB [r, g, b]. */
export function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    linToSrgbByte(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linToSrgbByte(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linToSrgbByte(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

export function packChroma64(abFloat128) {
  const out = new Uint8Array(128);
  for (let i = 0; i < 64; i++) {
    out[i * 2] = Math.max(-127, Math.min(127, Math.round(abFloat128[i * 2] * CHROMA_QUANT))) & 0xff;
    out[i * 2 + 1] = Math.max(-127, Math.min(127, Math.round(abFloat128[i * 2 + 1] * CHROMA_QUANT))) & 0xff;
  }
  return out;
}

/** Converts legacy 128-byte OKLab chroma into 192-byte 24-bit RGB (`8x8x3`). */
export function chroma128ToRgb24(raw64, packedChroma128, palReg = 0xe4, curve = STYLE_CURVES.snes) {
  const rgb24 = new Uint8Array(64 * 3);
  for (let i = 0; i < 64; i++) {
    const c = raw64[i] & 3;
    const sh = (palReg >> (c * 2)) & 3;
    const qa = (packedChroma128[i * 2] << 24) >> 24;
    const qb = (packedChroma128[i * 2 + 1] << 24) >> 24;
    const [r, g, b] = oklabToRgb(curve.L[sh], (qa / CHROMA_QUANT) * curve.boost[sh], (qb / CHROMA_QUANT) * curve.boost[sh]);
    rgb24[i * 3] = r;
    rgb24[i * 3 + 1] = g;
    rgb24[i * 3 + 2] = b;
  }
  return rgb24;
}

/** Downsamples a 32x32 RGBA tile into 192-byte 24-bit `8x8` RGB. */
export function rgba32ToRgb24(rgba) {
  const rgb24 = new Uint8Array(64 * 3);
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
          const o = ((py * 4 + dy) * 32 + (px * 4 + dx)) * 4;
          if (rgba[o + 3] > 0) {
            r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2]; n++;
          }
        }
      }
      if (n > 0) {
        const dst = (py * 8 + px) * 3;
        rgb24[dst] = Math.round(r / n);
        rgb24[dst + 1] = Math.round(g / n);
        rgb24[dst + 2] = Math.round(b / n);
      }
    }
  }
  return rgb24;
}

// --- Tile primitives -------------------------------------------------------------------

export function tileFingerprint(bytes, offset = 0) {
  let out = '';
  for (let i = 0; i < TILE_BYTES; i++) out += HEX_BYTE[bytes[offset + i] ?? 0];
  return out;
}

export function hexToTileBytes(hex) {
  const out = new Uint8Array(TILE_BYTES);
  for (let i = 0; i < TILE_BYTES; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

export function packRgba(r, g, b, a = 255) {
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

export function parseHexRgb(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function tileStats(raw) {
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < 64; i++) counts[raw[i] & 3]++;
  let unique = 0;
  let domColor = 0;
  for (let c = 0; c < 4; c++) {
    if (counts[c] > 0) unique++;
    if (counts[c] > counts[domColor]) domColor = c;
  }
  let borderZero = 0;
  for (let i = 0; i < 8; i++) {
    if (raw[i] === 0) borderZero++;
    if (raw[56 + i] === 0) borderZero++;
    if (i > 0 && i < 7 && raw[i * 8] === 0) borderZero++;
    if (i > 0 && i < 7 && raw[i * 8 + 7] === 0) borderZero++;
  }
  return { counts, unique, domColor, domShare: counts[domColor] / 64, borderZero };
}

/** Returns true if a decoded 8x8 tile is a 2-color text/UI glyph rather than a border or world art tile. */
export function isGlyphTile(raw, st = tileStats(raw)) {
  if (st.unique !== 2 || st.counts[0] < 18) return false;
  for (let r = 0; r < 8; r++) {
    let fullRow = true, fullCol = true;
    for (let c = 0; c < 8; c++) {
      if (raw[r * 8 + c] === 0) fullRow = false;
      if (raw[c * 8 + r] === 0) fullCol = false;
    }
    if (fullRow || fullCol) return false;
  }
  return true;
}

export function exteriorMask(raw, targetColor = 0) {
  const mask = new Uint8Array(64);
  const queue = [];
  const push = (x, y) => {
    const i = y * 8 + x;
    if (!mask[i] && raw[i] === targetColor) {
      mask[i] = 1;
      queue.push(i);
    }
  };
  for (let i = 0; i < 8; i++) {
    push(i, 0); push(i, 7); push(0, i); push(7, i);
  }
  while (queue.length) {
    const i = queue.pop();
    const x = i & 7, y = i >> 3;
    if (x > 0) push(x - 1, y);
    if (x < 7) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < 7) push(x, y + 1);
  }
  return mask;
}

export function scale2x(src, w, h) {
  const dst = new Uint8Array(w * 2 * h * 2);
  const at = (x, y) => src[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const ow = w * 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      const b = at(x, y - 1), h2 = at(x, y + 1), d = at(x - 1, y), f = at(x + 1, y);
      let e0 = p, e1 = p, e2 = p, e3 = p;
      if (b !== h2 && d !== f) {
        if (d === b) e0 = d;
        if (b === f) e1 = f;
        if (d === h2) e2 = d;
        if (h2 === f) e3 = f;
      }
      const ox = x * 2, oy = y * 2;
      dst[oy * ow + ox] = e0;
      dst[oy * ow + ox + 1] = e1;
      dst[(oy + 1) * ow + ox] = e2;
      dst[(oy + 1) * ow + ox + 1] = e3;
    }
  }
  return dst;
}

/** Renders an 8x8 tile at 32x32 with exact 4x4 nearest-neighbor Game Boy pixel blocks. */
export function renderCrispTile32(raw64, palReg, colors4, bgTileRgba = null, transparentZero = false) {
  const out = new Uint8Array(HD_TILE_PX * HD_TILE_PX * 4);
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const c = raw64[py * 8 + px] & 3;
      if (transparentZero && c === 0) continue;
      const sh = (palReg >> (c * 2)) & 3;
      const useBg = !transparentZero && sh === 0 && bgTileRgba;
      const [r, g, b] = colors4[sh];
      for (let dy = 0; dy < HD_SCALE; dy++) {
        for (let dx = 0; dx < HD_SCALE; dx++) {
          const o = ((py * HD_SCALE + dy) * HD_TILE_PX + (px * HD_SCALE + dx)) * 4;
          if (useBg) {
            out[o] = bgTileRgba[o];
            out[o + 1] = bgTileRgba[o + 1];
            out[o + 2] = bgTileRgba[o + 2];
          } else {
            out[o] = r;
            out[o + 1] = g;
            out[o + 2] = b;
          }
          out[o + 3] = 255;
        }
      }
    }
  }
  return out;
}

export function shiftTile2bpp(bytes16, dx, dy) {
  const out = new Uint8Array(TILE_BYTES);
  const s = dx & 7;
  for (let r = 0; r < 8; r++) {
    const sr = ((r + dy) & 7) * 2;
    const lo = bytes16[sr], hi = bytes16[sr + 1];
    out[r * 2] = s ? ((lo << s) | (lo >>> (8 - s))) & 0xff : lo;
    out[r * 2 + 1] = s ? ((hi << s) | (hi >>> (8 - s))) & 0xff : hi;
  }
  return out;
}

/** Cyclically shifts a 192-byte 24-bit 8x8 RGB buffer left by `dx` and up by `dy` pixels. */
export function shiftRgb24(rgb192, dx, dy) {
  const out = new Uint8Array(192);
  for (let y = 0; y < 8; y++) {
    const sy = (y + dy + 64) & 7;
    for (let x = 0; x < 8; x++) {
      const sx = (x + dx + 64) & 7;
      const dst = (y * 8 + x) * 3;
      const src = (sy * 8 + sx) * 3;
      out[dst] = rgb192[src];
      out[dst + 1] = rgb192[src + 1];
      out[dst + 2] = rgb192[src + 2];
    }
  }
  return out;
}

export function shiftRgba32(rgba, dxPx, dyPx) {
  const out = new Uint8Array(HD_TILE_PX * HD_TILE_PX * 4);
  for (let y = 0; y < HD_TILE_PX; y++) {
    const sy = (y + dyPx + HD_TILE_PX * 8) & (HD_TILE_PX - 1);
    for (let x = 0; x < HD_TILE_PX; x++) {
      const sx = (x + dxPx + HD_TILE_PX * 8) & (HD_TILE_PX - 1);
      const dst = (y * HD_TILE_PX + x) * 4;
      const src = (sy * HD_TILE_PX + sx) * 4;
      out[dst] = rgba[src];
      out[dst + 1] = rgba[src + 1];
      out[dst + 2] = rgba[src + 2];
      out[dst + 3] = rgba[src + 3];
    }
  }
  return out;
}

// --- Whole-ROM 2bpp Tile Scanner -------------------------------------------------------

export function scoreRomArtTile(bytes, off) {
  let nonZeroBytes = 0;
  for (let i = 0; i < TILE_BYTES; i++) if (bytes[off + i] !== 0) nonZeroBytes++;
  if (nonZeroBytes < 3) return 0;

  const raw = decodeTile(bytes, off);
  const st = tileStats(raw);
  if (st.unique <= 1) return 0;
  const fg = 64 - st.counts[0];
  if (fg < 4) return 0;

  let leftFg = 0, isolatedFg = 0, same = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const c = raw[y * 8 + x];
      if (c !== 0 && x < 5) leftFg++;
      if (x < 7 && c === raw[y * 8 + x + 1]) same++;
      if (y < 7 && c === raw[(y + 1) * 8 + x]) same++;
      if (c !== 0) {
        const hasSameNeighbor =
          (x > 0 && raw[y * 8 + x - 1] === c) ||
          (x < 7 && raw[y * 8 + x + 1] === c) ||
          (y > 0 && raw[(y - 1) * 8 + x] === c) ||
          (y < 7 && raw[(y + 1) * 8 + x] === c);
        if (!hasSameNeighbor) isolatedFg++;
      }
    }
  }
  if (leftFg === 0 && fg < 20) return 0;
  if (isolatedFg > fg * 0.45) return 0;

  let asciiCount = 0, hasHighBit = false;
  for (let i = 0; i < TILE_BYTES; i++) {
    const b = bytes[off + i];
    if ((b >= 0x20 && b <= 0x5a) || b === 0x00) asciiCount++;
    if (b & 0x80) hasHighBit = true;
  }
  if (asciiCount >= 13 && !hasHighBit) return 0;

  return same / 112;
}

export function extractRomArtTiles(rom, maxTiles = 512) {
  if (!rom || rom.length < 0x200) return [];
  const seen = new Set();
  const keys = [];
  const CHUNK = 512;

  for (let base = 0x150; base + 64 <= rom.length && keys.length < maxTiles; base += CHUNK) {
    const end = Math.min(rom.length, base + CHUNK);
    let bestPhase = 0, bestScore = -1;
    for (let phase = 0; phase < 16; phase++) {
      let sum = 0, cnt = 0;
      for (let off = base + phase; off + TILE_BYTES <= end; off += TILE_BYTES) {
        const s = scoreRomArtTile(rom, off);
        if (s >= 0.53) { sum += s; cnt++; }
      }
      if (cnt >= 5 && sum > bestScore) { bestScore = sum; bestPhase = phase; }
    }
    if (bestScore < 0) continue;

    const slots = [];
    for (let off = base + bestPhase; off + TILE_BYTES <= end; off += TILE_BYTES) {
      slots.push({ off, score: scoreRomArtTile(rom, off) });
    }
    let i = 0;
    while (i < slots.length) {
      if (slots[i].score < 0.53) { i++; continue; }
      let j = i, good = 0, gap = 0;
      while (j < slots.length) {
        if (slots[j].score >= 0.51) { good++; gap = 0; j++; }
        else if (gap < 1 && j + 1 < slots.length && slots[j + 1].score >= 0.55) { gap++; j++; }
        else break;
      }
      if (good >= 5) {
        for (let k = i; k < j && keys.length < maxTiles; k++) {
          if (slots[k].score < 0.49) continue;
          const raw = decodeTile(rom, slots[k].off);
          const st = tileStats(raw);
          if (st.unique <= 1 || isGlyphTile(raw, st)) continue;
          const key = tileFingerprint(rom, slots[k].off);
          if (!seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
      }
      i = j + 1;
    }
  }
  return keys;
}

export function hasStablePalette(ppu) {
  if (!(ppu.lcdc & 0x80)) return false;
  const shades = new Set([
    ppu.bgp & 3,
    (ppu.bgp >> 2) & 3,
    (ppu.bgp >> 4) & 3,
    (ppu.bgp >> 6) & 3,
  ]);
  return shades.size >= 3;
}

export function collectScreenTiles(ppu, title = '', rom = null) {
  const vram = ppu.vram;
  const lowTilesDefault = (ppu.lcdc & 0x10) !== 0;
  const bgMapDefault = ppu.lcdc & 0x08 ? 0x1c00 : 0x1800;
  const winMapDefault = ppu.lcdc & 0x40 ? 0x1c00 : 0x1800;
  const windowOn = (ppu.lcdc & 0x21) === 0x21 && ppu.wy < SCREEN_H && ppu.wx <= 166;

  const scxAligned = (ppu.scx & 7) === 0 && (ppu.scy & 7) === 0;
  const scxTile = ppu.scx >> 3;
  const scyTile = ppu.scy >> 3;
  const winStartRow = windowOn ? Math.max(0, Math.ceil(ppu.wy / 8)) : 18;
  const winStartCol = windowOn ? Math.max(0, (ppu.wx - 7) >> 3) : 20;

  const gridCells = [];
  const bgCounts = new Map();
  const tilesSummary = [];
  const seenSummary = new Set();

  for (let gy = 0; gy < 18; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      let t = -1;
      let isWin = false;
      if (scxAligned) {
        const sampleInfo = ppu.bgInfo[(gy * 8 + 4) * SCREEN_W + (gx * 8 + 4)];
        if (sampleInfo & INFO_VALID) {
          t = sampleInfo & INFO_TILE_MASK;
          isWin = (sampleInfo & INFO_WINDOW) !== 0;
        }
      }
      if (t < 0) {
        if (windowOn && gy >= winStartRow && gx >= winStartCol) {
          t = tileNumber(vram[winMapDefault + (gy - winStartRow) * 32 + (gx - winStartCol)], lowTilesDefault);
          isWin = true;
        } else {
          const mx = (scxTile + gx) & 31, my = (scyTile + gy) & 31;
          t = tileNumber(vram[bgMapDefault + my * 32 + mx], lowTilesDefault);
        }
      }
      const key = tileFingerprint(vram, t * TILE_BYTES);
      gridCells.push({ key, isWin });
      if (!isWin) bgCounts.set(key, (bgCounts.get(key) || 0) + 1);
    }
  }

  let groundKey = null, groundCount = 0;
  for (const [key, count] of bgCounts) {
    const st = tileStats(decodeTile(hexToTileBytes(key), 0));
    if (st.domColor === 0 && st.domShare >= 0.75 && count > groundCount) {
      groundKey = key;
      groundCount = count;
    }
  }

  for (const cell of gridCells) {
    const ns = `${cell.isWin ? 'hud' : 'bg'}:${cell.key}`;
    if (seenSummary.has(ns)) continue;
    seenSummary.add(ns);
    const raw = decodeTile(hexToTileBytes(cell.key), 0);
    const st = tileStats(raw);
    const glyph = isGlyphTile(raw, st);
    const role = st.unique === 1 ? 'solid'
      : cell.isWin ? 'hud'
        : glyph ? 'glyph'
          : (cell.key !== groundKey && groundKey && st.borderZero >= 14 && st.counts[0] < 60) ? 'cutout'
            : 'surface';
    tilesSummary.push({ key: cell.key, role, glyph, pal: ppu.bgp });
  }

  const onScreenSprites = readSprites(ppu.oam, ppu.lcdc).filter((s) => s.onScreen);
  const spriteClusters = [];
  const visited = new Set();

  for (let i = 0; i < onScreenSprites.length; i++) {
    if (visited.has(i)) continue;
    const group = [onScreenSprites[i]];
    visited.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < onScreenSprites.length; j++) {
        if (visited.has(j)) continue;
        const cand = onScreenSprites[j];
        const touches = group.some((g) =>
          cand.x <= g.x + 8 && cand.x + 8 >= g.x &&
          cand.y <= g.y + g.height && cand.y + cand.height >= g.y
        );
        if (touches) { group.push(cand); visited.add(j); grew = true; }
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const members = [];
    for (const s of group) {
      const pal = s.palette ? ppu.obp1 : ppu.obp0;
      const topIdx = s.height === 16 ? (s.tile & 0xfe) : s.tile;
      const key = tileFingerprint(vram, topIdx * TILE_BYTES);
      const botKey = s.height === 16 ? tileFingerprint(vram, (topIdx + 1) * TILE_BYTES) : null;
      const r0 = decodeTile(vram, topIdx * TILE_BYTES);
      const r1 = botKey ? decodeTile(vram, (topIdx + 1) * TILE_BYTES) : null;
      if (tileStats(r0).unique === 1 && (!r1 || tileStats(r1).unique === 1)) continue;
      minX = Math.min(minX, s.x); minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + 8); maxY = Math.max(maxY, s.y + s.height);
      members.push({
        x: s.x, y: s.y, height: s.height,
        flipX: s.flipX, flipY: s.flipY, pal, key, botKey,
      });
      if (s.height === 16) {
        const sid = `spr16:${key}:${botKey}`;
        if (!seenSummary.has(sid)) { seenSummary.add(sid); tilesSummary.push({ key, pairKey: botKey, role: 'spr16', pal }); }
      } else {
        const sid = `spr8:${key}`;
        if (!seenSummary.has(sid)) { seenSummary.add(sid); tilesSummary.push({ key, role: 'spr8', pal }); }
      }
    }
    if (members.length) {
      spriteClusters.push({ minX, minY, w: maxX - minX, h: maxY - minY, members });
    }
  }

  for (const s of onScreenSprites) {
    if (s.height !== 16) continue;
    const pal = s.palette ? ppu.obp1 : ppu.obp0;
    for (const delta of [-2, 2]) {
      const adj = (s.tile & 0xfe) + delta;
      if (adj < 0 || adj + 1 >= VRAM_TILES) continue;
      const r0 = decodeTile(vram, adj * TILE_BYTES);
      if (tileStats(r0).unique <= 1) continue;
      const key = tileFingerprint(vram, adj * TILE_BYTES);
      const botKey = tileFingerprint(vram, (adj + 1) * TILE_BYTES);
      const already = spriteClusters.some((cl) => cl.members.some((m) => m.key === key && m.botKey === botKey));
      if (already) continue;
      spriteClusters.push({
        minX: 0, minY: 0, w: 8, h: 16,
        members: [{ x: 0, y: 0, height: 16, flipX: false, flipY: false, pal, key, botKey }],
      });
      const sid = `spr16:${key}:${botKey}`;
      if (!seenSummary.has(sid)) { seenSummary.add(sid); tilesSummary.push({ key, pairKey: botKey, role: 'spr16', pal }); }
    }
  }

  const sheetSet = new Set();
  const extraSheetKeys = [];
  for (let t = 0; t < VRAM_TILES; t++) {
    const raw = decodeTile(vram, t * TILE_BYTES);
    const st = tileStats(raw);
    if (st.unique <= 1 || isGlyphTile(raw, st)) continue;
    const key = tileFingerprint(vram, t * TILE_BYTES);
    if (!sheetSet.has(key)) { sheetSet.add(key); extraSheetKeys.push(key); }
  }
  if (rom) {
    for (const key of extractRomArtTiles(rom, 512)) {
      if (!sheetSet.has(key)) { sheetSet.add(key); extraSheetKeys.push(key); }
    }
  }

  return {
    title,
    bgp: ppu.bgp,
    obp0: ppu.obp0,
    obp1: ppu.obp1,
    groundKey,
    shades: ppu.display,
    gridCells,
    spriteClusters,
    extraSheetKeys,
    tiles: tilesSummary,
  };
}

// --- Runtime 24-Bit Pixel-Layout-Locked Tile Pack --------------------------------------

function unpackColors4(packed4) {
  return Array.from({ length: 4 }, (_, i) => {
    const p = packed4[i];
    return [p & 0xff, (p >> 8) & 0xff, (p >> 16) & 0xff];
  });
}

function rgbaToU32(rgba) {
  const u32 = new Uint32Array(HD_TILE_PX * HD_TILE_PX);
  for (let i = 0; i < u32.length; i++) {
    const o = i * 4;
    u32[i] = rgba[o + 3] === 0 ? 0 : packRgba(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
  }
  return u32;
}

/**
 * Renders a 24-bit 8x8 RGB tile (`rgb24` = 192 bytes) into a crisp 32x32 RGBA buffer
 * (exact 4x4 square blocks per Game Boy pixel), honoring runtime `palReg` fades/flashes!
 */
export function materializeRgb24Tile32(raw64, rgb24, palReg, basePal = 0xe4, transparentZero = false) {
  const out = new Uint8Array(HD_TILE_PX * HD_TILE_PX * 4);
  const samePal = palReg === basePal;
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const idx = py * 8 + px;
      const c = raw64[idx] & 3;
      if (transparentZero && c === 0) continue;

      let r = rgb24[idx * 3];
      let g = rgb24[idx * 3 + 1];
      let b = rgb24[idx * 3 + 2];

      if (!samePal) {
        const baseSh = (basePal >> (c * 2)) & 3;
        const curSh = (palReg >> (c * 2)) & 3;
        const delta = curSh - baseSh;
        if (delta < 0) {
          // Fading lighter toward white (e.g. BGP whiteout transition or damage flash)
          const t = Math.min(1, (-delta) / 3);
          r = Math.round(r + (248 - r) * t);
          g = Math.round(g + (248 - g) * t);
          b = Math.round(b + (244 - b) * t);
        } else if (delta > 0) {
          // Fading darker toward black (e.g. BGP blackout transition)
          const t = Math.min(1, delta / 3);
          r = Math.round(r * (1 - t * 0.88));
          g = Math.round(g * (1 - t * 0.88));
          b = Math.round(b * (1 - t * 0.88));
        }
      }

      for (let dy = 0; dy < HD_SCALE; dy++) {
        for (let dx = 0; dx < HD_SCALE; dx++) {
          const o = ((py * HD_SCALE + dy) * HD_TILE_PX + (px * HD_SCALE + dx)) * 4;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = 255;
        }
      }
    }
  }
  return out;
}

export class HdTilePack {
  constructor(style = 'snes') {
    this.style = style;
    this.curve = STYLE_CURVES[style] || STYLE_CURVES.snes;
    this.theme = '';
    this.model = '';
    this.wholeGameDone = false;
    this.themeColors = [[236, 232, 214], [148, 178, 112], [86, 114, 74], [28, 26, 32]];
    this.hudColors = [[246, 241, 230], [186, 162, 132], [108, 86, 72], [30, 24, 30]];
    this.hasTheme = false;
    this.groundKey = null;

    /**
     * 24-bit `8x8` RGB tile stores:
     * `{ rgb24: Uint8Array(192), rawBytes: Uint8Array(16), basePal: number, surface: boolean, tier: 'scene'|'rom' }`
     */
    this.tileRgb = new Map();
    this.sprRgb = new Map();
    this.winRgb = new Map();

    this.renderCache = new Map();
    this.missingKeys = new Set();
    /** Keys currently visible on screen that only have blind 1D ROM-sheet starter colors (`tier: 'rom'`). */
    this.romTierOnScreen = new Set();
  }

  get bgTiles() { return this.tileRgb; }
  get sprTiles() { return this.sprRgb; }
  get winTiles() { return this.winRgb; }

  get count() {
    const all = new Set([...this.tileRgb.keys(), ...this.sprRgb.keys(), ...this.winRgb.keys()]);
    return all.size;
  }

  ingest({ theme, model, wholeGameDone, shades, hudShades, groundKey, tiles = {} }) {
    if (theme) this.theme = theme;
    if (model) this.model = model;
    if (wholeGameDone) this.wholeGameDone = true;
    if (Array.isArray(shades) && shades.length === 4) {
      this.themeColors = shades.map((h, i) => parseHexRgb(h, this.themeColors[i]));
      this.hasTheme = true;
    }
    if (Array.isArray(hudShades) && hudShades.length === 4) {
      this.hudColors = hudShades.map((h, i) => parseHexRgb(h, this.hudColors[i]));
    }
    if (groundKey) this.groundKey = groundKey;
    this.renderCache.clear();

    for (const entry of Object.values(tiles)) {
      if (!entry || !entry.key) continue;
      const rawBytes = hexToTileBytes(entry.key);
      const raw64 = decodeTile(rawBytes, 0);
      const basePal = entry.pal ?? 0xe4;
      const tier = entry.tier === 'rom' ? 'rom' : 'scene';

      let rgb24 = null;
      if (entry.rgb24 instanceof Uint8Array && entry.rgb24.length === 192) {
        rgb24 = entry.rgb24;
      } else if (entry.rgb24Base64) {
        const dec = base64ToBytes(entry.rgb24Base64);
        if (dec.length === 192) rgb24 = dec;
      } else if (entry.chroma instanceof Uint8Array || entry.chromaBase64) {
        const ch = entry.chroma instanceof Uint8Array ? entry.chroma : base64ToBytes(entry.chromaBase64);
        if (ch.length === 128) rgb24 = chroma128ToRgb24(raw64, ch, basePal, this.curve);
      } else if (entry.rgba instanceof Uint8Array || entry.rgbaBase64) {
        const rgba = entry.rgba instanceof Uint8Array ? entry.rgba : base64ToBytes(entry.rgbaBase64);
        if (rgba.length === HD_TILE_PX * HD_TILE_PX * 4) rgb24 = rgba32ToRgb24(rgba);
      }
      if (!rgb24) continue;

      const rec = { rgb24, rawBytes, basePal, surface: entry.role === 'surface', tier };

      if (entry.role === 'spr') {
        const prev = this.sprRgb.get(entry.key);
        if (!prev || tier === 'scene' || prev.tier === 'rom') this.sprRgb.set(entry.key, rec);
        if (!this.tileRgb.has(entry.key)) this.tileRgb.set(entry.key, rec);
        this.missingKeys.delete(`spr:${entry.key}`);
        if (tier === 'scene') this.romTierOnScreen.delete(`spr:${entry.key}`);
      } else if (entry.role === 'win') {
        const prev = this.winRgb.get(entry.key);
        if (!prev || tier === 'scene' || prev.tier === 'rom') this.winRgb.set(entry.key, rec);
        this.missingKeys.delete(`win:${entry.key}`);
        if (tier === 'scene') this.romTierOnScreen.delete(`win:${entry.key}`);
      } else {
        const prev = this.tileRgb.get(entry.key);
        if (!prev || tier === 'scene' || prev.tier === 'rom') this.tileRgb.set(entry.key, rec);
        this.missingKeys.delete(`bg:${entry.key}`);
        if (tier === 'scene') this.romTierOnScreen.delete(`bg:${entry.key}`);
      }
    }
  }

  toRecord() {
    const tiles = {};
    for (const [key, v] of this.tileRgb) {
      tiles[`bg:${key}`] = {
        key, role: v.surface ? 'surface' : 'bg', tier: v.tier, pal: v.basePal,
        rgb24Base64: bytesToBase64(v.rgb24),
      };
    }
    for (const [key, v] of this.winRgb) {
      tiles[`win:${key}`] = {
        key, role: 'win', tier: v.tier, pal: v.basePal,
        rgb24Base64: bytesToBase64(v.rgb24),
      };
    }
    for (const [key, v] of this.sprRgb) {
      tiles[`spr:${key}`] = {
        key, role: 'spr', tier: v.tier, pal: v.basePal,
        rgb24Base64: bytesToBase64(v.rgb24),
      };
    }
    const toHex = ([r, g, b]) => `#${HEX_BYTE[r]}${HEX_BYTE[g]}${HEX_BYTE[b]}`;
    return {
      style: this.style,
      theme: this.theme,
      model: this.model,
      wholeGameDone: this.wholeGameDone,
      groundKey: this.groundKey,
      shades: this.themeColors.map(toHex),
      hudShades: this.hudColors.map(toHex),
      tiles,
    };
  }

  static fromRecord(record) {
    const pack = new HdTilePack(record.style || 'snes');
    pack.ingest(record);
    return pack;
  }

  findShiftedSurface(bytes16) {
    for (const [, entry] of this.tileRgb) {
      if (!entry.surface || !entry.rawBytes) continue;
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          if (dx === 0 && dy === 0) continue;
          const shifted = shiftTile2bpp(entry.rawBytes, dx, dy);
          let match = true;
          for (let i = 0; i < TILE_BYTES; i++) {
            if (shifted[i] !== bytes16[i]) { match = false; break; }
          }
          if (match) {
            return {
              rgb24: shiftRgb24(entry.rgb24, dx, dy),
              rawBytes: new Uint8Array(bytes16),
              basePal: entry.basePal,
              surface: false,
              tier: entry.tier,
            };
          }
        }
      }
    }
    return null;
  }

  resolveSlice(bytes, offset, layer, palReg, fallbackPacked4, trackScreen = false) {
    const key = tileFingerprint(bytes, offset);
    const cacheKey = `${layer}:${palReg}:${key}`;
    const cached = this.renderCache.get(cacheKey);
    if (cached) {
      if (trackScreen && cached.tier === 'rom') {
        this.romTierOnScreen.add(`${layer === 'spr' ? 'spr' : 'bg'}:${key}`);
      }
      return cached;
    }

    const raw64 = decodeTile(bytes, offset);
    const st = tileStats(raw64);
    const transparentZero = layer === 'spr';
    const colors4 = this.hasTheme
      ? (layer === 'win' ? this.hudColors : this.themeColors)
      : unpackColors4(fallbackPacked4);

    if (st.unique === 1 || (!transparentZero && isGlyphTile(raw64, st))) {
      const rgba = renderCrispTile32(raw64, palReg, colors4, null, transparentZero);
      const res = { rgba, u32: rgbaToU32(rgba), tier: 'scene' };
      this.renderCache.set(cacheKey, res);
      return res;
    }

    let rec = layer === 'spr'
      ? (this.sprRgb.get(key) || this.tileRgb.get(key))
      : layer === 'win'
        ? (this.winRgb.get(key) || this.tileRgb.get(key))
        : this.tileRgb.get(key);

    if (!rec && layer === 'bg') {
      const shifted = this.findShiftedSurface(bytes.subarray(offset, offset + TILE_BYTES));
      if (shifted) {
        this.tileRgb.set(key, shifted);
        rec = shifted;
      }
    }

    if (rec) {
      if (trackScreen && rec.tier === 'rom') {
        this.romTierOnScreen.add(`${layer === 'spr' ? 'spr' : 'bg'}:${key}`);
      }
      const rgba = materializeRgb24Tile32(raw64, rec.rgb24, palReg, rec.basePal, transparentZero);
      const res = { rgba, u32: rgbaToU32(rgba), tier: rec.tier };
      this.renderCache.set(cacheKey, res);
      return res;
    }

    if (trackScreen && layer !== 'rom') {
      this.missingKeys.add(`${layer === 'spr' ? 'spr' : 'bg'}:${key}`);
    }
    const rgba = renderCrispTile32(raw64, palReg, colors4, null, transparentZero);
    const res = { rgba, u32: rgbaToU32(rgba), tier: 'fallback' };
    this.renderCache.set(cacheKey, res);
    return res;
  }

  resolveBgU32(vram, tileIdx, isWindow, bgp, fallbackPacked4, trackScreen = false) {
    return this.resolveSlice(vram, tileIdx * TILE_BYTES, isWindow ? 'win' : 'bg', bgp, fallbackPacked4, trackScreen).u32;
  }

  resolveSprU32(vram, tileIdx, palReg, fallbackPacked4, trackScreen = false) {
    return this.resolveSlice(vram, tileIdx * TILE_BYTES, 'spr', palReg, fallbackPacked4, trackScreen).u32;
  }

  peekUpgradedRgba(bytes, tileOrOffset, ppu, isRomOffset = false) {
    const offset = isRomOffset ? tileOrOffset : tileOrOffset * TILE_BYTES;
    if (offset < 0 || offset + TILE_BYTES > bytes.length) return null;
    const raw = decodeTile(bytes, offset);
    if (tileStats(raw).unique === 1) return null;
    const key = tileFingerprint(bytes, offset);
    const layer = this.sprRgb.has(key) ? 'spr' : this.winRgb.has(key) ? 'win' : (isRomOffset ? 'rom' : 'bg');
    if (isRomOffset && !this.tileRgb.has(key) && !this.sprRgb.has(key) && !isGlyphTile(raw)) return null;
    const pal = layer === 'spr' ? ppu.obp0 : ppu.bgp;
    const rgba = this.resolveSlice(bytes, offset, layer, pal, new Uint32Array([0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000]), false).rgba;
    if (layer === 'spr') {
      const preview = new Uint8Array(rgba);
      for (let i = 0; i < 1024; i++) {
        if (preview[i * 4 + 3] === 0) {
          preview[i * 4] = 42; preview[i * 4 + 1] = 44; preview[i * 4 + 2] = 55; preview[i * 4 + 3] = 255;
        }
      }
      return preview;
    }
    return rgba;
  }

  renderHdFrame(ppu, fallbackPacked4, outU32) {
    this.romTierOnScreen.clear();
    if (!(ppu.lcdc & 0x80)) {
      const [r, g, b] = this.hasTheme ? this.themeColors[0] : unpackColors4(fallbackPacked4)[0];
      outU32.fill(packRgba(r, g, b, 255));
      return;
    }

    const { vram, bgInfo, objInfo, bgPix, objPix, bgp, obp0, obp1, oam } = ppu;
    const fallbackBackdrop = this.hasTheme
      ? packRgba(this.themeColors[0][0], this.themeColors[0][1], this.themeColors[0][2], 255)
      : fallbackPacked4[0];

    const bgSlotLut = new Array(VRAM_TILES);
    const winSlotLut = new Array(VRAM_TILES);
    const sprSlotLut0 = new Array(VRAM_TILES);
    const sprSlotLut1 = new Array(VRAM_TILES);

    for (let y = 0; y < SCREEN_H; y++) {
      const rowOff = y * SCREEN_W;
      const outRowBase = y * HD_SCALE * HD_SCREEN_W;
      for (let x = 0; x < SCREEN_W; x++) {
        const i = rowOff + x;
        const bInfo = bgInfo[i];
        let pxColor = fallbackBackdrop;
        if (bInfo & INFO_VALID) {
          const t = bInfo & INFO_TILE_MASK;
          const bgTileU32 = (bInfo & INFO_WINDOW)
            ? (winSlotLut[t] || (winSlotLut[t] = this.resolveBgU32(vram, t, true, bgp, fallbackPacked4, true)))
            : (bgSlotLut[t] || (bgSlotLut[t] = this.resolveBgU32(vram, t, false, bgp, fallbackPacked4, true)));
          const bp = bgPix[i];
          pxColor = bgTileU32[((bp >> 3) * HD_SCALE) * HD_TILE_PX + (bp & 7) * HD_SCALE];
        }

        const oInfo = objInfo[i];
        if ((oInfo & INFO_VALID) !== 0 && (oInfo & INFO_OBJ_HIDDEN) === 0) {
          const st = oInfo & INFO_TILE_MASK;
          const oamIdx = (oInfo >> 10) & 0x3f;
          const useObp1 = (oam[oamIdx * 4 + 3] & 0x10) !== 0;
          const sprTileU32 = useObp1
            ? (sprSlotLut1[st] || (sprSlotLut1[st] = this.resolveSprU32(vram, st, obp1, fallbackPacked4, true)))
            : (sprSlotLut0[st] || (sprSlotLut0[st] = this.resolveSprU32(vram, st, obp0, fallbackPacked4, true)));
          const op = objPix[i];
          const sp = sprTileU32[(((op >> 3) & 7) * HD_SCALE) * HD_TILE_PX + (op & 7) * HD_SCALE];
          if (sp !== 0) pxColor = sp;
        }

        const dstX = x * HD_SCALE;
        for (let hy = 0; hy < HD_SCALE; hy++) {
          let dst = outRowBase + hy * HD_SCREEN_W + dstX;
          outU32[dst] = pxColor;
          outU32[dst + 1] = pxColor;
          outU32[dst + 2] = pxColor;
          outU32[dst + 3] = pxColor;
        }
      }
    }
  }

  renderHdVramSheet(vram, paletteReg, fallbackPacked4, targetU32) {
    const columns = 16;
    const width = columns * HD_TILE_PX;
    for (let t = 0; t < VRAM_TILES; t++) {
      const key = tileFingerprint(vram, t * TILE_BYTES);
      const layer = this.sprRgb.has(key) ? 'spr' : this.winRgb.has(key) ? 'win' : 'bg';
      const tileU32 = this.resolveSlice(vram, t * TILE_BYTES, layer, paletteReg, fallbackPacked4, false).u32;
      const x0 = (t % columns) * HD_TILE_PX;
      const y0 = ((t / columns) | 0) * HD_TILE_PX;
      for (let ry = 0; ry < HD_TILE_PX; ry++) {
        let dst = (y0 + ry) * width + x0;
        let src = ry * HD_TILE_PX;
        for (let rx = 0; rx < HD_TILE_PX; rx++) {
          targetU32[dst++] = tileU32[src++] || 0xff372c2a;
        }
      }
    }
  }

  renderHdRomSheet(rom, romOffset, count, paletteReg, fallbackPacked4, targetU32) {
    const columns = 16;
    const width = columns * HD_TILE_PX;
    for (let idx = 0; idx < count; idx++) {
      const off = romOffset + idx * TILE_BYTES;
      const key = tileFingerprint(rom, off);
      const layer = this.sprRgb.has(key) ? 'spr' : 'rom';
      const tileU32 = this.resolveSlice(rom, off, layer, paletteReg, fallbackPacked4, false).u32;
      const x0 = (idx % columns) * HD_TILE_PX;
      const y0 = ((idx / columns) | 0) * HD_TILE_PX;
      for (let ry = 0; ry < HD_TILE_PX; ry++) {
        let dst = (y0 + ry) * width + x0;
        let src = ry * HD_TILE_PX;
        for (let rx = 0; rx < HD_TILE_PX; rx++) {
          targetU32[dst++] = tileU32[src++] || 0xff372c2a;
        }
      }
    }
  }

  renderHdTilemap(vram, mapBase, lowTiles, bgp, isWindow, fallbackPacked4, targetU32) {
    const width = MAP_SIZE * HD_TILE_PX;
    const slotLut = new Array(VRAM_TILES);
    for (let cell = 0; cell < MAP_SIZE * MAP_SIZE; cell++) {
      const t = tileNumber(vram[mapBase + cell], lowTiles);
      const tileU32 = slotLut[t] || (slotLut[t] = this.resolveBgU32(vram, t, isWindow, bgp, fallbackPacked4, false));
      const x0 = (cell % MAP_SIZE) * HD_TILE_PX;
      const y0 = ((cell / MAP_SIZE) | 0) * HD_TILE_PX;
      for (let ry = 0; ry < HD_TILE_PX; ry++) {
        let dst = (y0 + ry) * width + x0;
        let src = ry * HD_TILE_PX;
        for (let rx = 0; rx < HD_TILE_PX; rx++) targetU32[dst++] = tileU32[src++];
      }
    }
  }

  renderHdSprite(vram, sprite, paletteReg, fallbackPacked4, targetU32) {
    const outH = sprite.height * HD_SCALE;
    const topTile = this.resolveSprU32(vram, sprite.tile, paletteReg, fallbackPacked4, false);
    const botTile = sprite.height === 16
      ? this.resolveSprU32(vram, sprite.tile + 1, paletteReg, fallbackPacked4, false)
      : null;
    for (let dy = 0; dy < outH; dy++) {
      const sy = sprite.flipY ? outH - 1 - dy : dy;
      const tileU32 = sy >= HD_TILE_PX && botTile ? botTile : topTile;
      const ty = sy & (HD_TILE_PX - 1);
      for (let dx = 0; dx < HD_TILE_PX; dx++) {
        const tx = sprite.flipX ? HD_TILE_PX - 1 - dx : dx;
        targetU32[dy * HD_TILE_PX + dx] = tileU32[ty * HD_TILE_PX + tx];
      }
    }
  }
}

export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
