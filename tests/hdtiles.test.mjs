import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameBoy } from '../src/core/gameboy.js';
import {
  HD_SCREEN_W, HD_SCREEN_H, HD_TILE_PX, HD_SCALE,
  tileFingerprint, hexToTileBytes, exteriorMask, extractRomArtTiles, collectScreenTiles,
  shiftTile2bpp, packChroma64, HdTilePack, bytesToBase64,
} from '../src/core/hdtiles.js';
import { upgradeScreenTiles, clearDiskCache } from '../tools/tile_upgrader.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO = fs.readFileSync(path.join(ROOT, 'roms/demo.gb'));

describe('Advanced Tile Mode (whole-game pixel-locked colorization)', () => {
  it('fingerprints 2bpp tiles and preserves enclosed interior highlights in exteriorMask', () => {
    const gemBytes = new Uint8Array([
      0x00, 0x00, 0x18, 0x18, 0x24, 0x3c, 0x42, 0x66,
      0x46, 0x66, 0x3c, 0x3c, 0x18, 0x18, 0x00, 0x00,
    ]);
    const fp = tileFingerprint(gemBytes);
    assert.equal(fp.length, 32);
    assert.deepEqual(hexToTileBytes(fp), gemBytes);

    const ring = new Uint8Array(64);
    for (let y = 1; y <= 6; y++) {
      for (let x = 1; x <= 6; x++) {
        if (x === 1 || x === 6 || y === 1 || y === 6) ring[y * 8 + x] = 3;
      }
    }
    const ext = exteriorMask(ring, 0);
    assert.equal(ext[0], 1, 'outer corner is transparent background');
    assert.equal(ext[3 * 8 + 3], 0, 'enclosed interior highlight is preserved');
  });

  it('scans whole Cartridge ROM + VRAM for uncompressed 2bpp art tiles alongside visible scene', () => {
    const gb = new GameBoy();
    gb.loadRom(DEMO);
    for (let i = 0; i < 20; i++) gb.runFrame();

    const romKeys = extractRomArtTiles(DEMO);
    assert.ok(romKeys.length >= 8, `extracts art tiles directly from Cartridge ROM (got ${romKeys.length})`);

    const captured = collectScreenTiles(gb.ppu, gb.cart.header.title, DEMO);
    assert.equal(captured.title, 'GEM GARDEN');
    assert.equal(captured.groundKey, tileFingerprint(gb.ppu.vram, 0));
    assert.equal(captured.gridCells.length, 360, 'captures full 20x18 tile-aligned scene grid');
    assert.ok(captured.extraSheetKeys.length >= 10, 'includes VRAM + whole-ROM art tiles for upfront batch colorization');

    const roles = new Set(captured.tiles.map((t) => t.role));
    assert.ok(roles.has('surface'), 'finds full-bleed surfaces (grass, wall, water)');
    assert.ok(roles.has('cutout'), 'finds foreground cutouts on grass (flower, gem)');
    assert.ok(roles.has('hud'), 'finds window-layer status bar tiles');
    assert.ok(roles.has('spr16'), 'pairs 8x16 player sprites together');
    assert.equal(captured.spriteClusters.length, 2, 'captures both standing and walking 8x16 sprite clusters');
  });

  it('groups touching 8x8 OAM sprites into a connected 16x16 metasprite cluster', () => {
    const gb = new GameBoy();
    gb.ppu.lcdc = 0x93; // 8x8 sprites
    for (let i = 0; i < 4; i++) {
      gb.ppu.vram[(10 + i) * 16] = 0xff;
      gb.ppu.oam[i * 4] = 60 + ((i >> 1) * 8) + 16;
      gb.ppu.oam[i * 4 + 1] = 40 + ((i & 1) * 8) + 8;
      gb.ppu.oam[i * 4 + 2] = 10 + i;
    }
    const captured = collectScreenTiles(gb.ppu, 'SAGA2');
    assert.equal(captured.spriteClusters.length, 1, '4 adjacent 8x8 sprites form 1 connected 16x16 cluster');
    assert.equal(captured.spriteClusters[0].w, 16);
    assert.equal(captured.spriteClusters[0].h, 16);
    assert.equal(captured.spriteClusters[0].members.length, 4);
  });

  it('keeps exact 8x8 pixel positions and shifts pixel-locked chroma on VRAM bit rotation', () => {
    const gb = new GameBoy();
    gb.loadRom(DEMO);
    for (let i = 0; i < 10; i++) gb.runFrame();

    const waterOffset = 4 * 16;
    const waterFrame0 = gb.ppu.vram.slice(waterOffset, waterOffset + 16);
    const waterKey0 = tileFingerprint(waterFrame0);

    // Give Game Boy column x = 1 cyan chroma and other columns deep blue chroma.
    const ab = new Float32Array(128);
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) {
        ab[(py * 8 + px) * 2] = px === 1 ? -0.14 : -0.02;
        ab[(py * 8 + px) * 2 + 1] = px === 1 ? -0.06 : -0.18;
      }
    }

    const pack = new HdTilePack('snes');
    pack.ingest({
      theme: 'Fantasy garden',
      shades: ['#dceec8', '#6fb357', '#356b4a', '#16202a'],
      hudShades: ['#faf2dc', '#c0a070', '#605048', '#1e2230'],
      tiles: {
        [`bg:${waterKey0}`]: { key: waterKey0, role: 'surface', chromaBase64: bytesToBase64(packChroma64(ab)) },
      },
    });

    const fallback = new Uint32Array([0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000]);
    const u32Before = pack.resolveBgU32(gb.ppu.vram, 4, false, gb.ppu.bgp, fallback);
    // Every 4x4 block corresponding to 1 Game Boy pixel must be a uniform crisp square!
    for (let dy = 0; dy < HD_SCALE; dy++) {
      for (let dx = 0; dx < HD_SCALE; dx++) {
        assert.equal(u32Before[dy * HD_TILE_PX + 4 + dx], u32Before[4], 'exact 4x4 pixel-locked square block');
      }
    }
    const col1Before = u32Before[4]; // Game Boy column x = 1 (HD x = 4..7)

    // Advance 16 frames so demo.asm's `rlca` loop rotates TILE_WATER left by 1 pixel.
    for (let i = 0; i < 16; i++) gb.runFrame();
    const waterFrame1 = gb.ppu.vram.slice(waterOffset, waterOffset + 16);
    assert.deepEqual(waterFrame1, shiftTile2bpp(waterFrame0, 1, 0));

    const shiftedU32 = pack.resolveBgU32(gb.ppu.vram, 4, false, gb.ppu.bgp, fallback);
    assert.equal(pack.missingKeys.size, 0, 'rotated water tile matched existing surface without missing');
    assert.equal(shiftedU32[0], col1Before, 'column x=1 pixel color shifted cleanly to column x=0');
  });

  it('colorizes whole-game tiles and renders pixel-locked 640x576 frames', async () => {
    const prev = process.env.HD_TILE_BACKEND;
    process.env.HD_TILE_BACKEND = 'procedural';
    const testCartId = 'UNIT_TEST_DEMO';
    try {
      clearDiskCache(testCartId, 'neon');
      const gb = new GameBoy();
      gb.loadRom(DEMO);
      for (let i = 0; i < 20; i++) gb.runFrame();

      const captured = collectScreenTiles(gb.ppu, 'GEM GARDEN', DEMO);
      const upgraded = await upgradeScreenTiles({
        cartId: testCartId,
        title: captured.title,
        style: 'neon',
        bgp: captured.bgp,
        obp0: captured.obp0,
        obp1: captured.obp1,
        groundKey: captured.groundKey,
        screenShadesBase64: bytesToBase64(captured.shades),
        gridCells: captured.gridCells,
        spriteClusters: captured.spriteClusters,
        extraSheetKeys: captured.extraSheetKeys,
        tiles: captured.tiles,
      });
      assert.equal(upgraded.ok, true);
      assert.equal(upgraded.wholeGameDone, true);
      assert.ok(Object.keys(upgraded.tiles).length >= 10);

      const pack = new HdTilePack('neon');
      pack.ingest(upgraded);
      const roundTrip = HdTilePack.fromRecord(pack.toRecord());
      assert.equal(roundTrip.count, pack.count);
      assert.equal(roundTrip.wholeGameDone, true);

      const out = new Uint32Array(HD_SCREEN_W * HD_SCREEN_H);
      const fallback = new Uint32Array([0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000]);
      roundTrip.renderHdFrame(gb.ppu, fallback, out);

      // Verify every 4x4 block in the 640x576 output is strictly uniform (exact Game Boy pixel positions!)
      for (let y = 0; y < 144; y += 17) {
        for (let x = 0; x < 160; x += 19) {
          const base = (y * 4) * HD_SCREEN_W + (x * 4);
          assert.equal(out[base + 3], out[base]);
          assert.equal(out[base + 3 * HD_SCREEN_W + 3], out[base]);
        }
      }

      const colors = new Set();
      for (let i = 0; i < out.length; i += 13) colors.add(out[i]);
      assert.ok(colors.size >= 6, 'colorized frame contains multiple rich palette hues');
    } finally {
      clearDiskCache(testCartId, 'neon');
      if (prev === undefined) delete process.env.HD_TILE_BACKEND;
      else process.env.HD_TILE_BACKEND = prev;
    }
  });

  it('supports full 24-bit per-pixel RGB within one 8x8 tile and promotes rom-tier tiles to scene-tier', () => {
    const gb = new GameBoy();
    gb.loadRom(DEMO);
    for (let i = 0; i < 10; i++) gb.runFrame();

    const key = tileFingerprint(gb.ppu.vram, 2 * 16); // gem tile
    const rgb24Rom = new Uint8Array(192).fill(120);
    const rgb24Scene = new Uint8Array(192);
    for (let i = 0; i < 64; i++) {
      rgb24Scene[i * 3] = (i * 4) & 0xff;
      rgb24Scene[i * 3 + 1] = (255 - i * 3) & 0xff;
      rgb24Scene[i * 3 + 2] = (80 + i * 2) & 0xff;
    }

    const pack = new HdTilePack('snes');
    pack.ingest({
      tiles: { [`bg:${key}`]: { key, role: 'bg', tier: 'rom', pal: gb.ppu.bgp, rgb24Base64: bytesToBase64(rgb24Rom) } },
    });
    const fb = new Uint32Array([0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000]);
    pack.resolveBgU32(gb.ppu.vram, 2, false, gb.ppu.bgp, fb, true);
    assert.equal(pack.romTierOnScreen.has(`bg:${key}`), true, 'tracks visible rom-tier tile for automatic scene promotion');

    // Promote to 24-bit scene-tier with distinct RGB values across pixels!
    pack.ingest({
      tiles: { [`bg:${key}`]: { key, role: 'bg', tier: 'scene', pal: gb.ppu.bgp, rgb24Base64: bytesToBase64(rgb24Scene) } },
    });
    assert.equal(pack.romTierOnScreen.has(`bg:${key}`), false, 'clears promotion queue once upgraded to scene-tier');
    const u32 = pack.resolveBgU32(gb.ppu.vram, 2, false, gb.ppu.bgp, fb, true);
    const distinct = new Set();
    for (let py = 0; py < 8; py++) {
      for (let px = 0; px < 8; px++) distinct.add(u32[(py * 4) * HD_TILE_PX + (px * 4)]);
    }
    assert.equal(distinct.size, 64, 'preserves all 64 independent 24-bit RGB pixel colors on exact 4x4 blocks');
  });
});
