// Gamepad and keyboard input, turned into named driver actions.
//
// Gamepads use the browser's "standard" mapping (Xbox names below; PlayStation pads map the
// same way: A=Cross, B=Circle, X=Square, Y=Triangle).
// The default layout follows the draft in the 201SIM spec and will be matched to MoSim's.

export const PAD = {
  A: 0, B: 1, X: 2, Y: 3,
  LB: 4, RB: 5, LT: 6, RT: 7,
  VIEW: 8, MENU: 9, LS: 10, RS: 11,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
};

// Button actions: name -> gamepad button and keyboard codes
export const BINDINGS = {
  intake: { pad: PAD.LT, keys: ['ShiftLeft', 'ShiftRight'], label: 'Intake' },
  autoShoot: { pad: PAD.RT, keys: ['Space'], label: 'Auto shoot' },
  autoPass: { pad: PAD.RB, keys: ['KeyE'], label: 'Auto pass' },
  manualShoot: { pad: PAD.LB, keys: ['KeyQ'], label: 'Manual shoot' },
  special: { pad: PAD.Y, keys: ['KeyR'], label: 'Robot special' },
  toggleFieldRel: { pad: PAD.B, keys: ['KeyF'], label: 'Field / robot relative' },
  resetGyro: { pad: PAD.X, keys: ['KeyG'], label: 'Reset gyro' },
  slow: { pad: PAD.LS, keys: ['ControlLeft', 'ControlRight'], label: 'Slow mode (hold)' },
  camPrev: { pad: PAD.LEFT, keys: ['KeyC'], label: 'Camera' },
  camNext: { pad: PAD.RIGHT, keys: [], label: 'Camera' },
  pause: { pad: PAD.MENU, keys: ['Escape'], label: 'Pause' },
  restart: { pad: PAD.VIEW, keys: ['Backspace'], label: 'Restart (hold)' },
  confirm: { pad: PAD.A, keys: ['Enter'], label: 'Confirm' },
};

const DEADBAND = 0.08;

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
    addEventListener('keydown', (e) => {
      if (!e.repeat) this.tapped.add(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.code)) {
        e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  activePad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  /** Read the controls once per frame. */
  poll() {
    const pad = this.activePad();
    this.padName = pad ? pad.id : null;
    const k = (c) => this.keys.has(c) || this.tapped.has(c);

    // Analog: left stick translates, right stick X rotates
    let lx = 0, ly = 0, rx = 0;
    if (pad) {
      [lx, ly] = shape(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      rx = shape1(pad.axes[2] ?? 0);
    }
    const kx = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
    const ky = (k('KeyS') ? 1 : 0) - (k('KeyW') ? 1 : 0);
    if (kx || ky) {
      const n = Math.hypot(kx, ky);
      lx = kx / n;
      ly = ky / n;
    }
    const kr = (k('ArrowRight') || k('KeyL') ? 1 : 0) - (k('ArrowLeft') || k('KeyJ') ? 1 : 0);
    if (kr) rx = kr * 0.8;

    // forward is stick up (axis is negative up); right is stick right
    this.forward = -ly;
    this.strafe = lx;
    this.turn = rx;

    // Buttons
    const next = {};
    for (const [name, b] of Object.entries(BINDINGS)) {
      const padDown = pad && b.pad != null && pad.buttons[b.pad] && pad.buttons[b.pad].value > 0.5;
      next[name] = !!padDown || b.keys.some(k);
    }
    this.prev = this.state;
    this.state = next;
    // a key tapped and released between polls counts as pressed for one poll
    for (const c of this.tapped) if (!this.keys.has(c)) for (const [name, b] of Object.entries(BINDINGS)) {
      if (b.keys.includes(c)) this.prev[name] = false;
    }
    this.tapped.clear();
  }

  held(name) { return !!this.state[name]; }
  pressed(name) { return !!this.state[name] && !this.prev[name]; }
}
