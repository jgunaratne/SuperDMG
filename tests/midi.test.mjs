import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GameBoy } from '../src/core/gameboy.js';
import { MIDI_PRESETS } from '../src/core/midi.js';
import { isConsonantWithGame, midiFromHz } from '../src/core/arranger.js';
import { machine, demoRom } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const idle = () => machine('.spin:\n  jr .spin');

/** Collects `seconds` of stereo audio as { left, right } arrays. */
function recordStereo(gb, seconds, rate = 48000) {
  gb.apu.setSampleRate(rate);
  gb.apu.sampleCount = 0;
  const left = [];
  const right = [];
  for (let frame = 0; frame < Math.round(seconds * 59.7275); frame++) {
    gb.runFrame();
    for (let i = 0; i < gb.apu.sampleCount; i++) {
      left.push(gb.apu.samples[i * 2]);
      right.push(gb.apu.samples[i * 2 + 1]);
    }
    gb.apu.sampleCount = 0;
  }
  return { left, right };
}

/** Magnitude of frequency `targetHz` in `samples` sampled at `rate`. */
function dftMagnitude(samples, targetHz, rate = 48000) {
  let re = 0, im = 0;
  const n = samples.length;
  const step = (2 * Math.PI * targetHz) / rate;
  for (let i = 0; i < n; i++) {
    const a = step * i;
    re += samples[i] * Math.cos(a);
    im -= samples[i] * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / Math.max(1, n);
}

const rms = (arr) => Math.sqrt(arr.reduce((s, x) => s + x * x, 0) / Math.max(1, arr.length));

test('MIDI mode replaces raw 50% square wave with rich even+odd stereo acoustic harmonics', () => {
  const period = Math.round(2048 - 131072 / 440);
  const actualHz = 131072 / (2048 - period);

  // Standard Game Boy 50% duty square wave has only odd harmonics (near-zero 2nd harmonic)
  // and identical L/R channels when centered.
  const gbClassic = idle();
  gbClassic.write(0xff26, 0x80);
  gbClassic.write(0xff24, 0x77);
  gbClassic.write(0xff25, 0x22);
  gbClassic.write(0xff16, 0x80); // 50% duty
  gbClassic.write(0xff17, 0xf0);
  gbClassic.write(0xff18, period & 0xff);
  gbClassic.write(0xff19, 0x80 | (period >> 8));
  const classic = recordStereo(gbClassic, 0.5);
  const classicEvenRatio = dftMagnitude(classic.left, actualHz * 2) / dftMagnitude(classic.left, actualHz);

  // MIDI mode on the same register writes plays grand piano / concert flute with even
  // harmonics, stereo spread and hall reverb.
  const gbMidi = idle();
  gbMidi.apu.setMidiEnabled(true);
  gbMidi.apu.setMidiPreset('piano');
  gbMidi.write(0xff26, 0x80);
  gbMidi.write(0xff24, 0x77);
  gbMidi.write(0xff25, 0x22);
  gbMidi.write(0xff16, 0x80);
  gbMidi.write(0xff17, 0xf0);
  gbMidi.write(0xff18, period & 0xff);
  gbMidi.write(0xff19, 0x80 | (period >> 8));
  const midi = recordStereo(gbMidi, 0.5);

  assert.ok(midi.left.every((s) => Number.isFinite(s) && s >= -1 && s <= 1), 'samples bounded in [-1, 1]');
  assert.ok(midi.right.every((s) => Number.isFinite(s) && s >= -1 && s <= 1), 'right samples bounded');
  const fund = dftMagnitude(midi.left, actualHz);
  const second = dftMagnitude(midi.left, actualHz * 2);
  assert.ok(fund > 0.04, `fundamental at ${actualHz.toFixed(1)} Hz is strong (${fund.toFixed(3)})`);
  assert.ok(second / fund > 0.25 && classicEvenRatio < 0.05,
    `MIDI grand piano has rich 2nd harmonic (${(second / fund).toFixed(2)} vs square ${classicEvenRatio.toFixed(3)})`);

  let stereoDiff = 0;
  for (let i = 0; i < midi.left.length; i++) stereoDiff = Math.max(stereoDiff, Math.abs(midi.left[i] - midi.right[i]));
  assert.ok(stereoDiff > 0.01, 'stereo unison detune and hall reverb create true stereo width');
});

test('MIDI polyphonic release tail rings naturally while preserving exact NR52 hardware timing', () => {
  const gb = idle();
  gb.apu.setMidiEnabled(true);
  gb.apu.setSampleRate(48000);
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0xff);
  gb.write(0xff16, 0x40); // 25% duty -> Grand Piano
  gb.write(0xff17, 0xf0);
  const period = Math.round(2048 - 131072 / 523.25); // C5
  gb.write(0xff18, period & 0xff);
  gb.write(0xff19, 0xc0 | (period >> 8)); // length enabled (64 steps = 0.25s)

  // Play while active, then wait until length counter turns hardware channel off.
  recordStereo(gb, 0.20);
  assert.equal(gb.peek(0xff26) & 0x02, 0x02, 'NR52 still active at 200ms');
  recordStereo(gb, 0.08);
  assert.equal(gb.peek(0xff26) & 0x02, 0x00, 'NR52 reports channel off on schedule');

  // Even after NR52 bit 1 is 0, the piano release + concert reverb tail rings smoothly,
  // then settles to silence.
  const tail = recordStereo(gb, 0.12);
  assert.ok(rms(tail.left) > 0.005, 'acoustic release and reverb continue after gate-off');
  const settled = recordStereo(gb, 0.7);
  const endSlice = settled.left.slice(-4000);
  assert.ok(rms(endSlice) < 0.002, 'release tail decays cleanly to silence');
});

