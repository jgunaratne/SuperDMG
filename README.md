# SuperDMG

**SuperDMG** is a Game Boy (DMG) emulator that runs in the browser, with AI tile
remastering, General MIDI instruments, and a live explorer for the tiles, tilemaps and
sprites a game has in video memory.

- **Play**: load any original Game Boy (DMG) ROM, or the built-in demo. Keyboard,
  gamepad and touch controls, sound, battery saves that persist in the browser.
- **Explore**: see every tile in video RAM as the game runs, hover or click anything
  (a tile, a map cell, a sprite, a pixel on the game screen) to inspect it, and see
  where a tile is used on screen. You can also read the cartridge ROM itself as tiles.
- **Advanced Tile Mode**: pre-scans uncompressed 2bpp tiles across the entire Cartridge
  ROM plus active VRAM, colorizes the live screen and whole-game tile sheets in parallel
  via the Gemini Image API (`gemini-2.5-flash-image`), and locks every pixel's exact 8×8
  Game Boy position and hardware-palette lightness (plus live Explorer previews for VRAM,
  Cartridge ROM, Tilemaps and Sprites).
- **MIDI Instruments**: check **MIDI instruments** on or off in **Sound**
  (or press `I`) to replace the standard Game Boy pulse, wavetable and LFSR noise tones
  with a 28-sample multi-zone studio bank generated via ElevenLabs (concert grand piano,
  bowed violin/strings, concert flute, oboe, French horn, nylon guitar, Rhodes electric
  piano, vibraphone, celesta, upright/cello bass and close-mic acoustic drum kit) with
  Hermite cubic pitch resampling, phase-locked sustain loops and concert-hall reverb.
- **AI Autoplay**: check **AI Autoplay** (or press `G`) to let Gemini
  (`gemini-2.5-flash`) watch the live Game Boy screen + sprite/tile telemetry, decide
  what to do next, and steer the character automatically in a closed loop.
- **Engine**: plain HTML5 canvas and ES modules. No build step and no dependencies.

## Run

```bash
GEMINI_API_KEY=... ./serve.sh        # http://<host>:8740/   (PORT=... to change)
```

*(You can also place `GEMINI_API_KEY=...` in a `.env` file in the project root; core
emulation, the VRAM explorer, and MIDI instruments work with no API key.)*

Then **Load ROM…**, drop a `.gb` file (or a `.zip` containing one) on the page, or press
**Play demo**. The last game you loaded comes back when you reopen the page.

| Game Boy | Keys |
| --- | --- |
| D-pad | Arrow keys or W A S D |
| A | X or K |
| B | Z or J |
| Start | Enter |
| Select | Shift or Backspace |

| Emulator | Keys |
| --- | --- |
| Pause / resume | P |
| Step one frame | N |
| Fast-forward | hold Space |
| Sound on / off | M |
| MIDI instruments on / off | I |
| Advanced Tile Mode (HD color) | H |
| AI Autoplay | G |
| Unpin the inspected tile | Esc |

Gamepads work if the browser exposes them, and touch devices get on-screen buttons.

### No ROM at hand?

- **Play demo** runs *Gem Garden*, a small game written for this project (source in
  [`roms/demo.asm`](roms/demo.asm)).
- `./tools/fetch_homebrew.sh` downloads two freely licensed homebrew games into
  `roms/local/` (not committed): *Adjustris* (CC0) and *Libbet and the Magic Floor*
  (zlib licence).

## The explorer

| View | Shows |
| --- | --- |
| **Tiles** | All 384 tiles in video RAM ($8000-$97FF), updated live. Rulers give the address: row `8A`, column `2` is the tile at `$8A20`. Switch to **Cartridge ROM** to page through the ROM file as tile data; uncompressed graphics show up as pictures, code and compressed data as noise. Use the -1 / +1 buttons if the tiles look sheared (they start at an odd offset). |
| **Tilemaps** | The two 32x32 maps ($9800 and $9C00), labelled with the layer using them. The yellow outline is the part on screen; blue is the window's area. |
| **Sprites** | The 40 OAM entries as they would be drawn, dimmed when off screen. |

