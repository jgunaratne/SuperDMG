import test from 'node:test';
import assert from 'node:assert/strict';
import { machine } from './helpers.mjs';

const idle = () => machine('.spin:\n  jr .spin');

/** Collects `seconds` of audio as one array of left-channel samples. */
function record(gb, seconds, rate = 48000) {
  gb.apu.setSampleRate(rate);
  gb.apu.sampleCount = 0;
  const left = [];
  for (let frame = 0; frame < Math.round(seconds * 59.7275); frame++) {
    gb.runFrame();
    for (let i = 0; i < gb.apu.sampleCount; i++) left.push(gb.apu.samples[i * 2]);
    gb.apu.sampleCount = 0;
  }
  return left;
}

const risingCrossings = (samples) => {
  let count = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) count++;
  return count;
};

test('produces samples at the requested rate', () => {
  const gb = idle();
  const samples = record(gb, 1);
  assert.ok(Math.abs(samples.length - 48000) < 900, `${samples.length} samples in one second`);
  assert.ok(samples.every((s) => s >= -1 && s <= 1));
});

test('no sample generation when the rate is zero', () => {
  const gb = idle();
  gb.apu.setSampleRate(0);
  for (let i = 0; i < 10; i++) gb.runFrame();
  assert.equal(gb.apu.sampleCount, 0);
});

test('pulse channel plays the programmed pitch', () => {
  const gb = idle();
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0x22);         // channel 2 on both sides
  gb.write(0xff16, 0x80);         // 50% duty
  gb.write(0xff17, 0xf0);         // full volume, no envelope
  const frequency = 440;
  const period = Math.round(2048 - 131072 / frequency);
  gb.write(0xff18, period & 0xff);
  gb.write(0xff19, 0x80 | (period >> 8));
  assert.equal(gb.peek(0xff26) & 0x02, 0x02, 'channel 2 reports active');
  const samples = record(gb, 1);
  const measured = risingCrossings(samples);
  assert.ok(Math.abs(measured - 131072 / (2048 - period)) <= 3, `${measured} Hz`);
  const peak = Math.max(...samples.map(Math.abs));
  assert.ok(peak > 0.1, 'audible');
});

test('noise and wave channels produce output', () => {
  const gb = idle();
  gb.write(0xff26, 0x80);
  gb.write(0xff24, 0x77);
  gb.write(0xff25, 0xff);
  gb.write(0xff21, 0xf0);
  gb.write(0xff22, 0x22);
  gb.write(0xff23, 0x80);
  const noise = record(gb, 0.25);
  assert.ok(risingCrossings(noise) > 200, 'noise is busy');

  gb.write(0xff21, 0x00);         // noise DAC off
  for (let i = 0; i < 16; i++) gb.write(0xff30 + i, i < 8 ? 0xff : 0x00); // square-ish wave
  gb.write(0xff1a, 0x80);
  gb.write(0xff1c, 0x20);         // full volume
  const period = 2048 - 256;      // 65536 / 256 = 256 Hz
  gb.write(0xff1d, period & 0xff);
  gb.write(0xff1e, 0x80 | (period >> 8));
  const wave = record(gb, 1);
  assert.ok(Math.abs(risingCrossings(wave) - 256) <= 3);
});

test('the length counter switches a channel off', () => {
  const gb = idle();
  gb.write(0xff26, 0x80);
  gb.write(0xff16, 0x3f);         // length 1/256 s
  gb.write(0xff17, 0xf0);
  gb.write(0xff18, 0x00);
  gb.write(0xff19, 0xc0);         // trigger with length enabled
  assert.equal(gb.peek(0xff26) & 0x02, 0x02);
  for (let i = 0; i < 2; i++) gb.runFrame();
  assert.equal(gb.peek(0xff26) & 0x02, 0x00);
});

test('powering the APU down clears its registers and silences it', () => {
  const gb = idle();
  gb.write(0xff26, 0x80);
  gb.write(0xff12, 0xf0);
  gb.write(0xff14, 0x80);
  gb.write(0xff24, 0x77);
  assert.equal(gb.peek(0xff26), 0xf1);
  gb.write(0xff26, 0x00);
  assert.equal(gb.peek(0xff26), 0x70);
  assert.equal(gb.peek(0xff24), 0x00);
  gb.write(0xff24, 0x77);
  assert.equal(gb.peek(0xff24), 0x00, 'writes are ignored while off');
  const samples = record(gb, 0.1);
  assert.ok(Math.max(...samples.map(Math.abs)) < 0.01);
});
