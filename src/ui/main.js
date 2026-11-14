// Application entry point: builds the pieces and wires the page's controls to them.

import { Emulator } from './emulator.js';
import { AudioOutput } from './audio.js';
import { Input } from './input.js';
import { Screen } from './screen.js';
import { Explorer } from './explorer.js';
import { AutoPlayer, AI_EFFORT_OPTIONS } from './autoplayer.js';
import { PALETTES, findPalette, packPalette } from './palettes.js';
import { downloadBlob } from './pixelview.js';
import { looksLikeZip, romFromZip } from './unzip.js';
import {
  HD_STYLES, HdTilePack, collectScreenTiles, computeScreenContextSignature,
  hasStablePalette, bytesToBase64,
} from '../core/hdtiles.js';
import { MIDI_PRESETS } from '../core/midi.js';
import { loadElevenLabsInstrumentBank } from './samples.js';
import {
  loadSettings, saveSettings, storeBatterySave, restoreBatterySave, rememberRom, recallRom,
  cartridgeId, storeHdPack, recallHdPack, deleteHdPack,
} from './storage.js';

const $ = (id) => document.getElementById(id);

const settings = loadSettings({
  palette: 'classic', volume: 60, muted: false,
  midiEnabled: false, midiPreset: 'symphonic',
  tab: 'tiles', tilePalette: 'bgp', dimUnused: false,
  mapViewport: true, mapGrid: false, hideOffscreen: false, highlight: true,
  hdStyle: 'snes', hdAuto: true,
  aiEffort: 'low',
});
const persist = () => saveSettings(settings);

const audio = new AudioOutput();
audio.setVolume(settings.volume / 100);
audio.setMuted(settings.muted);
const emulator = new Emulator(audio);
const screen = new Screen($('lcd'), $('lcd-canvas'), $('lcd-overlay'));
const explorer = new Explorer(emulator, screen, settings, persist);
explorer.onHdVariantSelect = () => {
  drawCurrentScreen();
  if (hdPack && emulator.loaded) {
    storeHdPack(currentCartId(), hdPack.style, hdPack.toRecord());
  }
};

// --- Messages --------------------------------------------------------------------------

let toastTimer = 0;
function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 3500);
}

// --- Advanced Tile Mode (Gemini) -------------------------------------------------------

let hdEnabled = false;
let hdBusy = false;
let hdPack = null;
let hdToken = 0;
let autoUpgradeTimer = 0;
let bgRomDrainTimer = 0;
let frameWatchTick = 0;
let activeSceneSig = null;
let pendingSettleSigId = '';
let pendingSettleCount = 0;
const attemptedMissing = new Set();
const attemptedSceneIds = new Set();

for (const style of HD_STYLES) {
  const option = document.createElement('option');
  option.value = style.id;
  option.textContent = style.name;
  $('hd-style').append(option);
}
$('hd-style').value = HD_STYLES.some((s) => s.id === settings.hdStyle) ? settings.hdStyle : 'snes';
$('hd-auto').checked = Boolean(settings.hdAuto);

function drawCurrentScreen() {
  if (!emulator.loaded) return;
  if (hdEnabled && hdPack) screen.drawHd(emulator.gb.ppu, hdPack);
  else screen.draw(emulator.gb.ppu.display);
}

function setHdStatus(message) {
  $('hd-status').textContent = message;
}

function syncHdControls() {
  const loaded = emulator.loaded;
  $('btn-hd-mode').disabled = !loaded;
  $('btn-hd-mode').setAttribute('aria-pressed', String(hdEnabled));
  $('btn-hd-upgrade').disabled = !loaded || hdBusy;
  $('btn-hd-reroll').disabled = !loaded || hdBusy;
  $('hd-panel').classList.toggle('active', hdEnabled);
  $('hd-panel').classList.toggle('busy', hdBusy);
  updateFlag();
}

function currentCartId() {
  return emulator.gb.cart ? cartridgeId(emulator.gb.cart) : 'rom';
}

async function ensurePackForCurrentRom() {
  const style = $('hd-style').value;
  const cartId = currentCartId();
  const saved = await recallHdPack(cartId, style);
  if (saved) return HdTilePack.fromRecord(saved);
  return new HdTilePack(style);
}