test('Wave RAM multi-cycle detection and flat-table silence work accurately', () => {
  const gb = idle();
  gb.apu.setMidiEnabled(true);
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0x44);

  // Flat zero wave RAM should stay silent even when CH3 is triggered.
  gb.write(0xff1a, 0x80);
  gb.write(0xff1c, 0x20);
  const period = 2048 - 596; // 65536 / 596 ~= 110 Hz for 1-cycle, ~220 Hz for 2-cycle
  gb.write(0xff1d, period & 0xff);
  gb.write(0xff1e, 0x80 | (period >> 8));
  const flat = recordStereo(gb, 0.15);
  assert.ok(rms(flat.left) < 1e-4, 'flat wave RAM produces silence');

  // Write a 2-cycle triangle wave across the 32 nibbles (16 nibbles per cycle).
  gb.write(0xff1a, 0x00);
  const nibbles = [0, 2, 4, 6, 8, 10, 12, 14, 15, 13, 11, 9, 7, 5, 3, 1];
  for (let i = 0; i < 16; i++) {
    const hi = nibbles[(i * 2) % 16];
    const lo = nibbles[(i * 2 + 1) % 16];
    gb.write(0xff30 + i, (hi << 4) | lo);
  }
  gb.write(0xff1a, 0x80);
  gb.write(0xff1e, 0x80 | (period >> 8));
  const twoCycle = recordStereo(gb, 0.35);
  const expectedHz = (65536 / 596) * 2;
  const at220 = dftMagnitude(twoCycle.left, expectedHz);
  const at110 = dftMagnitude(twoCycle.left, expectedHz / 2);
  assert.ok(at220 > 0.03 && at220 > at110 * 3,
    `2-cycle Wave RAM plays at ${expectedHz.toFixed(1)} Hz (${at220.toFixed(3)} vs ${at110.toFixed(4)})`);
});

test('Channel 4 synthesizes distinct kick and hi-hat percussion with open-hat choke', () => {
  const gb = idle();
  gb.apu.setMidiEnabled(true);
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0x88);

  // Low LFSR clock -> studio kick drum (strong sub-bass energy around 55-110 Hz).
  gb.write(0xff21, 0xf2);
  gb.write(0xff22, 0x93); // shift=9, div=3 -> ~170 Hz LFSR
  gb.write(0xff23, 0x80);
  const kick = recordStereo(gb, 0.2);
  const kickLow = dftMagnitude(kick.left, 65) + dftMagnitude(kick.left, 95);
  const kickHigh = dftMagnitude(kick.left, 5000);
  assert.ok(kickLow > kickHigh * 4, 'kick drum concentrates energy in low frequencies');

  // High LFSR clock + slow decay -> open hi-hat, choked immediately by closed hi-hat.
  gb.write(0xff21, 0xf4);
  gb.write(0xff22, 0x11); // high clock -> open hat
  gb.write(0xff23, 0x80);
  recordStereo(gb, 0.03);
  gb.write(0xff21, 0xf1); // short decay -> closed hat chokes open hat
  gb.write(0xff23, 0x80);
  recordStereo(gb, 0.10);
  const afterChoke = recordStereo(gb, 0.12);
  assert.ok(rms(afterChoke.left) < 0.015, 'closed hi-hat chokes the ringing open hi-hat');
});

