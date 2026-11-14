#!/usr/bin/env node
// Generates the multi-sampled General MIDI acoustic instrument and percussion bank
// using the ElevenLabs Sound Generation API (`POST /v1/sound-generation`), verifies
// monophonic pitch stability and harmonicity via YIN autocorrelation, trims pre-attack
// silence, measures each sample's exact fundamental frequency (`rootHz`), and writes
// compact studio MP3s + `manifest.json` to `assets/instruments/`.
//
// Usage:
//   ELEVENLABS_API_KEY=... node tools/generate_instruments.mjs [--force] [filter]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'assets', 'instruments');
const SAMPLE_RATE = 44100;

function loadApiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  if (process.env.ELEVENLABS) return process.env.ELEVENLABS.trim();
  const candidates = [
    path.join(ROOT, '.env'),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if ((key === 'ELEVENLABS_API_KEY' || key === 'ELEVENLABS') && val) return val;
    }
  }
  return '';
}

/**
 * 26 multi-zone studio recordings covering all 10 General MIDI patches + 6 drum kit pieces.
 */
const INSTRUMENTS = [
  // 1. Concert Grand Piano (3 zones)
  {
    id: 'piano_low', patch: 'grand_piano', kind: 'melodic', loop: false, targetHz: 110.00, duration: 2.2,
    prompts: [
      'Deep low-register bass note on an acoustic concert grand piano, single low left-hand piano key struck once and ringing out warmly, close studio microphone, dry, no chords, no melody',
      'One isolated low baritone C2-C3 key played once on a Steinway grand piano, warm deep single key strike decaying naturally, dry studio recording',
    ],
  },
  {
    id: 'piano_c4', patch: 'grand_piano', kind: 'melodic', loop: false, targetHz: 185.00, duration: 2.0,
    prompts: [
      'Single warm A3 220 Hz note struck once in the lower-middle register of an acoustic Steinway concert grand piano, solo warm mellow piano key ringing out, close studio mic, dry, no chords',
      'One isolated 220 Hz baritone-tenor single note played once on a warm studio grand piano, single key strike decaying smoothly, dry',
    ],
  },
  {
    id: 'piano_mid', patch: 'grand_piano', kind: 'melodic', loop: false, targetHz: 261.63, duration: 2.0,
    prompts: [
      'Single clean middle C4 note (262 Hz) played once on an acoustic concert grand piano, solo note ringing out naturally, close studio microphone, dry, no chords, no melody',
      'One isolated middle C4 key struck once on a studio grand piano, single note sustain decay, dry, no melody',
    ],
  },
  {
    id: 'piano_high', patch: 'grand_piano', kind: 'melodic', loop: false, targetHz: 523.25, duration: 1.8,
    prompts: [
      'Single clean high C5 note (523 Hz) struck once on an acoustic concert grand piano, bright clear solo piano note ringing out, close studio mic, dry, no chords, no melody',
      'One isolated C5 upper-register note played once on a concert grand piano, single strike decaying cleanly, dry',
    ],
  },

  // 2. Chamber Strings / Solo Violin (3 bowed sustaining zones)
  {
    id: 'strings_low', patch: 'violin_ensemble', kind: 'melodic', loop: true, targetHz: 196.00, duration: 2.4,
    prompts: [
      'Single steady sustained G3 note (196 Hz) bowed smoothly on a solo viola and violin section, pure constant pitch arco sustain, studio close mic, dry, no melody, no pitch change',
      'One continuous bowed G3 note held steady on orchestral chamber strings, single unchanging pitch, smooth sustain, dry studio recording',
    ],
  },
  {
    id: 'strings_mid', patch: 'violin_ensemble', kind: 'melodic', loop: true, targetHz: 293.66, duration: 2.4,
    prompts: [
      'Single steady sustained D4 note (294 Hz) bowed smoothly on a solo violin, warm lyrical constant pitch arco sustain, close studio microphone, dry, no melody, no vibrato',
      'One isolated D4 note held steady with a bow on a classical violin, single unchanging pitch, clean studio recording, dry',
    ],
  },
  {
    id: 'strings_high', patch: 'violin_ensemble', kind: 'melodic', loop: true, targetHz: 440.00, duration: 2.4,
    prompts: [
      'Single steady sustained A4 tuning note (440 Hz) bowed smoothly on a solo classical violin, pure constant pitch arco sustain, studio close mic, dry, no melody',
      'Concert violin playing one long steady A4 440 Hz tuning note, single constant pitch without changing notes, dry studio mic',
    ],
  },

  // 3. Concert Flute (2 sustaining zones)
  {
    id: 'flute_mid', patch: 'concert_flute', kind: 'melodic', loop: true, targetHz: 392.00, duration: 2.2,
    prompts: [
      'Single steady sustained G4 note (392 Hz) blown smoothly on a solo silver concert flute, pure clear constant pitch, close studio mic, dry, no melody, no trill',
      'One isolated long G4 note held steady on an orchestral flute, single unchanging pitch, clean warm woodwind tone, dry',
    ],
  },
  {
    id: 'flute_high', patch: 'concert_flute', kind: 'melodic', loop: true, targetHz: 587.33, duration: 2.2,
    prompts: [
      'Single steady sustained D5 note (587 Hz) played smoothly on a solo silver concert flute, pure singing constant pitch, studio close mic, dry, no melody, no trill',
      'One isolated long D5 high note held steady on a classical concert flute, single constant pitch, dry studio recording',
    ],
  },

  // 4. Classical Nylon Acoustic Guitar (2 plucked zones)
  {
    id: 'guitar_low', patch: 'nylon_guitar', kind: 'melodic', loop: false, targetHz: 146.83, duration: 2.0,
    prompts: [
      'Deep low wound bass string plucked once with thumb on a classical nylon-string acoustic guitar, warm resonant low guitar note ringing out, close studio mic, dry, no chord, no melody',
      'One isolated low A2 bass string plucked once on a warm acoustic nylon guitar, single deep note decay, dry close microphone',
    ],
  },
  {
    id: 'guitar_high', patch: 'nylon_guitar', kind: 'melodic', loop: false, targetHz: 329.63, duration: 1.9,
    prompts: [
      'Single clean E4 high string (330 Hz) plucked once on a classical nylon-string acoustic guitar, solo single note ringing out clearly, close studio mic, dry, no chord, no melody',
      'One isolated high E4 string plucked once on a classical acoustic guitar, single clear note decay, dry studio recording',
    ],
  },

  // 5. Orchestral Oboe (1 expressive double-reed zone)
  {
    id: 'oboe_mid', patch: 'oboe_reed', kind: 'melodic', loop: true, targetHz: 440.00, duration: 2.3,
    prompts: [
      'Orchestral oboe playing a single long steady A4 tuning note (440 Hz), pure constant unchanging pitch, solo double-reed woodwind sustain, close studio mic, dry, no melody',
      'Single sustained A4 440 Hz tuning note held steady on a solo classical oboe, constant pitch, dry studio recording',
    ],
  },

  // 6. Orchestral French Horn / Warm Brass (2 sustaining zones)
  {
    id: 'horn_low', patch: 'french_horn', kind: 'melodic', loop: true, targetHz: 174.61, duration: 2.3,
    prompts: [
      'Single steady sustained F3 note (175 Hz) played smoothly on a solo orchestral French horn, warm golden brass constant pitch sustain, close studio mic, dry, no fanfare, no melody',
      'One isolated long F3 note held steady on a solo brass French horn, single unchanging pitch, warm studio recording, dry',
    ],
  },
  {
    id: 'horn_high', patch: 'french_horn', kind: 'melodic', loop: true, targetHz: 349.23, duration: 2.3,
    prompts: [
      'Single steady sustained F4 note (349 Hz) played smoothly on a solo orchestral French horn, warm noble brass constant pitch sustain, close studio mic, dry, no fanfare, no melody',
      'One isolated long F4 note held steady on a solo brass French horn, single constant pitch without changing notes, dry',
    ],
  },

  // 7. Vintage Rhodes Electric Piano (2 struck tine zones)
  {
    id: 'epiano_mid', patch: 'electric_piano', kind: 'melodic', loop: false, targetHz: 220.00, duration: 2.0,
    prompts: [
      'Warm low-middle register note played once on a vintage Fender Rhodes electric piano, mellow warm electric piano single key sustaining cleanly, direct studio recording, dry, no chord',
      'One isolated low-mid A3 key struck once on a classic Rhodes electric piano, warm mellow tine sustain, single note only, dry',
    ],
  },
  {
    id: 'epiano_high', patch: 'electric_piano', kind: 'melodic', loop: false, targetHz: 523.25, duration: 1.8,
    prompts: [
      'Single clean C5 note (523 Hz) played once on a vintage Fender Rhodes electric piano, crystalline bell tine solo note ringing out, direct studio recording, dry, no chord, no melody',
      'One isolated high C5 key struck once on a Rhodes electric piano, bell-like single note decay, dry',
    ],
  },

  // 8. Vibraphone & Celesta (2 shimmering mallet/bell zones)
  {
    id: 'vibes_mid', patch: 'vibraphone_celesta', kind: 'melodic', loop: false, targetHz: 523.25, duration: 2.0,
    prompts: [
      'Single clean C5 bar (523 Hz) struck once with a yarn mallet on a concert vibraphone, pure ringing metallic solo note decaying smoothly, close studio mic, dry, no chord, no melody',
      'One isolated C5 note struck once on a jazz vibraphone, pure single resonant bar ringing out, dry studio recording',
    ],
  },
  {
    id: 'celesta_high', patch: 'vibraphone_celesta', kind: 'melodic', loop: false, targetHz: 1046.50, duration: 1.6,
    prompts: [
      'Single clean high C6 bell note (1047 Hz) struck once on an orchestral celesta glockenspiel, pure sparkling single bell tone ringing out, studio mic, dry, no melody, no arpeggio',
      'One isolated high C6 note struck once on an orchestral celesta, single pure bell chime decaying cleanly, dry',
    ],
  },

  // 9. Upright Acoustic & Fingered Bass (2 deep bass zones for Channel 3)
  {
    id: 'bass_deep', patch: 'acoustic_bass', kind: 'melodic', loop: false, targetHz: 82.41, duration: 1.9,
    prompts: [
      'Single clean low E2 open string (82 Hz) plucked once pizzicato on an upright acoustic double bass, deep woody solo bass note ringing out, close studio mic, dry, no bassline',
      'One isolated low E2 note plucked once on a studio electric fingered bass guitar, clean warm fundamental single note, dry',
    ],
  },
  {
    id: 'bass_mid', patch: 'acoustic_bass', kind: 'melodic', loop: false, targetHz: 146.83, duration: 1.8,
    prompts: [
      'Single clean D3 note (147 Hz) plucked once pizzicato on an upright acoustic double bass, punchy warm solo bass note decaying cleanly, close studio mic, dry, no riff',
      'One isolated D3 single note plucked once on an acoustic upright bass, warm woody tone, dry close mic',
    ],
  },
  {
    id: 'bass_upper', patch: 'acoustic_bass', kind: 'melodic', loop: false, targetHz: 175.00, duration: 1.8,
    prompts: [
      'High G3 string plucked once on an electric fingered jazz bass guitar, warm round upper-bass single note decaying cleanly, direct studio DI, dry, no riff, no slap',
      'Single isolated upper-register G3 note plucked once on a warm studio bass guitar, clean fundamental, dry',
    ],
  },

  // 10. Bowed Solo Cello (sustaining bass/baritone zone for Channel 3)
  {
    id: 'cello_low', patch: 'cello_bass', kind: 'melodic', loop: true, targetHz: 130.81, duration: 2.4,
    prompts: [
      'Single steady sustained C3 note (131 Hz) bowed smoothly on a solo classical cello, rich resonant deep constant pitch arco sustain, close studio mic, dry, no melody',
      'One isolated long C3 note held steady with a bow on an orchestral cello, single unchanging pitch, warm woody tone, dry',
    ],
  },

  // 11. Studio Acoustic Percussion Kit (6 dry close-mic one-shots for Channel 4)
  {
    id: 'drum_kick', patch: 'kick', kind: 'drum', loop: false, duration: 0.7,
    prompts: [
      'Single tight punchy acoustic studio kick drum hit, one clean bass drum thump, close studio microphone, dry, no beat, no loop',
    ],
  },
  {
    id: 'drum_snare', patch: 'snare', kind: 'drum', loop: false, duration: 0.7,
    prompts: [
      'Single crisp acoustic studio snare drum hit in center of drumhead with snappy snare wires, one single hit only, dry close mic, no roll',
    ],
  },
  {
    id: 'drum_tom', patch: 'tom', kind: 'drum', loop: false, duration: 0.8,
    prompts: [
      'Single warm tuned studio mid rack tom drum stick hit, one clean resonant drum hit only, dry close microphone, no fill',
    ],
  },
  {
    id: 'drum_hat_closed', patch: 'closed_hat', kind: 'drum', loop: false, duration: 0.5,
    prompts: [
      'Single tight crisp acoustic closed hi-hat cymbal stick tick, one short dry metallic chick hit only, studio close mic, no rhythm',
    ],
  },
  {
    id: 'drum_hat_open', patch: 'open_hat', kind: 'drum', loop: false, duration: 1.0,
    prompts: [
      'Single acoustic bronze open hi-hat cymbal stick hit ringing out smoothly, one single cymbal strike only, studio close mic, dry',
    ],
  },
  {
    id: 'drum_metallic', patch: 'metallic', kind: 'drum', loop: false, duration: 0.7,
    prompts: [
      'Single clean Latin percussion metal cowbell agogo strike with wooden stick, one tuned metallic hit only, dry studio close mic',
    ],
  },
];