async function upgradeVisibleTiles({ force = false, reviseScene = false, sheetsOnly = false } = {}) {
  if (!emulator.loaded || hdBusy) return false;
  const token = ++hdToken;
  const cart = emulator.gb.cart;
  const cartId = currentCartId();
  const style = $('hd-style').value;

  if (!hdPack) {
    hdPack = await ensurePackForCurrentRom();
    if (token !== hdToken) return false;
    if (hdEnabled) explorer.setHdPack(hdPack);
  } else if (hdPack.style !== style) {
    hdPack = await ensurePackForCurrentRom();
    if (token !== hdToken) return false;
    if (hdEnabled) explorer.setHdPack(hdPack);
  }

  // Wait briefly if the ROM just booted or is mid-fade before capturing the screen.
  if (!sheetsOnly) {
    for (let wait = 0; wait < 8; wait++) {
      const ready = emulator.gb.ppu.frameCount >= 2 && hasStablePalette(emulator.gb.ppu);
      if (ready || emulator.paused) break;
      await new Promise((r) => setTimeout(r, 55));
      if (token !== hdToken || !emulator.loaded) return false;
    }
  }

  const screenSig = computeScreenContextSignature(emulator.gb.ppu);

  // If this screen context was already colorized earlier in this session/history, reuse its cached tiles immediately!
  if (!force && !sheetsOnly && hdPack.restoreCachedSceneIfAvailable(screenSig)) {
    activeSceneSig = screenSig;
    attemptedSceneIds.add(screenSig.id);
    drawCurrentScreen();
    explorer.refresh(true);
    if (hdPack.wholeGameDone) {
      const styleName = HD_STYLES.find((s) => s.id === style)?.name || style;
      setHdStatus(`${styleName} active · Reused cached scene (${hdPack.count} tiles, ${hdPack.historyCount} saved in history).`);
      return true;
    }
  }

  const includeRom = force || sheetsOnly || !hdPack.wholeGameDone;
  const captured = collectScreenTiles(
    emulator.gb.ppu,
    cart.header.title || emulator.romName,
    includeRom ? cart.rom : null,
  );
  const isSceneTier = (map, key) => map.get(key)?.tier === 'scene';
  const artTiles = sheetsOnly ? [] : captured.tiles.filter((t) => {
    if (t.role === 'solid' || t.glyph) return false;
    if (force || reviseScene) return true;
    if (t.role === 'hud') return !isSceneTier(hdPack.winTiles, t.key) && !isSceneTier(hdPack.bgTiles, t.key);
    if (t.role === 'spr16') return !isSceneTier(hdPack.sprTiles, t.key) || !isSceneTier(hdPack.sprTiles, t.pairKey);
    if (t.role === 'spr8') return !isSceneTier(hdPack.sprTiles, t.key);
    return !isSceneTier(hdPack.bgTiles, t.key);
  });

  const uncachedExtraKeys = captured.extraSheetKeys.filter(
    (k) => !hdPack.bgTiles.has(k) && !hdPack.sprTiles.has(k),
  );

  if (!force && !reviseScene && uncachedExtraKeys.length === 0 && artTiles.length === 0 && hdPack.count > 0) {
    hdPack.wholeGameDone = true;
    activeSceneSig = screenSig;
    const styleName = HD_STYLES.find((s) => s.id === style)?.name || style;
    setHdStatus(`${styleName} active · ${hdPack.count} cached game tiles ready (${hdPack.historyCount} in history).`);
    drawCurrentScreen();
    explorer.refresh(true);
    return true;
  }

  for (const t of artTiles) {
    attemptedMissing.add(`${t.role.startsWith('spr') ? 'spr' : 'bg'}:${t.key}`);
    if (t.pairKey) attemptedMissing.add(`spr:${t.pairKey}`);
  }
  if (!sheetsOnly) attemptedSceneIds.add(screenSig.id);

  hdBusy = true;
  syncHdControls();
  setHdStatus(
    sheetsOnly
      ? `Pre-colorizing remaining ROM sprites & tiles from current screen context (${hdPack.count} cached)…`
      : includeRom
        ? `Colorizing current screen + pre-caching ROM sprites & tiles…`
        : `Regenerating tile colors for current screen context…`,
  );

  try {
    const response = await fetch('api/tiles/upgrade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cartId,
        title: captured.title,
        style,
        force,
        reviseScene,
        sheetsOnly,
        sceneId: screenSig.id,
        bgp: captured.bgp,
        obp0: captured.obp0,
        obp1: captured.obp1,
        groundKey: captured.groundKey,
        screenShadesBase64: bytesToBase64(captured.shades),
        gridCells: captured.gridCells,
        spriteClusters: captured.spriteClusters,
        extraSheetKeys: force ? captured.extraSheetKeys : uncachedExtraKeys,
        spriteSheetKeys: captured.spriteSheetKeys,
        spriteFamilies: captured.spriteFamilies,
        tiles: captured.tiles,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (token !== hdToken) return false;

    hdPack.ingest({ ...data, force, sceneId: sheetsOnly ? null : screenSig.id });
    if (!sheetsOnly) activeSceneSig = screenSig;
    await storeHdPack(cartId, style, hdPack.toRecord());

    if (hdEnabled) explorer.setHdPack(hdPack);
    drawCurrentScreen();
    explorer.refresh(true);

    const styleName = HD_STYLES.find((s) => s.id === style)?.name || style;
    const secs = ((data.elapsedMs || 0) / 1000).toFixed(1);
    const rem = Number(data.remainingCount) || 0;
    setHdStatus(
      rem > 0
        ? `${styleName} active · ${hdPack.count} tiles cached (${rem} more ROM tiles pre-colorizing in background…)`
        : data.cached
          ? `${styleName} active · ${hdPack.count} cached game tiles ready (${hdPack.historyCount} saved in history).`
          : `${styleName} active · ${hdPack.count} game tiles colorized in ${secs}s (${hdPack.historyCount} saved in history).`,
    );

    // Continue pre-colorizing remaining Cartridge ROM batches in the background until 100% cached!
    clearTimeout(bgRomDrainTimer);
    if (rem > 0 && hdEnabled && settings.hdAuto) {
      bgRomDrainTimer = setTimeout(() => {
        if (hdEnabled && settings.hdAuto && !hdBusy && emulator.loaded) {
          upgradeVisibleTiles({ force: false, reviseScene: false, sheetsOnly: true });
        }
      }, 450);
    }
    return true;
  } catch (err) {
    if (token === hdToken) {
      setHdStatus(`Could not colorize tiles: ${err.message}`);
      toast(`Advanced Tile Mode failed: ${err.message}`, true);
    }
    return false;
  } finally {
    if (token === hdToken) {
      hdBusy = false;
      syncHdControls();
      if (hdEnabled && settings.hdAuto) scheduleAutoUpgradeIfNeeded(true);
    }
  }
}

async function setHdMode(enabled) {
  if (!emulator.loaded || enabled === hdEnabled) return;
  clearTimeout(autoUpgradeTimer);
  hdEnabled = enabled;
  if (!enabled) {
    explorer.setHdPack(null);
    drawCurrentScreen();
    syncHdControls();
    setHdStatus('Classic 4-shade LCD active. Enter Advanced Tile Mode to colorize all game tiles.');
    return;
  }
  attemptedMissing.clear();
  hdPack = await ensurePackForCurrentRom();
  explorer.setHdPack(hdPack);
  drawCurrentScreen();
  syncHdControls();
  await upgradeVisibleTiles({ force: false });
}

function toggleHdMode() {
  setHdMode(!hdEnabled);
}

function screenSimilarity(sigA, sigB) {
  if (!sigA || !sigB || !sigA.keys.length || !sigB.keys.length) return 0;
  const setA = new Set(sigA.keys);
  let inter = 0;
  for (const k of sigB.keys) if (setA.has(k)) inter++;
  const union = setA.size + sigB.keys.length - inter;
  return union > 0 ? inter / union : 1;
}

function scheduleAutoUpgradeIfNeeded(immediateCheck = false) {
  if (!hdEnabled || !settings.hdAuto || hdBusy || !hdPack || !emulator.loaded) return;
  if (!immediateCheck && (++frameWatchTick % 12) !== 0) return;
  if (!hasStablePalette(emulator.gb.ppu)) return;

  const sig = computeScreenContextSignature(emulator.gb.ppu);

  // 1. If the screen switched to a previously colorized scene, restore its cached tiles immediately!
  if (activeSceneSig && sig.id !== activeSceneSig.id && screenSimilarity(activeSceneSig, sig) < 0.72) {
    if (hdPack.restoreCachedSceneIfAvailable(sig)) {
      activeSceneSig = sig;
      drawCurrentScreen();
      explorer.refresh(true);
      return;
    }
  }

  // 2. Check if new uncached tiles appeared, ROM-tier tiles entered screen, or screen tileset changed!
  let hasFreshMissing = false;
  for (const k of hdPack.missingKeys) {
    if (!attemptedMissing.has(k)) { hasFreshMissing = true; break; }
  }
  let hasFreshRomPromo = false;
  if (hdPack.romTierOnScreen.size >= 1) {
    for (const k of hdPack.romTierOnScreen) {
      if (!attemptedMissing.has(`scene:${k}`)) { hasFreshRomPromo = true; break; }
    }
  }
  const sceneChangedSignificantly = Boolean(
    sig.keys.length >= 2 &&
    activeSceneSig &&
    screenSimilarity(activeSceneSig, sig) < 0.68 &&
    !attemptedSceneIds.has(sig.id),
  );

  if (!hasFreshMissing && !hasFreshRomPromo && !sceneChangedSignificantly) return;

  // Require 2 consecutive stable checks (~200ms) so mid-scroll / mid-wipe frames are skipped cleanly.
  if (!immediateCheck) {
    if (pendingSettleSigId !== sig.id) {
      pendingSettleSigId = sig.id;
      pendingSettleCount = 1;
      return;
    }
    pendingSettleCount++;
    if (pendingSettleCount < 2) return;
  }

  clearTimeout(autoUpgradeTimer);
  autoUpgradeTimer = setTimeout(() => {
    if (hdEnabled && settings.hdAuto && !hdBusy && hasStablePalette(emulator.gb.ppu)) {
      for (const k of hdPack.romTierOnScreen) attemptedMissing.add(`scene:${k}`);
      upgradeVisibleTiles({ force: false, reviseScene: true });
    }
  }, 240);
}

$('btn-hd-mode').addEventListener('click', toggleHdMode);
$('btn-hd-upgrade').addEventListener('click', async () => {
  if (!hdEnabled) await setHdMode(true);
  else {
    attemptedMissing.clear();
    await upgradeVisibleTiles({ force: false, reviseScene: true });
  }
});
$('btn-hd-reroll').addEventListener('click', async () => {
  attemptedMissing.clear();
  if (!hdEnabled) {
    hdEnabled = true;
    syncHdControls();
  }
  await upgradeVisibleTiles({ force: true });
});
$('hd-style').addEventListener('change', async (e) => {
  settings.hdStyle = e.target.value;
  persist();
  attemptedMissing.clear();
  if (!emulator.loaded) return;
  hdPack = await ensurePackForCurrentRom();
  if (hdEnabled) {
    explorer.setHdPack(hdPack);
    drawCurrentScreen();
    await upgradeVisibleTiles({ force: false });
  }
});
$('hd-auto').addEventListener('change', (e) => {
  settings.hdAuto = e.target.checked;
  persist();
  if (settings.hdAuto) scheduleAutoUpgradeIfNeeded();
});

// --- Loading ROMs ----------------------------------------------------------------------

function loadRom(bytes, name, { remember = true } = {}) {
  flushSave();
  try {
    emulator.load(bytes, name);
  } catch (err) {
    toast(`Could not load ${name}: ${err.message}`, true);
    return false;
  }
  const cart = emulator.gb.cart;
  const restored = restoreBatterySave(cart);
  if (restored) emulator.gb.reset(); // boot again with the save in place
  if (remember) rememberRom(name, bytes);
  if (cart.header.cgbOnly) {
    toast('This game is for Game Boy Color only. It will run as on an original Game Boy, which usually means a warning screen.', true);
  } else if (restored) {
    toast(`Loaded ${cart.header.title || name} with its saved game.`);
  }
  $('lcd').focus({ preventScroll: true });
  return true;
}

async function loadFile(file) {
  if (!file) return;
  let bytes = new Uint8Array(await file.arrayBuffer());
  let name = file.name;
  if (looksLikeZip(bytes)) {
    try {
      const entry = await romFromZip(bytes);
      if (!entry) {
        toast(`${file.name} does not contain a .gb or .gbc file.`, true);
        return;
      }
      ({ name, bytes } = entry);
    } catch (err) {
      toast(`Could not read ${file.name}: ${err.message}.`, true);
      return;
    }
  }
  loadRom(bytes, name);
}

$('btn-load').addEventListener('click', () => $('file-rom').click());
$('file-rom').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});
$('btn-demo').addEventListener('click', async () => {
  try {
    const response = await fetch('roms/demo.gb');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    loadRom(new Uint8Array(await response.arrayBuffer()), 'demo.gb', { remember: false });
  } catch (err) {
    toast(`Could not load the demo: ${err.message}`, true);
  }
});

