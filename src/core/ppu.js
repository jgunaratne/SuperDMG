// Picture processing unit: LCD timing, STAT/LY registers and the scanline renderer.
//
// Timing is tracked per dot (4 dots per machine cycle, 456 dots per line, 154 lines per
// frame). Pixels are produced a scanline at a time, but lazily: if the game writes a
// video register in the middle of the drawing period, everything left of the beam is
// rendered with the old value first. That keeps mid-line palette, scroll and window
// tricks working without a full pixel-FIFO model.
//
// Besides the picture, the renderer records where every pixel came from (which tile,
// which tilemap cell, which sprite). The tile explorer uses that to answer "what is
// this pixel?" and "where is this tile on screen?" exactly, even when the game changes
// scroll or tile addressing halfway down the frame.

export const SCREEN_W = 160;
export const SCREEN_H = 144;

const LINE_DOTS = 456;
const FRAME_DOTS = LINE_DOTS * 154;

// Line timing is a short script per line: [dot, action] pairs in dot order. Dot 0 is
// the moment LY takes its new value. The offsets are the ones measured on hardware by
// the GBMicrotest and Mooneye suites; several things famously do not happen on round
// numbers (STAT only shows mode 2 a dot after the line starts, video RAM locks a few
// dots before STAT shows mode 3, and so on).
const A_OAM_MODE = 0;   // STAT shows mode 2, LYC comparison resumes
const A_VRAM_LOCK = 1;  // video RAM stops being readable
const A_DRAW = 2;       // STAT shows mode 3, pixels start
const A_HBLANK = 3;     // pixels done, STAT shows mode 0 (dot depends on the line)
const A_HBLANK_IRQ = 11; // the HBlank interrupt source follows one dot later
const A_LYC_OFF = 4;    // LYC comparison pauses ahead of an LY change
const A_LY_NEXT = 5;    // LY takes the next line number slightly early
const A_LYC_ON = 6;     // LYC comparison resumes
const A_VBLANK = 7;     // STAT shows mode 1, VBlank interrupt
const A_LY_WRAP = 8;    // line 153: LY reads 0, but LYC still compares against 153
const A_LYC_ZERO = 9;   // line 153: LYC now compares against 0
const A_NEXT_LINE = 10;

const DRAW_DOT = 81;

const SCRIPT_VISIBLE = [
  [1, A_OAM_MODE], [77, A_VRAM_LOCK], [DRAW_DOT, A_DRAW], [0, A_HBLANK], [0, A_HBLANK_IRQ], [LINE_DOTS, A_NEXT_LINE]];
const SCRIPT_LAST_VISIBLE = [
  [1, A_OAM_MODE], [77, A_VRAM_LOCK], [DRAW_DOT, A_DRAW], [0, A_HBLANK], [0, A_HBLANK_IRQ],
  [453, A_LYC_OFF], [455, A_LY_NEXT], [LINE_DOTS, A_NEXT_LINE]];
const SCRIPT_VBLANK_FIRST = [
  [1, A_LYC_ON], [2, A_VBLANK], [453, A_LYC_OFF], [455, A_LY_NEXT], [LINE_DOTS, A_NEXT_LINE]];
const SCRIPT_VBLANK = [
  [1, A_LYC_ON], [453, A_LYC_OFF], [455, A_LY_NEXT], [LINE_DOTS, A_NEXT_LINE]];
const SCRIPT_VBLANK_LAST = [
  [3, A_LY_WRAP], [5, A_LYC_OFF], [9, A_LYC_ZERO], [LINE_DOTS, A_NEXT_LINE]];
// First line after the LCD is switched on: no OAM scan phase is reported.
const SCRIPT_LCD_ON = [
  [DRAW_DOT, A_DRAW], [0, A_HBLANK], [0, A_HBLANK_IRQ], [LINE_DOTS, A_NEXT_LINE]];
const LCD_ON_DOT = 4;

// Layout of the per-pixel source records. See PPU.bgInfo / PPU.objInfo.
export const INFO_VALID = 1 << 24;
export const INFO_TILE_MASK = 0x1ff;      // tile number 0-383 (index into VRAM tile data)
export const INFO_WINDOW = 1 << 9;        // bgInfo: pixel came from the window layer
export const INFO_MAP_SHIFT = 10;         // bgInfo: 11-bit offset into $9800-$9FFF
export const INFO_MAP_MASK = 0x7ff;
export const INFO_OAM_SHIFT = 10;         // objInfo: OAM entry 0-39
export const INFO_OAM_MASK = 0x3f;
export const INFO_OBJ_HIDDEN = 1 << 16;   // objInfo: sprite pixel lost to the background

