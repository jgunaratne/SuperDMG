// Cartridge: header parsing, memory bank controllers (MBC1/2/3/5), battery RAM and the
// MBC3 real-time clock.

const RAM_SIZES = [0, 0x800, 0x2000, 0x8000, 0x20000, 0x10000];

const ROM_ONLY = 0, MBC1 = 1, MBC2 = 2, MBC3 = 3, MBC5 = 5;

const TYPES = {
  0x00: { kind: ROM_ONLY, name: 'ROM' },
  0x01: { kind: MBC1, name: 'MBC1' },
  0x02: { kind: MBC1, name: 'MBC1+RAM', ram: true },
  0x03: { kind: MBC1, name: 'MBC1+RAM+BATTERY', ram: true, battery: true },
  0x05: { kind: MBC2, name: 'MBC2' },
  0x06: { kind: MBC2, name: 'MBC2+BATTERY', battery: true },
  0x08: { kind: ROM_ONLY, name: 'ROM+RAM', ram: true },
  0x09: { kind: ROM_ONLY, name: 'ROM+RAM+BATTERY', ram: true, battery: true },
  0x0f: { kind: MBC3, name: 'MBC3+TIMER+BATTERY', rtc: true, battery: true },
  0x10: { kind: MBC3, name: 'MBC3+TIMER+RAM+BATTERY', rtc: true, ram: true, battery: true },
  0x11: { kind: MBC3, name: 'MBC3' },
  0x12: { kind: MBC3, name: 'MBC3+RAM', ram: true },
  0x13: { kind: MBC3, name: 'MBC3+RAM+BATTERY', ram: true, battery: true },
  0x19: { kind: MBC5, name: 'MBC5' },
  0x1a: { kind: MBC5, name: 'MBC5+RAM', ram: true },
  0x1b: { kind: MBC5, name: 'MBC5+RAM+BATTERY', ram: true, battery: true },
  0x1c: { kind: MBC5, name: 'MBC5+RUMBLE', rumble: true },
  0x1d: { kind: MBC5, name: 'MBC5+RUMBLE+RAM', rumble: true, ram: true },
  0x1e: { kind: MBC5, name: 'MBC5+RUMBLE+RAM+BATTERY', rumble: true, ram: true, battery: true },
};

const UNSUPPORTED_NAMES = {
  0x0b: 'MMM01', 0x0c: 'MMM01', 0x0d: 'MMM01', 0x20: 'MBC6', 0x22: 'MBC7',
  0xfc: 'Pocket Camera', 0xfd: 'TAMA5', 0xfe: 'HuC3', 0xff: 'HuC1',
};

const RTC_FOOTER = 48;

export function parseHeader(rom) {
  const cgbFlag = rom[0x143];
  // Newer carts reuse the tail of the title field for a manufacturer code and CGB flag.
  const titleEnd = cgbFlag & 0x80 ? 0x143 : 0x144;
  let title = '';
  for (let i = 0x134; i < titleEnd; i++) {
    const ch = rom[i];
    if (ch === 0) break;
    title += ch >= 0x20 && ch < 0x7f ? String.fromCharCode(ch) : '?';
  }
  let sum = 0;
  for (let i = 0x134; i <= 0x14c; i++) sum = (sum - rom[i] - 1) & 0xff;
  return {
    title: title.trim(),
    cgbFlag,
    cgbOnly: cgbFlag === 0xc0,
    cgbEnhanced: cgbFlag === 0x80,
    sgb: rom[0x146] === 0x03,
    type: rom[0x147],
    romSizeCode: rom[0x148],
    ramSizeCode: rom[0x149],
    version: rom[0x14c],
    headerChecksum: rom[0x14d],
    headerChecksumValid: sum === rom[0x14d],
    globalChecksum: (rom[0x14e] << 8) | rom[0x14f],
  };
}

