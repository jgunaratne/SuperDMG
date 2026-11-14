// A small two-pass SM83 assembler, used to build the bundled demo ROM from source.
//
// The instruction set is not written out a second time here: the encoding table is
// derived from the disassembler in src/core/disasm.js, so the two always agree on
// syntax. Memory operands use parentheses, as the disassembler prints them:
//
//     ld a,(hl)      ldh ($FF40),a      ld ($C000),a      jr nz,.loop
//
// Also supported: `name:` and `.local:` labels, `NAME equ expr`, `org`, `db` (bytes
// and "strings"), `dw`, `ds count[,fill]`, and expressions with $hex, %binary,
// + - * / & | ^ << >> ~, parentheses, HIGH() and LOW().

import { disassemble } from '../src/core/disasm.js';

const hex = (v, d) => v.toString(16).toUpperCase().padStart(d, '0');

/** pattern text -> {bytes, operand kind or null}. Built once from the disassembler. */
function buildTable() {
  const table = new Map();
  for (let op = 0; op < 256; op++) {
    if (op === 0xcb) continue;
    const code = [op, 0x34, 0x12];
    const { text, length } = disassemble((a) => code[a] ?? 0, 0);
    if (text.startsWith('DB ')) continue; // undefined opcode
    let pattern = text;
    let kind = null;
    if (length === 3) {
      pattern = text.replace('$1234', '%16');
      kind = '16';
    } else if (length === 2 && text !== 'STOP') {
      if (text.startsWith('JR ')) { pattern = text.replace(/\$[0-9A-F]{4}/, '%r'); kind = 'r'; }
      else if (text.startsWith('LDH ')) { pattern = text.replace('$FF34', '%h'); kind = 'h'; }
      else if (op === 0xe8 || op === 0xf8) { pattern = text.replace(/[+-]?\d+$/, (m) => (op === 0xf8 ? '+%s' : '%s')); kind = 's'; }
      else { pattern = text.replace('$34', '%8'); kind = '8'; }
    }
    table.set(pattern, { bytes: text === 'STOP' ? [op, 0] : [op], kind });
  }
  for (let op = 0; op < 256; op++) {
    const code = [0xcb, op];
    table.set(disassemble((a) => code[a], 0).text, { bytes: [0xcb, op], kind: null });
  }
  return table;
}

const TABLE = buildTable();
const FIXED = new Set(['A', 'B', 'C', 'D', 'E', 'H', 'L', 'AF', 'BC', 'DE', 'HL', 'SP', 'NZ', 'Z', 'NC',
  '(BC)', '(DE)', '(HL)', '(HL+)', '(HL-)', '($FF00+C)']);
const ALIASES = { '(C)': '($FF00+C)', '(HLI)': '(HL+)', '(HLD)': '(HL-)' };

class AsmError extends Error {
  constructor(message, line) {
    super(`line ${line.number}: ${message}\n    ${line.text.trim()}`);
  }
}

