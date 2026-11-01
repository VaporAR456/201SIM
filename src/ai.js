// AI robots for Play vs AI.
//
// Each AI robot is a real physics body that drives through the same field as you: it pushes FUEL,
// bumps into robots and can get stuck. It picks up FUEL that reaches its intake and launches it
// with a real ballistic shot (with aim error), so nothing scores unless it actually goes in.
//
// The thinking runs in three layers:
//  - Coach (one per alliance, every ~2 s): gives each robot a role and picks the alliance's
//    strategy for the match, learning across matches which strategies work against you.
//  - Brain (each robot, ~8 times a second): scores every action it could take right now
//    (collect, score, stage, defend, unstick) from the match state, its role and its personality,
//    and takes the best, with a little randomness between close options.
//  - Driving (every physics step): A* path on a 25 cm grid of the field, steering along it,
//    keeping clear of other robots, and turning to aim when it shoots.
import * as THREE from 'three';
import { HALF_L, HALF_W, BLUE, RED, HUB, ALLIANCE_ZONE_DEPTH, STATIONS, GROUP, groups, fieldToWorld } from './constants.js';
import { FUEL_RADIUS, hubCenter } from './fuel.js';

const G = 9.81;
const deg = Math.PI / 180;
const other = (a) => (a === BLUE ? RED : BLUE);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

export const AI_LEVELS = {
  // aim = degrees of spread per shot; with the speed noise that's roughly 45% / 65% / 85% in
  Rookie: { react: 0.6, aim: 7, speed: 0.7, fire: 3, think: 0.4, mistakes: 0.25, profile: false },
  District: { react: 0.3, aim: 4.5, speed: 0.85, fire: 4.5, think: 0.25, mistakes: 0.1, profile: false },
  Champs: { react: 0.12, aim: 2.6, speed: 1, fire: 6, think: 0.15, mistakes: 0.03, profile: true },
};

const TYPES = {
  Shooter: { cap: 40, fire: 1.2, range: [2.4, 4.4], speed: 4.3, intake: 8, aggression: 0.15, mass: 60 },
  Feeder: { cap: 30, fire: 0.8, range: [1.8, 3.0], speed: 4.8, intake: 12, aggression: 0.25, mass: 55 },
  Defender: { cap: 18, fire: 0.8, range: [1.8, 2.8], speed: 4.9, intake: 7, aggression: 0.85, mass: 68 },
  Climber: { cap: 25, fire: 1, range: [2.0, 3.4], speed: 4.0, intake: 8, aggression: 0.2, mass: 62 },
};
const TYPE_NAMES = Object.keys(TYPES);
const STRATEGIES = ['race', 'deny', 'hoard', 'balanced'];

// ------------------------------------------------------------ across-match memory
const MEM_KEY = '201sim.aiMemory.v1';
function loadMemory() {
  try { return JSON.parse(localStorage.getItem(MEM_KEY)) || null; } catch { return null; }
}
function saveMemory(m) {
  try { localStorage.setItem(MEM_KEY, JSON.stringify(m)); } catch { /* not saved */ }
}
export function resetAiMemory() { try { localStorage.removeItem(MEM_KEY); } catch { /* nothing */ } }
function freshMemory() {
  return { matches: 0, you: { side: 0, cycle: 0, score: 0 }, strat: Object.fromEntries(STRATEGIES.map((s) => [s, { a: 1, b: 1 }])), level: 1 };
}
// Thompson sampling: draw from each strategy's Beta(wins+1, losses+1) and take the best draw
function betaSample(a, b) {
  const g = (k) => { let x = 0; for (let i = 0; i < 12; i++) x += Math.random(); x -= 6; return Math.max(0.001, k + Math.sqrt(k) * x); };
  const x = g(a), y = g(b);
  return x / (x + y);
}

// ------------------------------------------------------------ navigation grid
class NavGrid {
  constructor(RAPIER, world, exclude) {
    this.cell = 0.25;
    this.nx = Math.ceil((2 * HALF_L) / this.cell);
    this.nz = Math.ceil((2 * HALF_W) / this.cell);
    this.block = new Uint8Array(this.nx * this.nz);
    const shape = new RAPIER.Cuboid(0.46, 0.2, 0.46);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    const filter = groups(0xffff, GROUP.FIELD | GROUP.TERRAIN);
    for (let i = 0; i < this.nx; i++) {
      for (let k = 0; k < this.nz; k++) {
        const { x, z } = this.center(i, k);
        const edge = Math.abs(x) > HALF_L - 0.48 || Math.abs(z) > HALF_W - 0.48;
        const hit = edge || !!world.intersectionWithShape({ x, y: 0.26, z }, rot, shape, undefined, filter, undefined, exclude);
        this.block[i * this.nz + k] = hit ? 1 : 0;
      }
    }
  }

