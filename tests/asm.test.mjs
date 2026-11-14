import test from 'node:test';
import assert from 'node:assert/strict';
import { assemble, finishRom } from '../tools/asm.mjs';
import { disassemble } from '../src/core/disasm.js';

const bytesAt = (out, start, count) => [...out.bytes.subarray(start, start + count)];

test('every instruction survives disassemble -> assemble', () => {
  const failures = [];
  const check = (code) => {
    const { text, length } = disassemble((a) => code[a - 0x200] ?? 0, 0x200);
    if (text.startsWith('DB ') || text === 'STOP') return; // undefined opcodes; STOP pads with 0
    const out = assemble(`  org $200\n  ${text}`);
    const got = bytesAt(out, 0x200, length).join();
    if (got !== code.slice(0, length).join()) failures.push(`${text}: ${got}`);
  };
  for (let op = 0; op < 256; op++) {
    if (op === 0xcb) continue;
    check([op, 0x7f, 0x12]);
    check([op, 0x80, 0xfe]); // negative offsets and high addresses
  }
  for (let op = 0; op < 256; op++) check([0xcb, op]);
  assert.deepEqual(failures, []);
});

test('labels, local labels and forward references', () => {
  const out = assemble(`
  org $100
first:
  jr .skip
  nop
.skip:
  jp second
second:
.skip:
  jr .skip
`);
  assert.deepEqual(bytesAt(out, 0x100, 8), [0x18, 0x01, 0x00, 0xc3, 0x06, 0x01, 0x18, 0xfe]);
  assert.equal(out.symbols.get('first.skip'), 0x103);
  assert.equal(out.symbols.get('second.skip'), 0x106);
});

test('constants, expressions and data directives', () => {
  const out = assemble(`
BASE equ $C000
SIZE equ 4*8+2
  org $0
  db 1, $FF, %1010, 'A', "hi", SIZE
  dw BASE+SIZE, HIGH(BASE) << 8 | LOW($1234)
  ds 3, $EE
  ld a,(BASE+1)
  ldh (BASE>>8 | $FF00),a
  ld hl,sp+-2
  add a,~$0F & $FF
`);
  assert.deepEqual(bytesAt(out, 0, 7), [1, 0xff, 0x0a, 0x41, 0x68, 0x69, 34]);
  assert.deepEqual(bytesAt(out, 7, 4), [0x22, 0xc0, 0x34, 0xc0]);
  assert.deepEqual(bytesAt(out, 11, 3), [0xee, 0xee, 0xee]);
  assert.deepEqual(bytesAt(out, 14, 9), [0xfa, 0x01, 0xc0, 0xe0, 0xc0, 0xf8, 0xfe, 0xc6, 0xf0]);
  assert.equal(out.end, 23);
});

test('mistakes are reported with the line', () => {
  assert.throws(() => assemble('  ld q,1'), /line 1: no such instruction/);
  assert.throws(() => assemble('\n  jp nowhere'), /line 2: unknown symbol "nowhere"/);
  assert.throws(() => assemble('top:\n  ds 200\n  jr top'), /jump target too far/);
  assert.throws(() => assemble('x:\nx:'), /defined twice/);
  assert.throws(() => assemble('  ld a,300'), /out of range/);
});

test('finishRom writes a header the cartridge loader accepts', async () => {
  const { parseHeader } = await import('../src/core/cartridge.js');
  const rom = finishRom(new Uint8Array(0x10000), { title: 'HELLO', type: 0x13, ramSize: 3 });
  const header = parseHeader(rom);
  assert.equal(header.title, 'HELLO');
  assert.equal(header.type, 0x13);
  assert.equal(header.romSizeCode, 1);
  assert.equal(header.ramSizeCode, 3);
  assert.equal(header.headerChecksumValid, true);
  let sum = 0;
  rom.forEach((b, i) => { if (i !== 0x14e && i !== 0x14f) sum = (sum + b) & 0xffff; });
  assert.equal(header.globalChecksum, sum);
});
