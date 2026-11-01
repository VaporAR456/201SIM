// Phone and tablet controls: a drive stick on the left, a turn stick on the right, and big
// buttons for the main actions. They feed the same driver actions as a gamepad, so everything
// else (shooting, menus, rules) works unchanged. Only shown on touch screens while driving.

const BUTTONS = [
  // [action, label, css class]
  ['autoShoot', 'SHOOT', 'big shoot'],
  ['intake', 'INTAKE', 'big intake'],
  ['autoPass', 'PASS', 'mid pass'],
  ['manualShoot', 'FREE', 'mid free'],
  ['deload', 'DUMP', 'small deload'],
  ['swapCamera', 'CAM', 'small cam'],
  ['toggleFieldRel', 'FIELD', 'small field'],
  ['resetGyro', 'GYRO', 'small gyro'],
  ['pause', 'II', 'small pause'],
];

export const isTouch = () => matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

export class TouchControls {
  constructor() {
    this.enabled = isTouch();
    this.lx = this.ly = this.rx = 0;
    this.held = {};
    this.root = null;
    if (!this.enabled) return;
    document.body.classList.add('touch');
    const root = document.createElement('div');
    root.id = 'touch';
    root.hidden = true;
    root.innerHTML = `
      <div class="tstick left" data-stick="drive"><div class="knob"></div></div>
      <div class="tstick right" data-stick="turn"><div class="knob"></div></div>
      <div class="tbtns">${BUTTONS.map(([a, l, c]) => `<button class="tbtn ${c}" data-act="${a}">${l}</button>`).join('')}</div>
      <button class="tbtn small fs" data-fs>⛶</button>`;
    document.body.appendChild(root);
    this.root = root;
    for (const el of root.querySelectorAll('.tstick')) this.stick(el);
    for (const b of root.querySelectorAll('[data-act]')) this.button(b);
    root.querySelector('[data-fs]').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const d = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen?.();
      else d.requestFullscreen?.().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
    });
    // no page scrolling, zooming or long-press menus while driving
    root.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** A floating stick: it centers wherever your thumb lands inside its half of the screen. */
  stick(el) {
    const knob = el.querySelector('.knob');
    const R = 60;
    let id = null, cx = 0, cy = 0;
    const set = (x, y) => {
      const kind = el.dataset.stick;
      knob.style.transform = `translate(${x * R}px, ${y * R}px)`;
      if (kind === 'drive') { this.lx = x; this.ly = -y; } else { this.rx = x; }
    };
    el.addEventListener('pointerdown', (e) => {
      if (id !== null) return;
      id = e.pointerId; el.setPointerCapture(id);
      const r = el.getBoundingClientRect();
      cx = e.clientX; cy = e.clientY;
      el.style.setProperty('--x', `${cx - r.left}px`); el.style.setProperty('--y', `${cy - r.top}px`);
      el.classList.add('on');
      set(0, 0);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      let dx = (e.clientX - cx) / R, dy = (e.clientY - cy) / R;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      if (el.dataset.stick === 'turn') dy = 0;
      set(dx, dy);
    });
    const end = (e) => { if (e.pointerId !== id) return; id = null; el.classList.remove('on'); set(0, 0); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  button(b) {
    const a = b.dataset.act;
    const down = (e) => { e.preventDefault(); this.held[a] = true; b.classList.add('on'); b.setPointerCapture?.(e.pointerId); navigator.vibrate?.(8); };
    const up = () => { this.held[a] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
  }

  /** Show while driving, hide in menus. */
  show(on) {
    if (!this.root) return;
    if (this.root.hidden === !on) return;
    this.root.hidden = !on;
    if (!on) { this.held = {}; this.lx = this.ly = this.rx = 0; for (const b of this.root.querySelectorAll('.on')) b.classList.remove('on'); }
  }
}
