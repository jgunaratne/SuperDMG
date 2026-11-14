// Sound output. The emulator produces short blocks of samples (one per video frame);
// each block becomes an AudioBuffer scheduled to start exactly where the previous one
// ends. This needs nothing beyond basic Web Audio, so it also works on plain-HTTP
// origins where AudioWorklet is unavailable.

const LEAD = 0.065;      // seconds of audio to keep queued ahead of the playhead
const MAX_AHEAD = 0.25;  // beyond this the emulator is running ahead: drop the block

export class AudioOutput {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.muted = false;
    this.volume = 0.6;
    this.nextTime = 0;
  }

  /** Browsers only start audio from a user gesture; call this from one. */
  unlock() {
    if (!this.ctx) {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      this.ctx = new Context({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
      this.applyGain();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 0; }

  /** Seconds of audio already scheduled but not yet played. */
  get queued() {
    return this.running ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0;
  }

  setMuted(muted) { this.muted = muted; this.applyGain(); }
  setVolume(volume) { this.volume = volume; this.applyGain(); }

  applyGain() {
    if (!this.gain) return;
    // Squared for a more even-feeling slider.
    const level = this.muted ? 0 : this.volume * this.volume;
    this.gain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.015);
  }

  /**
   * Queues a block of interleaved stereo samples.
   * @param {Float32Array} samples
   * @param {number} frames number of stereo frames in `samples`
   */
  push(samples, frames) {
    if (!this.running || frames === 0) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.nextTime < now + 0.005) this.nextTime = now + LEAD; // starting, or underran
    if (this.nextTime > now + MAX_AHEAD) return;
    const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i << 1];
      right[i] = samples[(i << 1) + 1];
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(this.nextTime);
    this.nextTime += frames / ctx.sampleRate;
  }

  /**
   * Sample-rate correction that keeps the queue near its target length. The audio
   * clock and the display clock drift apart; nudging the emulator's output rate by a
   * fraction of a percent absorbs that without audible pitch change.
   */
  get rateCorrection() {
    if (!this.running) return 1;
    const error = this.queued - LEAD;
    return 1 - Math.max(-0.008, Math.min(0.008, error * 0.2));
  }
}
