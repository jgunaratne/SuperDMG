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
