// Player input: keyboard, on-screen buttons and gamepads, merged into joypad state.
//
// Keyboard handling is document-wide so the game keeps responding after you click
// around the explorer. Two exceptions keep the page usable: typing in a form field
// is left alone, and Enter/Space on a focused button activates that button.

const KEY_TO_BUTTON = {
  ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down',
  KeyD: 'right', KeyA: 'left', KeyW: 'up', KeyS: 'down',
  KeyX: 'a', KeyK: 'a',
  KeyZ: 'b', KeyJ: 'b',
  Enter: 'start',
  ShiftLeft: 'select', ShiftRight: 'select', Backspace: 'select',
};
const OPPOSITE = { left: 'right', right: 'left', up: 'down', down: 'up' };
const GAMEPAD_BUTTONS = { 0: 'b', 1: 'a', 2: 'b', 3: 'a', 8: 'select', 9: 'start', 12: 'up', 13: 'down', 14: 'left', 15: 'right' };

export class Input {
  /**
   * @param {import('./emulator.js').Emulator} emulator
   * @param {{onPause: Function, onStep: Function, onMute: Function, onGesture: Function}} actions
   */
  constructor(emulator, actions) {
    this.emulator = emulator;
    this.actions = actions;
    // What each source is holding; a button is down if any source holds it.
    this.sources = { keys: new Set(), touch: new Set(), pad: new Set(), ai: new Set() };
    this.order = []; // most recently pressed last, to resolve left+right / up+down
    this.applied = new Set();

    document.addEventListener('keydown', (e) => this.onKey(e, true));
    document.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    emulator.addEventListener('frame', () => this.pollGamepads());
  }

  onKey(event, down) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
      // Range sliders and checkboxes do not need typing keys, but do use arrows/space.
      if (down && event.code === 'Escape') target.blur();
      return;
    }
    const activates = event.code === 'Enter' || event.code === 'Space';
    if (activates && (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY')) return;

    const button = KEY_TO_BUTTON[event.code];
    if (button) {
      event.preventDefault();
      if (down && !event.repeat) this.actions.onGesture();
      this.set('keys', button, down);
      return;
    }
    if (event.code === 'Space') {
      event.preventDefault();
      this.emulator.fastForward = down;
      return;
    }
    if (!down || event.repeat) return;
    if (event.code === 'KeyP') this.actions.onPause();
    else if (event.code === 'KeyN') this.actions.onStep();
    else if (event.code === 'KeyM') this.actions.onMute();
    else if (event.code === 'KeyI') this.actions.onMidiMode?.();
    else if (event.code === 'KeyH') this.actions.onHdMode?.();
    else if (event.code === 'KeyG') this.actions.onAiMode?.();
    else if (event.code === 'Escape') this.actions.onEscape();
  }

  /** Wires the on-screen buttons inside `root` ([data-button] elements). */
  bindTouchPad(root) {
    for (const el of root.querySelectorAll('[data-button]')) {
      const button = el.dataset.button;
      const press = (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        el.classList.add('held');
        this.actions.onGesture();
        this.set('touch', button, true);
      };
      const release = () => {
        el.classList.remove('held');
        this.set('touch', button, false);
      };
      el.addEventListener('pointerdown', press);
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('lostpointercapture', release);
      el.addEventListener('contextmenu', (e) => e.preventDefault());
    }
  }

  pollGamepads() {
    if (!navigator.getGamepads) return;
    const held = new Set();
    for (const pad of navigator.getGamepads()) {
      if (!pad || !pad.connected) continue;
      pad.buttons.forEach((b, i) => { if (b.pressed && GAMEPAD_BUTTONS[i]) held.add(GAMEPAD_BUTTONS[i]); });
      if (pad.axes[0] < -0.5) held.add('left'); else if (pad.axes[0] > 0.5) held.add('right');
      if (pad.axes[1] < -0.5) held.add('up'); else if (pad.axes[1] > 0.5) held.add('down');
    }
    const previous = this.sources.pad;
    for (const b of held) if (!previous.has(b)) this.set('pad', b, true);
    for (const b of [...previous]) if (!held.has(b)) this.set('pad', b, false);
  }

  set(source, button, down) {
    const held = this.sources[source];
    if (down === held.has(button)) return;
    if (down) {
      held.add(button);
      this.order = this.order.filter((b) => b !== button);
      this.order.push(button);
    } else {
      held.delete(button);
    }
    this.apply();
  }

  releaseAll() {
    const aiHeld = new Set(this.sources.ai);
    for (const held of Object.values(this.sources)) held.clear();
    for (const b of aiHeld) this.sources.ai.add(b);
    this.emulator.fastForward = false;
    this.apply();
  }

  /** Sets the exact set of buttons held by the autonomous AI player. */
  setAiButtons(buttons) {
    const next = new Set(buttons);
    const prev = this.sources.ai;
    let changed = false;
    for (const b of [...prev]) {
      if (!next.has(b)) {
        prev.delete(b);
        changed = true;
      }
    }
    for (const b of next) {
      if (!prev.has(b)) {
        prev.add(b);
        this.order = this.order.filter((x) => x !== b);
        this.order.push(b);
        changed = true;
      }
    }
    if (changed) this.apply();
  }

  /** Pushes the merged state to the joypad. Opposite directions never go down together. */
  apply() {
    const { keys, touch, pad, ai } = this.sources;
    const want = new Set([...ai, ...keys, ...touch, ...pad]);
    for (const [a, b] of [['left', 'right'], ['up', 'down']]) {
      if (want.has(a) && want.has(b)) {
        want.delete(this.order.lastIndexOf(a) > this.order.lastIndexOf(b) ? OPPOSITE[a] : OPPOSITE[b]);
      }
    }
    const gb = this.emulator.gb;
    for (const button of want) if (!this.applied.has(button)) gb.setButton(button, true);
    for (const button of this.applied) if (!want.has(button)) gb.setButton(button, false);
    this.applied = want;
  }
}