  center(i, k) { return { x: -HALF_L + (i + 0.5) * this.cell, z: -HALF_W + (k + 0.5) * this.cell }; }
  idx(x, z) {
    return [clamp(Math.floor((x + HALF_L) / this.cell), 0, this.nx - 1), clamp(Math.floor((z + HALF_W) / this.cell), 0, this.nz - 1)];
  }
  free(i, k) { return i >= 0 && k >= 0 && i < this.nx && k < this.nz && !this.block[i * this.nz + k]; }

  /** Nearest free cell to (i, k). */
  nearestFree(i, k) {
    if (this.free(i, k)) return [i, k];
    for (let r = 1; r < 12; r++) {
      for (let a = -r; a <= r; a++) {
        for (const [di, dk] of [[a, -r], [a, r], [-r, a], [r, a]]) if (this.free(i + di, k + dk)) return [i + di, k + dk];
      }
    }
    return [i, k];
  }

  lineFree(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.ceil(d / (this.cell * 0.5));
    for (let s = 1; s < n; s++) {
      const [i, k] = this.idx(x0 + ((x1 - x0) * s) / n, z0 + ((z1 - z0) * s) / n);
      if (!this.free(i, k)) return false;
    }
    return true;
  }

  /** A* from a to b (world x/z); returns smoothed waypoints, or null. */
  path(ax, az, bx, bz) {
    const [si, sk] = this.nearestFree(...this.idx(ax, az));
    const [gi, gk] = this.nearestFree(...this.idx(bx, bz));
    const N = this.nx * this.nz;
    const start = si * this.nz + sk, goal = gi * this.nz + gk;
    const gScore = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = [start];
    const f = new Float32Array(N).fill(Infinity);
    const h = (n) => { const di = Math.abs(((n / this.nz) | 0) - gi), dk = Math.abs((n % this.nz) - gk); return Math.max(di, dk) + 0.414 * Math.min(di, dk); };
    gScore[start] = 0; f[start] = h(start);
    let iter = 0;
    while (open.length && iter++ < 6000) {
      let bi = 0;
      for (let j = 1; j < open.length; j++) if (f[open[j]] < f[open[bi]]) bi = j;
      const cur = open[bi];
      open[bi] = open[open.length - 1]; open.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const ci = (cur / this.nz) | 0, ck = cur % this.nz;
      for (let di = -1; di <= 1; di++) {
        for (let dk = -1; dk <= 1; dk++) {
          if (!di && !dk) continue;
          const ni = ci + di, nk = ck + dk;
          if (!this.free(ni, nk)) continue;
          if (di && dk && (!this.free(ci + di, ck) || !this.free(ci, ck + dk))) continue;
          const n = ni * this.nz + nk;
          const g = gScore[cur] + (di && dk ? 1.414 : 1);
          if (g < gScore[n]) { gScore[n] = g; from[n] = cur; f[n] = g + h(n); open.push(n); }
        }
      }
    }
    if (from[goal] < 0 && goal !== start) return null;
    const cells = [];
    for (let n = goal; n >= 0 && n !== start; n = from[n]) cells.push(n);
    cells.reverse();
    const pts = cells.map((n) => this.center((n / this.nz) | 0, n % this.nz));
    pts.push({ x: bx, z: bz });
    // string-pull: skip waypoints we can see past
    const out = [];
    let ox = ax, oz = az, j = 0;
    while (j < pts.length) {
      let far = j;
      for (let t = pts.length - 1; t > j; t--) if (this.lineFree(ox, oz, pts[t].x, pts[t].z)) { far = t; break; }
      out.push(pts[far]);
      ox = pts[far].x; oz = pts[far].z;
      j = far + 1;
    }
    return out;
  }
}

// ------------------------------------------------------------ the robot body and model
function numberTexture(text, bg) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = bg; x.fillRect(0, 0, 512, 128);
  x.fillStyle = '#fff'; x.font = '900 104px system-ui, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(text, 256, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