/** Splits on commas that are not inside quotes or parentheses. */
function splitOperands(text) {
  const parts = [];
  let depth = 0, quote = false, current = '';
  for (const ch of text) {
    if (ch === '"') quote = !quote;
    if (!quote) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Recursive-descent expression evaluator. `lookup(name)` resolves symbols. */
function evaluate(text, lookup) {
  let pos = 0;
  const peek = () => { while (text[pos] === ' ') pos++; return text[pos]; };
  const eat = (s) => { peek(); if (text.startsWith(s, pos)) { pos += s.length; return true; } return false; };
  const binary = (next, ops) => () => {
    let value = next();
    for (;;) {
      peek();
      const op = ops.find((o) => text.startsWith(o, pos));
      if (!op) return value;
      pos += op.length;
      const rhs = next();
      switch (op) {
        case '|': value |= rhs; break;
        case '^': value ^= rhs; break;
        case '&': value &= rhs; break;
        case '<<': value <<= rhs; break;
        case '>>': value >>= rhs; break;
        case '+': value += rhs; break;
        case '-': value -= rhs; break;
        case '*': value *= rhs; break;
        case '/': value = Math.trunc(value / rhs); break;
        default: break;
      }
    }
  };
  const primary = () => {
    const ch = peek();
    if (ch === undefined) throw new Error('unexpected end of expression');
    if (eat('(')) { const v = expr(); if (!eat(')')) throw new Error('missing )'); return v; }
    let m;
    const rest = text.slice(pos);
    if ((m = /^\$([0-9A-Fa-f]+)/.exec(rest))) { pos += m[0].length; return parseInt(m[1], 16); }
    if ((m = /^%([01]+)/.exec(rest))) { pos += m[0].length; return parseInt(m[1], 2); }
    if ((m = /^\d+/.exec(rest))) { pos += m[0].length; return parseInt(m[0], 10); }
    if ((m = /^'(.)'/.exec(rest))) { pos += 3; return m[1].charCodeAt(0); }
    if ((m = /^(HIGH|LOW)\s*\(/i.exec(rest))) {
      pos += m[0].length;
      const v = expr();
      if (!eat(')')) throw new Error('missing )');
      return m[1].toUpperCase() === 'HIGH' ? (v >> 8) & 0xff : v & 0xff;
    }
    if ((m = /^[.A-Za-z_][\w.]*/.exec(rest))) { pos += m[0].length; return lookup(m[0]); }
    throw new Error(`unexpected "${rest}"`);
  };
  const unary = () => {
    if (eat('-')) return -unary();
    if (eat('~')) return ~unary();
    if (eat('+')) return unary();
    return primary();
  };
  const mul = binary(unary, ['*', '/']);
  const add = binary(mul, ['+', '-']);
  const shift = binary(add, ['<<', '>>']);
  const and = binary(shift, ['&']);
  const xor = binary(and, ['^']);
  const expr = binary(xor, ['|']);
  const value = expr();
  if (peek() !== undefined) throw new Error(`unexpected "${text.slice(pos)}"`);
  return value;
}

/**
 * Assembles source text into a ROM-sized buffer.
 * @param {string} source
 * @param {{size?: number, fill?: number}} [options]
 * @return {{bytes: Uint8Array, symbols: Map<string, number>, end: number}} `end` is
 *     the highest address written, plus one
 */
export function assemble(source, options = {}) {
  const bytes = new Uint8Array(options.size || 0x8000).fill(options.fill ?? 0x00);
  const symbols = new Map();
  const lines = source.split('\n').map((text, i) => ({ text, number: i + 1 }));
  let end = 0;

  for (let pass = 1; pass <= 2; pass++) {
    let pc = 0;
    let scope = '';
    const lookup = (line) => (name) => {
      const full = name.startsWith('.') ? scope + name : name;
      if (symbols.has(full)) return symbols.get(full);
      if (pass === 1) return 0; // forward reference, resolved in pass 2
      throw new AsmError(`unknown symbol "${name}"`, line);
    };
    const emit = (line, ...values) => {
      for (const v of values) {
        if (pc >= bytes.length) throw new AsmError('address past the end of the ROM', line);
        if (pass === 2) bytes[pc] = v & 0xff;
        pc++;
      }
      if (pc > end) end = pc;
    };
    const calc = (line, text) => {
      try {
        return evaluate(text, lookup(line));
      } catch (err) {
        if (err instanceof AsmError) throw err;
        throw new AsmError(err.message, line);
      }
    };

    for (const line of lines) {
      let text = '';
      let quote = false;
      for (const ch of line.text) { // strip the comment
        if (ch === '"') quote = !quote;
        if (ch === ';' && !quote) break;
        text += ch;
      }
      text = text.trim();
      if (!text) continue;

      let m;
      if ((m = /^([.A-Za-z_][\w.]*):\s*(.*)$/.exec(text))) {
        const name = m[1].startsWith('.') ? scope + m[1] : m[1];
        if (!m[1].startsWith('.')) scope = m[1];
        if (pass === 1) {
          if (symbols.has(name)) throw new AsmError(`"${name}" is defined twice`, line);
          symbols.set(name, pc);
        }
        text = m[2];
        if (!text) continue;
      }
      if ((m = /^([A-Za-z_]\w*)\s+equ\s+(.+)$/i.exec(text))) {
        if (pass === 1) symbols.set(m[1], calc(line, m[2]));
        continue;
      }

      const space = text.search(/\s/);
      const mnemonic = (space < 0 ? text : text.slice(0, space)).toUpperCase();
      const operands = space < 0 ? [] : splitOperands(text.slice(space + 1));

      if (mnemonic === 'ORG') { pc = calc(line, operands[0]); continue; }
      if (mnemonic === 'DB') {
        for (const operand of operands) {
          if (operand.startsWith('"')) emit(line, ...[...operand.slice(1, -1)].map((c) => c.charCodeAt(0)));
          else emit(line, calc(line, operand));
        }
        continue;
      }
      if (mnemonic === 'DW') {
        for (const operand of operands) { const v = calc(line, operand); emit(line, v, v >> 8); }
        continue;
      }
      if (mnemonic === 'DS') {
        const count = calc(line, operands[0]);
        const fill = operands[1] ? calc(line, operands[1]) : 0;
        for (let i = 0; i < count; i++) emit(line, fill);
        continue;
      }

      // An instruction. Each operand is either fixed text (a register, a condition)
      // or an expression that fills one of the table's placeholders.
      const shapes = operands.map((operand, index) => {
        let upper = operand.replace(/\s+/g, '').toUpperCase();
        upper = ALIASES[upper] || upper;
        if (FIXED.has(upper)) return [{ text: upper }];
        if ((mnemonic === 'BIT' || mnemonic === 'RES' || mnemonic === 'SET') && index === 0) {
          return [{ text: String(calc(line, operand)) }];
        }
        if (mnemonic === 'RST') return [{ text: `$${hex(calc(line, operand), 2)}` }];
        if (/^SP[+-]/.test(upper)) return [{ text: 'SP+%s', expr: operand.replace(/^\s*sp\s*/i, '') }];
        if (operand.startsWith('(') && operand.endsWith(')')) {
          const inner = operand.slice(1, -1);
          return [{ text: '(%16)', expr: inner }, { text: '(%h)', expr: inner }];
        }
        return ['%8', '%16', '%r', '%s'].map((p) => ({ text: p, expr: operand }));
      });

      let match = null;
      const search = (index, chosen) => {
        if (match) return;
        if (index === shapes.length) {
          const pattern = mnemonic + (chosen.length ? ' ' + chosen.map((c) => c.text).join(',') : '');
          const entry = TABLE.get(pattern);
          if (entry) match = { entry, expr: (chosen.find((c) => c.expr !== undefined) || {}).expr };
          return;
        }
        for (const shape of shapes[index]) search(index + 1, [...chosen, shape]);
      };
      search(0, []);
      if (!match) throw new AsmError('no such instruction', line);

      const { entry, expr } = match;
      const start = pc;
      emit(line, ...entry.bytes);
      if (!entry.kind) continue;
      const value = calc(line, expr);
      const check = (ok, what) => { if (pass === 2 && !ok) throw new AsmError(`${what} out of range (${value})`, line); };
      switch (entry.kind) {
        case '16': check(value >= -0x8000 && value <= 0xffff, 'value'); emit(line, value, value >> 8); break;
        case '8': check(value >= -0x80 && value <= 0xff, 'value'); emit(line, value); break;
        case 's': check(value >= -0x80 && value <= 0x7f, 'offset'); emit(line, value); break;
        case 'h': check((value >= 0xff00 && value <= 0xffff) || (value >= 0 && value <= 0xff), 'high-page address'); emit(line, value); break;
        default: { // relative jump
          const offset = value - (start + 2);
          if (pass === 2 && (offset < -128 || offset > 127)) throw new AsmError(`jump target too far (${offset})`, line);
          emit(line, offset);
        }
      }
    }
  }
  return { bytes, symbols, end };
}

/** Fills in the cartridge header fields and both checksums. */
export function finishRom(bytes, { title = '', type = 0x00, ramSize = 0x00 } = {}) {
  for (let i = 0; i < 16; i++) bytes[0x134 + i] = i < title.length ? title.charCodeAt(i) : 0;
  bytes[0x147] = type;
  bytes[0x148] = Math.log2(bytes.length / 0x8000);
  bytes[0x149] = ramSize;
  bytes[0x14a] = 0x01; // not Japan
  bytes[0x14b] = 0x00;
  let header = 0;
  for (let i = 0x134; i <= 0x14c; i++) header = (header - bytes[i] - 1) & 0xff;
  bytes[0x14d] = header;
  bytes[0x14e] = 0;
  bytes[0x14f] = 0;
  let global = 0;
  for (const b of bytes) global = (global + b) & 0xffff;
  bytes[0x14e] = global >> 8;
  bytes[0x14f] = global & 0xff;
  return bytes;
}
