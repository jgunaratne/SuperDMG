import test from 'node:test';
import assert from 'node:assert/strict';
import { machine, blankRom } from './helpers.mjs';
import { GameBoy } from '../src/core/gameboy.js';
import { Cartridge, parseHeader } from '../src/core/cartridge.js';

const idle = () => machine('.spin:\n  jr .spin');

test('DIV counts up every 64 machine cycles and any write clears it', () => {
  const gb = idle();
  gb.write(0xff04, 0x55);
  assert.equal(gb.peek(0xff04), 0);
  const start = gb.cycles;
  while (gb.peek(0xff04) === 0) gb.cpu.step();
  assert.ok(gb.cycles - start >= 64 && gb.cycles - start <= 66);
});

test('TIMA overflows into TMA and requests the timer interrupt', () => {
  const gb = idle();
  gb.write(0xff06, 0xf0);   // TMA
  gb.write(0xff05, 0xff);   // TIMA
  gb.write(0xff04, 0);      // restart the divider so the first tick is a full period away
  gb.write(0xff07, 0x05);   // enabled, one tick per 4 cycles
  gb.iflag = 0;
  const start = gb.cycles;
  while (!(gb.iflag & 4)) gb.cpu.step();
  assert.ok(gb.cycles - start <= 8, 'overflow within two ticks');
  assert.equal(gb.peek(0xff05), 0xf0);
  // 16 more ticks (64 cycles) wrap it again.
  gb.iflag = 0;
  const again = gb.cycles;
  while (!(gb.iflag & 4)) gb.cpu.step();
  assert.ok(Math.abs(gb.cycles - again - 64) <= 3);
});

test('the timer stays still while disabled', () => {
  const gb = idle();
  gb.write(0xff07, 0x01);
  gb.write(0xff05, 7);
  for (let i = 0; i < 500; i++) gb.cpu.step();
  assert.equal(gb.peek(0xff05), 7);
});

test('joypad: select lines, active-low buttons and the interrupt', () => {
  const gb = idle();
  gb.write(0xff00, 0x20);           // D-pad selected
  assert.equal(gb.peek(0xff00), 0xef);
  gb.iflag = 0;
  gb.setButton('left', true);
  assert.equal(gb.peek(0xff00), 0xed);
  assert.equal(gb.iflag & 0x10, 0x10);
  gb.setButton('a', true);
  assert.equal(gb.peek(0xff00), 0xed, 'buttons are not visible on the D-pad line');
  gb.write(0xff00, 0x10);           // buttons selected
  assert.equal(gb.peek(0xff00), 0xde);
  gb.write(0xff00, 0x30);           // nothing selected
  assert.equal(gb.peek(0xff00), 0xff);
  gb.setButton('left', false);
  gb.setButton('a', false);
  assert.throws(() => gb.setButton('turbo', true), /unknown button/);
});

test('serial transfers with the internal clock complete and report the byte', () => {
  const gb = idle();
  const sent = [];
  gb.serial.onByte = (b) => sent.push(b);
  gb.write(0xff01, 0x41);
  gb.iflag = 0;
  gb.write(0xff02, 0x81);
  assert.deepEqual(sent, [0x41]);
  for (let i = 0; i < 400 && !(gb.iflag & 8); i++) gb.cpu.step();
  assert.equal(gb.iflag & 8, 8);
  assert.equal(gb.peek(0xff01), 0xff, 'nothing is connected, so ones are shifted in');
  assert.equal(gb.peek(0xff02) & 0x80, 0);
});

test('OAM DMA copies 160 bytes and takes OAM off the bus while it runs', () => {
  const gb = idle();
  for (let i = 0; i < 160; i++) gb.wram[0x100 + i] = i ^ 0x5a;
  gb.runFrame(); // into VBlank, where OAM is otherwise readable
  gb.ppu.oam.fill(0);
  gb.write(0xff46, 0xc1);
  gb.tickCycle(); gb.tickCycle(); gb.tickCycle();
  assert.equal(gb.read(0xfe00), 0xff, 'busy');
  for (let i = 0; i < 170; i++) gb.tickCycle();
  assert.equal(gb.read(0xfe00), 0x5a);
  assert.deepEqual([...gb.ppu.oam], Array.from({ length: 160 }, (_, i) => i ^ 0x5a));
  assert.equal(gb.peek(0xff46), 0xc1);
});

