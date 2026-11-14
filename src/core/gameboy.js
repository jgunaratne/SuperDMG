// The machine: memory map, interrupt registers, OAM DMA, and the glue that advances
// every component one machine cycle at a time.
//
// The emulated model is the original Game Boy (DMG). There is no boot ROM: reset()
// puts the hardware straight into the state the boot ROM leaves behind.

import { CPU } from './cpu.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Timer } from './timer.js';
import { Joypad } from './joypad.js';
import { Serial } from './serial.js';
import { Cartridge } from './cartridge.js';

/** Machine cycles (clock / 4) per second and per video frame. */
export const CYCLES_PER_SECOND = 1048576;
export const CYCLES_PER_FRAME = 17556;
export const FRAMES_PER_SECOND = CYCLES_PER_SECOND / CYCLES_PER_FRAME; // ~59.73

// Divider value at the instant the boot ROM hands over to the cartridge at $0100:
// DIV reads $AB and rolls over to $AC fourteen cycles later.
const BOOT_DIVIDER = 0x2af2;

export class GameBoy {
  constructor() {
    this.wram = new Uint8Array(0x2000);
    this.hram = new Uint8Array(0x80);
    this.ie = 0;
    this.iflag = 0; // IF, low five bits
    // Interrupt flags raised in the second half of the current machine cycle. A halted
    // CPU samples its interrupt lines mid-cycle, so it notices these one cycle late.
    this.lateIrq = 0;
    /** Machine cycles executed since reset. */
    this.cycles = 0;
    /** @type {Cartridge|null} */
    this.cart = null;

    this.timer = new Timer(this);
    this.serial = new Serial(this);
    this.joypad = new Joypad(this);
    this.ppu = new PPU(this);
    this.apu = new APU(this);
    this.cpu = new CPU(this);
    this.resetDma();
  }

