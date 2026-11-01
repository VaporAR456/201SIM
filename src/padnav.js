// Controller navigation for the menus: the D-pad or left stick moves a highlight between the
// buttons, sliders and checkboxes on screen, A presses the highlighted one, and left / right
// moves a highlighted slider. It reads the controller's standard buttons directly, so it keeps
// working whatever the in-game bindings are.
import { PAD } from './input.js';

const FIRST = 0.38; // seconds before a held direction repeats
const REPEAT = 0.14;

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
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
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
      this.colX = null;
      this.setFocus(list.find((e) => e.classList.contains('primary') || e.classList.contains('mm-play')) ?? list[0] ?? null);
    }
    // which way is held: D-pad first, then the left stick
    const b = (i) => (pad.buttons[i]?.value ?? 0) > 0.5;
    const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
    let dir = b(PAD.UP) ? 'up' : b(PAD.DOWN) ? 'down' : b(PAD.LEFT) ? 'left' : b(PAD.RIGHT) ? 'right' : null;
    // the stick: engage past 0.6, keep the same direction until it's back under 0.35, and only
    // switch directions on a clear diagonal win, so it doesn't jitter between neighbors
    const mag = Math.hypot(ax, ay);
    if (!dir && (mag > 0.6 || (this.stickDir && mag > 0.35))) {
      const raw = Math.abs(ax) > Math.abs(ay) ? (ax > 0 ? 'right' : 'left') : (ay > 0 ? 'down' : 'up');
      const keep = this.stickDir && ((this.stickDir === 'left' || this.stickDir === 'right') ? Math.abs(ax) * 1.4 > Math.abs(ay) : Math.abs(ay) * 1.4 > Math.abs(ax));
      dir = keep ? this.stickDir : raw;
    }
    this.stickDir = !b(PAD.UP) && !b(PAD.DOWN) && !b(PAD.LEFT) && !b(PAD.RIGHT) ? dir : null;
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

  /** The row an element sits in: its button group, or itself. */
  rowOf(el) { return el.closest('.seg, tr') || el; }

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
    const row = this.rowOf(el);
    if (dir === 'left' || dir === 'right') {
      // along the row first (wrapped rows count as one row), then over to the next column
      const sib = list.filter((o) => o !== el && this.rowOf(o) === row);
      const s = dir === 'right' ? 1 : -1;
      const order = [el, ...sib].sort((a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.abs(p.top - q.top) > 8 ? p.top - q.top : p.left - q.left; });
      const i = order.indexOf(el) + s;
      if (sib.length && i >= 0 && i < order.length) { this.pick(order[i]); return; }
      // at the end of a row: over to the next column of the screen (main menu), else stay put
      const col = (o) => o.closest('.mm-left, .mm-setup, [data-navcol]');
      const here = col(el);
      if (here) this.spatial(dir, list, cx, cy, (o) => col(o) && col(o) !== here, true);
      return;
    }
    // up / down: the next row in the same column, landing on the item nearest the column we came from
    const colX = this.colX ?? cx;
    const s = dir === 'down' ? 1 : -1;
    let bestRow = null, bestD = Infinity;
    for (const o of list) {
      if (this.rowOf(o) === row) continue;
      const q = o.getBoundingClientRect();
      const oy = q.top + q.height / 2;
      const dy = (oy - cy) * s;
      if (dy <= 4) continue;
      // same column: the row overlaps where we are horizontally
      const rr = this.rowOf(o).getBoundingClientRect();
      const inCol = rr.left - 20 <= cx && cx <= rr.right + 20;
      // outside the main menu's two columns, any row below will do (nearest first)
      if (!inCol && el.closest('.mm-left, .mm-setup, [data-navcol]')) continue;
      const d = dy + (inCol ? 0 : 300);
      if (d < bestD - 2) { bestD = d; bestRow = this.rowOf(o); }
    }
    if (!bestRow) return;
    const items = list.filter((o) => this.rowOf(o) === bestRow);
    // in a wrapped row, enter on its nearest line
    const lineY = (o) => { const q = o.getBoundingClientRect(); return q.top + q.height / 2; };
    const edge = s > 0 ? Math.min(...items.map(lineY)) : Math.max(...items.map(lineY));
    const line = items.filter((o) => Math.abs(lineY(o) - edge) < 8);
    let best = line[0], bd = Infinity;
    for (const o of line) { const q = o.getBoundingClientRect(); const d = Math.abs(q.left + q.width / 2 - colX); if (d < bd) { bd = d; best = o; } }
    // the selected button of a group is where you'd expect to land
    const on = line.find((o) => o.classList.contains('on'));
    if (on && items.length > 1 && Math.abs(on.getBoundingClientRect().left - best.getBoundingClientRect().left) < 400) best = on;
    this.setFocus(best);
    this.colX = colX;
  }

  pick(o) { this.setFocus(o); const q = o.getBoundingClientRect(); this.colX = q.left + q.width / 2; }

  spatial(dir, list, cx, cy, ok, preferOn) {
    const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
    let best = null, bestScore = Infinity;
    for (const o of list) {
      if (o === this.cur || !ok(o)) continue;
      const q = o.getBoundingClientRect();
      const ox = q.left + q.width / 2 - cx, oy = q.top + q.height / 2 - cy;
      const along = ox * dx + oy * dy;
      if (along <= 4) continue;
      const across = Math.abs(ox * dy - oy * dx);
      const score = along + across * 3;
      if (score < bestScore) { bestScore = score; best = o; }
    }
    // landing in a button group: take its selected button
    if (best && preferOn) best = list.find((o) => this.rowOf(o) === this.rowOf(best) && o.classList.contains('on')) || best;
    if (best) this.pick(best);
  }

  reset() { this.root = null; }
}