class Bot {
  constructor(scene, RAPIER, world, alliance, team, typeName, level, pers) {
    this.alliance = alliance;
    this.team = team;
    this.typeName = typeName;
    this.type = TYPES[typeName];
    this.level = level;
    this.p = pers;
    this.halfL = 0.43; this.halfW = 0.43;
    this.load = 0;
    this.scored = 0;
    this.shots = 0;
    this.task = { kind: 'idle' };
    this.path = null;
    this.fireT = 0;
    this.thinkT = Math.random() * 0.3;
    this.stuckT = 0;
    this.lastPos = { x: 0, z: 0 };
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().enabledRotations(false, true, false).setCanSleep(false));
    const part = (hx, hy, hz, y, density) => world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(0, y, 0)
      .setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min).setRestitution(0.05).setDensity(density), body);
    part(this.halfL, 0.09, this.halfW, 0.1, 1); // bumpers
    part(this.halfL - 0.08, 0.17, this.halfW - 0.08, 0.36, 0.3); // frame and mechanisms (under the TRENCH arm)
    const m = body.mass();
    for (let i = 0; i < body.numColliders(); i++) { const c = body.collider(i); c.setDensity(c.density() * (this.type.mass / m)); }
    this.body = body;

    // model: bumpers with the team number, a frame, a hopper and a shooter hood
    const col = alliance === BLUE ? 0x1f6fff : 0xe8322f;
    const g = new THREE.Group();
    const bump = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
    const num = new THREE.MeshStandardMaterial({ map: numberTexture(String(team), alliance === BLUE ? '#1f6fff' : '#e8322f'), roughness: 0.85 });
    const geo = new THREE.BoxGeometry(this.halfL * 2, 0.13, this.halfW * 2);
    const bm = new THREE.Mesh(geo, [num, num, bump, bump, num, num]);
    bm.position.y = 0.1; bm.castShadow = true; g.add(bm);
    const metal = new THREE.MeshStandardMaterial({ color: [0x3a3f46, 0x5b6068, 0x2c2f33, 0x6b6f75][team % 4], metalness: 0.6, roughness: 0.45 });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(this.halfL * 2 - 0.12, 0.08, this.halfW * 2 - 0.12), metal);
    frame.position.y = 0.2; g.add(frame);
    const hop = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.26, 0.62), new THREE.MeshStandardMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.28, roughness: 0.1 }));
    hop.position.set(0.05, 0.37, 0); g.add(hop);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.34, 0.5), metal);
    tower.position.set(-0.28, 0.41, 0); tower.castShadow = true; g.add(tower);
    const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.46, 12), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 }));
    hood.rotation.x = Math.PI / 2; hood.position.set(-0.2, 0.55, 0); g.add(hood);
    const intake = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.7), new THREE.MeshStandardMaterial({ color: 0x2b8a3e, roughness: 0.7 }));
    intake.position.set(this.halfL + 0.04, 0.08, 0); g.add(intake);
    // FUEL you can see in the hopper
    this.fuelVis = new THREE.InstancedMesh(new THREE.SphereGeometry(FUEL_RADIUS, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffd21f, roughness: 0.75 }), 12);
    this.fuelVis.count = 0; g.add(this.fuelVis);
    const mtx = new THREE.Matrix4();
    for (let i = 0; i < 12; i++) { mtx.makeTranslation(-0.12 + (i % 3) * 0.15, 0.3 + Math.floor(i / 6) * 0.12, -0.2 + (Math.floor(i / 3) % 2) * 0.16 + (i >= 6 ? 0.08 : 0)); this.fuelVis.setMatrixAt(i, mtx); }
    scene.add(g);
    this.root = g;
    this.prev = new THREE.Vector3(); this.cur = new THREE.Vector3(); this.prevYaw = 0; this.curYaw = 0;
  }

  pos() { return this.body.translation(); }
  yaw() { const q = this.body.rotation(); return 2 * Math.atan2(q.y, q.w); }

  reset(x, z, yaw) {
    this.body.setTranslation({ x, y: 0.02, z }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.cur.set(x, 0, z); this.prev.copy(this.cur); this.curYaw = this.prevYaw = yaw;
    this.path = null; this.task = { kind: 'idle' }; this.stuckT = 0;
  }

  /** Chassis velocity command (world frame), with acceleration limits like a real swerve. */
  drive(vx, vz, omega, dt) {
    const lv = this.body.linvel();
    const max = this.type.speed * this.level.speed * this.p.speed;
    const s = Math.hypot(vx, vz);
    if (s > max) { vx *= max / s; vz *= max / s; }
    let ex = vx - lv.x, ez = vz - lv.z;
    const e = Math.hypot(ex, ez), a = 11 * dt;
    if (e > a) { ex *= a / e; ez *= a / e; }
    const w = this.body.angvel().y;
    const om = w + clamp(omega - w, -30 * dt, 30 * dt);
    this.body.setLinvel({ x: lv.x + ex, y: Math.min(lv.y, 0.3), z: lv.z + ez }, true);
    this.body.setAngvel({ x: 0, y: clamp(om, -9, 9), z: 0 }, true);
  }

  snapshot() {
    const p = this.pos();
    this.prev.copy(this.cur); this.prevYaw = this.curYaw;
    this.cur.set(p.x, p.y, p.z); this.curYaw = this.yaw();
  }

  sync(alpha) {
    this.root.position.lerpVectors(this.prev, this.cur, alpha);
    this.root.rotation.y = this.prevYaw + wrap(this.curYaw - this.prevYaw) * alpha;
    this.fuelVis.count = Math.min(12, Math.ceil(this.load / Math.max(1, this.type.cap / 12)));
  }
}