export class Cartridge {
  /**
   * @param {Uint8Array} bytes ROM image
   * @param {{now?: () => number}} [options] `now` returns wall-clock milliseconds and
   *     drives the MBC3 clock; tests inject a fake.
   */
  constructor(bytes, options = {}) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length < 0x150) throw new Error('This file is too small to be a Game Boy ROM.');
    this.now = options.now || (() => Date.now());
    this.header = parseHeader(bytes);

    const type = TYPES[this.header.type];
    if (!type) {
      const code = this.header.type.toString(16).toUpperCase().padStart(2, '0');
      const name = UNSUPPORTED_NAMES[this.header.type];
      throw new Error(`This cartridge uses an unsupported mapper (${name ? name + ', ' : ''}type $${code}).`);
    }
    this.kind = type.kind;
    this.typeName = type.name;
    this.hasBattery = !!type.battery;
    this.hasRtc = !!type.rtc;
    this.hasRumble = !!type.rumble;

    // Round the image up to a power-of-two number of 16 KiB banks.
    let size = 0x8000;
    while (size < bytes.length) size <<= 1;
    this.rom = new Uint8Array(size).fill(0xff);
    this.rom.set(bytes);
    this.romBanks = size >> 14;

    let ramSize = RAM_SIZES[this.header.ramSizeCode] || 0;
    if (this.kind === MBC2) ramSize = 0x200;       // built in: 512 half-bytes
    else if (!ramSize && type.ram) ramSize = 0x2000; // header says RAM but gives no size
    this.ram = new Uint8Array(ramSize);
    this.ramDirty = false;

    // MBC1 multicarts wire the upper bank bits one position lower. They are 1 MiB
    // images with a second copy of the boot logo at the start of bank $10.
    this.multicart = false;
    if (this.kind === MBC1 && this.romBanks === 64) {
      this.multicart = true;
      for (let i = 0x104; i < 0x134; i++) {
        if (this.rom[0x40000 + i] !== this.rom[i]) { this.multicart = false; break; }
      }
    }

    // MBC30 is an MBC3 with one more ROM bank bit, for 4 MiB games. The header does
    // not distinguish it, so go by size.
    this.bankMask = this.kind === MBC3 && this.romBanks > 128 ? 0xff : 0x7f;

    this.reset();
  }

  /** Power-on state of the mapper. Cartridge RAM and the clock are left alone. */
  reset() {
    this.ramEnabled = this.kind === ROM_ONLY; // no mapper, so no enable register either
    this.bank1 = 1;  // MBC1: 5-bit ROM bank; MBC2/3/5: ROM bank low bits
    this.bank2 = 0;  // MBC1: 2-bit upper bank; MBC5: ROM bank bit 8
    this.mode = 0;   // MBC1 banking mode
    this.ramBank = 0;
    this.rtcSelect = -1; // MBC3: index of the clock register mapped at $A000, or -1
    this.latchPrimed = false;
    this.romOffset0 = 0;
    this.romOffsetN = 0x4000;
    this.ramOffset = 0;
    if (this.hasRtc && !this.rtc) {
      this.rtc = { s: 0, m: 0, h: 0, d: 0, carry: false, halt: false, refMs: this.now() };
      this.rtcLatched = new Uint8Array(5);
    }
    this.updateBanks();
  }

  updateBanks() {
    const romMask = this.romBanks - 1;
    switch (this.kind) {
      case MBC1: {
        const shift = this.multicart ? 4 : 5;
        const low = this.multicart ? this.bank1 & 0x0f : this.bank1;
        const high = this.bank2 << shift;
        this.romOffsetN = ((high | low) & romMask) << 14;
        this.romOffset0 = this.mode ? (high & romMask) << 14 : 0;
        this.ramOffset = this.mode ? this.bank2 << 13 : 0;
        break;
      }
      case MBC2:
        this.romOffsetN = (this.bank1 & romMask) << 14;
        break;
      case MBC3:
        this.romOffsetN = (this.bank1 & romMask) << 14;
        this.ramOffset = this.ramBank << 13;
        break;
      case MBC5:
        this.romOffsetN = (((this.bank2 << 8) | this.bank1) & romMask) << 14;
        this.ramOffset = this.ramBank << 13;
        break;
      default:
        break;
    }
  }

  readRom(addr) {
    return addr < 0x4000 ? this.rom[this.romOffset0 + addr] : this.rom[this.romOffsetN + (addr & 0x3fff)];
  }

  /** Writes to $0000-$7FFF land on the mapper's control registers. */
  writeRom(addr, v) {
    const region = addr >> 13; // 0..3
    switch (this.kind) {
      case MBC1:
        if (region === 0) this.ramEnabled = (v & 0x0f) === 0x0a;
        else if (region === 1) this.bank1 = (v & 0x1f) || 1;
        else if (region === 2) this.bank2 = v & 3;
        else this.mode = v & 1;
        break;
      case MBC2:
        if (addr < 0x4000) {
          if (addr & 0x100) this.bank1 = (v & 0x0f) || 1;
          else this.ramEnabled = (v & 0x0f) === 0x0a;
        }
        break;
      case MBC3:
        if (region === 0) {
          this.ramEnabled = (v & 0x0f) === 0x0a;
        } else if (region === 1) {
          this.bank1 = (v & this.bankMask) || 1;
        } else if (region === 2) {
          if (v >= 0x08 && v <= 0x0c && this.hasRtc) {
            this.rtcSelect = v - 0x08;
          } else {
            this.rtcSelect = -1;
            this.ramBank = v & 0x07;
          }
        } else if (this.hasRtc) {
          // Writing 0 then 1 copies the running clock into the readable registers.
          if (v === 1 && this.latchPrimed) this.latchRtc();
          this.latchPrimed = v === 0;
        }
        break;
      case MBC5:
        if (region === 0) this.ramEnabled = (v & 0x0f) === 0x0a;
        else if (addr < 0x3000) this.bank1 = v;
        else if (region === 1) this.bank2 = v & 1;
        else if (region === 2) this.ramBank = v & (this.hasRumble ? 0x07 : 0x0f);
        break;
      default:
        return;
    }
    this.updateBanks();
  }

  readRam(addr) {
    if (!this.ramEnabled) return 0xff;
    if (this.kind === MBC2) return this.ram[addr & 0x1ff] | 0xf0;
    if (this.rtcSelect >= 0) return this.rtcLatched[this.rtcSelect];
    const size = this.ram.length;
    if (size === 0) return 0xff;
    return this.ram[(this.ramOffset + (addr & 0x1fff)) & (size - 1)];
  }

  writeRam(addr, v) {
    if (!this.ramEnabled) return;
    if (this.kind === MBC2) {
      this.ram[addr & 0x1ff] = v & 0x0f;
      this.ramDirty = true;
      return;
    }
    if (this.rtcSelect >= 0) {
      this.writeRtc(this.rtcSelect, v);
      this.ramDirty = true;
      return;
    }
    const size = this.ram.length;
    if (size === 0) return;
    this.ram[(this.ramOffset + (addr & 0x1fff)) & (size - 1)] = v;
    this.ramDirty = true;
  }

  // --- MBC3 real-time clock ---------------------------------------------------------

  /** Brings the clock fields up to the current wall-clock time. */
  syncRtc() {
    const rtc = this.rtc;
    const now = this.now();
    const elapsed = Math.floor((now - rtc.refMs) / 1000);
    if (elapsed <= 0) {
      if (now < rtc.refMs) rtc.refMs = now; // wall clock went backwards
      return;
    }
    rtc.refMs += elapsed * 1000;
    if (rtc.halt) return;
    let t = rtc.s + rtc.m * 60 + rtc.h * 3600 + rtc.d * 86400 + elapsed;
    let days = Math.floor(t / 86400);
    t -= days * 86400;
    if (days > 511) { rtc.carry = true; days %= 512; }
    rtc.d = days;
    rtc.h = Math.floor(t / 3600);
    rtc.m = Math.floor(t / 60) % 60;
    rtc.s = t % 60;
  }

  rtcRegisters(out) {
    const rtc = this.rtc;
    out[0] = rtc.s;
    out[1] = rtc.m;
    out[2] = rtc.h;
    out[3] = rtc.d & 0xff;
    out[4] = ((rtc.d >> 8) & 1) | (rtc.halt ? 0x40 : 0) | (rtc.carry ? 0x80 : 0);
    return out;
  }

  latchRtc() {
    this.syncRtc();
    this.rtcRegisters(this.rtcLatched);
  }

  writeRtc(index, v) {
    this.syncRtc();
    const rtc = this.rtc;
    switch (index) {
      case 0: rtc.s = v & 0x3f; rtc.refMs = this.now(); break; // also restarts the second
      case 1: rtc.m = v & 0x3f; break;
      case 2: rtc.h = v & 0x1f; break;
      case 3: rtc.d = (rtc.d & 0x100) | v; break;
      default:
        rtc.d = (rtc.d & 0xff) | ((v & 1) << 8);
        rtc.halt = (v & 0x40) !== 0;
        rtc.carry = (v & 0x80) !== 0;
    }
    this.rtcLatched[index] = [0x3f, 0x3f, 0x1f, 0xff, 0xc1][index] & v;
  }

  // --- Battery saves ----------------------------------------------------------------

  /**
   * Battery-backed state as a .sav image, or null if the cartridge has no battery.
   * Clock carts append the 48-byte footer other emulators use, so saves are portable.
   */
  getSaveData() {
    if (!this.hasBattery) return null;
    if (!this.hasRtc) return this.ram.slice();
    this.syncRtc();
    const out = new Uint8Array(this.ram.length + RTC_FOOTER);
    out.set(this.ram);
    const view = new DataView(out.buffer, this.ram.length);
    const live = this.rtcRegisters(new Uint8Array(5));
    for (let i = 0; i < 5; i++) {
      view.setUint32(i * 4, live[i], true);
      view.setUint32(20 + i * 4, this.rtcLatched[i], true);
    }
    view.setBigUint64(40, BigInt(Math.floor(this.rtc.refMs / 1000)), true);
    return out;
  }

  /** Restores a .sav image produced by getSaveData (or by another emulator). */
  loadSaveData(bytes) {
    if (!this.hasBattery || !bytes) return;
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const ramBytes = Math.min(bytes.length, this.ram.length);
    this.ram.set(bytes.subarray(0, ramBytes));
    const extra = bytes.length - this.ram.length;
    if (this.hasRtc && extra >= 44) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + this.ram.length, extra);
      const live = [], latched = [];
      for (let i = 0; i < 5; i++) {
        live.push(view.getUint32(i * 4, true) & 0xff);
        latched.push(view.getUint32(20 + i * 4, true) & 0xff);
      }
      // Older tools wrote a 32-bit timestamp, making the footer 44 bytes.
      const savedAt = extra >= 48 ? Number(view.getBigUint64(40, true)) : view.getUint32(40, true);
      const rtc = this.rtc;
      rtc.s = live[0] % 60; rtc.m = live[1] % 60; rtc.h = live[2] % 24;
      rtc.d = live[3] | ((live[4] & 1) << 8);
      rtc.halt = (live[4] & 0x40) !== 0;
      rtc.carry = (live[4] & 0x80) !== 0;
      rtc.refMs = savedAt * 1000;
      this.rtcLatched.set(latched);
      this.syncRtc(); // account for the time the game was switched off
    }
    this.ramDirty = false;
  }
}
