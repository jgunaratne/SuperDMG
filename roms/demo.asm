; Gem Garden: the small game that ships with the emulator ("Play demo").
;
; Walk around a scrolling garden and pick up every gem. It is deliberately a tour of
; the video hardware, so there is something to look at in each explorer view:
;   - background tiles and a 32x32 tilemap larger than the screen (scrolling)
;   - a status bar drawn with the window layer
;   - an 8x16 sprite with two walking frames, flipped when facing left
;   - a water tile whose pixels are rewritten in video RAM to animate it
;
; Built by tools/build_demo.mjs, which appends the graphics, the level and the HUD
; text (labels: tiles, sprites, level, hud_text, win_text) and defines GEM_TOTAL,
; START_X and START_Y.

rP1    equ $FF00
rIF    equ $FF0F
rNR10  equ $FF10
rNR11  equ $FF11
rNR12  equ $FF12
rNR13  equ $FF13
rNR14  equ $FF14
rNR21  equ $FF16
rNR22  equ $FF17
rNR23  equ $FF18
rNR24  equ $FF19
rNR30  equ $FF1A
rNR32  equ $FF1C
rNR33  equ $FF1D
rNR34  equ $FF1E
rNR41  equ $FF20
rNR42  equ $FF21
rNR43  equ $FF22
rNR44  equ $FF23
rNR50  equ $FF24
rNR51  equ $FF25
rNR52  equ $FF26
rLCDC  equ $FF40
rSCY   equ $FF42
rSCX   equ $FF43
rLY    equ $FF44
rBGP   equ $FF47
rOBP0  equ $FF48
rWY    equ $FF4A
rWX    equ $FF4B
rIE    equ $FFFF

TILE_FLOOR  equ 0
TILE_GEM    equ 2
TILE_SOLID  equ 3            ; this tile and every later one blocks the player
TILE_WATER  equ 4
FONT_0      equ 16           ; digits 0-9 start here
FONT_SPACE  equ 38
SPRITE_TILE equ $80

HUD         equ $9C00        ; window tilemap
HUD_ROW     equ 136          ; the window covers the bottom 8 lines

; Work RAM
map         equ $C000        ; copy of the level, for collision checks at any time
player_x    equ $C400        ; top-left of the 8x8 collision box, in world pixels
player_y    equ $C401
facing      equ $C402        ; OAM attribute byte: 0 = right, $20 = mirrored
walk        equ $C403        ; counts frames spent walking, picks the sprite frame
frame       equ $C404
keys        equ $C405        ; bit 0 right, 1 left, 2 up, 3 down, 4 A, 5 B, 6 select, 7 start
gems        equ $C406
won         equ $C407
dirty       equ $C408        ; a map cell changed and must be redrawn...
dirty_lo    equ $C409        ; ...at this video RAM address
dirty_hi    equ $C40A
vblank_flag equ $C40B
music_tick  equ $C40C        ; counts frames 0..7 per eighth-note step
music_step  equ $C40D        ; 0..127 across the 16-bar pastoral score

; --- Interrupt vectors and header ------------------------------------------------------

  org $0040
  push af
  ld a,1
  ld (vblank_flag),a
  pop af
  reti

  org $0100
  nop
  jp start

; --- Start-up --------------------------------------------------------------------------

  org $0150
start:
  di
  ld sp,$E000
