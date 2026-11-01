// The places you can play: the room around the field. Each map is built the first time it's
// used, from a few merged meshes and instanced crowds, so switching is cheap and only the map on
// screen is drawn.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_L, HALF_W } from './constants.js';
import { buildArena } from './arena.js';

export const MAPS = [
  { id: 'gym', name: 'School gym' },
  { id: 'rochester', name: 'Rochester HS gym' },
  { id: 'houston', name: 'Houston Champs' },
  { id: 'pits', name: 'FRC pits' },
  { id: 'space', name: 'Space' },
  { id: 'outside', name: 'Outside' },
];

// ------------------------------------------------------------ helpers
function tex(w, h, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 4;
  return t;
}
/** One mesh from many boxes: [w, h, d, x, y, z, rotY?]. */
function boxes(list, mat) {
  const gs = list.map(([w, h, d, x, y, z, ry = 0]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (ry) g.rotateY(ry);
    g.translate(x, y, z);
    return g;
  });
  return new THREE.Mesh(mergeGeometries(gs), mat);
}
function plane(w, h, mat, x, y, z, ry = 0, rx = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  m.position.set(x, y, z); m.rotation.set(rx, ry, 0, 'YXZ');
  return m;
}
const std = (o) => new THREE.MeshStandardMaterial(o);
const lam = (o) => new THREE.MeshLambertMaterial(o);
const basic = (o) => new THREE.MeshBasicMaterial(o);
// a little seeded random, so the crowd looks the same every time
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

/** Seated people along a bank of rows: one instanced body and one instanced head. */
function crowd(g, seats, colors, seed = 1) {
  const r = rng(seed);
  const n = seats.length;
  const body = new THREE.InstancedMesh(new THREE.BoxGeometry(0.44, 0.62, 0.3), lam({}), n);
  const head = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, 0.24, 0.22), lam({}), n);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  const skin = ['#f1c9a5', '#d8a27a', '#a8714a', '#6e4428', '#e0b08a'];
  seats.forEach(([x, y, z, ry], i) => {
    const h = 0.9 + r() * 0.2;
    m.makeRotationY(ry + (r() - 0.5) * 0.4).setPosition(x, y + 0.31 * h, z);
    m.scale(new THREE.Vector3(1, h, 1));
    body.setMatrixAt(i, m);
    body.setColorAt(i, c.set(colors[Math.floor(r() * colors.length)]));
    m.makeRotationY(ry).setPosition(x, y + 0.62 * h + 0.14, z);
    head.setMatrixAt(i, m);
    head.setColorAt(i, c.set(skin[Math.floor(r() * skin.length)]));
  });
  g.add(body, head);
}