// ------------------------------------------------------------ the whole AI side of a match
export class AIPlayers {
  constructor(scene, RAPIER, world, fuel) {
    this.scene = scene; this.RAPIER = RAPIER; this.world = world; this.fuel = fuel;
    this.bots = [];
    this.nav = null;
    this.mem = loadMemory() || freshMemory();
    this.you = { lastPos: null, sideT: 0, scoreT: [], carryingSide: 0 };
  }

  forget() { this.mem = freshMemory(); }

  /** Build the field map once the field exists (robot excluded, it moves). */
  buildNav(excludeBody) { this.world.updateSceneQueries(); this.nav = new NavGrid(this.RAPIER, this.world, excludeBody); }

  clear() {
    for (const b of this.bots) { this.world.removeRigidBody(b.body); this.scene.remove(b.root); }
    this.bots = [];
  }

  /**
   * Set up a match: `mine` robots on your alliance (counting 201) and `theirs` on the other,
   * at a difficulty. A seed makes the same personalities come back.
   */
  setup({ alliance, station, mine, theirs, level, seed }) {
    this.clear();
    if (!this.nav) return;
    this.alliance = alliance;
    let r = seed ? Number(seed) || [...String(seed)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) : Math.floor(Math.random() * 1e9);
    this.seed = r;
    const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    let lv = AI_LEVELS[level] || AI_LEVELS.District;
    if (level === 'Adaptive') {
      // 0 = Rookie .. 2 = Champs, moved after every match toward close games
      const t = clamp(this.mem.level ?? 1, 0, 2);
      const A = AI_LEVELS.Rookie, B = AI_LEVELS.District, C = AI_LEVELS.Champs;
      const mix = (k) => (t < 1 ? A[k] + (B[k] - A[k]) * t : B[k] + (C[k] - B[k]) * (t - 1));
      lv = { react: mix('react'), aim: mix('aim'), speed: mix('speed'), fire: mix('fire'), think: mix('think'), mistakes: mix('mistakes'), profile: t > 1.4 };
    }
    this.levelName = level;
    this.lv = lv;
    const used = new Set([201]);
    const team = () => { let n; do n = 100 + Math.floor(rand() * 11400); while (used.has(n)); used.add(n); return n; };
    const add = (al, slot) => {
      const typeName = TYPE_NAMES[Math.floor(rand() * TYPE_NAMES.length)];
      const pers = {
        aggression: clamp(TYPES[typeName].aggression + (rand() - 0.5) * 0.5, 0, 1),
        risk: rand(),
        patience: 0.3 + rand() * 0.6, // how full before going to score
        side: rand() < 0.5 ? -1 : 1, // favorite side of the field
        speed: 0.9 + rand() * 0.15,
        range: TYPES[typeName].range[0] + rand() * (TYPES[typeName].range[1] - TYPES[typeName].range[0]),
        jitter: 0.15 + rand() * 0.25,
      };
      const b = new Bot(this.scene, this.RAPIER, this.world, al, team(), typeName, lv, pers);
      b.slot = slot;
      this.bots.push(b);
    };
    // your teammates take the other driver stations; the opponents line up across the field
    const free = [0, 1, 2].filter((s) => s !== station);
    for (let i = 0; i < mine - 1; i++) add(alliance, free[i]);
    for (let i = 0; i < theirs; i++) add(other(alliance), i);
    // each alliance's coach picks a strategy: the opponents learn which ones beat you
    this.coach = {};
    for (const al of [BLUE, RED]) {
      const vsYou = al !== alliance;
      let strat = STRATEGIES[Math.floor(rand() * STRATEGIES.length)];
      if (vsYou) {
        let best = -1;
        for (const s of STRATEGIES) { const st = this.mem.strat[s]; const v = betaSample(st.a, st.b); if (v > best) { best = v; strat = s; } }
      }
      this.coach[al] = { strat, t: 0 };
    }
    this.you = { lastPos: null, sideT: [0, 0], shots: 0, scored: 0, inNeutralT: 0, carryT: 0 };
    this.reset();
  }

  /** Back to the starting spots with the preload. */
  reset() {
    for (const b of this.bots) {
      const p = fieldToWorld(0.95, STATIONS[b.slot].fy, b.alliance);
      const p2 = fieldToWorld(ALLIANCE_ZONE_DEPTH - 0.6, STATIONS[b.slot].fy, b.alliance);
      b.reset(p2.x, p2.z, Math.atan2(-(p2.z - p.z), p2.x - p.x));
      b.load = 8; b.scored = 0; b.shots = 0; b.fireT = 0;
      b.thinkT = Math.random() * 0.3;
    }
    for (const al of [BLUE, RED]) if (this.coach?.[al]) this.coach[al].t = 0;
  }

  get teams() {
    return {
      [BLUE]: this.bots.filter((b) => b.alliance === BLUE).map((b) => b.team),
      [RED]: this.bots.filter((b) => b.alliance === RED).map((b) => b.team),
    };
  }

