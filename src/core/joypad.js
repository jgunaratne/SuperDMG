// Joypad (P1, $FF00). Two select lines choose which half of the button matrix shows up
// in the low nibble; a pressed button pulls its bit low.

export const BUTTONS = ['right', 'left', 'up', 'down', 'a', 'b', 'select', 'start'];

export class Joypad {
  constructor(gb) {
    this.gb = gb;
    this.reset();
  }

  reset() {
    this.select = 0x00; // bits 4-5 as written; 0 = that half is selected
    this.state = 0;     // bit per entry of BUTTONS, 1 = held
    this.lines = 0x0f;
  }

  computeLines() {
    let lines = 0x0f;
    if (!(this.select & 0x10)) lines &= ~(this.state & 0x0f);
    if (!(this.select & 0x20)) lines &= ~(this.state >> 4);
    return lines & 0x0f;
  }

  update() {
    const lines = this.computeLines();
    // The interrupt fires when any selected line goes from high to low.
    if (this.lines & ~lines) this.gb.iflag |= 0x10;
    this.lines = lines;
  }

  read() { return 0xc0 | this.select | this.lines; }

  write(v) {
    this.select = v & 0x30;
    this.update();
  }

  /** @param {string} name one of BUTTONS */
  set(name, pressed) {
    const bit = BUTTONS.indexOf(name);
    if (bit < 0) throw new Error(`unknown button "${name}"`);
    if (pressed) this.state |= 1 << bit;
    else this.state &= ~(1 << bit);
    this.update();
  }

  anyPressed() { return this.state !== 0; }
}
