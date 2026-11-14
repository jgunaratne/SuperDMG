// Server-side Gemini vision-action planner for SuperDMG AI Autoplay.
//
// Renders the live 160x144 Game Boy screen at 4x (640x576) inside a labeled 20x18
// tile-coordinate ruler frame (672x608), pairs it with hardware sprite/scroll telemetry
// and recent turn outcomes, and asks Gemini (`GEMINI_MODEL`, default `gemini-3.8-flash`)
// to decide what to do next and return a frame-accurate joypad action sequence.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { encodePng, decodePng } from './png.mjs';
import { base64ToBytes } from '../src/core/hdtiles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_AI_MODEL = 'gemini-3.8-flash';

const SCREEN_W = 160;
const SCREEN_H = 144;
const SCALE = 4;
const VIEW_W = SCREEN_W * SCALE; // 640
const VIEW_H = SCREEN_H * SCALE; // 576
const MARGIN_L = 24;
const MARGIN_T = 20;
const OUT_W = MARGIN_L + VIEW_W + 8;  // 672 (divisible by 16)
const OUT_H = MARGIN_T + VIEW_H + 12; // 608 (divisible by 16)

// Classic high-contrast DMG sage-green/slate palette so 4 shades are unmistakable visually.
const DMG_COLORS = [
  [232, 240, 204], // shade 0: lightest ground/paper
  [158, 184, 128], // shade 1: light mid
  [78, 108, 76],   // shade 2: dark mid
  [20, 32, 24],    // shade 3: darkest ink/wall
];

// Tiny 3x5 pixel digits 0-9 for drawing column (0..19) and row (0..17) rulers.
const DIGITS_3X5 = [
  [0b111, 0b101, 0b101, 0b101, 0b111], // 0
  [0b010, 0b110, 0b010, 0b010, 0b111], // 1
  [0b111, 0b001, 0b111, 0b100, 0b111], // 2
  [0b111, 0b001, 0b111, 0b001, 0b111], // 3
  [0b101, 0b101, 0b111, 0b001, 0b001], // 4
  [0b111, 0b100, 0b111, 0b001, 0b111], // 5
  [0b111, 0b100, 0b111, 0b101, 0b111], // 6
  [0b111, 0b001, 0b001, 0b001, 0b001], // 7
  [0b111, 0b101, 0b111, 0b101, 0b111], // 8
  [0b111, 0b101, 0b111, 0b001, 0b111], // 9
];

export const AI_EFFORTS = [
  { id: 'low', name: 'Low (Fast)', level: 'LOW' },
  { id: 'medium', name: 'Medium', level: 'MEDIUM' },
  { id: 'high', name: 'High', level: 'HIGH' },
];

const VALID_SINGLE_BUTTONS = new Set(['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select', 'wait']);

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

function resolveAiModel() {
  return (process.env.GEMINI_MODEL || DEFAULT_AI_MODEL).trim().replace(/^models\//, '');
}

export function aiPlayerStatus() {
  const mode = process.env.AI_PLAYER_BACKEND || '';
  const model = resolveAiModel();
  if (mode === 'heuristic') {
    return {
      available: true,
      backend: 'heuristic',
      model: `${model} (heuristic)`,
      efforts: AI_EFFORTS,
    };
  }
  if (loadGeminiApiKey()) {
    return {
      available: true,
      backend: 'gemini-api',
      model,
      efforts: AI_EFFORTS,
    };
  }
  return {
    available: false,
    backend: 'none',
    model,
    efforts: AI_EFFORTS,
  };
}

function putPixel(buf, w, h, x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  buf[o] = r;
  buf[o + 1] = g;
  buf[o + 2] = b;
  buf[o + 3] = 255;
}

function blendPixel(buf, w, h, x, y, r, g, b, alpha) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const o = (y * w + x) * 4;
  const inv = 1 - alpha;
  buf[o] = Math.round(buf[o] * inv + r * alpha);
  buf[o + 1] = Math.round(buf[o + 1] * inv + g * alpha);
  buf[o + 2] = Math.round(buf[o + 2] * inv + b * alpha);
  buf[o + 3] = 255;
}