export class PPU {
  constructor(gb) {
    this.gb = gb;
    this.vram = new Uint8Array(0x2000);
    this.oam = new Uint8Array(0xa0);
    /** Shades (0 = lightest .. 3 = darkest) of the frame being drawn. */
    this.frame = new Uint8Array(SCREEN_W * SCREEN_H);
    /** Shades of the last completed frame; this is what a front end should show. */
    this.display = new Uint8Array(SCREEN_W * SCREEN_H);
    /** Per pixel: background/window tile and map cell that produced it. */
    this.bgInfo = new Uint32Array(SCREEN_W * SCREEN_H);
    /** Per pixel: sprite covering it (if any), whether or not it won priority. */
    this.objInfo = new Uint32Array(SCREEN_W * SCREEN_H);
    /** Per pixel: (row << 3) | col within the background/window 8x8 tile. */
    this.bgPix = new Uint8Array(SCREEN_W * SCREEN_H);
    /** Per pixel: ((attr & 0x60) << 1) | (inTileRow << 3) | inTileCol for the sprite. */
    this.objPix = new Uint8Array(SCREEN_W * SCREEN_H);

    this.lineSprites = new Uint8Array(10);
    this.objColor = new Uint8Array(SCREEN_W);
    this.objAttr = new Uint8Array(SCREEN_W);
    this.objMeta = new Uint32Array(SCREEN_W);
    this.lineObjPix = new Uint8Array(SCREEN_W);
    this.reset();
  }

  reset() {
    this.vram.fill(0);
    this.oam.fill(0);
    this.frame.fill(0);
    this.display.fill(0);
    this.bgInfo.fill(0);
    this.objInfo.fill(0);
    this.bgPix.fill(0);
    this.objPix.fill(0);

    this.lcdc = 0;
    this.stat = 0; // interrupt enable bits 3-6 only
    this.scy = 0; this.scx = 0;
    this.ly = 0; this.lyc = 0;
    this.bgp = 0; this.obp0 = 0; this.obp1 = 0;
    this.wy = 0; this.wx = 0;

    this.line = 0;          // line being processed, 0-153
    this.dot = 0;           // position within the line, 0-455
    this.subDot = 3;
    this.mode = 0;          // mode shown in STAT
    this.irqMode = -1;      // mode seen by the STAT interrupt logic (can lead STAT)
    this.cmpLy = 0;         // value LYC is compared with; -1 while comparison is paused
    this.lycMatch = false;  // STAT bit 2
    this.lycIrq = false;    // LYC interrupt source (survives paused comparison)
    this.statLine = false;  // level of the combined STAT interrupt signal
    this.oamLocked = false; // CPU reads of OAM return $FF
    this.oamWriteLocked = false;
    this.vramLocked = false;
    this.vramWriteLocked = false;
    this.hblankDot = 0;
    this.pixelDot = DRAW_DOT + 13;
    this.setScript(SCRIPT_VBLANK);

    this.lineSpriteCount = 0;
    this.renderX = 0;       // pixels of the current line already rendered
    this.winLine = 0;       // window's own line counter
    this.winOnLine = false; // window drew something on the current line
    this.wyTriggered = false;

    this.frameReady = false;
    this.frameCount = 0;
    this.skipFrame = false; // the first frame after LCD-on is never shown
    this.offDots = 0;       // frame pacing while the LCD is off
  }

  /**
   * The state the boot ROM leaves behind when it jumps to the cartridge: LCD on and
   * 60 dots from the end of the last VBlank line.
   */
  enterBootState() {
    this.lcdc = 0x91;
    this.bgp = 0xfc;
    this.obp0 = 0xff;
    this.obp1 = 0xff;
    this.line = 153;
    this.dot = 396;
    this.ly = 0;
    this.mode = 1;
    this.irqMode = 1;
    this.cmpLy = 0;
    this.lycMatch = true;
    this.lycIrq = true;
    this.setScript(SCRIPT_VBLANK_LAST);
    while (this.nextEvent < this.dot) this.advanceScript();
  }

  // --- Timing -----------------------------------------------------------------------