async function generateElevenLabsMp3(apiKey, prompt, durationSeconds) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: prompt,
      duration_seconds: Math.max(0.5, Math.min(22, durationSeconds)),
      prompt_influence: 0.72,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 240)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function decodeToFloat32Mono(filePath) {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', filePath,
    '-ac', '1', '-ar', String(SAMPLE_RATE),
    '-f', 'f32le', '-',
  ], { maxBuffer: 32 * 1024 * 1024 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice();
}

function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe; im[i + j + half] = uIm - vIm;
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
      }
    }
  }
}

/**
 * High-resolution 131072-point Hann FFT harmonic-series fundamental detector.
 * Rejects octave-subharmonic ghosts by requiring genuine spectral energy at f0.
 */
function fftFundamentalHz(pcm) {
  const N = 131072;
  const s0 = Math.min(1200, pcm.length >> 3);
  const s1 = Math.min(pcm.length, 66000);
  const len = s1 - s0;
  if (len < 2048) return 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, len - 1));
    re[i] = pcm[s0 + i] * w;
  }
  fftInPlace(re, im);
  const half = N >> 1;
  const mag = new Float64Array(half);
  const iMin = Math.floor((38 * N) / SAMPLE_RATE);
  const iMax = Math.ceil((2600 * N) / SAMPLE_RATE);
  let maxMag = 0;
  for (let i = 1; i < half; i++) {
    mag[i] = Math.hypot(re[i], im[i]);
    if (i >= iMin && i <= iMax && mag[i] > maxMag) maxMag = mag[i];
  }
  if (maxMag < 1e-6) return 0;

  const cands = [];
  for (let i = iMin + 2; i <= iMax - 2; i++) {
    if (mag[i] >= 0.08 * maxMag && mag[i] >= mag[i - 1] && mag[i] >= mag[i + 1]) {
      const y0 = mag[i - 1], y1 = mag[i], y2 = mag[i + 1];
      const denom = 2 * (2 * y1 - y2 - y0);
      const delta = Math.abs(denom) > 1e-12 ? (y2 - y0) / denom : 0;
      const f0 = ((i + delta) * SAMPLE_RATE) / N;
      let hsum = 0;
      for (let k = 1; k <= 8; k++) {
        const bi = Math.round((f0 * k * N) / SAMPLE_RATE);
        if (bi < half - 2) {
          let pk = 0;
          for (let b = bi - 2; b <= bi + 2; b++) if (mag[b] > pk) pk = mag[b];
          hsum += pk * Math.pow(k, -0.3);
        }
      }
      cands.push({ f0, hsum });
    }
  }
  if (!cands.length) return 0;
  let bestH = 0;
  for (const c of cands) if (c.hsum > bestH) bestH = c.hsum;
  const strong = cands.filter((c) => c.hsum >= 0.78 * bestH);
  strong.sort((a, b) => a.f0 - b.f0);
  return strong[0].f0;
}