Everything feeds one inspector: an enlarged tile with its 16 bytes, address, and where
it is in use right now (background map, window map, sprites, pixels on screen).

- **Hover** to preview, **click** to pin, **Esc** to unpin.
- A pinned or hovered tile is **highlighted on the game screen** and outlined in the
  maps, so you can go from "what is this tile?" to "where is it used?" and back.
- **Click a pixel on the game screen** to pin whatever is drawn there. Hold **Alt** to
  pick the background underneath a sprite.
- Pause (P) and step (N) to study a single frame. **Save PNG** exports the sheet.

The screen-to-tile lookup is exact: while rendering, the emulator records which tile,
map cell and sprite produced each pixel, so it stays right even when a game changes
scroll or tile addressing partway down the frame.

## Accuracy

The emulated machine is the original Game Boy (DMG). The core advances all hardware
one machine cycle at a time and is checked against the hardware test ROMs collected in
[c-sp/game-boy-test-roms](https://github.com/c-sp/game-boy-test-roms) v7.0:

| Suite | Passing | Covers |
| --- | --- | --- |
| Blargg `cpu_instrs`, `instr_timing`, `mem_timing`, `mem_timing-2`, `halt_bug` | all (19) | every instruction, cycle timing |
| Blargg `dmg_sound` | 12 / 12 | sound registers, length, sweep, wave RAM quirks |
| Mooneye Test Suite, DMG tests | 95 / 95 | timer, interrupts, HALT, OAM DMA, PPU timing, MBC1/2/5 |
| Mooneye (wilbertpol fork), DMG tests | 94 / 94 | more PPU and timer timing |
| dmg-acid2 | pixel-exact | background, window and sprite rendering rules |
| MBC3 Bank Tester | pixel-exact | MBC3 / MBC30 banking |
| GBMicrotest | 480 / 482 | sub-instruction PPU, timer and interrupt timing |
| Gambatte, DMG tests | 1507 / 1740 | a broad sweep; see below for what fails |
| AGE test ROMs, DMG tests | 8 / 14 | STAT, OAM and VRAM access timing |
| Mealybug Tearoom | 1 / 24 | register changes in the middle of a scanline |
| Blargg `oam_bug` | 3 / 8 | not emulated, see below |

```bash
npm run roms:fetch          # download the test ROMs into test-roms/ (not committed)
npm run test:conformance    # run them; fails if anything in the baseline regresses
node tools/conformance.mjs -v gambatte   # one suite, listing every failure
```

`tests/conformance-baseline.json` lists every test that passes. After improving the
core, `node tools/conformance.mjs --update` records the new set.

Two real homebrew games (*Adjustris* and *Libbet and the Magic Floor*, see above) were
also run and looked right. No commercial game has been tested, because none was
available when this was written. Games that only need what the suites above cover
should run correctly; games that rely on the items below may show glitches.

### Not emulated

- **Game Boy Color.** Color-only games show their "needs a Game Boy Color" screen;
  dual-mode games run as they would on the original hardware. No Super Game Boy
  borders either.
- **The boot ROM.** Games start directly in the state the boot ROM leaves behind.
- **Link cable.** Nothing is ever connected to the serial port.
- **Mappers** other than ROM-only, MBC1 (including multicarts), MBC2, MBC3 / MBC30 (with
  clock) and MBC5. MBC6, MBC7, HuC1/3, MMM01, the camera and TAMA5 are refused with a
  message.
- **A dot-exact pixel pipeline.** Each scanline is drawn in one go; when a game writes
  a video register in the middle of a line, the pixels left of the beam keep the old
  value. Palette changes land on exactly the right pixel (Mealybug `m3_bgp_change`
  passes); scroll, window and sprite changes mid-line can be a few pixels off. This is
  what the Mealybug failures, most Gambatte `window` / `sprites` failures and the AGE
  `m3-bg-*` screenshots are about.
- **The OAM corruption bug**, and a few sound-channel phase details (Gambatte `sound`).
- The two GBMicrotest failures are `halt_op_dupe_delay` and `stat_write_glitch_l154_d`.
- **Save states.** Battery saves are supported (and import/export as `.sav`).

## Tests

```bash
npm test             # unit tests, plus the conformance baseline if test-roms/ exists
npm run test:e2e     # the real app in headless Chrome (needs google-chrome)
npm run check        # syntax check
```

- The unit tests include a full playthrough of the demo: the test finds a route to
  every gem and plays the game to its win screen through the joypad.
- The end-to-end test drives the page with real mouse and keyboard events: speed,
  input, pause and step, every explorer view, loading files, saves surviving a reload,
  and the phone layout. Screenshots are written to `out/e2e/`.

## Layout

```
index.html              page
server.mjs, serve.sh    HTTP server + /api/tiles and /api/ai endpoints (port 8740)
src/core/               the emulator: no DOM, runs the same in Node
  gameboy.js            memory map, interrupts, OAM DMA, the machine-cycle clock
  cpu.js                SM83 CPU
  ppu.js                LCD timing, STAT/LY, scanline renderer, per-pixel source records
  apu.js                four sound channels, mixing, resampling
  midi.js               multi-zone MIDI sampler, wavetable fallback and hall reverb
  timer.js              divider, TIMA; also clocks the serial port and sound sequencer
  cartridge.js          header, MBC1/2/3/5, battery RAM, real-time clock
  joypad.js, serial.js
  tiles.js              2bpp decoding and rasterising for the explorer
  hdtiles.js            32x32 HD color tile store, cyclic-shift matching and 640x576 renderer
  disasm.js             disassembler (tools; also the assembler's instruction table)
src/ui/                 the page
  main.js               wiring
  emulator.js           real-time pacing, pause/step/speed
  audio.js              Web Audio output
  samples.js            studio instrument bank loader
  autoplayer.js         closed-loop AI autoplay controller
  input.js              keyboard, gamepad, touch
  screen.js             game canvas, highlight overlay, pixel picking
  explorer.js           tiles / tilemaps / sprites views and the inspector
  pixelview.js          pixel-art canvas with rulers and a crisp overlay
  storage.js            settings, battery saves, last ROM
  unzip.js              reads a ROM out of a .zip
assets/instruments/     28 studio instrument & drum samples + manifest.json
roms/demo.asm, demo.gb  the built-in game (source and build)
tools/
  tile_upgrader.mjs     Gemini scene-coherent + whole-ROM HD tile colorizer
  ai_player.mjs         Gemini vision-action planner for AI Autoplay
  generate_instruments.mjs  generates and FFT-calibrates the studio instrument bank
  build_demo.mjs        assembles the demo (art and level are defined here)
  asm.mjs               small SM83 assembler
  run_rom.mjs           run a ROM headlessly: screenshot, serial output, scripted input
  conformance.mjs       test-ROM runner with baseline
  e2e.mjs, browser.mjs  browser test and its DevTools-protocol driver
  debug.mjs             disassemble a ROM, or trace execution with PPU position
  microprobe.mjs, microtable.mjs   show what a GBMicrotest ROM measures, and when
tests/                  node --test suites
```

### Headless tools

```bash
node tools/run_rom.mjs game.gb --seconds 10 --png out/shot.png
node tools/run_rom.mjs game.gb --frames 600 --press "start@120+6,a@200+6" --png out/shot.png
node tools/debug.mjs trace game.gb 200
npm run demo:build      # after editing roms/demo.asm or tools/build_demo.mjs
```

## Notes

- This project contains no Nintendo code or data: no boot ROM, and the demo ROM leaves
  the header's logo field empty (which is why it runs in emulators but would not start
  on real hardware).
- Only load ROMs you have the right to use.