test('memory map: echo RAM, unusable area, high RAM and IE', () => {
  const gb = idle();
  gb.write(0xc123, 0x42);
  assert.equal(gb.read(0xe123), 0x42);
  gb.write(0xfd00, 0x24);
  assert.equal(gb.read(0xdd00), 0x24);
  gb.write(0xff90, 0x99);
  assert.equal(gb.read(0xff90), 0x99);
  gb.write(0xffff, 0x1f);
  assert.equal(gb.read(0xffff), 0x1f);
  assert.equal(gb.read(0xff03), 0xff, 'unmapped I/O reads high');
  gb.write(0x0150, 0x00);
  assert.notEqual(gb.read(0x0150), 0x00, 'ROM is read-only');
});

// --- Cartridges --------------------------------------------------------------------------

const bankAt = (cart, addr) => cart.readRom(addr) | (cart.readRom(addr + 1) << 8);

test('header fields are parsed', () => {
  const rom = blankRom({ type: 0x1b, banks: 64, ramSize: 3 });
  const header = parseHeader(rom);
  assert.equal(header.title, 'MAPPER');
  assert.equal(header.headerChecksumValid, true);
  const cart = new Cartridge(rom);
  assert.equal(cart.typeName, 'MBC5+RAM+BATTERY');
  assert.equal(cart.romBanks, 64);
  assert.equal(cart.ram.length, 0x8000);
  assert.equal(cart.hasBattery, true);
});