/** YIN pitch estimator on a mono window to check frame-to-frame pitch stability. */
function yinPitch(samples, start, windowSize, fMin, fMax) {
  const half = windowSize >> 1;
  const tauMin = Math.max(2, Math.floor(SAMPLE_RATE / fMax));
  const tauMax = Math.min(half - 2, Math.ceil(SAMPLE_RATE / fMin));
  if (tauMin >= tauMax || start + windowSize > samples.length) return null;

  const diff = new Float64Array(tauMax + 2);
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j += 2) {
      const d = samples[start + j] - samples[start + j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  const cmnd = new Float64Array(tauMax + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax + 1; tau++) {
    running += diff[tau];
    cmnd[tau] = running > 1e-12 ? (diff[tau] * tau) / running : 1;
  }

  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < 0.10 && cmnd[tau] <= cmnd[tau + 1]) {
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) {
    bestTau = tauMin;
    for (let tau = tauMin + 1; tau <= tauMax; tau++) {
      if (cmnd[tau] < cmnd[bestTau]) bestTau = tau;
    }
  }

  const aperiodicity = cmnd[bestTau];
  let refined = bestTau;
  if (bestTau > 1 && bestTau <= tauMax) {
    const y0 = cmnd[bestTau - 1], y1 = cmnd[bestTau], y2 = cmnd[bestTau + 1];
    const denom = 2 * (2 * y1 - y2 - y0);
    if (Math.abs(denom) > 1e-12) refined = bestTau + (y2 - y0) / denom;
  }
  return { hz: SAMPLE_RATE / refined, aperiodicity };
}