// ------------------------------------------------------------ Rochester High School gym
function buildRochester(g) {
  const L = 50, W = 34, H = 11;
  const blue = '#1f5fbf';
  // glossy maple
  const wood = tex(512, 512, (x, w, h) => {
    x.fillStyle = '#d9a866'; x.fillRect(0, 0, w, h);
    const rows = 24;
    for (let r = 0; r < rows; r++) {
      const y = (r * h) / rows;
      for (let px = -((r * 83) % 160); px < w; px += 150 + ((r * 37) % 90)) {
        const s = (px * 13 + r * 29) % 26;
        x.fillStyle = `rgb(${222 - s}, ${172 - s}, ${108 - s})`;
        x.fillRect(px + 1, y + 1, 148, h / rows - 1.5);
      }
    }
  }, 16, 12);
  const floor = plane(L, W, std({ map: wood, roughness: 0.18, metalness: 0.08 }), 0, -0.004, 0, 0, -Math.PI / 2);
  floor.receiveShadow = true;
  g.add(floor);
  // the blue court border with FALCONS on both sides (the field covers the middle of the court)
  const court = tex(2048, 1152, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    const b = 70;
    x.fillStyle = blue;
    x.fillRect(0, 0, w, b); x.fillRect(0, h - b, w, b); x.fillRect(0, 0, b, h); x.fillRect(w - b, 0, b, h);
    x.fillStyle = '#ffffff'; x.font = 'bold 60px Arial Black, Arial, sans-serif'; x.textAlign = 'center';
    x.fillText('FALCONS', w * 0.3, h - 14); x.fillText('ROCHESTER', w * 0.7, h - 14);
    x.save(); x.translate(w, 0); x.rotate(Math.PI); x.fillText('FALCONS', w * 0.3, -14 + 0); x.restore();
    x.save(); x.translate(w * 0.3, 56); x.rotate(Math.PI); x.fillText('FALCONS', 0, 0); x.restore();
    x.strokeStyle = '#1b1b1b'; x.lineWidth = 6;
    x.beginPath(); x.arc(w / 2, h / 2, 230, 0, Math.PI * 2); x.stroke();
  });
  const courtM = plane(32, 18, basic({ map: court, transparent: true, depthWrite: false }), 0, -0.001, 0, 0, -Math.PI / 2);
  g.add(courtM);
  // walls: cream block, blue padding at the bottom, two blue stripes up high
  const block = tex(256, 256, (x, w, h) => {
    x.fillStyle = '#efe9da'; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(150,140,120,0.3)'; x.lineWidth = 2;
    for (let r = 0; r < 8; r++) { const y = (r * h) / 8; x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke(); }
  }, 12, 3);
  const wallMat = lam({ map: block });
  const wall = [], pad = [], stripe = [];
  for (const [len, x, z, ry] of [[L, 0, -W / 2, 0], [L, 0, W / 2, Math.PI], [W, -L / 2, 0, Math.PI / 2], [W, L / 2, 0, -Math.PI / 2]]) {
    const add = (arr, hh, y, inset) => { const p = new THREE.PlaneGeometry(len, hh); p.rotateY(ry); p.translate(x * inset, y, z * inset); arr.push(p); };
    add(wall, H, H / 2, 1);
    add(pad, 2.2, 1.1, 0.998);
    add(stripe, 0.3, 5.4, 0.998);
    add(stripe, 0.45, 6.6, 0.998);
  }
  g.add(new THREE.Mesh(mergeGeometries(wall), wallMat));
  const blueMat = lam({ color: blue });
  g.add(new THREE.Mesh(mergeGeometries([...pad, ...stripe]), blueMat));
  // folded-up bleachers: blue fronts along both long walls
  const bl = tex(64, 256, (x, w, h) => {
    x.fillStyle = blue; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < 12; i++) x.fillRect(0, (i * h) / 12, w, 3);
  }, 40, 1);
  const bleach = [];
  for (const s of [-1, 1]) bleach.push([40, 2.5, 1.1, 0, 1.25, s * (W / 2 - 0.6)]);
  g.add(boxes(bleach, lam({ map: bl })));
  // the row of state-champion plaques (white Michigan mittens)
  const plaques = tex(1024, 128, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      const cx = i * 128 + 64;
      x.fillStyle = i === 5 ? blue : '#ffffff';
      x.beginPath();
      x.moveTo(cx - 34, 120); x.lineTo(cx - 40, 50); x.quadraticCurveTo(cx - 36, 18, cx - 14, 14);
      x.lineTo(cx - 6, 30); x.lineTo(cx + 18, 10); x.quadraticCurveTo(cx + 40, 22, cx + 38, 60);
      x.lineTo(cx + 30, 120); x.closePath(); x.fill();
      x.fillStyle = i === 5 ? '#fff' : '#1b3a8a'; x.font = 'bold 13px Arial'; x.textAlign = 'center';
      x.fillText('STATE', cx, 62); x.fillText('CHAMPION', cx, 78); x.fillText(String(2000 + ((i * 3) % 20)), cx, 96);
    }
  }, 5, 1);
  const pm = basic({ map: plaques, transparent: true });
  g.add(plane(40, 1.3, pm, 0, 3.4, -W / 2 + 0.03));
  g.add(plane(40, 1.3, pm, 0, 3.4, W / 2 - 0.03, Math.PI));
  // the end wall: flag, banners and a scoreboard
  const endTex = tex(1024, 256, (x, w, h) => {
    x.clearRect(0, 0, w, h);
    // flag
    for (let i = 0; i < 13; i++) { x.fillStyle = i % 2 ? '#ffffff' : '#b22234'; x.fillRect(40, 40 + i * 9, 190, 9); }
    x.fillStyle = '#3c3b6e'; x.fillRect(40, 40, 80, 63);
    // banners
    for (const [bx, yr] of [[300, '2016'], [430, '2016'], [560, '2017']]) {
      x.fillStyle = '#1b3a8a'; x.fillRect(bx, 20, 100, 200);
      x.fillStyle = '#fff'; x.font = 'bold 14px Arial'; x.textAlign = 'center';
      x.fillText('ROCHESTER', bx + 50, 60); x.fillText('STATE', bx + 50, 110); x.fillText('CHAMPIONS', bx + 50, 130);
      x.font = 'bold 26px Arial'; x.fillText(yr, bx + 50, 190);
    }
    // scoreboard
    x.fillStyle = '#10204a'; x.fillRect(700, 30, 280, 170);
    x.fillStyle = '#fff'; x.font = 'bold 22px Arial'; x.fillText('HOME', 760, 70); x.fillText('GUEST', 920, 70);
    x.fillStyle = '#ffb000'; x.font = 'bold 44px monospace'; x.fillText('201', 760, 130); x.fillText('00', 920, 130);
    x.fillStyle = '#ff4030'; x.fillText('2:40', 840, 185);
  });
  const em = basic({ map: endTex, transparent: true });
  g.add(plane(16, 4, em, -L / 2 + 0.03, 5.8, 0, Math.PI / 2));
  g.add(plane(16, 4, em, L / 2 - 0.03, 5.8, 0, -Math.PI / 2));
  // ceiling: cream deck, white trusses, blue-striped ducts, round pendant lights
  g.add(plane(L, W, lam({ color: 0xd8d0bc }), 0, H, 0, 0, Math.PI / 2));
  const truss = [];
  for (let i = -5; i <= 5; i++) {
    truss.push([0.2, 0.2, W, i * 4.6, H - 0.4, 0], [0.2, 0.2, W, i * 4.6, H - 1.8, 0]);
    for (let k = -7; k <= 7; k++) truss.push([0.08, 1.9, 0.08, i * 4.6, H - 1.1, k * 2.2]);
  }
  for (let k = -3; k <= 3; k++) truss.push([L, 0.15, 0.15, 0, H - 1.9, k * 4.6]);
  g.add(boxes(truss, lam({ color: 0xf2efe6 })));
  const ducts = [];
  for (const z of [-5, 5]) { const c = new THREE.CylinderGeometry(0.45, 0.45, L, 10); c.rotateZ(Math.PI / 2); c.translate(0, H - 2.6, z); ducts.push(c); }
  g.add(new THREE.Mesh(mergeGeometries(ducts), lam({ color: 0xe9e4d6 })));
  g.add(boxes([[L, 0.12, 0.92, 0, H - 2.6, -5], [L, 0.12, 0.92, 0, H - 2.6, 5]], blueMat));
  const lights = [];
  for (let i = -5; i <= 5; i++) for (let k = -3; k <= 3; k++) {
    const c = new THREE.CylinderGeometry(0.22, 0.32, 0.35, 10); c.translate(i * 4.6 + 2.3, H - 2.2, k * 4.6 + 2.3); lights.push(c);
  }
  g.add(new THREE.Mesh(mergeGeometries(lights), basic({ color: 0xffffff })));
  // basketball backboards, folded up to the ceiling
  const bbMat = std({ color: 0xffffff, transparent: true, opacity: 0.35, roughness: 0.1 });
  const frame = [];
  for (const [x, z, ry] of [[-L / 2 + 3, 0, Math.PI / 2], [L / 2 - 3, 0, -Math.PI / 2], [-9, -W / 2 + 4, 0], [9, -W / 2 + 4, 0], [-9, W / 2 - 4, Math.PI], [9, W / 2 - 4, Math.PI]]) {
    g.add(plane(1.8, 1.05, bbMat, x, 6.2, z, ry));
    frame.push([0.08, H - 6.2, 0.08, x, (H + 6.2) / 2, z], [0.5, 0.05, 0.05, x, 5.65, z, ry]);
  }
  g.add(boxes(frame, lam({ color: 0x222222 })));
  return { bg: 0xd8d0bc, hemi: [0xfffaf0, 0x8a6a45, 1.25] };
}

