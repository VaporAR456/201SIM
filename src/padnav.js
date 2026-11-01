// Controller navigation for the menus: the D-pad or left stick moves a highlight between the
// buttons, sliders and checkboxes on screen, A presses the highlighted one, and left / right
// moves a highlighted slider. It reads the controller's standard buttons directly, so it keeps
// working whatever the in-game bindings are.
import { PAD } from './input.js';

const FIRST = 0.35; // seconds before a held direction repeats
const REPEAT = 0.12;

export class PadNav {
  constructor() {
    this.cur = null;
    this.root = null;
    this.dir = null;
    this.holdT = 0;
    this.prev = [];
    this.active = false; // highlight only shows once the controller is used
    addEventListener('mousemove', () => this.show(false));
    addEventListener('keydown', () => this.show(false));
  }

  show(on) {
    if (this.active === on) return;
    this.active = on;
    this.cur?.classList.toggle('padfocus', on);
  }

  items(root) {
    return [...root.querySelectorAll('button, input')].filter((e) => !e.disabled && e.offsetParent !== null);
  }

  setFocus(el) {
    this.cur?.classList.remove('padfocus');
    this.cur = el;
    if (!el) return;
    if (this.active) el.classList.add('padfocus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  pressedBtn(pad, i) { return (pad.buttons[i]?.value ?? 0) > 0.5 && !(this.prev[i] > 0.5); }

  /**
   * Run one frame of navigation inside `root`. Returns true when A pressed something, so the
   * caller can skip its own A handling that frame.
   */
  update(root, pad, dt) {
    if (!pad) { this.prev = []; return false; }
    const list = this.items(root);
    if (root !== this.root || !list.includes(this.cur)) {
      this.root = root;
      this.setFocus(list.find((e) => e.classList.contains('primary')) ?? list[0] ?? null);
    }
    // which way is held: D-pad first, then the left stick
    const b = (i) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    let dir = b(PAD.UP) ? 'up' : b(PAD.DOWN) ? 'down' : b(PAD.LEFT) ? 'left' : b(PAD.RIGHT) ? 'right' : null;
    if (!dir && Math.hypot(ax, ay) > 0.6) dir = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 'right' : 'left') : (ay > 0 ? 'down' : 'up');
    let step = false;
    if (dir !== this.dir) { this.dir = dir; this.holdT = 0; step = !!dir; }
    else if (dir) { this.holdT += dt; if (this.holdT > FIRST) { this.holdT -= REPEAT; step = true; } }
    if (step) { this.show(true); this.move(dir, list); }

    let used = false;
    if (this.pressedBtn(pad, PAD.A) && this.cur) {
      this.show(true);
      const el = this.cur;
      if (el.type !== 'range') { el.click(); used = true; }
    }
    this.prev = pad.buttons.map((x) => x.value);
    return used;
  }

  move(dir, list) {
    const el = this.cur;
    if (!el) { this.setFocus(list[0] ?? null); return; }
    // a slider takes left / right itself
    if (el.type === 'range' && (dir === 'left' || dir === 'right')) {
      const s = +el.step || 1;
      const v = Math.min(+el.max, Math.max(+el.min, +el.value + (dir === 'right' ? s : -s)));
      if (v !== +el.value) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
      return;
    }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    let best = null, bestScore = Infinity;
    for (const o of list) {
      if (o === el) continue;
      const q = o.getBoundingClientRect();
      const ox = q.left + q.width / 2 - cx, oy = q.top + q.height / 2 - cy;
      const along = ox * dx + oy * dy;
      if (along <= 4) continue;
      const across = Math.abs(ox * dy - oy * dx);
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    if (best) this.setFocus(best);
  }

  reset() { this.root = null; }
}