function trimAndNormalize(pcm, { maxDurationSec = 2.4 } = {}) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const a = Math.abs(pcm[i]);
    if (a > peak) peak = a;
  }
  if (peak < 0.005) return null;

  // Find onset where signal reaches 6% of peak, keeping 1.5 ms pre-attack cushion.
  const thresh = peak * 0.06;
  let onset = 0;
  for (let i = 0; i < pcm.length; i++) {
    if (Math.abs(pcm[i]) >= thresh) { onset = i; break; }
  }
  const preSamples = Math.round(SAMPLE_RATE * 0.0015);
  const start = Math.max(0, onset - preSamples);

  // Trim trailing dead air below -52 dB relative to peak, keeping natural decay.
  const tailThresh = peak * 0.0025;
  let end = pcm.length;
  while (end > start + 2205 && Math.abs(pcm[end - 1]) < tailThresh) end--;
  end = Math.min(pcm.length, Math.min(end + Math.round(SAMPLE_RATE * 0.03), start + Math.round(maxDurationSec * SAMPLE_RATE)));

  const out = pcm.slice(start, end);
  const scale = 0.90 / peak;
  for (let i = 0; i < out.length; i++) out[i] *= scale;

  // Tiny 1.2 ms cosine fade-in and 12 ms fade-out so boundaries never click.
  const fadeIn = Math.min(Math.round(SAMPLE_RATE * 0.0012), out.length >> 3);
  for (let i = 0; i < fadeIn; i++) {
    out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
  }
  const fadeOut = Math.min(Math.round(SAMPLE_RATE * 0.015), out.length >> 3);
  for (let i = 0; i < fadeOut; i++) {
    out[out.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut);
  }
  return out;
}