  // ---------------------------------------------------------- reading the match
  /** Everything a robot needs to decide: your robot, the clock, the HUBs. */
  context(robot, match) {
    const on = match?.on;
    const ph = on ? match.phase() : { name: 'FREE', left: 99 };
    return {
      robot,
      match,
      active: (al) => (on ? match.isActive(al) : true),
      // seconds until this alliance's HUB is active again (0 if active now)
      untilActive: (al) => {
        if (!on) return 0;
        if (match.isActive(al)) return 0;
        return ph.left;
      },
      timeLeft: on ? (match.over ? 0 : match.teleopLeft() + (ph.name === 'AUTO' ? ph.left + 3 : 0)) : 999,
      endgame: on && ph.name === 'END GAME',
    };
  }

  /** Watch how you drive, so the AI can play against it. */
  watchYou(robot, game, dt) {
    const p = robot.body.translation();
    const y = this.you;
    // which side of the field you favor when you cross the middle
    if (Math.abs(p.x) < HALF_L - ALLIANCE_ZONE_DEPTH) {
      y.sideT[p.z < 0 ? 0 : 1] += dt;
      y.inNeutralT += dt;
    }
    if (game.held > 4) y.carryT += dt;
    y.shots = game.shots;
  }

  /** How dangerous you are right now: scoring rate and FUEL on board. */
  yourThreat(game, match) {
    const t = match?.on ? Math.max(20, match.t) : 60;
    return (game.score[this.alliance] / t) * 60 + game.held * 0.6;
  }

  // ---------------------------------------------------------- every physics step
  step(dt, robot, game, match) {
    if (!this.bots.length) return;
    const ctx = this.context(robot, match);
    this.watchYou(robot, game, dt);
    const disabled = match?.disabled;
    for (const al of [BLUE, RED]) this.coachThink(al, ctx, game, dt);
    for (const b of this.bots) {
      if (disabled) { b.drive(0, 0, 0, dt); continue; }
      this.collect(b);
      b.thinkT -= dt;
      if (b.thinkT <= 0) {
        b.thinkT = this.lv.think * (0.8 + Math.random() * 0.4);
        this.think(b, ctx, game);
      }
      this.act(b, ctx, game, dt);
    }
  }

  snapshot() { for (const b of this.bots) b.snapshot(); }
  sync(alpha) { for (const b of this.bots) b.sync(alpha); }

  // ---------------------------------------------------------- coach: roles and strategy
  coachThink(al, ctx, game, dt) {
    const c = this.coach?.[al];
    if (!c) return;
    c.t -= dt;
    if (c.t > 0) return;
    c.t = 2;
    const mine = this.bots.filter((b) => b.alliance === al);
    if (!mine.length) return;
    const opp = other(al);
    const diff = (game.score[al] ?? 0) - (game.score[opp] ?? 0);
    const youThreat = al !== this.alliance ? this.yourThreat(game, ctx.match) : 0;
    const oppBots = this.bots.filter((b) => b.alliance === opp);
    // pick at most one defender, and only when it pays: the opponent is out-scoring, our HUB is
    // off, or the strategy says to deny
    let defender = null;
    const wantDefense = c.strat === 'deny' || (c.strat === 'balanced' && (diff < -6 || youThreat > 25)) || (!ctx.active(al) && c.strat !== 'race');
    if (wantDefense && (mine.length > 1 || c.strat === 'deny' || !ctx.active(al))) {
      defender = mine.reduce((a, b) => (b.p.aggression - b.load * 0.02 > a.p.aggression - a.load * 0.02 ? b : a));
      if (defender.p.aggression < 0.35 && c.strat !== 'deny') defender = null;
    }
    // who to guard: the biggest threat on the other alliance (you, or one of their AI)
    let target = null, best = -1;
    if (al !== this.alliance) { target = { you: true }; best = youThreat; }
    for (const ob of oppBots) { const t = ob.scored * 1.2 + ob.load * 0.5; if (t > best) { best = t; target = { bot: ob }; } }
    for (const b of mine) {
      b.role = b === defender ? 'defend' : 'score';
      b.guard = b === defender ? target : null;
    }
  }

