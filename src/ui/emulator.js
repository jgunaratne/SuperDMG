// Runs the machine in real time: pacing against the display clock, pause / step /
// speed control, and feeding the audio output. Emits 'load', 'reset', 'pause' and
// 'frame' events for the rest of the UI.

import { GameBoy, CYCLES_PER_FRAME, CYCLES_PER_SECOND } from '../core/gameboy.js';

const FRAME_MS = (1000 * CYCLES_PER_FRAME) / CYCLES_PER_SECOND; // ~16.74
// Run a frame slightly early rather than skip one: on a 60 Hz display the emulated
// frame is a hair longer than the refresh interval, and without slack ordinary timer
// jitter turns into visible stutter.
const SLACK_MS = 2;
const MAX_CATCH_UP_MS = FRAME_MS * 4;

export class Emulator extends EventTarget {
  /** @param {import('./audio.js').AudioOutput} audio */
  constructor(audio) {
    super();
    this.gb = new GameBoy();
    this.audio = audio;
    this.loaded = false;
    this.romName = '';
    this.paused = false;
    this.speed = 1;
    this.fastForward = false;
    this.fps = 0;

    this.budget = 0;
    this.lastTime = 0;
    this.fpsFrames = 0;
    this.fpsSince = 0;
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Inserts a ROM and starts running it. Throws if the image is not usable.
   * @param {Uint8Array} bytes
   * @param {string} name file name, for display
   */
  load(bytes, name) {
    const cart = this.gb.loadRom(bytes);
    this.loaded = true;
    this.romName = name;
    this.paused = false;
    this.budget = 0;
    this.emit('load', { cart, name });
    this.emit('pause', { paused: false });
    this.emit('frame');
  }

  reset() {
    if (!this.loaded) return;
    this.gb.reset();
    this.budget = 0;
    this.emit('reset');
    this.emit('frame');
  }

  setPaused(paused) {
    if (!this.loaded || paused === this.paused) return;
    this.paused = paused;
    this.budget = 0;
    this.emit('pause', { paused });
  }

  togglePause() { this.setPaused(!this.paused); }

  /** Pauses (if running) and advances exactly one frame. */
  stepFrame() {
    if (!this.loaded) return;
    this.setPaused(true);
    this.gb.runFrame();
    this.gb.apu.sampleCount = 0;
    this.emit('frame');
  }

  setSpeed(speed) {
    this.speed = speed;
    this.budget = 0;
  }

  tick(now) {
    requestAnimationFrame(this.tick);
    const elapsed = now - this.lastTime;
    this.lastTime = now;
    if (now - this.fpsSince >= 1000) {
      // Smoothed, because whole frames per one-second window alternate between 59
      // and 60 at the true rate of 59.7.
      const measured = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fps = this.fps > 1 && measured > 1 ? this.fps * 0.75 + measured * 0.25 : measured;
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
    if (!this.loaded || this.paused) return;

    const gb = this.gb;
    const apu = gb.apu;
    let frames = 0;
    if (this.fastForward) {
      // As many frames as fit in most of a display frame; sound is dropped.
      const deadline = performance.now() + 11;
      do {
        gb.runFrame();
        apu.sampleCount = 0;
        frames++;
      } while (performance.now() < deadline);
      this.budget = 0;
    } else {
      this.budget = Math.min(this.budget + elapsed * this.speed, MAX_CATCH_UP_MS);
      const audio = this.audio;
      while (this.budget >= FRAME_MS - SLACK_MS) {
        this.budget -= FRAME_MS;
        // Off normal speed the sample rate is scaled so pitch follows speed and the
        // amount of audio per real second stays constant.
        apu.setSampleRate(audio.running ? (audio.sampleRate / this.speed) * audio.rateCorrection : 0);
        gb.runFrame();
        audio.push(apu.samples, apu.sampleCount);
        apu.sampleCount = 0;
        frames++;
      }
    }
    if (frames) {
      this.fpsFrames += frames;
      this.emit('frame');
    }
  }
}