// ------------------------------------------------------------ FIRST Championship, Houston
function buildHouston(g) {
  const L = 110, W = 80, H = 24;
  const floor = plane(L, W, lam({ color: 0x3b3e44 }), 0, -0.004, 0, 0, -Math.PI / 2);
  floor.receiveShadow = true;
  g.add(floor);
  // the field area: dark carpet and a metal barricade around it
  g.add(plane(30, 18, lam({ color: 0x22252b }), 0, -0.002, 0, 0, -Math.PI / 2));
  const rail = [];
  const rx = HALF_L + 5, rz = HALF_W + 4.5;
  for (const s of [-1, 1]) {
    rail.push([2 * rx, 0.06, 0.06, 0, 1.05, s * rz], [2 * rx, 0.06, 0.06, 0, 0.3, s * rz]);
    rail.push([0.06, 0.06, 2 * rz, s * rx, 1.05, 0], [0.06, 0.06, 2 * rz, s * rx, 0.3, 0]);
    for (let x = -rx; x <= rx; x += 2) rail.push([0.05, 1.1, 0.05, x, 0.55, s * rz]);
    for (let z = -rz; z <= rz; z += 2) rail.push([0.05, 1.1, 0.05, s * rx, 0.55, z]);
  }
  g.add(boxes(rail, lam({ color: 0xb8bcc2 })));
  // stands on all four sides, packed with teams in their colors
  const stand = [], seats = [];
  const rows = 16, rise = 0.5, depth = 0.85;
  const bank = (len, cx, cz, dirx, dirz, start) => {
    const ry = Math.atan2(dirx, dirz);
    for (let r = 0; r < rows; r++) {
      const off = start + r * depth;
      const y = rise * (r + 1);
      const along = dirx ? [depth, y, len] : [len, y, depth];
      stand.push([along[0], along[1], along[2], cx + dirx * (off + depth / 2), y / 2, cz + dirz * (off + depth / 2)]);
      for (let a = -len / 2 + 0.3; a < len / 2; a += 0.55) {
        if ((a * 7.3 + r * 3.1) % 1 < 0.12) continue; // a few empty seats
        seats.push([cx + dirx * (off + 0.4) + (dirx ? 0 : a), y, cz + dirz * (off + 0.4) + (dirz ? 0 : a), ry + Math.PI]);
      }
    }
  };
  bank(70, 0, 0, 0, -1, HALF_W + 7);
  bank(70, 0, 0, 0, 1, HALF_W + 7);
  bank(40, 0, 0, -1, 0, HALF_L + 9);
  bank(40, 0, 0, 1, 0, HALF_L + 9);
  g.add(boxes(stand, lam({ color: 0x8d939b })));
  crowd(g, seats, ['#f5d10f', '#f5d10f', '#2c9b3c', '#ef7a1a', '#1f6fff', '#d12d2d', '#6b3fb5', '#1b1b1b', '#e6e6e6', '#14a0a8', '#f080b0'], 7);
  // ceiling: dark, blue trusses, a grid of stage lights
  g.add(plane(L, W, basic({ color: 0x0c1018 }), 0, H, 0, 0, Math.PI / 2));
  const tr = [];
  for (let i = -8; i <= 8; i++) tr.push([0.5, 0.9, W, i * 6.5, H - 2, 0]);
  for (let k = -5; k <= 5; k++) tr.push([L, 0.4, 0.4, 0, H - 2.6, k * 7]);
  g.add(boxes(tr, lam({ color: 0x1d3a8a })));
  const spots = [];
  for (let i = -16; i <= 16; i++) for (let k = -10; k <= 10; k++) {
    if ((i * 7 + k * 13) % 3) continue;
    const c = new THREE.CylinderGeometry(0.18, 0.18, 0.1, 8); c.translate(i * 3.2, H - 3, k * 3.6); spots.push(c);
  }
  g.add(new THREE.Mesh(mergeGeometries(spots), basic({ color: 0xfffbe8 })));
  // big video screens hanging over the stands: blue | field | red, and the score screens
  const screen = tex(1024, 512, (x, w, h) => {
    x.fillStyle = '#0a0a12'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#1f5fff'; x.fillRect(0, 0, 110, h);
    x.fillStyle = '#e8322f'; x.fillRect(w - 110, 0, 110, h);
    const gr = x.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#30343c'); gr.addColorStop(1, '#5a4a3a');
    x.fillStyle = gr; x.fillRect(110, 0, w - 220, h);
    x.fillStyle = '#2b2f36'; x.fillRect(220, 250, w - 440, 200);
    x.fillStyle = '#fff'; x.font = 'bold 54px Arial'; x.textAlign = 'center';
    x.fillText('FIRST CHAMPIONSHIP', w / 2, 120); x.font = 'bold 36px Arial'; x.fillText('HOUSTON · REBUILT', w / 2, 180);
  });
  const score = tex(512, 160, (x, w, h) => {
    x.fillStyle = '#1f5fff'; x.fillRect(0, 0, w / 2, h); x.fillStyle = '#e8322f'; x.fillRect(w / 2, 0, w / 2, h);
    x.fillStyle = '#fff'; x.font = 'bold 80px Arial'; x.textAlign = 'center';
    x.fillText('92', w / 4, 110); x.fillText('82', (3 * w) / 4, 110);
  });
  const sm = basic({ map: screen }), scm = basic({ map: score });
  const frames = [];
  for (const s of [-1, 1]) {
    for (const x of [-12, 12]) {
      g.add(plane(14, 7, sm, x, 14, s * (HALF_W + 20), s > 0 ? Math.PI : 0));
      frames.push([14.6, 7.6, 0.3, x, 14, s * (HALF_W + 20.2)]);
    }
    for (const x of [-28, 28]) g.add(plane(8, 2.5, scm, x, 13, s * (HALF_W + 22), s > 0 ? Math.PI : 0));
    g.add(plane(10, 5, sm, s * (HALF_L + 24), 13, 0, -s * Math.PI / 2));
  }
  g.add(boxes(frames, lam({ color: 0x15171c })));
  // scoring table and media carts by the field
  g.add(boxes([[5, 0.9, 1.2, 0, 0.45, -HALF_W - 2.6], [1.5, 1.6, 1, -10, 0.8, -HALF_W - 3], [1.5, 1.6, 1, 10, 0.8, HALF_W + 3]], lam({ color: 0x1b1d22 })));
  g.add(boxes([[5.1, 0.25, 1.25, 0, 0.75, -HALF_W - 2.6]], lam({ color: 0x2e9e5b })));
  return { bg: 0x0c1018, hemi: [0xdfe6ff, 0x3a3f4a, 1.05] };
}

