import test from 'node:test';
import assert from 'node:assert/strict';
import { machine, runToBreak } from './helpers.mjs';

test('arithmetic sets flags the way the hardware does', () => {
  const gb = runToBreak(machine(`
  ld a,$0F
  add a,$01          ; half carry
  ld b,a
  push af
  ld a,$F0
  add a,$10          ; carry and zero
  push af
  ld a,$15
  add a,$27
  daa                ; 15 + 27 = 42 in BCD
  ld c,a
  ld a,$10
  sub $01            ; borrow from bit 4
  ld d,a
  push af
  ld a,$00
  cp $01             ; borrow
  push af
  ld hl,$0FFF
  ld de,$0001
  add hl,de          ; 16-bit half carry
  pop de             ; flags after CP -> E
  ld b,b
`));
  const cpu = gb.cpu;
  assert.equal(cpu.c, 0x42, 'DAA');
  assert.equal(cpu.hl, 0x1000);
  assert.equal(cpu.e & 0xf0, 0x70, 'CP 0,1: N H C');
  const stack = (offset) => gb.peek(cpu.sp + offset);
  assert.equal(stack(0) & 0xf0, 0x60, 'SUB $10,1: N H');
  assert.equal(stack(1), 0x0f);
  assert.equal(stack(2) & 0xf0, 0x90, 'ADD $F0,$10: Z C');
  assert.equal(stack(4) & 0xf0, 0x20, 'ADD $0F,1: H');
  assert.equal(stack(5), 0x10);
});

test('instructions take the documented number of machine cycles', () => {
  // Each snippet runs between two LD B,B markers; the marker itself costs one cycle.
  const cases = [
    ['nop', 1], ['ld a,b', 1], ['ld a,$12', 2], ['ld a,(hl)', 2], ['ld (hl),$12', 3],
    ['inc (hl)', 3], ['ld a,($C000)', 4], ['ldh a,($FF80)', 3], ['ld ($C000),sp', 5],
    ['push bc', 4], ['pop bc', 3], ['add hl,bc', 2], ['inc bc', 2], ['add sp,1', 4],
    ['ld hl,sp+1', 3], ['jp .next\n.next:', 4], ['jr .next\n.next:', 3],
    ['xor a\n  jr nz,.next\n.next:', 1 + 2], ['xor a\n  jr z,.next\n.next:', 1 + 3],
    ['call .sub\n  jr .next\n.sub:\n  ret\n.next:', 6 + 4 + 3],
    ['xor a\n  call nz,.next\n.next:', 1 + 3], ['rst $08', 4 + 4],
    ['bit 7,(hl)', 3], ['set 7,(hl)', 4], ['rlc b', 2], ['ld sp,hl', 2],
  ];
  for (const [code, cycles] of cases) {
    const gb = machine(`
  ld hl,$C100
  ld sp,$D000
  ld b,b
  ${code}
  ld b,b
  org $0008
  ret
`);
    runToBreak(gb);
    const start = gb.cycles;
    runToBreak(gb);
    assert.equal(gb.cycles - start - 1, cycles, code.split('\n')[0]);
  }
});

test('EI takes effect one instruction late; RETI re-enables at once', () => {
  const gb = runToBreak(machine(`
  ld sp,$D000
  ld a,$04
  ldh ($FFFF),a      ; enable the timer interrupt
  ldh ($FF0F),a      ; and request it
  ld c,0
  ei
  inc c              ; runs before the interrupt is taken
  inc c              ; runs after the handler returns
  ld b,b
  org $0050
  ld d,c             ; what C was when the handler ran
  reti
`));
  assert.equal(gb.cpu.d, 1);
  assert.equal(gb.cpu.c, 2);
  assert.equal(gb.cpu.ime, true);
  assert.equal(gb.iflag & 0x04, 0, 'the request is cleared when it is serviced');
});

test('HALT sleeps until an interrupt is requested', () => {
  const gb = machine(`
  ld sp,$D000
  ld a,$04
  ldh ($FFFF),a
  ld a,$FE
  ldh ($FF05),a      ; TIMA overflows after two ticks
  ld a,$05
  ldh ($FF07),a      ; fastest timer
  ei
  halt
  ld b,b
  org $0050
  ld e,$77
  reti
`);
  runToBreak(gb);
  assert.equal(gb.cpu.e, 0x77);
  assert.equal(gb.cpu.halted, false);
});

test('HALT with interrupts disabled and one pending repeats the next byte', () => {
  const gb = runToBreak(machine(`
  di
  ld a,$04
  ldh ($FFFF),a
  ldh ($FF0F),a      ; pending, but IME is off
  xor a
  halt
  inc a              ; fetched twice
  ld b,b
`));
  assert.equal(gb.cpu.a, 2);
});

test('an undefined opcode locks the CPU up', () => {
  const gb = machine(`
  db $DD
  ld b,b
`);
  for (let i = 0; i < 100; i++) gb.cpu.step();
  assert.equal(gb.cpu.locked, true);
  assert.equal(gb.cpu.lockedOpcode, 0xdd);
  assert.equal(gb.cpu.pc, 0x150);
});

test('reset leaves the registers as the boot ROM does', () => {
  const gb = machine('  ld b,b');
  const { cpu } = gb;
  assert.deepEqual([cpu.af, cpu.bc, cpu.de, cpu.hl, cpu.sp, cpu.pc],
    [0x01b0, 0x0013, 0x00d8, 0x014d, 0xfffe, 0x0100]);
  assert.equal(gb.peek(0xff40), 0x91);
  assert.equal(gb.peek(0xff0f), 0xe1);
  assert.equal(gb.peek(0xff26), 0xf1);
});
