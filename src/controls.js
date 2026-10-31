// The Controls screen: shows every binding and lets the driver remap it.
// Click a controller or keyboard cell (or move with the D-pad and press A), then press the new
// button, stick direction or key. Esc cancels. Bindings save in this browser.
import { ACTIONS, ANALOG, PAD, padLabel, keyLabel, axisLabel } from './input.js';

export class ControlsScreen {
  constructor(input, panel, onClose) {
    this.input = input;
    this.panel = panel;
    this.onClose = onClose;
    this.table = panel.querySelector('table');
    this.status = panel.querySelector('.remap-status');
    this.listening = null;
    this.focus = 0;
    this.rows = [];
    panel.querySelector('.remap-reset').addEventListener('click', () => {
      this.input.resetBindings();
      this.render();
      this.say('Back to the default layout.');
    });
    panel.querySelector('.remap-close').addEventListener('click', () => this.close());
    addEventListener('keydown', (e) => this.onKey(e), true);
  }

  get open() { return !this.panel.hidden; }

  show() {
    this.panel.hidden = false;
    this.focus = 0;
    this.render();
    this.say('Click a binding (or D-pad to it and press A), then press the new button or key. X on the controller resets a row.');
    this.navPrev = this.snapshot();
  }

  close() {
    this.cancel();
    this.panel.hidden = true;
    this.onClose?.();
  }

  say(t) { this.status.textContent = t; }

