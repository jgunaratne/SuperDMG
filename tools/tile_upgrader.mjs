// Server-side 24-Bit Million-Color Guided Colorization Pipeline (Gemini Image API).
//
// Unlocks the full 16.7-million-color 24-bit RGB palette while staying 100% faithful
// to every tile's 8x8 hardware pixel layout:
//   1. Joint-Bilateral 2bpp-Guided Color Transfer: Gemini (`gemini-2.5-flash-image`)
//      paints the assembled 160x144 screen in rich full-spectrum color (emerald grass,
//      shaded terracotta roofs, warm plaster walls, brown tree bark, multi-hue outfits).
//      We sample Gemini's actual [L, a, b] in a 5x5 DMG-shade-guided neighborhood so
//      each pixel gets true 24-bit lighting & hue (never bleached to fixed L=0.92!)
//      while preserving razor-sharp 8x8 hardware pixel contrast and edges.
//   2. Two-Tier Whole-Game + Scene Promotion: Pre-colorizes Cartridge ROM + VRAM sheets
//      upfront (`tier: 'rom'`) for zero-wait room transitions, then automatically
//      promotes visited scenes to full context-aware 24-bit color (`tier: 'scene'`).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng } from './png.mjs';
import { decodeTile } from '../src/core/tiles.js';
import {
  HD_STYLES, STYLE_CURVES, hexToTileBytes, exteriorMask, tileStats, isGlyphTile,
  isLikelySpriteTile, extractSpriteShadePalette, mergeSpriteShadePalette, applySpriteShadePalette,
  rgbToOklab, oklabToRgb, bytesToBase64, base64ToBytes,
} from '../src/core/hdtiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'hd-tiles');
const DEFAULT_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const GREYS = [[246, 246, 246], [186, 186, 186], [112, 112, 112], [28, 28, 28]];
const DMG_NORM = [1.0, 0.68, 0.38, 0.0];
const SCREEN_W = 160, SCREEN_H = 144, SCREEN_SCALE = 4;
const IMG_W = SCREEN_W * SCREEN_SCALE; // 640
const IMG_H = SCREEN_H * SCREEN_SCALE; // 576

const SHEET_COLS = 24, SHEET_ROWS = 24, SHEET_CELL = 32; // up to 24x24 (768x768 square = 576 tiles/sheet)
const MAX_SHEETS = 4; // up to 4 parallel sheets = 2,304 tiles per wave
const MAX_HISTORY_PER_TILE = 8;

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return '';
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'GEMINI_API_KEY' && val) return val;
  }
  return '';
}

export function upgraderStatus() {
  const mode = process.env.HD_TILE_BACKEND || '';
  if (mode === 'procedural') return { available: true, backend: 'procedural', styles: HD_STYLES };
  if (loadGeminiApiKey()) return { available: true, backend: 'gemini-api', styles: HD_STYLES };
  return { available: false, backend: 'none', styles: HD_STYLES };
}

function execFileAsync(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || '').trim();
        reject(new Error(msg.slice(-500) || err.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function readImageAsRgba(filePath, tempPrefix) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return decodePng(bytes);
  }
  const convPath = `${tempPrefix}_conv.png`;
  try {
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', filePath, convPath], 15000);
    return decodePng(fs.readFileSync(convPath));
  } finally {
    fs.rmSync(convPath, { force: true });
  }
}

async function requestGeminiImage({ apiKey, model, parts, aspectRatio, jobPrefix }) {
  const generationConfig = { responseModalities: ['IMAGE'] };
  if (aspectRatio) generationConfig.imageConfig = { aspectRatio };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'superdmg' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
      signal: AbortSignal.timeout(55000),
    },
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error('Gemini image API returned no image payload');
  const rawBytes = Buffer.from(part.inlineData.data, 'base64');
  const outPath = `${jobPrefix}_api.bin`;
  fs.writeFileSync(outPath, rawBytes);
  try {
    const decoded = await readImageAsRgba(outPath, jobPrefix);
    return { decoded, rawBytes, model };
  } finally {
    fs.rmSync(outPath, { force: true });
  }
}

async function colorizeImageWithGemini({
  inputPath,
  prompt,
  jobPrefix,
  referenceImagePath = null,
  fallbackPrompt = null,
  expectSquare = false,
}) {
  const apiKey = loadGeminiApiKey();
  if (!apiKey) {
    throw new Error('Set GEMINI_API_KEY in your environment or .env to use Advanced Tile Mode.');
  }

  const b64 = fs.readFileSync(inputPath).toString('base64');
  const model = process.env.GEMINI_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;

  if (referenceImagePath && fs.existsSync(referenceImagePath)) {
    try {
      const refB64 = fs.readFileSync(referenceImagePath).toString('base64');
      const res = await requestGeminiImage({
        apiKey,
        model,
        aspectRatio: expectSquare ? '1:1' : undefined,
        jobPrefix: `${jobPrefix}_ref`,
        parts: [
          { inlineData: { mimeType: 'image/png', data: refB64 } },
          { inlineData: { mimeType: 'image/png', data: b64 } },
          { text: prompt },
        ],
      });
      const ratio = res.decoded.width / Math.max(1, res.decoded.height);
      if (!expectSquare || Math.abs(ratio - 1) <= 0.14) {
        return res;
      }
    } catch {
      // Fall back cleanly to palette-anchored single-image request below if multi-image / imageConfig fails
    }
  }

  return requestGeminiImage({
    apiKey,
    model,
    jobPrefix,
    parts: [
      { inlineData: { mimeType: 'image/png', data: b64 } },
      { text: fallbackPrompt || prompt },
    ],
  });
}

// --- Rendering monochrome inputs -------------------------------------------------------

function buildBgShadeGrid(gridCells, bgp) {
  const bg = new Uint8Array(SCREEN_W * SCREEN_H);
  for (let gy = 0; gy < 18; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      const cell = gridCells[gy * 20 + gx];
      const raw = decodeTile(hexToTileBytes(cell.key), 0);
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          bg[(gy * 8 + py) * SCREEN_W + (gx * 8 + px)] = (bgp >> (raw[py * 8 + px] * 2)) & 3;
        }
      }
    }
  }
  return bg;
}