  /**
   * Inserts a cartridge and resets the machine.
   * @param {Uint8Array|ArrayBuffer} bytes ROM image
   * @param {{now?: () => number}} [options] forwarded to Cartridge
   * @return {Cartridge}
   */
  loadRom(bytes, options) {
    this.cart = new Cartridge(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), options);
    this.reset();
    return this.cart;
  }

  /** Power cycle. Cartridge RAM survives, as it would with a battery. */
  reset() {
    this.wram.fill(0);
    this.hram.fill(0);
    this.ie = 0;
    this.iflag = 0x01;
    this.cycles = 0;
    this.resetDma();

    this.timer.reset();
    this.timer.counter = BOOT_DIVIDER;
    this.serial.reset();
    this.joypad.reset();
    this.apu.reset();
    this.ppu.reset();
    if (this.cart) this.cart.reset();

    const cpu = this.cpu;
    const headerChecksum = this.cart ? this.cart.header.headerChecksum : 0;
    cpu.a = 0x01;
    cpu.f = headerChecksum ? 0xb0 : 0x80;
    cpu.b = 0x00; cpu.c = 0x13;
    cpu.d = 0x00; cpu.e = 0xd8;
    cpu.h = 0x01; cpu.l = 0x4d;
    cpu.sp = 0xfffe;
    cpu.pc = 0x0100;
    cpu.ime = false; cpu.imeDelay = false;
    cpu.halted = false; cpu.haltBug = false; cpu.stopped = false; cpu.locked = false;

    // Video: LCD on, near the end of VBlank, logo still in VRAM.
    this.ppu.enterBootState();
    this.loadBootLogo();

    // Sound: powered up, with the tail of the start-up chime on channel 1.
    const apu = this.apu;
    apu.powerOn();
    apu.skipDivEvent = 0;
    apu.divDivider = 0;
    for (const [addr, value] of [
      [0xff10, 0x80], [0xff11, 0x80], [0xff12, 0xf3], [0xff13, 0xc1], [0xff14, 0x87],
      [0xff16, 0x00], [0xff17, 0x00], [0xff19, 0x00],
      [0xff1a, 0x00], [0xff1b, 0x00], [0xff1c, 0x00], [0xff1e, 0x00],
      [0xff20, 0x00], [0xff21, 0x00], [0xff22, 0x00], [0xff23, 0x00],
      [0xff24, 0x77], [0xff25, 0xf3],
    ]) apu.write(addr, value);
    apu.ch1.volume = 0;
    apu.midi.reset();
  }

  /**
   * Recreates what the boot ROM draws: the logo bitmap from the cartridge header,
   * scaled 2x into tiles $01-$18, and the two tilemap rows that display it.
   */
  loadBootLogo() {
    if (!this.cart) return;
    const rom = this.cart.rom;
    const vram = this.ppu.vram;
    let out = 0x0010;
    for (let i = 0x104; i < 0x134; i++) {
      for (const nibble of [rom[i] >> 4, rom[i] & 0x0f]) {
        let wide = 0;
        for (let bit = 3; bit >= 0; bit--) wide = (wide << 2) | ((nibble >> bit) & 1 ? 3 : 0);
        vram[out] = wide;
        vram[out + 2] = wide;
        out += 4;
      }
    }
    for (let i = 0; i < 12; i++) {
      vram[0x1904 + i] = 0x01 + i;
      vram[0x1924 + i] = 0x0d + i;
    }
    vram[0x1910] = 0x19;
  }

  // --- Running ----------------------------------------------------------------------

  /**
   * Runs until the PPU finishes a frame, or for one frame's worth of time if no frame
   * boundary comes (which can happen around LCD on/off transitions).
   * @return {boolean} true if a new frame is ready in ppu.display
   */
  runFrame() {
    const cpu = this.cpu;
    const ppu = this.ppu;
    const limit = this.cycles + CYCLES_PER_FRAME;
    ppu.frameReady = false;
    while (!ppu.frameReady && this.cycles < limit) cpu.step();
    return ppu.frameReady;
  }

  /** @param {string} name right|left|up|down|a|b|select|start */
  setButton(name, pressed) {
    this.joypad.set(name, pressed);
  }

  // --- Bus: the CPU's view, one machine cycle per access ---------------------------

  tickCycle() {
    this.cycles++;
    this.lateIrq = 0;
    if (this.dmaRunning) this.dmaTick();
    this.timer.tick();
    this.ppu.tick();
    this.apu.tick();
  }

  readCycle(addr) {
    this.tickCycle();
    return this.read(addr);
  }

  writeCycle(addr, v) {
    this.tickCycle();
    this.write(addr, v);
  }

  read(addr) {
    if (this.dmaBusy && addr < 0xfe00 && this.dmaConflict(addr)) return this.dmaLatch;
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.readVram(addr);
    if (addr < 0xc000) return this.cart.readRam(addr);
    if (addr < 0xfe00) return this.wram[addr & 0x1fff]; // work RAM and its echo
    if (addr < 0xfea0) return this.dmaBusy ? 0xff : this.ppu.readOam(addr);
    if (addr < 0xff00) return this.dmaBusy || this.ppu.mode >= 2 ? 0xff : 0x00;
    if (addr < 0xff80) return this.readIo(addr);
    if (addr < 0xffff) return this.hram[addr & 0x7f];
    return this.ie;
  }

  write(addr, v) {
    if (this.dmaBusy && addr < 0xfe00 && this.dmaConflict(addr)) {
      // The write lands where the transfer is reading instead, and (outside video
      // RAM) also disturbs the OAM byte that was just copied.
      addr = (this.dmaSource + this.dmaIndex - 1) & 0xffff;
      if (addr >= 0xa000) this.ppu.oam[this.dmaIndex - 1] &= v;
      if (addr >= 0xc000) { this.wram[addr & 0x1fff] = v; return; }
    }
    if (addr < 0x8000) this.cart.writeRom(addr, v);
    else if (addr < 0xa000) this.ppu.writeVram(addr, v);
    else if (addr < 0xc000) this.cart.writeRam(addr, v);
    else if (addr < 0xfe00) this.wram[addr & 0x1fff] = v;
    else if (addr < 0xfea0) { if (!this.dmaBusy) this.ppu.writeOam(addr, v); }
    else if (addr < 0xff00) { /* unusable */ }
    else if (addr < 0xff80) this.writeIo(addr, v);
    else if (addr < 0xffff) this.hram[addr & 0x7f] = v;
    else this.ie = v;
  }

  readIo(addr) {
    if (addr >= 0xff40) return addr === 0xff46 ? this.dmaReg : this.ppu.readRegister(addr);
    if (addr >= 0xff10) return this.apu.read(addr);
    switch (addr) {
      case 0xff00: return this.joypad.read();
      case 0xff01: return this.serial.sb;
      case 0xff02: return this.serial.readSc();
      case 0xff04: return this.timer.div;
      case 0xff05: return this.timer.tima;
      case 0xff06: return this.timer.tma;
      case 0xff07: return this.timer.tac | 0xf8;
      case 0xff0f: return this.iflag | 0xe0;
      default: return 0xff;
    }
  }

  writeIo(addr, v) {
    if (addr >= 0xff40) {
      if (addr === 0xff46) {
        // OAM DMA starts two cycles after the write.
        this.dmaReg = v;
        this.dmaDelay = 2;
        this.dmaRunning = true;
      } else if (addr <= 0xff4b) {
        this.ppu.writeRegister(addr, v);
      }
      return;
    }
    if (addr >= 0xff10) { this.apu.write(addr, v); return; }
    switch (addr) {
      case 0xff00: this.joypad.write(v); break;
      case 0xff01: this.serial.sb = v; break;
      case 0xff02: this.serial.writeSc(v); break;
      case 0xff04: this.timer.writeDiv(); break;
      case 0xff05: this.timer.writeTima(v); break;
      case 0xff06: this.timer.writeTma(v); break;
      case 0xff07: this.timer.writeTac(v); break;
      case 0xff0f: this.iflag = v & 0x1f; break;
      default: break;
    }
  }

  // --- OAM DMA ----------------------------------------------------------------------

  resetDma() {
    this.dmaReg = 0xff;
    this.dmaDelay = 0;      // cycles until a requested transfer starts
    this.dmaActive = false; // copying bytes
    this.dmaBusy = false;   // a byte was copied this cycle: OAM is off the bus
    this.dmaRunning = false;
    this.dmaSource = 0;
    this.dmaIndex = 0;
    this.dmaLatch = 0xff;   // the byte copied this cycle
  }

  dmaTick() {
    if (this.dmaDelay > 0 && --this.dmaDelay === 0) {
      this.dmaSource = this.dmaReg << 8;
      this.dmaIndex = 0;
      this.dmaActive = true;
    }
    if (this.dmaActive) {
      this.dmaBusy = true;
      this.dmaLatch = this.dmaRead((this.dmaSource + this.dmaIndex) & 0xffff);
      this.ppu.oam[this.dmaIndex] = this.dmaLatch;
      if (++this.dmaIndex === 0xa0) this.dmaActive = false;
    } else {
      this.dmaBusy = false;
      if (this.dmaDelay === 0) this.dmaRunning = false;
    }
  }

  /**
   * While a transfer runs it owns the bus it reads from: the video RAM bus for
   * sources in $8000-$9FFF, otherwise the main bus shared by the cartridge and work
   * RAM. A CPU access to that bus sees the transfer's data instead of its own.
   */
  dmaConflict(addr) {
    const next = (this.dmaSource + this.dmaIndex) & 0xffff;
    if (addr === next || (next >= 0xe000 && addr === (next & ~0x2000))) return false;
    const video = addr >= 0x8000 && addr < 0xa000;
    return video === (this.dmaSource >= 0x8000 && this.dmaSource < 0xa000);
  }

  dmaRead(addr) {
    if (addr < 0x8000) return this.cart.readRom(addr);
    if (addr < 0xa000) return this.ppu.vram[addr & 0x1fff];
    if (addr < 0xc000) return this.cart.readRam(addr);
    return this.wram[addr & 0x1fff]; // sources above $DFFF read the work RAM echo
  }

  // --- Inspection (no side effects, no access restrictions) -------------------------

  peek(addr) {
    addr &= 0xffff;
    if (addr < 0x8000) return this.cart ? this.cart.readRom(addr) : 0xff;
    if (addr < 0xa000) return this.ppu.vram[addr & 0x1fff];
    if (addr < 0xc000) return this.cart ? this.cart.readRam(addr) : 0xff;
    if (addr < 0xfe00) return this.wram[addr & 0x1fff];
    if (addr < 0xfea0) return this.ppu.oam[addr & 0xff];
    if (addr < 0xff00) return 0x00;
    if (addr < 0xff80) return this.readIo(addr);
    if (addr < 0xffff) return this.hram[addr & 0x7f];
    return this.ie;
  }
}

export { Cartridge };
