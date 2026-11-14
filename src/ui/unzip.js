// Pulls a Game Boy ROM out of a .zip archive, since that is how ROMs are often kept.
// Handles ordinary archives: entries stored as-is or deflated, no encryption, no zip64.

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;

export const looksLikeZip = (bytes) => bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

/**
 * @param {Uint8Array} zip archive contents
 * @return {Promise<?{name: string, bytes: Uint8Array}>} the first .gb or .gbc entry,
 *     or null if the archive has none
 */
export async function romFromZip(zip) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // The directory is located from a record at the very end (before an optional comment).
  let end = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 0xffff; i--) {
    if (view.getUint32(i, true) === END_OF_DIRECTORY) { end = i; break; }
  }
  if (end < 0) throw new Error('the archive is damaged or incomplete');

  const count = view.getUint16(end + 10, true);
  let pos = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count && pos + 46 <= zip.length; n++) {
    if (view.getUint32(pos, true) !== DIRECTORY_ENTRY) break;
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const packedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const path = decoder.decode(zip.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;
    if (!/\.gbc?$/i.test(path)) continue;

    const name = path.slice(path.lastIndexOf('/') + 1);
    if (flags & 1) throw new Error(`${name} is password protected`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = zip.subarray(start, start + packedSize);
    if (method === 0) return { name, bytes: packed.slice() };
    if (method !== 8) throw new Error(`${name} is compressed in a way this page cannot read`);
    const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (bytes.length !== size) throw new Error(`${name} is damaged`);
    return { name, bytes };
  }
  return null;
}
