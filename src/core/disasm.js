// SM83 disassembler. Used by the debugging tools; has no dependencies on the rest of
// the core so it can run against any byte source.

const R8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const R16 = ['BC', 'DE', 'HL', 'SP'];
const R16_STACK = ['BC', 'DE', 'HL', 'AF'];
const CONDITION = ['NZ', 'Z', 'NC', 'C'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const ROTATE = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SWAP', 'SRL'];
const ACCUMULATOR = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'];

const hex2 = (v) => '$' + v.toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => '$' + v.toString(16).toUpperCase().padStart(4, '0');

/**
 * Disassembles one instruction.
 * @param {(addr: number) => number} read byte reader
 * @param {number} pc address of the opcode
 * @return {{text: string, length: number}}
 */
export function disassemble(read, pc) {
  const op = read(pc);
  const imm8 = () => read((pc + 1) & 0xffff);
  const imm16 = () => imm8() | (read((pc + 2) & 0xffff) << 8);
  const relative = () => hex4((pc + 2 + ((imm8() << 24) >> 24)) & 0xffff);
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;

  if (x === 1) return { text: op === 0x76 ? 'HALT' : `LD ${R8[y]},${R8[z]}`, length: 1 };
  if (x === 2) return { text: ALU[y] + R8[z], length: 1 };

  if (x === 0) {
    switch (z) {
      case 0:
        if (y === 0) return { text: 'NOP', length: 1 };
        if (y === 1) return { text: `LD (${hex4(imm16())}),SP`, length: 3 };
        if (y === 2) return { text: 'STOP', length: 2 };
        if (y === 3) return { text: `JR ${relative()}`, length: 2 };
        return { text: `JR ${CONDITION[y - 4]},${relative()}`, length: 2 };
      case 1:
        return q === 0 ? { text: `LD ${R16[p]},${hex4(imm16())}`, length: 3 }
          : { text: `ADD HL,${R16[p]}`, length: 1 };
      case 2: {
        const target = ['(BC)', '(DE)', '(HL+)', '(HL-)'][p];
        return { text: q === 0 ? `LD ${target},A` : `LD A,${target}`, length: 1 };
      }
      case 3: return { text: `${q === 0 ? 'INC' : 'DEC'} ${R16[p]}`, length: 1 };
      case 4: return { text: `INC ${R8[y]}`, length: 1 };
      case 5: return { text: `DEC ${R8[y]}`, length: 1 };
      case 6: return { text: `LD ${R8[y]},${hex2(imm8())}`, length: 2 };
      default: return { text: ACCUMULATOR[y], length: 1 };
    }
  }

  switch (z) {
    case 0:
      if (y < 4) return { text: `RET ${CONDITION[y]}`, length: 1 };
      if (y === 4) return { text: `LDH (${hex4(0xff00 | imm8())}),A`, length: 2 };
      if (y === 5) return { text: `ADD SP,${(imm8() << 24) >> 24}`, length: 2 };
      if (y === 6) return { text: `LDH A,(${hex4(0xff00 | imm8())})`, length: 2 };
      return { text: `LD HL,SP${(imm8() << 24) >> 24 >= 0 ? '+' : ''}${(imm8() << 24) >> 24}`, length: 2 };
    case 1:
      if (q === 0) return { text: `POP ${R16_STACK[p]}`, length: 1 };
      return { text: ['RET', 'RETI', 'JP HL', 'LD SP,HL'][p], length: 1 };
    case 2:
      if (y < 4) return { text: `JP ${CONDITION[y]},${hex4(imm16())}`, length: 3 };
      if (y === 4) return { text: 'LD ($FF00+C),A', length: 1 };
      if (y === 5) return { text: `LD (${hex4(imm16())}),A`, length: 3 };
      if (y === 6) return { text: 'LD A,($FF00+C)', length: 1 };
      return { text: `LD A,(${hex4(imm16())})`, length: 3 };
    case 3:
      if (y === 0) return { text: `JP ${hex4(imm16())}`, length: 3 };
      if (y === 1) {
        const cb = imm8();
        const reg = R8[cb & 7], n = (cb >> 3) & 7;
        const text = [`${ROTATE[n]} ${reg}`, `BIT ${n},${reg}`, `RES ${n},${reg}`, `SET ${n},${reg}`][cb >> 6];
        return { text, length: 2 };
      }
      if (y === 6) return { text: 'DI', length: 1 };
      if (y === 7) return { text: 'EI', length: 1 };
      break;
    case 4:
      if (y < 4) return { text: `CALL ${CONDITION[y]},${hex4(imm16())}`, length: 3 };
      break;
    case 5:
      if (q === 0) return { text: `PUSH ${R16_STACK[p]}`, length: 1 };
      if (p === 0) return { text: `CALL ${hex4(imm16())}`, length: 3 };
      break;
    case 6: return { text: `${ALU[y]}${hex2(imm8())}`, length: 2 };
    default: return { text: `RST ${hex2(y << 3)}`, length: 1 };
  }
  return { text: `DB ${hex2(op)}`, length: 1 };
}