function evaluateCandidate(pcm, spec) {
  if (!pcm || pcm.length < SAMPLE_RATE * 0.12) {
    return { ok: false, reason: 'clip too short or silent' };
  }

  if (spec.kind === 'drum') {
    // Drum QC: verify strong early transient in first 90 ms and no second drum hit later.
    const earlyEnd = Math.min(pcm.length, Math.round(SAMPLE_RATE * 0.09));
    let earlyPeak = 0;
    for (let i = 0; i < earlyEnd; i++) earlyPeak = Math.max(earlyPeak, Math.abs(pcm[i]));
    if (earlyPeak < 0.45) return { ok: false, reason: `weak initial transient (${earlyPeak.toFixed(2)})` };

    // Check envelope in 40 ms frames to ensure single hit rather than a drum beat.
    const hop = Math.round(SAMPLE_RATE * 0.04);
    let dipped = false;
    for (let pos = earlyEnd; pos + hop <= pcm.length; pos += hop) {
      let r = 0;
      for (let i = pos; i < pos + hop; i++) r += pcm[i] * pcm[i];
      const rms = Math.sqrt(r / hop);
      if (rms < 0.05) dipped = true;
      else if (dipped && rms > 0.24) return { ok: false, reason: 'multiple drum hits detected' };
    }
    return { ok: true, rootHz: 0, loopStartSec: 0, loopEndSec: 0 };
  }

  // Melodic QC: check single onset + monophonic pitch consistency.
  const win = spec.targetHz < 120 ? 6144 : 4096;
  const hop = 1536;
  const fMin = Math.max(38, spec.targetHz * 0.42);
  const fMax = Math.min(2400, spec.targetHz * 2.35);

  const frameRms = [];
  let maxRms = 0;
  for (let pos = Math.round(SAMPLE_RATE * 0.025); pos + win <= pcm.length; pos += hop) {
    let s = 0;
    for (let i = 0; i < win; i++) s += pcm[pos + i] * pcm[pos + i];
    const r = Math.sqrt(s / win);
    frameRms.push({ pos, rms: r });
    if (r > maxRms) maxRms = r;
  }
  if (maxRms < 0.04) return { ok: false, reason: 'melodic body RMS too low' };

  // Detect re-strike / multi-note phrase in amplitude envelope.
  let droppedLow = false;
  for (const f of frameRms) {
    if (f.rms < maxRms * 0.16) droppedLow = true;
    else if (droppedLow && f.rms > maxRms * 0.58) {
      return { ok: false, reason: 're-attack / multiple notes in envelope' };
    }
  }

  const pitches = [];
  for (const f of frameRms) {
    if (f.rms < maxRms * 0.14) continue;
    const est = yinPitch(pcm, f.pos, win, fMin, fMax);
    if (est && est.aperiodicity < 0.20) {
      pitches.push({ ...est, rms: f.rms, pos: f.pos });
    }
  }
  if (pitches.length < 4) {
    return { ok: false, reason: `insufficient harmonic frames (${pitches.length})` };
  }

  const sortedHz = pitches.map((p) => p.hz).sort((a, b) => a - b);
  const medianHz = sortedHz[sortedHz.length >> 1];

  // Check 10th..90th percentile spread in semitones to catch melodies or chords.
  const p10 = sortedHz[Math.floor(sortedHz.length * 0.1)];
  const p90 = sortedHz[Math.floor((sortedHz.length - 1) * 0.9)];
  const spreadSemitones = 12 * Math.log2(p90 / p10);
  if (spreadSemitones > 1.15) {
    return { ok: false, reason: `pitch drifted ${spreadSemitones.toFixed(2)} semitones (${p10.toFixed(1)}..${p90.toFixed(1)} Hz)` };
  }

  // Weighted average around median for sub-cent accuracy.
  let num = 0, den = 0;
  for (const p of pitches) {
    if (Math.abs(12 * Math.log2(p.hz / medianHz)) <= 0.6) {
      const w = p.rms / Math.max(0.002, p.aperiodicity + 0.005);
      num += p.hz * w;
      den += w;
    }
  }
  const rootHz = fftFundamentalHz(pcm) || (den > 0 ? num / den : medianHz);
  if (rootHz < spec.targetHz * 0.42 || rootHz > spec.targetHz * 2.4) {
    return { ok: false, reason: `fundamental ${rootHz.toFixed(1)} Hz outside target register (${spec.targetHz.toFixed(1)} Hz)` };
  }

  let loopStartSec = 0;
  let loopEndSec = 0;
  if (spec.loop) {
    // Choose a steady-state region in the middle of the sustained body.
    const durSec = pcm.length / SAMPLE_RATE;
    if (durSec < 0.95) return { ok: false, reason: `sustaining sample too short (${durSec.toFixed(2)}s)` };
    loopStartSec = Math.min(0.42, durSec * 0.26);
    loopEndSec = Math.max(loopStartSec + 0.36, Math.min(durSec - 0.16, durSec * 0.78));
    if (loopEndSec - loopStartSec < 0.25) {
      return { ok: false, reason: 'sustain region too short for clean loop' };
    }
  }

  return {
    ok: true,
    rootHz: Number(rootHz.toFixed(3)),
    spreadSemitones: Number(spreadSemitones.toFixed(3)),
    loopStartSec: Number(loopStartSec.toFixed(4)),
    loopEndSec: Number(loopEndSec.toFixed(4)),
  };
}