test('unusable images are rejected with a readable message', () => {
  assert.throws(() => new Cartridge(new Uint8Array(100)), /too small/);
  assert.throws(() => new Cartridge(blankRom({ type: 0x22 })), /unsupported mapper \(MBC7/);
  assert.throws(() => new GameBoy().loadRom(blankRom({ type: 0xfc })), /Pocket Camera/);
});

test('MBC1: bank 0 becomes 1, high bits, RAM gating and banking mode', () => {
  const cart = new Cartridge(blankRom({ type: 0x03, banks: 128, ramSize: 3 }));
  assert.equal(bankAt(cart, 0x6000), 1);
  cart.writeRom(0x2000, 0x00);
  assert.equal(bankAt(cart, 0x6000), 1, 'bank 0 cannot be selected');
  cart.writeRom(0x2000, 0x12);
  assert.equal(bankAt(cart, 0x6000), 0x12);
  cart.writeRom(0x4000, 0x02);
  assert.equal(bankAt(cart, 0x6000), 0x52);
  assert.equal(bankAt(cart, 0x2000), 0, 'low area stays on bank 0 in mode 0');
  cart.writeRom(0x6000, 0x01);
  assert.equal(bankAt(cart, 0x2000), 0x40, 'mode 1 banks the low area too');

  assert.equal(cart.readRam(0xa000), 0xff, 'RAM disabled');
  cart.writeRam(0xa000, 0x77);
  cart.writeRom(0x0000, 0x0a);
  assert.equal(cart.readRam(0xa000), 0x00, 'the write while disabled was dropped');
  cart.writeRam(0xa000, 0x77);          // RAM bank 2 in mode 1
  cart.writeRom(0x4000, 0x00);
  assert.equal(cart.readRam(0xa000), 0x00);
  cart.writeRom(0x4000, 0x02);
  assert.equal(cart.readRam(0xa000), 0x77);
  assert.equal(cart.ramDirty, true);
});

test('plain ROM+RAM cartridges have their RAM always switched in', () => {
  const cart = new Cartridge(blankRom({ type: 0x09, ramSize: 2 }));
  cart.writeRam(0xa010, 0x3c);
  assert.equal(cart.readRam(0xa010), 0x3c);
  assert.equal(cart.hasBattery, true);
  assert.equal(new Cartridge(blankRom({ type: 0x00 })).readRam(0xa000), 0xff, 'no RAM at all reads high');
});

test('MBC2: bank select by address bit 8 and 4-bit RAM', () => {
  const cart = new Cartridge(blankRom({ type: 0x06, banks: 16 }));
  cart.writeRom(0x2100, 0x05);
  assert.equal(bankAt(cart, 0x6000), 5);
  cart.writeRom(0x0000, 0x0a);
  cart.writeRam(0xa000, 0xab);
  assert.equal(cart.readRam(0xa000), 0xfb, 'upper nibble reads as ones');
  assert.equal(cart.readRam(0xa200), 0xfb, 'the 512 cells repeat');
});

test('MBC3: banking and a clock that follows wall time', () => {
  let now = 1_000_000_000_000;
  const cart = new Cartridge(blankRom({ type: 0x10, banks: 128, ramSize: 3 }), { now: () => now });
  cart.writeRom(0x2000, 0x7f);
  assert.equal(bankAt(cart, 0x6000), 0x7f);
  cart.writeRom(0x0000, 0x0a);
  const latch = () => { cart.writeRom(0x6000, 0); cart.writeRom(0x6000, 1); };
  const clock = () => [0x08, 0x09, 0x0a, 0x0b, 0x0c].map((r) => { cart.writeRom(0x4000, r); return cart.readRam(0xa000); });

  now += (1 * 86400 + 2 * 3600 + 3 * 60 + 4) * 1000;
  assert.deepEqual(clock(), [0, 0, 0, 0, 0], 'not latched yet');
  latch();
  assert.deepEqual(clock(), [4, 3, 2, 1, 0]);

  now += 5000;
  assert.deepEqual(clock(), [4, 3, 2, 1, 0], 'latched value holds');
  latch();
  assert.equal(clock()[0], 9);

  // Halting stops the clock.
  cart.writeRom(0x4000, 0x0c);
  cart.writeRam(0xa000, 0x40);
  now += 60000;
  latch();
  assert.equal(clock()[0], 9);

  // RAM banks still work alongside the clock registers.
  cart.writeRom(0x4000, 0x02);
  cart.writeRam(0xa000, 0x5a);
  cart.writeRom(0x4000, 0x00);
  assert.equal(cart.readRam(0xa000), 0x00);
});

test('MBC5: nine-bit ROM bank, bank 0 selectable', () => {
  const cart = new Cartridge(blankRom({ type: 0x19, banks: 512 }));
  cart.writeRom(0x2000, 0x00);
  assert.equal(bankAt(cart, 0x6000), 0);
  cart.writeRom(0x2000, 0x34);
  cart.writeRom(0x3000, 0x01);
  assert.equal(bankAt(cart, 0x6000), 0x134);
});

test('battery saves round-trip, including the clock footer', () => {
  let now = 1_700_000_000_000;
  const rom = blankRom({ type: 0x10, banks: 4, ramSize: 2 });
  const cart = new Cartridge(rom, { now: () => now });
  cart.writeRom(0x0000, 0x0a);
  cart.writeRam(0xa123, 0xc3);
  now += 90 * 1000;
  const save = cart.getSaveData();
  assert.equal(save.length, 0x2000 + 48);

  // Load it two hours later: the clock has moved on by the time switched off.
  now += 2 * 3600 * 1000;
  const later = new Cartridge(rom, { now: () => now });
  later.loadSaveData(save);
  later.writeRom(0x0000, 0x0a);
  assert.equal(later.readRam(0xa123), 0xc3);
  later.writeRom(0x6000, 0); later.writeRom(0x6000, 1);
  const read = (r) => { later.writeRom(0x4000, r); return later.readRam(0xa000); };
  assert.deepEqual([read(0x08), read(0x09), read(0x0a)], [30, 1, 2]);
  assert.equal(later.ramDirty, false);

  assert.equal(new Cartridge(blankRom({ type: 0x01 })).getSaveData(), null, 'no battery, no save');
});
