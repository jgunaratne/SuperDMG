#!/usr/bin/env node
// Builds roms/demo.gb ("Gem Garden") from roms/demo.asm plus the artwork and level
// defined here. Run with `npm run demo:build`; the built ROM is committed so the app
// works without a build step.
//
// The header's logo field is left empty on purpose: it holds a Nintendo trademark that
// real hardware checks before starting a cartridge. This ROM is meant for emulators,
// which do not need it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assemble, finishRom } from './asm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- Artwork: one character per pixel, lightest to darkest ---------------------------

const SHADE = { '.': 0, 'o': 1, 'x': 2, '#': 3 };

/** 8-pixel-wide rows of art -> 2bpp bytes (two per row). */
function encode(rows) {
  const bytes = [];
  for (const row of rows) {
    if (row.length !== 8) throw new Error(`art row "${row}" is not 8 pixels wide`);
    let lo = 0, hi = 0;
    for (const ch of row) {
      const shade = SHADE[ch];
      if (shade === undefined) throw new Error(`unknown art character "${ch}"`);
      lo = (lo << 1) | (shade & 1);
      hi = (hi << 1) | (shade >> 1);
    }
    bytes.push(lo, hi);
  }
  return bytes;
}

const art = (text) => text.trim().split('\n').map((row) => row.trim());

const TERRAIN = {
  floor: `
    ........
    ..o.....
    ........
    ......o.
    ........
    .o......
    ........
    ....o...`,
  flower: `
    ........
    ...#....
    ..#o#...
    ...#....
    ...x..o.
    ..xx....
    ...x....
    ........`,
  gem: `
    ........
    ...##...
    ..#oo#..
    .#o..x#.
    .#o.xx#.
    ..#xx#..
    ...##...
    ........`,
  wall: `
    xxx#xxxx
    xoo#xooo
    xxx#xxxx
    ########
    xxxxxxx#
    oooxooo#
    xxxxxxx#
    ########`,
  water: `
    oooooooo
    oo..oooo
    o.oo.ooo
    oooooooo
    oooooooo
    oooo..oo
    ooo.oo.o
    oooooooo`,
  tree: `
    ..####..
    .#xxxx#.
    #xxoxxx#
    #xxxxox#
    #xoxxxx#
    .#xxxx#.
    ..####..
    ...##...`,
};

// The order fixes the tile numbers the game code relies on (see demo.asm).
const TERRAIN_ORDER = ['floor', 'flower', 'gem', 'wall', 'water', 'tree'];
const FONT_BASE = 16;

// 5x7 glyphs for the status bar.
const GLYPHS = {
  '0': '.###. #...# #..## #.#.# ##..# #...# .###.',
  '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  '2': '.###. #...# ....# ...#. ..#.. .#... #####',
  '3': '####. ....# ....# .###. ....# ....# ####.',
  '4': '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  '5': '##### #.... ####. ....# ....# #...# .###.',
  '6': '.###. #.... #.... ####. #...# #...# .###.',
  '7': '##### ....# ...#. ..#.. ..#.. ..#.. ..#..',
  '8': '.###. #...# #...# .###. #...# #...# .###.',
  '9': '.###. #...# #...# .#### ....# ....# .###.',
  'G': '.###. #...# #.... #.### #...# #...# .###.',
  'E': '##### #.... #.... ####. #.... #.... #####',
  'M': '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  'S': '.#### #.... #.... .###. ....# ....# ####.',
  'Y': '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  'O': '.###. #...# #...# #...# #...# #...# .###.',
  'U': '#...# #...# #...# #...# #...# #...# .###.',
  'W': '#...# #...# #...# #.#.# #.#.# ##.## #...#',
  'I': '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  'N': '#...# ##..# #.#.# #.#.# #..## #...# #...#',
  '/': '....# ....# ...#. ..#.. .#... #.... #....',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  ' ': '..... ..... ..... ..... ..... ..... .....',
};
const FONT_ORDER = '0123456789GEMSYOUWIN/! ';

/** A status-bar tile: a rule along the top, then the glyph. */
function glyphTile(ch) {
  return ['########', ...GLYPHS[ch].split(' ').map((row) => `.${row}..`)];
}