// Drag and drop anywhere on the page.
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('dropzone').hidden = false;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  audio.unlock();
  loadFile(e.dataTransfer.files[0]);
});

// --- Cartridge info and battery saves --------------------------------------------------

function describeSize(bytes) {
  return bytes >= 1 << 20 ? `${bytes >> 20} MiB` : `${bytes >> 10} KiB`;
}

function updateCartInfo() {
  const cart = emulator.gb.cart;
  const { header } = cart;
  $('cart-title').textContent = header.title || emulator.romName;
  $('cart-meta').textContent = [
    cart.typeName, `${describeSize(cart.rom.length)} ROM`,
    cart.ram.length ? `${describeSize(cart.ram.length)} RAM` : '',
  ].filter(Boolean).join(' · ');
  document.title = `${header.title || emulator.romName} · SuperDMG`;
  $('btn-save-export').disabled = !cart.hasBattery;
  $('btn-save-import').disabled = !cart.hasBattery;
  updateSaveStatus();
}

let lastSaved = 0;
function updateSaveStatus() {
  const cart = emulator.gb.cart;
  if (!cart) return;
  $('save-status').textContent = !cart.hasBattery ? 'This cartridge has no battery.'
    : lastSaved ? `Saved in this browser at ${new Date(lastSaved).toLocaleTimeString()}.`
      : 'Saves are kept in this browser automatically.';
}

