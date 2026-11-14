// Real-time music-theory arranger that enriches the Game Boy's monophonic channels
// into a harmonious, multi-layered chamber/orchestral score when MIDI mode is active.
//
// Pipeline (runs every ~4 ms of audio time with zero per-sample allocations):
//   1. Infers the active Major/Minor key (24-key Krumhansl-Kessler profile) and live
//      diatonic/borrowed triad from the notes played on Channels 1, 2 and 3.
//   2. Enforces strict vertical consonance against every sounding Game Boy note (forbids
//      minor/major 2nd clusters, minor 9ths, major 7ths, tritones, and muddy low 3rds),
//      releasing any accompaniment voice immediately if a game channel moves into a clash.
//   3. Voices four orchestral accompaniment layers tucked beneath the original melody:
//        - Stereo voice-led inner chord pad (Strings / French Horn / Rhodes)
//        - Diatonic 3rd / 6th counter-harmony on solo melodic phrases (Flute / Oboe / Violin)
//        - Tempo-locked chord arpeggiator in open melodic spaces (Nylon Guitar / Piano / Vibes)
//        - Sub-octave acoustic upright/cello bass foundation
//      plus a feather-light off-beat hi-hat pocket when a steady drum groove is active.

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

// Consonant diatonic triads per mode: [degreeOffset, thirdSemis, fifthSemis].
const MAJOR_TRIADS = [
  [0, 4, 7],  // I
  [2, 3, 7],  // ii
  [4, 3, 7],  // iii
  [5, 4, 7],  // IV
  [7, 4, 7],  // V
  [9, 3, 7],  // vi
];
const MINOR_TRIADS = [
  [0, 3, 7],  // i
  [3, 4, 7],  // III
  [5, 3, 7],  // iv
  [7, 3, 7],  // v
  [7, 4, 7],  // V (harmonic minor dominant)
  [8, 4, 7],  // VI
  [10, 4, 7], // VII
];

const ARRANGER_ROLES = {
  symphonic: {
    padL: 'violin_ensemble',
    padR: 'french_horn',
    counter: 'concert_flute',
    counterAlt: 'oboe_reed',
    arp: 'nylon_guitar',
    subBass: 'acoustic_bass',
  },
  jrpg: {
    padL: 'violin_ensemble',
    padR: 'french_horn',
    counter: 'concert_flute',
    counterAlt: 'violin_ensemble',
    arp: 'vibraphone_celesta',
    subBass: 'cello_bass',
  },
  piano: {
    padL: 'violin_ensemble',
    padR: 'violin_ensemble',
    counter: 'violin_ensemble',
    counterAlt: 'concert_flute',
    arp: 'grand_piano',
    subBass: 'acoustic_bass',
  },
  jazz: {
    padL: 'electric_piano',
    padR: 'electric_piano',
    counter: 'vibraphone_celesta',
    counterAlt: 'french_horn',
    arp: 'vibraphone_celesta',
    subBass: 'acoustic_bass',
  },
};

export function midiFromHz(hz) {
  return 69 + 12 * Math.log2(hz / 440);
}