  /** Advances one machine cycle (four dots). */
  tick() {
    if (!(this.lcdc & 0x80)) {
      // No video timing while the LCD is off, but keep handing out (blank) frames at
      // the usual rate so the front end keeps its rhythm.
      this.offDots += 4;
      if (this.offDots >= FRAME_DOTS) {
        this.offDots -= FRAME_DOTS;
        this.frameReady = true;
      }
      return;
    }
    if (this.dot + 4 < this.nextEvent) {
      this.dot += 4;
      return;
    }
    for (let i = 0; i < 4; i++) {
      this.subDot = i; // position within the machine cycle, for interrupt latency
      if (++this.dot === this.nextEvent) this.runAction(this.script[this.scriptPos][1]);
    }
  }

  setScript(script) {
    this.script = script;
    this.scriptPos = 0;
    this.nextEvent = script[0][0];
  }

  advanceScript() {
    const entry = this.script[++this.scriptPos];
    const action = entry[1];
    this.nextEvent = action === A_HBLANK ? this.hblankDot
      : action === A_HBLANK_IRQ ? this.hblankDot + 1 : entry[0];
  }

  runAction(action) {
    switch (action) {
      case A_OAM_MODE:
        this.mode = 2;
        this.oamWriteLocked = true;
        this.cmpLy = this.line;
        if (this.line === 0) this.irqMode = 2; // line 0's OAM interrupt is not early
        this.updateStat();
        this.irqMode = -1; // the OAM source is only a pulse
        this.updateStat();
        this.advanceScript();
        break;
      case A_VRAM_LOCK:
        this.vramLocked = true;
        this.oamWriteLocked = false; // OAM briefly accepts writes just before drawing
        this.advanceScript();
        break;
      case A_DRAW:
        this.startDrawing();
        break;
      case A_HBLANK:
        this.startHBlank();
        break;
      case A_HBLANK_IRQ:
        this.irqMode = 0;
        this.updateStat();
        this.advanceScript();
        break;
      case A_LYC_OFF:
        this.cmpLy = -1;
        this.updateStat();
        this.advanceScript();
        break;
      case A_LY_NEXT:
        this.ly = this.line + 1;
        // The OAM-scan interrupt source also fires as VBlank begins.
        if (this.ly === SCREEN_H && (this.stat & 0x20) && !this.statLine) this.raiseStat();
        this.advanceScript();
        break;
      case A_LYC_ON:
        this.cmpLy = this.line;
        this.updateStat();
        this.advanceScript();
        break;
      case A_VBLANK:
        this.mode = 1;
        this.irqMode = 1;
        this.gb.iflag |= 0x01;
        if (this.subDot >= 2) this.gb.lateIrq |= 0x01;
        this.presentFrame();
        this.updateStat();
        this.advanceScript();
        break;
      case A_LY_WRAP:
        this.ly = 0;
        this.cmpLy = 153;
        this.updateStat();
        this.advanceScript();
        break;
      case A_LYC_ZERO:
        this.cmpLy = 0;
        this.updateStat();
        this.advanceScript();
        break;
      default:
        this.startLine();
    }
  }

  startLine() {
    this.dot = 0;
    this.line = this.line === 153 ? 0 : this.line + 1;
    const line = this.line;
    if (line < SCREEN_H) {
      if (line === 0) {
        this.winLine = 0;
        this.wyTriggered = false;
      } else {
        this.ly = line;
        this.cmpLy = -1;
        this.irqMode = 2; // the OAM interrupt leads the visible mode change by a dot
      }
      this.mode = 0; // STAT keeps showing mode 0 for one more dot
      if (line === 0) this.irqMode = 0;
      this.oamLocked = true; // reads only; writes still land for one more dot
      this.beginLine();
      this.setScript(line === SCREEN_H - 1 ? SCRIPT_LAST_VISIBLE : SCRIPT_VISIBLE);
      this.updateStat();
    } else if (line === SCREEN_H) {
      this.setScript(SCRIPT_VBLANK_FIRST);
    } else if (line === 153) {
      this.setScript(SCRIPT_VBLANK_LAST);
    } else {
      this.setScript(SCRIPT_VBLANK);
    }
  }

  beginLine() {
    this.renderX = 0;
    this.winOnLine = false;
    if ((this.lcdc & 0x20) && this.wy === this.line) this.wyTriggered = true;
  }