/** Writes battery RAM to storage if the game has changed it. */
function flushSave() {
  const cart = emulator.gb.cart;
  if (!cart || !cart.hasBattery || !cart.ramDirty) return;
  if (storeBatterySave(cart)) {
    lastSaved = Date.now();
    updateSaveStatus();
  } else {
    toast('Could not store the saved game in this browser. Use Export .sav to keep it.', true);
  }
}
setInterval(flushSave, 2000);
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

$('btn-save-export').addEventListener('click', () => {
  const cart = emulator.gb.cart;
  const data = cart && cart.getSaveData();
  if (!data) return;
  const stem = emulator.romName.replace(/\.[^.]+$/, '') || 'game';
  downloadBlob(new Blob([data], { type: 'application/octet-stream' }), `${stem}.sav`);
});
$('btn-save-import').addEventListener('click', () => $('file-save').click());
$('file-save').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const cart = emulator.gb.cart;
  if (!file || !cart) return;
  cart.loadSaveData(new Uint8Array(await file.arrayBuffer()));
  storeBatterySave(cart);
  emulator.reset();
  toast(`Imported ${file.name}. The game was restarted to pick it up.`);
});

// --- Transport -------------------------------------------------------------------------

const transportButtons = [$('btn-pause'), $('btn-step'), $('btn-reset')];
let autoPlayer = null;