// ------------------------------------------------------------ the pits
function buildPits(g) {
  const L = 80, W = 56, H = 12;
  const carpet = tex(128, 128, (x, w, h) => {
    x.fillStyle = '#3a3c40'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#2c2e32'; x.fillRect(0, 0, w / 2, h / 2); x.fillRect(w / 2, h / 2, w / 2, h / 2);
    for (let i = 0; i < 400; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; x.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  }, L / 1.2, W / 1.2);
  const floor = plane(L, W, lam({ map: carpet }), 0, -0.004, 0, 0, -Math.PI / 2);
  floor.receiveShadow = true;
  g.add(floor);
  // ceiling: black with blue arches and lots of round lights
  g.add(plane(L, W, basic({ color: 0x111317 }), 0, H, 0, 0, Math.PI / 2));
  const beams = [];
  for (let i = -6; i <= 6; i++) beams.push([0.6, 0.8, W, i * 6.5, H - 0.6, 0]);
  for (const x of [-26, 26]) for (const z of [-22, 22]) beams.push([0.6, H, 0.6, x, H / 2, z]);
  g.add(boxes(beams, lam({ color: 0x1e3f8f })));
  const lights = [];
  for (let i = -18; i <= 18; i++) for (let k = -12; k <= 12; k++) {
    if ((i + k) % 2) continue;
    const c = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 8); c.translate(i * 2.2, H - 0.05, k * 2.2); lights.push(c);
  }
  g.add(new THREE.Mesh(mergeGeometries(lights), basic({ color: 0xffffff })));
  g.add(plane(L, H, lam({ color: 0xd9d6cf }), 0, H / 2, -W / 2));
  g.add(plane(L, H, lam({ color: 0xd9d6cf }), 0, H / 2, W / 2, Math.PI));
  g.add(plane(W, H, lam({ color: 0xd9d6cf }), -L / 2, H / 2, 0, Math.PI / 2));
  g.add(plane(W, H, lam({ color: 0xd9d6cf }), L / 2, H / 2, 0, -Math.PI / 2));
  // pit booths in rows around the field: red drapes, a team banner, a tool chest, a cart, a robot
  const teams = [
    [115, 'MVRT', '#5b2a86', '#ffcc33'], [107, 'ROBOTICS', '#1b3a8a', '#ffffff'], [33, 'KILLER BEES', '#f5c400', '#111'],
    [254, 'POOFS', '#14284b', '#f5c400'], [1678, 'CITRUS', '#ef7a1a', '#fff'], [118, 'ROBONAUTS', '#c0c4cc', '#1b3a8a'],
    [2056, 'OP', '#111', '#ef3e3e'], [1323, 'MADTOWN', '#2b2b2b', '#e8322f'], [4414, 'HIGHTIDE', '#0d6c8f', '#fff'],
    [1690, 'ORBIT', '#111', '#ffffff'], [7769, 'THE CREW', '#0e3b6b', '#f5c400'], [27, 'RUSH', '#1b3a8a', '#ffcc00'],
    [2481, 'ROBOTEERS', '#c0161c', '#fff'], [3539, 'BYTE DOGS', '#2e9e5b', '#fff'], [67, 'HOT', '#e8322f', '#fff'], [195, 'CYBERKNIGHTS', '#222', '#4da3ff'],
  ];
  const cols = 4;
  const atlas = tex(1024, 1024, (x, w, h) => {
    const cw = w / cols, ch = h / cols;
    teams.forEach(([n, name, bg, fg], i) => {
      const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
      x.fillStyle = bg; x.fillRect(cx + 4, cy + 4, cw - 8, ch - 8);
      x.fillStyle = fg; x.textAlign = 'center'; x.font = 'bold 34px Arial'; x.fillText(name, cx + cw / 2, cy + 70);
      x.font = 'bold 96px Arial'; x.fillText(String(n), cx + cw / 2, cy + 190);
    });
  });
  atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
  const drape = [], low = [], chest = [], cart = [], top = [], bump = [], frame = [], banners = [];
  const booth = (x, z, ry, i) => {
    const c = Math.cos(ry), s = Math.sin(ry);
    const at = (lx, lz) => [x + lx * c + lz * s, z - lx * s + lz * c];
    const push = (arr, w, h, d, lx, y, lz) => { const [px, pz] = at(lx, lz); arr.push([w, h, d, px, y, pz, ry]); };
    push(drape, 3.2, 2.4, 0.05, 0, 1.2, -1.5); // back drape
    push(low, 0.05, 0.9, 3, -1.6, 0.45, 0); push(low, 0.05, 0.9, 3, 1.6, 0.45, 0); // low side drapes
    push(chest, 1.1, 1.0, 0.6, -1.0, 0.5, -1.1);
    push(top, 1.1, 0.04, 0.6, -1.0, 1.02, -1.1);
    push(cart, 0.9, 0.7, 0.6, 0.9, 0.35, -1.1);
    push(bump, 0.85, 0.16, 0.85, 0.2, 0.62, 0.4); // robot on a cart
    push(frame, 0.7, 0.5, 0.7, 0.2, 0.95, 0.4);
    push(cart, 0.9, 0.5, 0.9, 0.2, 0.25, 0.4);
    // banner: a plane on the back drape, mapped to this team's square in the atlas
    const pg = new THREE.PlaneGeometry(1.6, 1.6);
    const t = i % teams.length, u0 = (t % cols) / cols, v0 = 1 - (Math.floor(t / cols) + 1) / cols;
    const uv = pg.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) / cols, v0 + uv.getY(k) / cols);
    pg.rotateY(ry);
    const [bx, bz] = at(0, -1.46);
    pg.translate(bx, 1.55, bz);
    banners.push(pg);
  };
  let i = 0;
  for (const s of [-1, 1]) {
    for (let x = -22; x <= 22; x += 3.4) booth(x, s * (HALF_W + 6.5), s > 0 ? Math.PI : 0, i++);
    for (let x = -22; x <= 22; x += 3.4) booth(x, s * (HALF_W + 12), s > 0 ? 0 : Math.PI, i++);
    for (let z = -6.8; z <= 6.8; z += 3.4) booth(s * (HALF_L + 7), z, s > 0 ? Math.PI / 2 : -Math.PI / 2, i++);
  }
  g.add(boxes(drape, lam({ color: 0xc4161c })));
  g.add(boxes(low, lam({ color: 0xa81418 })));
  g.add(boxes(chest, lam({ color: 0x8e959e })));
  g.add(boxes(top, lam({ color: 0xe8dcc0 })));
  g.add(boxes(cart, lam({ color: 0xd42a2a })));
  g.add(boxes(bump, lam({ color: 0x1f5fff })));
  g.add(boxes(frame, lam({ color: 0x55595f })));
  g.add(new THREE.Mesh(mergeGeometries(banners), basic({ map: atlas })));
  // hanging signs
  const sign = tex(512, 128, (x, w, h) => {
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, w, h); x.fillStyle = '#1f5fff'; x.fillRect(0, 0, w, 26);
    x.fillStyle = '#1b3a8a'; x.font = 'bold 54px Arial'; x.textAlign = 'center'; x.fillText('ROBOT INSPECTION', w / 2, 95);
  });
  const sg = basic({ map: sign, side: THREE.DoubleSide });
  for (const x of [-15, 15]) g.add(plane(4, 1, sg, x, 6, 0));
  return { bg: 0x111317, hemi: [0xffffff, 0x4a4a52, 1.15] };
}