function drawDigit(buf, w, h, digit, x0, y0, scale, rgb) {
  const rows = DIGITS_3X5[digit];
  if (!rows) return;
  for (let ry = 0; ry < 5; ry++) {
    const bits = rows[ry];
    for (let rx = 0; rx < 3; rx++) {
      if ((bits >> (2 - rx)) & 1) {
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            putPixel(buf, w, h, x0 + rx * scale + dx, y0 + ry * scale + dy, rgb[0], rgb[1], rgb[2]);
          }
        }
      }
    }
  }
}

function drawNumber2(buf, w, h, num, cx, cy, rgb = [218, 224, 240]) {
  const s = 2; // each digit is 6x10 px
  if (num >= 10) {
    drawDigit(buf, w, h, Math.floor(num / 10) % 10, cx - 7, cy - 5, s, rgb);
    drawDigit(buf, w, h, num % 10, cx + 1, cy - 5, s, rgb);
  } else {
    drawDigit(buf, w, h, num % 10, cx - 3, cy - 5, s, rgb);
  }
}

/**
 * Renders an annotated 672x608 PNG showing the 4x Game Boy screen framed by
 * 20-column (0..19) and 18-row (0..17) tile rulers plus subtle 8x8 tile gridlines.
 */
export function renderAnnotatedScreenPng({ screenShadesBase64, screenPngBase64, sprites = [] }) {
  const buf = new Uint8Array(OUT_W * OUT_H * 4);
  // Dark slate bezel frame
  for (let i = 0; i < OUT_W * OUT_H; i++) {
    buf[i * 4] = 32;
    buf[i * 4 + 1] = 35;
    buf[i * 4 + 2] = 48;
    buf[i * 4 + 3] = 255;
  }

  let drewPng = false;
  if (screenPngBase64) {
    try {
      const decoded = decodePng(base64ToBytes(screenPngBase64));
      if (decoded.width > 0 && decoded.height > 0) {
        for (let vy = 0; vy < VIEW_H; vy++) {
          const sy = Math.min(decoded.height - 1, Math.floor((vy / VIEW_H) * decoded.height));
          for (let vx = 0; vx < VIEW_W; vx++) {
            const sx = Math.min(decoded.width - 1, Math.floor((vx / VIEW_W) * decoded.width));
            const so = (sy * decoded.width + sx) * 4;
            putPixel(buf, OUT_W, OUT_H, MARGIN_L + vx, MARGIN_T + vy,
              decoded.data[so], decoded.data[so + 1], decoded.data[so + 2]);
          }
        }
        drewPng = true;
      }
    } catch { /* fall back to shades */ }
  }

  if (!drewPng) {
    const shades = screenShadesBase64 ? base64ToBytes(screenShadesBase64) : new Uint8Array(SCREEN_W * SCREEN_H);
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        const [r, g, b] = DMG_COLORS[(shades[y * SCREEN_W + x] ?? 0) & 3];
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            putPixel(buf, OUT_W, OUT_H, MARGIN_L + x * SCALE + dx, MARGIN_T + y * SCALE + dy, r, g, b);
          }
        }
      }
    }
  }

  // Subtle 32px (1 Game Boy 8x8 tile) gridlines so tile distances are visually countable.
  const cellPx = 8 * SCALE; // 32
  for (let col = 0; col <= 20; col++) {
    const gx = MARGIN_L + col * cellPx;
    if (col < 20) drawNumber2(buf, OUT_W, OUT_H, col, gx + 16, 10, col % 5 === 0 ? [255, 222, 122] : [182, 190, 210]);
    if (col > 0 && col < 20) {
      const alpha = col % 5 === 0 ? 0.28 : 0.13;
      for (let vy = 0; vy < VIEW_H; vy++) {
        blendPixel(buf, OUT_W, OUT_H, gx, MARGIN_T + vy, 40, 50, 70, alpha);
      }
    }
  }
  for (let row = 0; row <= 18; row++) {
    const gy = MARGIN_T + row * cellPx;
    if (row < 18) drawNumber2(buf, OUT_W, OUT_H, row, 11, gy + 16, row % 5 === 0 ? [255, 222, 122] : [182, 190, 210]);
    if (row > 0 && row < 18) {
      const alpha = row % 5 === 0 ? 0.28 : 0.13;
      for (let vx = 0; vx < VIEW_W; vx++) {
        blendPixel(buf, OUT_W, OUT_H, MARGIN_L + vx, gy, 40, 50, 70, alpha);
      }
    }
  }

  // Subtle corner ticks around on-screen OAM sprites so small characters stand out clearly.
  sprites.slice(0, 6).forEach((sp, idx) => {
    const x0 = MARGIN_L + Math.round(sp.x * SCALE);
    const y0 = MARGIN_T + Math.round(sp.y * SCALE);
    const w = 8 * SCALE;
    const h = (sp.height === 16 ? 16 : 8) * SCALE;
    const color = idx === 0 ? [0, 212, 255] : [255, 115, 190];
    const arm = 6;
    for (let d = 0; d < arm; d++) {
      // Top-left, top-right, bottom-left, bottom-right corner L-ticks
      putPixel(buf, OUT_W, OUT_H, x0 + d, y0, ...color);
      putPixel(buf, OUT_W, OUT_H, x0, y0 + d, ...color);
      putPixel(buf, OUT_W, OUT_H, x0 + w - 1 - d, y0, ...color);
      putPixel(buf, OUT_W, OUT_H, x0 + w - 1, y0 + d, ...color);
      putPixel(buf, OUT_W, OUT_H, x0 + d, y0 + h - 1, ...color);
      putPixel(buf, OUT_W, OUT_H, x0, y0 + h - 1 - d, ...color);
      putPixel(buf, OUT_W, OUT_H, x0 + w - 1 - d, y0 + h - 1, ...color);
      putPixel(buf, OUT_W, OUT_H, x0 + w - 1, y0 + h - 1 - d, ...color);
    }
  });

  return encodePng(OUT_W, OUT_H, buf);
}