function updateFlag() {
  const flag = $('lcd-flag');
  const cpu = emulator.gb.cpu;
  const text = !emulator.loaded ? ''
    : cpu.locked ? `CPU locked up (bad opcode $${cpu.lockedOpcode.toString(16).toUpperCase()})`
      : emulator.paused ? 'Paused'
        : emulator.fastForward ? 'Fast'
          : hdBusy ? 'Upgrading tiles…'
            : autoPlayer && autoPlayer.enabled
              ? (autoPlayer.thinking ? 'AI Autoplay · Thinking…' : 'AI Autoplay')
              : hdEnabled ? 'HD Color' : '';
  flag.textContent = text;
  flag.hidden = !text;
}

emulator.addEventListener('load', async () => {
  $('lcd-empty').hidden = true;
  for (const b of transportButtons) b.disabled = false;
  lastSaved = 0;
  clearTimeout(autoUpgradeTimer);
  clearTimeout(bgRomDrainTimer);
  attemptedMissing.clear();
  attemptedSceneIds.clear();
  activeSceneSig = null;
  hdToken++;
  hdBusy = false;
  hdPack = null;
  updateCartInfo();
  syncHdControls();
  syncAiControls();
  if (hdEnabled) {
    hdPack = await ensurePackForCurrentRom();
    explorer.setHdPack(hdPack);
    drawCurrentScreen();
    upgradeVisibleTiles({ force: false });
  } else {
    explorer.setHdPack(null);
  }
});
emulator.addEventListener('pause', () => {
  $('btn-pause').setAttribute('aria-pressed', String(emulator.paused));
  $('btn-pause').textContent = emulator.paused ? 'Resume' : 'Pause';
  updateFlag();
});
emulator.addEventListener('frame', () => {
  drawCurrentScreen();
  updateFlag();
  if (hdEnabled) scheduleAutoUpgradeIfNeeded();
});
setInterval(() => {
  $('fps').textContent = emulator.loaded && !emulator.paused ? `${emulator.fps.toFixed(1)} fps` : '\u00a0';
}, 500);

$('btn-pause').addEventListener('click', () => emulator.togglePause());
$('btn-step').addEventListener('click', () => emulator.stepFrame());
$('btn-reset').addEventListener('click', () => {
  flushSave();
  emulator.reset();
});

const speedButtons = [...$('speed').querySelectorAll('button')];
for (const button of speedButtons) {
  button.addEventListener('click', () => {
    emulator.setSpeed(Number(button.dataset.speed));
    for (const b of speedButtons) b.setAttribute('aria-pressed', String(b === button));
  });
}

// --- Sound -----------------------------------------------------------------------------

for (const preset of MIDI_PRESETS) {
  const option = document.createElement('option');
  option.value = preset.id;
  option.textContent = preset.name;
  $('midi-preset').append(option);
}
if (!MIDI_PRESETS.some((p) => p.id === settings.midiPreset)) settings.midiPreset = 'symphonic';

function syncMidiControls() {
  const enabled = Boolean(settings.midiEnabled);
  $('midi-enabled').checked = enabled;
  $('midi-preset').value = settings.midiPreset;
  $('midi-preset').disabled = !enabled;
  emulator.gb.apu.setMidiPreset(settings.midiPreset);
  emulator.gb.apu.setMidiEnabled(enabled);
}

function setMidiMode(enabled) {
  settings.midiEnabled = Boolean(enabled);
  audio.unlock();
  syncMidiControls();
  persist();
}

function toggleMidiMode() {
  setMidiMode(!settings.midiEnabled);
}

