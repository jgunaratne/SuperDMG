import test from 'node:test';
import assert from 'node:assert/strict';
import { GameBoy } from '../src/core/gameboy.js';
import { bytesToBase64 } from '../src/core/hdtiles.js';
import { decodePng } from '../tools/png.mjs';
import {
  aiPlayerStatus,
  renderAnnotatedScreenPng,
  normalizeActionPlan,
  parseModelJsonResponse,
  planNextMoves,
} from '../tools/ai_player.mjs';
import {
  captureTelemetrySnapshot,
  summarizeTurnOutcome,
} from '../src/ui/autoplayer.js';
import { demoRom } from './helpers.mjs';

function bootDemo() {
  const gb = new GameBoy();
  gb.loadRom(demoRom());
  for (let i = 0; i < 10; i++) gb.runFrame();
  return gb;
}

test('annotated screen PNG renders 672x608 ruler-framed 4x Game Boy viewport', () => {
  const gb = bootDemo();
  const snap = captureTelemetrySnapshot(gb);
  const png = renderAnnotatedScreenPng({
    screenShadesBase64: bytesToBase64(gb.ppu.display),
    sprites: snap.sprites,
  });
  const decoded = decodePng(png);
  assert.equal(decoded.width, 672);
  assert.equal(decoded.height, 608);
  assert.equal(snap.sprites.length, 1);
  assert.equal(snap.sprites[0].index, 0);
  assert.ok(snap.windowRows.includes(17), 'bottom HUD row detected as window layer');
});

test('parseModelJsonResponse and normalizeActionPlan sanitize chords, bounds, and fences', () => {
  const parsed = parseModelJsonResponse('```json\n{"observation":"At start","goal":"Run and jump","actions":[{"button":"right+a","frames":120},{"button":"left+right","frames":10},{"button":"bogus","frames":8}]}\n```');
  const plan = normalizeActionPlan(parsed);
  assert.equal(plan.observation, 'At start');
  assert.equal(plan.goal, 'Run and jump');
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(plan.actions[0], { button: 'right+a', buttons: ['right', 'a'], frames: 80 });
  assert.deepEqual(plan.actions[1], { button: 'left', buttons: ['left'], frames: 10 });

  const fallback = normalizeActionPlan({ observation: 'Title screen', actions: [] });
  assert.deepEqual(fallback.actions, [{ button: 'start', buttons: ['start'], frames: 6 }]);
});

test('summarizeTurnOutcome distinguishes real movement from wall-blocked turns', () => {
  const gb = bootDemo();
  const s0 = captureTelemetrySnapshot(gb);

  // Trying to walk up into the top border wall should be flagged as blocked
  gb.setButton('up', true);
  for (let i = 0; i < 16; i++) gb.runFrame();
  gb.setButton('up', false);
  gb.runFrame();
  const sBlocked = captureTelemetrySnapshot(gb);
  const blockedOutcome = summarizeTurnOutcome(s0, sBlocked);
  assert.equal(blockedOutcome.blocked, true);
  assert.equal(blockedOutcome.moved, false);

  // Walking right along the open corridor moves Sprite #0 and reports moved=true
  gb.setButton('right', true);
  for (let i = 0; i < 24; i++) gb.runFrame();
  gb.setButton('right', false);
  gb.runFrame();
  const sMoved = captureTelemetrySnapshot(gb);
  const movedOutcome = summarizeTurnOutcome(sBlocked, sMoved);
  assert.equal(movedOutcome.blocked, false);
  assert.equal(movedOutcome.moved, true);
  assert.match(movedOutcome.text, /Sprite #0 moved/);
});

test('heuristic backend executes closed-loop autoplay steps offline', async () => {
  const prev = process.env.AI_PLAYER_BACKEND;
  process.env.AI_PLAYER_BACKEND = 'heuristic';
  try {
    const status = aiPlayerStatus();
    assert.equal(status.available, true);
    assert.equal(status.backend, 'heuristic');

    const gb = bootDemo();
    const xStart = gb.peek(0xc400);
    const yStart = gb.peek(0xc401);
    const history = [];

    for (let turn = 1; turn <= 3; turn++) {
      const before = captureTelemetrySnapshot(gb);
      const res = await planNextMoves({
        title: gb.cart.header.title,
        effort: 'low',
        screenShadesBase64: bytesToBase64(gb.ppu.display),
        telemetry: before,
        history,
      });
      assert.equal(res.ok, true);
      assert.ok(res.actions.length >= 1);
      for (const act of res.actions) {
        for (const b of act.buttons) gb.setButton(b, true);
        for (let f = 0; f < act.frames; f++) gb.runFrame();
        for (const b of act.buttons) gb.setButton(b, false);
        gb.runFrame();
      }
      const after = captureTelemetrySnapshot(gb);
      const out = summarizeTurnOutcome(before, after);
      history.push({
        turn,
        goal: res.goal,
        actions: res.actions.map((a) => a.button).join(','),
        outcome: out.text,
        moved: out.moved,
        blocked: out.blocked,
      });
    }

    assert.ok(
      gb.peek(0xc400) !== xStart || gb.peek(0xc401) !== yStart,
      'heuristic autoplay moved the player across the garden',
    );
  } finally {
    if (prev === undefined) delete process.env.AI_PLAYER_BACKEND;
    else process.env.AI_PLAYER_BACKEND = prev;
  }
});
