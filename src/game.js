// The robot's game mechanisms: expanding hopper (the agitator), intake, spindexer feed and
// shooter, plus HUB scoring. Tuning lives in robotConfig.js (hardware) and settings.js (player).
import * as THREE from 'three';
import { IN, HALF_L, HALF_W, HUB, BLUE, RED, fieldToWorld, GROUP, groups, ALLIANCE_ZONE_DEPTH, OUTPOST } from './constants.js';
import { FUEL_RADIUS, hubCenter } from './fuel.js';

const G = 9.81;
const deg = Math.PI / 180;
// roughly normal noise (sum of uniforms), standard deviation ~1
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class Game {
  constructor(scene, robot, fuel, settings) {
    this.robot = robot;
    this.fuel = fuel;
    this.settings = settings;
    this.cfg = robot.cfg;
    this.score = { [BLUE]: 0, [RED]: 0 };
    this.held = 0;
    this.hopperPos = 0; // inches out; 12 = fully out (intake down), -4 = pulled in past stowed
    this.agitateT = 0;
    this.fireT = 0;
    this.exitQueue = [];
    this.aim = null;
    this.clock = 0;
    this.alliance = BLUE;

    // aim line
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3));
    this.aimLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffd21f, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.8 }));
    this.aimLine.frustumCulled = false;
    this.aimLine.visible = false;
    scene.add(this.aimLine);

    this.inside = []; // FUEL bodies sitting in the hopper right now
    this.insideLocal = []; // and where, in the robot's frame (for drawing the net)

    // the net: a grid of cords that sags, bulges over a full hopper and wobbles as the robot moves
    const NU = 14, NV = 10;
    this.netN = [NU, NV];
    const netGeo = new THREE.BufferGeometry();
    netGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NU * NV * 3), 3));
    const idx = [];
    for (let i = 0; i < NU; i++) for (let k = 0; k < NV; k++) {
      const n = i * NV + k;
      if (i + 1 < NU) idx.push(n, n + NV);
      if (k + 1 < NV) idx.push(n, n + 1);
    }
    netGeo.setIndex(idx);
    const net = new THREE.LineSegments(netGeo, new THREE.LineBasicMaterial({ color: 0x15171a }));
    net.frustumCulled = false;
    robot.root.add(net);
    this.netMesh = net;
    this.wob = { y: 0, vy: 0, z: 0, vz: 0, x: 0, vx: 0 };
    this.lastVel = null;
    this.lastT = 0;
  }

  /** How many FUEL fit right now: the net holds `capacity`; a broken net loses a quarter. */
  get capacity() {
    return this.netBroken ? Math.floor(this.settings.capacity * 0.75) : this.settings.capacity;
  }

  reset() {
    // a human player for each alliance; `human` is yours (the HUD shows it)
    this.humans = { [BLUE]: { stash: 0, t: 0, thrown: 0 }, [RED]: { stash: 0, t: 0, thrown: 0 } };
    this.netBroken = false;
    this.strain = 0;
    this.spillT = 0;
    if (this.wob) Object.assign(this.wob, { y: 0, vy: 0, z: 0, vz: 0, x: 0, vx: 0 });
    this.score = { [BLUE]: 0, [RED]: 0 };
    this.fouls = [];
    this.aiFouls = [];
    this.ejected = 0;
    this.lastG407 = -99;
    this.shots = 0;
    this.missedInactive = 0;
    this.exitQueue = [];
    this.fuel.reset();
    this.robot.setNet(true);
    // start with the hopper out just far enough for the preload
    const pre = Math.min(this.preloadCount(), this.capacity);
    this.hopperPos = Math.max(0, this.cfg.hopper.outIn + (this.cfg.hopper.box.rearX + Math.ceil(pre / 11) * 0.165 + 0.01 + 0.1 - this.robot.halfL) / 0.0254);
    this.robot.setHopper(this.hopperPos, this.cfg.hopper.outIn);
    // preloaded FUEL: real balls dropped into the hopper
    const hb = this.cfg.hopper.box;
    const n = Math.min(this.preloadCount(), this.capacity);
    for (let i = 0; i < n; i++) {
      const b = this.fuel.takeSpare();
      if (!b) break;
      const lx = hb.rearX + 0.085 + Math.floor(i / 12) * 0.16;
      const lz = -hb.halfW + 0.085 + (i % 4) * 0.155;
      const ly = hb.floorY + 0.085 + (Math.floor(i / 4) % 3) * 0.16;
      const w = this.toWorld(lx, ly, lz);
      this.fuel.enable(b, w.x, w.y, w.z, 0, 0, 0);
      b.body.enableCcd(true);
    }
    this.countInside();
  }

  /**
   * Called once per physics step before the robot drives. Returns a turn command that replaces
   * the driver's while auto-aiming, or null.
   */
  update(input, dt, alliance) {
    this.alliance = alliance;
    const cfg = this.cfg;
    const hop = cfg.hopper;
    const shooting = input.held('autoShoot') || input.held('autoPass') || input.held('manualShoot');

    // ---------------------------------------------------------- expanding hopper / agitator
    let target = 0;
    if (shooting && this.held > 0) {
      this.agitateT += dt;
      const cycle = hop.outHold + hop.inHold;
      target = (this.agitateT % cycle) < hop.outHold ? hop.outIn : hop.inIn;
    } else {
      this.agitateT = 0;
      if (input.held('intake')) target = hop.outIn;
    }
    // a full hopper can't be pulled all the way in: the FUEL takes up the room
    const hb = hop.box;
    // the front wall can't slide back past the frontmost ball (FUEL can't be crushed), and a pile
    // needs about one ball-width of hopper per 11 FUEL (4 across, 3 high)
    let frontBall = -Infinity;
    for (const l of this.insideLocal) frontBall = Math.max(frontBall, l[0]);
    const needLen = this.held ? Math.ceil(this.held / 11) * 0.165 + 0.01 : 0;
    const minFront = Math.max(hb.rearX + needLen, frontBall + FUEL_RADIUS + 0.01);
    const minPos = hop.outIn + (minFront + 0.1 - this.robot.halfL) / 0.0254;
    // (except while shooting: then the agitator really does drive in and shove the pile at the
    // spindexer, which is the whole point of it)
    if (!(this.agitateT > 0)) target = Math.max(target, Math.min(hop.outIn, minPos));
    const step = hop.maxSpeedInPerS * dt;
    this.hopperPos += Math.max(-step, Math.min(step, target - this.hopperPos));
    this.robot.setHopper(this.hopperPos, hop.outIn);

    // ---------------------------------------------------------- intake
    this.countInside();
    // the agitator also shakes the pile a little so FUEL finds the spindexer
    if (this.agitateT > 0 && Math.random() < dt * 8 && this.inside.length) {
      const b = this.inside[Math.floor(Math.random() * this.inside.length)];
      // (a kick in velocity terms, so it's the same whatever the held FUEL's physics mass is)
      const lv = b.body.linvel();
      b.body.setLinvel({ x: lv.x + (Math.random() - 0.5) * 0.37, y: lv.y + 0.56, z: lv.z + (Math.random() - 0.5) * 0.37 }, true);
    }
    // The net: a full hopper won't take more. Keep ramming FUEL into it and you can cram in a
    // couple extra, but hold it there too long and the net tears off.
    const net = this.cfg.net;
    let pushing = false;
    const rollers = input.held('intake') && this.hopperPos > hop.outIn - 2;
    if (rollers) {
      const full = this.held >= this.capacity;
      const overLimit = this.capacity + (this.netBroken ? 0 : net.cramExtra);
      const waiting = this.collect(full ? Math.min(overLimit, this.capacity + Math.floor(this.strain / net.cramEvery)) : this.capacity);
      pushing = full && waiting > 0 && !this.netBroken;
    }
    if (pushing) {
      this.strain += dt;
      if (this.strain >= net.breakAfter) this.breakNet();
    } else {
      this.strain = Math.max(0, this.strain - dt * net.recover);
    }
    // ---------------------------------------------------------- aiming and shooting
    let turn = null;
    this.aim = null;
    if (input.held('autoShoot')) this.aim = this.solveHub(alliance);
    else if (input.held('autoPass')) this.aim = this.solvePass(alliance);
    else if (input.held('manualShoot')) this.aim = this.solveManual();

    if (this.aim && this.aim.yaw !== undefined) {
      const err = wrap(this.aim.yaw - this.robot.yaw());
      // a calm heading controller: no faster than ~60% of top turn rate, so it settles instead of
      // whipping round while the robot moves
      const lim = cfg.maxOmega * 0.6;
      const omega = Math.max(-lim, Math.min(lim, 4.5 * err));
      turn = -omega / (cfg.maxOmega * this.robot.speedScale);
      turn = Math.max(-1, Math.min(1, turn));
      // Like passing: on the move you keep firing at nearly the normal rate and just miss more.
      // The window opens with speed, and once firing it stays open unless you're way off. Shots go
      // where the shooter actually points, so any heading error shows up as a miss.
      const v = this.robot.body.linvel();
      const moving = Math.hypot(v.x, v.z);
      const win = (this.firing ? 15 : Math.min(12, 4 + 4 * moving)) * deg;
      this.aim.ready = Math.abs(err) < win;
      this.aim.err = err;
    }

    // deload: roll FUEL back out over the intake, e.g. to hand it to the human player
    this.deloadT = (this.deloadT || 0) - dt;
    if (input.held('deload') && !shooting && this.held > 0 && this.deloadT <= 0 && !(this.match?.countdown > 0)) {
      this.deloadT = 1 / 8;
      this.deload();
    }
    this.fireT -= dt;
    this.robot.spinIndexer(shooting && this.held > 0 ? dt : 0);
    if (this.aim && this.aim.ready && this.held > 0 && this.fireT <= 0 && !(this.match?.countdown > 0)) {
      // both shooters fire together (one ball each, while there are two to give)
      const ex = this.cfg.shooter.exits || [this.cfg.shooter.exit];
      for (const e of ex) if (this.held > 0) this.launch(this.aim, e);
      this.fireT = ex.length / (this.settings.bps ?? 9); // a volley of one per shooter
    }
    this.firing = !!(this.aim && this.aim.ready && this.held > 0);

    this.clock += dt;
    this.scoreCheck(dt);
    this.returnStrays(dt);
    this.humanPlayer(dt);
    return turn;
  }

  // ------------------------------------------------------------ human player
  /**
   * Each alliance has a human player behind its OUTPOST. FUEL you deliver there (shoot, pass or push it
   * into the OUTPOST) goes into their stash, and they throw it into your HUB whenever it's active.
   * Good throws, not perfect ones.
   */
  get human() { return this.humans[this.alliance]; }

  humanPlayer(dt) {
    for (const al of [BLUE, RED]) this.humanFor(al, dt);
  }

  /** Hand FUEL straight to an alliance's human player (an AI robot dumping into the OUTPOST). */
  feedHuman(al, n) { this.humans[al].stash += n; }

  humanFor(al, dt) {
    const h = this.humans[al];
    const sign = al === BLUE ? -1 : 1;
    const o = fieldToWorld(OUTPOST.depth / 2, OUTPOST.fy, al);
    const hx = OUTPOST.depth / 2 + 0.25, hz = OUTPOST.width / 2 + 0.2;
    // collect delivered FUEL (a few checks a second is plenty)
    h.t += dt;
    if ((h.scanT = (h.scanT || 0) + dt) > 0.1) {
      h.scanT = 0;
      for (const b of this.fuel.balls) {
        if (!b.active || b.inRobot) continue;
        const t = b.body.translation();
        if (Math.abs(t.x - o.x) < hx && Math.abs(t.z - o.z) < hz && t.y < 0.9) {
          this.fuel.disable(b);
          h.stash++;
        }
      }
    }
    // throw: about one every 0.6 s while the HUB counts
    const active = this.match ? this.match.isActive(al) && !this.match.over : true;
    if (h.stash > 0 && active && h.t > 0.65) {
      const b = this.fuel.takeSpare();
      if (!b) return;
      h.t = Math.random() * 0.15;
      h.stash--;
      h.thrown++;
      const hub = hubCenter(al);
      // from over the alliance wall above the OUTPOST, arcing into the HUB
      const sx = sign * (HALF_L - 0.2), sy = 2.1, sz = o.z;
      const aimX = hub.x + (Math.random() - 0.5) * 0.5, aimZ = hub.z + (Math.random() - 0.5) * 0.5;
      const dx = aimX - sx, dz = aimZ - sz;
      const d = Math.hypot(dx, dz);
      const dh = HUB.rim + 0.25 - sy;
      const th = (52 + (Math.random() - 0.5) * 6) * deg;
      const g = 9.81;
      const v = Math.sqrt((g * d * d) / (2 * Math.cos(th) ** 2 * (d * Math.tan(th) - dh))) * (1 + (Math.random() - 0.5) * 0.06);
      const hv = v * Math.cos(th);
      this.fuel.enable(b, sx, sy, sz, (dx / d) * hv, v * Math.sin(th), (dz / d) * hv);
      b.shot = null;
      b.human = al;
      this.onHumanThrow?.(al);
    }
  }

  // ------------------------------------------------------------ intake
  breakNet() {
    this.netBroken = true;
    this.strain = 0;
    // the net tears off the front and flops over the back; FUEL on top of the pile pops out
    this.wob.vy += 2;
    this.robot.setNet(false);
    const top = [...this.inside].sort((a, b) => b.body.translation().y - a.body.translation().y);
    const pop = Math.max(0, this.held - this.capacity) + 3;
    for (let i = 0; i < pop && i < top.length; i++) {
      const a = Math.random() * Math.PI * 2;
      const lv = top[i].body.linvel();
      top[i].body.setLinvel({ x: lv.x + Math.cos(a) * 1.16, y: lv.y + 2.1, z: lv.z + Math.sin(a) * 1.16 }, true);
    }
  }

  /** Drop FUEL out of the top of the robot onto the carpet. */
  spill(n) {
    const p = this.robot.body.translation();
    for (let i = 0; i < n && this.held > 0; i++) {
      const b = this.fuel.takeSpare();
      if (!b) return;
      const a = Math.random() * Math.PI * 2;
      this.fuel.enable(b, p.x + Math.cos(a) * 0.3, p.y + 0.7, p.z + Math.sin(a) * 0.3,
        Math.cos(a) * 1.5, 1, Math.sin(a) * 1.5);
      this.held--;
    }
  }

  /** Robot-frame point to world. */
  toWorld(lx, ly, lz) {
    const p = this.robot.body.translation();
    const q = this.robot.body.rotation();
    const v = new THREE.Vector3(lx, ly, lz).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    return { x: p.x + v.x, y: p.y + v.y, z: p.z + v.z };
  }

  /** Let a ball the intake is feeding pass through the hopper's front door (or not). */
  setFeeding(b, on) {
    b.feeding = on;
    this.fuel.updateGroups(b);
  }

  /** Find the FUEL sitting in the hopper (by position, in the robot's frame). */
  /** How many FUEL start in the robot (the main menu can turn the preload off). */
  preloadCount() { return this.preloadOn === false ? 0 : this.cfg.preload; }

  countInside() {
    const r = this.robot;
    const p = r.body.translation();
    const q = r.body.rotation();
    this._qi = (this._qi || new THREE.Quaternion()).set(-q.x, -q.y, -q.z, q.w);
    this._qf = this._qf || new THREE.Quaternion();
    const v = this._v || (this._v = new THREE.Vector3());
    const hb = this.cfg.hopper.box;
    const front = r.hopperFront;
    this.inside.length = 0;
    this.insideLocal.length = 0;
    for (const b of this.fuel.balls) {
      if (!b.active) continue;
      const t = b.body.translation();
      const dx = t.x - p.x, dz = t.z - p.z;
      if (dx * dx + dz * dz > 1.0) {
        if (b.inRobot) { b.inRobot = false; this.fuel.setHeld(b, false); }
        if (b.feeding) this.setFeeding(b, false);
        continue;
      }
      v.set(dx, t.y - p.y, dz).applyQuaternion(this._qi);
      // Containment: a held ball squeezed partway through a wall (a stiff solver limit when 30+
      // FUEL lean on it in a fast spin, or a hard landing off a BUMP) goes back in, the way the
      // real hopper would hold it. Only the intake (feeding) and a torn net let FUEL out.
      if (b.inRobot && !b.feeding && !this.netBroken) {
        const R = FUEL_RADIUS + 0.005;
        const lo = [hb.rearX + R, hb.floorY + R, -hb.halfW + R], hi = [front - R, hb.netY - R, hb.halfW - R];
        const c = [v.x, v.y, v.z];
        let out = false, far = false;
        for (let k = 0; k < 3; k++) {
          if (c[k] < lo[k]) { far ||= lo[k] - c[k] > 0.25; c[k] = lo[k]; out = true; }
          else if (c[k] > hi[k]) { far ||= c[k] - hi[k] > 0.25; c[k] = hi[k]; out = true; }
        }
        // only a little way out: it's still really in there
        if (out && !far && (c[0] - v.x) ** 2 + (c[1] - v.y) ** 2 + (c[2] - v.z) ** 2 > (0.6 * FUEL_RADIUS) ** 2) {
          v.set(c[0], c[1], c[2]);
          const back = this._v2 || (this._v2 = new THREE.Vector3());
          back.copy(v).applyQuaternion(this._qf.set(q.x, q.y, q.z, q.w));
          b.body.setTranslation({ x: p.x + back.x, y: p.y + back.y, z: p.z + back.z }, true);
          const lv = r.body.linvel();
          b.body.setLinvel({ x: lv.x, y: lv.y, z: lv.z }, true);
        }
      }
      const inside = v.x > hb.rearX - 0.08 && v.x < front + 0.02 && Math.abs(v.z) < hb.halfW + 0.03 && v.y > hb.floorY - 0.02 && v.y < hb.netY + 0.15;
      if (inside !== !!b.inRobot) { b.inRobot = inside; b.body.enableCcd(false); this.fuel.setHeld(b, inside); }
      // a fed ball that is well inside (or that missed) shuts the one-way door behind it
      if (b.feeding && (v.x < front - 0.01 || v.x > front + 0.5 || v.y > hb.netY + 0.2)) this.setFeeding(b, false);
      if (inside) { this.inside.push(b); this.insideLocal.push([v.x, v.y, v.z]); }
    }
    this.held = this.inside.length;
  }

  /**
   * Run the intake rollers: FUEL in front of the intake gets pulled up and over into the hopper,
   * up to `limit`. Returns how many were left waiting at a full hopper.
   */
  collect(limit) {
    let waiting = 0;
    const r = this.robot;
    const p = r.body.translation();
    const yaw = r.yaw();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const front = r.hopperFront;
    const x0 = front - 0.03;
    const x1 = front + this.cfg.intakeReach + FUEL_RADIUS;
    const hw = this.cfg.intakeWidth / 2;
    const rv = r.body.linvel();
    let pulled = 0;
    for (const b of this.fuel.balls) {
      if (!b.active || b.inRobot) continue;
      const q = b.body.translation();
      if (q.y - p.y > 0.4) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (lx > x0 && lx < x1 && Math.abs(lz) < hw) {
        if (this.held + pulled >= limit) { waiting++; continue; }
        pulled++;
        // rollers: back over the front wall and up, steering toward the middle of the hopper
        const back = -2.2, up = q.y - p.y < 0.24 ? 2.4 : 0.6, side = -lz * 3;
        b.body.setLinvel({ x: rv.x + back * c + side * s, y: up, z: rv.z - back * s + side * c }, true);
        b.body.enableCcd(true);
        this.setFeeding(b, true);
      }
    }
    return waiting;
  }

  // ------------------------------------------------------------ ballistics
  exitPoint(at) {
    const r = this.robot;
    const [ex, ey, ez] = at || this.cfg.shooter.exit;
    const p = r.body.translation();
    const yaw = r.yaw();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: p.x + ex * c + ez * s, y: p.y + ey, z: p.z - ex * s + ez * c };
  }

  /** Speed needed to go d horizontally and h up at launch angle th, or null. */
  static speedFor(d, h, th) {
    const den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - h);
    if (den <= 0) return null;
    return Math.sqrt((G * d * d) / den);
  }

  /** Aim at a point, leading for robot motion (shoot on the move). */
  solveTo(tx, ty, tz, angleFn, maxSpeed, scale = 1) {
    const sh = this.cfg.shooter;
    const e = this.exitPoint();
    const v = this.robot.body.linvel();
    let ax = tx, az = tz, sol = null;
    for (let i = 0; i < 4; i++) {
      const dx = ax - e.x, dz = az - e.z;
      const d = Math.hypot(dx, dz);
      let th = angleFn(d);
      let spd = Game.speedFor(d, ty - e.y, th);
      if (!spd) { th = Math.atan((ty - e.y + 0.6) / d); spd = Game.speedFor(d, ty - e.y, th) || maxSpeed; }
      const want = spd;
      spd = Math.min(spd * scale, maxSpeed);
      const tof = d / (spd * Math.cos(th));
      sol = { d, th, spd, want, ux: dx / d, uz: dz / d, tof };
      // lead the target by where the robot's own motion will carry the ball (the aim does this
      // well but not perfectly, and never by more than a meter)
      let lx = v.x * tof * 0.85, lz = v.z * tof * 0.85;
      const ll = Math.hypot(lx, lz);
      if (ll > 1) { lx /= ll; lz /= ll; }
      ax = tx - lx;
      az = tz - lz;
    }
    const f = sh.facing;
    sol.yaw = Math.atan2(-f * sol.uz, f * sol.ux);
    sol.e = e;
    sol.short = sol.want * scale > maxSpeed + 0.01;
    return sol;
  }

  hoodAngle(d) {
    const sh = this.cfg.shooter;
    const t = Math.max(0, Math.min(1, (d - sh.nearDist) / (sh.farDist - sh.nearDist)));
    return (sh.angleNear + (sh.angleFar - sh.angleNear) * t) * deg;
  }

  solveHub(alliance) {
    const h = hubCenter(alliance);
    const sol = this.solveTo(h.x, this.cfg.shooter.aimHeight, h.z, (d) => this.hoodAngle(d),
      this.cfg.shooter.maxExitSpeed, this.settings.hubPower / 100);
    sol.kind = 'shot';
    return sol;
  }

  solvePass(alliance) {
    const p = this.robot.body.translation();
    const fy = Math.max(1.2, Math.min(2 * HALF_W - 1.2, HALF_W - (alliance === BLUE ? p.z : -p.z)));
    const t = fieldToWorld(this.cfg.shooter.passLandFx, fy, alliance);
    const sol = this.solveTo(t.x, FUEL_RADIUS, t.z, () => this.cfg.shooter.passAngle * deg,
      this.cfg.shooter.maxExitSpeed * (this.settings.passPower / 100));
    sol.kind = 'pass';
    return sol;
  }

  solveManual() {
    // fixed hood and speed straight out of the shooter, wherever the robot points
    const sh = this.cfg.shooter;
    const yaw = this.robot.yaw();
    const f = sh.facing;
    const d = this.settings.freeShotDist ?? sh.manualDist;
    const th = this.hoodAngle(d);
    const boost = d > 6 ? this.settings.passPower / 100 : 1;
    const spd = Math.min(Game.speedFor(d, 0.15 - this.exitPoint().y, th), sh.maxExitSpeed * boost);
    return { kind: 'manual', th, spd, ux: f * Math.cos(yaw), uz: -f * Math.sin(yaw), e: this.exitPoint(), ready: true, d };
  }

  /** The spindexer feeds whichever ball in the hopper is nearest the shooter tower. */
  feedBall() {
    // only a ball down at the spindexer (low, against the shooter tower) gets picked up;
    // the agitator pushes the rest of the pile back to it
    const hb = this.cfg.hopper.box;
    let best = null, bx = Infinity;
    this.inside.forEach((b, i) => {
      const [x, y] = this.insideLocal[i];
      if (x < hb.rearX + 0.2 && y < hb.floorY + 0.2 && x < bx) { bx = x; best = b; }
    });
    return best;
  }

  /** Push one FUEL out the front of the robot, low and slow. */
  deload() {
    // the ball nearest the intake goes first
    let best = -1, bx = -Infinity;
    this.insideLocal.forEach((l, i) => { if (l[0] > bx) { bx = l[0]; best = i; } });
    if (best < 0) return;
    const b = this.inside[best];
    const r = this.robot;
    const yaw = r.yaw(), c = Math.cos(yaw), s = Math.sin(yaw);
    const p = r.body.translation();
    const v = r.body.linvel();
    const out = r.halfL + (this.cfg.intakeReach ?? 0.2) + 0.12;
    const side = (Math.random() - 0.5) * 0.3;
    b.inRobot = false;
    this.fuel.enable(b, p.x + c * out + s * side, 0.25, p.z - s * out + c * side, v.x + c * 2.2, 0.6, v.z - s * 2.2);
    b.shot = null;
    this.held--;
    this.inside.splice(best, 1); this.insideLocal.splice(best, 1);
  }

  launch(aim, exit) {
    const b = this.feedBall();
    if (!b) return;
    b.inRobot = false;
    const sh = this.cfg.shooter;
    const e = this.exitPoint(exit);
    const v = this.robot.body.linvel();
    // a little spread so not every shot is perfect
    // Auto aim points the shooter at the HUB; it doesn't make every ball go in. Real shots
    // scatter, and more so on the move.
    const moving = Math.hypot(v.x, v.z);
    const spread = (sh.spreadDeg + moving * 1.5) * deg;
    const yawN = (aim.err ?? 0) + gauss() * spread;
    const thN = aim.th + gauss() * spread * 0.8;
    const spd = aim.spd * (1 + gauss() * (sh.speedNoise + moving * 0.01));
    const cy = Math.cos(yawN), sy = Math.sin(yawN);
    const ux = aim.ux * cy - aim.uz * sy;
    const uz = aim.ux * sy + aim.uz * cy;
    const h = spd * Math.cos(thN);
    this.fuel.enable(b, e.x, e.y, e.z, ux * h + v.x, spd * Math.sin(thN), uz * h + v.z);
    b.shot = { outside: !this.inAllianceZone(), t: this.clock };
    this.held--;
    const k = this.inside.indexOf(b);
    if (k >= 0) { this.inside.splice(k, 1); this.insideLocal.splice(k, 1); }
    this.shots = (this.shots || 0) + 1;
    this.onShot?.();
  }

  // ------------------------------------------------------------ rules
  /** Are the robot's BUMPERS at least partly inside its ALLIANCE ZONE? */
  inAllianceZone() {
    const p = this.robot.body.translation();
    const yaw = this.robot.yaw();
    const reach = Math.abs(Math.cos(yaw)) * this.robot.halfL + Math.abs(Math.sin(yaw)) * this.robot.halfW;
    const line = HALF_L - ALLIANCE_ZONE_DEPTH; // zone boundary, distance from center
    return this.alliance === BLUE ? p.x - reach < -line : p.x + reach > line;
  }

  /** Call a foul on 201: points go to the other alliance, as in the game manual. */
  foul(kind, rule, why) {
    const pts = kind === 'MAJOR' ? 15 : 5;
    const opp = this.alliance === BLUE ? RED : BLUE;
    // counts in free drive too, so practice shows what a foul really costs (not after the final buzzer)
    const live = !this.match?.over;
    if (live) { this.score[opp] += pts; if (this.match) this.match.points[opp] += pts; this.fouls.push({ kind, rule, why, pts }); }
    this.onFoul?.(`${kind} FOUL ${rule}: ${why}${live ? ` (+${pts} ${opp.toUpperCase()})` : ''}`);
  }

  /** A foul by an AI robot on `al`: points to the other alliance. */
  foulBy(al, team, kind, rule, why) {
    const pts = kind === 'MAJOR' ? 15 : 5;
    const opp = al === BLUE ? RED : BLUE;
    if (this.match?.over) return;
    this.score[opp] += pts;
    if (this.match) this.match.points[opp] += pts;
    (this.aiFouls ||= []).push({ al, team, kind, rule, pts, why });
    this.onFoul?.(`${kind} FOUL${rule ? ` ${rule}` : ''} on ${team}: ${why} (+${pts} ${opp.toUpperCase()})`);
  }

  /** TOWER points for an alliance (AI robots that climb). */
  addTower(al, pts) {
    if (this.match?.over) return;
    this.score[al] += pts;
    if (this.match) { this.match.points[al] += pts; this.match.tower[al] += pts; }
  }

  /**
   * FUEL that leaves the field is thrown back in near where it went out, the way FIELD STAFF do
   * it. If 201 shot it out, that's G405 (a MINOR FOUL, MAJOR if it keeps happening).
   */
  returnStrays(dt) {
    this.strayScan = (this.strayScan || 0) + dt;
    if (this.strayScan < 0.25) return;
    const step = this.strayScan;
    this.strayScan = 0;
    for (const b of this.fuel.balls) {
      if (!b.active) continue;
      const q = b.body.translation();
      const out = Math.abs(q.x) > HALF_L + 0.05 || Math.abs(q.z) > HALF_W + 0.05 || q.y < -0.3;
      if (!out) { b.outT = 0; continue; }
      if (!b.outT && b.shot && this.clock - b.shot.t < 6) {
        this.ejected = (this.ejected || 0) + 1;
        this.foul(this.ejected > 1 ? 'MAJOR' : 'MINOR', 'G405', 'FUEL launched out of the field');
        b.shot = null;
      }
      b.outT = (b.outT || 0) + step;
      if (b.outT < 2.5) continue;
      b.outT = 0;
      // toss it back over the wall from about where it went out
      const x = Math.max(-HALF_L + 0.5, Math.min(HALF_L - 0.5, q.x));
      const z = Math.max(-HALF_W + 0.5, Math.min(HALF_W - 0.5, q.z));
      const ix = Math.abs(q.x) > HALF_L ? -Math.sign(q.x) : 0;
      const iz = Math.abs(q.z) > HALF_W ? -Math.sign(q.z) : 0;
      this.fuel.enable(b, x - ix * 0.45, 1.1, z - iz * 0.45, ix * 1.6 + (Math.random() - 0.5) * 0.6, 1.5, iz * 1.6 + (Math.random() - 0.5) * 0.6);
    }
  }

  // ------------------------------------------------------------ scoring
  scoreCheck(dt) {
    const apo = HUB.openingAcross / 2 - FUEL_RADIUS * 0.5;
    for (const al of [BLUE, RED]) {
      const h = hubCenter(al);
      for (const b of this.fuel.balls) {
        if (!b.active) continue;
        const q = b.body.translation();
        if (q.y > 1.7 || q.y < 1.3) continue;
        const dx = q.x - h.x, dz = q.z - h.z;
        // inside the hexagon (checked as its inscribed circle plus the six corners' margin)
        if (Math.hypot(dx, dz) < apo) {
          // G407: launched into your own HUB from outside your ALLIANCE ZONE
          if (b.shot?.outside && al === this.alliance && this.clock - this.lastG407 > 3) {
            this.lastG407 = this.clock;
            this.foul('MAJOR', 'G407', 'scored from outside your ALLIANCE ZONE');
          }
          b.shot = null;
          const counted = this.match ? this.match.scored(al) : true;
          if (counted) this.score[al]++;
          else if (!b.bot) this.missedInactive = (this.missedInactive || 0) + 1;
          this.onScored?.(b, al, counted);
          this.fuel.disable(b);
          b.queued = true;
          this.exitQueue.push({ b, al, t: 0.6 });
        }
      }
    }
    // scored FUEL comes back out of the HUB's NEUTRAL ZONE side
    for (let i = this.exitQueue.length - 1; i >= 0; i--) {
      const q = this.exitQueue[i];
      q.t -= dt;
      if (q.t > 0) continue;
      this.exitQueue.splice(i, 1);
      const h = hubCenter(q.al);
      const toCenter = -Math.sign(h.x);
      this.fuel.enable(q.b, h.x + toCenter * (HUB.size / 2 + 0.12), 0.8, h.z + (Math.random() - 0.5) * 0.8,
        toCenter * (1.5 + Math.random()), 0, (Math.random() - 0.5) * 1.2);
    }
  }

  // ------------------------------------------------------------ FUEL in the hopper
  drawHeld(time) {
    // the FUEL itself is drawn with the rest; just lay the net over it
    this.drawNet(time, this.insideLocal.length);
  }

  /** Lay the net over the hopper: tied at its edges, sagging when slack, pushed up by FUEL, wobbling. */
  drawNet(time, n) {
    const dt = Math.min(0.05, Math.max(0, time - this.lastT));
    this.lastT = time;
    const R = this.cfg.netRig;
    const [NU, NV] = this.netN;
    const pos = this.netMesh.geometry.attributes.position;

    // shake from the robot's acceleration (in its own frame), plus the agitator
    const v = this.robot.body.linvel();
    const yaw = this.robot.yaw();
    let ax = 0, ay = 0, az = 0;
    if (this.lastVel && dt > 0) {
      const dx = (v.x - this.lastVel.x) / dt, dz = (v.z - this.lastVel.z) / dt;
      ay = (v.y - this.lastVel.y) / dt;
      ax = dx * Math.cos(yaw) - dz * Math.sin(yaw);
      az = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    }
    this.lastVel = { x: v.x, y: v.y, z: v.z };
    const w = this.wob;
    const spring = (key, vkey, drive, k, c) => {
      w[vkey] += (-k * w[key] - c * w[vkey] - drive) * dt;
      w[key] += w[vkey] * dt;
      w[key] = Math.max(-0.12, Math.min(0.12, w[key]));
    };
    const agit = this.agitateT > 0 ? Math.sin(time * 20) * 6 : 0;
    spring('y', 'vy', ay * 0.6 + agit, 160, 7);
    spring('x', 'vx', ax * 0.25, 90, 5);
    spring('z', 'vz', az * 0.25, 90, 5);

    // how far the front tie point has slid with the hopper
    const front = R.frontX + (this.robot.intakeNode ? this.robot.intakeNode.position.x - this.robot.intakeBase : 0);
    const len = front - R.rearX;
    const slack = Math.max(0, 1 - len / (R.frontX - R.rearX));
    const sag = 0.035 + slack * 0.16;
    const r = FUEL_RADIUS;
    const held = this.insideLocal;
    for (let i = 0; i < NU; i++) {
      const u = i / (NU - 1);
      for (let k = 0; k < NV; k++) {
        const vv = k / (NV - 1);
        const bell = Math.sin(Math.PI * u) * Math.sin(Math.PI * vv);
        let x, y, z;
        if (this.netBroken) {
          // torn off the front: hanging from the shooter tower, down over the back of the robot
          const s = u * (R.frontX - R.rearX);
          const over = R.rearX + 0.37;
          z = (vv - 0.5) * 2 * R.sideZ * 0.9 + w.z * u * 2;
          if (s < over - R.rearX + 0.02) { x = R.rearX - s; y = R.rearY + 0.01 - s * 0.05; }
          else { x = -over - 0.01 + w.x * u; y = R.rearY - (s - (over - R.rearX + 0.02)) + 0.02; }
          y += w.y * bell;
        } else {
          x = R.rearX + u * len + w.x * bell * 0.6;
          z = (vv - 0.5) * 2 * R.sideZ + w.z * bell * 0.6;
          const edge = R.rearY + (R.frontY - R.rearY) * u;
          const side = R.sideY;
          // edges sit on their tie points; the middle sags, more when the hopper is pulled in
          const tie = edge * (1 - Math.abs(vv - 0.5) * 2 * 0.3) + side * Math.abs(vv - 0.5) * 2 * 0.3;
          y = tie - sag * bell + w.y * bell;
          // FUEL piled high pushes the net up
          for (let j = 0; j < n; j++) {
            const b = held[j];
            const dx = b[0] - x, dz = b[2] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < r * r * 1.4) y = Math.max(y, b[1] + Math.sqrt(Math.max(0, r * r * 1.4 - d2)) * 0.85);
          }
        }
        pos.setXYZ(i * NV + k, x, y, z);
      }
    }
    pos.needsUpdate = true;
  }

  // ------------------------------------------------------------ aim line
  drawAim() {
    const a = this.aim;
    const show = !!a && this.settings.showTrajectory;
    this.aimLine.visible = show;
    if (!show) return;
    const pos = this.aimLine.geometry.attributes.position;
    const v = this.robot.body.linvel();
    const h = a.spd * Math.cos(a.th);
    const vx = a.ux * h + v.x, vz = a.uz * h + v.z, vy = a.spd * Math.sin(a.th);
    const T = Math.max(0.3, (a.d / Math.max(0.1, h)) * 1.05);
    for (let i = 0; i < 40; i++) {
      const t = (i / 39) * T;
      pos.setXYZ(i, a.e.x + vx * t, Math.max(0, a.e.y + vy * t - 0.5 * G * t * t), a.e.z + vz * t);
    }
    pos.needsUpdate = true;
    this.aimLine.computeLineDistances();
    this.aimLine.material.color.set(a.short ? 0xff5a4a : a.ready === false ? 0x9aa6b2 : 0xffd21f);
  }
}