.wait:
  ldh a,(rLY)                ; the LCD may only be switched off during VBlank
  cp 144
  jr nz,.wait
  xor a
  ldh (rLCDC),a

  ld hl,player_x
  ld bc,16
  ld d,0
  call fill

  ld hl,tiles
  ld de,$8000
  ld bc,tiles_end-tiles
  call copy
  ld hl,sprites
  ld de,$8800
  ld bc,sprites_end-sprites
  call copy

  ld hl,level                ; once for collisions, once for the picture
  ld de,map
  ld bc,1024
  call copy
  ld hl,level
  ld de,$9800
  ld bc,1024
  call copy

  ld hl,HUD
  ld bc,32
  ld d,FONT_SPACE
  call fill
  ld hl,hud_text
  ld de,HUD
  ld bc,hud_text_end-hud_text
  call copy

  ld hl,$FE00                ; hide all 40 sprites
  ld bc,160
  ld d,0
  call fill

  ld a,%11100100             ; colour numbers map straight onto shades
  ldh (rBGP),a
  ldh (rOBP0),a
  xor a
  ldh (rSCX),a
  ldh (rSCY),a
  ld a,HUD_ROW
  ldh (rWY),a
  ld a,7
  ldh (rWX),a

  ld a,$80                   ; sound on, both speakers, full volume
  ldh (rNR52),a
  ld a,$FF
  ldh (rNR51),a
  ld a,$77
  ldh (rNR50),a
  call init_music

  ld a,START_X
  ld (player_x),a
  ld a,START_Y
  ld (player_y),a

  xor a
  ldh (rIF),a
  ld a,1                     ; VBlank interrupt only
  ldh (rIE),a
  ld a,%11110111             ; LCD on, window on at $9C00, tiles at $8000, 8x16 sprites
  ldh (rLCDC),a
  ei

; --- Main loop: one pass per frame -----------------------------------------------------

main:
  halt                       ; sleep until the VBlank interrupt
  ld a,(vblank_flag)
  or a
  jr z,main
  xor a
  ld (vblank_flag),a
  call draw                  ; first, while video memory is still writable
  call read_keys
  call update
  call update_music
  jr main

; --- Drawing (runs in VBlank) ----------------------------------------------------------

draw:
  ; Camera: keep the player near the middle, without scrolling past the level edge.
  ld a,(player_x)
  sub 76
  jr nc,.x_low
  xor a
.x_low:
  cp 97
  jr c,.x_ok
  ld a,96
.x_ok:
  ldh (rSCX),a
  ld b,a
  ld a,(player_y)
  sub 64
  jr nc,.y_low
  xor a
.y_low:
  cp 121
  jr c,.y_ok
  ld a,120
.y_ok:
  ldh (rSCY),a
  ld c,a

  ; Sprite 0 is the player. It is 16 tall; the collision box is its lower half.
  ld hl,$FE00
  ld a,(player_y)
  sub c
  add a,8
  ld (hl+),a
  ld a,(player_x)
  sub b
  add a,8
  ld (hl+),a
  ld a,(walk)
  and 8                      ; swap frames every 8 walking frames
  rrca
  rrca
  add a,SPRITE_TILE
  ld (hl+),a
  ld a,(facing)
  ld (hl),a

  ; A gem was picked up: clear its map cell and bring the HUD up to date.
  ld a,(dirty)
  or a
  jr z,.water
  xor a
  ld (dirty),a
  ld a,(dirty_lo)
  ld l,a
  ld a,(dirty_hi)
  ld h,a
  ld (hl),TILE_FLOOR
  call draw_count
  ld a,(won)
  or a
  call nz,draw_win

.water:
  ; Every 16th frame, rotate each row of the water tile one pixel to the left.
  ld a,(frame)
  and 15
  ret nz
  ld hl,$8000+TILE_WATER*16
  ld b,16
.rotate:
  ld a,(hl)
  rlca
  ld (hl+),a
  dec b
  jr nz,.rotate
  ret

draw_count:
  ld a,(gems)
  ld b,0
.tens:
  cp 10
  jr c,.ones
  sub 10
  inc b
  jr .tens
.ones:
  add a,FONT_0
  ld (HUD+6),a
  ld a,b
  add a,FONT_0
  ld (HUD+5),a
  ret

draw_win:
  ld hl,win_text
  ld de,HUD+11
  ld bc,win_text_end-win_text
  jp copy

; --- Input -----------------------------------------------------------------------------

read_keys:
  ld a,$20                   ; select the D-pad
  ldh (rP1),a
  ldh a,(rP1)
  ldh a,(rP1)                ; read twice to let the lines settle
  cpl
  and $0F
  ld b,a
  ld a,$10                   ; select the buttons
  ldh (rP1),a
  ldh a,(rP1)
  ldh a,(rP1)
  cpl
  and $0F
  swap a
  or b
  ld (keys),a
  ld a,$30
  ldh (rP1),a
  ret

; --- Game logic ------------------------------------------------------------------------

