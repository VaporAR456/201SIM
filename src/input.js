// Gamepad and keyboard input, turned into named driver actions. Every binding can be remapped
// in the Controls screen and is saved in this browser.
//
// Gamepads use the browser's "standard" mapping (Xbox names below; PlayStation pads map the
// same way: A=Cross, B=Circle, X=Square, Y=Triangle). Controllers without the standard mapping
// still work once remapped, because a binding can be any button or any axis direction.

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

const PAD_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'Left stick click',
  'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];
const AXIS_NAMES = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'];

// Analog actions: which axis, and the sign that makes the prompted direction positive
export const ANALOG = {
  driveX: { label: 'Drive left / right', prompt: 'Push the stick RIGHT', axis: 0, sign: 1 },
  driveY: { label: 'Drive forward / back', prompt: 'Push the stick FORWARD (up)', axis: 1, sign: -1 },
  rotate: { label: 'Rotate', prompt: 'Push the stick RIGHT', axis: 2, sign: 1 },
};

// Digital actions: a gamepad button or axis direction, plus keyboard keys.
// Defaults match MoSim's REBUILT layout (from abdur's screenshots of MoSim's Keybinds screen).
// Field/robot relative, reset gyro, pause and restart are 201SIM extras on buttons MoSim leaves free.
export const ACTIONS = {
  intake: { label: 'Intake', pad: { b: PAD.LT }, keys: ['ShiftLeft'] },
  autoShoot: { label: 'Auto shoot', pad: { b: PAD.RT }, keys: ['KeyK'] },
  autoPass: { label: 'Auto pass', pad: { b: PAD.RB }, keys: ['KeyE'] },
  manualShoot: { label: 'Manual shoot', pad: { b: PAD.LB }, keys: ['KeyQ'] },
  climb: { label: 'Climb', pad: { b: PAD.DOWN }, keys: ['KeyC'] },
  special1: { label: 'Robot special 1', pad: { b: PAD.Y }, keys: ['KeyV'] },
  special2: { label: 'Robot special 2', pad: { b: PAD.X }, keys: ['KeyI'] },
  special3: { label: 'Robot special 3', pad: { b: PAD.B }, keys: ['KeyO'] },
  swapCamera: { label: 'Swap camera', pad: { b: PAD.RS }, keys: ['Space'] },
  speed1: { label: 'Drive speed 1 (slow)', pad: null, keys: ['Digit1'] },
  speed2: { label: 'Drive speed 2', pad: null, keys: ['Digit2'] },
  speed3: { label: 'Drive speed 3 (full)', pad: null, keys: ['Digit3'] },
  toggleFieldRel: { label: 'Field / robot relative', pad: { b: PAD.LS }, keys: ['KeyF'] },
  resetGyro: { label: 'Reset gyro', pad: { b: PAD.UP }, keys: ['KeyG'] },
  pause: { label: 'Pause', pad: { b: PAD.MENU }, keys: ['Escape'] },
  restart: { label: 'Restart (hold)', pad: { b: PAD.VIEW }, keys: ['Backspace'] },
  driveFwd: { label: 'Drive forward', pad: null, keys: ['KeyW'], keyOnly: true },
  driveBack: { label: 'Drive back', pad: null, keys: ['KeyS'], keyOnly: true },
  driveLeft: { label: 'Drive left', pad: null, keys: ['KeyA'], keyOnly: true },
  driveRight: { label: 'Drive right', pad: null, keys: ['KeyD'], keyOnly: true },
  rotLeft: { label: 'Steer left', pad: null, keys: ['KeyJ'], keyOnly: true },
  rotRight: { label: 'Steer right', pad: null, keys: ['KeyL'], keyOnly: true },
};

// Menu keys that never change, so you can always get back out
const FIXED = { confirm: { pad: { b: PAD.A }, keys: ['Enter'] } };

const STORAGE_KEY = '201sim.bindings.v2';
const DEADBAND = 0.08;

export function padLabel(p) {
  if (!p) return '-';
  if (p.b != null) return PAD_NAMES[p.b] ?? `Button ${p.b}`;
  return `${AXIS_NAMES[p.a] ?? `Axis ${p.a}`} ${p.dir > 0 ? '+' : '-'}`;
}

export function keyLabel(code) {
  if (!code) return '-';
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace(/^Arrow(\w+)/, (_, d) => ({ Left: '←', Right: '→', Up: '↑', Down: '↓' }[d]))
    .replace(/(Left|Right)$/, ' ($1)')
    .replace('Control', 'Ctrl').replace('Escape', 'Esc');
}