  startDrawing() {
    this.scanOam();
    this.buildObjLine();
    this.pixelDot = DRAW_DOT + 13 + (this.scx & 7); // dot at which pixel 0 is output
    this.mode = 3;
    this.irqMode = 3;
    this.oamLocked = true;
    this.oamWriteLocked = true;
    this.vramLocked = true;
    this.vramWriteLocked = true;
    // The line after LCD-on reaches HBlank two dots later than a regular line.
    this.hblankDot = DRAW_DOT + this.drawingLength() + (this.script === SCRIPT_LCD_ON ? 2 : 0);
    this.advanceScript();
    this.updateStat();
  }

  startHBlank() {
    this.renderTo(SCREEN_W);
    if (this.winOnLine) this.winLine++;
    this.mode = 0;
    this.oamLocked = false;
    this.oamWriteLocked = false;
    this.vramLocked = false;
    this.vramWriteLocked = false;
    this.advanceScript();
  }

  presentFrame() {
    if (this.skipFrame) this.skipFrame = false;
    else this.display.set(this.frame);
    this.frameReady = true;
    this.frameCount++;
  }

  /**
   * Length of the drawing period for the current line. The base is 172 dots; fine
   * scrolling, the window and every sprite on the line stall the pixel pipeline.
   */
  drawingLength() {
    const lcdc = this.lcdc;
    const scx = this.scx;
    let length = 172 + (scx & 7);
    const winX = this.wx - 7;
    const window = (lcdc & 0x21) === 0x21 && this.wyTriggered && this.wx <= 166;
    if (window) length += 6;
    const count = this.lineSpriteCount;
    if ((lcdc & 0x02) && count) {
      // Each sprite costs 6 dots, plus up to 5 more the first time the background
      // tile under its left edge has to be fetched again. Sprites are sorted by X, so
      // sprites sharing a tile are adjacent.
      const oam = this.oam;
      let lastTile = -1000;
      for (let i = 0; i < count; i++) {
        const x = oam[(this.lineSprites[i] << 2) + 1];
        if (x >= 168) continue;
        const left = x - 8;
        const inWindow = window && left >= winX;
        const px = inWindow ? left - winX : left + scx;
        const tile = (px >> 3) + (inWindow ? 0x200 : 0);
        if (tile !== lastTile) {
          lastTile = tile;
          const extra = x === 0 ? 5 : 5 - (px & 7);
          if (extra > 0) length += extra;
        }
        length += 6;
      }
    }
    return length;
  }

  // --- STAT / LYC -------------------------------------------------------------------

  raiseStat() {
    this.gb.iflag |= 0x02;
    if (this.subDot >= 2) this.gb.lateIrq |= 0x02;
  }

  /** Recomputes the STAT interrupt signal; the interrupt fires on its rising edge. */
  updateStat() {
    if (!(this.lcdc & 0x80)) return;
    // The LYC flag drops whenever the comparison is paused, but the interrupt source
    // remembers the last real comparison.
    if (this.cmpLy === this.lyc) {
      this.lycMatch = true;
      this.lycIrq = true;
    } else {
      this.lycMatch = false;
      if (this.cmpLy !== -1) this.lycIrq = false;
    }
    const stat = this.stat;
    const mode = this.irqMode;
    const level = ((stat & 0x40) !== 0 && this.lycIrq) ||
        ((stat & 0x08) !== 0 && mode === 0) ||
        ((stat & 0x10) !== 0 && mode === 1) ||
        ((stat & 0x20) !== 0 && mode === 2);
    if (level && !this.statLine) this.raiseStat();
    this.statLine = level;
  }

  // --- Registers --------------------------------------------------------------------

  readRegister(addr) {
    switch (addr) {
      case 0xff40: return this.lcdc;
      case 0xff41: return 0x80 | this.stat | (this.lycMatch ? 0x04 : 0) | this.mode;
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      default: return 0xff;
    }
  }

