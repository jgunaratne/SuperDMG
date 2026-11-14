// Screen colour schemes: four colours, lightest shade first.

export const PALETTES = [
  { id: 'classic', name: 'Classic', colors: ['#9bbc0f', '#8bac0f', '#306230', '#0f380f'] },
  { id: 'pocket', name: 'Pocket', colors: ['#c7ccab', '#8f9672', '#4c533b', '#191c13'] },
  { id: 'grey', name: 'Greys', colors: ['#ffffff', '#aaaaaa', '#555555', '#000000'] },
  { id: 'paper', name: 'Paper', colors: ['#f3eee0', '#c4b698', '#72664f', '#231f19'] },
];

/** Packs "#rrggbb" into the 32-bit layout of a Uint32Array over ImageData. */
export function packColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16)) >>> 0;
}

export function packPalette(palette) {
  return Uint32Array.from(palette.colors, packColor);
}

export function findPalette(id) {
  return PALETTES.find((p) => p.id === id) || PALETTES[0];
}