function renderScreenInputPng(screenShades, bgShadeGrid, spriteClusters, obp0) {
  const buf = new Uint8Array(IMG_W * IMG_H * 4);
  if (screenShades && screenShades.length === SCREEN_W * SCREEN_H) {
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const [r, g, b] = GREYS[screenShades[y * SCREEN_W + x] & 3];
        for (let dy = 0; dy < SCREEN_SCALE; dy++) {
          for (let dx = 0; dx < SCREEN_SCALE; dx++) {
            const o = ((y * SCREEN_SCALE + dy) * IMG_W + (x * SCREEN_SCALE + dx)) * 4;
            buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
          }
        }
      }
    }
    return encodePng(IMG_W, IMG_H, buf);
  }

  for (let y = 0; y < SCREEN_H; y++) {
    for (let x = 0; x < SCREEN_W; x++) {
      const [r, g, b] = GREYS[bgShadeGrid[y * SCREEN_W + x] & 3];
      for (let dy = 0; dy < SCREEN_SCALE; dy++) {
        for (let dx = 0; dx < SCREEN_SCALE; dx++) {
          const o = ((y * SCREEN_SCALE + dy) * IMG_W + (x * SCREEN_SCALE + dx)) * 4;
          buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
        }
      }
    }
  }
  for (const cl of spriteClusters) {
    for (const m of cl.members) {
      if (m.x === 0 && m.y === 0 && cl.minX === 0 && cl.minY === 0) continue;
      const pal = m.pal ?? obp0;
      const top = decodeTile(hexToTileBytes(m.key), 0);
      const bot = m.botKey ? decodeTile(hexToTileBytes(m.botKey), 0) : null;
      for (let sy = 0; sy < m.height; sy++) {
        const wy = m.y + sy;
        if (wy < 0 || wy >= SCREEN_H) continue;
        const srcRow = m.flipY ? m.height - 1 - sy : sy;
        const raw = srcRow >= 8 && bot ? bot : top;
        const inRow = srcRow & 7;
        for (let sx = 0; sx < 8; sx++) {
          const wx = m.x + sx;
          if (wx < 0 || wx >= SCREEN_W) continue;
          const inCol = m.flipX ? 7 - sx : sx;
          const c = raw[inRow * 8 + inCol];
          if (c === 0) continue;
          const [r, g, b] = GREYS[(pal >> (c * 2)) & 3];
          for (let dy = 0; dy < SCREEN_SCALE; dy++) {
            for (let dx = 0; dx < SCREEN_SCALE; dx++) {
              const o = ((wy * SCREEN_SCALE + dy) * IMG_W + (wx * SCREEN_SCALE + dx)) * 4;
              buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
            }
          }
        }
      }
    }
  }
  return encodePng(IMG_W, IMG_H, buf);
}

function renderTileSheetInputPng(keys, bgp) {
  // Always use a 1:1 square grid (16x16 = 512x512 or 24x24 = 768x768) so image models
  // preserve exact 1:1 cell geometry without vertical aspect stretching.
  const cols = keys.length <= 256 ? 16 : SHEET_COLS;
  const rows = cols;
  const w = cols * SHEET_CELL;
  const h = rows * SHEET_CELL;
  const buf = new Uint8Array(w * h * 4);
  const [br, bg, bb] = GREYS[bgp & 3];
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = br; buf[i * 4 + 1] = bg; buf[i * 4 + 2] = bb; buf[i * 4 + 3] = 255;
  }
  const pxScale = SHEET_CELL / 8;
  keys.forEach((key, idx) => {
    if (idx >= cols * rows) return;
    const raw = decodeTile(hexToTileBytes(key), 0);
    const ox = (idx % cols) * SHEET_CELL;
    const oy = Math.floor(idx / cols) * SHEET_CELL;
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        const [r, g, b] = GREYS[(bgp >> (raw[py * 8 + px] * 2)) & 3];
        for (let dy = 0; dy < pxScale; dy++) {
          for (let dx = 0; dx < pxScale; dx++) {
            const o = ((oy + py * pxScale + dy) * w + (ox + px * pxScale + dx)) * 4;
            buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
          }
        }
      }
    }
  });
  return { png: encodePng(w, h, buf), w, h, cols };
}

// --- 24-Bit Joint-Bilateral DMG-Shade-Guided Color Transfer ----------------------------

function sampleGridOklab(up, gridW, gridH) {
  const gpL = new Float32Array(gridW * gridH);
  const gpA = new Float32Array(gridW * gridH);
  const gpB = new Float32Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    const uy0 = Math.floor(((y + 0.12) / gridH) * up.height);
    const uy1 = Math.max(uy0 + 1, Math.ceil(((y + 0.88) / gridH) * up.height));
    for (let x = 0; x < gridW; x++) {
      const ux0 = Math.floor(((x + 0.12) / gridW) * up.width);
      const ux1 = Math.max(ux0 + 1, Math.ceil(((x + 0.88) / gridW) * up.width));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = Math.max(0, uy0); yy < Math.min(up.height, uy1); yy++) {
        for (let xx = Math.max(0, ux0); xx < Math.min(up.width, ux1); xx++) {
          const o = (yy * up.width + xx) * 4;
          r += up.data[o]; g += up.data[o + 1]; b += up.data[o + 2]; n++;
        }
      }
      const [L, a, ob] = rgbToOklab(r / n, g / n, b / n);
      const i = y * gridW + x;
      gpL[i] = L; gpA[i] = a; gpB[i] = ob;
    }
  }
  return { gpL, gpA, gpB };
}

/**
 * Extracts a 24-bit `8x8x3` (192-byte) RGB tile at cell `(gx, gy)` using 5x5
 * joint-bilateral DMG-shade-guided transfer so Gemini's full million-color lighting
 * and hues are preserved while keeping razor-sharp 8x8 hardware pixel contrast!
 */
function extractGuidedCellRgb24(gx, gy, bgShades, gpL, gpA, gpB, chromaBoost = 1.22) {
  const rgb24 = new Uint8Array(64 * 3);
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const x = gx * 8 + px, y = gy * 8 + py;
      const s = bgShades[y * SCREEN_W + x];
      let wL = 0, wA = 0, wB = 0, wSum = 0;
      let minL = 1, maxL = 0, minDm = 1, maxDm = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= SCREEN_H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= SCREEN_W) continue;
          const ni = ny * SCREEN_W + nx;
          const ns = bgShades[ni];
          if (gpL[ni] < minL) minL = gpL[ni];
          if (gpL[ni] > maxL) maxL = gpL[ni];
          if (DMG_NORM[ns] < minDm) minDm = DMG_NORM[ns];
          if (DMG_NORM[ns] > maxDm) maxDm = DMG_NORM[ns];
          if (ns === s) {
            const w = 1 / (1 + dx * dx + dy * dy);
            wL += gpL[ni] * w; wA += gpA[ni] * w; wB += gpB[ni] * w; wSum += w;
          }
        }
      }
      let L = wL / wSum, a = wA / wSum, b = wB / wSum;
      if (maxDm > minDm + 0.05) {
        const rel = (DMG_NORM[s] - minDm) / (maxDm - minDm);
        const span = Math.max(0.20, maxL - minL);
        const guidedL = Math.max(0.13, Math.min(0.95, minL + rel * span));
        L = s === 3 ? Math.min(L, 0.23) : (L * 0.48 + guidedL * 0.52);
      } else if (s === 3) {
        L = Math.min(L, 0.23);
      }
      const boost = s === 3 ? 0.60 : chromaBoost;
      const [r, g, bl] = oklabToRgb(L, a * boost, b * boost);
      const dst = (py * 8 + px) * 3;
      rgb24[dst] = r; rgb24[dst + 1] = g; rgb24[dst + 2] = bl;
    }
  }
  return rgb24;
}