/**
 * Formats the 20x18 visible tile-ID grid into a compact ASCII grid where the dominant
 * walkable/blank background tile is `.` and HUD window rows are marked `W`, making
 * walls, corridors, doors, items, and text blocks unmistakable alongside the image.
 */
function formatAsciiTileGrid(telemetry = {}) {
  const cells = telemetry.gridTiles;
  if (!Array.isArray(cells) || cells.length !== 360) return '';
  const counts = new Map();
  const winRows = new Set(Array.isArray(telemetry.windowRows) ? telemetry.windowRows : []);
  for (let i = 0; i < 360; i++) {
    const row = (i / 20) | 0;
    if (winRows.has(row)) continue;
    const t = cells[i];
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  let floorTile = -1;
  let floorCount = 0;
  for (const [t, c] of counts) {
    if (c > floorCount) { floorTile = t; floorCount = c; }
  }
  // Only treat the dominant tile as open background `.` when it covers >= 20% of non-HUD cells.
  const nonHudCells = Math.max(1, 360 - winRows.size * 20);
  if (floorCount < nonHudCells * 0.2) floorTile = -1;

  // Map sprite positions onto (col, row) for direct overlay reference.
  // For 8x16 tall sprites, anchor `@` on the bottom 8x8 body/feet cell (sp.y + 8)
  // since top-down Game Boy games place collision boxes at the character's feet.
  const spriteAt = new Map();
  for (const sp of telemetry.sprites || []) {
    const bodyY = sp.height === 16 ? sp.y + 8 : sp.y;
    const c = Math.round(sp.x / 8);
    const r = Math.round(bodyY / 8);
    if (c >= 0 && c < 20 && r >= 0 && r < 18 && !spriteAt.has(`${c},${r}`)) {
      spriteAt.set(`${c},${r}`, sp.index === 0 ? '@' : 'S');
    }
  }

  const lines = ['Cols:  00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19'];
  for (let r = 0; r < 18; r++) {
    const tag = winRows.has(r) ? 'W' : ' ';
    const rowTokens = [];
    for (let c = 0; c < 20; c++) {
      const spMark = spriteAt.get(`${c},${r}`);
      const t = cells[r * 20 + c];
      if (spMark) rowTokens.push(`${spMark}${spMark}`);
      else if (t === floorTile) rowTokens.push('..');
      else rowTokens.push(t.toString(16).toUpperCase().padStart(2, '0').slice(-2));
    }
    lines.push(`R${String(r).padStart(2, '0')}${tag}: ${rowTokens.join(' ')}`);
  }
  return lines.join('\n');
}

function buildPrompt(payload) {
  const title = String(payload.title || 'Game Boy ROM').trim();
  const t = payload.telemetry || {};
  const sprites = Array.isArray(t.sprites) ? t.sprites : [];
  const history = Array.isArray(payload.history) ? payload.history.slice(-6) : [];

  const spriteLines = sprites.length
    ? sprites.slice(0, 8).map((s) => {
      const bodyY = s.height === 16 ? s.y + 8 : s.y;
      return `  - Sprite #${s.index}: screen px(${s.x}, ${s.y}), hitbox tile(col=${(s.x / 8).toFixed(1)}, row=${(bodyY / 8).toFixed(1)}), size=8x${s.height || 8}, tile=$${Number(s.tile || 0).toString(16).toUpperCase().padStart(2, '0')}${s.flipX ? ' [facing-left]' : ''}`;
    }).join('\n')
    : '  - None currently visible (likely title screen, menu, text screen, or background-rendered game).';

  const historyLines = history.length
    ? history.map((h) =>
      `  - Turn ${h.turn}: goal="${h.goal}" | actions=[${h.actions}] -> ${h.outcome}`)
      .join('\n')
    : '  - None yet (first turn).';

  const lastTurn = history.length ? history[history.length - 1] : null;
  const stuckWarning = lastTurn && lastTurn.blocked
    ? `\nIMPORTANT: Your previous move [${lastTurn.actions}] produced NO movement or screen change (${lastTurn.outcome}). Do NOT repeat that exact blocked direction! Either route around the obstacle along an open '.' corridor, or if on a title/menu/dialog/win screen, press "start" or "a".\n`
    : '';

  const gridText = formatAsciiTileGrid(t);

  return [
    `You are an AI player autonomously playing the Game Boy game "${title}".`,
    'Look carefully at the attached Game Boy screen image (20 columns 0..19 × 18 rows 0..17, 8×8 px per tile; cyan corner brackets mark Sprite #0) and the hardware telemetry below, then decide what to do next and output a short sequence of controller inputs.',
    '',
    'HARDWARE TELEMETRY:',
    `- Frame: ${t.frameCount ?? 0} | Scroll: SCX=${t.scx ?? 0}, SCY=${t.scy ?? 0}`,
    '- Visible OAM Sprites:',
    spriteLines,
    ...(gridText ? [
      '- Visible 20×18 Tile Grid (`..` = dominant open ground/background, `@@` = Sprite #0, `SS` = other sprite, `W` = HUD window row, hex = non-floor tiles such as walls, water, items, doors, blocks, or text):',
      gridText,
    ] : []),
    '',
    'RECENT TURN MEMORY:',
    historyLines,
    stuckWarning,
    'GAMEPLAY & TIMING RULES:',
    '1. Identify the game state first:',
    '   - Title screen / "PRESS START" / Game Over / "YOU WIN": press `{"button": "start", "frames": 6}` (or `"a"`).',
    '   - Menu / dialogue box: use `"a"` to confirm/advance, `"up"`/`"down"`/`"left"`/`"right"` (4-6 frames) to move cursors.',
    '   - Top-down exploration / maze / RPG: walk along open `..` corridors toward collectibles, gems, keys, stairs, doors, or unexplored areas while steering around wall/water hex tiles! Walking 1 tile (8 pixels) typically takes ~8 frames at 1 px/frame (so 3 tiles = ~24 frames, 5 tiles = ~40 frames). Chain 2–4 turns/corridor segments in one plan when a multi-step L-path or U-path is clearly visible!',
    '   - Puzzle / falling-block / action / platformer: position/rotate pieces (`"left"`, `"right"`, `"a"`, `"b"`, `"down"`) or run & jump using chords like `"right+a"` or `"left+a"`.',
    '2. Avoid oscillating back and forth between the same two spots. Check RECENT TURN MEMORY to make steady forward progress.',
    '3. Valid `"button"` values: `"up"`, `"down"`, `"left"`, `"right"`, `"a"`, `"b"`, `"start"`, `"select"`, `"wait"`, or chords `"right+a"`, `"left+a"`, `"right+b"`, `"left+b"`, `"up+a"`, `"down+a"`.',
    '4. Plan 1 to 5 sequential actions (`frames` between 4 and 72 per step).',
    '',
    'Respond ONLY with valid JSON matching this exact schema:',
    '{"observation": "1 concise sentence describing what is on screen and character/item positions", "goal": "1 concise sentence stating what to do next and how to move", "actions": [{"button": "right", "frames": 24}]}',
  ].join('\n');
}

export function normalizeActionPlan(raw) {
  const observation = String(raw?.observation || raw?.thought || 'Inspecting the Game Boy screen.').trim().slice(0, 240);
  const goal = String(raw?.goal || raw?.plan || raw?.decision || observation).trim().slice(0, 240);
  const rawActions = Array.isArray(raw?.actions) ? raw.actions : [];
  const actions = [];

  for (const item of rawActions.slice(0, 6)) {
    if (!item) continue;
    const rawBtn = String(item.button || item.key || '').toLowerCase().trim();
    const parts = rawBtn.split('+').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1 && parts[0] === 'wait') {
      const frames = Math.max(4, Math.min(60, Math.round(Number(item.frames) || 12)));
      actions.push({ button: 'wait', buttons: [], frames });
      continue;
    }
    const validParts = parts.filter((p) => VALID_SINGLE_BUTTONS.has(p) && p !== 'wait').slice(0, 2);
    if (!validParts.length) continue;
    // Prevent opposite D-pad directions in the same chord
    if ((validParts.includes('left') && validParts.includes('right'))
      || (validParts.includes('up') && validParts.includes('down'))) {
      validParts.splice(1);
    }
    const defaultFrames = validParts.some((b) => b === 'a' || b === 'b' || b === 'start' || b === 'select')
      && validParts.length === 1 ? 6 : 16;
    const frames = Math.max(3, Math.min(80, Math.round(Number(item.frames) || defaultFrames)));
    actions.push({
      button: validParts.join('+'),
      buttons: validParts,
      frames,
    });
  }

  if (!actions.length) {
    actions.push({ button: 'start', buttons: ['start'], frames: 6 });
  }

  return { observation, goal, actions };
}

