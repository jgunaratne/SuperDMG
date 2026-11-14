// Sharp SM83 (the Game Boy CPU).
//
// Timing model: every bus access costs one machine cycle (4 clock ticks) and the bus
// advances the rest of the hardware *before* the access happens, so the timer, PPU and
// APU always see memory accesses at the right moment inside an instruction. Internal
// delay cycles call bus.tickCycle() explicitly. Interrupts are sampled right after the
// opcode fetch, which is where the real CPU decides between "execute this opcode" and
// "start interrupt dispatch".

export class CPU {
  constructor(bus) {
    this.bus = bus;
    this.a = 0; this.b = 0; this.c = 0; this.d = 0; this.e = 0; this.h = 0; this.l = 0;
    // Flags are kept unpacked as 0/1 integers and assembled into F on demand.
    this.fz = 0; this.fn = 0; this.fh = 0; this.fc = 0;
    this.sp = 0;
    this.pc = 0;
    this.ime = false;      // interrupt master enable
    this.imeDelay = false; // EI takes effect after the following instruction
    this.halted = false;
    this.haltBug = false;  // next opcode byte is read twice
    this.stopped = false;
    this.locked = false;   // executed an undefined opcode: the real CPU hangs until reset
    this.lockedOpcode = 0;
    /** Called when LD B,B executes: test ROMs use it as a software breakpoint. */
    this.onBreak = null;
  }