/** Extracts a 24-bit 8x8 RGB starter tile from a square `cols x cols` ROM/VRAM sheet. */
function extractSheetTileRgb24(raw64, bgp, sheetIdx, sheetCols, sheetLab, sheetPixelW, chromaBoost = 1.2) {
  const ox = (sheetIdx % sheetCols) * 8;
  const oy = Math.floor(sheetIdx / sheetCols) * 8;
  const gridW = sheetPixelW / 4;
  const rgb24 = new Uint8Array(64 * 3);
  const { gpL, gpA, gpB } = sheetLab;

  let minL = 1, maxL = 0, minDm = 1, maxDm = 0;
  const sh64 = new Uint8Array(64);
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const sh = (bgp >> (raw64[py * 8 + px] * 2)) & 3;
      sh64[py * 8 + px] = sh;
      const gi = (oy + py) * gridW + (ox + px);
      if (gpL[gi] < minL) minL = gpL[gi];
      if (gpL[gi] > maxL) maxL = gpL[gi];
      if (DMG_NORM[sh] < minDm) minDm = DMG_NORM[sh];
      if (DMG_NORM[sh] > maxDm) maxDm = DMG_NORM[sh];
    }
  }

  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const idx = py * 8 + px;
      const s = sh64[idx];
      let wL = 0, wA = 0, wB = 0, wSum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8 && sh64[ny * 8 + nx] === s) {
            const gi = (oy + ny) * gridW + (ox + nx);
            const w = dx === 0 && dy === 0 ? 2 : 1;
            wL += gpL[gi] * w; wA += gpA[gi] * w; wB += gpB[gi] * w; wSum += w;
          }
        }
      }
      let L = wL / wSum, a = wA / wSum, b = wB / wSum;
      if (maxDm > minDm + 0.05) {
        const rel = (DMG_NORM[s] - minDm) / (maxDm - minDm);
        const span = Math.max(0.24, maxL - minL);
        const gL = Math.max(0.14, Math.min(0.94, minL + rel * span));
        L = s === 3 ? Math.min(L, 0.22) : (L * 0.45 + gL * 0.55);
      } else if (s === 3) {
        L = Math.min(L, 0.22);
      }
      const boost = s === 3 ? 0.55 : chromaBoost;
      const [r, g, bl] = oklabToRgb(L, a * boost, b * boost);
      rgb24[idx * 3] = r; rgb24[idx * 3 + 1] = g; rgb24[idx * 3 + 2] = bl;
    }
  }
  return rgb24;
}

function makeSeamlessSurfaceRgb24(raw64, rgb24) {
  const perColor = [[], [], [], []];
  for (let i = 0; i < 64; i++) {
    const c = raw64[i] & 3;
    perColor[c].push([rgb24[i * 3], rgb24[i * 3 + 1], rgb24[i * 3 + 2]]);
  }
  const med3 = (arr) => {
    if (!arr.length) return [0, 0, 0];
    const s = (ch) => arr.map((a) => a[ch]).sort((a, b) => a - b)[arr.length >> 1];
    return [s(0), s(1), s(2)];
  };
  const medians = perColor.map(med3);
  const out = new Uint8Array(192);
  for (let i = 0; i < 64; i++) {
    const c = raw64[i] & 3;
    const [mr, mg, mb] = medians[c];
    const px = i & 7, py = i >> 3;
    if (px === 0 || px === 7 || py === 0 || py === 7) {
      out[i * 3] = mr;
      out[i * 3 + 1] = mg;
      out[i * 3 + 2] = mb;
    } else {
      out[i * 3] = Math.round(mr * 0.65 + rgb24[i * 3] * 0.35);
      out[i * 3 + 1] = Math.round(mg * 0.65 + rgb24[i * 3 + 1] * 0.35);
      out[i * 3 + 2] = Math.round(mb * 0.65 + rgb24[i * 3 + 2] * 0.35);
    }
  }
  return { seamless: out, medians };
}

// --- Persistent Tile History Vault & Cartridge Disk Cache ------------------------------

function diskCachePath(cartId, style, ver = 'v5') {
  const safe = `${cartId || 'rom'}_${style || 'snes'}_${ver}`.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96);
  return path.join(CACHE_DIR, `${safe}.json`);
}

function contextScreenPath(cartId, style) {
  const safe = `${cartId || 'rom'}_${style || 'snes'}_ctx_screen`.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96);
  return path.join(CACHE_DIR, `${safe}.png`);
}

function tileVaultPath(style) {
  const safe = `vault_${style || 'snes'}_v5`.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function loadDiskCache(cartId, style) {
  for (const ver of ['v5', 'v4']) {
    const fp = diskCachePath(cartId, style, ver);
    try {
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch { /* ignore corrupt cache */ }
  }
  return null;
}

function saveDiskCache(cartId, style, data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(diskCachePath(cartId, style, 'v5'), JSON.stringify(data));
  } catch { /* non-fatal */ }
}

function loadTileVault(style) {
  const fp = tileVaultPath(style);
  try {
    if (!fs.existsSync(fp)) return { active: {}, history: {} };
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return {
      active: parsed?.active && typeof parsed.active === 'object' ? parsed.active : {},
      history: parsed?.history && typeof parsed.history === 'object' ? parsed.history : {},
    };
  } catch {
    return { active: {}, history: {} };
  }
}

function saveTileVault(style, vault) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(tileVaultPath(style), JSON.stringify(vault));
  } catch { /* non-fatal */ }
}

function appendHistoryVariant(historyMap, nsKey, entry, model, sceneId = null) {
  if (!entry?.rgb24Base64) return;
  const list = Array.isArray(historyMap[nsKey]) ? [...historyMap[nsKey]] : [];
  const variant = {
    key: entry.key,
    role: entry.role,
    tier: entry.tier,
    pal: entry.pal ?? 0xe4,
    model: model || '',
    sceneId,
    ts: Date.now(),
    rgb24Base64: entry.rgb24Base64,
  };
  const existingIdx = list.findIndex((v) => v.rgb24Base64 === variant.rgb24Base64);
  if (existingIdx >= 0) {
    list[existingIdx] = { ...list[existingIdx], ...variant };
  } else {
    list.push(variant);
    if (list.length > MAX_HISTORY_PER_TILE) list.shift();
  }
  historyMap[nsKey] = list;
}

export function clearDiskCache(cartId, style, { clearVault = false } = {}) {
  try {
    fs.rmSync(diskCachePath(cartId, style, 'v5'), { force: true });
    fs.rmSync(diskCachePath(cartId, style, 'v4'), { force: true });
    fs.rmSync(contextScreenPath(cartId, style), { force: true });
    if (clearVault) fs.rmSync(tileVaultPath(style), { force: true });
  } catch { /* non-fatal */ }
}

/**
 * Unifies all sprite tiles within each contiguous ROM/VRAM character animation strip
 * (`[pose0_top, pose0_bot, pose1_top, pose1_bot, ...]`) onto a shared `(evenPal, oddPal)`
 * `[c1, c2, c3]` character palette so pre-cached sprites never shift colors between frames.
 */
