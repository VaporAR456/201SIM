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
import { HALF_L, HALF_W, BLUE, RED, HUB, ALLIANCE_ZONE_DEPTH, STATIONS, GROUP, groups, fieldToWorld, OUTPOST, TOWER } from './constants.js';
import { FUEL_RADIUS, hubCenter } from './fuel.js';
import { MIDLAND, TROY, STATES, MILSTEIN, TOP, ELITE } from './teams.js';

const G = 9.81;
const deg = Math.PI / 180;
const other = (a) => (a === BLUE ? RED : BLUE);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Skill levels, weakest to strongest. A robot's skill can sit between two of them.
// aim = degrees of spread per shot, fire = shots a second, intake = how fast it swallows FUEL.
// Calibrated to real 2026 alliance scores (3 robots, 2:40): Easy ~ 120, Medium ~ 250,
// Hard ~ 370, Challenging ~ 550 (see REAL_EVENTS below).
const LEVELS = [
  { name: 'Easy', react: 0.6, aim: 8, speed: 0.65, fire: 1.3, intake: 0.5, think: 0.45, mistakes: 0.3 },
  { name: 'Medium', react: 0.35, aim: 5.5, speed: 0.78, fire: 1.9, intake: 0.7, think: 0.3, mistakes: 0.15 },
  { name: 'Hard', react: 0.2, aim: 3.6, speed: 0.95, fire: 3.4, intake: 1.15, think: 0.2, mistakes: 0.07 },
  { name: 'Challenging', react: 0.1, aim: 2.2, speed: 1.1, fire: 6.5, intake: 2.0, think: 0.1, mistakes: 0.02 },
  // the world's best (300+ EPA): only real teams this good get here
  { name: 'Elite', react: 0.05, aim: 1.5, speed: 1.35, fire: 10, intake: 6, think: 0.07, mistakes: 0.01 },
];
export const AI_LEVEL_NAMES = ['Challenging', 'Realistic', 'Adaptive'];
/** A skill between the levels: t = 0 (Easy) .. 3 (Challenging) .. 4 (Elite). Below 0 is weaker still. */
function levelAt(t) {
  const weak = Math.min(0, t);
  const over = clamp(t - 4, 0, 1.2); // past Elite: only used to keep a top team on its real pace
  t = clamp(t, 0, 4);
  const i = Math.min(3, Math.floor(t)), f = t - i, A = LEVELS[i], B = LEVELS[i + 1];
  const out = { t: t + over };
  for (const k of ['react', 'aim', 'speed', 'fire', 'intake', 'think', 'mistakes']) out[k] = A[k] + (B[k] - A[k]) * f;
  if (over) { out.intake *= 1 + over * 0.6; out.speed = Math.min(1.5, out.speed * (1 + over * 0.12)); out.fire *= 1 + over * 0.3; }
  // the weakest real robots barely score: slower cycles, worse aim
  if (weak < 0) { out.fire *= 1 + weak * 0.6; out.intake *= 1 + weak * 0.5; out.aim *= 1 - weak * 0.5; out.t = weak; }
  return out;
}

// A real robot's skill from its Statbotics EPA (points it adds to its alliance per match). The
// points per level come from running AI-only matches at each level: ~30 / 77 / 110 / 175 / 330.
const EPA_T = [[0, -0.7], [30, 0], [77, 1], [110, 2], [175, 3], [330, 4]];
function epaToT(e) {
  for (let i = 1; i < EPA_T.length; i++) {
    const [a, ta] = EPA_T[i - 1], [b, tb] = EPA_T[i];
    if (e <= b || i === EPA_T.length - 1) return ta + (tb - ta) * clamp((e - a) / (b - a), 0, 1.2);
  }
  return 0;
}
function tToEpa(t) {
  for (let i = 1; i < EPA_T.length; i++) {
    const [a, ta] = EPA_T[i - 1], [b, tb] = EPA_T[i];
    if (t <= tb || i === EPA_T.length - 1) return a + (b - a) * clamp((t - ta) / (tb - ta), 0, 1);
  }
  return 0;
}
const entry = ([team, name, epa, tower, auto]) => ({ team, name, epa, tower, auto });
const EVENT_ROSTERS = [MIDLAND, TROY, STATES, MILSTEIN]; // same order as REAL_EVENTS
/** Every team once (its latest / best-known numbers), never 201. */
function uniq(lists) {
  const m = new Map();
  for (const l of lists) for (const r of l) if (r[0] !== 201) m.set(r[0], entry(r));
  return [...m.values()];
}
// who you can meet at each difficulty
const POOLS = {
  Easy: () => uniq([MIDLAND, TROY]).filter((e) => e.epa < 60),
  Medium: () => uniq([MIDLAND, TROY, STATES, MILSTEIN]).filter((e) => e.epa >= 40 && e.epa <= 120),
  Hard: () => uniq([STATES, MILSTEIN]).filter((e) => e.epa >= 90 && e.epa <= 200),
  Challenging: () => uniq([MILSTEIN, TOP]).filter((e) => e.epa > 150 && !ELITE[e.team]),
  all: () => uniq([MIDLAND, TROY, STATES, MILSTEIN, TOP]),
};
/** Every team you can pick to play against, best first. */
export const TEAM_LIST = POOLS.all().sort((a, b) => b.epa - a.epa).map((e) => ({
  ...e,
  events: [['top', TOP], ['mil', MILSTEIN], ['sta', STATES], ['try', TROY], ['mid', MIDLAND]].filter(([, l]) => l.some((r) => r[0] === e.team)).map(([k]) => k),
}));
// 201 played by the AI, from its 2026 season on Statbotics: EPA 163.7 (31 FUEL in AUTO, ~44 / 36
// in its two active shifts, 46 in END GAME, never climbs). Double shooter at 8 FUEL/s, 40 FUEL hopper.
export const FEDS = { team: 201, name: 'The FEDS', epa: 163.7, tower: 0, auto: 30.8, events: [] };
// Realistic: 201's 2026 season from FIRST's match results (alliance scores, quals). Each match
// is set at one of these events' level, and the robots in it are spread around that level the
// way real alliances mix strong and weak robots.
export const REAL_EVENTS = [
  { name: 'FIM Midland (week 2)', t: 0.55, spread: 0.6, typical: '50-280, most 80-170' },
  { name: 'FIM Troy (week 4)', t: 1.45, spread: 0.75, typical: '120-570, most 200-300' },
  { name: 'Michigan State Champs', t: 2.15, spread: 0.6, typical: '250-570, most 270-420' },
  { name: 'FIRST Championship (Milstein)', t: 2.55, spread: 0.55, typical: '140-660, most 380-500' },
];