  get f() { return (this.fz << 7) | (this.fn << 6) | (this.fh << 5) | (this.fc << 4); }
  set f(v) { this.fz = (v >> 7) & 1; this.fn = (v >> 6) & 1; this.fh = (v >> 5) & 1; this.fc = (v >> 4) & 1; }
  get af() { return (this.a << 8) | this.f; }
  set af(v) { this.a = (v >> 8) & 0xff; this.f = v & 0xf0; }
  get bc() { return (this.b << 8) | this.c; }
  set bc(v) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }
  get de() { return (this.d << 8) | this.e; }
  set de(v) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }
  get hl() { return (this.h << 8) | this.l; }
  set hl(v) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  /** Runs one instruction, one interrupt dispatch, or one idle cycle while halted. */
  step() {
    const bus = this.bus;
    if (this.locked) { bus.tickCycle(); return; }
    if (this.halted) {
      // A halted CPU keeps re-reading the opcode after HALT, one fetch per cycle, and
      // samples its interrupt lines in the middle of each of those cycles. A flag
      // raised in the second half of a cycle (bus.lateIrq) is noticed a cycle later.
      bus.tickCycle();
      if (bus.ie & bus.iflag & ~bus.lateIrq & 0x1f) {
        this.halted = false;
        // The cycle that just ended was the fetch: either it is thrown away for the
        // interrupt, or its opcode runs now.
        if (this.ime) this.dispatchInterrupt();
        else this.run(bus.read(this.pc));
      }
      return;
    }
    if (this.stopped) {
      bus.tickCycle();
      if (bus.joypad.anyPressed()) this.stopped = false;
      return;
    }

    const opcode = bus.readCycle(this.pc);
    if (this.ime && (bus.ie & bus.iflag & 0x1f)) {
      // The fetched opcode is thrown away and PC is not advanced.
      this.dispatchInterrupt();
      return;
    }
    this.run(opcode);
  }

  /** Executes an opcode that has just been fetched from PC. */
  run(opcode) {
    if (this.imeDelay) { this.ime = true; this.imeDelay = false; }
    if (this.haltBug) this.haltBug = false;
    else this.pc = (this.pc + 1) & 0xffff;
    this.execute(opcode);
  }

  dispatchInterrupt() {
    const bus = this.bus;
    this.ime = false;
    this.imeDelay = false;
    bus.tickCycle();
    bus.tickCycle();
    this.sp = (this.sp - 1) & 0xffff;
    bus.writeCycle(this.sp, this.pc >> 8);
    // The vector is chosen late: pushing the high byte can itself rewrite IE (SP = 0),
    // which cancels the dispatch and sends the CPU to $0000.
    const enabled = bus.ie;
    this.sp = (this.sp - 1) & 0xffff;
    bus.writeCycle(this.sp, this.pc & 0xff);
    const pending = enabled & bus.iflag & 0x1f;
    if (pending) {
      const bit = 31 - Math.clz32(pending & -pending);
      bus.iflag &= ~(1 << bit);
      this.pc = 0x40 + (bit << 3);
    } else {
      this.pc = 0;
    }
  }

  fetch8() {
    const v = this.bus.readCycle(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    return v;
  }

  fetch16() {
    const lo = this.fetch8();
    return (this.fetch8() << 8) | lo;
  }

  push16(v) {
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.writeCycle(this.sp, (v >> 8) & 0xff);
    this.sp = (this.sp - 1) & 0xffff;
    this.bus.writeCycle(this.sp, v & 0xff);
  }

  pop16() {
    const lo = this.bus.readCycle(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    const hi = this.bus.readCycle(this.sp);
    this.sp = (this.sp + 1) & 0xffff;
    return (hi << 8) | lo;
  }

  // 8-bit operand by opcode register code: B C D E H L (HL) A
  getR(code) {
    switch (code) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.bus.readCycle((this.h << 8) | this.l);
      default: return this.a;
    }
  }

  setR(code, v) {
    switch (code) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.bus.writeCycle((this.h << 8) | this.l, v); break;
      default: this.a = v;
    }
  }

  // 16-bit operand by opcode pair code: BC DE HL SP
  getRP(code) {
    switch (code) {
      case 0: return (this.b << 8) | this.c;
      case 1: return (this.d << 8) | this.e;
      case 2: return (this.h << 8) | this.l;
      default: return this.sp;
    }
  }

  setRP(code, v) {
    switch (code) {
      case 0: this.b = (v >> 8) & 0xff; this.c = v & 0xff; break;
      case 1: this.d = (v >> 8) & 0xff; this.e = v & 0xff; break;
      case 2: this.h = (v >> 8) & 0xff; this.l = v & 0xff; break;
      default: this.sp = v & 0xffff;
    }
  }

  condition(code) {
    switch (code) {
      case 0: return !this.fz;
      case 1: return !!this.fz;
      case 2: return !this.fc;
      default: return !!this.fc;
    }
  }

  // ADD ADC SUB SBC AND XOR OR CP against A
  alu(op, v) {
    const a = this.a;
    switch (op) {
      case 0: { // ADD
        const r = a + v;
        this.fz = (r & 0xff) === 0 ? 1 : 0; this.fn = 0;
        this.fh = (a & 0xf) + (v & 0xf) > 0xf ? 1 : 0; this.fc = r > 0xff ? 1 : 0;
        this.a = r & 0xff;
        break;
      }
      case 1: { // ADC
        const c = this.fc;
        const r = a + v + c;
        this.fz = (r & 0xff) === 0 ? 1 : 0; this.fn = 0;
        this.fh = (a & 0xf) + (v & 0xf) + c > 0xf ? 1 : 0; this.fc = r > 0xff ? 1 : 0;
        this.a = r & 0xff;
        break;
      }
      case 2: { // SUB
        const r = a - v;
        this.fz = (r & 0xff) === 0 ? 1 : 0; this.fn = 1;
        this.fh = (a & 0xf) < (v & 0xf) ? 1 : 0; this.fc = r < 0 ? 1 : 0;
        this.a = r & 0xff;
        break;
      }
      case 3: { // SBC
        const c = this.fc;
        const r = a - v - c;
        this.fz = (r & 0xff) === 0 ? 1 : 0; this.fn = 1;
        this.fh = (a & 0xf) - (v & 0xf) - c < 0 ? 1 : 0; this.fc = r < 0 ? 1 : 0;
        this.a = r & 0xff;
        break;
      }
      case 4: // AND
        this.a = a & v;
        this.fz = this.a === 0 ? 1 : 0; this.fn = 0; this.fh = 1; this.fc = 0;
        break;
      case 5: // XOR
        this.a = a ^ v;
        this.fz = this.a === 0 ? 1 : 0; this.fn = 0; this.fh = 0; this.fc = 0;
        break;
      case 6: // OR
        this.a = a | v;
        this.fz = this.a === 0 ? 1 : 0; this.fn = 0; this.fh = 0; this.fc = 0;
        break;
      default: { // CP
        const r = a - v;
        this.fz = (r & 0xff) === 0 ? 1 : 0; this.fn = 1;
        this.fh = (a & 0xf) < (v & 0xf) ? 1 : 0; this.fc = r < 0 ? 1 : 0;
      }
    }
  }

  inc8(v) {
    const r = (v + 1) & 0xff;
    this.fz = r === 0 ? 1 : 0; this.fn = 0; this.fh = (v & 0xf) === 0xf ? 1 : 0;
    return r;
  }

  dec8(v) {
    const r = (v - 1) & 0xff;
    this.fz = r === 0 ? 1 : 0; this.fn = 1; this.fh = (v & 0xf) === 0 ? 1 : 0;
    return r;
  }

  // SP + signed 8-bit offset, used by ADD SP,e and LD HL,SP+e. Flags come from the
  // unsigned low-byte addition.
  spOffset(byte) {
    const sp = this.sp;
    this.fz = 0; this.fn = 0;
    this.fh = (sp & 0xf) + (byte & 0xf) > 0xf ? 1 : 0;
    this.fc = (sp & 0xff) + byte > 0xff ? 1 : 0;
    return (sp + ((byte << 24) >> 24)) & 0xffff;
  }

  jr(taken) {
    const offset = (this.fetch8() << 24) >> 24;
    if (taken) {
      this.bus.tickCycle();
      this.pc = (this.pc + offset) & 0xffff;
    }
  }

  jp(taken) {
    const target = this.fetch16();
    if (taken) {
      this.bus.tickCycle();
      this.pc = target;
    }
  }

  call(taken) {
    const target = this.fetch16();
    if (taken) {
      this.bus.tickCycle();
      this.push16(this.pc);
      this.pc = target;
    }
  }

  ret() {
    this.pc = this.pop16();
    this.bus.tickCycle();
  }

  halt() {
    const bus = this.bus;
    if (bus.ie & bus.iflag & 0x1f) {
      // An interrupt is already waiting, so the CPU never actually stops.
      if (this.ime) this.pc = (this.pc - 1) & 0xffff; // dispatch now, return to this HALT
      else this.haltBug = true;
    } else {
      this.halted = true;
      bus.tickCycle();
    }
  }

  execute(op) {
    const bus = this.bus;
    const x = op >> 6;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 1) {
      if (op === 0x76) this.halt();
      else this.setR(y, this.getR(z)); // LD r,r'
      if (op === 0x40 && this.onBreak) this.onBreak();
      return;
    }
    if (x === 2) {
      this.alu(y, this.getR(z));
      return;
    }

    const p = y >> 1;
    const q = y & 1;

    if (x === 0) {
      switch (z) {
        case 0:
          if (y === 0) return; // NOP
          if (y === 1) { // LD (nn),SP
            const addr = this.fetch16();
            bus.writeCycle(addr, this.sp & 0xff);
            bus.writeCycle((addr + 1) & 0xffff, this.sp >> 8);
            return;
          }
          if (y === 2) { // STOP
            this.pc = (this.pc + 1) & 0xffff;
            this.stopped = true;
            bus.timer.writeDiv();
            return;
          }
          this.jr(y === 3 || this.condition(y - 4));
          return;
        case 1:
          if (q === 0) { // LD rp,nn
            this.setRP(p, this.fetch16());
          } else { // ADD HL,rp
            const hl = (this.h << 8) | this.l;
            const v = this.getRP(p);
            const r = hl + v;
            this.fn = 0;
            this.fh = (hl & 0xfff) + (v & 0xfff) > 0xfff ? 1 : 0;
            this.fc = r > 0xffff ? 1 : 0;
            this.h = (r >> 8) & 0xff; this.l = r & 0xff;
            bus.tickCycle();
          }
          return;
        case 2: {
          const hl = (this.h << 8) | this.l;
          if (q === 0) {
            switch (p) {
              case 0: bus.writeCycle((this.b << 8) | this.c, this.a); break; // LD (BC),A
              case 1: bus.writeCycle((this.d << 8) | this.e, this.a); break; // LD (DE),A
              case 2: bus.writeCycle(hl, this.a); this.hl = (hl + 1) & 0xffff; break; // LD (HL+),A
              default: bus.writeCycle(hl, this.a); this.hl = (hl - 1) & 0xffff;       // LD (HL-),A
            }
          } else {
            switch (p) {
              case 0: this.a = bus.readCycle((this.b << 8) | this.c); break; // LD A,(BC)
              case 1: this.a = bus.readCycle((this.d << 8) | this.e); break; // LD A,(DE)
              case 2: this.a = bus.readCycle(hl); this.hl = (hl + 1) & 0xffff; break; // LD A,(HL+)
              default: this.a = bus.readCycle(hl); this.hl = (hl - 1) & 0xffff;       // LD A,(HL-)
            }
          }
          return;
        }
        case 3: // INC rp / DEC rp
          this.setRP(p, (this.getRP(p) + (q === 0 ? 1 : -1)) & 0xffff);
          bus.tickCycle();
          return;
        case 4: this.setR(y, this.inc8(this.getR(y))); return;
        case 5: this.setR(y, this.dec8(this.getR(y))); return;
        case 6: this.setR(y, this.fetch8()); return; // LD r,n
        default:
          switch (y) {
            case 0: { // RLCA
              const c = this.a >> 7;
              this.a = ((this.a << 1) | c) & 0xff;
              this.fz = 0; this.fn = 0; this.fh = 0; this.fc = c;
              return;
            }
            case 1: { // RRCA
              const c = this.a & 1;
              this.a = (this.a >> 1) | (c << 7);
              this.fz = 0; this.fn = 0; this.fh = 0; this.fc = c;
              return;
            }
            case 2: { // RLA
              const c = this.a >> 7;
              this.a = ((this.a << 1) | this.fc) & 0xff;
              this.fz = 0; this.fn = 0; this.fh = 0; this.fc = c;
              return;
            }
            case 3: { // RRA
              const c = this.a & 1;
              this.a = (this.a >> 1) | (this.fc << 7);
              this.fz = 0; this.fn = 0; this.fh = 0; this.fc = c;
              return;
            }
            case 4: { // DAA
              let a = this.a;
              if (!this.fn) {
                if (this.fc || a > 0x99) { a += 0x60; this.fc = 1; }
                if (this.fh || (a & 0x0f) > 0x09) a += 0x06;
              } else {
                if (this.fc) a -= 0x60;
                if (this.fh) a -= 0x06;
              }
              this.a = a & 0xff;
              this.fz = this.a === 0 ? 1 : 0; this.fh = 0;
              return;
            }
            case 5: this.a ^= 0xff; this.fn = 1; this.fh = 1; return; // CPL
            case 6: this.fn = 0; this.fh = 0; this.fc = 1; return;    // SCF
            default: this.fn = 0; this.fh = 0; this.fc ^= 1; return;  // CCF
          }
      }
    }

    // x === 3
    switch (z) {
      case 0:
        if (y < 4) { // RET cc
          bus.tickCycle();
          if (this.condition(y)) this.ret();
          return;
        }
        if (y === 4) { bus.writeCycle(0xff00 | this.fetch8(), this.a); return; }  // LDH (n),A
        if (y === 6) { this.a = bus.readCycle(0xff00 | this.fetch8()); return; }  // LDH A,(n)
        if (y === 5) { // ADD SP,e
          this.sp = this.spOffset(this.fetch8());
          bus.tickCycle(); bus.tickCycle();
          return;
        }
        this.hl = this.spOffset(this.fetch8()); // LD HL,SP+e
        bus.tickCycle();
        return;
      case 1:
        if (q === 0) { // POP rp2
          const v = this.pop16();
          if (p === 3) this.af = v; else this.setRP(p, v);
          return;
        }
        if (p === 0) { this.ret(); return; }
        if (p === 1) { this.ret(); this.ime = true; return; } // RETI: no delay
        if (p === 2) { this.pc = (this.h << 8) | this.l; return; } // JP HL
        this.sp = (this.h << 8) | this.l; // LD SP,HL
        bus.tickCycle();
        return;
      case 2:
        if (y < 4) { this.jp(this.condition(y)); return; }
        if (y === 4) { bus.writeCycle(0xff00 | this.c, this.a); return; }  // LD (C),A
        if (y === 6) { this.a = bus.readCycle(0xff00 | this.c); return; }  // LD A,(C)
        if (y === 5) { bus.writeCycle(this.fetch16(), this.a); return; }   // LD (nn),A
        this.a = bus.readCycle(this.fetch16());                            // LD A,(nn)
        return;
      case 3:
        if (y === 0) { this.jp(true); return; }
        if (y === 1) { this.executeCB(this.fetch8()); return; }
        if (y === 6) { this.ime = false; this.imeDelay = false; return; } // DI
        if (y === 7) { if (!this.ime) this.imeDelay = true; return; }    // EI
        this.lock(op);
        return;
      case 4:
        if (y < 4) this.call(this.condition(y));
        else this.lock(op);
        return;
      case 5:
        if (q === 0) { // PUSH rp2
          bus.tickCycle();
          this.push16(p === 3 ? this.af : this.getRP(p));
          return;
        }
        if (p === 0) this.call(true);
        else this.lock(op);
        return;
      case 6: this.alu(y, this.fetch8()); return;
      default: // RST
        bus.tickCycle();
        this.push16(this.pc);
        this.pc = y << 3;
    }
  }

  executeCB(op) {
    const reg = op & 7;
    const y = (op >> 3) & 7;
    const v = this.getR(reg);
    let r;
    switch (op >> 6) {
      case 0:
        switch (y) {
          case 0: this.fc = v >> 7; r = ((v << 1) | this.fc) & 0xff; break;                 // RLC
          case 1: this.fc = v & 1; r = (v >> 1) | (this.fc << 7); break;                    // RRC
          case 2: r = ((v << 1) | this.fc) & 0xff; this.fc = v >> 7; break;                 // RL
          case 3: r = (v >> 1) | (this.fc << 7); this.fc = v & 1; break;                    // RR
          case 4: this.fc = v >> 7; r = (v << 1) & 0xff; break;                             // SLA
          case 5: this.fc = v & 1; r = (v >> 1) | (v & 0x80); break;                        // SRA
          case 6: this.fc = 0; r = ((v << 4) | (v >> 4)) & 0xff; break;                     // SWAP
          default: this.fc = v & 1; r = v >> 1;                                             // SRL
        }
        this.fz = r === 0 ? 1 : 0; this.fn = 0; this.fh = 0;
        break;
      case 1: // BIT: flags only, nothing is written back
        this.fz = (v >> y) & 1 ? 0 : 1; this.fn = 0; this.fh = 1;
        return;
      case 2: r = v & ~(1 << y); break; // RES
      default: r = v | (1 << y);        // SET
    }
    this.setR(reg, r);
  }

  lock(op) {
    this.locked = true;
    this.lockedOpcode = op;
    this.pc = (this.pc - 1) & 0xffff;
  }
}