function unifySpriteFamilies(outTiles, spriteFamilies, force = false) {
  if (!Array.isArray(spriteFamilies)) return;
  for (const family of spriteFamilies) {
    if (!Array.isArray(family) || family.length < 2) continue;
    let evenPal = null;
    let oddPal = null;

    family.forEach((key, idx) => {
      const entry = outTiles[`spr:${key}`];
      if (!entry?.rgb24Base64) return;
      const raw64 = decodeTile(hexToTileBytes(key), 0);
      const pal3 = extractSpriteShadePalette(raw64, base64ToBytes(entry.rgb24Base64));
      if ((idx & 1) === 0) evenPal = mergeSpriteShadePalette(evenPal, pal3);
      else oddPal = mergeSpriteShadePalette(oddPal, pal3);
    });
    if (!evenPal && !oddPal) continue;
    if (!oddPal) oddPal = evenPal;
    if (!evenPal) evenPal = oddPal;

    family.forEach((key, idx) => {
      const ns = `spr:${key}`;
      const entry = outTiles[ns];
      if (!entry?.rgb24Base64) return;
      if (!force && entry.tier === 'scene') return;
      const raw64 = decodeTile(hexToTileBytes(key), 0);
      const targetPal = (idx & 1) === 0 ? evenPal : oddPal;
      const unified = applySpriteShadePalette(raw64, targetPal, base64ToBytes(entry.rgb24Base64));
      outTiles[ns] = {
        ...entry,
        rgb24Base64: bytesToBase64(unified),
      };
    });
  }
}

function buildFallbackGridFromTiles(inputTiles) {
  const cells = [];
  const bg = inputTiles.filter((t) => t.role !== 'spr8' && t.role !== 'spr16');
  const filler = bg[0]?.key || '0'.repeat(32);
  for (let i = 0; i < 360; i++) {
    const item = bg[i % Math.max(1, bg.length)];
    cells.push({ key: item ? item.key : filler, isWin: item?.role === 'hud' });
  }
  const clusters = [];
  for (const t of inputTiles) {
    if (t.role === 'spr16') {
      clusters.push({
        minX: 8, minY: 8, w: 8, h: 16,
        members: [{ x: 8, y: 8, height: 16, flipX: false, flipY: false, pal: t.pal ?? 0xe4, key: t.key, botKey: t.pairKey }],
      });
    } else if (t.role === 'spr8') {
      clusters.push({
        minX: 8, minY: 8, w: 8, h: 8,
        members: [{ x: 8, y: 8, height: 8, flipX: false, flipY: false, pal: t.pal ?? 0xe4, key: t.key, botKey: null }],
      });
    }
  }
  return { gridCells: cells, spriteClusters: clusters };
}

