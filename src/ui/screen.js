// The game screen: draws the emulator's frame (either classic 160x144 4-shade LCD or
// 640x576 full-color Advanced Tile Mode), and layers on top of it the explorer's
// highlights (where a tile appears) and the box around whatever is under the pointer.

import { SCREEN_W, SCREEN_H } from '../core/ppu.js';
import { describePixel, visibleTileAt } from '../core/tiles.js';
import { HD_SCREEN_W, HD_SCREEN_H } from '../core/hdtiles.js';

const HIGHLIGHT = 'rgba(255, 45, 135, 0.55)';
const HOVER = '#ffffff';

export class Screen {
  /**
   * @param {HTMLElement} root the .lcd element
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLCanvasElement} overlay
   */
  constructor(root, canvas, overlay) {
    this.root = root;
    this.canvas = canvas;
    this.overlay = overlay;
    this.ctx = canvas.getContext('2d');
    this.overCtx = overlay.getContext('2d');
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.hdImage = null;
    this.hdPixels = null;
    this.hdActive = false;
    this.colors = new Uint32Array(4);
    this.scale = 3;
  }

  setColors(colors) { this.colors = colors; }

  /** Integer scale factor; also sizes the overlay in device pixels. */
  setScale(scale) {
    this.scale = scale;
    document.documentElement.style.setProperty('--lcd-scale', String(scale));
  }

  setCanvasResolution(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  syncOverlay() {
    const k = this.scale * (window.devicePixelRatio || 1);
    const w = Math.round(SCREEN_W * k);
    const h = Math.round(SCREEN_H * k);
    if (this.overlay.width !== w || this.overlay.height !== h) {
      this.overlay.width = w;
      this.overlay.height = h;
    }
    return k;
  }

  /** @param {Uint8Array} shades the PPU's display buffer */
  draw(shades) {
    this.hdActive = false;
    this.root.classList.remove('hd-active');
    this.setCanvasResolution(SCREEN_W, SCREEN_H);
    const { pixels, colors } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = colors[shades[i]];
    this.ctx.putImageData(this.image, 0, 0);
  }

  /**
   * Draws a 640x576 full-color high-resolution frame using an upgraded HD tile pack.
   * @param {import('../core/ppu.js').PPU} ppu
   * @param {import('../core/hdtiles.js').HdTilePack} hdPack
   */
  drawHd(ppu, hdPack) {
    this.hdActive = true;
    this.root.classList.add('hd-active');
    this.setCanvasResolution(HD_SCREEN_W, HD_SCREEN_H);
    if (!this.hdImage) {
      this.hdImage = this.ctx.createImageData(HD_SCREEN_W, HD_SCREEN_H);
      this.hdPixels = new Uint32Array(this.hdImage.data.buffer);
    }
    hdPack.renderHdFrame(ppu, this.colors, this.hdPixels);
    this.ctx.putImageData(this.hdImage, 0, 0);
  }

  /**
   * @param {import('../core/ppu.js').PPU} ppu
   * @param {number} tile VRAM tile number to highlight wherever it is visible, or -1
   * @param {?{x: number, y: number, w: number, h: number}} box outline to draw
   */
  drawOverlay(ppu, tile, box) {
    const k = this.syncOverlay();
    const ctx = this.overCtx;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (tile >= 0) {
      ctx.fillStyle = HIGHLIGHT;
      for (let y = 0; y < SCREEN_H; y++) {
        const row = y * SCREEN_W;
        const y0 = Math.round(y * k);
        const h = Math.round((y + 1) * k) - y0;
        let start = -1;
        for (let x = 0; x <= SCREEN_W; x++) {
          const hit = x < SCREEN_W && visibleTileAt(ppu, row + x) === tile;
          if (hit && start < 0) start = x;
          else if (!hit && start >= 0) {
            const x0 = Math.round(start * k);
            ctx.fillRect(x0, y0, Math.round(x * k) - x0, h);
            start = -1;
          }
        }
      }
    }
    if (box) {
      const t = Math.max(1, Math.round(1.5 * (window.devicePixelRatio || 1)));
      const x0 = Math.round(box.x * k), y0 = Math.round(box.y * k);
      const x1 = Math.round((box.x + box.w) * k), y1 = Math.round((box.y + box.h) * k);
      // Dark halo then light line, so the box shows on any colour.
      for (const [inset, color] of [[0, 'rgba(0, 0, 0, 0.6)'], [t, HOVER]]) {
        ctx.fillStyle = color;
        const a = x0 - 2 * t + inset, b = y0 - 2 * t + inset;
        const w = x1 - x0 + 4 * t - 2 * inset, h = y1 - y0 + 4 * t - 2 * inset;
        ctx.fillRect(a, b, w, t);
        ctx.fillRect(a, b + h - t, w, t);
        ctx.fillRect(a, b + t, t, h - 2 * t);
        ctx.fillRect(a + w - t, b + t, t, h - 2 * t);
      }
    }
  }

  /** Screen pixel under a pointer event, or null. */
  locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * SCREEN_W);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * SCREEN_H);
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return null;
    return { x, y };
  }

  /**
   * What is under a screen pixel, plus the on-screen bounds of that tile or sprite.
   * @param {boolean} background prefer the background even if a sprite is on top
   */
  pick(ppu, x, y, background = false) {
    const info = describePixel(ppu, x, y);
    const useSprite = info.sprite && !info.sprite.hidden && !background;
    let box = null;
    if (useSprite) {
      const base = info.sprite.index * 4;
      box = { x: ppu.oam[base + 1] - 8, y: ppu.oam[base] - 16, w: 8, h: ppu.lcdc & 0x04 ? 16 : 8 };
    } else if (info.bg) {
      // Grow outwards while the neighbouring pixels come from the same map cell.
      const key = ppu.bgInfo[y * SCREEN_W + x];
      let x0 = x, x1 = x, y0 = y, y1 = y;
      while (x0 > 0 && ppu.bgInfo[y * SCREEN_W + x0 - 1] === key) x0--;
      while (x1 < SCREEN_W - 1 && ppu.bgInfo[y * SCREEN_W + x1 + 1] === key) x1++;
      while (y0 > 0 && ppu.bgInfo[(y0 - 1) * SCREEN_W + x] === key) y0--;
      while (y1 < SCREEN_H - 1 && ppu.bgInfo[(y1 + 1) * SCREEN_W + x] === key) y1++;
      box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    return { ...info, layer: useSprite ? 'sprite' : info.bg ? 'bg' : null, box };
  }
}
