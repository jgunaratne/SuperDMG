// Divider, TIMA timer, and the two other clocks that hang off the same counter.
//
// The hardware has one free-running 16-bit counter. DIV is its top byte, and TIMA, the
// serial shift clock and the APU frame sequencer are all driven by falling edges of
// individual counter bits. Modelling it that way gives the documented glitches for
// free: writing DIV or TAC can produce a stray edge and tick TIMA early.
//
// The counter is kept in machine cycles (clock / 4), so bit n here is bit n+2 of the
// real counter.

const TIMA_BIT = [0x80, 0x02, 0x08, 0x20]; // TAC rates: 4096, 262144, 65536, 16384 Hz
const SERIAL_BIT = 0x40;                   // 8192 Hz shift clock
const APU_BIT = 0x400;                     // 512 Hz frame sequencer (DIV bit 4)

export class Timer {
  constructor(gb) {
    this.gb = gb;
    this.reset();
  }

  reset() {
    this.counter = 0;
    this.tima = 0;
    this.tma = 0;
    this.tac = 0;
    this.enabled = false;
    this.mask = TIMA_BIT[0];
    this.overflow = false; // TIMA wrapped last cycle: reload and interrupt are due
    this.reloaded = false; // TMA was copied into TIMA during this cycle
  }

  tick() {
    const prev = this.counter;
    const next = (prev + 1) & 0x3fff;
    this.counter = next;
    this.reloaded = false;
    if (this.overflow) {
      // TIMA reads 0 for one cycle after wrapping, then takes TMA and raises the IRQ.
      this.overflow = false;
      this.reloaded = true;
      this.tima = this.tma;
      this.gb.iflag |= 0x04;
      this.gb.lateIrq |= 0x04;
    } else if (this.enabled && (prev & this.mask) && !(next & this.mask)) {
      this.increment();
    }
    const fell = prev & ~next;
    if (fell & (SERIAL_BIT | APU_BIT)) {
      if (fell & SERIAL_BIT) this.gb.serial.clock();
      if (fell & APU_BIT) this.gb.apu.divEvent();
    }
  }

  increment() {
    this.tima = (this.tima + 1) & 0xff;
    if (this.tima === 0) this.overflow = true;
  }

  get div() { return (this.counter >> 6) & 0xff; }

  /** True while the bit that clocks the APU frame sequencer is high. */
  get apuBit() { return (this.counter & APU_BIT) !== 0; }

  writeDiv() {
    // Resetting the counter is a falling edge for every bit that was set.
    const prev = this.counter;
    this.counter = 0;
    if (this.enabled && (prev & this.mask)) this.increment();
    if (prev & SERIAL_BIT) this.gb.serial.clock();
    if (prev & APU_BIT) this.gb.apu.divEvent();
  }

  writeTima(v) {
    // A write in the cycle after the wrap cancels the reload; a write in the reload
    // cycle itself loses to TMA.
    if (this.reloaded) return;
    this.overflow = false;
    this.tima = v;
  }

  writeTma(v) {
    this.tma = v;
    if (this.reloaded) this.tima = v;
  }

  writeTac(v) {
    const before = this.enabled && (this.counter & this.mask) !== 0;
    this.tac = v & 7;
    this.enabled = (v & 4) !== 0;
    this.mask = TIMA_BIT[v & 3];
    const after = this.enabled && (this.counter & this.mask) !== 0;
    if (before && !after) this.increment();
  }
}