export function parseModelJsonResponse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('empty model response');
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip markdown code fences or extract outermost JSON object if present.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    if (fenced) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`invalid JSON from model: ${trimmed.slice(0, 120)}`);
  }
}

/**
 * Deterministic vision-grid heuristic planner used ONLY when `AI_PLAYER_BACKEND=heuristic`
 * in unit tests so `npm test` stays fast and hermetic offline.
 */
function runHeuristicPlanner(payload) {
  const t = payload.telemetry || {};
  const sprites = Array.isArray(t.sprites) ? t.sprites : [];
  const history = Array.isArray(payload.history) ? payload.history : [];
  const lastBlocked = history.length > 0 && history[history.length - 1].blocked;

  if (!sprites.length) {
    return normalizeActionPlan({
      observation: 'No active player sprite on screen; likely a title or menu screen.',
      goal: 'Press Start and A to begin or advance the screen.',
      actions: [{ button: 'start', frames: 6 }, { button: 'a', frames: 6 }],
    });
  }

  const sp = sprites[0];
  const col = Math.max(0, Math.min(19, Math.round(sp.x / 8)));
  const row = Math.max(0, Math.min(17, Math.round(sp.y / 8)));
  const cells = Array.isArray(t.gridTiles) && t.gridTiles.length === 360 ? t.gridTiles : null;

  const dirs = [
    { button: 'right', dc: 1, dr: 0 },
    { button: 'down', dc: 0, dr: 1 },
    { button: 'left', dc: -1, dr: 0 },
    { button: 'up', dc: 0, dr: -1 },
  ];
  const lastBtn = history.length ? String(history[history.length - 1].actions || '').split(/\s+/)[0] : '';

  let chosen = dirs[(history.length) % dirs.length];
  if (cells) {
    const floor = cells[row * 20 + col];
    const open = dirs.filter(({ dc, dr, button }) => {
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nc >= 20 || nr < 0 || nr >= 17) return false;
      if (lastBlocked && button === lastBtn) return false;
      const tile = cells[nr * 20 + nc];
      return tile === floor || tile < 3;
    });
    if (open.length) chosen = open[history.length % open.length];
  } else if (lastBlocked) {
    const alt = dirs.filter((d) => d.button !== lastBtn);
    chosen = alt[history.length % alt.length];
  }

  return normalizeActionPlan({
    observation: `Character sprite #0 at tile (${col}, ${row}).`,
    goal: `Move ${chosen.button} to explore the area.`,
    actions: [{ button: chosen.button, frames: 16 }],
  });
}

