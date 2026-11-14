// Audio processing unit: two pulse channels (one with frequency sweep), a wavetable
// channel and a noise channel, mixed to stereo.
//
// Channels are clocked once per machine cycle. The 512 Hz frame sequencer that drives
// length counters, the sweep and volume envelopes is not a timer of its own: it runs
// off a bit of the system divider, so the Timer calls divEvent() here.
//
// Output is produced by averaging the mixer level over each output sample period,
// which is a cheap and effective low-pass for the very high frequencies the channels
// can produce.

import { MidiSynth } from './midi.js';

const CYCLES_PER_SECOND = 1048576; // machine cycles

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1], // 12.5%
  [1, 0, 0, 0, 0, 0, 0, 1], // 25%
  [1, 0, 0, 0, 0, 1, 1, 1], // 50%
  [0, 1, 1, 1, 1, 1, 1, 0], // 75%
];
const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
const WAVE_SHIFT = [4, 0, 1, 2];

// Bits that read back as 1 for $FF10-$FF2F (write-only and unused bits).
const READ_MASK = [
  0x80, 0x3f, 0x00, 0xff, 0xbf,
  0xff, 0x3f, 0x00, 0xff, 0xbf,
  0x7f, 0xff, 0x9f, 0xff, 0xbf,
  0xff, 0xff, 0x00, 0x00, 0xbf,
  0x00, 0x00, 0x70,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

const BUFFER_FRAMES = 4096;

function envelopeChannel() {
  return {
    enabled: false, dacOn: false,
    length: 0, lengthEnabled: false,
    envInitial: 0, envUp: false, envPeriod: 0, envTimer: 0, volume: 0,
  };
}

export class APU {
  constructor(gb) {
    this.gb = gb;
    this.regs = new Uint8Array(0x20);
    this.wave = new Uint8Array(16);
    /** Interleaved stereo output, -1..1. Read sampleCount frames, then set it to 0. */
    this.samples = new Float32Array(BUFFER_FRAMES * 2);
    this.sampleCount = 0;
    this.sampleRate = 0;
    this.charge = 1;
    this.midi = new MidiSynth();
    this.midiEnabled = false;
    this.midiPair = new Float32Array(2);
    this.reset();
  }

  reset() {
    this.regs.fill(0);
    this.wave.fill(0);
    this.powered = false;
    this.nr50 = 0;
    this.nr51 = 0;
    this.ch1 = { ...envelopeChannel(), duty: 0, dutyPos: 0, freq: 0, timer: 0,
      sweepPeriod: 0, sweepNegate: false, sweepShift: 0, sweepTimer: 0,
      sweepEnabled: false, shadow: 0, negateUsed: false };
    this.ch2 = { ...envelopeChannel(), duty: 0, dutyPos: 0, freq: 0, timer: 0 };
    this.ch3 = { enabled: false, dacOn: false, length: 0, lengthEnabled: false,
      volumeCode: 0, freq: 0, pos: 0, countdown: 0, sampleByte: 0, justRead: false };
    this.ch4 = { ...envelopeChannel(), shift: 0, widthMode: false, divisorCode: 0,
      timer: 0, lfsr: 0x7fff };
    // Frame sequencer position. Odd values mean the most recent step clocked the
    // length counters (so the next one will not).
    this.divDivider = 0;
    this.skipDivEvent = 0;
    this.dirty = true;
    this.outL = 0; this.outR = 0;
    this.accL = 0; this.accR = 0; this.accN = 0;
    this.phase = 0;
    this.capL = 0; this.capR = 0;
    this.sampleCount = 0;
    this.midi.reset();
  }

  /** Sets the output sample rate in Hz. 0 turns sample generation off. */
  setSampleRate(rate) {
    this.sampleRate = rate;
    // High-pass filter coefficient: the real output is AC-coupled through a capacitor.
    this.charge = rate > 0 ? Math.pow(0.999958, 4194304 / rate) : 1;
    this.midi.setSampleRate(rate);
  }

  /** Enables or disables General MIDI instrument replacement for all four channels. */
  setMidiEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.midiEnabled) return;
    this.midiEnabled = next;
    if (next) {
      this.midi.syncFromApu(this);
    } else {
      this.midi.reset();
      this.dirty = true;
      this.accL = 0; this.accR = 0; this.accN = 0;
      this.capL = 0; this.capR = 0;
    }
  }

  /** Selects the General MIDI instrument ensemble ('symphonic' | 'jrpg' | 'piano' | 'jazz'). */
  setMidiPreset(preset) {
    this.midi.setPreset(preset);
  }

  // --- Clocking ---------------------------------------------------------------------

  /** Advances one machine cycle. */
  tick() {
    if (this.powered) {
      const c1 = this.ch1;
      if (c1.enabled && --c1.timer <= 0) {
        c1.timer = 2048 - c1.freq;
        c1.dutyPos = (c1.dutyPos + 1) & 7;
        this.dirty = true;
      }
      const c2 = this.ch2;
      if (c2.enabled && --c2.timer <= 0) {
        c2.timer = 2048 - c2.freq;
        c2.dutyPos = (c2.dutyPos + 1) & 7;
        this.dirty = true;
      }
      const c3 = this.ch3;
      if (c3.enabled) {
        // The wave channel steps at up to 2 MHz, twice per machine cycle. justRead
        // records whether it fetched a sample on the most recent of those steps, which
        // is the only moment the CPU can reach wave RAM while the channel plays.
        for (let i = 0; i < 2; i++) {
          if (c3.countdown === 0) {
            c3.countdown = 2047 - c3.freq;
            c3.pos = (c3.pos + 1) & 31;
            c3.sampleByte = this.wave[c3.pos >> 1];
            c3.justRead = true;
            this.dirty = true;
          } else {
            c3.countdown--;
            c3.justRead = false;
          }
        }
      }
      const c4 = this.ch4;
      if (c4.enabled) {
        c4.timer -= 4;
        if (c4.timer <= 0) {
          c4.timer += NOISE_DIVISOR[c4.divisorCode] << c4.shift;
          if (c4.shift < 14) {
            const bit = (c4.lfsr ^ (c4.lfsr >> 1)) & 1;
            c4.lfsr = (c4.lfsr >> 1) | (bit << 14);
            if (c4.widthMode) c4.lfsr = (c4.lfsr & ~0x40) | (bit << 6);
            this.dirty = true;
          }
        }
      }
    }

    if (this.sampleRate === 0) return;
    if (!this.midiEnabled) {
      if (this.dirty) this.mix();
      this.accL += this.outL;
      this.accR += this.outR;
      this.accN++;
    }
    this.phase += this.sampleRate;
    if (this.phase >= CYCLES_PER_SECOND) {
      this.phase -= CYCLES_PER_SECOND;
      this.emitSample();
    }
  }

  mix() {
    this.dirty = false;
    if (!this.powered) { this.outL = 0; this.outR = 0; return; }
    const pan = this.nr51;
    let left = 0, right = 0, out;

    // Each DAC maps the channel's 4-bit level to -1..+1; a disabled DAC outputs 0.
    const c1 = this.ch1;
    if (c1.dacOn) {
      out = (c1.enabled && DUTY[c1.duty][c1.dutyPos] ? c1.volume : 0) / 7.5 - 1;
      if (pan & 0x10) left += out;
      if (pan & 0x01) right += out;
    }
    const c2 = this.ch2;
    if (c2.dacOn) {
      out = (c2.enabled && DUTY[c2.duty][c2.dutyPos] ? c2.volume : 0) / 7.5 - 1;
      if (pan & 0x20) left += out;
      if (pan & 0x02) right += out;
    }
    const c3 = this.ch3;
    if (c3.dacOn) {
      let level = 0;
      if (c3.enabled) {
        const nibble = c3.pos & 1 ? c3.sampleByte & 0x0f : c3.sampleByte >> 4;
        level = nibble >> WAVE_SHIFT[c3.volumeCode];
      }
      out = level / 7.5 - 1;
      if (pan & 0x40) left += out;
      if (pan & 0x04) right += out;
    }
    const c4 = this.ch4;
    if (c4.dacOn) {
      out = (c4.enabled && !(c4.lfsr & 1) ? c4.volume : 0) / 7.5 - 1;
      if (pan & 0x80) left += out;
      if (pan & 0x08) right += out;
    }
    // Four channels, eight master volume steps.
    this.outL = left * (((this.nr50 >> 4) & 7) + 1) / 32;
    this.outR = right * ((this.nr50 & 7) + 1) / 32;
  }

  emitSample() {
    let outL, outR;
    if (this.midiEnabled) {
      this.midi.renderSample(this, this.midiPair);
      outL = this.midiPair[0];
      outR = this.midiPair[1];
    } else {
      const n = this.accN || 1;
      const inL = this.accL / n;
      const inR = this.accR / n;
      this.accL = 0; this.accR = 0; this.accN = 0;
      outL = inL - this.capL;
      outR = inR - this.capR;
      this.capL = inL - outL * this.charge;
      this.capR = inR - outR * this.charge;
    }
    if (this.sampleCount < BUFFER_FRAMES) {
      const i = this.sampleCount++ << 1;
      this.samples[i] = outL;
      this.samples[i + 1] = outR;
    }
  }

  // --- Frame sequencer --------------------------------------------------------------

  /** One 512 Hz step, clocked by the falling edge of a divider bit. */
  divEvent() {
    if (!this.powered) return;
    if (this.skipDivEvent === 1) { this.skipDivEvent = 2; return; }
    if (this.skipDivEvent === 2) this.skipDivEvent = 0;
    else this.divDivider = (this.divDivider + 1) & 7;
    const step = this.divDivider;
    if (step & 1) this.clockLength();
    if ((step & 3) === 3) this.clockSweep();
    if (step === 0) this.clockEnvelopes();
  }

  clockLength() {
    for (const c of [this.ch1, this.ch2, this.ch3, this.ch4]) {
      if (c.lengthEnabled && c.length > 0 && --c.length === 0) {
        c.enabled = false;
        this.dirty = true;
      }
    }
  }

  clockEnvelopes() {
    for (const c of [this.ch1, this.ch2, this.ch4]) {
      if (c.envPeriod === 0) continue;
      if (--c.envTimer > 0) continue;
      c.envTimer = c.envPeriod;
      if (c.envUp) { if (c.volume < 15) { c.volume++; this.dirty = true; } }
      else if (c.volume > 0) { c.volume--; this.dirty = true; }
    }
  }

  clockSweep() {
    const c = this.ch1;
    if (--c.sweepTimer > 0) return;
    c.sweepTimer = c.sweepPeriod || 8;
    if (!c.sweepEnabled || c.sweepPeriod === 0) return;
    const freq = this.sweepFrequency();
    if (freq <= 2047 && c.sweepShift !== 0) {
      c.shadow = freq;
      c.freq = freq;
      this.sweepFrequency(); // second overflow check with the new value
    }
  }

  /** Next sweep frequency; silences the channel if it overflows. */
  sweepFrequency() {
    const c = this.ch1;
    const delta = c.shadow >> c.sweepShift;
    let freq;
    if (c.sweepNegate) {
      freq = c.shadow - delta;
      c.negateUsed = true;
    } else {
      freq = c.shadow + delta;
    }
    if (freq > 2047) {
      c.enabled = false;
      this.dirty = true;
    }
    return freq;
  }

  // --- Registers --------------------------------------------------------------------

  read(addr) {
    if (addr >= 0xff30) {
      const c3 = this.ch3;
      if (!c3.enabled) return this.wave[addr & 0x0f];
      // While playing, the CPU sees the byte the channel is using, and only in the
      // instant the channel itself reads it.
      return c3.justRead ? this.wave[c3.pos >> 1] : 0xff;
    }
    if (addr === 0xff26) {
      return (this.powered ? 0x80 : 0) | 0x70 |
          (this.ch1.enabled ? 1 : 0) | (this.ch2.enabled ? 2 : 0) |
          (this.ch3.enabled ? 4 : 0) | (this.ch4.enabled ? 8 : 0);
    }
    return this.regs[addr - 0xff10] | READ_MASK[addr - 0xff10];
  }

  write(addr, v) {
    if (addr >= 0xff30) {
      const c3 = this.ch3;
      if (!c3.enabled) { this.wave[addr & 0x0f] = v; this.midi.markWaveDirty(); }
      else if (c3.justRead) { this.wave[c3.pos >> 1] = v; this.midi.markWaveDirty(); }
      return;
    }
    if (addr === 0xff26) {
      const on = (v & 0x80) !== 0;
      if (on && !this.powered) this.powerOn();
      else if (!on && this.powered) this.powerOff();
      return;
    }
    if (addr > 0xff26) return;
    if (!this.powered) {
      // Registers are frozen while powered down, except that on the original Game Boy
      // the length counters stay writable.
      switch (addr) {
        case 0xff11: this.ch1.length = 64 - (v & 0x3f); break;
        case 0xff16: this.ch2.length = 64 - (v & 0x3f); break;
        case 0xff1b: this.ch3.length = 256 - v; break;
        case 0xff20: this.ch4.length = 64 - (v & 0x3f); break;
        default: break;
      }
      return;
    }

    this.regs[addr - 0xff10] = v;
    this.dirty = true;
    switch (addr) {
      case 0xff10: {
        const c = this.ch1;
        const wasNegate = c.sweepNegate;
        c.sweepPeriod = (v >> 4) & 7;
        c.sweepNegate = (v & 0x08) !== 0;
        c.sweepShift = v & 7;
        // Leaving subtract mode after it has been used kills the channel.
        if (wasNegate && !c.sweepNegate && c.negateUsed) c.enabled = false;
        break;
      }
      case 0xff11: this.ch1.duty = v >> 6; this.ch1.length = 64 - (v & 0x3f); break;
      case 0xff12: this.writeEnvelope(this.ch1, v); break;
      case 0xff13: this.ch1.freq = (this.ch1.freq & 0x700) | v; break;
      case 0xff14: {
        const c = this.ch1;
        c.freq = (c.freq & 0xff) | ((v & 7) << 8);
        if (this.writeControl(c, v, 64)) {
          this.triggerEnvelope(c);
          c.timer = 2048 - c.freq;
          c.shadow = c.freq;
          c.sweepTimer = c.sweepPeriod || 8;
          c.negateUsed = false;
          c.sweepEnabled = c.sweepPeriod !== 0 || c.sweepShift !== 0;
          if (c.sweepShift !== 0) this.sweepFrequency();
          if (this.midiEnabled) this.midi.onTrigger(this, 1);
        }
        break;
      }

      case 0xff16: this.ch2.duty = v >> 6; this.ch2.length = 64 - (v & 0x3f); break;
      case 0xff17: this.writeEnvelope(this.ch2, v); break;
      case 0xff18: this.ch2.freq = (this.ch2.freq & 0x700) | v; break;
      case 0xff19: {
        const c = this.ch2;
        c.freq = (c.freq & 0xff) | ((v & 7) << 8);
        if (this.writeControl(c, v, 64)) {
          this.triggerEnvelope(c);
          c.timer = 2048 - c.freq;
          if (this.midiEnabled) this.midi.onTrigger(this, 2);
        }
        break;
      }

      case 0xff1a:
        this.ch3.dacOn = (v & 0x80) !== 0;
        if (!this.ch3.dacOn) this.ch3.enabled = false;
        break;
      case 0xff1b: this.ch3.length = 256 - v; break;
      case 0xff1c: this.ch3.volumeCode = (v >> 5) & 3; break;
      case 0xff1d: this.ch3.freq = (this.ch3.freq & 0x700) | v; break;
      case 0xff1e: {
        const c = this.ch3;
        c.freq = (c.freq & 0xff) | ((v & 7) << 8);
        if (this.writeControl(c, v, 256)) {
          const reading = c.enabled && c.countdown === 0;
          if (reading) {
            // Hardware bug: retriggering in the very cycle the channel fetches a
            // sample scrambles the start of wave RAM.
            const offset = ((c.pos + 1) >> 1) & 0x0f;
            if (offset < 4) this.wave[0] = this.wave[offset];
            else this.wave.copyWithin(0, offset & ~3, (offset & ~3) + 4);
            this.midi.markWaveDirty();
          }
          c.pos = 0;
          if (reading) c.sampleByte = this.wave[0];
          if (c.dacOn) {
            c.enabled = true;
            c.countdown = (c.freq ^ 0x7ff) + 3;
          }
          if (this.midiEnabled) this.midi.onTrigger(this, 3);
        }
        break;
      }

      case 0xff20: this.ch4.length = 64 - (v & 0x3f); break;
      case 0xff21: this.writeEnvelope(this.ch4, v); break;
      case 0xff22:
        this.ch4.shift = v >> 4;
        this.ch4.widthMode = (v & 0x08) !== 0;
        this.ch4.divisorCode = v & 7;
        break;
      case 0xff23: {
        const c = this.ch4;
        if (this.writeControl(c, v, 64)) {
          this.triggerEnvelope(c);
          c.lfsr = 0x7fff;
          c.timer = NOISE_DIVISOR[c.divisorCode] << c.shift;
          if (this.midiEnabled) this.midi.onTrigger(this, 4);
        }
        break;
      }

      case 0xff24: this.nr50 = v; break;
      case 0xff25: this.nr51 = v; break;
      default: break;
    }
  }

  writeEnvelope(c, v) {
    c.envInitial = v >> 4;
    c.envUp = (v & 0x08) !== 0;
    c.envPeriod = v & 7;
    c.dacOn = (v & 0xf8) !== 0;
    if (!c.dacOn) c.enabled = false;
  }

  triggerEnvelope(c) {
    if (c.dacOn) c.enabled = true;
    c.volume = c.envInitial;
    c.envTimer = c.envPeriod || 8;
  }

  /**
   * Handles the length-enable and trigger bits shared by every NRx4 register.
   * Returns true if the write triggers the channel.
   */
  writeControl(c, v, maxLength) {
    const wasEnabled = c.lengthEnabled;
    c.lengthEnabled = (v & 0x40) !== 0;
    const trigger = (v & 0x80) !== 0;
    // If the frame sequencer is in the half of its period where the length counter
    // was just clocked, switching length on clocks it once more straight away.
    const extraClock = (this.divDivider & 1) === 1;
    if (extraClock && !wasEnabled && c.lengthEnabled && c.length > 0) {
      c.length--;
      if (c.length === 0 && !trigger) c.enabled = false;
    }
    if (trigger && c.length === 0) {
      c.length = maxLength;
      if (extraClock && c.lengthEnabled) c.length--;
    }
    return trigger;
  }

  powerOn() {
    this.powered = true;
    this.divDivider = 0;
    this.skipDivEvent = 0;
    // If the divider bit that clocks the sequencer is already high, the first step
    // after power-on is swallowed.
    if (this.gb.timer.apuBit) {
      this.skipDivEvent = 1;
      this.divDivider = 1;
    }
    this.ch1.dutyPos = 0;
    this.ch2.dutyPos = 0;
    this.ch3.pos = 0;
    this.ch3.sampleByte = 0;
    this.dirty = true;
  }

  powerOff() {
    // Everything is cleared except wave RAM and (on this model) the length counters.
    const lengths = [this.ch1.length, this.ch2.length, this.ch3.length, this.ch4.length];
    const wave = this.wave.slice();
    const { sampleRate, charge, capL, capR, phase } = this;
    const samples = this.sampleCount;
    this.reset();
    this.wave.set(wave);
    this.ch1.length = lengths[0];
    this.ch2.length = lengths[1];
    this.ch3.length = lengths[2];
    this.ch4.length = lengths[3];
    this.sampleRate = sampleRate; this.charge = charge;
    this.capL = capL; this.capR = capR; this.phase = phase;
    this.sampleCount = samples;
  }
}