const TYPES = {
  Shooter: { cap: 40, fire: 1.2, range: [2.4, 4.4], speed: 4.3, intake: 8, aggression: 0.15, mass: 60 },
  Feeder: { cap: 30, fire: 0.8, range: [1.8, 3.0], speed: 4.8, intake: 12, aggression: 0.25, mass: 55 },
  Defender: { cap: 18, fire: 0.8, range: [1.8, 2.8], speed: 4.9, intake: 7, aggression: 0.85, mass: 68 },
  Climber: { cap: 25, fire: 1, range: [2.0, 3.4], speed: 4.0, intake: 8, aggression: 0.2, mass: 62 },
};
const TYPE_NAMES = Object.keys(TYPES);
const STRATEGIES = ['race', 'deny', 'hoard', 'balanced'];
// TOWER: LEVEL 1 / 2 / 3 in TELEOP (points per robot), how long the climb takes, how high it hangs
const CLIMB_PTS = [0, 10, 20, 30];
const CLIMB_TIME = [0, 2.5, 4.5, 6.5];
const CLIMB_Y = [0, 0.18, 0.5, 0.85];

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
  return { matches: 0, you: { side: 0, cycle: 0, score: 0 }, strat: Object.fromEntries(STRATEGIES.map((s) => [s, { a: 1, b: 1 }])), level: 1.5 };
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