function toHex([r, g, b]) {
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

export async function upgradeScreenTiles(payload) {
  const tStart = Date.now();
  const styleSpec = HD_STYLES.find((s) => s.id === payload.style) || HD_STYLES[0];
  const curve = STYLE_CURVES[styleSpec.id] || STYLE_CURVES.snes;
  const chromaBoost = styleSpec.id === 'gbcdx' ? 1.35 : styleSpec.id === 'neon' ? 1.42 : 1.24;
  const cartId = String(payload.cartId || payload.title || 'rom');
  const force = Boolean(payload.force);
  const reviseScene = Boolean(payload.reviseScene);
  const sheetsOnly = Boolean(payload.sheetsOnly) && !force && !reviseScene;
  const sceneId = payload.sceneId ? String(payload.sceneId) : null;
  const inputTiles = Array.isArray(payload.tiles) ? payload.tiles : [];
  const extraSheetKeys = Array.isArray(payload.extraSheetKeys) ? payload.extraSheetKeys : [];
  const spriteSheetKeys = Array.isArray(payload.spriteSheetKeys) ? payload.spriteSheetKeys : [];
  const spriteFamilies = Array.isArray(payload.spriteFamilies) ? payload.spriteFamilies : [];
  const bgp = payload.bgp ?? 0xe4;
  const obp0 = payload.obp0 ?? 0xe4;

  const { gridCells, spriteClusters } = Array.isArray(payload.gridCells) && payload.gridCells.length === 360
    ? { gridCells: payload.gridCells, spriteClusters: payload.spriteClusters || [] }
    : buildFallbackGridFromTiles(inputTiles);

  // Load both cartridge cache AND cross-session Tile History Vault (preserving history even on force!)
  const prevDisk = loadDiskCache(cartId, styleSpec.id);
  const vault = loadTileVault(styleSpec.id);
  const mergedHistory = { ...vault.history, ...(prevDisk?.history || {}) };
  const cachedTiles = !force
    ? { ...vault.active, ...(prevDisk?.tiles || {}) }
    : {};

  const sprHintSet = new Set(spriteSheetKeys);
  const isSceneReady = (entry) => Boolean(entry && entry.tier === 'scene');
  const missingScreenArt = sheetsOnly ? [] : (force || reviseScene ? inputTiles : inputTiles.filter((t) => {
    if (t.role === 'solid' || t.glyph) return false;
    if (t.role === 'hud') {
      const raw = decodeTile(hexToTileBytes(t.key), 0);
      if (isGlyphTile(raw)) return false;
      return !isSceneReady(cachedTiles[`win:${t.key}`]) && !isSceneReady(cachedTiles[`bg:${t.key}`]);
    }
    if (t.role === 'spr16') return !isSceneReady(cachedTiles[`spr:${t.key}`]) || !isSceneReady(cachedTiles[`spr:${t.pairKey}`]);
    if (t.role === 'spr8') return !isSceneReady(cachedTiles[`spr:${t.key}`]);
    return !isSceneReady(cachedTiles[`bg:${t.key}`]);
  }));

  const missingExtraKeys = extraSheetKeys.filter((k) => !cachedTiles[`bg:${k}`] && !cachedTiles[`spr:${k}`]);
  const needWholePass = force
    ? extraSheetKeys.length > 0
    : missingExtraKeys.length > 0;

  if (!force && prevDisk && missingScreenArt.length === 0 && !needWholePass) {
    return {
      ok: true,
      cached: true,
      wholeGameDone: true,
      remainingCount: 0,
      sceneId,
      style: styleSpec.id,
      theme: prevDisk.theme,
      model: prevDisk.model || 'cached',
      shades: prevDisk.shades,
      hudShades: prevDisk.hudShades,
      groundKey: payload.groundKey || prevDisk.groundKey || null,
      tiles: cachedTiles,
      history: mergedHistory,
      elapsedMs: Date.now() - tStart,
    };
  }

  const persistAndFinalize = (outTiles, shades, hudShades, modelName, remainingCount) => {
    unifySpriteFamilies(outTiles, spriteFamilies, force);
    for (const [nsKey, entry] of Object.entries(outTiles)) {
      const wasChanged = !cachedTiles[nsKey] || cachedTiles[nsKey].rgb24Base64 !== entry.rgb24Base64;
      if (wasChanged || !mergedHistory[nsKey]) {
        appendHistoryVariant(mergedHistory, nsKey, entry, modelName, entry.tier === 'scene' ? sceneId : null);
      }
      vault.active[nsKey] = entry;
      vault.history[nsKey] = mergedHistory[nsKey];
    }
    const result = {
      ok: true,
      cached: false,
      wholeGameDone: remainingCount === 0,
      remainingCount,
      sceneId,
      style: styleSpec.id,
      theme: styleSpec.prompt,
      model: modelName,
      groundKey: payload.groundKey || prevDisk?.groundKey || null,
      shades,
      hudShades,
      tiles: outTiles,
      history: mergedHistory,
      elapsedMs: Date.now() - tStart,
    };
    saveDiskCache(cartId, styleSpec.id, result);
    saveTileVault(styleSpec.id, vault);
    return result;
  };

  // Procedural fast path for hermetic unit tests
  if (process.env.HD_TILE_BACKEND === 'procedural') {
    const outTiles = { ...cachedTiles };
    const baseShades = [0, 1, 2, 3].map((s) => oklabToRgb(curve.L[s], 0.02, 0.04));
    const baseHud = [0, 1, 2, 3].map((s) => oklabToRgb(curve.L[s], -0.01, -0.02));
    const winSet = new Set(gridCells.filter((c) => c.isWin).map((c) => c.key));
    const allKeys = new Set([
      ...gridCells.map((c) => c.key),
      ...extraSheetKeys,
      ...spriteClusters.flatMap((cl) => cl.members.flatMap((m) => [m.key, m.botKey].filter(Boolean))),
    ]);
    let idx = 0;
    for (const key of allKeys) {
      const raw = decodeTile(hexToTileBytes(key), 0);
      const st = tileStats(raw);
      if (st.unique <= 1 || isGlyphTile(raw, st)) continue;
      const isWin = winSet.has(key);
      const isSpr = !isWin && sprHintSet.has(key);
      const ext = exteriorMask(raw, 0);
      const angle = ((idx++ * 137.5) * Math.PI) / 180;
      const rgb24 = new Uint8Array(192);
      for (let i = 0; i < 64; i++) {
        const sh = (bgp >> (raw[i] * 2)) & 3;
        const [r, g, b] = isWin
          ? baseHud[sh]
          : (!isSpr && ext[i])
            ? baseShades[bgp & 3]
            : oklabToRgb(curve.L[sh], Math.cos(angle) * 0.11, Math.sin(angle) * 0.11);
        rgb24[i * 3] = r; rgb24[i * 3 + 1] = g; rgb24[i * 3 + 2] = b;
      }
      if (isSpr) {
        const cleanSpr = applySpriteShadePalette(raw, extractSpriteShadePalette(raw, rgb24), rgb24);
        outTiles[`spr:${key}`] = { key, role: 'spr', tier: 'rom', pal: obp0, rgb24Base64: bytesToBase64(cleanSpr) };
      } else {
        const role = isWin ? 'win' : (st.borderZero < 10 ? 'surface' : 'bg');
        outTiles[`${isWin ? 'win' : 'bg'}:${key}`] = { key, role, tier: 'scene', pal: bgp, rgb24Base64: bytesToBase64(rgb24) };
      }
    }
    for (const cl of spriteClusters) {
      for (const m of cl.members) {
        const pal = m.pal ?? obp0;
        for (const k of [m.key, m.botKey].filter(Boolean)) {
          const raw = decodeTile(hexToTileBytes(k), 0);
          const rgb24 = new Uint8Array(192);
          for (let i = 0; i < 64; i++) {
            const sh = (pal >> (raw[i] * 2)) & 3;
            const [r, g, b] = oklabToRgb(curve.L[sh], -0.07, 0.12);
            rgb24[i * 3] = r; rgb24[i * 3 + 1] = g; rgb24[i * 3 + 2] = b;
          }
          outTiles[`spr:${k}`] = { key: k, role: 'spr', tier: 'scene', pal, rgb24Base64: bytesToBase64(rgb24) };
        }
      }
    }
    const shades = [0, 1, 2, 3].map((s) => toHex(oklabToRgb(curve.L[s], 0.02, 0.04)));
    const hudShades = [0, 1, 2, 3].map((s) => toHex(oklabToRgb(curve.L[s], -0.01, -0.02)));
    return persistAndFinalize(outTiles, shades, hudShades, 'procedural', 0);
  }

  // Mark sprite-overlapped cells on the 20x18 grid
  const sprOverlappedCell = new Uint8Array(360);
  const onScreenSprKeys = new Set();
  const offScreenSprKeys = [];
  for (const cl of spriteClusters) {
    for (const m of cl.members) {
      const visible = m.x + 8 > 0 && m.x < SCREEN_W && m.y + m.height > 0 && m.y < SCREEN_H && !(m.x === 0 && m.y === 0 && cl.minX === 0 && cl.minY === 0);
      if (visible) {
        onScreenSprKeys.add(m.key);
        if (m.botKey) onScreenSprKeys.add(m.botKey);
        const gx0 = Math.max(0, Math.floor(m.x / 8)), gx1 = Math.min(19, Math.floor((m.x + 7) / 8));
        const gy0 = Math.max(0, Math.floor(m.y / 8)), gy1 = Math.min(17, Math.floor((m.y + m.height - 1) / 8));
        for (let gy = gy0; gy <= gy1; gy++) {
          for (let gx = gx0; gx <= gx1; gx++) sprOverlappedCell[gy * 20 + gx] = 1;
        }
      } else {
        for (const k of [m.key, m.botKey].filter(Boolean)) {
          if (!onScreenSprKeys.has(k) && !offScreenSprKeys.includes(k)) offScreenSprKeys.push(k);
        }
      }
    }
  }

  const occByNsKey = new Map();
  const visibleArtKeys = new Set();
  let domBgEntry = null, domBgCount = 0;
  for (let gy = 0; gy < 18; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      const cell = gridCells[gy * 20 + gx];
      const raw = decodeTile(hexToTileBytes(cell.key), 0);
      const st = tileStats(raw);
      const ns = `${cell.isWin ? 'win' : 'bg'}:${cell.key}`;
      if (!occByNsKey.has(ns)) occByNsKey.set(ns, { key: cell.key, isWin: Boolean(cell.isWin), raw, st, cells: [] });
      occByNsKey.get(ns).cells.push({ gx, gy, overlapped: Boolean(sprOverlappedCell[gy * 20 + gx]) });
      if (st.unique > 1 && !isGlyphTile(raw, st)) visibleArtKeys.add(cell.key);
    }
  }
  for (const [ns, info] of occByNsKey) {
    if (ns.startsWith('bg:') && info.st.domColor === 0 && info.st.domShare >= 0.65 && info.cells.length > domBgCount) {
      domBgCount = info.cells.length;
      domBgEntry = { ns, ...info };
    }
  }
  const domBgSolid = Boolean(domBgEntry && domBgEntry.st.unique === 1);

  // Queue off-screen ROM + VRAM tiles for parallel starter sheets (`tier: 'rom'`),
  // placing sprite strips together first so contiguous character poses stay adjacent!
  const candidateExtra = force ? extraSheetKeys : missingExtraKeys;
  const sheetQueue = [];
  const queuedSet = new Set(sheetsOnly ? [] : [...visibleArtKeys, ...onScreenSprKeys]);
  const orderedExtra = [
    ...offScreenSprKeys,
    ...candidateExtra.filter((k) => sprHintSet.has(k)),
    ...candidateExtra.filter((k) => !sprHintSet.has(k)),
  ];
  for (const k of orderedExtra) {
    if (!queuedSet.has(k)) {
      queuedSet.add(k);
      sheetQueue.push(k);
    }
  }

  const batchCap = SHEET_COLS * SHEET_ROWS; // 576 tiles per sheet
  const sheetBatches = [];
  for (let i = 0; i < sheetQueue.length && sheetBatches.length < MAX_SHEETS; i += batchCap) {
    sheetBatches.push(sheetQueue.slice(i, i + batchCap));
  }
  const processedSheetTiles = sheetBatches.reduce((acc, b) => acc + b.length, 0);
  const remainingExtraCount = Math.max(0, sheetQueue.length - processedSheetTiles);

  const nonce = crypto.randomBytes(6).toString('hex');
  const tempBase = path.join(os.tmpdir(), `gb_col24_${nonce}`);
  const screenInPath = `${tempBase}_screen_in.png`;
  const sheetPaths = sheetBatches.map((_, idx) => `${tempBase}_sheet${idx}_in.png`);
  const ctxScreenFile = contextScreenPath(cartId, styleSpec.id);

  try {
    const outTiles = { ...cachedTiles };
    const defTheme = [0, 1, 2, 3].map((s) => oklabToRgb(curve.L[s], 0, 0));
    let themeColors = prevDisk?.shades
      ? prevDisk.shades.map((h, i) => [
        parseInt(h.slice(1, 3), 16) || defTheme[i][0],
        parseInt(h.slice(3, 5), 16) || defTheme[i][1],
        parseInt(h.slice(5, 7), 16) || defTheme[i][2],
      ])
      : defTheme;
    let hudColors = prevDisk?.hudShades
      ? prevDisk.hudShades.map((h) => [
        parseInt(h.slice(1, 3), 16) || 240,
        parseInt(h.slice(3, 5), 16) || 236,
        parseInt(h.slice(5, 7), 16) || 224,
      ])
      : [[245, 240, 228], [172, 165, 156], [98, 92, 88], [28, 24, 30]];
    let domGroundColor0Rgb = themeColors[bgp & 3];
    let activeModel = prevDisk?.model || DEFAULT_IMAGE_MODEL;

    // STEP 1: Colorize the CURRENT LIVE SCREEN first so it sets the exact visual & palette
    //         context for both on-screen tiles AND all ROM/VRAM tile sheets!
    let upScreen = null;
    let bgShadeGrid = null;
    if (!sheetsOnly) {
      bgShadeGrid = buildBgShadeGrid(gridCells, bgp);
      const screenShades = payload.screenShadesBase64 ? base64ToBytes(payload.screenShadesBase64) : null;
      fs.writeFileSync(screenInPath, renderScreenInputPng(screenShades, bgShadeGrid, spriteClusters, obp0));

      const screenPrompt = [
        `Colorize this monochrome Game Boy screenshot in-place into ${styleSpec.prompt}.`,
        'STRICT PIXEL-POSITION RULES:',
        '1. Keep EVERY structure, tree, roof, wall, door, stair, character sprite, logo, UI border, and letter at its exact 1:1 pixel coordinates edge-to-edge without moving, resizing, cropping, or adding outer borders.',
        domBgSolid
          ? '2. Keep large blank title/menu/playfield background areas clean and uniform while richly colorizing logos, blocks, sprites, and frames with full-color gradients and shading.'
          : '2. Paint rich, full-spectrum colors with natural lighting and depth across every element (lush green grass/foliage, brown tree trunks, warm roofs and walls, deep water, stone, and distinct hair, skin, and outfit colors on every character).',
      ].join('\n');

      const screenRes = await colorizeImageWithGemini({
        inputPath: screenInPath,
        prompt: screenPrompt,
        jobPrefix: `${tempBase}_s0`,
      });
      upScreen = screenRes.decoded;
      activeModel = screenRes.model;
      if (screenRes.rawBytes) {
        try {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          fs.writeFileSync(ctxScreenFile, screenRes.rawBytes);
        } catch { /* non-fatal */ }
      }

      const screenLab = sampleGridOklab(upScreen, SCREEN_W, SCREEN_H);
      const { gpL, gpA, gpB } = screenLab;

      // Sample 4-shade scene & Window theme colors directly from the colorized current screen
      const bgShadeRgbs = [[], [], [], []], winShadeRgbs = [[], [], [], []];
      for (let gy = 0; gy < 18; gy++) {
        for (let gx = 0; gx < 20; gx++) {
          if (sprOverlappedCell[gy * 20 + gx]) continue;
          const cell = gridCells[gy * 20 + gx];
          for (let py = 1; py < 7; py += 2) {
            for (let px = 1; px < 7; px += 2) {
              const x = gx * 8 + px, y = gy * 8 + py;
              const i = y * SCREEN_W + x;
              const sh = bgShadeGrid[i];
              const L = sh === 3 ? Math.min(gpL[i], 0.22) : gpL[i];
              const rgb = oklabToRgb(L, gpA[i] * (sh === 3 ? 0.55 : 1.15), gpB[i] * (sh === 3 ? 0.55 : 1.15));
              if (cell.isWin) winShadeRgbs[sh].push(rgb);
              else bgShadeRgbs[sh].push(rgb);
            }
          }
        }
      }
      const medRgb = (arr, fb) => {
        if (!arr.length) return fb;
        const s = (c) => arr.map((a) => a[c]).sort((a, b) => a - b)[arr.length >> 1];
        return [s(0), s(1), s(2)];
      };
      themeColors = [0, 1, 2, 3].map((s) => medRgb(bgShadeRgbs[s], defTheme[s]));
      const winPaper = medRgb(winShadeRgbs[0], [245, 240, 228]);
      let winInk = medRgb(winShadeRgbs[3], [28, 24, 30]);
      const luma = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b;
      if (Math.abs(luma(winPaper) - luma(winInk)) < 115) {
        winInk = luma(winPaper) > 128 ? [28, 22, 26] : [244, 236, 214];
      }
      const lerpRgb = (a, b, t) => [
        Math.round(a[0] * (1 - t) + b[0] * t),
        Math.round(a[1] * (1 - t) + b[1] * t),
        Math.round(a[2] * (1 - t) + b[2] * t),
      ];
      hudColors = [winPaper, lerpRgb(winPaper, winInk, 0.34), lerpRgb(winPaper, winInk, 0.68), winInk];
      domGroundColor0Rgb = themeColors[bgp & 3];

      // Extract dominant ground tile FIRST so cutout foreground objects lock exterior color 0 to ground RGB
      if (domBgEntry && domBgEntry.st.unique > 1 && !isGlyphTile(domBgEntry.raw, domBgEntry.st)) {
        const clean = domBgEntry.cells.filter((c) => !c.overlapped);
        const pool = (clean.length ? clean : domBgEntry.cells).slice(0, 24);
        const patches = pool.map((c) => extractGuidedCellRgb24(c.gx, c.gy, bgShadeGrid, gpL, gpA, gpB, chromaBoost));
        let chosen = patches[0];
        if (patches.length >= 3) {
          const mean = new Float32Array(192);
          for (const p of patches) for (let j = 0; j < 192; j++) mean[j] += p[j];
          for (let j = 0; j < 192; j++) mean[j] /= patches.length;
          let best = Infinity;
          for (const p of patches) {
            let d = 0;
            for (let j = 0; j < 192; j++) d += Math.abs(p[j] - mean[j]);
            if (d < best) { best = d; chosen = p; }
          }
        }
        const { seamless, medians } = makeSeamlessSurfaceRgb24(domBgEntry.raw, chosen);
        domGroundColor0Rgb = medians[0];
        themeColors[bgp & 3] = medians[0];
        outTiles[domBgEntry.ns] = {
          key: domBgEntry.key,
          role: 'surface',
          tier: 'scene',
          pal: bgp,
          rgb24Base64: bytesToBase64(seamless),
        };
      }

      // Revise ALL visible BG & Window non-glyph tiles to full 24-bit `tier: 'scene'`!
      for (const [ns, info] of occByNsKey) {
        if (domBgEntry && ns === domBgEntry.ns) continue;
        const { key, isWin, raw, st, cells } = info;
        if (st.unique <= 1 || isGlyphTile(raw, st)) continue;

        const clean = cells.filter((c) => !c.overlapped);
        const pool = (clean.length ? clean : cells).slice(0, 24);
        const patches = pool.map((c) => extractGuidedCellRgb24(c.gx, c.gy, bgShadeGrid, gpL, gpA, gpB, chromaBoost));
        let chosen = patches[0];
        if (patches.length >= 3) {
          const mean = new Float32Array(192);
          for (const p of patches) for (let j = 0; j < 192; j++) mean[j] += p[j];
          for (let j = 0; j < 192; j++) mean[j] /= patches.length;
          let best = Infinity;
          for (const p of patches) {
            let d = 0;
            for (let j = 0; j < 192; j++) d += Math.abs(p[j] - mean[j]);
            if (d < best) { best = d; chosen = p; }
          }
        }

        const isRepeatingSurface = !isWin && (cells.length >= 5 || st.borderZero < 6) && st.borderZero < 12;
        if (isRepeatingSurface) {
          chosen = makeSeamlessSurfaceRgb24(raw, chosen).seamless;
        } else if (!isWin && domBgEntry && st.borderZero >= 8) {
          const touchesGround = cells.some((c) =>
            [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
              const nx = c.gx + dx, ny = c.gy + dy;
              return nx >= 0 && nx < 20 && ny >= 0 && ny < 18 && gridCells[ny * 20 + nx].key === domBgEntry.key;
            }),
          );
          if (touchesGround || domBgSolid) {
            const ext = exteriorMask(raw, 0);
            for (let i = 0; i < 64; i++) {
              if (ext[i]) {
                chosen[i * 3] = domGroundColor0Rgb[0];
                chosen[i * 3 + 1] = domGroundColor0Rgb[1];
                chosen[i * 3 + 2] = domGroundColor0Rgb[2];
              }
            }
          }
        }

        const role = isWin ? 'win' : (isRepeatingSurface ? 'surface' : 'bg');
        outTiles[ns] = {
          key,
          role,
          tier: 'scene',
          pal: bgp,
          rgb24Base64: bytesToBase64(chosen),
        };
      }

      // Extract visible character/monster sprites with clean per-band `[c1, c2, c3]` palettes
      // AND propagate that exact character palette to off-screen walking neighbor frames!
      const [, backLabA, backLabB] = rgbToOklab(domGroundColor0Rgb[0], domGroundColor0Rgb[1], domGroundColor0Rgb[2]);
      const writtenUnflippedSpr = new Set();
      let primaryHeroUpperPal = null;
      let primaryHeroLowerPal = null;

      for (const cl of spriteClusters) {
        const visibleMembers = cl.members.filter((m) =>
          m.x + 8 > 0 && m.x < SCREEN_W && m.y + m.height > 0 && m.y < SCREEN_H &&
          !(m.x === 0 && m.y === 0 && cl.minX === 0 && cl.minY === 0),
        );
        if (!visibleMembers.length) continue;

        let bestOx = 0, bestOy = 0, bestScore = -Infinity;
        for (let oy = -3; oy <= 3; oy++) {
          for (let ox = -3; ox <= 3; ox++) {
            let score = -Math.hypot(ox, oy) * 0.03;
            for (const m of visibleMembers) {
              const pal = m.pal ?? obp0;
              const topRaw = decodeTile(hexToTileBytes(m.key), 0);
              const botRaw = m.botKey ? decodeTile(hexToTileBytes(m.botKey), 0) : null;
              for (let sy = 0; sy < m.height; sy++) {
                const yy = m.y + sy + oy;
                if (yy < 0 || yy >= SCREEN_H) continue;
                const srcRow = m.flipY ? m.height - 1 - sy : sy;
                const raw = srcRow >= 8 && botRaw ? botRaw : topRaw;
                for (let sx = 0; sx < 8; sx++) {
                  const xx = m.x + sx + ox;
                  if (xx < 0 || xx >= SCREEN_W) continue;
                  const inCol = m.flipX ? 7 - sx : sx;
                  const c = raw[(srcRow & 7) * 8 + inCol];
                  if (c === 0) continue;
                  const sh = (pal >> (c * 2)) & 3;
                  const gi = yy * SCREEN_W + xx;
                  const nonBg = Math.hypot(gpA[gi] - backLabA, gpB[gi] - backLabB);
                  if (sh === 3) score += (0.62 - gpL[gi]) * 1.1;
                  else score += nonBg * 2.2;
                }
              }
            }
            if (score > bestScore) { bestScore = score; bestOx = ox; bestOy = oy; }
          }
        }

        let clusterUpperPal = null;
        let clusterLowerPal = null;
        const sampledSlices = [];

        for (const m of visibleMembers) {
          const pal = m.pal ?? obp0;
          const slices = m.height === 16 ? [0, 8] : [0];
          for (const yOff of slices) {
            const isBottom = m.flipY && m.height === 16 ? yOff === 0 : yOff === 8;
            const key = isBottom ? m.botKey : m.key;
            if (!key) continue;
            const raw = decodeTile(hexToTileBytes(key), 0);
            if (tileStats(raw).unique <= 1) continue;
            const rgb24 = new Uint8Array(192);
            for (let py = 0; py < 8; py++) {
              const screenDy = m.flipY ? 7 - py : py;
              const yy = Math.max(0, Math.min(SCREEN_H - 1, m.y + yOff + screenDy + bestOy));
              for (let px = 0; px < 8; px++) {
                const idx = py * 8 + px;
                const c = raw[idx];
                if (c === 0) continue;
                const sh = (pal >> (c * 2)) & 3;
                const screenDx = m.flipX ? 7 - px : px;
                const xx = Math.max(0, Math.min(SCREEN_W - 1, m.x + screenDx + bestOx));
                const gi = yy * SCREEN_W + xx;
                let L = gpL[gi], a = gpA[gi], b = gpB[gi];
                if (sh === 3) L = Math.min(L, 0.22);
                else if (sh === 0) L = Math.max(0.68, Math.min(0.92, L));
                else if (sh === 1) L = Math.max(0.46, Math.min(0.78, L));
                else L = Math.max(0.30, Math.min(0.58, L));
                const boost = sh === 3 ? 0.55 : chromaBoost;
                const [r, g, bl] = oklabToRgb(L, a * boost, b * boost);
                rgb24[idx * 3] = r;
                rgb24[idx * 3 + 1] = g;
                rgb24[idx * 3 + 2] = bl;
              }
            }
            const pal3 = extractSpriteShadePalette(raw, rgb24);
            const isLower = cl.h > 8 && (m.y + yOff - cl.minY) >= (cl.h * 0.45);
            if (isLower) clusterLowerPal = mergeSpriteShadePalette(clusterLowerPal, pal3);
            else clusterUpperPal = mergeSpriteShadePalette(clusterUpperPal, pal3);
            sampledSlices.push({ key, raw, rgb24, pal, isLower, flipped: Boolean(m.flipX || m.flipY) });
          }
        }

        if (!clusterLowerPal) clusterLowerPal = clusterUpperPal;
        if (!clusterUpperPal) clusterUpperPal = clusterLowerPal;
        if (!primaryHeroUpperPal && clusterUpperPal) {
          primaryHeroUpperPal = clusterUpperPal;
          primaryHeroLowerPal = clusterLowerPal;
        }

        for (const item of sampledSlices) {
          if (writtenUnflippedSpr.has(item.key) && item.flipped) continue;
          const targetPal = (item.isLower ? clusterLowerPal : clusterUpperPal) || clusterUpperPal;
          const cleanRgb24 = targetPal ? applySpriteShadePalette(item.raw, targetPal, item.rgb24) : item.rgb24;
          outTiles[`spr:${item.key}`] = {
            key: item.key,
            role: 'spr',
            tier: 'scene',
            pal: item.pal,
            rgb24Base64: bytesToBase64(cleanRgb24),
          };
          if (!item.flipped) writtenUnflippedSpr.add(item.key);
        }
      }

      // Immediately propagate the on-screen character palette onto adjacent `±2` walking slots!
      if (primaryHeroUpperPal) {
        for (const cl of spriteClusters) {
          for (const m of cl.members) {
            const isOffNeighbor = m.x === 0 && m.y === 0 && cl.minX === 0 && cl.minY === 0;
            if (!isOffNeighbor) continue;
            const pal = m.pal ?? obp0;
            if (m.key && !onScreenSprKeys.has(m.key)) {
              const rawTop = decodeTile(hexToTileBytes(m.key), 0);
              if (tileStats(rawTop).unique > 1) {
                outTiles[`spr:${m.key}`] = {
                  key: m.key,
                  role: 'spr',
                  tier: 'scene',
                  pal,
                  rgb24Base64: bytesToBase64(applySpriteShadePalette(rawTop, primaryHeroUpperPal)),
                };
              }
            }
            if (m.botKey && !onScreenSprKeys.has(m.botKey)) {
              const rawBot = decodeTile(hexToTileBytes(m.botKey), 0);
              if (tileStats(rawBot).unique > 1) {
                outTiles[`spr:${m.botKey}`] = {
                  key: m.botKey,
                  role: 'spr',
                  tier: 'scene',
                  pal,
                  rgb24Base64: bytesToBase64(applySpriteShadePalette(rawBot, primaryHeroLowerPal || primaryHeroUpperPal)),
                };
              }
            }
          }
        }
      }
    }

    // STEP 2: Colorize whole-ROM + off-screen VRAM sheets IN PARALLEL, conditioned directly on
    //         the colorized CURRENT SCREEN (`ctxScreenFile`) + its measured hex palette!
    if (sheetBatches.length > 0) {
      const paletteContextText = `Match this game's current screen palette: ground/backdrop ${toHex(domGroundColor0Rgb)}, world tones ${themeColors.map(toHex).join(', ')}, UI tones ${hudColors.map(toHex).join(', ')}.`;
      const sheetInfos = sheetBatches.map((batch, idx) => {
        const rendered = renderTileSheetInputPng(batch, bgp);
        fs.writeFileSync(sheetPaths[idx], rendered.png);
        return { batch, path: sheetPaths[idx], w: rendered.w, h: rendered.h, cols: rendered.cols };
      });

      const refPrompt = [
        `Image 1 is the colorized current game screen showing the exact world palette, lighting, ground/wall materials, and character art style (${styleSpec.prompt}).`,
        `Using Image 1 as your strict visual palette and style reference (${paletteContextText}), colorize Image 2 (the square ${sheetInfos[0].cols}-column Game Boy ROM tile & sprite sheet from the same game) in-place.`,
        'CRITICAL: Output ONLY the colorized square Image 2 tile grid at its exact 1:1 cell positions edge-to-edge without moving, resizing, cropping, or adding borders.',
      ].join(' ');

      const singleFallbackPrompt = [
        `Colorize every 8x8 pixel-art tile and character sprite in this square Game Boy ROM tile sheet in-place into ${styleSpec.prompt}.`,
        paletteContextText,
        'Keep every tile cell at its exact 1:1 pixel position edge-to-edge without moving, cropping, or adding borders.',
      ].join(' ');

      const hasRefScreen = fs.existsSync(ctxScreenFile);
      const sheetResults = await Promise.all(
        sheetInfos.map((info, idx) =>
          colorizeImageWithGemini({
            inputPath: info.path,
            prompt: refPrompt,
            fallbackPrompt: singleFallbackPrompt,
            referenceImagePath: hasRefScreen ? ctxScreenFile : null,
            expectSquare: true,
            jobPrefix: `${tempBase}_sh${idx}`,
          }).catch(() => null),
        ),
      );

      const allSprKeys = new Set([...offScreenSprKeys, ...sprHintSet]);
      sheetResults.forEach((res, idx) => {
        if (!res) return;
        if (res.model) activeModel = res.model;
        const { batch, w, h, cols } = sheetInfos[idx];
        const sheetLab = sampleGridOklab(res.decoded, w / 4, h / 4);
        batch.forEach((key, tIdx) => {
          const raw = decodeTile(hexToTileBytes(key), 0);
          const st = tileStats(raw);
          if (st.unique <= 1 || isGlyphTile(raw, st)) return;
          const isSpr = allSprKeys.has(key) || isLikelySpriteTile(raw, st);
          const ns = `${isSpr ? 'spr' : 'bg'}:${key}`;
          if (!force && isSceneReady(outTiles[ns])) return;

          let rgb24 = extractSheetTileRgb24(raw, bgp, tIdx, cols, sheetLab, w, chromaBoost);
          if (isSpr) {
            rgb24 = applySpriteShadePalette(raw, extractSpriteShadePalette(raw, rgb24), rgb24);
          } else {
            const isSurface = st.borderZero < 10;
            if (isSurface) {
              rgb24 = makeSeamlessSurfaceRgb24(raw, rgb24).seamless;
            } else if (st.borderZero >= 10) {
              const ext = exteriorMask(raw, 0);
              for (let i = 0; i < 64; i++) {
                if (ext[i]) {
                  rgb24[i * 3] = domGroundColor0Rgb[0];
                  rgb24[i * 3 + 1] = domGroundColor0Rgb[1];
                  rgb24[i * 3 + 2] = domGroundColor0Rgb[2];
                }
              }
            }
          }
          outTiles[ns] = {
            key,
            role: isSpr ? 'spr' : (st.borderZero < 10 ? 'surface' : 'bg'),
            tier: 'rom',
            pal: isSpr ? obp0 : bgp,
            rgb24Base64: bytesToBase64(rgb24),
          };
        });
      });
    }

    return persistAndFinalize(
      outTiles,
      themeColors.map(toHex),
      hudColors.map(toHex),
      activeModel,
      remainingExtraCount,
    );
  } finally {
    fs.rmSync(screenInPath, { force: true });
    for (const p of sheetPaths) fs.rmSync(p, { force: true });
  }
}