function setMidiPreset(id) {
  if (!MIDI_PRESETS.some((p) => p.id === id)) return;
  settings.midiPreset = id;
  syncMidiControls();
  persist();
}

$('midi-enabled').addEventListener('change', (e) => setMidiMode(e.target.checked));
$('midi-preset').addEventListener('change', (e) => setMidiPreset(e.target.value));
syncMidiControls();

const midiSamplesReady = loadElevenLabsInstrumentBank(emulator.gb.apu.midi).catch(() => 0);

function updateMute() {
  $('btn-mute').setAttribute('aria-pressed', String(!settings.muted));
  $('btn-mute').textContent = settings.muted ? 'Muted' : 'Sound';
}
function toggleMute() {
  settings.muted = !settings.muted;
  audio.setMuted(settings.muted);
  audio.unlock();
  updateMute();
  persist();
}
$('btn-mute').addEventListener('click', toggleMute);
$('volume').value = String(settings.volume);
$('volume').addEventListener('input', (e) => {
  settings.volume = Number(e.target.value);
  audio.setVolume(settings.volume / 100);
  persist();
});
updateMute();

// Browsers hold audio back until the first click or key press.
window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });

// --- Screen colours and size -----------------------------------------------------------

function applyPalette(id) {
  const palette = findPalette(id);
  settings.palette = palette.id;
  const colors = packPalette(palette);
  screen.setColors(colors);
  explorer.setColors(colors);
  drawCurrentScreen();
  for (const b of $('palettes').children) b.setAttribute('aria-pressed', String(b.dataset.palette === palette.id));
}
for (const palette of PALETTES) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'swatch';
  button.dataset.palette = palette.id;
  const strip = document.createElement('i');
  for (const color of palette.colors) {
    const b = document.createElement('b');
    b.style.background = color;
    strip.append(b);
  }
  button.append(strip, palette.name);
  button.addEventListener('click', () => { applyPalette(palette.id); persist(); });
  $('palettes').append(button);
}
applyPalette(settings.palette);

/** Largest whole-number scale that leaves room for the explorer beside the screen. */
function fitScreen() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  let scale;
  if (width <= 1120) scale = Math.floor((Math.min(width, 620) - 60) / 160);
  else scale = width >= 1600 && height >= 940 ? 4 : 3;
  screen.setScale(Math.max(1, Math.min(5, scale)));
  explorer.refresh(true);
}
window.addEventListener('resize', fitScreen);
fitScreen();

// --- Input & AI Autoplay ---------------------------------------------------------------

const input = new Input(emulator, {
  onPause: () => emulator.togglePause(),
  onStep: () => emulator.stepFrame(),
  onMute: toggleMute,
  onMidiMode: toggleMidiMode,
  onHdMode: toggleHdMode,
  onAiMode: () => { if (emulator.loaded) autoPlayer.toggle(); },
  onEscape: () => explorer.unpin(),
  onGesture: () => audio.unlock(),
});
input.bindTouchPad($('pad'));

for (const opt of AI_EFFORT_OPTIONS) {
  const option = document.createElement('option');
  option.value = opt.id;
  option.textContent = opt.name;
  $('ai-effort').append(option);
}
if (!AI_EFFORT_OPTIONS.some((e) => e.id === settings.aiEffort)) settings.aiEffort = 'low';
$('ai-effort').value = settings.aiEffort;

const padButtonEls = [...$('pad').querySelectorAll('[data-button]')];
const DEFAULT_AI_PROMPT = 'Check AI Autoplay to let Gemini 4 Hydrogen inspect the screen, decide what to do next, and move the character automatically.';
let renderedLogRev = -1;

