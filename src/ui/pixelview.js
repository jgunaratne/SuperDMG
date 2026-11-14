// A pixel-art canvas with rulers and a crisp overlay.
//
// Two stacked canvases: the bottom one holds the artwork at its native resolution and
// is scaled up by CSS with nearest-neighbour filtering; the top one is sized in device
// pixels so outlines and grid lines stay sharp at any scale.

export class PixelView {
  /**
   * @param {HTMLElement} root container, emptied and filled by this view
   * @param {{width: number, height: number, scale: number, cell?: number,
   *     columnLabels?: string[], rowLabels?: string[]}} options
   *     `cell` is the size in source pixels of one ruler division.
   */
  constructor(root, options) {
    this.root = root;
    this.width = options.width;
    this.height = options.height;
    this.scale = options.scale;
    this.cell = options.cell || 8;

    this.topRuler = document.createElement('div');
    this.topRuler.className = 'ruler ruler-top';
    this.leftRuler = document.createElement('div');
    this.leftRuler.className = 'ruler ruler-left';
    this.stack = document.createElement('div');
    this.stack.className = 'stack';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.over = document.createElement('canvas');
    this.over.className = 'over';
    this.stack.append(this.canvas, this.over);
    root.replaceChildren(this.topRuler, this.leftRuler, this.stack);

    const cssWidth = this.width * this.scale;
    const cssHeight = this.height * this.scale;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.stack.style.width = `${cssWidth}px`;
    this.stack.style.height = `${cssHeight}px`;

    this.ctx = this.canvas.getContext('2d');
    this.backingScale = 1;
    this.image = this.ctx.createImageData(this.width, this.height);
    /** Packed pixels of the artwork; call commit() after changing them. */
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.overCtx = this.over.getContext('2d');
    this.k = 1;
    this.setLabels(options.columnLabels || [], options.rowLabels || []);
    this.syncOverlay();
  }

  /** Changes the pixel density of the artwork backing buffer without altering logical coordinates. */
  setBackingScale(bs) {
    if (this.backingScale === bs) return;
    this.backingScale = bs;
    this.canvas.width = this.width * bs;
    this.canvas.height = this.height * bs;
    this.image = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  setLabels(columns, rows, emphasise = () => false) {
    const size = this.cell * this.scale;
    const fill = (ruler, labels, style) => {
      ruler.replaceChildren(...labels.map((text, i) => {
        const span = document.createElement('span');
        span.textContent = text;
        span.style[style] = `${size}px`;
        if (emphasise(i)) span.className = 'block-start';
        return span;
      }));
    };
    if (columns) fill(this.topRuler, columns, 'width');
    if (rows) fill(this.leftRuler, rows, 'height');
  }

  commit() {
    this.ctx.putImageData(this.image, 0, 0);
  }

  /** Keeps the overlay's backing store matched to the display's pixel density. */
  syncOverlay() {
    const k = this.scale * (window.devicePixelRatio || 1);
    const w = Math.round(this.width * k);
    const h = Math.round(this.height * k);
    if (this.over.width !== w || this.over.height !== h) {
      this.over.width = w;
      this.over.height = h;
    }
    this.k = k;
  }

  clearOverlay() {
    this.syncOverlay();
    this.overCtx.clearRect(0, 0, this.over.width, this.over.height);
  }

  /** Filled rectangle, in source-pixel coordinates. */
  fill(x, y, w, h, color) {
    const k = this.k;
    const x0 = Math.round(x * k), y0 = Math.round(y * k);
    this.overCtx.fillStyle = color;
    this.overCtx.fillRect(x0, y0, Math.round((x + w) * k) - x0, Math.round((y + h) * k) - y0);
  }

  /** Rectangle outline drawn inside the given bounds, `thickness` in CSS pixels. */
  outline(x, y, w, h, color, thickness = 2) {
    const k = this.k;
    const t = Math.max(1, Math.round(thickness * (window.devicePixelRatio || 1)));
    const x0 = Math.round(x * k), y0 = Math.round(y * k);
    const x1 = Math.round((x + w) * k), y1 = Math.round((y + h) * k);
    const ctx = this.overCtx;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, t);
    ctx.fillRect(x0, y1 - t, x1 - x0, t);
    ctx.fillRect(x0, y0 + t, t, y1 - y0 - 2 * t);
    ctx.fillRect(x1 - t, y0 + t, t, y1 - y0 - 2 * t);
  }

  /** One-device-pixel grid lines every `step` source pixels. */
  grid(step, color, majorEvery = 0, majorColor = color) {
    const ctx = this.overCtx;
    const k = this.k;
    for (let x = step; x < this.width; x += step) {
      ctx.fillStyle = majorEvery && x % majorEvery === 0 ? majorColor : color;
      ctx.fillRect(Math.round(x * k), 0, 1, this.over.height);
    }
    for (let y = step; y < this.height; y += step) {
      ctx.fillStyle = majorEvery && y % majorEvery === 0 ? majorColor : color;
      ctx.fillRect(0, Math.round(y * k), this.over.width, 1);
    }
  }

  /** Source-pixel coordinates under a pointer event, or null if outside. */
  locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * this.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * this.height);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return { x, y };
  }

  /** Renders the artwork enlarged to a PNG blob (for downloads). */
  toBlob(scale = 4) {
    const out = document.createElement('canvas');
    out.width = this.width * scale;
    out.height = this.height * scale;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, 0, 0, out.width, out.height);
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