// What the teams' 2026 robots look like, roughly: frame / accent colors and the kind of shooter.
// Team colors for the well-known teams; everyone else gets a look picked from their number, so a
// team always looks the same.
const LOOKS = {
  4414: { frame: 0x1b2a3a, accent: 0x00a6b4, shooter: 'turret' },
  254: { frame: 0x1d2d5c, accent: 0xf2b400, shooter: 'turret' },
  1323: { frame: 0x1a1a1a, accent: 0xc8102e, shooter: 'wide' },
  1690: { frame: 0x111111, accent: 0xe8e8e8, shooter: 'turret' },
  1678: { frame: 0x2f6b2a, accent: 0xff8a1c, shooter: 'wide' },
  33: { frame: 0x1a1a1a, accent: 0xf5c400, shooter: 'hood' },
  118: { frame: 0x9aa3ad, accent: 0x1b3a8a, shooter: 'turret' },
  201: { frame: 0x2a2f36, accent: 0x1f6fff, shooter: 'double' },
};
const SHOOTERS = ['hood', 'double', 'wide', 'turret'];
const ACCENTS = [0xf5c400, 0x2e9e5b, 0xff8a1c, 0x7a3cc4, 0x14a0a8, 0xe8322f, 0x1f6fff, 0xd0d4da, 0xf080b0, 0x8bc34a];
function lookFor(team) {
  if (LOOKS[team]) return LOOKS[team];
  const h = (team * 2654435761) >>> 0;
  return { frame: [0x3a3f46, 0x5b6068, 0x2c2f33, 0x6b6f75, 0x1d1f22][h % 5], accent: ACCENTS[(h >>> 3) % ACCENTS.length], shooter: SHOOTERS[(h >>> 7) % SHOOTERS.length], tall: (h >>> 11) % 3 === 0 };
}
/** Frame, hopper, shooter and intake, as a few low-poly pieces. */
function buildMech(team, hl, hw) {
  const L = lookFor(team);
  const g = new THREE.Group();
  const frameM = new THREE.MeshStandardMaterial({ color: L.frame, metalness: 0.55, roughness: 0.45 });
  const accM = new THREE.MeshStandardMaterial({ color: L.accent, metalness: 0.3, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6 });
  const box = (w, h, d, x, y, z, m) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o; };
  const cyl = (r, len, x, y, z, m, axis = 'z') => { const o = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 12), m); if (axis === 'z') o.rotation.x = Math.PI / 2; if (axis === 'x') o.rotation.z = Math.PI / 2; o.position.set(x, y, z); g.add(o); return o; };
  box(hl * 2 - 0.12, 0.08, hw * 2 - 0.12, 0, 0.2, 0, frameM);
  const hopH = L.tall ? 0.34 : 0.26;
  const hop = box(0.55, hopH, 0.64, 0.05, 0.24 + hopH / 2, 0, new THREE.MeshStandardMaterial({ color: 0xcfe6ff, transparent: true, opacity: 0.28, roughness: 0.1 }));
  hop.castShadow = false;
  // hopper corner posts in the team color
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.03, hopH, 0.03, 0.05 + sx * 0.27, 0.24 + hopH / 2, sz * 0.31, accM);
  if (L.shooter === 'turret') {
    box(0.22, 0.12, 0.3, -0.26, 0.36, 0, frameM);
    const t = cyl(0.17, 0.08, -0.26, 0.47, 0, accM, 'y');
    void t;
    box(0.3, 0.12, 0.2, -0.22, 0.57, 0, dark).rotation.z = 0.35;
    cyl(0.07, 0.22, -0.16, 0.6, 0, accM);
  } else if (L.shooter === 'double') {
    box(0.2, 0.34, 0.6, -0.28, 0.41, 0, frameM);
    for (const z of [-0.14, 0.14]) { cyl(0.08, 0.2, -0.2, 0.56, z, dark); box(0.12, 0.03, 0.2, -0.27, 0.62, z, accM); }
  } else if (L.shooter === 'wide') {
    box(0.22, 0.32, 0.72, -0.27, 0.4, 0, frameM);
    cyl(0.085, 0.7, -0.2, 0.56, 0, dark);
    box(0.2, 0.03, 0.72, -0.27, 0.63, 0, accM).rotation.z = -0.3;
  } else {
    box(0.2, 0.34, 0.5, -0.28, 0.41, 0, frameM);
    cyl(0.09, 0.46, -0.2, 0.55, 0, dark);
    box(0.16, 0.03, 0.46, -0.3, 0.63, 0, accM).rotation.z = -0.4;
  }
  // over-the-bumper intake in the team color, with a roller
  box(0.1, 0.06, 0.72, hl + 0.06, 0.12, 0, accM);
  cyl(0.035, 0.72, hl + 0.1, 0.09, 0, dark);
  return g;
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
    // the rest of the robot: a low-poly take on the team's real robot (their colors and shooter style)
    this.mech = buildMech(team, this.halfL, this.halfW);
    g.add(this.mech);
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
    this.root.position.y += this.climbY || 0;
    this.root.rotation.y = this.prevYaw + wrap(this.curYaw - this.prevYaw) * alpha;
    this.fuelVis.count = Math.min(12, Math.ceil(this.load / Math.max(1, (this.cap || this.type.cap) / 12)));
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
  setup({ alliance, station, mine, theirs, level, seed, picks = [] }) {
    this.clear();
    if (!this.nav) return;
    this.alliance = alliance;
    let r = seed ? Number(seed) || [...String(seed)].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) : Math.floor(Math.random() * 1e9);
    this.seed = r;
    const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
    // which real teams can show up, and how far each one strays from its usual level this match
    let pool, spread = 0.18;
    this.event = null;
    this.elites = [];
    if (level === 'Realistic') {
      const i = Math.floor(rand() * REAL_EVENTS.length);
      this.event = REAL_EVENTS[i];
      pool = uniq([EVENT_ROSTERS[i]]);
    } else if (level === 'Adaptive') {
      // moved after every match toward close games; teams near that level are likeliest
      const want = tToEpa(clamp(this.mem.level ?? 1, 0, 4));
      pool = POOLS.all().filter((e) => Math.abs(e.epa - want) < Math.max(25, want * 0.3) && !ELITE[e.team]);
    } else {
      pool = (POOLS[level] || POOLS.Medium)();
    }
    if (pool.length < 6) pool = POOLS.all().filter((e) => !ELITE[e.team]);
    this.levelName = level;
    this.boost = 0; this.adaptT = 0;
    const gaussR = () => { let u = rand() || 1e-6, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const used = new Set([201]);
    for (const n of picks.slice(0, theirs)) if (n) used.add(n); // nobody else gets your picks
    const draw = () => {
      const left = pool.filter((e) => !used.has(e.team));
      const e = left[Math.floor(rand() * left.length)] || entry([100 + Math.floor(rand() * 9000), 'Team', 80, 0, 10]);
      used.add(e.team);
      return e;
    };
    // what kind of robot: a team that climbs a lot is a Climber; weak robots often play defense or feed
    const typeFor = (e) => {
      if (e.tower > 3) return 'Climber';
      const t = epaToT(e.epa);
      if (t < 0.7 && rand() < 0.5) return rand() < 0.5 ? 'Defender' : 'Feeder';
      if (t >= 2.8) return 'Shooter'; // the top teams are all high-volume shooters
      const r = rand();
      return r < 0.2 ? 'Feeder' : r < 0.3 ? 'Defender' : 'Shooter';
    };
    const add = (al, slot, e) => {
      const elite = ELITE[e.team] || (e.team === 201 ? { bps: 8, onMove: true } : null);
      const typeName = elite ? 'Shooter' : typeFor(e);
      const pers = {
        aggression: clamp(TYPES[typeName].aggression + (rand() - 0.5) * 0.5, 0, 1),
        risk: rand(),
        patience: 0.3 + rand() * 0.6, // how full before going to score
        side: rand() < 0.5 ? -1 : 1, // favorite side of the field
        speed: 0.9 + rand() * 0.15,
        range: TYPES[typeName].range[0] + rand() * (TYPES[typeName].range[1] - TYPES[typeName].range[0]),
        jitter: 0.15 + rand() * 0.25,
      };
      const baseT = epaToT(e.epa) + gaussR() * spread;
      const lv = levelAt(baseT);
      // the ones whose robots we know: their real shot rate, shooting on the move
      if (elite) { lv.fire = elite.bps / TYPES.Shooter.fire; lv.aim = Math.min(lv.aim, 1.5); }
      const eliteFire = elite ? lv.fire : 0;
      const b = new Bot(this.scene, this.RAPIER, this.world, al, e.team, typeName, lv, pers);
      b.slot = slot;
      b.name = e.name;
      b.epa = e.epa;
      b.onMove = !!elite?.onMove || lv.t > 3.2;
      b.baseT = baseT;
      b.eliteFire = eliteFire;
      b.corr = 0;
      // the best robots carry more (bigger hoppers): up to half again at the top
      b.cap = Math.round(TYPES[typeName].cap * (1 + Math.max(0, lv.t - 2) * 0.25));
      b.elite = !!elite;
      b.sloppy = rand(); // how careful it is about fouls this match
      // TOWER: from how many TOWER points the team really averages
      b.climbLevel = e.tower > 20 ? 3 : e.tower > 9 ? 2 : e.tower > 1.5 ? 1 : 0;
      if (typeName === 'Climber' && !b.climbLevel) b.climbLevel = 1;
      this.bots.push(b);
      if (elite && e.team !== 201) this.elites.push(b);
      if (e.team === 201) { b.climbLevel = 0; b.cap = 40; b.is201 = true; this.use201Model?.(b); }
    };
    // your teammates take the other driver stations; the opponents line up across the field
    const free = [0, 1, 2].filter((s) => s !== station);
    for (let i = 0; i < mine - 1; i++) add(alliance, free[i], draw());
    // Challenging: a chance to draw one (or two) of the world's best as opponents
    const elites = [];
    if (level === 'Challenging') {
      const r = rand();
      const n = Math.min(theirs, r < 0.15 ? 2 : r < 0.6 ? 1 : 0);
      const names = Object.keys(ELITE).map(Number).sort(() => rand() - 0.5);
      for (let i = 0; i < n; i++) { if (picks.includes(names[i])) continue; const e = entry(TOP.find((x) => x[0] === names[i])); used.add(e.team); elites.push(e); }
    }
    // teams you picked yourself take their slots first
    for (let i = 0; i < theirs; i++) {
      const pk = picks[i] === 201 ? FEDS : picks[i] ? TEAM_LIST.find((e) => e.team === picks[i]) : null;
      add(other(alliance), i, pk || elites.shift() || draw());
    }
    // each alliance's coach picks a strategy: the opponents learn which ones beat you
    this.coach = {};
    for (const al of [BLUE, RED]) {
      const vsYou = al !== alliance;
      let strat = STRATEGIES[Math.floor(rand() * STRATEGIES.length)];
      if (vsYou) {
        let best = -1;
        for (const s of STRATEGIES) { const st = this.mem.strat[s]; const v = betaSample(st.a, st.b); if (v > best) { best = v; strat = s; } }
      }
      // how much this alliance likes to play defense, different every match
      this.coach[al] = { strat, t: 0, defense: rand() };
    }
    this.you = { lastPos: null, sideT: [0, 0], shots: 0, scored: 0, inNeutralT: 0, carryT: 0 };
    this.reset();
  }

  /** Back to the starting spots with the preload. */
  reset() {
    this.g403 = new Map();
    this.paceT = 0;
    for (const b of this.bots) {
      const p = fieldToWorld(0.95, STATIONS[b.slot].fy, b.alliance);
      const p2 = fieldToWorld(ALLIANCE_ZONE_DEPTH - 0.6, STATIONS[b.slot].fy, b.alliance);
      b.reset(p2.x, p2.z, Math.atan2(-(p2.z - p.z), p2.x - p.x));
      b.load = 8; b.scored = 0; b.shots = 0; b.fireT = 0;
      b.climbY = 0; b.towerPts = 0; b.pinT = 0; b.fouls = 0;
      b.corr = 0; b.defT = 0; if (b.baseT != null) Object.assign(b.level, levelAt(b.baseT), b.eliteFire ? { fire: b.eliteFire } : {});
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

  /**
   * Adaptive, during the match: every few seconds the other alliance's robots get better while
   * you're ahead and ease off while you're behind, so the match stays close.
   */
  adapt(game, match, dt) {
    if (!match?.on || match.over || match.disabled) return;
    this.adaptT -= dt;
    if (this.adaptT > 0) return;
    this.adaptT = 3;
    const opp = other(this.alliance);
    const lead = (game.score[this.alliance] ?? 0) - (game.score[opp] ?? 0);
    // a lead early in the match counts for more than the same lead near the end
    const t = Math.max(25, match.t);
    const want = clamp((lead / t) * 3.2 + lead / 60, -1.2, 2.2);
    this.boost += (want - this.boost) * 0.45;
  }

  /**
   * Keep every robot on its real team's pace. Each AI robot is a real team with a real EPA
   * (points it adds per match). Every few seconds it compares what it has scored with what that
   * team would have by now, and sharpens or eases its own driving to match, so over a match it
   * lands near its real number whatever traffic and defense it ran into. (Adaptive then moves the
   * other alliance up or down on top of that.)
   */
  pace(game, match, dt) {
    if (!match?.on || match.over || match.disabled) return;
    this.paceT = (this.paceT || 0) - dt;
    if (this.paceT > 0) return;
    this.paceT = 3;
    const frac = clamp(match.t / 163, 0, 1);
    for (const b of this.bots) {
      if (b.epa == null) continue;
      // defending isn't scoring: don't count that time against it
      if (b.task.kind === 'defend') { b.defT = (b.defT || 0) + 3; continue; }
      const want = Math.max(0, b.epa) * clamp((match.t - (b.defT || 0)) / 163, 0, 1);
      const have = b.scored + (b.towerPts || 0);
      if (frac > 0.12) {
        const err = (want - have) / Math.max(15, want);
        b.corr = clamp(b.corr + clamp(err, -0.5, 0.5) * 0.35, -1.2, 1.6);
      }
      const boost = this.levelName === 'Adaptive' && b.alliance !== this.alliance ? this.boost : 0;
      const lv = levelAt(b.baseT + b.corr + boost);
      if (b.eliteFire) { lv.fire = b.eliteFire * (1 + clamp(b.corr, -0.5, 0.4)); lv.aim = Math.min(lv.aim, 1.5); }
      Object.assign(b.level, lv);
      b.onMove = !!b.elite || lv.t > 3.2;
    }
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
    this.ctx = ctx;
    this.youPos = robot.body.translation();
    this.watchYou(robot, game, dt);
    const disabled = match?.disabled;
    for (const al of [BLUE, RED]) this.coachThink(al, ctx, game, dt);
    if (this.levelName === 'Adaptive') this.adapt(game, match, dt);
    this.pace(game, match, dt);
    this.referee(robot, game, dt);
    for (const b of this.bots) {
      if (disabled) { b.drive(0, 0, 0, dt); continue; }
      this.collect(b, dt);
      b.thinkT -= dt;
      if (b.thinkT <= 0) {
        b.thinkT = b.level.think * (0.8 + Math.random() * 0.4);
        this.think(b, ctx, game);
      }
      this.act(b, ctx, game, dt);
    }
  }

  /**
   * The referee, for every robot on the field (you included):
   *  - pinning an opposing robot that's trying to move for more than 3 s: MINOR FOUL. A careful
   *    driver backs off before that; a sloppy one doesn't.
   *  - touching an opposing robot that's on its TOWER in END GAME: MAJOR FOUL.
   *  - an AI defender slamming into a robot at full speed: sometimes MINOR (excessive contact).
   * How sloppy each AI robot is gets rolled every match.
   */
  referee(robot, game, dt) {
    if (game.match?.disabled) return;
    const endgame = this.ctx?.endgame;
    const auto = this.ctx?.match?.on && this.ctx.match.phase().name === 'AUTO';
    const now = this.ctx?.match?.t ?? 0;
    this.g403 ||= new Map();
    const rv = robot.body.linvel();
    const you = { p: robot.body.translation(), v: rv, al: this.alliance, r: robot.halfL, team: 201, you: true, wants: Math.hypot(robot.cmd?.vx || 0, robot.cmd?.vz || 0) > 0.8 };
    const all = [you, ...this.bots.map((o) => ({ p: o.pos(), v: o.body.linvel(), al: o.alliance, r: o.halfL, team: o.team, bot: o, wants: Math.hypot(o.cmdX || 0, o.cmdZ || 0) > 1 }))];
    for (const m of all) {
      const who = m.bot || this.you;
      let pinning = false;
      who.rcool = Math.max(0, (who.rcool || 0) - dt);
      for (const o of all) {
        if (o === m || o.al === m.al) continue;
        const dx = o.p.x - m.p.x, dz = o.p.z - m.p.z, d = Math.hypot(dx, dz);
        if (d > m.r + o.r + 0.14) continue;
        // G403: in AUTO, a robot whose BUMPERS are all the way across the CENTER LINE may not
        // touch an opponent. A MAJOR FOUL for each new contact.
        const across = m.al === BLUE ? m.p.x - m.r > 0 : m.p.x + m.r < 0;
        if (auto && across) {
          const key = `${m.team}>${o.team}`;
          // a new contact: they'd been apart for at least a second
          const last = this.g403.get(key);
          this.g403.set(key, now);
          if (last === undefined || now - last > 1) this.foul(game, m, 'MAJOR', 'contact across the CENTER LINE in AUTO', 'G403');
        }
        // a robot on its TOWER in END GAME is protected
        if (endgame && o.bot?.climbY > 0.02) {
          const hit = (o.bot.hitBy ||= new Set());
          if (!hit.has(m.team)) { hit.add(m.team); this.foul(game, m, 'MAJOR', 'contact with a robot on its TOWER in END GAME'); }
          continue;
        }
        // pinning: they want to move and can't, and we're the one leaning on them
        if (Math.hypot(o.v.x, o.v.z) < 0.35 && o.wants && (m.you || m.bot.task.kind === 'defend')) pinning = true;
        // excessive contact: a defender arriving at full speed
        if (m.bot?.task.kind === 'defend' && !who.rcool) {
          const closing = ((m.v.x - o.v.x) * dx + (m.v.z - o.v.z) * dz) / (d || 1);
          if (closing > 3.2) { who.rcool = 6; if (Math.random() < m.bot.sloppy * 0.35) this.foul(game, m, 'MINOR', 'excessive contact'); }
        }
      }
      who.pinT = pinning ? (who.pinT || 0) + dt : Math.max(0, (who.pinT || 0) - dt * 2);
      // a careful AI driver counts in their head and backs off around 2.5 s
      if (m.bot && who.pinT > 2.3 + m.bot.sloppy * 0.4 && m.bot.sloppy < 0.55) { who.pinT = 0; m.bot.backOff = 1.2; continue; }
      if (who.pinT > 3) {
        who.pinT = 0;
        this.foul(game, m, 'MINOR', 'pinning for more than 3 seconds');
        if (m.bot) m.bot.task = { kind: 'unstick', t: 0, dir: { x: Math.random() - 0.5, z: Math.random() - 0.5 }, until: 1.2 };
      }
    }
  }

  foul(game, m, kind, why, rule = '') {
    if (m.bot) m.bot.fouls = (m.bot.fouls || 0) + 1;
    game.foulBy(m.al, m.team, kind, rule, why);
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
    // Defense mostly happens during the other alliance's shift: our HUB is off, theirs counts, so
    // the best use of a robot is slowing down whoever is shooting. How much an alliance likes to
    // defend is rolled per match (c.defense).
    let defender = null;
    const theirShift = !ctx.active(al) && ctx.active(opp);
    let wantDefense = false;
    if (c.strat === 'deny') wantDefense = c.defense > 0.15;
    else if (theirShift) wantDefense = c.defense > 0.3 && c.strat !== 'race' || c.defense > 0.75;
    else if (c.strat === 'balanced') wantDefense = c.defense > 0.6 && (diff < -10 || youThreat > 30);
    if (wantDefense && (mine.length > 1 || theirShift || c.strat === 'deny')) {
      // the one whose scoring we'd miss least: aggressive, light on FUEL, and not our best shooter
      const dv = (r) => r.p.aggression - r.load * 0.02 - Math.max(0, r.level.t) * 0.35 - (r.elite ? 2 : 0);
      defender = mine.reduce((a, b) => (dv(b) > dv(a) ? b : a));
      if (defender.p.aggression + c.defense < 0.6) defender = null;
      // a top scorer doesn't get sent to play defense: it fills up and passes for the next shift
      if (defender && (defender.elite || defender.level.t > 3.3) && c.strat !== 'deny') defender = null;
    }
    // who to guard: the biggest threat on the other alliance (you, or one of their AI). Your own
    // teammates never pick you. A robot hanging on its TOWER is off limits.
    let target = null, best = -1;
    if (al !== this.alliance) { target = { you: true }; best = youThreat; }
    for (const ob of oppBots) {
      if (ob.climbY > 0) continue;
      const t = ob.scored * 1.2 + ob.load * 0.5;
      if (t > best) { best = t; target = { bot: ob }; }
    }
    for (const b of mine) {
      b.role = b === defender ? 'defend' : 'score';
      b.guard = b === defender ? target : null;
    }
  }

  // ---------------------------------------------------------- brain: pick a task
  think(b, ctx, game) {
    // once on the TOWER, it stays there
    if (b.task.kind === 'climb' && b.task.phase !== 'go') return;
    const p = b.pos();
    const al = b.alliance;
    const lv = b.level;
    const strat = this.coach[al].strat;
    const full = b.load / b.cap;
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
    if (b.load < b.cap) {
      let u = (1 - full) * 0.95;
      if (!active && strat === 'hoard') u *= 1.3;
      options.push({ kind: 'collect', u });
    }
    // pass: our HUB is off, so lob what we pick up in the NEUTRAL ZONE back to our ALLIANCE ZONE,
    // ready for when it turns on
    if (!active && b.load >= 3 && soon > 4 && !this.inZone(p, al)) {
      options.push({ kind: 'pass', u: 0.35 + full * 1.1 + (strat === 'hoard' ? 0.15 : 0) });
    }
    // defend: the coach's call, weighed by personality
    if (b.role === 'defend' && b.guard) options.push({ kind: 'defend', u: 0.7 + b.p.aggression * 0.6 - full * 0.3 });
    // feed the OUTPOST: hand FUEL to our human player while our HUB is off (feeders love this)
    if (b.load >= 10 && !active) {
      let u = full * 0.75 + (b.typeName === 'Feeder' ? 0.4 : 0) + (strat === 'hoard' ? 0.1 : 0) - b.p.patience * 0.2;
      if (game.humans[al].stash > 20) u -= 0.5;
      options.push({ kind: 'feed', u });
    }
    // climb: in END GAME, with enough time to get there and get up
    if (b.climbLevel && ctx.endgame) {
      const tw = this.towerSpot(b);
      const travel = Math.hypot(p.x - tw.x, p.z - tw.z) / b.type.speed + 1.5;
      const need = travel + CLIMB_TIME[b.climbLevel] + 2;
      if (ctx.timeLeft < need + 6) options.push({ kind: 'climb', u: ctx.timeLeft < need ? 3 : 1.4 });
    }
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

  /** Inside this alliance's ALLIANCE ZONE? */
  inZone(p, al) { return (al === BLUE ? -p.x : p.x) > HALF_L - ALLIANCE_ZONE_DEPTH; }

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
    } else if (kind === 'pass') {
      // a spot on the floor of our ALLIANCE ZONE, clear of the HUB
      b.task.target = fieldToWorld(ALLIANCE_ZONE_DEPTH * (0.35 + Math.random() * 0.4), HALF_W + (Math.random() - 0.5) * 4.5, al);
      b.path = null;
    } else if (kind === 'feed') {
      const o = fieldToWorld(OUTPOST.depth + 0.55, OUTPOST.fy + 0.1, al);
      b.task.spot = o;
      this.plan(b, o.x, o.z);
    } else if (kind === 'climb') {
      const tw = this.towerSpot(b);
      b.task.spot = tw;
      b.task.phase = 'go';
      this.plan(b, tw.x, tw.z);
    } else if (kind === 'unstick') {
      const a = Math.random() * Math.PI * 2;
      b.task.dir = { x: Math.cos(a), z: Math.sin(a) };
      b.task.until = 0.7;
      b.path = null;
      b.stuckT = 0;
    }
    void p;
  }

  /** Where to line up on our TOWER (two robots can climb side by side). */
  towerSpot(b) {
    const mates = this.bots.filter((o) => o.alliance === b.alliance && o.climbLevel);
    const i = Math.max(0, mates.indexOf(b));
    return fieldToWorld(TOWER.depth + 0.5, TOWER.fy + (i % 2 ? 0.5 : -0.5), b.alliance);
  }

  /** Choose a FUEL to go get: close, in a cluster, on our favorite side, not chased by a teammate. */
  pickBall(b) {
    const p = b.pos();
    const al = b.alliance;
    const sign = al === BLUE ? -1 : 1;
    const balls = this.fuel.balls;
    const claimed = new Set(this.bots.filter((o) => o !== b && o.task.ball).map((o) => o.task.ball));
    const near = this.bots.filter((o) => o !== b).map((o) => ({ ...o.pos(), mate: o.alliance === al }));
    if (this.youPos) near.push({ x: this.youPos.x, z: this.youPos.z, mate: al === this.alliance });
    let best = null, bs = Infinity;
    for (let n = 0; n < 160; n++) {
      const ball = balls[(Math.random() * balls.length) | 0];
      if (!ball.active || ball.inRobot || claimed.has(ball)) continue;
      const q = ball.body.translation();
      if (q.y > 0.2 || Math.abs(q.x) > HALF_L - 0.3 || Math.abs(q.z) > HALF_W - 0.3) continue;
      // stay out of the other alliance's zone
      if (-sign * q.x > HALF_L - ALLIANCE_ZONE_DEPTH) continue;
      // in AUTO, don't go fully across the CENTER LINE (G403)
      if (this.ctx?.match?.on && this.ctx.match.phase().name === 'AUTO' && -sign * q.x > 0.3) continue;
      const [i, k] = this.nav.idx(q.x, q.z);
      if (!this.nav.free(i, k)) continue;
      let s = Math.hypot(q.x - p.x, q.z - p.z);
      // while our HUB is off, leave the ones at home for later and gather from the middle
      if (this.ctx && !this.ctx.active(al) && this.inZone(q, al)) s += 3;
      s += (Math.sign(q.z) === b.p.side * (al === BLUE ? 1 : -1) ? -0.6 : 0.6) * (1 - b.p.risk * 0.5);
      for (const o of this.bots) if (o !== b && o.task.ball) { const t = o.task.ball.body.translation(); if (Math.hypot(t.x - q.x, t.z - q.z) < 1.5) s += 1.2; }
      // where everyone is: a ball right next to a teammate is theirs to take; one next to an
      // opponent is a fight (worth it only to an aggressive driver); clusters are worth more
      for (const r of near) {
        const d = Math.hypot(r.x - q.x, r.z - q.z);
        if (d < 1.6) s += r.mate ? 2.2 - d : (1.4 - d) * (1 - b.p.aggression);
      }
      let cl = 0;
      for (let k = 0; k < 6; k++) { const o = balls[(Math.random() * balls.length) | 0]; if (o.active && !o.inRobot) { const t = o.body.translation(); if (Math.hypot(t.x - q.x, t.z - q.z) < 1.2 && t.y < 0.2) cl++; } }
      s -= cl * 0.35;
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
      // a teammate leaves you room to shoot
      if (al === this.alliance && this.youPos) s += Math.max(0, 2.8 - Math.hypot(this.youPos.x - x, this.youPos.z - z)) * 4;
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
      // the best robots don't stop to shoot: they fire as soon as they're in the zone and in range
      else if (t.kind === 'score' && b.onMove && this.inZone(p, b.alliance) && Math.hypot(p.x - hub.x, p.z - hub.z) < 5.5) {
        face = Math.atan2(-(hub.z - p.z), hub.x - p.x);
        this.shoot(b, ctx, game, dt);
      }
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
        // follow them anywhere, even into their ALLIANCE ZONE while they shoot (the nav grid keeps
        // it off the HUB). A careful driver backs off before a pin turns into a foul.
        if (b.backOff > 0) { b.backOff -= dt; const k = 1.6 / (Math.hypot(p.x - gp.x, p.z - gp.z) || 1); tx = p.x + (p.x - gp.x) * k; tz = p.z + (p.z - gp.z) * k; }
        face = Math.atan2(-(gp.z - p.z), gp.x - p.x);
        t.replan -= dt;
        if (t.replan <= 0) { t.replan = 0.6; this.plan(b, tx, tz); }
        if (b.path && Math.hypot(tx - p.x, tz - p.z) < 1.5) b.path = null;
      }
    } else if (t.kind === 'pass' && t.target) {
      face = Math.atan2(-(t.target.z - p.z), t.target.x - p.x);
      this.lob(b, t.target, dt);
      if (b.load <= 0 || ctx.active(b.alliance)) b.thinkT = 0, b.task = { kind: 'idle' };
    } else if (t.kind === 'feed' && t.spot) {
      arrive = true;
      const d = Math.hypot(p.x - t.spot.x, p.z - t.spot.z);
      if (d < 0.8) {
        // tip the hopper into the OUTPOST
        t.dump = (t.dump || 0) + dt * 12;
        while (t.dump >= 1 && b.load > 0) { t.dump -= 1; b.load--; game.feedHuman(b.alliance, 1); }
        if (b.load <= 0) b.thinkT = 0, b.task = { kind: 'idle' };
      }
    } else if (t.kind === 'climb' && t.spot) {
      const d = Math.hypot(p.x - t.spot.x, p.z - t.spot.z);
      const face = b.alliance === BLUE ? Math.PI : 0; // back up to the TOWER
      if (t.phase === 'go') {
        arrive = true;
        if (d < 0.25) { t.phase = 'up'; t.climbT = 0; b.path = null; }
      }
      if (t.phase !== 'go') {
        b.drive(0, 0, clamp(wrap(face - b.yaw()) * 5, -4, 4), dt);
        if (t.phase === 'up') {
          t.climbT += dt;
          const dur = CLIMB_TIME[b.climbLevel];
          b.climbY = CLIMB_Y[b.climbLevel] * Math.min(1, t.climbT / dur);
          if (t.climbT >= dur) {
            // the odd slip: drop back down and try for a lower rung
            if (Math.random() < b.level.mistakes * 0.6 && b.climbLevel > 1) { b.climbLevel--; t.climbT = 0; b.climbY = 0; }
            else { t.phase = 'hang'; game.addTower(b.alliance, CLIMB_PTS[b.climbLevel]); b.towerPts = CLIMB_PTS[b.climbLevel]; }
          }
        }
        return;
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
    // keep clear of other robots (and you), unless we're defending. Your teammates give you a
    // wide berth and stay out of the line between you and the HUB while you're shooting.
    if (t.kind !== 'defend') {
      const mate = b.alliance === this.alliance;
      // teammates keep well apart (they talk to each other); opponents only avoid a head-on crash
      const others = [...this.bots.filter((o) => o !== b).map((o) => ({ q: o.pos(), r: o.alliance === b.alliance ? 1.9 : 1.25 })), { q: ctx.robot.body.translation(), r: mate ? 2.4 : 1.25 }];
      for (const { q: o, r } of others) {
        const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz);
        if (d < r && d > 0.01) { const k = (r - d) * 2.2; vx += (dx / d) * k; vz += (dz / d) * k; }
      }
      if (mate && game.aim) {
        const a = ctx.robot.body.translation(), h = game.aim.target || hubCenter(this.alliance);
        const sx = h.x - a.x, sz = h.z - a.z, L2 = sx * sx + sz * sz || 1;
        const u = clamp(((p.x - a.x) * sx + (p.z - a.z) * sz) / L2, 0, 1);
        const cx = a.x + sx * u, cz = a.z + sz * u;
        const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
        if (d < 1.3 && u > 0.05 && u < 0.98) { const k = (1.3 - d) * 3 / (d || 1); vx += dx * k || sz * 0.5; vz += dz * k || -sx * 0.5; }
      }
    }
    // reaction delay: the command catches up over the level's reaction time
    const kr = 1 - Math.exp(-dt / Math.max(0.05, b.level.react * 0.5));
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
  collect(b, dt) {
    if (b.load >= b.cap) return;
    // the intake can only swallow so many a second
    b.intakeBudget = Math.min(2, (b.intakeBudget || 0) + dt * b.type.intake * b.level.intake);
    if (b.intakeBudget < 1) return;
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
        b.intakeBudget -= 1;
        if (b.intakeBudget < 1) return;
        if (b.load >= b.cap) return;
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
    b.fireT = 1 / (b.level.fire * b.type.fire * (0.85 + Math.random() * 0.3));
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
    // on the move it keeps firing, just a little less accurately
    const lv0 = b.body.linvel();
    const err = b.level.aim * deg * (1 + Math.min(0.5, Math.hypot(lv0.x, lv0.z) * 0.12));
    const yawN = gauss() * err;
    v *= 1 + gauss() * (0.02 + b.level.aim * 0.006);
    const cy = Math.cos(yawN), sy = Math.sin(yawN);
    const ux = (dx / d) * cy - (dz / d) * sy, uz = (dx / d) * sy + (dz / d) * cy;
    const thN = th + gauss() * err * 0.6;
    const hv = v * Math.cos(thN);
    this.fuel.enable(ball, ex, ey, ez, ux * hv, v * Math.sin(thN), uz * hv);
    ball.shot = null;
    ball.bot = b;
  }

  /** Lob one FUEL to a spot on the floor (passing back to our ALLIANCE ZONE). */
  lob(b, target, dt) {
    b.fireT -= dt;
    if (b.load <= 0 || b.fireT > 0) return;
    const p = b.pos();
    const want = Math.atan2(-(target.z - p.z), target.x - p.x);
    if (Math.abs(wrap(want - b.yaw())) > 12 * deg) return;
    const ball = this.fuel.takeSpare();
    if (!ball) return;
    b.fireT = 1 / (b.level.fire * b.type.fire * 1.15 * (0.85 + Math.random() * 0.3));
    b.load--;
    const ex = p.x, ez = p.z, ey = 0.62;
    const dx = target.x - ex, dz = target.z - ez, d = Math.hypot(dx, dz) || 1;
    const th = 50 * deg;
    // lands on the floor: solve with the drop from the shooter height
    const den = 2 * Math.cos(th) ** 2 * (d * Math.tan(th) + ey);
    const v = Math.sqrt((G * d * d) / den) * (1 + gauss() * 0.06);
    const yawN = gauss() * b.level.aim * 1.5 * deg;
    const cy = Math.cos(yawN), sy = Math.sin(yawN);
    const ux = (dx / d) * cy - (dz / d) * sy, uz = (dx / d) * sy + (dz / d) * cy;
    const hv = v * Math.cos(th);
    this.fuel.enable(ball, ex, ey, ez, ux * hv, v * Math.sin(th), uz * hv);
    ball.shot = null;
    ball.bot = null;
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
    // what it took during the match to keep up carries into the next one, plus the result
    this.mem.level = clamp((this.mem.level ?? 1.5) + this.boost * 0.6 + clamp(margin / 45, -0.8, 0.8), 0, 4);
    const y = this.you;
    const side = y.sideT[1] - y.sideT[0];
    this.mem.you.side = this.mem.you.side * 0.7 + Math.sign(side) * 0.3;
    this.mem.you.score = this.mem.you.score * 0.7 + yours * 0.3;
    this.mem.matches++;
    saveMemory(this.mem);
  }
}