function cleanThoughtDisplay(raw) {
  return String(raw || '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderAiLog() {
  if (!autoPlayer || renderedLogRev === autoPlayer.logRevision) return;
  renderedLogRev = autoPlayer.logRevision;

  const logEl = $('ai-log');
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 56;
  const entries = autoPlayer.thinkingLog;

  if (!entries.length && !autoPlayer.thinking) {
    const empty = document.createElement('p');
    empty.className = 'ai-log-empty';
    empty.id = 'ai-log-empty';
    empty.textContent = 'Thinking history will appear here turn by turn once AI Autoplay starts. Type or paste hints, walkthrough steps, or goals below to steer the AI.';
    logEl.replaceChildren(empty);
    return;
  }

  const nodes = [];
  for (const entry of entries) {
    if (entry.kind === 'user') {
      const card = document.createElement('div');
      card.className = 'ai-entry ai-entry-user';
      const head = document.createElement('div');
      head.className = 'ai-entry-head';
      const tag = document.createElement('span');
      tag.className = 'ai-entry-tag';
      tag.textContent = 'You · Hint';
      const time = document.createElement('span');
      time.className = 'mono';
      time.textContent = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      head.append(tag, time);

      const body = document.createElement('div');
      body.className = 'ai-entry-user-text';
      body.textContent = entry.text;
      card.append(head, body);
      nodes.push(card);
      continue;
    }

    const card = document.createElement('div');
    card.className = 'ai-entry';

    const head = document.createElement('div');
    head.className = 'ai-entry-head';
    const tag = document.createElement('span');
    tag.className = 'ai-entry-tag';
    tag.textContent = `Turn #${entry.turn}`;
    const timing = document.createElement('span');
    timing.className = 'mono';
    timing.textContent = entry.latencyMs > 0 ? `${(entry.latencyMs / 1000).toFixed(1)}s · ${entry.effort}` : entry.effort;
    const steps = document.createElement('span');
    steps.className = 'ai-entry-steps';
    steps.textContent = entry.actions.join(' → ');
    const outcome = document.createElement('span');
    outcome.className = `ai-entry-outcome${entry.blocked ? ' blocked' : entry.moved ? ' ok' : ''}`;
    outcome.textContent = entry.pending
      ? 'Executing…'
      : entry.blocked
        ? 'Blocked'
        : entry.moved
          ? 'Moved'
          : (entry.outcome || 'Done');
    if (entry.outcome) outcome.title = entry.outcome;
    head.append(tag, timing, steps, outcome);
    card.append(head);

    if (entry.goal) {
      const goalEl = document.createElement('div');
      goalEl.className = 'ai-entry-goal';
      goalEl.textContent = entry.goal;
      card.append(goalEl);
    }
    if (entry.observation) {
      const obsEl = document.createElement('div');
      obsEl.className = 'ai-entry-obs';
      obsEl.textContent = entry.observation;
      card.append(obsEl);
    }
    const cleanedThought = cleanThoughtDisplay(entry.thought);
    if (cleanedThought) {
      const thoughtEl = document.createElement('div');
      thoughtEl.className = 'ai-entry-thought';
      thoughtEl.textContent = cleanedThought;
      card.append(thoughtEl);
    }
    nodes.push(card);
  }

  if (autoPlayer.thinking) {
    const card = document.createElement('div');
    card.className = 'ai-entry ai-entry-thinking';
    const head = document.createElement('div');
    head.className = 'ai-entry-head';
    const tag = document.createElement('span');
    tag.className = 'ai-entry-tag';
    tag.textContent = `Turn #${autoPlayer.turnCount + 1}`;
    const status = document.createElement('span');
    status.textContent = `Thinking with ${autoPlayer.model} (${autoPlayer.effort})…`;
    head.append(tag, status);
    card.append(head);
    nodes.push(card);
  }

  logEl.replaceChildren(...nodes);
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function syncAiControls() {
  if (!autoPlayer) return;
  const loaded = emulator.loaded;
  const active = autoPlayer.enabled;
  $('ai-play').disabled = !loaded;
  $('ai-play').checked = active;
  $('ai-effort').disabled = !loaded;
  $('ai-effort').value = autoPlayer.effort;
  $('ai-model-badge').textContent = autoPlayer.model || 'gemini-4-hydrogen';
  $('ai-panel').classList.toggle('active', active);
  $('ai-panel').classList.toggle('thinking', active && autoPlayer.thinking);
  $('lcd').classList.toggle('ai-active', active);

  const heldSet = new Set(autoPlayer.activeButtons);
  for (const el of padButtonEls) {
    el.classList.toggle('ai-held', active && heldSet.has(el.dataset.button));
  }

  const actionsEl = $('ai-actions');
  if (active && autoPlayer.plannedSteps.length) {
    actionsEl.replaceChildren(
      ...autoPlayer.plannedSteps.map((step, idx) => {
        const span = document.createElement('span');
        span.className = 'ai-chip';
        if (!autoPlayer.thinking && idx === autoPlayer.activeStepIndex) span.classList.add('current');
        else if (!autoPlayer.thinking && autoPlayer.activeStepIndex > idx) span.classList.add('done');
        span.textContent = step.label;
        return span;
      }),
    );
    actionsEl.hidden = false;
  } else {
    actionsEl.replaceChildren();
    actionsEl.hidden = true;
  }

  if (active) {
    $('ai-goal').textContent = autoPlayer.thinking
      ? `Thinking (Turn #${autoPlayer.turnCount + 1})…`
      : (autoPlayer.lastGoal || 'Looking at the screen with Gemini 4 Hydrogen…');
  } else {
    $('ai-goal').textContent = autoPlayer.lastGoal && autoPlayer.lastGoal.startsWith('Stopped:')
      ? autoPlayer.lastGoal
      : DEFAULT_AI_PROMPT;
  }

  const notes = autoPlayer.userNotes;
  const notesBar = $('ai-notes-bar');
  if (notes.length > 0) {
    const latest = notes[notes.length - 1].replace(/\s+/g, ' ');
    $('ai-notes-summary').textContent = notes.length === 1
      ? `Active hint: "${latest}"`
      : `Active hints (${notes.length}): latest "${latest}"`;
    notesBar.hidden = false;
  } else {
    notesBar.hidden = true;
  }

  renderAiLog();
  updateFlag();
}

autoPlayer = new AutoPlayer({
  emulator,
  screen,
  input,
  getDraftGuidance: () => $('ai-assist-input').value,
  onUpdate: syncAiControls,
  onError: (msg) => toast(msg, true),
});
autoPlayer.setEffort(settings.aiEffort);
syncAiControls();

function submitAiAssist() {
  const inputEl = $('ai-assist-input');
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  autoPlayer.addUserGuidance(text);
}

$('ai-play').addEventListener('change', (e) => {
  audio.unlock();
  autoPlayer.setEnabled(e.target.checked);
});
$('ai-effort').addEventListener('change', (e) => {
  settings.aiEffort = e.target.value;
  autoPlayer.setEffort(settings.aiEffort);
  persist();
  if (emulator.loaded) $('lcd').focus({ preventScroll: true });
});
$('btn-ai-clear').addEventListener('click', () => {
  autoPlayer.clearHistory();
});
$('btn-ai-clear-notes').addEventListener('click', () => {
  autoPlayer.clearUserGuidance();
});
$('ai-assist-form').addEventListener('submit', (e) => {
  e.preventDefault();
  submitAiAssist();
});
$('ai-assist-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitAiAssist();
  }
});