  // ---------------------------------------------------------- brain: pick a task
  think(b, ctx, game) {
    const p = b.pos();
    const al = b.alliance;
    const lv = this.lv;
    const strat = this.coach[al].strat;
    const full = b.load / b.type.cap;
    const active = ctx.active(al);
    const soon = ctx.untilActive(al);
    const options = [];
    // score: worth more the fuller we are, and only when our HUB counts (or will by the time we get there)
    if (b.load > 0) {
      const hub = hubCenter(al);
      const travel = Math.hypot(p.x - hub.x, p.z - hub.z) / b.type.speed;
      const ready = active || soon < travel + 1;
      let u = (full >= b.p.patience || (b.load > 3 && ctx.timeLeft < 15)) ? 1.2 : full * 0.9;
      if (strat === 'hoard' && !active) u *= 0.3;
      if (strat === 'race') u *= 1.15;
      options.push({ kind: ready ? 'score' : 'stage', u: ready ? u : u * 0.55 });
    }
    // collect: worth more the emptier we are
    if (b.load < b.type.cap) {
      let u = (1 - full) * 0.95;
      if (!active && strat === 'hoard') u *= 1.3;
      options.push({ kind: 'collect', u });
    }
    // defend: the coach's call, weighed by personality
    if (b.role === 'defend' && b.guard) options.push({ kind: 'defend', u: 0.7 + b.p.aggression * 0.6 - full * 0.3 });
    // a little randomness between close calls, more for less patient personalities
    for (const o of options) o.u += (Math.random() - 0.5) * b.p.jitter;
    // stick with the current task a bit, so it doesn't flip-flop
    for (const o of options) if (o.kind === b.task.kind) o.u += 0.12;
    options.sort((x, y) => y.u - x.u);
    let pick = options[0]?.kind ?? 'collect';
    // the occasional mistake: a worse option
    if (options.length > 1 && Math.random() < lv.mistakes * 0.3) pick = options[1].kind;
    if (b.stuckT > 1.2) pick = 'unstick';
    if (pick !== b.task.kind || this.taskStale(b)) this.startTask(b, pick, ctx, game);
  }

  taskStale(b) {
    const t = b.task;
    if (t.kind === 'collect') return !t.ball || !t.ball.active || t.ball.inRobot || t.ball.body.translation().y > 0.3;
    return false;
  }

  startTask(b, kind, ctx, game) {
    const p = b.pos();
    const al = b.alliance;
    b.task = { kind, t: 0 };
    if (kind === 'collect') {
      const ball = this.pickBall(b);
      if (!ball) { b.task = { kind: 'stage', t: 0 }; return this.startTask(b, 'stage', ctx, game); }
      b.task.ball = ball;
      const q = ball.body.translation();
      this.plan(b, q.x, q.z);
    } else if (kind === 'score' || kind === 'stage') {
      const spot = this.shotSpot(b);
      b.task.spot = spot;
      this.plan(b, spot.x, spot.z);
    } else if (kind === 'defend') {
      b.task.replan = 0;
    } else if (kind === 'unstick') {
      const a = Math.random() * Math.PI * 2;
      b.task.dir = { x: Math.cos(a), z: Math.sin(a) };
      b.task.until = 0.7;
      b.path = null;
      b.stuckT = 0;
    }
    void p;
  }

  /** Choose a FUEL to go get: close, in a cluster, on our favorite side, not chased by a teammate. */
  pickBall(b) {
    const p = b.pos();
    const al = b.alliance;
    const sign = al === BLUE ? -1 : 1;
    const balls = this.fuel.balls;
    const claimed = new Set(this.bots.filter((o) => o !== b && o.task.ball).map((o) => o.task.ball));
    let best = null, bs = Infinity;
    for (let n = 0; n < 160; n++) {
      const ball = balls[(Math.random() * balls.length) | 0];
      if (!ball.active || ball.inRobot || claimed.has(ball)) continue;
      const q = ball.body.translation();
      if (q.y > 0.2 || Math.abs(q.x) > HALF_L - 0.3 || Math.abs(q.z) > HALF_W - 0.3) continue;
      // stay out of the other alliance's zone
      if (-sign * q.x > HALF_L - ALLIANCE_ZONE_DEPTH) continue;
      const [i, k] = this.nav.idx(q.x, q.z);
      if (!this.nav.free(i, k)) continue;
      let s = Math.hypot(q.x - p.x, q.z - p.z);
      s += (Math.sign(q.z) === b.p.side * (al === BLUE ? 1 : -1) ? -0.6 : 0.6) * (1 - b.p.risk * 0.5);
      for (const o of this.bots) if (o !== b && o.task.ball) { const t = o.task.ball.body.translation(); if (Math.hypot(t.x - q.x, t.z - q.z) < 1.5) s += 1.2; }
      if (s < bs) { bs = s; best = ball; }
    }
    return best;
  }

  /** A place to shoot from: inside our ALLIANCE ZONE, at our preferred range, away from other robots. */
  shotSpot(b) {
    const al = b.alliance;
    const hub = hubCenter(al);
    const toWall = al === BLUE ? -1 : 1;
    let best = null, bs = Infinity;
    for (let n = 0; n < 14; n++) {
      const ang = (b.p.side * (al === BLUE ? 1 : -1)) * (0.2 + Math.random() * 0.9) * (Math.random() < 0.75 ? 1 : -1);
      const r = b.p.range + (Math.random() - 0.5) * 0.5;
      const x = hub.x + toWall * Math.cos(ang) * r, z = hub.z + Math.sin(ang) * r;
      if (toWall * x < HALF_L - ALLIANCE_ZONE_DEPTH + 0.5) continue; // must be in the zone
      const [i, k] = this.nav.idx(x, z);
      if (!this.nav.free(i, k)) continue;
      let s = Math.hypot(x - b.pos().x, z - b.pos().z) * 0.3;
      for (const o of this.bots) if (o !== b && o.task.spot) s += Math.max(0, 2 - Math.hypot(o.task.spot.x - x, o.task.spot.z - z)) * 3;
      if (s < bs) { bs = s; best = { x, z }; }
    }
    return best || { x: hub.x + toWall * 2.5, z: hub.z };
  }

