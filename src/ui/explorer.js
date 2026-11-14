// The tile explorer: a live view of the graphics the game has loaded.
//
//   Tiles     every 8x8 tile in video RAM (or the cartridge ROM read as tile data)
//   Tilemaps  the two 32x32 maps the background and window are built from
//   Sprites   the 40 entries of the sprite table (OAM)
//
// All three, and the game screen itself, feed one inspector. Hovering shows a tile
// there; clicking pins it. A pinned or hovered video-RAM tile is highlighted wherever
// it is currently visible on the game screen and in the maps.

import { PixelView, downloadBlob } from './pixelview.js';
import {
  renderTileSheet, renderTilemap, readSprites, renderSprite, tileUsage, tileNumber,
  tileAddress, applyPalette, visibleTileAt, IDENTITY_PALETTE, VRAM_TILES, TILE_BYTES, MAP_BASES,
} from '../core/tiles.js';
import { SCREEN_W, SCREEN_H } from '../core/ppu.js';
import { HD_SCALE, HD_TILE_PX } from '../core/hdtiles.js';

const hex = (v, digits = 2) => v.toString(16).toUpperCase().padStart(digits, '0');
const $ = (id) => document.getElementById(id);

const SHEET_COLUMNS = 16;
const SHEET_ROWS = VRAM_TILES / SHEET_COLUMNS;
const ROM_PAGE = VRAM_TILES * TILE_BYTES;

const SELECT = '#ff2d87';
const HOVER = '#ffffff';
const GRID = 'rgba(255, 255, 255, 0.09)';
const BLOCK_LINE = 'rgba(232, 193, 90, 0.7)';
const DIM = 'rgba(42, 44, 55, 0.74)';
const VIEWPORT = '#ffd23f';
const WINDOW_AREA = '#5ad1ff';
const WELL = 0xff372c2a; // --well, packed

const BLOCKS = [
  'sprites, and background when LCDC.4 is set',
  'shared by sprites and background',
  'background when LCDC.4 is clear',
];

export class Explorer {
  /**
   * @param {import('./emulator.js').Emulator} emulator
   * @param {import('./screen.js').Screen} screen
   * @param {{tab: string, tilePalette: string, dimUnused: boolean, mapViewport: boolean,
   *     mapGrid: boolean, hideOffscreen: boolean, highlight: boolean}} prefs
   * @param {() => void} onPrefsChange
   */
  constructor(emulator, screen, prefs, onPrefsChange) {
    this.emulator = emulator;
    this.gb = emulator.gb;
    this.screen = screen;
    this.prefs = prefs;
    this.onPrefsChange = onPrefsChange;
    this.colors = new Uint32Array(4);

    this.tab = prefs.tab;
    this.source = 'vram';
    this.romOffset = 0;
    this.mapIndex = 0;
    /** Pinned subject: {source: 'vram', tile} or {source: 'rom', offset}, plus context. */
    this.pinned = null;
    this.hovered = null;
    this.screenHover = null; // pick result while the pointer is over the game screen
    this.frameCount = 0;
    this.cache = {};         // last text written to each DOM node, to avoid churn

    // Phones get smaller sheets so they fit without sideways scrolling.
    const compact = window.innerWidth < 600;
    this.tileView = new PixelView($('tile-sheet'), {
      width: SHEET_COLUMNS * 8, height: SHEET_ROWS * 8, scale: compact ? 2 : 3,
      columnLabels: [...'0123456789ABCDEF'],
    });
    this.mapView = new PixelView($('map-sheet'), {
      width: 256, height: 256, scale: compact ? 1 : 2, cell: 32,
      columnLabels: ['00', '04', '08', '0C', '10', '14', '18', '1C'],
      rowLabels: ['00', '04', '08', '0C', '10', '14', '18', '1C'],
    });
    this.inspCanvas = $('insp-canvas');
    this.inspCtx = this.inspCanvas.getContext('2d');
    this.inspImage = this.inspCtx.createImageData(8, 8);
    this.inspPixels = new Uint32Array(this.inspImage.data.buffer);
    this.inspHdCanvas = $('insp-hd-canvas');
    this.inspHdCtx = this.inspHdCanvas.getContext('2d');
    this.inspHdImage = this.inspHdCtx.createImageData(HD_TILE_PX, HD_TILE_PX);
    this.hdPack = null;
    this.showHd = true;

    this.buildSprites();
    this.bindTabs();
    this.bindTiles();
    this.bindMaps();
    this.bindScreen();
    this.bindInspector();
    $('explorer-hd').addEventListener('change', (e) => {
      this.showHd = e.target.checked;
      this.refresh(true);
    });
    this.updateRowLabels();
    this.setTab(this.tab);

    emulator.addEventListener('load', () => {
      this.pinned = null;
      this.hovered = null;
      this.romOffset = 0;
      $('rom-bank').max = String(this.gb.cart.romBanks - 1);
      this.updateRowLabels();
      this.refresh(true);
    });
    emulator.addEventListener('reset', () => this.refresh(true));
    emulator.addEventListener('pause', () => this.refresh(true));
    emulator.addEventListener('frame', () => {
      // The screen overlay tracks every frame; the heavier views every other one.
      this.frameCount++;
      this.refresh(emulator.paused || (this.frameCount & 1) === 0);
    });
  }