test('toggling MIDI mode on/off mid-note and switching all presets is seamless, and boot reset is silent', () => {
  const gb = idle();
  gb.apu.setMidiEnabled(true);
  const bootQuiet = recordStereo(gb, 0.15);
  assert.ok(rms(bootQuiet.left) < 1e-4, 'post-boot state with ch1.volume=0 does not play a phantom note');

  // Start a note in classic mode, flip MIDI on mid-note, cycle presets, then flip back off.
  const gbLive = idle();
  gbLive.write(0xff26, 0x80);
  gbLive.write(0xff24, 0x77);
  gbLive.write(0xff25, 0x11);
  gbLive.write(0xff11, 0x80);
  gbLive.write(0xff12, 0xf0);
  gbLive.write(0xff13, 0x00);
  gbLive.write(0xff14, 0x87); // 512 Hz sustained

  const before = recordStereo(gbLive, 0.1);
  assert.ok(rms(before.left) > 0.05);

  gbLive.apu.setMidiEnabled(true);
  for (const preset of MIDI_PRESETS) {
    gbLive.apu.setMidiPreset(preset.id);
    const chunk = recordStereo(gbLive, 0.08);
    assert.ok(rms(chunk.left) > 0.02, `preset ${preset.id} produces audible output`);
    assert.ok(chunk.left.every((s) => Number.isFinite(s) && Math.abs(s) <= 1));
  }

  gbLive.apu.setMidiEnabled(false);
  const restored = recordStereo(gbLive, 0.1);
  assert.ok(rms(restored.left) > 0.05, 'classic Game Boy tone resumes immediately when unchecked');
});

test('ElevenLabs studio sample bank loads all 28 zones, plays pitch-locked notes, and loops seamlessly', () => {
  const instDir = path.join(ROOT, 'assets', 'instruments');
  const manifest = JSON.parse(fs.readFileSync(path.join(instDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.samples.length, 28, 'manifest lists all 28 ElevenLabs studio samples');

  const decoded = manifest.samples.map((meta) => {
    const raw = execFileSync('ffmpeg', [
      '-v', 'error', '-i', path.join(instDir, meta.file),
      '-ac', '1', '-ar', '44100', '-f', 'f32le', '-',
    ], { maxBuffer: 16 * 1024 * 1024 });
    return {
      ...meta,
      sampleRate: 44100,
      pcm: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2).slice(),
    };
  });

  const gb = idle();
  const count = gb.apu.midi.loadSampleBank(decoded);
  assert.equal(count, 28);
  assert.equal(gb.apu.midi.samplesLoaded, true);

  // Verify pitch-locked playback at A4 (440 Hz) across Concert Grand Piano and Violin Strings.
  gb.apu.setMidiEnabled(true);
  gb.apu.setMidiPreset('symphonic');
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0x22);
  const period440 = Math.round(2048 - 131072 / 440);
  const actualHz = 131072 / (2048 - period440);

  gb.write(0xff16, 0x40); // 25% duty -> ElevenLabs Concert Grand Piano
  gb.write(0xff17, 0xf0);
  gb.write(0xff18, period440 & 0xff);
  gb.write(0xff19, 0x80 | (period440 >> 8));
  const piano = recordStereo(gb, 0.45);
  const pianoFund = dftMagnitude(piano.left, actualHz);
  const pianoOffPitch = dftMagnitude(piano.left, actualHz * 1.19); // minor third away
  assert.ok(pianoFund > 0.015 && pianoFund > pianoOffPitch * 4,
    `ElevenLabs Grand Piano locks to ${actualHz.toFixed(1)} Hz (${pianoFund.toFixed(4)} vs ${pianoOffPitch.toFixed(4)})`);

  // Verify long sustained bowed Violin Strings (duty 0) loops cleanly past 2.8 seconds.
  gb.write(0xff16, 0x00); // 12.5% duty -> ElevenLabs Violin Ensemble (looped)
  gb.write(0xff19, 0x80 | (period440 >> 8));
  const strings = recordStereo(gb, 2.8);
  const tailSlice = strings.left.slice(-12000);
  assert.ok(rms(tailSlice) > 0.02, 'ElevenLabs bowed strings sustain seamlessly across loop wraps');
  let maxStep = 0;
  for (let i = 1; i < strings.left.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(strings.left[i] - strings.left[i - 1]));
  }
  assert.ok(maxStep < 0.25, `no discontinuity click across sustain loop wrap (maxStep=${maxStep.toFixed(4)})`);
});