update:
  ld hl,frame
  inc (hl)
  ld a,(won)
  or a
  jr z,.play
  ld a,(keys)                ; all gems found: Start plays again
  bit 7,a
  ret z
  jp start
.play:
  ld a,(keys)
  and $0F
  jr z,.moves
  ld hl,walk
  inc (hl)
.moves:
  ld a,(keys)
  bit 0,a
  call nz,move_right
  ld a,(keys)
  bit 1,a
  call nz,move_left
  ld a,(keys)
  bit 2,a
  call nz,move_up
  ld a,(keys)
  bit 3,a
  call nz,move_down

  ; Standing on a gem?
  ld a,(player_x)
  add a,4
  ld b,a
  ld a,(player_y)
  add a,4
  ld c,a
  call cell_at
  cp TILE_GEM
  ret nz
  ld (hl),TILE_FLOOR
  ld a,h                     ; same cell in the background map at $9800
  add a,$98-HIGH(map)
  ld (dirty_hi),a
  ld a,l
  ld (dirty_lo),a
  ld a,1
  ld (dirty),a
  call chirp
  ld hl,gems
  inc (hl)
  ld a,(hl)
  cp GEM_TOTAL
  ret nz
  ld a,1
  ld (won),a
  ret

; Each move tests the two corners of the collision box on the leading edge.
move_right:
  xor a
  ld (facing),a
  ld a,(player_y)
  ld c,a
  ld a,(player_x)
  add a,8
  ld b,a
  call solid_at
  ret nz
  ld a,c
  add a,7
  ld c,a
  call solid_at
  ret nz
  ld hl,player_x
  inc (hl)
  ret

move_left:
  ld a,$20
  ld (facing),a
  ld a,(player_y)
  ld c,a
  ld a,(player_x)
  dec a
  ld b,a
  call solid_at
  ret nz
  ld a,c
  add a,7
  ld c,a
  call solid_at
  ret nz
  ld hl,player_x
  dec (hl)
  ret

move_up:
  ld a,(player_x)
  ld b,a
  ld a,(player_y)
  dec a
  ld c,a
  call solid_at
  ret nz
  ld a,b
  add a,7
  ld b,a
  call solid_at
  ret nz
  ld hl,player_y
  dec (hl)
  ret

move_down:
  ld a,(player_x)
  ld b,a
  ld a,(player_y)
  add a,8
  ld c,a
  call solid_at
  ret nz
  ld a,b
  add a,7
  ld b,a
  call solid_at
  ret nz
  ld hl,player_y
  inc (hl)
  ret

; World pixel (B, C) -> HL = that cell in the RAM copy of the map, A = its tile.
cell_at:
  ld a,c
  and $F8
  ld l,a
  ld h,0
  add hl,hl
  add hl,hl                  ; (y / 8) * 32
  ld a,b
  srl a
  srl a
  srl a
  or l                       ; + x / 8
  ld l,a
  ld a,h
  add a,HIGH(map)
  ld h,a
  ld a,(hl)
  ret

; Does the cell under world pixel (B, C) block the player? NZ if so.
solid_at:
  call cell_at
  cp TILE_SOLID
  jr nc,.solid
  xor a
  ret
.solid:
  or 1
  ret

; A short rising blip on pulse channel 1.
chirp:
  ld a,$15                   ; sweep upwards
  ldh (rNR10),a
  ld a,$80                   ; 50% duty
  ldh (rNR11),a
  ld a,$F2                   ; start loud, fade
  ldh (rNR12),a
  xor a
  ldh (rNR13),a
  ld a,$87                   ; trigger, around 512 Hz
  ldh (rNR14),a
  ret

; --- Helpers ---------------------------------------------------------------------------

; Copies BC bytes from HL to DE.
copy:
  ld a,(hl+)
  ld (de),a
  inc de
  dec bc
  ld a,b
  or c
  jr nz,copy
  ret

; Stores D into BC bytes starting at HL.
fill:
  ld a,d
  ld (hl+),a
  dec bc
  ld a,b
  or c
  jr nz,fill
  ret

code_end:

; --- Data (appended by the build script) -----------------------------------------------
; Starts on a 16-byte boundary so the tiles line up in the explorer's ROM view.
  org DATA_START
