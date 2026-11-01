// REBUILT match flow: 20s AUTO, then 2:20 of teleop split into a 10s TRANSITION (both HUBs
// active), four 25s SHIFTS where the HUBs take turns being active, and a 30s END GAME (both
// active). The alliance that scored more FUEL in AUTO has its HUB inactive in SHIFT 1.
// FUEL counts for 1 point in an active HUB, and up to 3 seconds after it turns inactive.
// Between AUTO and TELEOP robots are disabled for 3 seconds while AUTO scoring finishes, and
// FUEL still counts for 3 seconds after the match timer hits 0:00.
import { BLUE, RED } from './constants.js';

export const PHASES = [
  { name: 'AUTO', len: 20 },
  { name: 'AUTO DONE', len: 3, disabled: true }, // robots disabled; AUTO FUEL still counting
  { name: 'TRANSITION', len: 10 },
  { name: 'SHIFT 1', len: 25, shift: 1 },
  { name: 'SHIFT 2', len: 25, shift: 2 },
  { name: 'SHIFT 3', len: 25, shift: 3 },
  { name: 'SHIFT 4', len: 25, shift: 4 },
  { name: 'END GAME', len: 30 },
];
const GRACE = 3;
const other = (a) => (a === BLUE ? RED : BLUE);

export class Match {
  constructor() { this.reset(false); }

  reset(on) {
    this.on = on;
    this.t = 0; // seconds since the match started
    this.over = false;
    this.autoFuel = { [BLUE]: 0, [RED]: 0 };
    this.points = { [BLUE]: 0, [RED]: 0 };
    this.firstInactive = null; // decided when AUTO ends
    this.lastActive = { [BLUE]: 0, [RED]: 0 };
    this.shots = 0;
    this.overT = 0;
    // 3-2-1-GO before the clock starts: robots are disabled until GO
    this.countdown = on ? 3 : 0;
  }

  /** True while the robot is disabled (the pause between AUTO and TELEOP, or after the match). */
  get disabled() {
    return this.on && (this.over || this.countdown > 0 || !!this.phase().disabled);
  }

  /** Seconds left in TELEOP (2:20 at the start of the TRANSITION SHIFT). */
  teleopLeft() {
    const before = PHASES[0].len + PHASES[1].len;
    return Math.max(0, PHASES.reduce((a, p) => a + p.len, 0) - Math.max(before, this.t));
  }

  phase() {
    let t = this.t;
    for (const p of PHASES) {
      if (t < p.len) return { ...p, left: p.len - t };
      t -= p.len;
    }
    return { name: 'MATCH OVER', left: 0 };
  }

  isActive(alliance) {
    if (!this.on) return true;
    const p = this.phase();
    if (!p.shift) return p.name !== 'MATCH OVER';  // AUTO, AUTO DONE, TRANSITION, END GAME
    const inactiveFirst = this.firstInactive ?? RED;
    // odd shifts: the AUTO winner's HUB is off; even shifts: the other one is
    const off = p.shift % 2 === 1 ? inactiveFirst : other(inactiveFirst);
    return alliance !== off;
  }

  /** Advance the clock. Returns true on the frame the match ends. */
  update(dt) {
    if (!this.on) return false;
    if (this.over) { this.overT += dt; return false; }
    if (this.countdown > 0) { this.countdown = Math.max(0, this.countdown - dt); return false; }
    const autoNames = ['AUTO', 'AUTO DONE'];
    const wasAuto = autoNames.includes(this.phase().name);
    this.t += dt;
    if (wasAuto && !autoNames.includes(this.phase().name)) {
      // a tie is settled at random, like the field's coin flip
      const b = this.autoFuel[BLUE], r = this.autoFuel[RED];
      this.firstInactive = b > r ? BLUE : r > b ? RED : (Math.random() < 0.5 ? BLUE : RED);
    }
    for (const a of [BLUE, RED]) if (this.isActive(a)) this.lastActive[a] = this.t;
    if (this.phase().name === 'MATCH OVER') { this.over = true; return true; }
    return false;
  }

  /** FUEL went into a HUB: does it count? */
  scored(alliance) {
    if (!this.on) { this.points[alliance]++; return true; }
    // the HUB keeps counting for 3 seconds after the timer reaches 0:00
    if (this.over) {
      if (this.overT > GRACE) return false;
      this.points[alliance]++;
      return true;
    }
    const counts = this.isActive(alliance) || this.t - this.lastActive[alliance] <= GRACE;
    if (counts) {
      this.points[alliance]++;
      if (['AUTO', 'AUTO DONE'].includes(this.phase().name)) this.autoFuel[alliance]++;
    }
    return counts;
  }
}

export function clock(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