// ------------------------------------------------------------ space
function buildSpace(g) {
  const panel = tex(256, 256, (x, w, h) => {
    x.fillStyle = '#2a2f38'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#141820'; x.lineWidth = 6; x.strokeRect(0, 0, w, h);
    x.strokeStyle = '#3c4350'; x.lineWidth = 2; x.strokeRect(20, 20, w - 40, h - 40);
    x.fillStyle = '#1a1e26'; for (const [a, b] of [[14, 14], [w - 14, 14], [14, h - 14], [w - 14, h - 14]]) { x.beginPath(); x.arc(a, b, 5, 0, 7); x.fill(); }
  }, 16, 10);
  const deck = plane(34, 22, std({ map: panel, metalness: 0.6, roughness: 0.45 }), 0, -0.004, 0, 0, -Math.PI / 2);
  deck.receiveShadow = true;
  g.add(deck);
  g.add(boxes([[34, 0.6, 22, 0, -0.31, 0]], lam({ color: 0x1a1d24 })));
  g.add(boxes([[34.2, 0.08, 0.1, 0, 0.02, 11], [34.2, 0.08, 0.1, 0, 0.02, -11], [0.1, 0.08, 22.2, 17, 0.02, 0], [0.1, 0.08, 22.2, -17, 0.02, 0]], basic({ color: 0x35e0ff })));
  // stars
  const n = 3000, pos = new Float32Array(n * 3), r = rng(3);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u), R = 150 + r() * 30;
    pos[i * 3] = R * s * Math.cos(a); pos[i * 3 + 1] = R * u; pos[i * 3 + 2] = R * s * Math.sin(a);
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: true, fog: false })));
  // a planet and its moon
  const planet = tex(512, 256, (x, w, h) => {
    const cs = ['#c98b4f', '#e2b07a', '#a0603a', '#d9a066', '#f0d0a0', '#b8743f'];
    for (let y = 0; y < h; y += 8) { x.fillStyle = cs[Math.floor((Math.sin(y * 0.11) + 1) * 2.9)]; x.fillRect(0, y, w, 8); }
  });
  const p = new THREE.Mesh(new THREE.SphereGeometry(38, 40, 24), lam({ map: planet }));
  p.position.set(-70, 25, -120);
  g.add(p);
  const ring = new THREE.Mesh(new THREE.RingGeometry(46, 64, 64), basic({ color: 0xd9c49a, transparent: true, opacity: 0.45, side: THREE.DoubleSide }));
  ring.position.copy(p.position); ring.rotation.set(-1.2, 0.3, 0);
  g.add(ring);
  const moon = new THREE.Mesh(new THREE.SphereGeometry(7, 24, 16), lam({ color: 0xb8bcc4 }));
  moon.position.set(90, 40, 60);
  g.add(moon);
  return { bg: 0x020308, hemi: [0xb8c8ff, 0x1a1a2a, 0.75] };
}