  setColors(colors) {
    this.colors = colors;
    this.cache = {};
    this.refresh(true);
  }

  /** Attaches or detaches an upgraded HD tile pack so Explorer views can preview HD tiles. */
  setHdPack(hdPack) {
    this.hdPack = hdPack;
    $('explorer-hd-wrap').hidden = !hdPack;
    this.cache.inspEmpty = null;
    this.refresh(true);
  }

  /** What the inspector is showing: a hover preview wins over the pin. */
  get subject() { return this.hovered || this.pinned; }

  // --- Wiring -------------------------------------------------------------------------

  bindTabs() {
    this.tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
    this.tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => this.setTab(tab.id.replace('tab-', '')));
      tab.addEventListener('keydown', (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        e.stopPropagation(); // arrow keys move between tabs here, not the D-pad
        const next = this.tabs[(i + step + this.tabs.length) % this.tabs.length];
        next.focus();
        this.setTab(next.id.replace('tab-', ''));
      });
    });
  }

  setTab(name) {
    if (!this.tabs.some((t) => t.id === `tab-${name}`)) name = 'tiles';
    this.tab = name;
    for (const tab of this.tabs) {
      const selected = tab.id === `tab-${name}`;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (this.prefs.tab !== name) {
      this.prefs.tab = name;
      this.onPrefsChange();
    }
    this.refresh(true);
  }

  bindPref(id, key) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = this.prefs[key]; else el.value = this.prefs[key];
    el.addEventListener('change', () => {
      this.prefs[key] = el.type === 'checkbox' ? el.checked : el.value;
      this.onPrefsChange();
      this.refresh(true);
    });
  }

  bindSegmented(id, attribute, onSelect) {
    const buttons = [...$(id).querySelectorAll('button')];
    for (const button of buttons) {
      button.addEventListener('click', () => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
        onSelect(button.dataset[attribute]);
      });
    }
  }

  bindTiles() {
    this.bindPref('tile-palette', 'tilePalette');
    this.bindPref('tile-dim', 'dimUnused');
    this.bindSegmented('tile-source', 'source', (source) => {
      this.source = source;
      $('rom-bar').hidden = source !== 'rom';
      $('tile-dim').closest('label').hidden = source === 'rom';
      this.hovered = null;
      this.updateRowLabels();
      this.refresh(true);
    });

    const move = (delta) => {
      const max = Math.max(0, (this.gb.cart ? this.gb.cart.rom.length : 0) - TILE_BYTES);
      this.romOffset = Math.max(0, Math.min(max, this.romOffset + delta));
      this.updateRowLabels();
      this.refresh(true);
    };
    $('rom-prev').addEventListener('click', () => move(-ROM_PAGE));
    $('rom-next').addEventListener('click', () => move(ROM_PAGE));
    $('rom-nudge-down').addEventListener('click', () => move(-1));
    $('rom-nudge-up').addEventListener('click', () => move(1));
    $('rom-bank').addEventListener('change', (e) => {
      const banks = this.gb.cart ? this.gb.cart.romBanks : 1;
      const bank = Math.max(0, Math.min(banks - 1, Number(e.target.value) || 0));
      this.romOffset = bank * 0x4000 + (this.romOffset & 0x0f);
      this.updateRowLabels();
      this.refresh(true);
    });

    const view = this.tileView;
    const subjectAt = (event) => {
      const p = view.locate(event);
      if (!p) return null;
      const index = (p.y >> 3) * SHEET_COLUMNS + (p.x >> 3);
      if (this.source === 'vram') return { source: 'vram', tile: index, context: { from: 'sheet' } };
      const offset = this.romOffset + index * TILE_BYTES;
      if (!this.gb.cart || offset + TILE_BYTES > this.gb.cart.rom.length) return null;
      return { source: 'rom', offset, context: { from: 'sheet' } };
    };
    view.stack.addEventListener('pointermove', (e) => this.setHover(subjectAt(e)));
    view.stack.addEventListener('pointerleave', () => this.setHover(null));
    view.stack.addEventListener('click', (e) => this.togglePin(subjectAt(e)));

    $('btn-sheet-png').addEventListener('click', async () => {
      const suffix = this.source === 'vram' ? 'vram-tiles' : `rom-${hex(this.romOffset, 6)}`;
      downloadBlob(await view.toBlob(4), `${this.fileStem()}-${suffix}.png`);
    });
  }

  bindMaps() {
    this.bindPref('map-viewport', 'mapViewport');
    this.bindPref('map-grid', 'mapGrid');
    this.bindSegmented('map-select', 'map', (index) => {
      this.mapIndex = Number(index);
      this.refresh(true);
    });
    const view = this.mapView;
    const subjectAt = (event) => {
      const p = view.locate(event);
      if (!p) return null;
      const col = p.x >> 3, row = p.y >> 3;
      const ppu = this.gb.ppu;
      const offset = MAP_BASES[this.mapIndex] + row * 32 + col;
      const entry = ppu.vram[offset];
      return {
        source: 'vram', tile: tileNumber(entry, (ppu.lcdc & 0x10) !== 0),
        context: { from: 'map', address: 0x8000 + offset, col, row, entry },
      };
    };
    view.stack.addEventListener('pointermove', (e) => this.setHover(subjectAt(e)));
    view.stack.addEventListener('pointerleave', () => this.setHover(null));
    view.stack.addEventListener('click', (e) => this.togglePin(subjectAt(e)));
  }

  buildSprites() {
    this.bindPref('sprite-hide-off', 'hideOffscreen');
    const grid = $('sprite-grid');
    this.spriteCells = [];
    for (let index = 0; index < 40; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sprite';
      button.setAttribute('role', 'listitem');
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const label = document.createElement('span');
      label.textContent = hex(index);
      button.append(canvas, label);
      const subject = () => {
        const sprite = readSprites(this.gb.ppu.oam, this.gb.ppu.lcdc)[index];
        return { source: 'vram', tile: sprite.tile, context: { from: 'sprite', sprite } };
      };
      button.addEventListener('pointerenter', () => this.setHover(subject()));
      button.addEventListener('pointerleave', () => this.setHover(null));
      button.addEventListener('focus', () => this.setHover(subject()));
      button.addEventListener('blur', () => this.setHover(null));
      button.addEventListener('click', () => this.togglePin(subject()));
      grid.append(button);
      this.spriteCells.push({ button, canvas, ctx: canvas.getContext('2d'), height: 8 });
    }
  }

  bindScreen() {
    const root = this.screen.root;
    const update = (event) => {
      if (!this.emulator.loaded) return;
      const p = this.screen.locate(event);
      if (!p) { this.clearScreenHover(); return; }
      this.screenPointer = { x: p.x, y: p.y, background: event.altKey };
      this.updateScreenHover();
    };
    root.addEventListener('pointermove', update);
    root.addEventListener('pointerleave', () => this.clearScreenHover());
    root.addEventListener('click', (event) => {
      update(event);
      if (this.hovered && this.hovered.context.from === 'screen') this.togglePin(this.hovered);
    });
  }

  /** Re-picks under a stationary pointer, since the picture moves beneath it. */
  updateScreenHover() {
    const at = this.screenPointer;
    if (!at) return;
    const pick = this.screen.pick(this.gb.ppu, at.x, at.y, at.background);
    this.screenHover = pick;
    const tile = pick.layer === 'sprite' ? pick.sprite.tile : pick.layer === 'bg' ? pick.bg.tile : -1;
    this.hovered = tile < 0 ? null : { source: 'vram', tile, context: { from: 'screen', pick } };
  }

  clearScreenHover() {
    if (!this.screenPointer) return;
    this.screenPointer = null;
    this.screenHover = null;
    this.setHover(null);
  }

  bindInspector() {
    this.bindPref('insp-highlight', 'highlight');
    $('btn-unpin').addEventListener('click', () => this.unpin());
    $('btn-tile-png').addEventListener('click', () => {
      const subject = this.subject;
      if (!subject) return;
      const out = document.createElement('canvas');
      out.width = out.height = 128;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.inspCanvas, 0, 0, 128, 128);
      const name = subject.source === 'vram' ? `tile-${hex(subject.tile, 3)}` : `rom-${hex(subject.offset, 6)}`;
      out.toBlob((blob) => downloadBlob(blob, `${this.fileStem()}-${name}.png`), 'image/png');
    });
    $('btn-hd-tile-png').addEventListener('click', () => {
      const subject = this.subject;
      if (!subject || subject.source !== 'vram') return;
      const out = document.createElement('canvas');
      out.width = out.height = 128;
      const ctx = out.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.inspHdCanvas, 0, 0, 128, 128);
      out.toBlob((blob) => downloadBlob(blob, `${this.fileStem()}-tile-${hex(subject.tile, 3)}-hd.png`), 'image/png');
    });
  }

  fileStem() {
    return (this.emulator.romName || 'gameboy').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  }

  // --- Selection ----------------------------------------------------------------------

  setHover(subject) {
    this.hovered = subject;
    this.refresh(true);
  }

  togglePin(subject) {
    if (!subject) return;
    this.pinned = sameSubject(this.pinned, subject) ? null : subject;
    this.refresh(true);
  }

  unpin() {
    this.pinned = null;
    this.refresh(true);
  }

  /** VRAM tile to highlight on the screen and in the maps, or -1. */
  get highlightTile() {
    const subject = this.subject;
    return subject && subject.source === 'vram' && this.prefs.highlight ? subject.tile : -1;
  }

  // --- Drawing ------------------------------------------------------------------------

  /** @param {boolean} full also redraw the active view, inspector and register strip */
  refresh(full) {
    const ppu = this.gb.ppu;
    if (this.screenPointer) this.updateScreenHover();
    this.screen.drawOverlay(ppu, this.highlightTile, this.screenHover ? this.screenHover.box : null);
    this.drawReadout();
    if (!full) return;
    if (this.tab === 'tiles') this.drawTiles();
    else if (this.tab === 'maps') this.drawMap();
    else this.drawSprites();
    this.drawInspector();
    this.drawRegisters();
  }

  setText(id, text) {
    if (this.cache[id] === text) return;
    this.cache[id] = text;
    $(id).textContent = text;
  }

  tilePaletteValue() {
    const ppu = this.gb.ppu;
    switch (this.prefs.tilePalette) {
      case 'obp0': return ppu.obp0;
      case 'obp1': return ppu.obp1;
      case 'raw': return IDENTITY_PALETTE;
      default: return ppu.bgp;
    }
  }

  updateRowLabels() {
    const rows = [];
    for (let r = 0; r < SHEET_ROWS; r++) {
      rows.push(this.source === 'vram' ? hex(0x80 + r) : hex((this.romOffset >> 8) + r, 3));
    }
    // Video RAM tile data comes in three 128-tile blocks: mark where each starts.
    this.tileView.setLabels(null, rows, (i) => this.source === 'vram' && i % 8 === 0);
    if (this.gb.cart) {
      const bank = this.romOffset >> 14;
      const address = (this.romOffset & 0x3fff) + (bank ? 0x4000 : 0);
      $('rom-bank').value = String(bank);
      this.setText('rom-range', `$${hex(bank)}:${hex(address, 4)}  file $${hex(this.romOffset, 6)}`);
      this.setText('rom-align', `+${this.romOffset & 0x0f}`);
    }
  }

  drawTiles() {
    const view = this.tileView;
    const ppu = this.gb.ppu;
    const palette = this.tilePaletteValue();
    const useHd = Boolean(this.hdPack && this.showHd);
    view.setBackingScale(useHd ? HD_SCALE : 1);
    let usage = null;
    if (this.source === 'vram') {
      if (useHd) this.hdPack.renderHdVramSheet(ppu.vram, palette, this.colors, view.pixels);
      else renderTileSheet(ppu.vram, 0, VRAM_TILES, SHEET_COLUMNS, palette, this.colors, view.pixels);
      if (this.prefs.dimUnused) usage = tileUsage(ppu.vram, ppu.oam, ppu.lcdc);
    } else {
      const rom = this.gb.cart ? this.gb.cart.rom : new Uint8Array(0);
      const count = Math.max(0, Math.min(VRAM_TILES, Math.floor((rom.length - this.romOffset) / TILE_BYTES)));
      view.pixels.fill(WELL);
      if (useHd) this.hdPack.renderHdRomSheet(rom, this.romOffset, count, palette, this.colors, view.pixels);
      else renderTileSheet(rom, this.romOffset, count, SHEET_COLUMNS, palette, this.colors, view.pixels);
    }
    view.commit();

    view.clearOverlay();
    view.grid(8, GRID);
    if (this.source === 'vram') {
      const line = 1 / view.k;
      view.fill(0, 64, view.width, line, BLOCK_LINE);
      view.fill(0, 128, view.width, line, BLOCK_LINE);
    }
    if (usage) {
      for (let t = 0; t < VRAM_TILES; t++) {
        if (usage.bg[t] || usage.window[t] || usage.sprites[t]) continue;
        view.fill((t % SHEET_COLUMNS) * 8, ((t / SHEET_COLUMNS) | 0) * 8, 8, 8, DIM);
      }
    }
    const mark = (subject, color, thickness) => {
      if (!subject || subject.source !== this.source) return;
      const index = subject.source === 'vram' ? subject.tile : (subject.offset - this.romOffset) / TILE_BYTES;
      if (!Number.isInteger(index) || index < 0 || index >= VRAM_TILES) return;
      view.outline((index % SHEET_COLUMNS) * 8, ((index / SHEET_COLUMNS) | 0) * 8, 8, 8, color, thickness);
    };
    mark(this.pinned, SELECT, 3);
    mark(this.hovered, HOVER, 2);
  }

  drawMap() {
    const view = this.mapView;
    const ppu = this.gb.ppu;
    const lcdc = ppu.lcdc;
    const base = MAP_BASES[this.mapIndex];
    const lowTiles = (lcdc & 0x10) !== 0;
    const bgBase = lcdc & 0x08 ? 0x1c00 : 0x1800;
    const winBase = lcdc & 0x40 ? 0x1c00 : 0x1800;
    const windowOn = (lcdc & 0x21) === 0x21;
    const useHd = Boolean(this.hdPack && this.showHd);
    view.setBackingScale(useHd ? HD_SCALE : 1);
    if (useHd) {
      const isWinOnly = windowOn && base === winBase && base !== bgBase;
      this.hdPack.renderHdTilemap(ppu.vram, base, lowTiles, ppu.bgp, isWinOnly, this.colors, view.pixels);
    } else {
      renderTilemap(ppu.vram, base, lowTiles, ppu.bgp, this.colors, view.pixels);
    }
    view.commit();

    for (let i = 0; i < 2; i++) {
      const roles = [];
      if (MAP_BASES[i] === bgBase) roles.push('BG');
      if (MAP_BASES[i] === winBase && windowOn) roles.push('window');
      this.setText(`map-tag-${i}`, roles.join(' + '));
    }

    view.clearOverlay();
    if (this.prefs.mapGrid) view.grid(8, GRID);
    const tile = this.highlightTile;
    if (tile >= 0) {
      for (let cell = 0; cell < 1024; cell++) {
        if (tileNumber(ppu.vram[base + cell], lowTiles) !== tile) continue;
        view.outline((cell & 31) * 8, (cell >> 5) * 8, 8, 8, SELECT, 2);
      }
    }
    if (this.prefs.mapViewport) {
      if (base === bgBase) {
        // The background wraps around, so the screen area can split into four pieces.
        for (const [x, w] of wrap(ppu.scx, SCREEN_W)) {
          for (const [y, h] of wrap(ppu.scy, SCREEN_H)) view.outline(x, y, w, h, VIEWPORT, 2);
        }
      }
      if (base === winBase && windowOn && ppu.wx <= 166 && ppu.wy < SCREEN_H) {
        const w = Math.min(SCREEN_W, SCREEN_W - (ppu.wx - 7));
        view.outline(0, 0, w, SCREEN_H - ppu.wy, WINDOW_AREA, 2);
      }
    }
    const hovered = this.hovered;
    if (hovered && hovered.context.from === 'map') {
      view.outline(hovered.context.col * 8, hovered.context.row * 8, 8, 8, HOVER, 2);
    }
  }

  drawSprites() {
    const ppu = this.gb.ppu;
    const sprites = readSprites(ppu.oam, ppu.lcdc);
    const tile = this.highlightTile;
    const useHd = Boolean(this.hdPack && this.showHd);
    const k = useHd ? HD_SCALE : 1;
    let visible = 0;
    for (const sprite of sprites) {
      const cell = this.spriteCells[sprite.index];
      const cw = 8 * k, ch = sprite.height * k;
      if (cell.canvas.width !== cw || cell.canvas.height !== ch) {
        cell.height = sprite.height;
        cell.canvas.width = cw;
        cell.canvas.height = ch;
        cell.canvas.style.height = `${sprite.height * 4}px`;
      }
      if (!cell.image || cell.image.width !== cw || cell.image.height !== ch) {
        cell.image = cell.ctx.createImageData(cw, ch);
        cell.pixels = new Uint32Array(cell.image.data.buffer);
      }
      const palette = sprite.palette ? ppu.obp1 : ppu.obp0;
      if (useHd) this.hdPack.renderHdSprite(ppu.vram, sprite, palette, this.colors, cell.pixels);
      else renderSprite(ppu.vram, sprite, palette, this.colors, 0, cell.pixels);
      cell.ctx.putImageData(cell.image, 0, 0);
      if (sprite.onScreen) visible++;
      const selected = tile >= 0 && (sprite.tile === tile || (sprite.height === 16 && sprite.tile + 1 === tile));
      cell.button.classList.toggle('off', !sprite.onScreen);
      cell.button.classList.toggle('selected', selected);
      cell.button.hidden = this.prefs.hideOffscreen && !sprite.onScreen;
      const title = `Sprite ${sprite.index} at (${sprite.x}, ${sprite.y}), tile $${hex(sprite.tile)}`;
      if (cell.title !== title) { cell.title = title; cell.button.title = title; cell.button.setAttribute('aria-label', title); }
    }
    this.setText('sprite-summary',
      `${visible} of 40 sprites on screen · ${ppu.lcdc & 0x04 ? '8×16' : '8×8'}${ppu.lcdc & 0x02 ? '' : ' · sprites switched off'}`);
  }

  drawReadout() {
    const pick = this.screenHover;
    let text = '\u00a0';
    if (pick) {
      const parts = [`x ${pick.x}, y ${pick.y}`];
      if (pick.bg) parts.push(`${pick.bg.window ? 'window' : 'BG'} tile $${hex(pick.bg.tile, 3)} at $${hex(pick.bg.mapAddress, 4)}`);
      if (pick.sprite) parts.push(`sprite ${pick.sprite.index}${pick.sprite.hidden ? ' (behind)' : ''}`);
      text = parts.join(' · ');
    } else if (this.emulator.loaded) {
      text = 'Click a pixel to pin its tile';
    }
    this.setText('lcd-readout', text);
  }

  drawInspector() {
    const subject = this.subject;
    const empty = !subject || !this.gb.cart;
    if (this.cache.inspEmpty !== empty) {
      this.cache.inspEmpty = empty;
      $('inspector-empty').hidden = !empty;
      $('inspector-body').hidden = empty;
    }
    if (empty) return;

    const ppu = this.gb.ppu;
    const isVram = subject.source === 'vram';
    const bytes = isVram ? ppu.vram : this.gb.cart.rom;
    const offset = isVram ? subject.tile * TILE_BYTES : subject.offset;

    // Picture and bytes.
    let palette = this.tilePaletteValue();
    const context = subject.context;
    if (context.from === 'sprite') palette = context.sprite.palette ? ppu.obp1 : ppu.obp0;
    else if (context.from === 'map' || context.from === 'screen') palette = ppu.bgp;
    if (context.from === 'screen' && context.pick.layer === 'sprite') {
      palette = ppu.oam[context.pick.sprite.index * 4 + 3] & 0x10 ? ppu.obp1 : ppu.obp0;
    }
    renderTileSheet(bytes, offset, 1, 1, palette, this.colors, this.inspPixels);
    this.inspCtx.putImageData(this.inspImage, 0, 0);
    const hdRgba = this.hdPack ? this.hdPack.peekUpgradedRgba(bytes, isVram ? subject.tile : subject.offset, ppu, !isVram) : null;
    $('insp-hd').hidden = !hdRgba;
    if (hdRgba) {
      this.inspHdImage.data.set(hdRgba);
      this.inspHdCtx.putImageData(this.inspHdImage, 0, 0);
    }
    let rows = '';
    for (let r = 0; r < 8; r++) rows += `${hex(bytes[offset + r * 2] ?? 0)} ${hex(bytes[offset + r * 2 + 1] ?? 0)}\n`;
    if (this.cache.rows !== rows) {
      this.cache.rows = rows;
      $('insp-rows').replaceChildren(...rows.trim().split('\n').map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }));
    }

    // Title, context and facts.
    $('insp-pin').hidden = !sameSubject(subject, this.pinned);
    $('btn-unpin').hidden = !this.pinned;
    const facts = [];
    if (isVram) {
      const tile = subject.tile;
      const block = tile >> 7;
      this.setText('insp-title', `Tile $${hex(tile, 3)}`);
      facts.push(['Address', `$${hex(tileAddress(tile), 4)}–$${hex(tileAddress(tile) + 15, 4)}`]);
      facts.push(['Tile ID', `$${hex(tile & 0xff)}`]);
      facts.push(['Block', `${block}`]);
    } else {
      const bank = subject.offset >> 14;
      this.setText('insp-title', `ROM $${hex(subject.offset, 6)}`);
      facts.push(['Bank', `$${hex(bank)}`]);
      facts.push(['Address', `$${hex((subject.offset & 0x3fff) + (bank ? 0x4000 : 0), 4)}`]);
      facts.push(['File offset', `${subject.offset}`]);
    }
    this.setText('insp-context', this.describeContext(subject));
    const factsKey = facts.map((f) => f.join('=')).join('|');
    if (this.cache.facts !== factsKey) {
      this.cache.facts = factsKey;
      $('insp-facts').replaceChildren(...facts.flatMap(([name, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = name;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }));
    }

    // Where the tile is in use right now.
    const chips = [];
    if (isVram) {
      const usage = tileUsage(ppu.vram, ppu.oam, ppu.lcdc);
      const tile = subject.tile;
      let pixels = 0;
      for (let i = 0; i < SCREEN_W * SCREEN_H; i++) if (visibleTileAt(ppu, i) === tile) pixels++;
      chips.push(['BG map', usage.bg[tile]], ['Window map', usage.window[tile]],
        ['Sprites', usage.sprites[tile]], ['On screen', pixels, 'px']);
    }
    const chipsKey = chips.map((c) => c.join(':')).join('|');
    if (this.cache.chips !== chipsKey) {
      this.cache.chips = chipsKey;
      $('insp-usage').replaceChildren(...chips.map(([name, count, unit]) => {
        const chip = document.createElement('span');
        chip.className = count ? 'chip on' : 'chip';
        const value = document.createElement('b');
        value.textContent = unit ? `${count} ${unit}` : `×${count}`;
        chip.append(`${name} `, value);
        return chip;
      }));
    }
    $('insp-highlight').closest('label').hidden = !isVram;
  }

  describeContext(subject) {
    const context = subject.context;
    if (subject.source === 'rom') return 'Cartridge bytes read as a tile. If the picture looks like noise, the data here is code or compressed graphics.';
    if (context.from === 'map') {
      return `Map cell (${context.col}, ${context.row}) at $${hex(context.address, 4)} holds ID $${hex(context.entry)}.`;
    }
    if (context.from === 'sprite') {
      const s = context.sprite;
      const flags = [s.flipX && 'flip X', s.flipY && 'flip Y', s.behind && 'behind BG', `OBP${s.palette}`].filter(Boolean);
      return `Sprite ${s.index} at (${s.x}, ${s.y}), ${s.height === 16 ? `tiles $${hex(s.tile)}+$${hex(s.tile + 1)}` : `tile $${hex(s.tile)}`}: ${flags.join(', ')}.`;
    }
    if (context.from === 'screen') {
      const pick = context.pick;
      if (pick.layer === 'sprite') {
        return `Screen (${pick.x}, ${pick.y}): sprite ${pick.sprite.index}. Hold Alt to look at the background behind it.`;
      }
      return `Screen (${pick.x}, ${pick.y}): ${pick.bg.window ? 'window' : 'background'} cell (${pick.bg.col}, ${pick.bg.row}) at $${hex(pick.bg.mapAddress, 4)}.`;
    }
    return `Block ${subject.tile >> 7}: ${BLOCKS[subject.tile >> 7]}.`;
  }

  drawRegisters() {
    const ppu = this.gb.ppu;
    const lcdc = ppu.lcdc;
    const key = [lcdc, ppu.scx, ppu.scy, ppu.wx, ppu.wy, ppu.bgp, ppu.obp0, ppu.obp1, ppu.lyc].join(',');
    if (this.cache.registers !== key) {
      this.cache.registers = key;
      this.buildRegisters();
    }
    this.setText('ppu-ly', hex(ppu.ly));
  }

  buildRegisters() {
    const ppu = this.gb.ppu;
    const lcdc = ppu.lcdc;
    const flags = [
      [lcdc & 0x80, 'LCD on', 'LCD off'],
      [lcdc & 0x01, 'BG on', 'BG off'],
      [lcdc & 0x20, 'Window on', 'Window off'],
      [lcdc & 0x02, lcdc & 0x04 ? 'Sprites 8×16' : 'Sprites 8×8', 'Sprites off'],
      [true, `Tile data $${lcdc & 0x10 ? '8000' : '8800'}`],
      [true, `BG map $${lcdc & 0x08 ? '9C00' : '9800'}`],
      [true, `Window map $${lcdc & 0x40 ? '9C00' : '9800'}`],
    ];
    $('ppu-flags').replaceChildren(...flags.map(([on, yes, no]) => {
      const chip = document.createElement('span');
      chip.className = on ? 'chip on' : 'chip';
      chip.textContent = on ? yes : no;
      return chip;
    }));

    const values = [['LCDC', lcdc], ['SCX', ppu.scx], ['SCY', ppu.scy], ['WX', ppu.wx], ['WY', ppu.wy], ['LYC', ppu.lyc], ['LY', null]];
    $('ppu-values').replaceChildren(...values.map(([name, value]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = name;
      const dd = document.createElement('dd');
      if (value === null) dd.id = 'ppu-ly'; else dd.textContent = hex(value);
      div.append(dt, dd);
      return div;
    }));
    this.cache['ppu-ly'] = null; // the LY cell was just recreated

    $('ppu-palettes').replaceChildren(...[['BGP', ppu.bgp], ['OBP0', ppu.obp0], ['OBP1', ppu.obp1]].map(([name, value]) => {
      const el = document.createElement('span');
      el.className = 'pal';
      el.title = `${name} = $${hex(value)}: colour numbers 0-3 map to these shades`;
      const strip = document.createElement('i');
      for (let c = 0; c < 4; c++) {
        const b = document.createElement('b');
        b.style.background = cssColor(this.colors[applyPalette(value, c)]);
        strip.append(b);
      }
      el.append(name, strip);
      return el;
    }));
  }
}

function sameSubject(a, b) {
  return !!a && !!b && a.source === b.source && a.tile === b.tile && a.offset === b.offset;
}

/** Splits a span starting at `start` on a 256-wide wrapping axis into [start, length] pieces. */
function wrap(start, length) {
  return start + length <= 256 ? [[start, length]] : [[start, 256 - start], [0, start + length - 256]];
}

function cssColor(packed) {
  return `rgb(${packed & 0xff}, ${(packed >> 8) & 0xff}, ${(packed >> 16) & 0xff})`;
}