// Mouse clicks on controls should not take the keyboard away from the game: hand
// focus back to the screen afterwards. Keyboard users keep normal focus behaviour.
document.addEventListener('click', (e) => {
  if (e.detail === 0) return; // activated from the keyboard
  if (e.target.closest('.ai-assist, .ai-log, .ai-notes-bar, #btn-ai-clear')) return;
  const control = e.target.closest('button, input[type="checkbox"], input[type="range"], [role="tab"]');
  if (control && emulator.loaded) $('lcd').focus({ preventScroll: true });
});
$('volume').addEventListener('change', () => { if (emulator.loaded) $('lcd').focus({ preventScroll: true }); });
$('midi-preset').addEventListener('change', () => { if (emulator.loaded) $('lcd').focus({ preventScroll: true }); });
$('hd-style').addEventListener('change', () => { if (emulator.loaded) $('lcd').focus({ preventScroll: true }); });

// --- Start-up --------------------------------------------------------------------------

// Carry on with the last game, if the browser still has it.
recallRom().then((entry) => {
  if (entry && !emulator.loaded) loadRom(entry.bytes, entry.name, { remember: false });
});

const hd = {
  get enabled() { return hdEnabled; },
  get busy() { return hdBusy; },
  get pack() { return hdPack; },
  setEnabled: setHdMode,
  toggle: toggleHdMode,
  upgrade: upgradeVisibleTiles,
};

const midi = {
  get enabled() { return Boolean(settings.midiEnabled); },
  get preset() { return settings.midiPreset; },
  get samplesLoaded() { return emulator.gb.apu.midi.samplesLoaded; },
  get sampleCount() { return emulator.gb.apu.midi.sampleCount; },
  samplesReady: midiSamplesReady,
  setEnabled: setMidiMode,
  toggle: toggleMidiMode,
  setPreset: setMidiPreset,
};

const ai = {
  get enabled() { return autoPlayer.enabled; },
  get thinking() { return autoPlayer.thinking; },
  get turnCount() { return autoPlayer.turnCount; },
  get effort() { return autoPlayer.effort; },
  get lastThought() { return autoPlayer.lastThought; },
  get lastGoal() { return autoPlayer.lastGoal; },
  get lastObservation() { return autoPlayer.lastObservation; },
  get activeButtons() { return [...autoPlayer.activeButtons]; },
  get plannedSteps() { return [...autoPlayer.plannedSteps]; },
  get history() { return [...autoPlayer.history]; },
  get thinkingLog() { return [...autoPlayer.thinkingLog]; },
  get userNotes() { return [...autoPlayer.userNotes]; },
  setEnabled: (on) => autoPlayer.setEnabled(on),
  toggle: () => autoPlayer.toggle(),
  assist: (text) => autoPlayer.addUserGuidance(text),
  clearHistory: () => autoPlayer.clearHistory(),
  clearGuidance: () => autoPlayer.clearUserGuidance(),
  setEffort: (effort) => {
    settings.aiEffort = effort;
    autoPlayer.setEffort(effort);
    persist();
  },
};

// Handy in the console, and used by the end-to-end test.
window.gameboy = { emulator, screen, explorer, audio, input, loadRom, hd, midi, ai };