async function callGeminiPlanner({ imagePath, prompt, effortLevel }) {
  const apiKey = loadGeminiApiKey();
  if (!apiKey) {
    throw new Error('Set GEMINI_API_KEY in your environment or .env to use AI Autoplay.');
  }

  const b64 = fs.readFileSync(imagePath).toString('base64');
  const model = resolveAiModel();
  const thinkingConfig = { thinkingLevel: effortLevel, includeThoughts: false };

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'superdmg-autoplay' },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/png', data: b64 } },
            { text: prompt },
          ],
        }],
        generationConfig: {
          temperature: 0.25,
          responseMimeType: 'application/json',
          thinkingConfig,
        },
      }),
    },
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error?.message || `HTTP ${resp.status}`);
  const parts = data.candidates?.[0]?.content?.parts || [];
  const textPart = [...parts].reverse().find((p) => typeof p.text === 'string' && !p.thought);
  if (!textPart?.text) throw new Error('Gemini API returned no text output');
  return { parsed: parseModelJsonResponse(textPart.text), model };
}

/**
 * Looks at the current Game Boy screen + telemetry and plans the next controller moves
 * using Gemini.
 */
export async function planNextMoves(payload = {}) {
  const tStart = Date.now();
  const effortSpec = AI_EFFORTS.find((e) => e.id === payload.effort) || AI_EFFORTS[0];
  const configuredModel = resolveAiModel();

  if (process.env.AI_PLAYER_BACKEND === 'heuristic') {
    const plan = runHeuristicPlanner(payload);
    return {
      ok: true,
      model: `${configuredModel} (heuristic)`,
      effort: effortSpec.id,
      ...plan,
      elapsedMs: Date.now() - tStart,
    };
  }

  const nonce = crypto.randomBytes(6).toString('hex');
  const tempBase = path.join(os.tmpdir(), `gb_ai_${nonce}`);
  const imagePath = `${tempBase}_screen.png`;

  try {
    const png = renderAnnotatedScreenPng({
      screenShadesBase64: payload.screenShadesBase64,
      screenPngBase64: payload.screenPngBase64,
      sprites: payload.telemetry?.sprites || [],
    });
    fs.writeFileSync(imagePath, png);

    const prompt = buildPrompt(payload);
    const { parsed, model } = await callGeminiPlanner({
      imagePath,
      prompt,
      effortLevel: effortSpec.level,
    });
    const plan = normalizeActionPlan(parsed);
    return {
      ok: true,
      model,
      effort: effortSpec.id,
      ...plan,
      elapsedMs: Date.now() - tStart,
    };
  } finally {
    fs.rmSync(imagePath, { force: true });
  }
}