export function axisLabel(a) {
  return AXIS_NAMES[a.axis] ?? `Axis ${a.axis}`;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function shape(x, y) {
  // Circular deadband, then square the magnitude for fine control at low speed
  const mag = Math.hypot(x, y);
  if (mag < DEADBAND) return [0, 0];
  const m = Math.min(1, (mag - DEADBAND) / (1 - DEADBAND));
  const s = (m * m) / mag;
  return [x * s, y * s];
}

function shape1(v) {
  const a = Math.abs(v);
  if (a < DEADBAND) return 0;
  const m = Math.min(1, (a - DEADBAND) / (1 - DEADBAND));
  return Math.sign(v) * m * m;
}

export class Input {
  constructor() {
    this.keys = new Set();
    this.tapped = new Set(); // keys pressed since the last poll, so quick taps are never missed
    this.prev = {};
    this.state = {};
    this.padName = null;
    this.suspended = false; // true while the Controls screen is listening for a new binding
    this.load();
    addEventListener('keydown', (e) => {
      if (this.suspended) return;
      if (!e.repeat) this.tapped.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Tab'].includes(e.code)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  // ---------------------------------------------------------- bindings
  defaults() {
    const actions = {};
    for (const [k, a] of Object.entries(ACTIONS)) actions[k] = { pad: a.pad, keys: a.keys };
    const analog = {};
    for (const [k, a] of Object.entries(ANALOG)) analog[k] = { axis: a.axis, sign: a.sign };
    return clone({ actions, analog });
  }

  load() {
    this.bindings = this.defaults();
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) {
        for (const k of Object.keys(this.bindings.actions)) if (saved.actions?.[k]) this.bindings.actions[k] = saved.actions[k];
        for (const k of Object.keys(this.bindings.analog)) if (saved.analog?.[k]) this.bindings.analog[k] = saved.analog[k];
      }
    } catch { /* storage blocked: defaults only */ }
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.bindings)); } catch { /* not saved */ }
  }

  resetBindings() {
    this.bindings = this.defaults();
    this.save();
  }

  /** Put one action (or one stick) back to its default binding. */
  resetOne(name) {
    const d = this.defaults();
    if (d.analog[name]) this.bindings.analog[name] = d.analog[name];
    else {
      const def = d.actions[name];
      if (def.pad) this.setPad(name, def.pad);
      else this.bindings.actions[name].pad = null;
      for (const c of def.keys) for (const b of Object.values(this.bindings.actions)) b.keys = b.keys.filter((x) => x !== c);
      this.bindings.actions[name].keys = def.keys;
    }
    this.save();
  }

  setPad(action, pad) {
    // a button does one job: take it off any other action first
    if (pad) for (const b of Object.values(this.bindings.actions)) if (sameP(b.pad, pad)) b.pad = null;
    this.bindings.actions[action].pad = pad;
    this.save();
  }

  setKey(action, code) {
    if (code) for (const b of Object.values(this.bindings.actions)) b.keys = b.keys.filter((c) => c !== code);
    this.bindings.actions[action].keys = code ? [code] : [];
    this.save();
  }

  setAxis(name, axis, sign) {
    this.bindings.analog[name] = { axis, sign };
    this.save();
  }

  // ---------------------------------------------------------- reading
  activePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  padActive(pad, p) {
    if (!pad || !p) return false;
    if (p.b != null) return (pad.buttons[p.b]?.value ?? 0) > 0.5;
    return (pad.axes[p.a] ?? 0) * p.dir > 0.5;
  }

  /** Read the controls once per frame. */
  poll() {
    const pad = this.activePad();
    this.padName = pad ? pad.id : null;
    const k = (c) => this.keys.has(c) || this.tapped.has(c);
    const B = this.bindings;

    if (this.suspended) {
      this.prev = this.state;
      this.state = {};
      this.forward = this.strafe = this.turn = 0;
      this.tapped.clear();
      return;
    }

    // Analog sticks
    let lx = 0, ly = 0, rx = 0;
    if (pad) {
      const ax = (a) => (pad.axes[a.axis] ?? 0) * a.sign;
      [lx, ly] = shape(ax(B.analog.driveX), ax(B.analog.driveY));
      rx = shape1(ax(B.analog.rotate));
    }

    // Buttons
    const next = {};
    for (const [name, b] of Object.entries(B.actions)) next[name] = this.padActive(pad, b.pad) || b.keys.some(k);
    for (const [name, b] of Object.entries(FIXED)) next[name] = this.padActive(pad, b.pad) || b.keys.some(k);

    // Keyboard driving overrides the sticks while held
    const kx = (next.driveRight ? 1 : 0) - (next.driveLeft ? 1 : 0);
    const ky = (next.driveFwd ? 1 : 0) - (next.driveBack ? 1 : 0);
    if (kx || ky) {
      const n = Math.hypot(kx, ky);
      lx = kx / n;
      ly = ky / n;
    }
    const kr = (next.rotRight ? 1 : 0) - (next.rotLeft ? 1 : 0);
    if (kr) rx = kr * 0.8;

    this.forward = ly;
    this.strafe = lx;
    this.turn = rx;

    this.prev = this.state;
    this.state = next;
    this.tapped.clear();
  }

  held(name) { return !!this.state[name]; }
  pressed(name) { return !!this.state[name] && !this.prev[name]; }
}

function sameP(a, b) {
  if (!a || !b) return false;
  return a.b != null ? a.b === b.b : a.a === b.a && a.dir === b.dir;
}
