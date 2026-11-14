// Closed-loop Gemini AI autoplay controller.
//
// When enabled, inspects the live Game Boy screen + PPU sprite/scroll/tilemap state,
// asks `/api/ai/act` what to do next, executes the returned button plan
// frame-accurately against the emulator clock, measures whether the character or
// screen actually changed, and feeds the outcome into the next turn's memory.

import { SCREEN_W, SCREEN_H, INFO_VALID, INFO_TILE_MASK, INFO_WINDOW } from '../core/ppu.js';
import { readSprites } from '../core/tiles.js';
import { bytesToBase64 } from '../core/hdtiles.js';

const CARDINALS = new Set(['up', 'down', 'left', 'right']);

export const AI_EFFORT_OPTIONS = [
  { id: 'low', name: 'Low · Fast' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
];

function fnv1aBytes(arr, step = 1) {
  let h = 0x811c9dc5;
  for (let i = 0; i < arr.length; i += step) {
    h ^= arr[i] & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnv1aTiles(bgInfo) {
  let h = 0x811c9dc5;
  for (let gy = 0; gy < 18; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      const info = bgInfo[(gy * 8 + 4) * SCREEN_W + (gx * 8 + 4)];
      const tile = (info & INFO_VALID) ? (info & INFO_TILE_MASK) : 0x1ff;
      h ^= tile;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

/** Captures PPU telemetry + hashes for vision grounding and movement/stuck detection. */
export function captureTelemetrySnapshot(gb) {
  const { ppu } = gb;
  const sprites = readSprites(ppu.oam, ppu.lcdc)
    .filter((s) => s.onScreen)
    .map((s) => ({
      index: s.index,
      x: s.x,
      y: s.y,
      tile: s.tile,
      height: s.height,
      flipX: s.flipX,
    }));

  const gridTiles = new Array(360);
  const winCounts = new Uint8Array(18);
  for (let gy = 0; gy < 18; gy++) {
    for (let gx = 0; gx < 20; gx++) {
      const info = ppu.bgInfo[(gy * 8 + 4) * SCREEN_W + (gx * 8 + 4)];
      gridTiles[gy * 20 + gx] = (info & INFO_VALID) ? (info & INFO_TILE_MASK) : 0;
      if ((info & INFO_VALID) && (info & INFO_WINDOW)) winCounts[gy]++;
    }
  }
  const windowRows = [];
  for (let gy = 0; gy < 18; gy++) {
    if (winCounts[gy] >= 10) windowRows.push(gy);
  }

  const spriteSig = sprites.map((s) => `${s.index}:${s.x},${s.y}`).join('|');
  const mapHash = fnv1aTiles(ppu.bgInfo);
  const shadeHash = fnv1aBytes(ppu.display, 3);

  return {
    frameCount: ppu.frameCount,
    scx: ppu.scx,
    scy: ppu.scy,
    wy: ppu.wy,
    wx: ppu.wx,
    sprites,
    gridTiles,
    windowRows,
    spriteSig,
    mapHash,
    shadeHash,
  };
}

/** Compares pre-action and post-action snapshots to report exact movement or wall-blocking. */
export function summarizeTurnOutcome(before, after) {
  if (!before || !after) return { moved: true, blocked: false, text: 'Executed initial actions.' };

  const changes = [];
  let moved = false;

  if (before.sprites.length && after.sprites.length) {
    const b0 = before.sprites[0];
    const a0 = after.sprites.find((s) => s.index === b0.index) || after.sprites[0];
    if (a0 && (a0.x !== b0.x || a0.y !== b0.y)) {
      moved = true;
      const bRow = ((b0.height === 16 ? b0.y + 8 : b0.y) / 8).toFixed(1);
      const aRow = ((a0.height === 16 ? a0.y + 8 : a0.y) / 8).toFixed(1);
      changes.push(
        `Sprite #${b0.index} moved tile(${(b0.x / 8).toFixed(1)},${bRow})->tile(${(a0.x / 8).toFixed(1)},${aRow})`,
      );
    }
  } else if (before.sprites.length !== after.sprites.length) {
    moved = true;
    changes.push(`Visible sprites changed (${before.sprites.length}->${after.sprites.length})`);
  }

  const dScx = ((after.scx - before.scx + 384) % 256) - 128;
  const dScy = ((after.scy - before.scy + 384) % 256) - 128;
  if (dScx !== 0 || dScy !== 0) {
    moved = true;
    changes.push(`Camera scrolled (dSCX=${dScx >= 0 ? '+' : ''}${dScx}, dSCY=${dScy >= 0 ? '+' : ''}${dScy})`);
  }

  if (before.mapHash !== after.mapHash) {
    changes.push('Screen tilemap updated');
  }

  const screenChanged = moved || before.mapHash !== after.mapHash || before.shadeHash !== after.shadeHash;
  if (!moved && before.mapHash === after.mapHash) {
    return {
      moved: false,
      blocked: true,
      text: 'BLOCKED / NO CHANGE (character position, scroll, and tilemap did not change)',
    };
  }
  return {
    moved: screenChanged,
    blocked: false,
    text: changes.join('; ') || 'Screen visuals updated',
  };
}

function formatActionLabel(step) {
  const arrow = { up: '↑', down: '↓', left: '←', right: '→' };
  const btn = String(step.button || 'wait')
    .split('+')
    .map((p) => arrow[p] || p.toUpperCase())
    .join('+');
  return `${btn} ${step.frames}f`;
}

export class AutoPlayer {
  /**
   * @param {{
   *   emulator: import('./emulator.js').Emulator,
   *   screen: import('./screen.js').Screen,
   *   input: import('./input.js').Input,
   *   onUpdate?: Function,
   *   onError?: Function,
   * }} deps
   */
  constructor({ emulator, screen, input, onUpdate, onError }) {
    this.emulator = emulator;
    this.screen = screen;
    this.input = input;
    this.onUpdate = onUpdate || (() => {});
    this.onError = onError || (() => {});

    this.enabled = false;
    this.thinking = false;
    this.effort = 'low';
    this.model = 'gemini-3.8-flash';
    this.turnCount = 0;
    this.lastLatencyMs = 0;
    this.lastObservation = '';
    this.lastGoal = '';
    this.plannedSteps = [];
    this.activeStepIndex = -1;
    this.activeButtons = [];
    this.history = [];

    this._token = 0;
    this._queue = [];
    this._currentItem = null;
    this._itemFrames = 0;
    this._lastMotionSig = '';
    this._stagnantFrames = 0;
    this._settleFrames = 0;
    this._turnBeforeSnap = null;
    this._consecutiveErrors = 0;
    this._retryTimer = 0;
    this._captureCanvas = null;

    this.emulator.addEventListener('frame', () => this._onFrame());
    this.emulator.addEventListener('load', () => this._onRomChange());
    this.emulator.addEventListener('reset', () => this._onRomChange());
  }

  setEffort(effort) {
    if (AI_EFFORT_OPTIONS.some((e) => e.id === effort)) {
      this.effort = effort;
      this.onUpdate();
    }
  }

  toggle() {
    return this.setEnabled(!this.enabled);
  }

  setEnabled(enabled) {
    if (!this.emulator.loaded && enabled) return false;
    if (enabled === this.enabled) return this.enabled;

    clearTimeout(this._retryTimer);
    this._token++;
    this.enabled = Boolean(enabled);
    this._clearExecution();

    if (!this.enabled) {
      this.thinking = false;
      this.onUpdate();
      return false;
    }

    this._consecutiveErrors = 0;
    if (this.emulator.paused) this.emulator.setPaused(false);
    this.lastGoal = 'Looking at the screen with Gemini…';
    this.onUpdate();
    this._requestNextTurn();
    return true;
  }

  _onRomChange() {
    clearTimeout(this._retryTimer);
    this._token++;
    this._clearExecution();
    this.thinking = false;
    this.turnCount = 0;
    this.history = [];
    this.lastObservation = '';
    this.lastGoal = this.enabled ? 'Game restarted — inspecting new screen…' : '';
    this.plannedSteps = [];
    this.activeStepIndex = -1;
    this.onUpdate();
    if (this.enabled && this.emulator.loaded) {
      this._retryTimer = setTimeout(() => {
        if (this.enabled && this.emulator.loaded) this._requestNextTurn();
      }, 180);
    }
  }

  _clearExecution() {
    this._queue = [];
    this._currentItem = null;
    this._itemFrames = 0;
    this._stagnantFrames = 0;
    this._settleFrames = 0;
    this._applyButtons([]);
  }

  _applyButtons(buttons) {
    this.activeButtons = buttons;
    this.input.setAiButtons(buttons);
  }

  _captureHdPngBase64() {
    if (!this.screen.hdActive) return null;
    try {
      if (!this._captureCanvas) {
        this._captureCanvas = document.createElement('canvas');
        this._captureCanvas.width = 320;
        this._captureCanvas.height = 288;
      }
      const ctx = this._captureCanvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.screen.canvas, 0, 0, 320, 288);
      const dataUrl = this._captureCanvas.toDataURL('image/png');
      const comma = dataUrl.indexOf(',');
      return comma >= 0 ? dataUrl.slice(comma + 1) : null;
    } catch {
      return null;
    }
  }

  _motionSignature() {
    const { ppu } = this.emulator.gb;
    let oamHash = 0x811c9dc5;
    for (let i = 0; i < 160; i++) {
      oamHash ^= ppu.oam[i];
      oamHash = Math.imul(oamHash, 0x01000193) >>> 0;
    }
    return `${ppu.scx},${ppu.scy},${oamHash >>> 0},${fnv1aTiles(ppu.bgInfo)}`;
  }

  async _requestNextTurn() {
    if (!this.enabled || !this.emulator.loaded || this.thinking) return;
    const token = ++this._token;

    // Wait briefly if the cartridge just booted and hasn't drawn 2 frames yet.
    for (let wait = 0; wait < 6 && this.emulator.gb.ppu.frameCount < 2; wait++) {
      await new Promise((r) => setTimeout(r, 40));
      if (token !== this._token || !this.enabled || !this.emulator.loaded) return;
    }

    const gb = this.emulator.gb;
    const snap = captureTelemetrySnapshot(gb);
    const title = gb.cart?.header?.title || this.emulator.romName || 'Game Boy ROM';

    this.thinking = true;
    this.activeStepIndex = -1;
    this.onUpdate();

    try {
      const response = await fetch('api/ai/act', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          effort: this.effort,
          screenShadesBase64: bytesToBase64(gb.ppu.display),
          screenPngBase64: this._captureHdPngBase64(),
          telemetry: {
            frameCount: snap.frameCount,
            scx: snap.scx,
            scy: snap.scy,
            wy: snap.wy,
            wx: snap.wx,
            sprites: snap.sprites,
            gridTiles: snap.gridTiles,
            windowRows: snap.windowRows,
          },
          history: this.history.slice(-6),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (token !== this._token || !this.enabled || !this.emulator.loaded) return;

      this._consecutiveErrors = 0;
      this.thinking = false;
      this.turnCount++;
      this.model = data.model || 'gemini-3.8-flash';
      this.lastLatencyMs = Number(data.elapsedMs) || 0;
      this.lastObservation = data.observation || '';
      this.lastGoal = data.goal || '';

      const actions = Array.isArray(data.actions) && data.actions.length
        ? data.actions
        : [{ button: 'wait', buttons: [], frames: 12 }];

      this.plannedSteps = actions.map((a) => ({
        button: a.button || 'wait',
        buttons: Array.isArray(a.buttons) ? a.buttons : [],
        frames: Math.max(3, Math.min(80, Number(a.frames) || 12)),
        label: formatActionLabel(a),
      }));

      // Build frame execution queue with crisp 3-frame release gaps between steps.
      this._turnBeforeSnap = captureTelemetrySnapshot(this.emulator.gb);
      this._queue = [];
      this.plannedSteps.forEach((step, idx) => {
        this._queue.push({
          stepIndex: idx,
          buttons: step.buttons,
          frames: step.frames,
          isCardinalWalk: step.buttons.length === 1 && CARDINALS.has(step.buttons[0]) && step.frames >= 18,
        });
        if (idx < this.plannedSteps.length - 1) {
          this._queue.push({ stepIndex: idx, buttons: [], frames: 3, isGap: true });
        }
      });

      if (this.emulator.paused) this.emulator.setPaused(false);
      this._advanceQueueItem();
      this.onUpdate();
    } catch (err) {
      if (token !== this._token || !this.enabled) return;
      this.thinking = false;
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= 3) {
        this.enabled = false;
        this._clearExecution();
        this.lastGoal = `Stopped: ${err.message}`;
        this.onUpdate();
        this.onError(`AI autoplay stopped: ${err.message}`);
        return;
      }
      this.lastGoal = `Retrying after error (${err.message})…`;
      this.onUpdate();
      this._retryTimer = setTimeout(() => {
        if (token === this._token && this.enabled) this._requestNextTurn();
      }, 1200);
    }
  }

  _advanceQueueItem() {
    this._currentItem = this._queue.shift() || null;
    this._itemFrames = 0;
    this._stagnantFrames = 0;
    if (this._currentItem) {
      this._lastMotionSig = this._motionSignature();
      this.activeStepIndex = this._currentItem.stepIndex;
      this._applyButtons(this._currentItem.buttons);
      this.onUpdate();
    } else {
      this._applyButtons([]);
      this._settleFrames = 2;
      this.onUpdate();
    }
  }

  _onFrame() {
    if (!this.enabled || !this.emulator.loaded || this.emulator.paused || this.thinking) return;

    if (this._currentItem) {
      this._itemFrames++;

      // Early wall-stop guard: if walking in a cardinal direction and nothing has moved
      // for 14 consecutive frames, finish this blocked step early instead of grinding.
      if (this._currentItem.isCardinalWalk && this._itemFrames % 2 === 0) {
        const sig = this._motionSignature();
        if (sig === this._lastMotionSig) {
          this._stagnantFrames += 2;
        } else {
          this._lastMotionSig = sig;
          this._stagnantFrames = 0;
        }
        if (this._itemFrames >= 18 && this._stagnantFrames >= 14) {
          this._advanceQueueItem();
          return;
        }
      }

      if (this._itemFrames >= this._currentItem.frames) {
        this._advanceQueueItem();
      }
      return;
    }

    if (this._settleFrames > 0) {
      this._settleFrames--;
      if (this._settleFrames === 0) {
        const afterSnap = captureTelemetrySnapshot(this.emulator.gb);
        const outcome = summarizeTurnOutcome(this._turnBeforeSnap, afterSnap);
        this.history.push({
          turn: this.turnCount,
          goal: this.lastGoal,
          actions: this.plannedSteps.map((s) => s.label).join(', '),
          outcome: outcome.text,
          moved: outcome.moved,
          blocked: outcome.blocked,
        });
        if (this.history.length > 8) this.history.shift();
        this.activeStepIndex = -1;
        this.onUpdate();
        this._requestNextTurn();
      }
    }
  }
}