  plan(b, x, z) {
    const p = b.pos();
    b.path = this.nav.path(p.x, p.z, x, z);
    b.goal = { x, z };
  }

  // ---------------------------------------------------------- doing the task
  act(b, ctx, game, dt) {
    const p = b.pos();
    const t = b.task;
    t.t = (t.t || 0) + dt;
    let face = null; // heading to hold
    let arrive = false;
    let tx = null, tz = null;
    if (t.kind === 'collect' && t.ball) {
      const q = t.ball.body.translation();
      // the ball rolled: aim at where it is now, replanning now and then
      if (b.goal && Math.hypot(q.x - b.goal.x, q.z - b.goal.z) > 0.6) this.plan(b, q.x, q.z);
      face = Math.atan2(-(q.z - p.z), q.x - p.x);
      if (Math.hypot(q.x - p.x, q.z - p.z) < 1.2) { tx = q.x; tz = q.z; }
      if (t.t > 7) b.thinkT = 0, t.ball = null;
    } else if ((t.kind === 'score' || t.kind === 'stage') && t.spot) {
      arrive = true;
      const hub = hubCenter(b.alliance);
      const d = Math.hypot(p.x - t.spot.x, p.z - t.spot.z);
      if (d < 1.4) face = Math.atan2(-(hub.z - p.z), hub.x - p.x);
      if (t.kind === 'score' && d < 0.6) this.shoot(b, ctx, game, dt);
    } else if (t.kind === 'defend') {
      const g = b.guard;
      let gp = null;
      if (g?.you) gp = ctx.robot.body.translation();
      else if (g?.bot) gp = g.bot.pos();
      if (gp) {
        // get between them and their HUB, leaning on them
        const hub = hubCenter(other(b.alliance));
        const dx = hub.x - gp.x, dz = hub.z - gp.z, d = Math.hypot(dx, dz) || 1;
        const lead = Math.min(1.1, d * 0.4);
        tx = gp.x + (dx / d) * lead; tz = gp.z + (dz / d) * lead;
        // don't follow them into their own ALLIANCE ZONE for long (protected), and never the HUB
        const sign = b.alliance === BLUE ? 1 : -1;
        if (sign * tx > HALF_L - ALLIANCE_ZONE_DEPTH - 0.4) tx = sign * (HALF_L - ALLIANCE_ZONE_DEPTH - 0.4);
        face = Math.atan2(-(gp.z - p.z), gp.x - p.x);
        t.replan -= dt;
        if (t.replan <= 0) { t.replan = 0.6; this.plan(b, tx, tz); }
        if (b.path && Math.hypot(tx - p.x, tz - p.z) < 1.5) b.path = null;
      }
    } else if (t.kind === 'unstick') {
      b.drive(t.dir.x * 2, t.dir.z * 2, 0, dt);
      t.until -= dt;
      if (t.until <= 0) b.thinkT = 0, b.task = { kind: 'idle' };
      return;
    }

    // follow the path, or go straight at a close target
    let vx = 0, vz = 0;
    const speed = b.type.speed;
    if (tx !== null && (!b.path || !b.path.length)) {
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz) || 1;
      const s = Math.min(speed, d * 3 + 0.8);
      vx = (dx / d) * s; vz = (dz / d) * s;
    } else if (b.path && b.path.length) {
      let wp = b.path[0];
      while (b.path.length > 1 && Math.hypot(wp.x - p.x, wp.z - p.z) < 0.45) { b.path.shift(); wp = b.path[0]; }
      const dx = wp.x - p.x, dz = wp.z - p.z, d = Math.hypot(dx, dz) || 1;
      const last = b.path.length === 1;
      if (last && d < 0.12) b.path.shift();
      const s = last && arrive ? Math.min(speed, d * 2.4) : speed;
      vx = (dx / d) * s; vz = (dz / d) * s;
      if (face === null && d > 0.3) face = Math.atan2(-dz, dx);
    }
    // keep clear of other robots (and you), unless we're defending
    if (t.kind !== 'defend') {
      const others = [...this.bots.filter((o) => o !== b).map((o) => o.pos()), ctx.robot.body.translation()];
      for (const o of others) {
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        if (d < 1.5 && d > 0.01) { const k = (1.5 - d) * 2.2; vx += (dx / d) * k; vz += (dz / d) * k; }
      }
    }
    // reaction delay: the command catches up over the level's reaction time
    const kr = 1 - Math.exp(-dt / Math.max(0.05, this.lv.react * 0.5));
    b.cmdX = (b.cmdX ?? 0) + (vx - (b.cmdX ?? 0)) * kr;
    b.cmdZ = (b.cmdZ ?? 0) + (vz - (b.cmdZ ?? 0)) * kr;
    let om = 0;
    if (face !== null) om = clamp(wrap(face - b.yaw()) * 6, -7, 7);
    b.drive(b.cmdX, b.cmdZ, om, dt);

