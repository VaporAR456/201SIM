// The robot's game mechanisms: expanding hopper (the agitator), intake, spindexer feed and
// shooter, plus HUB scoring. Tuning lives in robotConfig.js (hardware) and settings.js (player).
import * as THREE from 'three';
import { IN, HALF_W, HUB, BLUE, RED, fieldToWorld } from './constants.js';
import { FUEL_RADIUS, hubCenter } from './fuel.js';

const G = 9.81;
const deg = Math.PI / 180;

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

    // aim line
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3));
    this.aimLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffd21f, dashSize: 0.15, gapSize: 0.1, transparent: true, opacity: 0.8 }));
    this.aimLine.frustumCulled = false;
    this.aimLine.visible = false;
    scene.add(this.aimLine);
  }

  reset() {
    this.score = { [BLUE]: 0, [RED]: 0 };
    this.shots = 0;
    this.missedInactive = 0;
    this.exitQueue = [];
    this.fuel.reset();
    // preloaded FUEL ride in the robot as a count; those balls stay switched off
    this.held = Math.min(this.cfg.preload, this.settings.capacity);
    this.hopperPos = 0;
  }

  /**
   * Called once per physics step before the robot drives. Returns a turn command that replaces
   * the driver's while auto-aiming, or null.
   */
  update(input, dt, alliance) {
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
    const step = hop.maxSpeedInPerS * dt;
    this.hopperPos += Math.max(-step, Math.min(step, target - this.hopperPos));
    this.robot.setHopper(this.hopperPos, hop.outIn);

    // ---------------------------------------------------------- intake
    if (input.held('intake') && this.hopperPos > hop.outIn - 2 && this.held < this.settings.capacity) {
      this.collect();
    }

    // ---------------------------------------------------------- aiming and shooting
    let turn = null;
    this.aim = null;
    if (input.held('autoShoot')) this.aim = this.solveHub(alliance);
    else if (input.held('autoPass')) this.aim = this.solvePass(alliance);
    else if (input.held('manualShoot')) this.aim = this.solveManual();

    if (this.aim && this.aim.yaw !== undefined) {
      const err = wrap(this.aim.yaw - this.robot.yaw());
      const omega = Math.max(-cfg.maxOmega, Math.min(cfg.maxOmega, 7 * err));
      turn = -omega / (cfg.maxOmega * this.robot.speedScale);
      turn = Math.max(-1, Math.min(1, turn));
      this.aim.ready = Math.abs(err) < 4 * deg;
    }

    this.fireT -= dt;
    this.robot.spinIndexer(shooting && this.held > 0 ? dt : 0);
    if (this.aim && this.aim.ready && this.held > 0 && this.fireT <= 0) {
      this.launch(this.aim);
      this.fireT = 1 / this.settings.fireRate;
    }

    this.scoreCheck(dt);
    return turn;
  }

  // ------------------------------------------------------------ intake
  collect() {
    const r = this.robot;
    const p = r.body.translation();
    const yaw = r.yaw();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const x0 = r.halfL - 0.04;
    const x1 = r.halfL + this.cfg.intakeReach + FUEL_RADIUS;
    const hw = this.cfg.intakeWidth / 2;
    for (const b of this.fuel.balls) {
      if (!b.active) continue;
      const q = b.body.translation();
      if (q.y > 0.35) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (lx > x0 && lx < x1 && Math.abs(lz) < hw) {
        this.fuel.disable(b);
        this.held++;
        if (this.held >= this.settings.capacity) return;
      }
    }
  }

  // ------------------------------------------------------------ ballistics
  exitPoint() {
    const r = this.robot;
    const [ex, ey, ez] = this.cfg.shooter.exit;
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
      // lead the target by where the robot's own motion will carry the ball
      ax = tx - v.x * tof;
      az = tz - v.z * tof;
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
    const th = this.hoodAngle(sh.manualDist);
    const spd = Math.min(Game.speedFor(sh.manualDist, sh.aimHeight - this.exitPoint().y, th), sh.maxExitSpeed);
    return { kind: 'manual', th, spd, ux: f * Math.cos(yaw), uz: -f * Math.sin(yaw), e: this.exitPoint(), ready: true, d: sh.manualDist };
  }

  launch(aim) {
    const b = this.fuel.takeSpare();
    if (!b) return;
    const sh = this.cfg.shooter;
    const e = this.exitPoint();
    const v = this.robot.body.linvel();
    // a little spread so not every shot is perfect
    const yawN = (Math.random() - 0.5) * 2 * sh.spreadDeg * deg;
    const thN = aim.th + (Math.random() - 0.5) * 2 * sh.spreadDeg * deg;
    const spd = aim.spd * (1 + (Math.random() - 0.5) * 2 * sh.speedNoise);
    const cy = Math.cos(yawN), sy = Math.sin(yawN);
    const ux = aim.ux * cy - aim.uz * sy;
    const uz = aim.ux * sy + aim.uz * cy;
    const h = spd * Math.cos(thN);
    this.fuel.enable(b, e.x, e.y, e.z, ux * h + v.x, spd * Math.sin(thN), uz * h + v.z);
    this.held--;
    this.shots = (this.shots || 0) + 1;
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
          if (this.match ? this.match.scored(al) : true) this.score[al]++;
          else this.missedInactive = (this.missedInactive || 0) + 1;
          this.fuel.disable(b);
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