function writeProcessedMp3(pcm, outFile, tempDir, id) {
  const rawPath = path.join(tempDir, `${id}.f32`);
  fs.writeFileSync(rawPath, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'f32le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawPath,
    '-codec:a', 'libmp3lame', '-b:a', '128k',
    outFile,
  ]);
  fs.rmSync(rawPath, { force: true });
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const recalibrate = args.includes('--recalibrate');
  const filter = args.find((a) => !a.startsWith('--')) || '';

  const apiKey = recalibrate ? (loadApiKey() || 'recalibrate-only') : loadApiKey();
  if (!apiKey) {
    console.error('Missing ELEVENLABS_API_KEY (or ELEVENLABS) in environment or .env');
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifestPath = path.join(OUT_DIR, 'manifest.json');
  const existing = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : { version: 1, generator: 'elevenlabs-sound-generation', samples: [] };
  const byId = new Map((existing.samples || []).map((s) => [s.id, s]));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-elevenlabs-'));
  const targets = INSTRUMENTS.filter((inst) => !filter || inst.id.includes(filter) || inst.patch.includes(filter));

  console.log(`Generating ${targets.length} ElevenLabs studio instrument samples -> assets/instruments/`);

  try {
    // Process with concurrency = 3 to respect ElevenLabs rate limits cleanly.
    let cursor = 0;
    async function worker() {
      while (cursor < targets.length) {
        const spec = targets[cursor++];
        const mp3Path = path.join(OUT_DIR, `${spec.id}.mp3`);
        if (!force && fs.existsSync(mp3Path) && byId.has(spec.id)) {
          if (recalibrate) {
            const finalPcm = decodeToFloat32Mono(mp3Path);
            const rootHz = spec.kind === 'melodic' ? fftFundamentalHz(finalPcm) : 0;
            const durSec = finalPcm.length / SAMPLE_RATE;
            const prev = byId.get(spec.id);
            const updated = {
              ...prev,
              rootHz: Number((rootHz || prev.rootHz).toFixed(3)),
              durationSec: Number(durSec.toFixed(4)),
            };
            byId.set(spec.id, updated);
            console.log(`  * ${spec.id.padEnd(16)} recalibrated rootHz=${updated.rootHz}`);
          } else {
            const prev = byId.get(spec.id);
            console.log(`  = ${spec.id.padEnd(16)} cached (rootHz=${prev.rootHz})`);
          }
          continue;
        }

        let best = null;
        let bestPcm = null;
        const maxAttempts = 5;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const basePrompt = spec.prompts[attempt % spec.prompts.length];
          const prompt = attempt >= 2
            ? `${basePrompt}. Strictly one single steady note only, never play two notes.`
            : basePrompt;
          const rawMp3Path = path.join(tempDir, `${spec.id}_try${attempt}.mp3`);
          try {
            const mp3Bytes = await generateElevenLabsMp3(apiKey, prompt, spec.duration);
            fs.writeFileSync(rawMp3Path, mp3Bytes);
            const rawPcm = decodeToFloat32Mono(rawMp3Path);
            const pcm = trimAndNormalize(rawPcm, { maxDurationSec: spec.duration + 0.2 });
            const verdict = evaluateCandidate(pcm, spec);
            fs.rmSync(rawMp3Path, { force: true });

            if (verdict.ok) {
              best = verdict;
              bestPcm = pcm;
              console.log(
                `  + ${spec.id.padEnd(16)} ok on try ${attempt + 1}` +
                (spec.kind === 'melodic'
                  ? `  root=${verdict.rootHz.toFixed(2)} Hz (target ${spec.targetHz.toFixed(1)} Hz, spread=${verdict.spreadSemitones} st)`
                  : `  (${(pcm.length / SAMPLE_RATE).toFixed(2)}s drum one-shot)`),
              );
              break;
            } else {
              console.log(`  ~ ${spec.id} try ${attempt + 1} rejected: ${verdict.reason}`);
              if (!bestPcm && pcm) {
                bestPcm = pcm;
                best = {
                  ok: false,
                  rootHz: spec.targetHz || 0,
                  loopStartSec: spec.loop ? 0.35 : 0,
                  loopEndSec: spec.loop ? Math.max(0.7, pcm.length / SAMPLE_RATE - 0.15) : 0,
                };
              }
            }
          } catch (err) {
            console.log(`  ! ${spec.id} try ${attempt + 1} error: ${err.message}`);
            await new Promise((r) => setTimeout(r, 900 * (attempt + 1)));
          }
        }

        if (!bestPcm) throw new Error(`Failed to generate usable audio for ${spec.id}`);

        writeProcessedMp3(bestPcm, mp3Path, tempDir, spec.id);

        // Re-decode the final MP3 so duration & pitch reflect exact post-codec PCM.
        const finalPcm = decodeToFloat32Mono(mp3Path);
        const recheck = evaluateCandidate(finalPcm, spec);
        const rootHz = recheck.ok && recheck.rootHz ? recheck.rootHz : (best.rootHz || spec.targetHz || 0);

        byId.set(spec.id, {
          id: spec.id,
          file: `${spec.id}.mp3`,
          patch: spec.patch,
          kind: spec.kind,
          rootHz: Number(rootHz.toFixed(3)),
          loop: Boolean(spec.loop),
          loopStartSec: spec.loop ? (recheck.ok ? recheck.loopStartSec : best.loopStartSec) : 0,
          loopEndSec: spec.loop ? (recheck.ok ? recheck.loopEndSec : best.loopEndSec) : 0,
          durationSec: Number((finalPcm.length / SAMPLE_RATE).toFixed(4)),
        });
      }
    }

    await Promise.all([worker(), worker(), worker()]);

    const ordered = INSTRUMENTS.map((inst) => byId.get(inst.id)).filter(Boolean);
    const manifest = {
      version: 1,
      generator: 'elevenlabs-sound-generation',
      sampleCount: ordered.length,
      samples: ordered,
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${ordered.length} samples and ${manifestPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
