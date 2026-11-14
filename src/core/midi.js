// High-quality General MIDI instrument engine powered by multi-sampled ElevenLabs
// studio recordings (`assets/instruments/*.mp3`), with 4-point Hermite cubic pitch
// resampling, phase-locked zero-crossing sustain loops, velocity tone shaping,
// polyphonic release tails, studio percussion (with pedal hi-hat choke), and stereo
// concert-hall reverb.
//
// Falls back seamlessly to 5-band anti-aliased acoustic wavetables before the sample
// bank finishes decoding or in headless environments that do not load audio assets.

import { HarmonicArranger } from './arranger.js';

const NOISE_DIVISOR = [8, 16, 32, 48, 64, 80, 96, 112];
const WAVE_VOLUME = [0, 1.0, 0.5, 0.25];

const TABLE_BITS = 11;
const TABLE_SIZE = 1 << TABLE_BITS; // 2048 samples per single-cycle wavetable
const TABLE_MASK = TABLE_SIZE - 1;
const TWO_PI = Math.PI * 2;

const BAND_MAX_HARMONICS = [32, 24, 16, 10, 6];

function pitchBand(freq) {
  if (freq < 110) return 0;
  if (freq < 240) return 1;
  if (freq < 520) return 2;
  if (freq < 1100) return 3;
  return 4;
}

/** Builds 5 band-limited 2048-sample wavetables from harmonic amplitudes (1-indexed). */
function buildBandTables(harmonics, phaseSeed = 0) {
  const tables = new Array(BAND_MAX_HARMONICS.length);
  for (let b = 0; b < BAND_MAX_HARMONICS.length; b++) {
    const limit = Math.min(harmonics.length, BAND_MAX_HARMONICS[b]);
    const table = new Float32Array(TABLE_SIZE);
    let peak = 0;
    for (let h = 0; h < limit; h++) {
      const amp = harmonics[h];
      if (!amp) continue;
      const order = h + 1;
      const taper = limit > 4 ? Math.cos((h / (limit + 1)) * (Math.PI * 0.42)) : 1;
      const weight = amp * taper;
      const phi0 = phaseSeed * order + h * h * 0.37;
      for (let i = 0; i < TABLE_SIZE; i++) {
        table[i] += weight * Math.sin((TWO_PI * order * i) / TABLE_SIZE + phi0);
      }
    }
    for (let i = 0; i < TABLE_SIZE; i++) {
      const a = Math.abs(table[i]);
      if (a > peak) peak = a;
    }
    if (peak > 1e-6) {
      const inv = 1 / peak;
      for (let i = 0; i < TABLE_SIZE; i++) table[i] *= inv;
    }
    tables[b] = table;
  }
  return tables;
}

function sampleTable(table, phase) {
  const pos = phase * TABLE_SIZE;
  const i0 = pos | 0;
  const frac = pos - i0;
  const a = table[i0 & TABLE_MASK];
  const b = table[(i0 + 1) & TABLE_MASK];
  return a + (b - a) * frac;
}

/**
 * Prepares a decoded ElevenLabs recording for zero-latency playback:
 * trims MP3 decoder pre-padding to <0.8 ms, normalizes peak level, and (for sustaining
 * wind/string/brass zones) snaps `loopStart` and `loopEnd` to phase-correlated rising
 * zero-crossings with an in-phase cosine crossfade baked across the seam.
 */