  writeRegister(addr, v) {
    // Anything left of the beam keeps the old value. (BGP has its own handling.)
    if (this.mode === 3 && addr !== 0xff41 && addr !== 0xff45 && addr !== 0xff47) {
      this.renderTo(this.beamX());
    }
    switch (addr) {
      case 0xff40: {
        const was = this.lcdc & 0x80;
        this.lcdc = v;
        if (was && !(v & 0x80)) this.turnOff();
        else if (!was && (v & 0x80)) this.turnOn();
        break;
      }
      case 0xff41:
        if (this.lcdc & 0x80) {
          // DMG quirk: for an instant the write acts as if every source were enabled,
          // which can raise a spurious interrupt.
          this.stat = 0x78;
          this.updateStat();
        }
        this.stat = v & 0x78;
        this.updateStat();
        break;
      case 0xff42: this.scy = v; break;
      case 0xff43: this.scx = v; break;
      case 0xff44: break; // LY is read-only
      case 0xff45:
        this.lyc = v;
        this.updateStat();
        break;
      case 0xff47:
        if (this.mode === 3) {
          // On this model the pixel in flight during the write sees both palettes
          // at once (old OR new) before the new one takes over.
          const x = this.dot - this.pixelDot;
          this.renderTo(Math.min(SCREEN_W, x - 1));
          if (x >= 1 && x <= SCREEN_W) {
            this.bgp |= v;
            this.renderTo(x);
          }
        }
        this.bgp = v;
        break;
      case 0xff48: this.obp0 = v; break;
      case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break;
      case 0xff4b: this.wx = v; break;
      default: break;
    }
  }

  turnOff() {
    this.line = 0;
    this.ly = 0;
    this.dot = 0;
    this.mode = 0;
    this.irqMode = -1;
    this.oamLocked = false;
    this.oamWriteLocked = false;
    this.vramLocked = false;
    this.vramWriteLocked = false;
    this.offDots = 0;
    // A switched-off LCD is blank (lighter than any shade, in fact).
    this.frame.fill(0);
    this.display.fill(0);
    this.bgInfo.fill(0);
    this.objInfo.fill(0);
    this.bgPix.fill(0);
    this.objPix.fill(0);
  }

  turnOn() {
    // The first line is special: it is a few dots short, STAT reports mode 0 where the
    // OAM scan would be, and OAM stays accessible until drawing starts.
    this.line = 0;
    this.ly = 0;
    this.dot = LCD_ON_DOT;
    this.mode = 0;
    this.irqMode = -1; // STAT says mode 0, but this is not an HBlank for interrupts
    this.cmpLy = 0;
    this.winLine = 0;
    this.wyTriggered = false;
    this.skipFrame = true;
    this.beginLine();
    this.setScript(SCRIPT_LCD_ON);
    this.updateStat();
  }

  // --- CPU access to video memory ---------------------------------------------------

  readVram(addr) {
    return this.vramLocked ? 0xff : this.vram[addr & 0x1fff];
  }

  writeVram(addr, v) {
    if (!this.vramWriteLocked) this.vram[addr & 0x1fff] = v;
  }

  readOam(addr) {
    return this.oamLocked ? 0xff : this.oam[addr & 0xff];
  }

  writeOam(addr, v) {
    if (!this.oamWriteLocked) this.oam[addr & 0xff] = v;
  }

  // --- Rendering --------------------------------------------------------------------

  /** Picks the (at most 10) sprites on the current line, highest priority first. */
  scanOam() {
    const oam = this.oam;
    const sprites = this.lineSprites;
    const height = this.lcdc & 0x04 ? 16 : 8;
    const y16 = this.line + 16;
    let count = 0;
    for (let i = 0; i < 40 && count < 10; i++) {
      const y = oam[i << 2];
      if (y16 < y || y16 >= y + height) continue;
      // Insertion sort by X; OAM order breaks ties because the scan itself is in order.
      const x = oam[(i << 2) + 1];
      let slot = count;
      while (slot > 0 && oam[(sprites[slot - 1] << 2) + 1] > x) {
        sprites[slot] = sprites[slot - 1];
        slot--;
      }
      sprites[slot] = i;
      count++;
    }
    this.lineSpriteCount = count;
  }