// ------------------------------------------------------------ outside
function buildOutside(g) {
  // sky dome: a gradient from horizon haze to blue
  const sky = new THREE.SphereGeometry(185, 32, 16);
  const col = [], top = new THREE.Color(0x3d7fd6), hor = new THREE.Color(0xcfe3f5);
  const pa = sky.attributes.position;
  for (let i = 0; i < pa.count; i++) { const t = Math.max(0, pa.getY(i) / 185); const c = hor.clone().lerp(top, Math.pow(t, 0.6)); col.push(c.r, c.g, c.b); }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.add(new THREE.Mesh(sky, basic({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false })));
  const grass = tex(256, 256, (x, w, h) => {
    x.fillStyle = '#4f8a3a'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 2500; i++) { const s = Math.random(); x.fillStyle = s < 0.5 ? '#5b9a42' : s < 0.8 ? '#447a32' : '#6aa84e'; x.fillRect(Math.random() * w, Math.random() * h, 2, 4); }
  }, 120, 120);
  const ground = plane(360, 360, lam({ map: grass }), 0, -0.004, 0, 0, -Math.PI / 2);
  ground.receiveShadow = true;
  g.add(ground);
  // a mown stripe pattern near the field
  g.add(plane(40, 26, lam({ color: 0x5a9a44, transparent: true, opacity: 0.35 }), 0, -0.002, 0, 0, -Math.PI / 2));
  // trees in a ring, instanced
  const r = rng(11), N = 140;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 3, 6), lam({ color: 0x6b4a2e }), N);
  const leaf = new THREE.InstancedMesh(new THREE.ConeGeometry(2.4, 6, 7), lam({ color: 0x2f6b2a }), N);
  const m = new THREE.Matrix4(), c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const a = r() * Math.PI * 2, d = 30 + r() * 70, s = 0.7 + r() * 0.8;
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    m.makeScale(s, s, s).setPosition(x, 1.5 * s, z); trunk.setMatrixAt(i, m);
    m.makeScale(s, s, s).setPosition(x, 5.5 * s, z); leaf.setMatrixAt(i, m);
    leaf.setColorAt(i, c.setHSL(0.28 + r() * 0.06, 0.45, 0.22 + r() * 0.1));
  }
  g.add(trunk, leaf);
  // a few team canopies and a chain-link fence around the field
  const tent = [], legs = [], fence = [];
  const cols = [0x1f5fff, 0xe8322f, 0xffb000, 0x2e9e5b, 0x7a3cc4];
  [[-14, -11], [-6, -12], [6, -12], [14, -11], [-12, 12], [12, 12]].forEach(([x, z], i) => {
    tent.push({ x, z, c: cols[i % cols.length] });
    for (const [a, b] of [[-1.4, -1.4], [1.4, -1.4], [-1.4, 1.4], [1.4, 1.4]]) legs.push([0.05, 2.4, 0.05, x + a, 1.2, z + b]);
  });
  for (const t of tent) {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.1, 0.8, 4), lam({ color: t.c }));
    roof.position.set(t.x, 2.8, t.z); roof.rotation.y = Math.PI / 4;
    g.add(roof);
  }
  g.add(boxes(legs, lam({ color: 0xcccccc })));
  const fx = HALF_L + 4, fz = HALF_W + 4;
  for (let x = -fx; x <= fx; x += 2.5) fence.push([0.06, 1.8, 0.06, x, 0.9, fz], [0.06, 1.8, 0.06, x, 0.9, -fz]);
  for (let z = -fz; z <= fz; z += 2.5) fence.push([0.06, 1.8, 0.06, fx, 0.9, z], [0.06, 1.8, 0.06, -fx, 0.9, z]);
  fence.push([2 * fx, 0.05, 0.05, 0, 1.8, fz], [2 * fx, 0.05, 0.05, 0, 1.8, -fz], [0.05, 0.05, 2 * fz, fx, 1.8, 0], [0.05, 0.05, 2 * fz, -fx, 1.8, 0]);
  g.add(boxes(fence, lam({ color: 0x9aa0a6 })));
  const mesh = tex(64, 64, (x, w, h) => {
    x.clearRect(0, 0, w, h); x.strokeStyle = 'rgba(170,175,180,0.8)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(0, 0); x.lineTo(w, h); x.moveTo(w, 0); x.lineTo(0, h); x.stroke();
  }, 2 * fx / 0.4, 1.8 / 0.4);
  const mm = basic({ map: mesh, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  g.add(plane(2 * fx, 1.8, mm, 0, 0.9, fz), plane(2 * fx, 1.8, mm, 0, 0.9, -fz));
  const mesh2 = mesh.clone(); mesh2.repeat.set(2 * fz / 0.4, 1.8 / 0.4); mesh2.needsUpdate = true;
  const mm2 = basic({ map: mesh2, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  g.add(plane(2 * fz, 1.8, mm2, fx, 0.9, 0, Math.PI / 2), plane(2 * fz, 1.8, mm2, -fx, 0.9, 0, Math.PI / 2));
  // clouds
  const cl = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), basic({ color: 0xffffff, fog: false }), 40);
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2, d = 90 + r() * 60, k = Math.floor(i / 5);
    m.makeScale(8 + r() * 8, 2 + r() * 2, 5 + r() * 5).setPosition(Math.cos(a + k) * d + r() * 10, 45 + r() * 25, Math.sin(a + k) * d);
    cl.setMatrixAt(i, m);
  }
  g.add(cl);
  return { bg: 0x9ec8ef, hemi: [0xdfefff, 0x4a6a35, 1.3] };
}

