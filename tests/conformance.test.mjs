// Runs the hardware-conformance suites against the committed baseline, when the test
// ROMs have been downloaded (npm run roms:fetch). Without them this test is skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.mjs';

const haveRoms = fs.existsSync(path.join(ROOT, 'test-roms', 'VERSION'));

test('no conformance test in the baseline regresses', { skip: haveRoms ? false : 'test ROMs not downloaded' }, () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools/conformance.mjs')], { encoding: 'utf8' });
  // The runner exits non-zero if a baseline test fails or is missing.
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const suites = [...run.stdout.matchAll(/^(\w+): (\d+)\/(\d+) passed/gm)];
  const total = suites.reduce((sum, m) => sum + Number(m[2]), 0);
  assert.ok(suites.length >= 5 && total > 2000, `ran ${suites.length} suites, ${total} passing tests`);
});