export function prepareSampleZone(entry) {
  const sr = entry.sampleRate || 44100;
  const src = entry.pcm;
  if (!src || src.length < 256) return null;

  let peak = 0;
  for (let i = 0; i < src.length; i++) {
    const a = Math.abs(src[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return null;

  const onsetThresh = peak * 0.03;
  let onset = 0;
  for (let i = 0; i < src.length; i++) {
    if (Math.abs(src[i]) >= onsetThresh) { onset = i; break; }
  }
  const pre = Math.round(sr * 0.0008);
  const trimStart = Math.max(0, onset - pre);
  const pcm = new Float32Array(src.length - trimStart);
  const norm = 0.88 / peak;
  for (let i = 0; i < pcm.length; i++) pcm[i] = src[trimStart + i] * norm;

  const rampIn = Math.min(Math.round(sr * 0.0008), pcm.length >> 4);
  for (let i = 0; i < rampIn; i++) {
    pcm[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / rampIn);
  }

  const rootHz = entry.rootHz || 0;
  let loop = Boolean(entry.loop) && rootHz > 20 && pcm.length > sr * 0.6;
  let loopStart = 0;
  let loopEnd = pcm.length;

  if (loop) {
    const period = sr / rootHz;
    const rawStart = Math.max(
      Math.round(sr * 0.18),
      Math.round((entry.loopStartSec || 0.28) * sr) - trimStart,
    );
    const rawEnd = Math.min(
      pcm.length - Math.round(sr * 0.04),
      Math.max(rawStart + Math.round(sr * 0.24), Math.round((entry.loopEndSec || 1.2) * sr) - trimStart),
    );

    // Snap loopStart to a rising zero-crossing.
    loopStart = rawStart;
    const searchStartEnd = Math.min(pcm.length - 4, rawStart + Math.ceil(period * 1.5));
    for (let i = rawStart; i < searchStartEnd; i++) {
      if (pcm[i - 1] <= 0 && pcm[i] > 0) { loopStart = i; break; }
    }

    // Snap loopEnd near an integer multiple of `period` with best 1-cycle correlation.
    const cycles = Math.max(6, Math.round((rawEnd - loopStart) / period));
    const targetEnd = Math.min(rawEnd, Math.round(loopStart + cycles * period));
    const winLen = Math.max(16, Math.min(Math.round(period), pcm.length - targetEnd - 4));
    const searchLo = Math.max(loopStart + Math.round(period * 4), targetEnd - Math.ceil(period));
    const searchHi = Math.min(pcm.length - winLen - 2, targetEnd + Math.ceil(period));

    let bestEnd = targetEnd;
    let bestCorr = -Infinity;
    for (let i = searchLo; i <= searchHi; i++) {
      if (pcm[i - 1] <= 0 && pcm[i] > 0) {
        let corr = 0;
        for (let k = 0; k < winLen; k += 2) corr += pcm[loopStart + k] * pcm[i + k];
        if (corr > bestCorr) {
          bestCorr = corr;
          bestEnd = i;
        }
      }
    }
    loopEnd = bestEnd;

    if (loopEnd - loopStart < sr * 0.12) {
      loop = false;
    } else {
      // Bake an in-phase cosine crossfade before `loopEnd` matching pre-`loopStart`
      // so wrapping `pos` from `loopEnd` -> `loopStart` is C1-continuous.
      const xfade = Math.min(
        loopStart - 2,
        Math.floor((loopEnd - loopStart) * 0.35),
        Math.max(Math.round(period * 2), Math.round(sr * 0.028)),
      );
      if (xfade > 8) {
        for (let k = 0; k < xfade; k++) {
          const alpha = 0.5 - 0.5 * Math.cos((Math.PI * (k + 1)) / (xfade + 1));
          const dst = loopEnd - xfade + k;
          const srcIdx = loopStart - xfade + k;
          pcm[dst] = pcm[dst] * (1 - alpha) + pcm[srcIdx] * alpha;
        }
      }
    }
  }

  return {
    id: entry.id,
    patch: entry.patch,
    kind: entry.kind,
    sampleRate: sr,
    rootHz,
    loop,
    loopStart,
    loopEnd,
    loopSpan: Math.max(1, loopEnd - loopStart),
    pcm,
  };
}

function zoneAt(zone, idx) {
  if (idx < 0) return 0;
  if (zone.loop) {
    if (idx >= zone.loopEnd) {
      idx = zone.loopStart + ((idx - zone.loopStart) % zone.loopSpan);
    }
    return zone.pcm[idx];
  }
  return idx < zone.pcm.length ? zone.pcm[idx] : 0;
}

/** 4-point Catmull-Rom / Hermite cubic resampler for crisp acoustic transposition. */
function readSampleHermite(zone, pos) {
  if (!zone.loop && pos >= zone.pcm.length) return 0;
  const i0 = pos | 0;
  const t = pos - i0;
  const ym1 = zoneAt(zone, i0 - 1);
  const y0 = zoneAt(zone, i0);
  const y1 = zoneAt(zone, i0 + 1);
  const y2 = zoneAt(zone, i0 + 2);
  const a0 = -0.5 * ym1 + 1.5 * y0 - 1.5 * y1 + 0.5 * y2;
  const a1 = ym1 - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
  const a2 = -0.5 * ym1 + 0.5 * y1;
  return ((a0 * t + a1) * t + a2) * t + y0;
}

const PATCH_SPECS = {
  grand_piano: {
    body: [1.00, 0.44, 0.24, 0.14, 0.09, 0.06, 0.04, 0.025, 0.016, 0.01],
    attack: [1.00, 0.78, 0.58, 0.44, 0.34, 0.26, 0.20, 0.15, 0.11, 0.08, 0.06, 0.045, 0.03, 0.02],
    gain: 0.92, sampleGain: 1.05,
    attackTime: 0.0022, sampleAttack: 0.0012,
    brightDecay: 0.17, brightFloor: 0.16,
    naturalDecay: 1.65, sustainFloor: 0.38,
    releaseTime: 0.22,
    detuneCents: 1.8, detuneMix: 0.34,
    hammerAmt: 0.20,
    reverbSend: 0.24,
  },
  electric_piano: {
    body: [1.00, 0.20, 0.09, 0.03, 0.015],
    attack: [1.00, 0.48, 0.28, 0.16, 0.10, 0.08, 0.14, 0.05],
    gain: 0.90, sampleGain: 1.02,
    attackTime: 0.002, sampleAttack: 0.0012,
    brightDecay: 0.14, brightFloor: 0.12,
    naturalDecay: 1.85, sustainFloor: 0.42,
    releaseTime: 0.24,
    detuneCents: 4.5, detuneMix: 0.38,
    tineRatio: 7.0, tineAmt: 0.22, tineDecay: 0.09,
    reverbSend: 0.27,
  },
  nylon_guitar: {
    body: [1.00, 0.36, 0.18, 0.07, 0.03, 0.012],
    attack: [1.00, 0.72, 0.56, 0.42, 0.32, 0.24, 0.18, 0.13, 0.09, 0.06, 0.04, 0.025],
    gain: 0.92, sampleGain: 1.06,
    attackTime: 0.0018, sampleAttack: 0.0010,
    brightDecay: 0.13, brightFloor: 0.10,
    naturalDecay: 1.30, sustainFloor: 0.34,
    releaseTime: 0.21,
    detuneCents: 2.2, detuneMix: 0.26,
    hammerAmt: 0.24,
    vibratoRate: 5.3, vibratoDepth: 0.0018, vibratoDelay: 0.16,
    reverbSend: 0.25,
  },
  violin_ensemble: {
    body: [1.00, 0.52, 0.35, 0.25, 0.18, 0.13, 0.095, 0.07, 0.05, 0.035, 0.022, 0.014],
    attack: [1.00, 0.65, 0.48, 0.36, 0.28, 0.21, 0.16, 0.12, 0.09, 0.065, 0.045, 0.03],
    gain: 0.84, sampleGain: 0.96,
    attackTime: 0.022, sampleAttack: 0.014,
    brightDecay: 0.22, brightFloor: 0.48,
    naturalDecay: 0, sustainFloor: 1.0,
    releaseTime: 0.18,
    ensemble: true,
    detuneCents: 6.5,
    chiffAmt: 0.045,
    vibratoRate: 5.4, vibratoDepth: 0.0032, vibratoDelay: 0.11,
    reverbSend: 0.32,
  },
  concert_flute: {
    body: [1.00, 0.24, 0.16, 0.05, 0.035, 0.012],
    attack: [1.00, 0.42, 0.30, 0.14, 0.09, 0.04, 0.02],
    gain: 0.88, sampleGain: 0.98,
    attackTime: 0.015, sampleAttack: 0.010,
    brightDecay: 0.11, brightFloor: 0.30,
    naturalDecay: 0, sustainFloor: 1.0,
    releaseTime: 0.13,
    chiffAmt: 0.13, steadyBreath: 0.015,
    vibratoRate: 5.2, vibratoDepth: 0.0036, vibratoDelay: 0.11,
    reverbSend: 0.30,
  },
  oboe_reed: {
    body: [0.68, 1.00, 0.82, 0.54, 0.36, 0.22, 0.13, 0.08, 0.045, 0.025],
    attack: [0.75, 1.00, 0.92, 0.70, 0.52, 0.36, 0.24, 0.15, 0.09, 0.05],
    gain: 0.84, sampleGain: 0.94,
    attackTime: 0.011, sampleAttack: 0.008,
    brightDecay: 0.14, brightFloor: 0.45,
    naturalDecay: 0, sustainFloor: 1.0,
    releaseTime: 0.12,
    chiffAmt: 0.035,
    vibratoRate: 5.5, vibratoDepth: 0.0030, vibratoDelay: 0.10,
    reverbSend: 0.28,
  },
  french_horn: {
    body: [0.88, 1.00, 0.72, 0.48, 0.30, 0.18, 0.10, 0.055, 0.03, 0.015],
    attack: [0.75, 1.00, 0.92, 0.78, 0.62, 0.48, 0.35, 0.25, 0.17, 0.11, 0.07, 0.04],
    gain: 0.86, sampleGain: 0.96,
    attackTime: 0.013, sampleAttack: 0.009,
    brassBloom: true,
    brightDecay: 0.20, brightFloor: 0.42,
    naturalDecay: 0, sustainFloor: 1.0,
    releaseTime: 0.16,
    detuneCents: 3.5, detuneMix: 0.34,
    vibratoRate: 5.0, vibratoDepth: 0.0022, vibratoDelay: 0.15,
    reverbSend: 0.30,
  },
  vibraphone_celesta: {
    body: [1.00, 0.12, 0.06, 0.18, 0.03],
    attack: [1.00, 0.32, 0.18, 0.42, 0.12, 0.22, 0.06],
    gain: 0.88, sampleGain: 1.04,
    attackTime: 0.0016, sampleAttack: 0.0010,
    brightDecay: 0.15, brightFloor: 0.18,
    naturalDecay: 1.35, sustainFloor: 0.36,
    releaseTime: 0.28,
    detuneCents: 3.0, detuneMix: 0.36,
    tineRatio: 3.98, tineAmt: 0.30, tineDecay: 0.12,
    vibratoRate: 5.8, vibratoDepth: 0.0020, vibratoDelay: 0.05,
    reverbSend: 0.34,
  },
  acoustic_bass: {
    body: [1.00, 0.56, 0.28, 0.12, 0.05, 0.02],
    attack: [1.00, 0.78, 0.54, 0.34, 0.20, 0.11, 0.06, 0.03],
    gain: 0.98, sampleGain: 1.12,
    attackTime: 0.0025, sampleAttack: 0.0012,
    brightDecay: 0.11, brightFloor: 0.22,
    naturalDecay: 1.45, sustainFloor: 0.55,
    releaseTime: 0.070,
    hammerAmt: 0.18,
    reverbSend: 0.08,
  },
  cello_bass: {
    body: [0.92, 1.00, 0.58, 0.34, 0.20, 0.11, 0.06, 0.03],
    attack: [0.90, 1.00, 0.74, 0.52, 0.36, 0.24, 0.15, 0.09, 0.05],
    gain: 0.92, sampleGain: 1.02,
    attackTime: 0.008, sampleAttack: 0.006,
    brightDecay: 0.16, brightFloor: 0.42,
    naturalDecay: 0, sustainFloor: 1.0,
    releaseTime: 0.090,
    detuneCents: 3.5, detuneMix: 0.32,
    vibratoRate: 5.1, vibratoDepth: 0.0024, vibratoDelay: 0.13,
    reverbSend: 0.14,
  },
};

/** Selectable General MIDI orchestration presets exposed to the UI. */
export const MIDI_PRESETS = [
  { id: 'symphonic', name: 'Concert GM' },
  { id: 'jrpg', name: '16-Bit SoundCanvas' },
  { id: 'piano', name: 'Grand Piano & Strings' },
  { id: 'jazz', name: 'Electric & Vibes' },
];

const PRESET_ORCHESTRATION = {
  symphonic: {
    ch1: ['oboe_reed', 'grand_piano', 'nylon_guitar', 'french_horn'],
    ch2: ['violin_ensemble', 'grand_piano', 'concert_flute', 'violin_ensemble'],
    sweep: 'vibraphone_celesta',
    bassSmooth: 'acoustic_bass',
    bassBright: 'cello_bass',
    waveLeadSmooth: 'concert_flute',
    waveLeadBright: 'violin_ensemble',
  },
  jrpg: {
    ch1: ['oboe_reed', 'french_horn', 'nylon_guitar', 'violin_ensemble'],
    ch2: ['oboe_reed', 'french_horn', 'concert_flute', 'violin_ensemble'],
    sweep: 'vibraphone_celesta',
    bassSmooth: 'acoustic_bass',
    bassBright: 'cello_bass',
    waveLeadSmooth: 'concert_flute',
    waveLeadBright: 'french_horn',
  },
  piano: {
    ch1: ['grand_piano', 'grand_piano', 'nylon_guitar', 'violin_ensemble'],
    ch2: ['violin_ensemble', 'grand_piano', 'grand_piano', 'violin_ensemble'],
    sweep: 'vibraphone_celesta',
    bassSmooth: 'acoustic_bass',
    bassBright: 'acoustic_bass',
    waveLeadSmooth: 'grand_piano',
    waveLeadBright: 'violin_ensemble',
  },
  jazz: {
    ch1: ['electric_piano', 'electric_piano', 'nylon_guitar', 'french_horn'],
    ch2: ['oboe_reed', 'vibraphone_celesta', 'electric_piano', 'french_horn'],
    sweep: 'vibraphone_celesta',
    bassSmooth: 'acoustic_bass',
    bassBright: 'cello_bass',
    waveLeadSmooth: 'vibraphone_celesta',
    waveLeadBright: 'electric_piano',
  },
};

let compiledPatches = null;
function getPatches() {
  if (compiledPatches) return compiledPatches;
  compiledPatches = {};
  let seed = 0.13;
  for (const [id, spec] of Object.entries(PATCH_SPECS)) {
    compiledPatches[id] = {
      id,
      ...spec,
      detuneRatioUp: spec.detuneCents ? Math.pow(2, spec.detuneCents / 1200) : 1,
      detuneRatioDown: spec.detuneCents ? Math.pow(2, -spec.detuneCents / 1200) : 1,
      bodyTables: buildBandTables(spec.body, seed),
      attackTables: buildBandTables(spec.attack, seed + 0.21),
    };
    seed += 0.31;
  }
  return compiledPatches;
}

const MAX_VOICES = 32;
const MAX_DRUMS = 12;

const COMB_TIMES_L = [0.0297, 0.0371, 0.0411, 0.0437];
const COMB_STEREO_SPREAD = 0.00052;
const ALLPASS_TIMES = [0.0050, 0.0017];
const CYMBAL_FREQS = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

function makeVoice() {
  return {
    active: false,
    releasing: false,
    channel: 0,
    isArranger: false,
    customAttack: 0,
    patch: null,
    sampleZone: null,
    samplePos: 0,
    samplePos2: 0,
    freq: 440,
    phase1: 0,
    phase2: 0,
    phase3: 0,
    tinePhase: 0,
    vibPhase: 0,
    age: 0,
    releaseAge: 0,
    releaseDuration: 0.15,
    releaseStartGain: 0,
    envSmooth: 0,
    currentGain: 0,
    velocity: 1,
    panL: 0.78,
    panR: 0.78,
    chiffState: 0,
    lpL: 0,
    lpR: 0,
  };
}

function makeDrum() {
  return {
    active: false,
    kind: 'kick',
    sampleZone: null,
    samplePos: 0,
    playbackRate: 1,
    choked: false,
    age: 0,
    duration: 0.25,
    velocity: 1,
    baseFreq: 120,
    phase1: 0,
    phase2: 0,
    cymbalPhases: new Float32Array(6),
    filterLp: 0,
    panL: 0.78,
    panR: 0.78,
    reverbSend: 0.16,
  };
}

export class MidiSynth {
  constructor() {
    this.patches = getPatches();
    this.preset = 'symphonic';
    this.sampleRate = 0;
    this.invRate = 0;
    this.reverbNominalRate = 0;

    // Multi-zone ElevenLabs studio sample bank (`patchId -> [zone, ...]`, `drumKind -> zone`).
    this.samplePatches = Object.create(null);
    this.sampleDrums = Object.create(null);
    this.samplesLoaded = false;
    this.sampleCount = 0;

    this.voices = Array.from({ length: MAX_VOICES }, makeVoice);
    this.channelVoice = [null, null, null, null];
    this.arranger = new HarmonicArranger();
    this.arrangerEnabled = true;

    this.drums = Array.from({ length: MAX_DRUMS }, makeDrum);
    this.noiseSustainGain = 0;
    this.noiseLp = 0;
    this.noiseBp = 0;

    this.rng = 0x9e3779b9;

    this.waveDirty = true;
    this.waveProfile = { silent: true, mult: 1, brightness: 0.3 };

    this.combsL = [];
    this.combsR = [];
    this.allpassL = [];
    this.allpassR = [];
  }

  /**
   * Registers decoded ElevenLabs instrument & drum samples (`[{ id, patch, kind, rootHz, loop, ... }]`).
   */
  loadSampleBank(entries) {
    const patches = Object.create(null);
    const drums = Object.create(null);
    let count = 0;

    for (const raw of entries) {
      const zone = raw.loopSpan ? raw : prepareSampleZone(raw);
      if (!zone) continue;
      count++;
      if (zone.kind === 'drum') {
        drums[zone.patch] = zone;
      } else if (zone.rootHz > 0) {
        if (!patches[zone.patch]) patches[zone.patch] = [];
        patches[zone.patch].push(zone);
      }
    }
    for (const list of Object.values(patches)) {
      list.sort((a, b) => a.rootHz - b.rootHz);
    }

    this.samplePatches = patches;
    this.sampleDrums = drums;
    this.sampleCount = count;
    this.samplesLoaded = count > 0;

    // Upgrade any currently sustaining voices to use the newly loaded ElevenLabs bank.
    for (const v of this.voices) {
      if (v.active && !v.sampleZone && v.patch) {
        const z = this.pickSampleZone(v.patch.id, v.freq);
        if (z) {
          v.sampleZone = z;
          v.samplePos = z.loop ? z.loopStart : 0;
          v.samplePos2 = z.loop ? z.loopStart + z.loopSpan * 0.41 : 0;
        }
      }
    }
    return count;
  }

  pickSampleZone(patchId, freq) {
    const list = this.samplePatches[patchId];
    if (!list || list.length === 0) return null;
    if (list.length === 1) return list[0];
    let best = list[0];
    let bestDist = Math.abs(Math.log2(freq / best.rootHz));
    for (let i = 1; i < list.length; i++) {
      const dist = Math.abs(Math.log2(freq / list[i].rootHz));
      if (dist < bestDist) {
        bestDist = dist;
        best = list[i];
      }
    }
    return best;
  }

  setPreset(id) {
    if (PRESET_ORCHESTRATION[id]) this.preset = id;
  }

  setArrangerEnabled(enabled) {
    const next = Boolean(enabled);
    if (next === this.arrangerEnabled) return;
    this.arrangerEnabled = next;
    if (!next) this.arranger.reset(this);
  }

  setSampleRate(rate) {
    if (rate <= 0) {
      this.sampleRate = 0;
      this.invRate = 0;
      return;
    }
    this.sampleRate = rate;
    this.invRate = 1 / rate;
    const nominal = Math.max(8000, Math.min(192000, Math.round(rate / 4000) * 4000));
    if (nominal !== this.reverbNominalRate) {
      this.reverbNominalRate = nominal;
      this.initReverb(nominal);
    }
  }

  initReverb(rate) {
    this.combsL = COMB_TIMES_L.map((t) => ({
      buf: new Float32Array(Math.max(16, Math.round(t * rate))),
      idx: 0,
      store: 0,
    }));
    this.combsR = COMB_TIMES_L.map((t) => ({
      buf: new Float32Array(Math.max(16, Math.round((t + COMB_STEREO_SPREAD) * rate))),
      idx: 0,
      store: 0,
    }));
    this.allpassL = ALLPASS_TIMES.map((t) => ({
      buf: new Float32Array(Math.max(8, Math.round(t * rate))),
      idx: 0,
    }));
    this.allpassR = ALLPASS_TIMES.map((t) => ({
      buf: new Float32Array(Math.max(8, Math.round((t + 0.00021) * rate))),
      idx: 0,
    }));
  }

  reset() {
    this.arranger.reset(null);
    for (const v of this.voices) { v.active = false; v.releasing = false; }
    this.channelVoice[1] = null;
    this.channelVoice[2] = null;
    this.channelVoice[3] = null;
    for (const d of this.drums) d.active = false;
    this.noiseSustainGain = 0;
    this.noiseLp = 0;
    this.noiseBp = 0;
    this.waveDirty = true;
    for (const c of [...this.combsL, ...this.combsR]) { c.buf.fill(0); c.idx = 0; c.store = 0; }
    for (const a of [...this.allpassL, ...this.allpassR]) { a.buf.fill(0); a.idx = 0; }
  }

  markWaveDirty() {
    this.waveDirty = true;
  }

  whiteNoise() {
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return x * 4.656612873077393e-10;
  }

  analyzeWave(wave) {
    let min = 15, max = 0, sum = 0;
    const samples = new Float32Array(32);
    for (let i = 0; i < 16; i++) {
      const hi = wave[i] >> 4;
      const lo = wave[i] & 0x0f;
      if (hi < min) min = hi;
      if (hi > max) max = hi;
      if (lo < min) min = lo;
      if (lo > max) max = lo;
      samples[i << 1] = hi;
      samples[(i << 1) + 1] = lo;
      sum += hi + lo;
    }
    if (max - min === 0) {
      this.waveProfile = { silent: true, mult: 1, brightness: 0 };
      this.waveDirty = false;
      return this.waveProfile;
    }
    const mean = sum / 32;
    const norm = 2 / Math.max(1, max - min);
    for (let i = 0; i < 32; i++) samples[i] = (samples[i] - mean) * norm;

    const mag = (k) => {
      let re = 0, im = 0;
      for (let n = 0; n < 32; n++) {
        const ang = (TWO_PI * k * n) / 32;
        re += samples[n] * Math.cos(ang);
        im -= samples[n] * Math.sin(ang);
      }
      return Math.hypot(re, im) / 16;
    };

    const m1 = mag(1);
    const m2 = mag(2);
    const m3 = mag(3);
    const m4 = mag(4);
    const m6 = mag(6);

    let mult = 1;
    if (m4 > 3.5 * m1 && m4 > 3.5 * m2 && m4 > 0.2) mult = 4;
    else if (m2 > 3.5 * m1 && m2 > 0.2) mult = 2;

    const fund = mult === 4 ? m4 : mult === 2 ? m2 : Math.max(0.05, m1);
    const upper = mult === 4 ? mag(8) : mult === 2 ? m4 + m6 : m2 * 0.5 + m3 + m4 + m6;
    const brightness = Math.min(1, upper / (fund + upper + 0.05));

    this.waveProfile = { silent: false, mult, brightness };
    this.waveDirty = false;
    return this.waveProfile;
  }

  syncFromApu(apu) {
    this.reset();
    if (!apu.powered) return;
    if (apu.ch1.enabled && apu.ch1.dacOn && apu.ch1.volume > 0) this.noteOn(apu, 1);
    if (apu.ch2.enabled && apu.ch2.dacOn && apu.ch2.volume > 0) this.noteOn(apu, 2);
    if (apu.ch3.enabled && apu.ch3.dacOn && apu.ch3.volumeCode > 0) this.noteOn(apu, 3);
    if (apu.ch4.enabled && apu.ch4.dacOn && apu.ch4.volume > 0) this.triggerDrum(apu);
  }

  onTrigger(apu, channel) {
    if (!apu.powered) return;
    if (channel === 4) {
      this.triggerDrum(apu);
      return;
    }
    this.noteOn(apu, channel);
  }

  channelFrequency(apu, channel) {
    if (channel === 1) return 131072 / (2048 - apu.ch1.freq);
    if (channel === 2) return 131072 / (2048 - apu.ch2.freq);
    const prof = this.waveDirty ? this.analyzeWave(apu.wave) : this.waveProfile;
    if (prof.silent) return 0;
    return (65536 / (2048 - apu.ch3.freq)) * prof.mult;
  }

  channelEnvelopeGain(apu, channel) {
    if (channel === 1) {
      const c = apu.ch1;
      return c.enabled && c.dacOn ? c.volume / 15 : 0;
    }
    if (channel === 2) {
      const c = apu.ch2;
      return c.enabled && c.dacOn ? c.volume / 15 : 0;
    }
    const c = apu.ch3;
    if (!c.enabled || !c.dacOn) return 0;
    const prof = this.waveDirty ? this.analyzeWave(apu.wave) : this.waveProfile;
    return prof.silent ? 0 : WAVE_VOLUME[c.volumeCode];
  }

  channelPan(nr51, channel) {
    const maskL = 0x10 << (channel - 1);
    const maskR = 0x01 << (channel - 1);
    const l = (nr51 & maskL) !== 0;
    const r = (nr51 & maskR) !== 0;
    if (!l && !r) return [0, 0];
    if (l && !r) return [0.95, 0.20];
    if (!l && r) return [0.20, 0.95];
    if (channel === 1) return [0.84, 0.70];
    if (channel === 2) return [0.70, 0.84];
    return [0.78, 0.78];
  }

  selectPatch(apu, channel, freq) {
    const orch = PRESET_ORCHESTRATION[this.preset] || PRESET_ORCHESTRATION.symphonic;
    if (channel === 1) {
      const c1 = apu.ch1;
      if (c1.sweepEnabled && c1.sweepPeriod > 0 && c1.sweepShift > 0) {
        return this.patches[orch.sweep];
      }
      return this.patches[orch.ch1[c1.duty & 3]];
    }
    if (channel === 2) {
      return this.patches[orch.ch2[apu.ch2.duty & 3]];
    }
    const prof = this.waveDirty ? this.analyzeWave(apu.wave) : this.waveProfile;
    const bright = prof.brightness > 0.42;
    if (freq > 230) {
      return this.patches[bright ? orch.waveLeadBright : orch.waveLeadSmooth];
    }
    return this.patches[bright ? orch.bassBright : orch.bassSmooth];
  }

  releaseVoice(v, fastScale = 1) {
    if (!v || !v.active || v.releasing) return;
    if (v.currentGain < 0.001) {
      v.active = false;
      return;
    }
    v.releasing = true;
    v.releaseAge = 0;
    v.releaseStartGain = v.currentGain;
    v.releaseDuration = Math.max(0.025, v.patch.releaseTime * fastScale);
  }

  allocVoice() {
    for (const v of this.voices) {
      if (!v.active) return v;
    }
    let victim = this.voices[0];
    let bestScore = Infinity;
    for (const v of this.voices) {
      // Never steal an active non-releasing Game Boy channel if any releasing or arranger voice exists.
      const base = v.releasing ? 0 : (v.isArranger ? 5 : 25);
      const score = base + v.currentGain;
      if (score < bestScore) {
        bestScore = score;
        victim = v;
      }
    }
    for (let ch = 1; ch <= 3; ch++) {
      if (this.channelVoice[ch] === victim) this.channelVoice[ch] = null;
    }
    return victim;
  }

  /** Spawns a polyphonic accompaniment voice managed by `HarmonicArranger`. */
  spawnArrangerVoice(patchId, freq, gain, panL, panR) {
    if (freq < 27 || freq > 4200 || gain <= 0.005) return null;
    const patch = this.patches[patchId] || this.patches.violin_ensemble;
    const zone = this.pickSampleZone(patch.id, freq);
    const v = this.allocVoice();
    v.active = true;
    v.releasing = false;
    v.channel = 0;
    v.isArranger = true;
    // Sustaining pads/counter-melodies swell gently (24 ms); plucked arps stay crisp (3 ms).
    const plucked = patchId === 'nylon_guitar' || patchId === 'grand_piano' ||
        patchId === 'vibraphone_celesta' || patchId === 'acoustic_bass';
    v.customAttack = plucked ? 0.003 : 0.024;
    v.patch = patch;
    v.sampleZone = zone;
    v.samplePos = 0;
    v.samplePos2 = zone && zone.loop ? zone.loopStart + zone.loopSpan * 0.41 : 0;
    v.freq = freq;
    v.phase1 = (this.whiteNoise() * 0.5 + 0.5) * 0.25;
    v.phase2 = (v.phase1 + 0.37) % 1;
    v.phase3 = (v.phase1 + 0.71) % 1;
    v.tinePhase = 0;
    v.vibPhase = 0;
    v.age = 0;
    v.releaseAge = 0;
    v.envSmooth = gain;
    v.currentGain = 0;
    v.velocity = Math.max(0.22, Math.min(0.75, gain * 1.65));
    v.panL = panL;
    v.panR = panR;
    v.chiffState = 0;
    v.lpL = 0;
    v.lpR = 0;
    return v;
  }

  /** Spawns a soft off-beat closed hi-hat brush tick for rhythmic drum grooves. */
  spawnGhostHat(apu, velocity) {
    let slot = null;
    for (const d of this.drums) {
      if (!d.active) { slot = d; break; }
    }
    if (!slot) return;
    const [panL, panR] = this.channelPan(apu.nr51, 4);
    if (panL === 0 && panR === 0) return;
    const sampleZone = this.sampleDrums.closed_hat || null;
    const playbackRate = 1.04 + this.whiteNoise() * 0.02;
    slot.active = true;
    slot.kind = 'closed_hat';
    slot.sampleZone = sampleZone;
    slot.samplePos = 0;
    slot.playbackRate = playbackRate;
    slot.choked = false;
    slot.age = 0;
    slot.duration = sampleZone
      ? Math.min(0.095, sampleZone.pcm.length / (sampleZone.sampleRate * playbackRate))
      : 0.055;
    slot.velocity = velocity;
    slot.baseFreq = 120;
    slot.phase1 = 0;
    slot.phase2 = 0;
    slot.cymbalPhases.fill(0);
    slot.filterLp = 0;
    slot.panL = Math.max(0, Math.min(1, panL - 0.12));
    slot.panR = Math.max(0, Math.min(1, panR + 0.12));
    slot.reverbSend = 0.10;
  }

  noteOn(apu, channel) {
    const prev = this.channelVoice[channel];
    if (prev) {
      let tails = 0;
      for (const v of this.voices) {
        if (v.active && v.releasing && v.channel === channel) tails++;
      }
      const scale = channel === 3 ? 0.55 : tails >= 2 ? 0.45 : 1.0;
      this.releaseVoice(prev, scale);
      this.channelVoice[channel] = null;
    }

    const ch = channel === 1 ? apu.ch1 : channel === 2 ? apu.ch2 : apu.ch3;
    if (!ch.enabled || !ch.dacOn) return;
    const initGain = this.channelEnvelopeGain(apu, channel);
    const rising = channel <= 2 && ch.envUp && ch.envPeriod > 0;
    if (initGain <= 0 && !rising) return;

    const freq = this.channelFrequency(apu, channel);
    if (freq < 20 || freq > 6000) return;

    const patch = this.selectPatch(apu, channel, freq);
    const zone = this.pickSampleZone(patch.id, freq);
    const v = this.allocVoice();
    const [panL, panR] = this.channelPan(apu.nr51, channel);
    v.active = true;
    v.releasing = false;
    v.channel = channel;
    v.isArranger = false;
    v.customAttack = 0;
    v.patch = patch;
    v.sampleZone = zone;
    v.samplePos = 0;
    v.samplePos2 = zone && zone.loop ? zone.loopStart + zone.loopSpan * 0.41 : 0;
    v.freq = freq;
    v.phase1 = (this.whiteNoise() * 0.5 + 0.5) * 0.25;
    v.phase2 = (v.phase1 + 0.37) % 1;
    v.phase3 = (v.phase1 + 0.71) % 1;
    v.tinePhase = 0;
    v.vibPhase = 0;
    v.age = 0;
    v.releaseAge = 0;
    v.envSmooth = initGain;
    v.currentGain = 0;
    v.velocity = rising ? 0.65 : Math.max(0.2, Math.pow(initGain, 0.75));
    v.panL = panL;
    v.panR = panR;
    v.chiffState = 0;
    v.lpL = 0;
    v.lpR = 0;
    this.channelVoice[channel] = v;
  }

  triggerDrum(apu) {
    const c4 = apu.ch4;
    if (!c4.enabled || !c4.dacOn) return;
    const initGain = c4.volume / 15;
    if (initGain <= 0 && !(c4.envUp && c4.envPeriod > 0)) return;

    const divisor = NOISE_DIVISOR[c4.divisorCode] << c4.shift;
    const fLfsr = 4194304 / Math.max(8, divisor);

    let kind;
    let duration;
    let baseFreq = 120;
    let reverbSend = 0.16;
    let playbackRate = 1 + this.whiteNoise() * 0.016; // subtle human round-robin nuance

    if (c4.widthMode) {
      kind = 'metallic';
      baseFreq = Math.max(95, Math.min(1400, fLfsr / 15));
      playbackRate = Math.max(0.65, Math.min(1.75, baseFreq / 240));
      duration = 0.24;
      reverbSend = 0.20;
    } else if (fLfsr >= 14000) {
      const shortHit = (c4.envPeriod > 0 && c4.envPeriod <= 2 && !c4.envUp) ||
          (c4.lengthEnabled && c4.length <= 22);
      if (shortHit) {
        kind = 'closed_hat';
        duration = 0.12;
        reverbSend = 0.12;
        for (const d of this.drums) {
          if (d.active && d.kind === 'open_hat') {
            d.choked = true;
            d.duration = Math.min(d.duration, d.age + 0.016);
          }
        }
      } else {
        kind = 'open_hat';
        duration = 0.48;
        reverbSend = 0.20;
      }
    } else if (fLfsr >= 3200) {
      kind = 'snare';
      baseFreq = 188;
      duration = 0.34;
      reverbSend = 0.22;
    } else if (fLfsr >= 850) {
      kind = 'tom';
      baseFreq = 96 + (fLfsr - 850) * 0.022;
      playbackRate = Math.max(0.78, Math.min(1.28, baseFreq / 118));
      duration = 0.40;
      reverbSend = 0.20;
    } else {
      kind = 'kick';
      baseFreq = 48;
      duration = 0.38;
      reverbSend = 0.08;
    }

    const sampleZone = this.sampleDrums[kind] || null;
    if (sampleZone) {
      const sampleDur = sampleZone.pcm.length / (sampleZone.sampleRate * playbackRate);
      duration = kind === 'closed_hat' ? Math.min(0.16, sampleDur) : sampleDur;
    }

    let slot = null;
    for (const d of this.drums) {
      if (!d.active) { slot = d; break; }
    }
    if (!slot) {
      slot = this.drums[0];
      for (const d of this.drums) if (d.age > slot.age) slot = d;
    }

    const [panL, panR] = this.channelPan(apu.nr51, 4);
    slot.active = true;
    slot.kind = kind;
    slot.sampleZone = sampleZone;
    slot.samplePos = 0;
    slot.playbackRate = playbackRate;
    slot.choked = false;
    slot.age = 0;
    slot.duration = duration;
    slot.velocity = initGain > 0 ? Math.pow(initGain, 0.8) : 0.45;
    slot.baseFreq = baseFreq;
    slot.phase1 = 0;
    slot.phase2 = 0;
    slot.cymbalPhases.fill(0);
    slot.filterLp = 0;
    const kitBias = kind === 'closed_hat' || kind === 'open_hat' ? 0.10 : kind === 'tom' ? -0.08 : 0;
    slot.panL = Math.max(0, Math.min(1, panL - kitBias));
    slot.panR = Math.max(0, Math.min(1, panR + kitBias));
    slot.reverbSend = reverbSend;
    if (this.arrangerEnabled) this.arranger.onDrumTrigger();
  }

  /** Synthesizes one stereo output frame [left, right] at `this.sampleRate`. */
  renderSample(apu, outPair) {
    if (!apu.powered || this.sampleRate <= 0) {
      outPair[0] = 0;
      outPair[1] = 0;
      return;
    }

    const dt = this.invRate;
    const envSlew = Math.min(1, dt * 260);

    for (let ch = 1; ch <= 3; ch++) {
      const v = this.channelVoice[ch];
      const liveGain = this.channelEnvelopeGain(apu, ch);
      const liveFreq = liveGain > 0 ? this.channelFrequency(apu, ch) : 0;
      const [panL, panR] = this.channelPan(apu.nr51, ch);
      const audible = liveGain > 0 && liveFreq >= 20 && liveFreq <= 6000 && (panL > 0 || panR > 0);

      if (v) {
        if (!audible) {
          if (v.age < 0.002 || v.currentGain < 0.002) v.active = false;
          else this.releaseVoice(v, 1.0);
          this.channelVoice[ch] = null;
        } else {
          v.freq = liveFreq;
          v.panL = panL;
          v.panR = panR;
          v.envSmooth += (liveGain - v.envSmooth) * envSlew;
          if (ch <= 2) {
            const nextPatch = this.selectPatch(apu, ch, liveFreq);
            if (nextPatch !== v.patch) {
              v.patch = nextPatch;
              const nextZone = this.pickSampleZone(nextPatch.id, liveFreq);
              if (nextZone !== v.sampleZone) {
                v.sampleZone = nextZone;
                if (nextZone && nextZone.loop) {
                  v.samplePos = nextZone.loopStart;
                  v.samplePos2 = nextZone.loopStart + nextZone.loopSpan * 0.41;
                }
              }
            }
          }
        }
      } else if (audible) {
        this.noteOn(apu, ch);
      }
    }

    if (this.arrangerEnabled) {
      this.arranger.step(dt, apu, this);
    }

    let dryL = 0, dryR = 0;
    let revSendL = 0, revSendR = 0;

    // --- Melodic polyphonic voices ---------------------------------------------------
    for (let i = 0; i < MAX_VOICES; i++) {
      const v = this.voices[i];
      if (!v.active) continue;

      const patch = v.patch;
      const zone = v.sampleZone;
      v.age += dt;

      let amp;
      if (v.releasing) {
        v.releaseAge += dt;
        if (v.releaseAge >= v.releaseDuration) {
          v.active = false;
          continue;
        }
        const r = 1 - v.releaseAge / v.releaseDuration;
        amp = v.releaseStartGain * r * r;
      } else if (zone) {
        // Real ElevenLabs recordings already carry their own natural acoustic decay.
        const atkDur = v.customAttack || patch.sampleAttack;
        const atk = v.age < atkDur ? v.age / atkDur : 1;
        amp = v.envSmooth * atk * patch.sampleGain;
        v.currentGain = amp;
      } else {
        const atkDur = v.customAttack || patch.attackTime;
        const attack = v.age < atkDur ? v.age / atkDur : 1;
        let acousticSustain = 1;
        if (patch.naturalDecay > 0) {
          acousticSustain = patch.sustainFloor +
              (1 - patch.sustainFloor) * Math.exp(-v.age / patch.naturalDecay);
        }
        amp = v.envSmooth * attack * acousticSustain * patch.gain;
        v.currentGain = amp;
      }

      if (amp < 1e-4 && v.releasing) {
        v.active = false;
        continue;
      }

      let freq = v.freq;
      if (patch.vibratoDepth) {
        v.vibPhase += patch.vibratoRate * dt;
        if (v.vibPhase >= 1) v.vibPhase -= 1;
        if (v.age > patch.vibratoDelay) {
          const fade = Math.min(1, (v.age - patch.vibratoDelay) * 6);
          freq *= 1 + Math.sin(TWO_PI * v.vibPhase) * patch.vibratoDepth * fade;
        }
      }

      let sigL = 0, sigR = 0;

      if (zone) {
        // --- ElevenLabs Multi-Sampled Studio Playback --------------------------------
        const ratio = Math.max(0.22, Math.min(4.2, freq / zone.rootHz)) * (zone.sampleRate * dt);
        const s1 = readSampleHermite(zone, v.samplePos);
        v.samplePos += ratio;
        if (zone.loop && v.samplePos >= zone.loopEnd) {
          v.samplePos = zone.loopStart + ((v.samplePos - zone.loopStart) % zone.loopSpan);
        }

        if (patch.ensemble && zone.loop) {
          const s2 = readSampleHermite(zone, v.samplePos2);
          v.samplePos2 += ratio * 1.0044;
          if (v.samplePos2 >= zone.loopEnd) {
            v.samplePos2 = zone.loopStart + ((v.samplePos2 - zone.loopStart) % zone.loopSpan);
          }
          sigL = s1 * 0.76 + s2 * 0.24;
          sigR = s1 * 0.24 + s2 * 0.76;
        } else if (patch.detuneMix) {
          const s2 = readSampleHermite(zone, v.samplePos2);
          v.samplePos2 += ratio * patch.detuneRatioUp;
          if (zone.loop && v.samplePos2 >= zone.loopEnd) {
            v.samplePos2 = zone.loopStart + ((v.samplePos2 - zone.loopStart) % zone.loopSpan);
          }
          const m = patch.detuneMix * 0.55;
          sigL = s1 * (1 - m * 0.35) + s2 * (m * 0.35);
          sigR = s1 * (1 - m * 0.65) + s2 * (m * 0.65);
        } else {
          sigL = s1;
          sigR = s1;
        }

        // If a non-looping struck/plucked recording is held past its natural decay by an
        // organ-style Game Boy note, blend a warm singing floor so it never drops dead.
        if (!zone.loop && !v.releasing) {
          const progress = v.samplePos / zone.pcm.length;
          if (progress > 0.65) {
            const blend = Math.min(1, (progress - 0.65) * 3) * 0.22;
            const inc = freq * dt;
            v.phase1 += inc;
            if (v.phase1 >= 1) v.phase1 -= v.phase1 | 0;
            const body = sampleTable(patch.bodyTables[pitchBand(freq)], v.phase1) * blend;
            sigL += body;
            sigR += body;
          }
        }

        // Velocity-sensitive tone warmth filter (softer notes sound naturally mellower).
        const alpha = Math.min(1, (2200 + 16000 * v.velocity) * dt * TWO_PI);
        v.lpL += (sigL - v.lpL) * alpha;
        v.lpR += (sigR - v.lpR) * alpha;
        sigL = v.lpL;
        sigR = v.lpR;
      } else {
        // --- Band-Limited Acoustic Wavetable Fallback --------------------------------
        const band = pitchBand(freq);
        const bodyTab = patch.bodyTables[band];
        const atkTab = patch.attackTables[band];

        let bright;
        if (patch.brassBloom) {
          const bloom = v.age < 0.036 ? v.age / 0.036 : 1;
          const settle = patch.brightFloor +
              (0.92 - patch.brightFloor) * Math.exp(-Math.max(0, v.age - 0.036) / patch.brightDecay);
          bright = (0.08 + 0.84 * bloom) * (v.age < 0.036 ? 1 : settle / 0.92) * v.velocity;
        } else {
          bright = (patch.brightFloor + (1 - patch.brightFloor) * Math.exp(-v.age / patch.brightDecay)) * v.velocity;
        }
        if (bright > 1) bright = 1;

        const inc = freq * dt;
        v.phase1 += inc;
        if (v.phase1 >= 1) v.phase1 -= v.phase1 | 0;

        const s1Body = sampleTable(bodyTab, v.phase1);
        const s1Atk = sampleTable(atkTab, v.phase1);
        sigL = s1Body + (s1Atk - s1Body) * bright;
        sigR = sigL;

        if (patch.ensemble) {
          v.phase2 += inc * patch.detuneRatioDown;
          if (v.phase2 >= 1) v.phase2 -= v.phase2 | 0;
          v.phase3 += inc * patch.detuneRatioUp;
          if (v.phase3 >= 1) v.phase3 -= v.phase3 | 0;
          const s2 = sampleTable(bodyTab, v.phase2) * (1 - bright * 0.5) + sampleTable(atkTab, v.phase2) * (bright * 0.5);
          const s3 = sampleTable(bodyTab, v.phase3) * (1 - bright * 0.5) + sampleTable(atkTab, v.phase3) * (bright * 0.5);
          sigL = sigL * 0.5 + s2 * 0.38 + s3 * 0.12;
          sigR = sigR * 0.5 + s3 * 0.38 + s2 * 0.12;
        } else if (patch.detuneMix) {
          v.phase2 += inc * patch.detuneRatioUp;
          if (v.phase2 >= 1) v.phase2 -= v.phase2 | 0;
          const s2 = sampleTable(bodyTab, v.phase2);
          const m = patch.detuneMix;
          sigL = sigL * (1 - m * 0.35) + s2 * (m * 0.35);
          sigR = sigR * (1 - m * 0.65) + s2 * (m * 0.65);
        }

        if (patch.tineAmt && v.age < patch.tineDecay * 5) {
          const tineFreq = freq * patch.tineRatio;
          if (tineFreq < this.sampleRate * 0.42) {
            v.tinePhase += tineFreq * dt;
            if (v.tinePhase >= 1) v.tinePhase -= v.tinePhase | 0;
            const tine = Math.sin(TWO_PI * v.tinePhase) * patch.tineAmt * v.velocity *
                Math.exp(-v.age / patch.tineDecay);
            sigL += tine;
            sigR += tine;
          }
        }

        if (patch.hammerAmt && v.age < 0.014) {
          const envH = Math.exp(-v.age / 0.0032) * patch.hammerAmt * v.velocity;
          v.chiffState += (this.whiteNoise() - v.chiffState) * Math.min(1, 2200 * dt * TWO_PI);
          const thump = (v.chiffState * 0.55 + Math.sin(TWO_PI * Math.min(1800, freq * 3.1) * v.age) * 0.45) * envH;
          sigL += thump;
          sigR += thump;
        }

        if (patch.chiffAmt || patch.steadyBreath) {
          const chiffEnv = patch.chiffAmt && v.age < 0.06
            ? patch.chiffAmt * Math.exp(-v.age / 0.014)
            : 0;
          const breathAmt = chiffEnv + (patch.steadyBreath || 0);
          if (breathAmt > 1e-4) {
            const n = this.whiteNoise();
            v.chiffState += (n - v.chiffState) * Math.min(0.85, freq * 2.5 * dt * TWO_PI);
            const air = (n - v.chiffState) * breathAmt;
            sigL += air;
            sigR += air;
          }
        }
      }

      const outL = sigL * amp * v.panL;
      const outR = sigR * amp * v.panR;
      dryL += outL;
      dryR += outR;
      revSendL += outL * patch.reverbSend;
      revSendR += outR * patch.reverbSend;
    }

    // --- Studio percussion voices (Channel 4 triggers) -------------------------------
    for (let i = 0; i < MAX_DRUMS; i++) {
      const d = this.drums[i];
      if (!d.active) continue;
      d.age += dt;
      if (d.age >= d.duration) {
        d.active = false;
        continue;
      }

      let sig = 0;
      if (d.sampleZone) {
        sig = readSampleHermite(d.sampleZone, d.samplePos) * d.velocity * 1.12;
        d.samplePos += d.playbackRate * (d.sampleZone.sampleRate * dt);
        const rem = d.duration - d.age;
        if (rem < 0.016) sig *= Math.max(0, rem / 0.016);
      } else {
        const t = d.age;
        if (d.kind === 'kick') {
          const f = d.baseFreq + 112 * Math.exp(-t / 0.022);
          d.phase1 += f * dt;
          if (d.phase1 >= 1) d.phase1 -= 1;
          const body = Math.sin(TWO_PI * d.phase1) * Math.exp(-t / 0.085);
          const click = t < 0.008 ? this.whiteNoise() * Math.exp(-t / 0.0018) * 0.35 : 0;
          sig = (body * 1.15 + click) * d.velocity;
        } else if (d.kind === 'snare') {
          const f1 = d.baseFreq + 45 * Math.exp(-t / 0.014);
          d.phase1 += f1 * dt;
          d.phase2 += (d.baseFreq * 1.76) * dt;
          if (d.phase1 >= 1) d.phase1 -= 1;
          if (d.phase2 >= 1) d.phase2 -= 1;
          const head = (Math.sin(TWO_PI * d.phase1) * 0.65 + Math.sin(TWO_PI * d.phase2) * 0.35) *
              Math.exp(-t / 0.042);
          const n = this.whiteNoise();
          d.filterLp += (n - d.filterLp) * Math.min(0.85, 3400 * dt * TWO_PI);
          const wires = (n - d.filterLp * 0.55) * Math.exp(-t / 0.072) * 0.78;
          sig = (head * 0.72 + wires) * d.velocity;
        } else if (d.kind === 'tom') {
          const f = d.baseFreq * (1 + 0.55 * Math.exp(-t / 0.028));
          d.phase1 += f * dt;
          if (d.phase1 >= 1) d.phase1 -= 1;
          const body = Math.sin(TWO_PI * d.phase1) * Math.exp(-t / 0.082);
          const stick = t < 0.012 ? this.whiteNoise() * Math.exp(-t / 0.003) * 0.28 : 0;
          sig = (body + stick) * d.velocity;
        } else if (d.kind === 'closed_hat' || d.kind === 'open_hat') {
          let metal = 0;
          for (let m = 0; m < 6; m++) {
            let p = d.cymbalPhases[m] + CYMBAL_FREQS[m] * 3.8 * dt;
            if (p >= 1) p -= p | 0;
            d.cymbalPhases[m] = p;
            metal += p < 0.5 ? 1 : -1;
          }
          const n = this.whiteNoise();
          const raw = metal * 0.11 + n * 0.65;
          d.filterLp += (raw - d.filterLp) * Math.min(0.92, 6800 * dt * TWO_PI);
          const hp = raw - d.filterLp;
          const tau = d.kind === 'closed_hat' ? 0.020 : 0.095;
          const tail = 1 - t / d.duration;
          sig = hp * Math.exp(-t / tau) * tail * d.velocity * 0.85;
        } else {
          d.phase1 += d.baseFreq * dt;
          d.phase2 += (d.baseFreq * 1.481) * dt;
          if (d.phase1 >= 1) d.phase1 -= d.phase1 | 0;
          if (d.phase2 >= 1) d.phase2 -= d.phase2 | 0;
          const bell = Math.sin(TWO_PI * d.phase1) * 0.62 + Math.sin(TWO_PI * d.phase2) * 0.38;
          sig = bell * Math.exp(-t / 0.058) * d.velocity * 0.78;
        }
      }

      const outL = sig * d.panL;
      const outR = sig * d.panR;
      dryL += outL;
      dryR += outR;
      revSendL += outL * d.reverbSend;
      revSendR += outR * d.reverbSend;
    }

    // --- Continuous Channel 4 brush/surf texture for held envelopes ------------------
    const c4 = apu.ch4;
    const [nPanL, nPanR] = this.channelPan(apu.nr51, 4);
    const heldNoiseTarget = c4.enabled && c4.dacOn && (nPanL > 0 || nPanR > 0) &&
        (c4.envPeriod === 0 || c4.envUp || c4.envPeriod >= 4)
      ? (c4.volume / 15) * 0.20
      : 0;
    this.noiseSustainGain += (heldNoiseTarget - this.noiseSustainGain) * Math.min(1, dt * 60);
    if (this.noiseSustainGain > 1e-4) {
      const divisor = NOISE_DIVISOR[c4.divisorCode] << c4.shift;
      const cutoff = Math.max(140, Math.min(8000, (4194304 / Math.max(8, divisor)) * 0.35));
      const f = Math.min(0.75, 2 * Math.sin((Math.PI * cutoff) * dt));
      const n = this.whiteNoise();
      this.noiseLp += f * this.noiseBp;
      const hp = n - this.noiseLp - 0.85 * this.noiseBp;
      this.noiseBp += f * hp;
      const tex = (this.noiseBp * 0.7 + this.noiseLp * 0.3) * this.noiseSustainGain;
      dryL += tex * nPanL;
      dryR += tex * nPanR;
      revSendL += tex * nPanL * 0.22;
      revSendR += tex * nPanR * 0.22;
    }

    // --- Stereo concert-hall Schroeder/Freeverb reverb -------------------------------
    let wetL = 0, wetR = 0;
    if (this.combsL.length === 4) {
      const inL = (revSendL * 0.8 + revSendR * 0.2) * 0.25;
      const inR = (revSendR * 0.8 + revSendL * 0.2) * 0.25;
      const feedback = 0.78;
      const damp = 0.32;
      const undamp = 1 - damp;

      for (let i = 0; i < 4; i++) {
        const cL = this.combsL[i];
        const outCL = cL.buf[cL.idx];
        cL.store = outCL * undamp + cL.store * damp;
        cL.buf[cL.idx] = inL + cL.store * feedback;
        if (++cL.idx >= cL.buf.length) cL.idx = 0;
        wetL += outCL;

        const cR = this.combsR[i];
        const outCR = cR.buf[cR.idx];
        cR.store = outCR * undamp + cR.store * damp;
        cR.buf[cR.idx] = inR + cR.store * feedback;
        if (++cR.idx >= cR.buf.length) cR.idx = 0;
        wetR += outCR;
      }

      for (let i = 0; i < 2; i++) {
        const aL = this.allpassL[i];
        const bufL = aL.buf[aL.idx];
        const nextL = -wetL + bufL;
        aL.buf[aL.idx] = wetL + bufL * 0.5;
        if (++aL.idx >= aL.buf.length) aL.idx = 0;
        wetL = nextL;

        const aR = this.allpassR[i];
        const bufR = aR.buf[aR.idx];
        const nextR = -wetR + bufR;
        aR.buf[aR.idx] = wetR + bufR * 0.5;
        if (++aR.idx >= aR.buf.length) aR.idx = 0;
        wetR = nextR;
      }
    }

    const masterL = (((apu.nr50 >> 4) & 7) + 1) / 8;
    const masterR = ((apu.nr50 & 7) + 1) / 8;
    const mixL = (dryL + wetL * 0.85) * masterL * 0.38;
    const mixR = (dryR + wetR * 0.85) * masterR * 0.38;

    outPair[0] = mixL / (1 + Math.abs(mixL) * 0.65);
    outPair[1] = mixR / (1 + Math.abs(mixR) * 0.65);
  }
}