// The player, 8x16, two walking frames. Colour '.' is transparent for sprites.
const PLAYER_TOP = `
    ...##...
    ..####..
    .#x##x#.
    .#oooo#.
    .#o#o#o.
    .#oooo#.
    ..#oo#..
    ..####..`;
const PLAYER_LEGS = [`
    .#xxxx#.
    #x#xx#x#
    #x#xx#x#
    .#xxxx#.
    ..#xx#..
    ..#..#..
    .##..#..
    .....##.`, `
    .#xxxx#.
    #x#xx#x#
    #x#xx#x#
    .#xxxx#.
    ..#xx#..
    ..#..#..
    ..#..##.
    .##.....`];

// --- Level: 32 x 32 cells -------------------------------------------------------------
//   # wall   ~ water   T tree   . grass   , flower   * gem   P player start

const LEVEL = `
################################
#P....,....T.......#...........#
#..,.....*.T..,....#..*....,...#
#......TTTTT.......#.......TT..#
#..~~~.............#..,....TT..#
#.~~~~~...,....*...#...........#
#.~~~~~~...........####..####..#
#..~~~~......T.................#
#...~~...,...T.....,......*....#
#............T.................#
#.,....*.....TTTTTTTT..,.......#
#..............................#
#######..####........TTT.......#
#.....#..#..#...,....T*T....,..#
#..*..#..#..#........T.T.......#
#.....#.....#..................#
#.....####..#....~~~~~~........#
#..,........#...~~~~~~~~...,...#
#...........#...~~~..~~~.......#
#######..####...~~*..~~~.......#
#...............~~~..~~~..TT...#
#..,............~~~..~~~..TT...#
#........,.......~~..~~......*.#
#....TT................,.......#
#....TT...*....................#
#.............,.....########...#
#..,................#......#...#
#.........TTTT......#..*...#.,.#
#....*....T..T......#......#...#
#.........T..T..,...###..###...#
#..,...........................#
################################`.trim().split('\n');

const CELL = { '.': 0, 'P': 0, ',': 1, '*': 2, '#': 3, '~': 4, 'T': 5 };

