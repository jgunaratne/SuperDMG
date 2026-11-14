// Minimal PNG reader/writer on top of node:zlib. Enough for test reference images
// (greyscale, palette, RGB, RGBA at 1-8 bits, non-interlaced) and for dumping
// screenshots from the headless tools.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @param {Uint8Array} bytes PNG file contents
 * @return {{width: number, height: number, data: Uint8Array}} 8-bit RGBA pixels
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, transparency = null;
  const idat = [];
  for (let pos = 8; pos + 12 <= buf.length;) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      transparency = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (interlace) throw new Error('interlaced PNGs are not supported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || depth > 8) throw new Error(`unsupported PNG format (type ${colorType}, depth ${depth})`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const pixels = Buffer.alloc(stride * height);

  // Undo the per-scanline prediction filters.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bytesPerPixel ? pixels[dst + x - bytesPerPixel] : 0;
      const b = y > 0 ? pixels[dst + x - stride] : 0;
      const c = x >= bytesPerPixel && y > 0 ? pixels[dst + x - stride - bytesPerPixel] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      pixels[dst + x] = (raw[src + x] + predicted) & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  const maxValue = (1 << depth) - 1;
  const sample = (y, index) => {
    if (depth === 8) return pixels[y * stride + index];
    const bit = index * depth;
    return (pixels[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & maxValue;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      let r, g, b, a = 255;
      if (colorType === 3) {
        const entry = sample(y, i);
        r = palette[entry * 3]; g = palette[entry * 3 + 1]; b = palette[entry * 3 + 2];
        if (transparency && entry < transparency.length) a = transparency[entry];
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = Math.round((sample(y, i) * 255) / maxValue);
        if (colorType === 4) a = Math.round((sample(y, i + 1) * 255) / maxValue);
      } else {
        r = sample(y, i); g = sample(y, i + 1); b = sample(y, i + 2);
        if (colorType === 6) a = sample(y, i + 3);
      }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba 8-bit RGBA pixels
 * @return {Buffer} PNG file contents
 */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Expands a shade buffer (values 0-3) to RGBA using four [r, g, b] colours. */
export function shadesToRgba(shades, colors, scale = 1, width = 160) {
  const height = shades.length / width;
  const out = new Uint8Array(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const [r, g, b] = colors[shades[((y / scale) | 0) * width + ((x / scale) | 0)] & 3];
      const o = (y * width * scale + x) * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

/** The greys the test-ROM collection uses for its reference screenshots. */
export const REFERENCE_GREYS = [[0xff, 0xff, 0xff], [0xaa, 0xaa, 0xaa], [0x55, 0x55, 0x55], [0x00, 0x00, 0x00]];