const BUILDERS = { rochester: buildRochester, houston: buildHouston, pits: buildPits, space: buildSpace, outside: buildOutside };

export class Maps {
  constructor(scene, hemi) {
    this.scene = scene;
    this.hemi = hemi;
    this.built = {};
    this.current = null;
  }

  /** Show one map (building it the first time), hide the rest. */
  show(id) {
    if (!MAPS.some((m) => m.id === id)) id = 'gym';
    if (!this.built[id]) {
      let look;
      let g;
      if (id === 'gym') { g = buildArena(this.scene); look = { bg: 0x2a2d31, hemi: [0xfff4e0, 0x6b5a45, 1.1] }; }
      else { g = new THREE.Group(); this.scene.add(g); look = BUILDERS[id](g); }
      g.traverse((o) => { if (o.isMesh) o.matrixAutoUpdate = false, o.updateMatrix(); });
      this.built[id] = { g, look };
    }
    for (const [k, v] of Object.entries(this.built)) v.g.visible = k === id;
    const { look } = this.built[id];
    this.scene.background = new THREE.Color(look.bg);
    this.hemi.color.set(look.hemi[0]); this.hemi.groundColor.set(look.hemi[1]); this.hemi.intensity = look.hemi[2];
    this.current = id;
    return id;
  }

  /** A random map, not the one you just played. */
  random() {
    const ids = MAPS.map((m) => m.id).filter((id) => id !== this.current);
    return ids[Math.floor(Math.random() * ids.length)];
  }
}