function readLevel() {
  if (LEVEL.length !== 32) throw new Error(`level has ${LEVEL.length} rows, expected 32`);
  let start = null;
  const gems = [];
  LEVEL.forEach((row, y) => {
    if (row.length !== 32) throw new Error(`level row ${y} is ${row.length} wide, expected 32`);
    [...row].forEach((ch, x) => {
      if (!(ch in CELL)) throw new Error(`unknown level character "${ch}" at ${x},${y}`);
      if (ch === 'P') start = { x, y };
      if (ch === '*') gems.push({ x, y });
    });
  });
  if (!start) throw new Error('the level has no player start (P)');

  // Every gem must be reachable on foot, or the game cannot be finished.
  const seen = new Set([`${start.x},${start.y}`]);
  const queue = [start];
  while (queue.length) {
    const { x, y } = queue.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const ch = LEVEL[ny] && LEVEL[ny][nx];
      if (!ch || CELL[ch] >= 3 || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`);
      queue.push({ x: nx, y: ny });
    }
  }
  const stranded = gems.filter((g) => !seen.has(`${g.x},${g.y}`));
  if (stranded.length) throw new Error(`unreachable gems at ${stranded.map((g) => `${g.x},${g.y}`).join(' ')}`);
  return { cells: LEVEL.flatMap((row) => [...row].map((ch) => CELL[ch])), start, gems };
}

// --- Assemble -------------------------------------------------------------------------

const db = (label, bytes) => {
  const lines = [`${label}:`];
  for (let i = 0; i < bytes.length; i += 16) lines.push(`  db ${bytes.slice(i, i + 16).join(',')}`);
  lines.push(`${label}_end:`);
  return lines.join('\n');
};
const fontTile = (ch) => FONT_BASE + FONT_ORDER.indexOf(ch);
const text = (s) => [...s].map(fontTile);

const DATA_START = 0x400;

// --- 16-Bar Pastoral Score ("Gem Garden" in G Major / E Minor, 112 BPM) --------------

const NOTE_SEMITONES = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

function noteHz(spec) {
  const m = /^([A-G](?:#|b)?)(\d)$/.exec(spec);
  if (!m) throw new Error(`bad note "${spec}"`);
  const midi = (Number(m[2]) + 1) * 12 + NOTE_SEMITONES[m[1]];
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Encodes a 128-step eighth-note table as [lo, hi] pairs ($00 = hold, $FE = rest). */
function encodeTrack(phrases, { wave = false } = {}) {
  const steps = [];
  for (const token of phrases.trim().split(/\s+/)) {
    const [note, lenStr] = token.split(':');
    const len = Number(lenStr);
    if (!len || len < 1) throw new Error(`bad token "${token}"`);
    if (note === 'R') {
      steps.push(0x00, 0xfe);
      for (let i = 1; i < len; i++) steps.push(0x00, 0x00);
    } else {
      const hz = noteHz(note);
      const divider = Math.max(0, Math.min(2047, Math.round(2048 - (wave ? 65536 : 131072) / hz)));
      steps.push(divider & 0xff, 0x80 | ((divider >> 8) & 0x07));
      for (let i = 1; i < len; i++) steps.push(0x00, 0x00);
    }
  }
  if (steps.length !== 256) {
    throw new Error(`expected 128 eighth-note steps (256 bytes), got ${steps.length / 2}`);
  }
  return steps;
}

// Section A (bars 1-8): sunlit G-major stroll; Section B (bars 9-16): pond & trees bridge.
const MELODY_SCORE = `
  D5:2 G5:2 B5:3 A5:1   F#5:3 E5:1 D5:4   E5:2 G5:2 D5:3 B4:1   C5:2 E5:2 D5:1 F#5:3
  G5:2 B5:2 D6:3 B5:1   B5:2 G5:2 F#5:4   E5:2 G5:2 A5:2 F#5:2  G5:6 R:2
  E5:3 F#5:1 G5:4       G5:2 E5:2 C5:4    C5:2 E5:2 F#5:3 A5:1  B5:4 A5:4
  G5:2 B5:2 A5:3 F#5:1  G5:2 E5:2 D5:4    C5:2 E5:2 G5:4        F#5:2 A5:2 D5:3 R:1
`;

const BASS_SCORE = `
  G3:4 D3:4   F#3:4 B2:4   C3:4 B2:4   A2:4 D3:4
  G3:4 D3:4   E3:4 B2:4    C3:4 D3:4   G2:6 D3:2
  E3:4 B2:4   C3:4 G2:4    A2:4 D3:4   G3:4 F#3:4
  E3:4 D3:4   C3:4 B2:4    A2:4 C3:4   D3:4 F#3:4
`;

// Warm rounded-cello 32-nibble waveform for Channel 3 ($FF30-$FF3F).
const WAVE_RAM_BYTES = [
  0x24, 0x69, 0xbd, 0xef, 0xfe, 0xdb, 0x96, 0x42,
  0x12, 0x35, 0x79, 0xbc, 0xcb, 0x97, 0x53, 0x21,
];

const MUSIC_DRIVER_ASM = `
; --- Pastoral music player (CH2 melody, CH3 wave bass, CH4 brush; CH1 kept for SFX) ---

init_music:
  xor a
  ldh (rNR30),a
  ld hl,wave_table
  ld c,$30
  ld b,16
.wloop:
  ld a,(hl+)
  ld ($FF00+c),a
  inc c
  dec b
  jr nz,.wloop
  ld a,$80
  ldh (rNR30),a
  ld a,7
  ld (music_tick),a
  ld a,$FF
  ld (music_step),a
  ret

update_music:
  ld a,(music_tick)
  inc a
  cp 8
  jr nc,.step
  ld (music_tick),a
  ret
.step:
  xor a
  ld (music_tick),a
  ld a,(music_step)
  inc a
  and 127
  ld (music_step),a
  ld e,a

  ; --- Channel 2: Lead melody (50% duty in bars 1-8, 25% duty in bars 9-16) -----------
  ld l,e
  ld h,0
  add hl,hl
  ld bc,melody_table
  add hl,bc
  ld a,(hl+)
  ld d,a
  ld a,(hl)
  or a
  jr z,.bass                 ; $00 = sustain current note
  cp $FE
  jr nz,.play_mel
  xor a
  ldh (rNR22),a
  jr .bass
.play_mel:
  ld b,a
  ld a,e
  bit 6,a
  ld a,$80
  jr z,.duty_set
  ld a,$40
.duty_set:
  ldh (rNR21),a
  ld a,$A4
  ldh (rNR22),a
  ld a,d
  ldh (rNR23),a
  ld a,b
  ldh (rNR24),a

  ; --- Channel 3: Walking wave bass ---------------------------------------------------
.bass:
  ld l,e
  ld h,0
  add hl,hl
  ld bc,bass_table
  add hl,bc
  ld a,(hl+)
  ld d,a
  ld a,(hl)
  or a
  jr z,.drums
  cp $FE
  jr nz,.play_bass
  xor a
  ldh (rNR32),a
  jr .drums
.play_bass:
  ld b,a
  ld a,$80
  ldh (rNR30),a
  ld a,$40
  ldh (rNR32),a
  ld a,d
  ldh (rNR33),a
  ld a,b
  ldh (rNR34),a

  ; --- Channel 4: Light pastoral percussion (kick on 1, brush snare on 3, hat on 2/4) -
.drums:
  ld a,e
  and 7
  jr z,.kick
  cp 4
  jr z,.snare
  cp 2
  jr z,.hat
  cp 6
  ret nz
.hat:
  ld a,$36
  ldh (rNR41),a
  ld a,$31
  ldh (rNR42),a
  ld a,$11
  ldh (rNR43),a
  ld a,$C0
  ldh (rNR44),a
  ret
.kick:
  ld a,$24
  ldh (rNR41),a
  ld a,$51
  ldh (rNR42),a
  ld a,$83
  ldh (rNR43),a
  ld a,$C0
  ldh (rNR44),a
  ret
.snare:
  ld a,$2A
  ldh (rNR41),a
  ld a,$41
  ldh (rNR42),a
  ld a,$42
  ldh (rNR43),a
  ld a,$C0
  ldh (rNR44),a
  ret
`;

/** Assembles the demo. @return {{bytes: Uint8Array, summary: string}} */
export function buildDemo() {
  const level = readLevel();
  const total = level.gems.length;
  if (total > 99) throw new Error('the HUD only has two digits');

  const tiles = new Array(FONT_BASE * 16).fill(0);
  TERRAIN_ORDER.forEach((name, i) => tiles.splice(i * 16, 16, ...encode(art(TERRAIN[name]))));
  for (const ch of FONT_ORDER) tiles.push(...encode(glyphTile(ch)));
  const sprites = PLAYER_LEGS.flatMap((legs) => [...encode(art(PLAYER_TOP)), ...encode(art(legs))]);

  const source = [
    `DATA_START equ ${DATA_START}`,
    `GEM_TOTAL equ ${total}`,
    `START_X equ ${level.start.x * 8}`,
    `START_Y equ ${level.start.y * 8}`,
    fs.readFileSync(path.join(ROOT, 'roms/demo.asm'), 'utf8'),
    db('tiles', tiles),
    db('sprites', sprites),
    db('level', level.cells),
    db('hud_text', text(`GEMS 00/${String(total).padStart(2, '0')}`)),
    db('win_text', text('YOU WIN!')),
    MUSIC_DRIVER_ASM,
    db('wave_table', WAVE_RAM_BYTES),
    db('melody_table', encodeTrack(MELODY_SCORE, { wave: false })),
    db('bass_table', encodeTrack(BASS_SCORE, { wave: true })),
  ].join('\n');

  const { bytes, end, symbols } = assemble(source);
  if (symbols.get('code_end') > DATA_START) throw new Error('the code has grown past DATA_START; move it up');
  finishRom(bytes, { title: 'GEM GARDEN' });
  const summary = `code $0150-$${symbols.get('code_end').toString(16)}, ` +
      `data $${DATA_START.toString(16)}-$${end.toString(16)}, ${total} gems`;
  return { bytes, summary };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { bytes, summary } = buildDemo();
  const out = path.join(ROOT, 'roms/demo.gb');
  fs.writeFileSync(out, bytes);
  console.log(`${path.relative(ROOT, out)}: ${summary}`);
}