  /** Flattens the line's sprites into one row of sprite pixels. */
  buildObjLine() {
    const objColor = this.objColor;
    objColor.fill(0);
    const count = this.lineSpriteCount;
    if (!count) return;
    const { oam, vram, objAttr, objMeta, lineObjPix, lineSprites } = this;
    const tall = (this.lcdc & 0x04) !== 0;
    // Lowest priority first, so higher-priority sprites overwrite.
    for (let i = count - 1; i >= 0; i--) {
      const index = lineSprites[i];
      const base = index << 2;
      const x0 = oam[base + 1] - 8;
      if (x0 <= -8 || x0 >= SCREEN_W) continue;
      const attr = oam[base + 3];
      let row = this.line + 16 - oam[base];
      let tile = oam[base + 2];
      if (tall) {
        if (attr & 0x40) row = 15 - row;
        tile = (tile & 0xfe) | (row >> 3);
        row &= 7;
      } else if (attr & 0x40) {
        row = 7 - row;
      }
      const addr = (tile << 4) + (row << 1);
      const lo = vram[addr];
      const hi = vram[addr + 1];
      const meta = INFO_VALID | tile | (index << INFO_OAM_SHIFT);
      const flipBits = (attr & 0x60) << 1;
      for (let px = 0; px < 8; px++) {
        const x = x0 + px;
        if (x < 0 || x >= SCREEN_W) continue;
        const bit = attr & 0x20 ? px : 7 - px;
        const color = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
        if (!color) continue;
        objColor[x] = color;
        objAttr[x] = attr;
        objMeta[x] = meta;
        lineObjPix[x] = flipBits | (row << 3) | (7 - bit);
      }
    }
  }

  /**
   * First screen column that a register write landing now can still affect. Pixel 0
   * leaves the pipeline 13 dots into the drawing period (later if the line starts
   * part-way into a tile), then one pixel per dot.
   */
  beamX() {
    const x = this.dot - this.pixelDot;
    return x < 0 ? 0 : x > SCREEN_W ? SCREEN_W : x;
  }

  /** Renders the current line up to (not including) column `end`. */
  renderTo(end) {
    const start = this.renderX;
    if (end <= start) return;
    this.renderX = end;

    const { vram, frame, bgInfo, objInfo, bgPix, objPix, objColor, objAttr, objMeta, lineObjPix } = this;
    const lcdc = this.lcdc;
    const line = this.line;
    const rowBase = line * SCREEN_W;
    const bgOn = (lcdc & 0x01) !== 0;
    const objOn = (lcdc & 0x02) !== 0;
    const lowTiles = (lcdc & 0x10) !== 0; // tile numbers index $8000 directly
    const bgMap = lcdc & 0x08 ? 0x1c00 : 0x1800;
    const winMap = lcdc & 0x40 ? 0x1c00 : 0x1800;
    const winX = this.wx - 7;
    const window = bgOn && (lcdc & 0x20) !== 0 && this.wyTriggered && this.wx <= 166;
    const winLine = this.winLine;
    const scx = this.scx;
    const bgY = (line + this.scy) & 0xff;
    const bgp = this.bgp;

    for (let x = start; x < end; x++) {
      let color = 0;
      let info = 0;
      let bpix = 0;
      if (bgOn) {
        let mapOffset, row, col;
        if (window && x >= winX) {
          this.winOnLine = true;
          const wx = x - winX;
          mapOffset = winMap + ((winLine >> 3) << 5) + (wx >> 3);
          row = winLine & 7;
          col = wx & 7;
          info = INFO_VALID | INFO_WINDOW;
        } else {
          const bx = (x + scx) & 0xff;
          mapOffset = bgMap + ((bgY >> 3) << 5) + (bx >> 3);
          row = bgY & 7;
          col = bx & 7;
          info = INFO_VALID;
        }
        let tile = vram[mapOffset];
        if (!lowTiles && tile < 0x80) tile += 0x100;
        const addr = (tile << 4) + (row << 1);
        const bit = 7 - col;
        color = (((vram[addr + 1] >> bit) & 1) << 1) | ((vram[addr] >> bit) & 1);
        info |= tile | ((mapOffset - 0x1800) << INFO_MAP_SHIFT);
        bpix = (row << 3) | col;
      }
      let shade = (bgp >> (color << 1)) & 3;
      let obj = 0;
      let opix = 0;
      const objPixel = objColor[x];
      if (objPixel && objOn) {
        const attr = objAttr[x];
        obj = objMeta[x];
        opix = lineObjPix[x];
        if ((attr & 0x80) && color !== 0) {
          obj |= INFO_OBJ_HIDDEN; // behind background colours 1-3
        } else {
          shade = ((attr & 0x10 ? this.obp1 : this.obp0) >> (objPixel << 1)) & 3;
        }
      }
      const i = rowBase + x;
      frame[i] = shade;
      bgInfo[i] = info;
      objInfo[i] = obj;
      bgPix[i] = bpix;
      objPix[i] = opix;
    }
  }
}