    // stuck? (trying to move but not getting anywhere)
    const lv = b.body.linvel();
    const want = Math.hypot(b.cmdX, b.cmdZ);
    if (want > 1 && Math.hypot(lv.x, lv.z) < 0.25) b.stuckT += dt; else b.stuckT = Math.max(0, b.stuckT - dt * 2);
    if (b.stuckT > 1.2) b.thinkT = 0;
  }

  /** FUEL that reaches the intake goes in the hopper. */
  collect(b) {
    if (b.load >= b.type.cap) return;
    const p = b.pos();
    const y = b.yaw(), c = Math.cos(y), s = Math.sin(y);
    // only look at nearby balls: cheap check first
    for (const ball of this.fuel.balls) {
      if (!ball.active || ball.inRobot) continue;
      const q = ball.body.translation();
      const dx = q.x - p.x, dz = q.z - p.z;
      if (dx * dx + dz * dz > 0.64 || q.y > 0.25) continue;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (lx > b.halfL - 0.08 && lx < b.halfL + 0.22 && Math.abs(lz) < 0.36) {
        this.fuel.disable(ball);
        b.load++;
        if (b.load >= b.type.cap) return;
      }
    }
  }

  /** Fire one FUEL at the HUB when aimed, with this robot's aim error. */
  shoot(b, ctx, game, dt) {
    b.fireT -= dt;
    if (b.load <= 0 || b.fireT > 0 || !ctx.active(b.alliance)) return;
    const p = b.pos();
    const hub = hubCenter(b.alliance);
    const want = Math.atan2(-(hub.z - p.z), hub.x - p.x);
    if (Math.abs(wrap(want - b.yaw())) > 8 * deg) return;
    const ball = this.fuel.takeSpare();
    if (!ball) return;
    b.fireT = 1 / (this.lv.fire * b.type.fire * (0.85 + Math.random() * 0.3));
    b.load--;
    b.shots++;
    const ex = p.x + Math.cos(b.yaw()) * -0.15, ez = p.z - Math.sin(b.yaw()) * -0.15, ey = 0.62;
    const dx = hub.x - ex, dz = hub.z - ez;
    const d = Math.hypot(dx, dz);
    const th = (58 + d * 2) * deg;
    const h = 1.95 - ey;
    const den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) - h);
    if (den <= 0) return;
    let v = Math.sqrt((G * d * d) / den);
    const err = this.lv.aim * deg;
    const yawN = gauss() * err;
    v *= 1 + gauss() * (0.02 + this.lv.aim * 0.006);
    const cy = Math.cos(yawN), sy = Math.sin(yawN);
    const ux = (dx / d) * cy - (dz / d) * sy, uz = (dx / d) * sy + (dz / d) * cy;
    const thN = th + gauss() * err * 0.6;
    const hv = v * Math.cos(thN);
    this.fuel.enable(ball, ex, ey, ez, ux * hv, v * Math.sin(thN), uz * hv);
    ball.shot = null;
    ball.bot = b;
  }

  /** A FUEL went into a HUB: credit the robot that shot it. */
  credit(ball, counted) {
    if (ball.bot && counted) ball.bot.scored++;
    ball.bot = null;
  }

  // ---------------------------------------------------------- after the match: learn
  matchOver(game) {
    if (!this.bots.length) return;
    const opp = other(this.alliance);
    const theirs = game.score[opp], yours = game.score[this.alliance];
    const won = theirs > yours;
    const st = this.mem.strat[this.coach[opp].strat];
    if (won) st.a += 1; else st.b += 1;
    // forget slowly, so it keeps adapting if you change how you play
    for (const s of STRATEGIES) { this.mem.strat[s].a = 1 + (this.mem.strat[s].a - 1) * 0.9; this.mem.strat[s].b = 1 + (this.mem.strat[s].b - 1) * 0.9; }
    // Adaptive difficulty: toward close matches
    const margin = yours - theirs;
    this.mem.level = clamp((this.mem.level ?? 1) + clamp(margin / 40, -0.5, 0.5), 0, 2);
    const y = this.you;
    const side = y.sideT[1] - y.sideT[0];
    this.mem.you.side = this.mem.you.side * 0.7 + Math.sign(side) * 0.3;
    this.mem.you.score = this.mem.you.score * 0.7 + yours * 0.3;
    this.mem.matches++;
    saveMemory(this.mem);
  }
}
