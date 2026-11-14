// Serial port (SB/SC). There is never a link partner: transfers clocked by this Game
// Boy shift in 1s and complete after eight clock edges; transfers waiting on an
// external clock never finish. Outgoing bytes are reported through onByte, which is how
// test ROMs print their results.

export class Serial {
  constructor(gb) {
    this.gb = gb;
    this.onByte = null;
    this.reset();
  }

  reset() {
    this.sb = 0;
    this.sc = 0;
    this.bitsLeft = 0;
  }

  /** One falling edge of the 8192 Hz shift clock. */
  clock() {
    if (this.bitsLeft === 0) return;
    if (--this.bitsLeft === 0) {
      this.sb = 0xff;
      this.sc &= 0x7f;
      this.gb.iflag |= 0x08;
      this.gb.lateIrq |= 0x08;
    }
  }

  readSc() { return this.sc | 0x7e; }

  writeSc(v) {
    this.sc = v & 0x81;
    if ((v & 0x81) === 0x81) {
      this.bitsLeft = 8;
      if (this.onByte) this.onByte(this.sb);
    } else {
      this.bitsLeft = 0;
    }
  }
}