  render() {
    const B = this.input.bindings;
    this.rows = [];
    let html = '<tr><th>Action</th><th>Controller</th><th>Keyboard</th><th></th></tr>';
    const reset = (name) => `<td><button class="reset-one" data-reset="${name}">Reset</button></td>`;
    for (const [name, a] of Object.entries(ANALOG)) {
      this.rows.push({ kind: 'axis', name });
      html += `<tr data-row="${this.rows.length - 1}"><td>${a.label}</td>` +
        `<td><button data-kind="axis" data-name="${name}">${axisLabel(B.analog[name])}</button></td><td class="dim">see below</td>${reset(name)}</tr>`;
    }
    for (const [name, a] of Object.entries(ACTIONS)) {
      this.rows.push({ kind: a.keyOnly ? 'key' : 'pad', name });
      const b = B.actions[name];
      const padCell = a.keyOnly ? '<td class="dim">left stick</td>'
        : `<td><button data-kind="pad" data-name="${name}">${padLabel(b.pad)}</button></td>`;
      html += `<tr data-row="${this.rows.length - 1}"><td>${a.label}</td>${padCell}` +
        `<td><button data-kind="key" data-name="${name}">${b.keys.map(keyLabel).join(' / ') || '-'}</button></td>${reset(name)}</tr>`;
    }
    this.table.innerHTML = html;
    this.table.querySelectorAll('button[data-kind]').forEach((btn) => {
      btn.addEventListener('click', () => this.listen(btn.dataset.kind, btn.dataset.name));
    });
    this.table.querySelectorAll('button[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => this.resetRow(btn.dataset.reset));
    });
    this.highlight();
  }

  highlight() {
    this.table.querySelectorAll('tr[data-row]').forEach((tr) => {
      tr.classList.toggle('focus', +tr.dataset.row === this.focus);
    });
    const tr = this.table.querySelector(`tr[data-row="${this.focus}"]`);
    tr?.scrollIntoView({ block: 'nearest' });
  }

  resetRow(name) {
    this.cancel();
    this.input.resetOne(name);
    this.render();
    this.say(`${(ANALOG[name] || ACTIONS[name]).label} is back to its default.`);
  }

  listen(kind, name) {
    this.cancel();
    this.input.suspended = true;
    this.listening = { kind, name, base: this.snapshot(), started: performance.now() };
    const cell = this.table.querySelector(`button[data-kind="${kind}"][data-name="${name}"]`);
    cell?.classList.add('listening');
    if (cell) cell.textContent = 'Press…';
    const label = kind === 'axis' ? ANALOG[name].label : ACTIONS[name].label;
    if (kind === 'axis') this.say(`${label}: ${ANALOG[name].prompt}. Esc cancels.`);
    else if (kind === 'pad') this.say(`${label}: press a controller button or push a stick or trigger. Esc cancels.`);
    else this.say(`${label}: press a key. Esc cancels, Delete clears it.`);
  }

  cancel() {
    if (!this.listening) return;
    this.listening = null;
    this.input.suspended = false;
    this.render();
  }

  finish(msg) {
    this.listening = null;
    this.render();
    this.say(msg);
    // let the button that was just pressed go before the game reads it again
    setTimeout(() => { this.input.suspended = false; }, 250);
    this.navPrev = this.snapshot();
  }

  onKey(e) {
    if (!this.open) return;
    const L = this.listening;
    if (!L) {
      if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { this.cancel(); this.say('Cancelled.'); return; }
    if (L.kind !== 'key') return;
    if (e.code === 'Delete') { this.input.setKey(L.name, null); this.finish('Cleared.'); return; }
    this.input.setKey(L.name, e.code);
    this.finish(`${ACTIONS[L.name].label} is now ${keyLabel(e.code)}.`);
  }

  snapshot() {
    const pad = this.input.activePad();
    if (!pad) return null;
    return { buttons: pad.buttons.map((b) => b.value), axes: [...pad.axes] };
  }

  /** Called every frame while the screen is open. */
  update() {
    if (!this.open) return;
    const pad = this.input.activePad();
    const L = this.listening;
    if (L && pad && (L.kind === 'pad' || L.kind === 'axis')) {
      if (!L.base) L.base = this.snapshot();
      if (performance.now() - L.started < 200) return;
      // a newly pressed button
      if (L.kind === 'pad') {
        for (let i = 0; i < pad.buttons.length; i++) {
          if (pad.buttons[i].value < 0.3) L.base.buttons[i] = 0; // released since: can be picked
          if (pad.buttons[i].value > 0.5 && (L.base.buttons[i] ?? 0) < 0.3) {
            this.input.setPad(L.name, { b: i });
            this.finish(`${ACTIONS[L.name].label} is now ${padLabel({ b: i })}.`);
            return;
          }
        }
      }
      // the axis that moved furthest from rest
      let best = -1, bestD = 0.6;
      for (let i = 0; i < pad.axes.length; i++) {
        const d = Math.abs(pad.axes[i] - (L.base.axes[i] ?? 0));
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best >= 0) {
        const dir = Math.sign(pad.axes[best] - (L.base.axes[best] ?? 0));
        if (L.kind === 'axis') {
          this.input.setAxis(L.name, best, dir);
          this.finish(`${ANALOG[L.name].label} is now ${axisLabel({ axis: best })}.`);
        } else {
          const p = { a: best, dir };
          this.input.setPad(L.name, p);
          this.finish(`${ACTIONS[L.name].label} is now ${padLabel(p)}.`);
        }
      }
      return;
    }
    if (L || !pad) return;

    // Controller navigation of the list (fixed to the standard layout so it can't be lost)
    const now = this.snapshot();
    const prev = this.navPrev || now;
    const hit = (i) => now.buttons[i] > 0.5 && (prev.buttons[i] ?? 0) <= 0.5;
    if (hit(PAD.DOWN)) { this.focus = Math.min(this.rows.length - 1, this.focus + 1); this.highlight(); }
    if (hit(PAD.UP)) { this.focus = Math.max(0, this.focus - 1); this.highlight(); }
    if (hit(PAD.A)) {
      const r = this.rows[this.focus];
      if (r.kind !== 'key') this.listen(r.kind, r.name);
    }
    if (hit(PAD.X)) this.resetRow(this.rows[this.focus].name);
    if (hit(PAD.B)) this.close();
    this.navPrev = now;
  }
}