export function hzFromMidi(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function mod12(n) {
  return ((n % 12) + 12) % 12;
}

/**
 * Verifies that `candMidi` forms a clean acoustic consonance against every currently
 * sounding Game Boy note (`gameNotes`, array of MIDI floats) and the active `bassMidi`.
 */
export function isConsonantWithGame(candMidi, gameNotes, bassMidi = null) {
  const cRound = Math.round(candMidi);
  if (cRound < 34 || cRound > 92) return false;

  if (bassMidi !== null) {
    const bRound = Math.round(bassMidi);
    const bassIc = mod12(cRound - bRound);
    // Against the bass, allow only octave/unison (0), 3rds (3, 4), 5th (7), and 6ths (8, 9).
    if (
      bassIc === 1 || bassIc === 2 || bassIc === 5 ||
      bassIc === 6 || bassIc === 10 || bassIc === 11
    ) {
      return false;
    }
    // Low-register clarity: below C3 (48) only pure octaves; C3..G3 (48..54) only octaves/5ths.
    if (cRound < 48 && bassIc !== 0) return false;
    if (cRound < 55 && bassIc !== 0 && bassIc !== 7) return false;
  } else if (cRound < 52) {
    return false;
  }

  for (let i = 0; i < gameNotes.length; i++) {
    const g = gameNotes[i];
    const dist = Math.abs(candMidi - g);
    // Forbid close-register 2nds (0.45..2.65 semitones) while permitting octaves & >= m3.
    if (dist > 0.45 && dist < 2.65) return false;
    const ic = mod12(cRound - Math.round(g));
    // Forbid semitone/b9 (1), tritone (6), and major-7th/split-3rd clashes (11) against any voice.
    if (ic === 1 || ic === 6 || ic === 11) return false;
  }
  return true;
}

const SLOT_PAD_L = 0;
const SLOT_PAD_R = 1;
const SLOT_COUNTER = 2;
const SLOT_ARP = 3;
const SLOT_SUB_BASS = 4;
const NUM_SLOTS = 5;

export class HarmonicArranger {
  constructor() {
    this.pcHist = new Float64Array(12);
    this.recentPc = new Float64Array(12);
    this.keyRoot = 0;       // 0..11 (C = 0)
    this.keyMinor = false;
    this.chordRoot = 0;     // 0..11
    this.chordThird = 4;    // 3 or 4
    this.chordFifth = 7;

    this.clock = 0;
    this.controlAccum = 0;

    this.prevChMidi = [-1, -1, -1, -1];
    this.chHoldAge = [0, 0, 0, 0];
    this.phraseScore = 0;

    // Tempo / subdivision tracking from note inter-onset intervals.
    this.lastOnsetTime = -10;
    this.subdivisionSec = 0.16; // ~94 BPM sixteenth / 188 BPM eighth default
    this.recentDensity = 0;     // notes/sec measure so fast runs clear the arp lane
    this.arpPhase = 0;
    this.arpStep = 0;

    // Drum groove pocket tracking.
    this.lastDrumTime = -10;
    this.drumPeriod = 0;
    this.drumStreak = 0;
    this.ghostHatArmed = false;

    // Active arranger voice references managed inside MidiSynth (`slot -> voice | null`).
    this.slotVoices = new Array(NUM_SLOTS).fill(null);
    this.slotMidi = new Float64Array(NUM_SLOTS).fill(-1);
  }

  reset(midiSynth) {
    this.pcHist.fill(0);
    this.recentPc.fill(0);
    this.clock = 0;
    this.controlAccum = 0;
    this.prevChMidi.fill(-1);
    this.chHoldAge.fill(0);
    this.phraseScore = 0;
    this.lastOnsetTime = -10;
    this.subdivisionSec = 0.16;
    this.recentDensity = 0;
    this.arpPhase = 0;
    this.arpStep = 0;
    this.lastDrumTime = -10;
    this.drumPeriod = 0;
    this.drumStreak = 0;
    this.ghostHatArmed = false;
    for (let s = 0; s < NUM_SLOTS; s++) {
      if (this.slotVoices[s] && midiSynth) midiSynth.releaseVoice(this.slotVoices[s], 0.25);
      this.slotVoices[s] = null;
      this.slotMidi[s] = -1;
    }
  }

  onDrumTrigger() {
    const dt = this.clock - this.lastDrumTime;
    this.lastDrumTime = this.clock;
    this.ghostHatArmed = true;
    if (dt >= 0.16 && dt <= 0.72) {
      this.drumPeriod = this.drumPeriod > 0 ? this.drumPeriod * 0.7 + dt * 0.3 : dt;
      this.drumStreak = Math.min(8, this.drumStreak + 1);
    } else if (dt > 1.4) {
      this.drumStreak = 1;
    }
  }

  updateKey() {
    let bestScore = -Infinity;
    let bestRoot = this.keyRoot;
    let bestMinor = this.keyMinor;

    for (let root = 0; root < 12; root++) {
      let maj = 0, min = 0;
      for (let i = 0; i < 12; i++) {
        const w = this.pcHist[mod12(root + i)];
        maj += w * MAJOR_PROFILE[i];
        min += w * MINOR_PROFILE[i];
      }
      if (root === this.keyRoot && !this.keyMinor) maj *= 1.07;
      if (root === this.keyRoot && this.keyMinor) min *= 1.07;
      if (maj > bestScore) { bestScore = maj; bestRoot = root; bestMinor = false; }
      if (min > bestScore) { bestScore = min; bestRoot = root; bestMinor = true; }
    }

    if (bestScore > 0.05) {
      this.keyRoot = bestRoot;
      this.keyMinor = bestMinor;
    }
  }

  inScale(pc) {
    const rel = mod12(pc - this.keyRoot);
    const scale = this.keyMinor ? MINOR_SCALE : MAJOR_SCALE;
    for (let i = 0; i < 7; i++) if (scale[i] === rel) return true;
    return false;
  }

  updateChord(activeNotes, bassMidi) {
    const baseTriads = this.keyMinor ? MINOR_TRIADS : MAJOR_TRIADS;
    const candidates = [];
    for (const [deg, t3, t5] of baseTriads) {
      candidates.push([mod12(this.keyRoot + deg), t3, t5, true]);
    }
    // Also consider triads rooted on the live bass note so borrowed chords fit cleanly.
    if (bassMidi !== null) {
      const bPc = mod12(Math.round(bassMidi));
      candidates.push([bPc, 4, 7, false]);
      candidates.push([bPc, 3, 7, false]);
    }

    let bestScore = -Infinity;
    let best = [this.chordRoot, this.chordThird, this.chordFifth];

    for (const [root, t3, t5, diatonic] of candidates) {
      const p3 = mod12(root + t3);
      const p5 = mod12(root + t5);
      let score = diatonic ? 1.1 : 0.2;
      if (root === this.chordRoot && t3 === this.chordThird) score += 0.65;

      // Recent phrase memory helps arpeggiated basslines hold a stable chord.
      score += (this.recentPc[root] * 0.9 + this.recentPc[p3] * 0.75 + this.recentPc[p5] * 0.7);

      if (bassMidi !== null) {
        const bPc = mod12(Math.round(bassMidi));
        if (bPc === root) score += 3.2;
        else if (bPc === p5) score += 1.5;
        else if (bPc === p3) score += 1.3;
        else score -= 1.8;
      }

      for (let i = 0; i < activeNotes.length; i++) {
        const n = activeNotes[i];
        const pc = mod12(Math.round(n.midi));
        const w = n.gain * (n.isBass ? 1.6 : 1.15);
        if (pc === root) score += 2.6 * w;
        else if (pc === p3) score += 2.3 * w;
        else if (pc === p5) score += 2.0 * w;
        // Penalize triads whose chord tones clash by semitone with any active melody note.
        for (const ct of [root, p3, p5]) {
          const ic = mod12(ct - pc);
          if (ic === 1 || ic === 11) score -= 3.4 * w;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        best = [root, t3, t5];
      }
    }

    this.chordRoot = best[0];
    this.chordThird = best[1];
    this.chordFifth = best[2];
  }

  releaseSlot(midiSynth, slot, fastScale = 0.5) {
    const v = this.slotVoices[slot];
    if (v && v.active && !v.releasing) {
      midiSynth.releaseVoice(v, fastScale);
    }
    this.slotVoices[slot] = null;
    this.slotMidi[slot] = -1;
  }

  startOrHoldSlot(midiSynth, apu, slot, targetMidi, patchId, gain, panL, panR, rearticulate = false) {
    const existing = this.slotVoices[slot];
    if (existing && (!existing.active || existing.releasing)) {
      this.slotVoices[slot] = null;
    }
    const cur = this.slotVoices[slot];
    if (cur && !rearticulate && Math.abs(this.slotMidi[slot] - targetMidi) < 0.25) {
      cur.envSmooth += (gain - cur.envSmooth) * 0.35;
      cur.panL = panL;
      cur.panR = panR;
      return;
    }
    if (cur) {
      midiSynth.releaseVoice(cur, 0.55);
      this.slotVoices[slot] = null;
    }
    const freq = hzFromMidi(targetMidi);
    const masterOn = (apu.nr51 & 0xff) !== 0;
    if (!masterOn || gain < 0.015) return;
    const v = midiSynth.spawnArrangerVoice(patchId, freq, gain, panL, panR);
    if (v) {
      this.slotVoices[slot] = v;
      this.slotMidi[slot] = targetMidi;
    }
  }

  /** Advances the arranger by `dt` seconds; executes full analysis every ~4 ms. */
  step(dt, apu, midiSynth) {
    this.clock += dt;
    this.controlAccum += dt;
    if (this.controlAccum < 0.004) return;
    const stepDt = this.controlAccum;
    this.controlAccum = 0;

    // Exponential decay on tonal histograms and phrase activity.
    const histDecay = Math.exp(-stepDt / 4.2);
    const recentDecay = Math.exp(-stepDt / 0.48);
    for (let i = 0; i < 12; i++) {
      this.pcHist[i] *= histDecay;
      this.recentPc[i] *= recentDecay;
    }
    this.recentDensity *= Math.exp(-stepDt / 0.55);

    // Collect clean musical notes currently sounding across CH1, CH2, CH3.
    const activeNotes = [];
    const gameMidis = [];

    for (let ch = 1; ch <= 3; ch++) {
      // Ignore hardware-swept sound effects on Channel 1 (jumps, chirps, lasers).
      if (ch === 1 && apu.ch1.sweepEnabled && apu.ch1.sweepPeriod > 0 && apu.ch1.sweepShift > 0) {
        this.prevChMidi[1] = -1;
        this.chHoldAge[1] = 0;
        continue;
      }
      const gain = midiSynth.channelEnvelopeGain(apu, ch);
      const [pL, pR] = midiSynth.channelPan(apu.nr51, ch);
      if (gain <= 0.02 || (pL === 0 && pR === 0)) {
        this.prevChMidi[ch] = -1;
        this.chHoldAge[ch] = 0;
        continue;
      }
      const hz = midiSynth.channelFrequency(apu, ch);
      if (hz < 27 || hz > 4186) {
        this.prevChMidi[ch] = -1;
        this.chHoldAge[ch] = 0;
        continue;
      }
      const midi = midiFromHz(hz);
      const prev = this.prevChMidi[ch];
      if (prev < 0 || Math.abs(midi - prev) >= 0.65) {
        this.prevChMidi[ch] = midi;
        this.chHoldAge[ch] = 0;

        // Register a musical note onset.
        const pc = mod12(Math.round(midi));
        const bassWeight = ch === 3 || midi < 57 ? 2.0 : 1.0;
        this.pcHist[pc] += gain * bassWeight;
        this.recentPc[pc] += gain * bassWeight;
        this.phraseScore = Math.min(6, this.phraseScore + (ch === 3 ? 1.1 : 0.85));

        if (ch <= 2) {
          const ioi = this.clock - this.lastOnsetTime;
          this.lastOnsetTime = this.clock;
          this.recentDensity += 1;
          if (ioi >= 0.085 && ioi <= 0.52) {
            // Normalize IOI into an eighth/sixteenth subdivision (~0.12s..0.24s).
            const sub = ioi > 0.28 ? ioi * 0.5 : ioi;
            this.subdivisionSec = this.subdivisionSec * 0.78 + sub * 0.22;
          }
        }
      } else {
        this.chHoldAge[ch] += stepDt;
        const pc = mod12(Math.round(midi));
        const w = (ch === 3 || midi < 57 ? 1.3 : 0.65) * gain * stepDt;
        this.pcHist[pc] += w;
        this.recentPc[pc] += w * 1.4;
      }

      activeNotes.push({
        ch,
        midi,
        gain,
        age: this.chHoldAge[ch],
        isBass: ch === 3 || midi < 56,
      });
      gameMidis.push(midi);
    }

    if (activeNotes.length === 0) {
      this.phraseScore *= Math.exp(-stepDt / 0.8);
      for (let s = 0; s < NUM_SLOTS; s++) this.releaseSlot(midiSynth, s, 0.75);
      return;
    }

    if (activeNotes.length >= 2) {
      this.phraseScore = Math.min(6, this.phraseScore + stepDt * 3.5);
    }

    // Identify lowest bass anchor and highest lead melody voice.
    let bassObj = null;
    let leadObj = null;
    for (const n of activeNotes) {
      if (n.midi < 63 && (!bassObj || n.ch === 3 || n.midi < bassObj.midi)) {
        if (!bassObj || (n.ch === 3 && bassObj.ch !== 3) || n.midi < bassObj.midi) bassObj = n;
      }
      if (!leadObj || n.midi > leadObj.midi) leadObj = n;
    }
    if (bassObj && leadObj && bassObj === leadObj && activeNotes.length === 1) {
      if (leadObj.midi >= 58) bassObj = null;
      else leadObj = null;
    }
    const bassMidi = bassObj ? bassObj.midi : null;

    // 1. Immediately release any active arranger voice that clashes with the new game notes!
    for (let s = 0; s < NUM_SLOTS; s++) {
      if (this.slotVoices[s] && this.slotMidi[s] > 0) {
        if (!isConsonantWithGame(this.slotMidi[s], gameMidis, bassMidi)) {
          this.releaseSlot(midiSynth, s, 0.22);
        }
      }
    }

    // Require genuine musical context (>= 2 notes or simultaneous harmony) before orchestrating.
    if (this.phraseScore < 1.35) return;

    this.updateKey();
    this.updateChord(activeNotes, bassMidi);

    const roles = ARRANGER_ROLES[midiSynth.preset] || ARRANGER_ROLES.symphonic;
    const avgGain = activeNotes.reduce((s, n) => s + n.gain, 0) / activeNotes.length;
    const chordPcs = [
      this.chordRoot,
      mod12(this.chordRoot + this.chordThird),
      mod12(this.chordRoot + this.chordFifth),
    ];
    // Tuning offset follows the lead/bass fractional temperament smoothly (within ±20 cents).
    const refMidi = leadObj ? leadObj.midi : bassObj ? bassObj.midi : 60;
    const fracOffset = Math.max(-0.2, Math.min(0.2, refMidi - Math.round(refMidi)));

    // --- Layer D: Symphonic Sub-Octave Upright/Cello Bass Foundation ----------------
    if (bassObj && bassObj.midi >= 46 && bassObj.midi <= 62 && bassObj.age >= 0.012) {
      const subMidi = bassObj.midi - 12;
      if (isConsonantWithGame(subMidi, gameMidis, bassMidi)) {
        this.startOrHoldSlot(
          midiSynth, apu, SLOT_SUB_BASS, subMidi,
          roles.subBass, bassObj.gain * 0.34, 0.78, 0.78, false,
        );
      } else {
        this.releaseSlot(midiSynth, SLOT_SUB_BASS, 0.4);
      }
    } else {
      this.releaseSlot(midiSynth, SLOT_SUB_BASS, 0.5);
    }

    // --- Layer A: Stereo Voice-Led Inner Harmonic Pad (G3..D5 = 55..74) -------------
    const padCandidates = [];
    for (let m = 55; m <= 74; m++) {
      const pc = mod12(m);
      if (pc === chordPcs[0] || pc === chordPcs[1] || pc === chordPcs[2]) {
        const tuned = m + fracOffset;
        if (isConsonantWithGame(tuned, gameMidis, bassMidi)) {
          padCandidates.push(tuned);
        }
      }
    }

    if (padCandidates.length >= 1) {
      const prevL = this.slotMidi[SLOT_PAD_L] > 0 ? this.slotMidi[SLOT_PAD_L] : 60;
      let bestL = padCandidates[0];
      let bestDistL = Math.abs(bestL - prevL);
      for (const c of padCandidates) {
        // Prefer lower-middle register (57..67) for left pad.
        const regBias = c > 68 ? (c - 68) * 0.6 : 0;
        const d = Math.abs(c - prevL) + regBias;
        if (d < bestDistL) { bestDistL = d; bestL = c; }
      }
      const padGain = Math.min(0.26, avgGain * 0.24);
      this.startOrHoldSlot(midiSynth, apu, SLOT_PAD_L, bestL, roles.padL, padGain, 0.82, 0.34, false);

      // Second stereo pad voice picks a distinct consonant chord tone (>= 3 semitones apart).
      const rightCands = padCandidates.filter((c) =>
        Math.abs(c - bestL) >= 2.9 && mod12(Math.round(c)) !== mod12(Math.round(bestL)));
      if (rightCands.length >= 1) {
        const prevR = this.slotMidi[SLOT_PAD_R] > 0 ? this.slotMidi[SLOT_PAD_R] : 65;
        let bestR = rightCands[0];
        let bestDistR = Math.abs(bestR - prevR);
        for (const c of rightCands) {
          const d = Math.abs(c - prevR);
          if (d < bestDistR) { bestDistR = d; bestR = c; }
        }
        this.startOrHoldSlot(midiSynth, apu, SLOT_PAD_R, bestR, roles.padR, padGain * 0.92, 0.34, 0.82, false);
      } else {
        this.releaseSlot(midiSynth, SLOT_PAD_R, 0.6);
      }
    } else {
      this.releaseSlot(midiSynth, SLOT_PAD_L, 0.5);
      this.releaseSlot(midiSynth, SLOT_PAD_R, 0.5);
    }

    // --- Layer B: Diatonic 3rd / 6th Counter-Harmony on Solo Lead Phrases ------------
    const ch1Active = activeNotes.find((n) => n.ch === 1);
    const ch2Active = activeNotes.find((n) => n.ch === 2);
    const pulseInterval = ch1Active && ch2Active ? Math.abs(ch1Active.midi - ch2Active.midi) : 99;
    const alreadyHarmonized = pulseInterval >= 2.7 && pulseInterval <= 9.5;

    if (leadObj && leadObj.midi >= 60 && leadObj.age >= 0.036 && !alreadyHarmonized) {
      const leadRound = Math.round(leadObj.midi);
      // Candidate sweet harmonies below the lead: diatonic 3rd (-3/-4) or 6th (-8/-9).
      let chosenHarm = null;
      const offsets = [-4, -3, -9, -8, -7];
      let bestHarmScore = -Infinity;
      for (const off of offsets) {
        const candRound = leadRound + off;
        const candPc = mod12(candRound);
        const candMidi = candRound + fracOffset;
        if (!isConsonantWithGame(candMidi, gameMidis, bassMidi)) continue;
        // Avoid duplicating an existing pad pitch exactly.
        if (Math.abs(candMidi - this.slotMidi[SLOT_PAD_L]) < 0.8) continue;
        if (Math.abs(candMidi - this.slotMidi[SLOT_PAD_R]) < 0.8) continue;

        let sc = 0;
        if (this.inScale(candPc)) sc += 2.5;
        if (candPc === chordPcs[0] || candPc === chordPcs[1] || candPc === chordPcs[2]) sc += 2.2;
        if (off === -3 || off === -4) sc += 0.8; // sweet parallel 3rd preference
        if (sc > bestHarmScore) {
          bestHarmScore = sc;
          chosenHarm = candMidi;
        }
      }

      if (chosenHarm !== null && bestHarmScore >= 2.0) {
        const leadPatch = midiSynth.selectPatch(apu, leadObj.ch, hzFromMidi(leadObj.midi));
        const counterPatch = leadPatch.id === roles.counter ? roles.counterAlt : roles.counter;
        this.startOrHoldSlot(
          midiSynth, apu, SLOT_COUNTER, chosenHarm,
          counterPatch, Math.min(0.32, leadObj.gain * 0.30), 0.58, 0.82, false,
        );
      } else {
        this.releaseSlot(midiSynth, SLOT_COUNTER, 0.45);
      }
    } else {
      this.releaseSlot(midiSynth, SLOT_COUNTER, 0.45);
    }

    // --- Layer C: Space-Aware Chord Arpeggiator (Harp / Guitar / Piano / Vibes) ------
    const longestHold = Math.max(...activeNotes.map((n) => n.age));
    const spaceOpen = longestHold >= this.subdivisionSec * 1.15 && this.recentDensity < 4.2;

    if (spaceOpen) {
      this.arpPhase += stepDt;
      if (this.arpPhase >= this.subdivisionSec) {
        this.arpPhase -= this.subdivisionSec;
        // Build ordered consonant chord tones across C4..A5 (60..81) for delicate filigree.
        const arpTones = [];
        for (let m = 60; m <= 81; m++) {
          const pc = mod12(m);
          if (pc === chordPcs[0] || pc === chordPcs[1] || pc === chordPcs[2]) {
            const tuned = m + fracOffset;
            if (isConsonantWithGame(tuned, gameMidis, bassMidi)) {
              arpTones.push(tuned);
            }
          }
        }
        if (arpTones.length >= 2) {
          // Up-and-down harp wave pattern: 0, 1, 2, 1 ...
          const cycleLen = arpTones.length > 2 ? arpTones.length * 2 - 2 : 2;
          const pos = this.arpStep++ % cycleLen;
          const idx = pos < arpTones.length ? pos : cycleLen - pos;
          const arpMidi = arpTones[Math.min(arpTones.length - 1, idx)];
          const panBias = (this.arpStep & 1) ? 0.16 : -0.16;
          this.startOrHoldSlot(
            midiSynth, apu, SLOT_ARP, arpMidi,
            roles.arp, Math.min(0.28, avgGain * 0.26),
            0.70 - panBias, 0.70 + panBias, true,
          );
        }
      }
    } else {
      this.arpPhase = this.subdivisionSec * 0.65;
    }

    // --- Layer E: Subtle Off-Beat Hi-Hat Pocket when Drum Groove is Active -----------
    if (
      this.ghostHatArmed &&
      this.drumStreak >= 3 &&
      this.drumPeriod >= 0.22 &&
      this.drumPeriod <= 0.68 &&
      this.clock - this.lastDrumTime >= this.drumPeriod * 0.5 &&
      this.clock - this.lastDrumTime <= this.drumPeriod * 0.65
    ) {
      this.ghostHatArmed = false;
      if ((apu.nr51 & 0x88) !== 0) {
        midiSynth.spawnGhostHat(apu, 0.16);
      }
    }
  }
}