test('HarmonicArranger enriches the Gem Garden score with multi-part accompaniment and 0 dissonant clashes', () => {
  // 1. Compare polyphonic voice richness with arranger off vs on across the demo score.
  const gbPlain = new GameBoy();
  gbPlain.loadRom(demoRom());
  gbPlain.apu.setMidiEnabled(true);
  gbPlain.apu.midi.setArrangerEnabled(false);
  gbPlain.apu.setSampleRate(48000);

  const gbRich = new GameBoy();
  gbRich.loadRom(demoRom());
  gbRich.apu.setMidiEnabled(true);
  gbRich.apu.midi.setArrangerEnabled(true);
  gbRich.apu.setSampleRate(48000);

  let maxPlainVoices = 0;
  let maxRichVoices = 0;
  let arrangerFrames = 0;
  let arpTriggers = 0;
  let clashes = 0;
  let checkedFrames = 0;

  // Step through a full 16-bar cycle (~1,040 frames) of Gem Garden's pastoral score.
  for (let frame = 0; frame < 1040; frame++) {
    gbPlain.runFrame();
    gbPlain.apu.sampleCount = 0;
    gbRich.runFrame();
    gbRich.apu.sampleCount = 0;

    const plainSustaining = gbPlain.apu.midi.voices.filter((v) => v.active && !v.releasing).length;
    const richSustaining = gbRich.apu.midi.voices.filter((v) => v.active && !v.releasing).length;
    if (plainSustaining > maxPlainVoices) maxPlainVoices = plainSustaining;
    if (richSustaining > maxRichVoices) maxRichVoices = richSustaining;

    const midi = gbRich.apu.midi;
    const arr = midi.arranger;
    const activeArrVoices = midi.voices.filter((v) => v.active && !v.releasing && v.isArranger);
    if (activeArrVoices.length > 0) arrangerFrames++;
    if (arr.arpStep > arpTriggers) arpTriggers = arr.arpStep;

    // Collect live Game Boy pitches and verify every active non-releasing arranger slot
    // satisfies strict music-theory consonance against all sounding game channels.
    const gameMidis = [];
    let bassMidi = null;
    for (let ch = 1; ch <= 3; ch++) {
      if (ch === 1 && gbRich.apu.ch1.sweepEnabled && gbRich.apu.ch1.sweepPeriod > 0 && gbRich.apu.ch1.sweepShift > 0) continue;
      const g = midi.channelEnvelopeGain(gbRich.apu, ch);
      if (g <= 0.02) continue;
      const hz = midi.channelFrequency(gbRich.apu, ch);
      if (hz < 27 || hz > 4186) continue;
      const m = midiFromHz(hz);
      gameMidis.push(m);
      if (m < 63 && (bassMidi === null || ch === 3 || m < bassMidi)) bassMidi = m;
    }

    if (gameMidis.length > 0) {
      checkedFrames++;
      for (let s = 0; s < arr.slotVoices.length; s++) {
        const sv = arr.slotVoices[s];
        if (sv && sv.active && !sv.releasing && arr.slotMidi[s] > 0) {
          if (!isConsonantWithGame(arr.slotMidi[s], gameMidis, bassMidi)) {
            clashes++;
          }
        }
      }
    }
  }

  assert.ok(maxRichVoices >= maxPlainVoices + 2,
    `HarmonicArranger adds polyphonic orchestral voices (max ${maxRichVoices} vs plain ${maxPlainVoices})`);
  assert.ok(arrangerFrames > 600, `accompaniment voices active across the score (${arrangerFrames} frames)`);
  assert.ok(arpTriggers >= 6, `space-aware counter-arpeggiator blooms during held notes (${arpTriggers} steps)`);
  assert.ok(checkedFrames > 800 && clashes === 0,
    `zero dissonant clashes across ${checkedFrames} frames (clashes=${clashes})`);

  // Key detector locks onto G major (7) or relative E minor (4) for Gem Garden's score.
  const { keyRoot, keyMinor } = gbRich.apu.midi.arranger;
  assert.ok(
    (keyRoot === 7 && !keyMinor) || (keyRoot === 4 && keyMinor),
    `detected G major / E minor tonal center (got root=${keyRoot}, minor=${keyMinor})`,
  );
});
