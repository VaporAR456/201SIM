// The room around the field: a school gym with a wood floor, bleachers, banners and ceiling
// lights. All static and merged into a few meshes so it costs almost nothing to draw.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HALF_L, HALF_W } from './constants.js';

const ROOM_L = 46; // along the field's length
const ROOM_W = 34;
const ROOM_H = 12;

function canvasTexture(w, h, draw, repeatX = 1, repeatY = 1) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 4;
  return t;
}

export function buildArena(scene) {
  const g = new THREE.Group();
  scene.add(g);

  // ---------------------------------------------------------- maple floor with court lines
  const wood = canvasTexture(512, 512, (x, w, h) => {
    x.fillStyle = '#c8955a';
    x.fillRect(0, 0, w, h);
    const rows = 16;
    for (let r = 0; r < rows; r++) {
      const y = (r * h) / rows;
      let off = (r * 97) % 200;
      for (let px = -off; px < w; px += 180 + ((r * 31) % 70)) {
        const shade = 180 + ((px * 7 + r * 13) % 30);
        x.fillStyle = `rgb(${shade + 20}, ${shade - 30}, ${shade - 95})`;
        x.fillRect(px, y + 1, 178, h / rows - 2);
      }
      x.fillStyle = 'rgba(70,40,10,0.35)';
      x.fillRect(0, y, w, 1);
    }
  }, 10, 10);
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ROOM_L, ROOM_W),
    new THREE.MeshStandardMaterial({ map: wood, roughness: 0.55, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.004;
  floor.receiveShadow = true;
  g.add(floor);

  // ---------------------------------------------------------- walls: painted block, team-color stripe
  const block = canvasTexture(256, 256, (x, w, h) => {
    x.fillStyle = '#e6e1d6';
    x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(120,110,95,0.35)';
    x.lineWidth = 2;
    for (let r = 0; r < 8; r++) {
      const y = (r * h) / 8;
      x.beginPath(); x.moveTo(0, y); x.lineTo(w, y); x.stroke();
      for (let c = 0; c < 4; c++) {
        const xx = c * (w / 4) + (r % 2) * (w / 8);
        x.beginPath(); x.moveTo(xx, y); x.lineTo(xx, y + h / 8); x.stroke();
      }
    }
  }, 1, 1);
  const wallMat = new THREE.MeshStandardMaterial({ map: block, roughness: 0.9 });
  const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1b3a8a, roughness: 0.8 });
  const walls = [];
  const stripes = [];
  for (const [len, x, z, ry] of [
    [ROOM_L, 0, -ROOM_W / 2, 0], [ROOM_L, 0, ROOM_W / 2, Math.PI],
    [ROOM_W, -ROOM_L / 2, 0, Math.PI / 2], [ROOM_W, ROOM_L / 2, 0, -Math.PI / 2],
  ]) {
    const w = new THREE.PlaneGeometry(len, ROOM_H);
    w.rotateY(ry);
    w.translate(x, ROOM_H / 2, z);
    walls.push(w);
    const s = new THREE.PlaneGeometry(len, 1.2);
    s.rotateY(ry);
    s.translate(x * 0.999, 1.6, z * 0.999);
    stripes.push(s);
  }
  block.repeat.set(10, 3);
  g.add(new THREE.Mesh(mergeGeometries(walls), wallMat));
  g.add(new THREE.Mesh(mergeGeometries(stripes), stripeMat));

  // ---------------------------------------------------------- bleachers along both long sides
  const seats = [];
  const rails = [];
  for (const side of [-1, 1]) {
    const z0 = side * (HALF_W + 3.2);
    for (let r = 0; r < 9; r++) {
      const depth = 0.75;
      const rise = 0.42;
      const b = new THREE.BoxGeometry(28, rise * (r + 1), depth);
      b.translate(0, (rise * (r + 1)) / 2, z0 + side * (r * depth + depth / 2));
      seats.push(b);
    }
    const rail = new THREE.BoxGeometry(28, 0.05, 0.05);
    rail.translate(0, 9 * 0.42 + 0.9, z0 + side * 9 * 0.75);
    rails.push(rail);
  }
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x6d7a88, roughness: 0.6, metalness: 0.3 });
  const bleachers = new THREE.Mesh(mergeGeometries(seats), seatMat);
  bleachers.receiveShadow = true;
  g.add(bleachers);
  g.add(new THREE.Mesh(mergeGeometries(rails), new THREE.MeshStandardMaterial({ color: 0x9aa3ab, metalness: 0.7, roughness: 0.3 })));

  // ---------------------------------------------------------- banners on the long walls
  const bannerColors = ['#1f6fff', '#e8322f', '#ffb000', '#1b3a8a', '#2e9e5b', '#7a3cc4'];
  const bannerTex = canvasTexture(1536, 256, (x, w, h) => {
    const n = bannerColors.length;
    for (let i = 0; i < n; i++) {
      x.fillStyle = bannerColors[i];
      x.fillRect((i * w) / n + 8, 0, w / n - 16, h);
      x.fillStyle = 'rgba(255,255,255,0.9)';
      x.font = 'bold 64px Arial, sans-serif';
      x.textAlign = 'center';
      x.fillText(['FRC', '201', 'REBUILT', 'FIRST', '2026', 'FEDS'][i], (i + 0.5) * (w / n), h * 0.62);
    }
  });
  for (const side of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.PlaneGeometry(24, 4), new THREE.MeshBasicMaterial({ map: bannerTex }));
    b.position.set(0, 8.2, side * (ROOM_W / 2 - 0.05));
    if (side > 0) b.rotation.y = Math.PI;
    g.add(b);
  }

  // ---------------------------------------------------------- ceiling: trusses and light panels
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_L, ROOM_W), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = ROOM_H;
  g.add(ceiling);
  const trusses = [];
  for (let i = -4; i <= 4; i++) {
    const t = new THREE.BoxGeometry(0.25, 0.6, ROOM_W);
    t.translate(i * 5, ROOM_H - 0.8, 0);
    trusses.push(t);
  }
  g.add(new THREE.Mesh(mergeGeometries(trusses), new THREE.MeshStandardMaterial({ color: 0x4a5058, metalness: 0.5, roughness: 0.5 })));
  const lights = [];
  for (let i = -4; i <= 4; i++) {
    for (let j = -2; j <= 2; j++) {
      const l = new THREE.BoxGeometry(1.4, 0.08, 0.7);
      l.translate(i * 5, ROOM_H - 1.2, j * 5);
      lights.push(l);
    }
  }
  g.add(new THREE.Mesh(mergeGeometries(lights), new THREE.MeshBasicMaterial({ color: 0xfff6e0 })));

  // scoring table and a few carts behind the alliance walls, just for scale
  const props = [];
  for (const s of [-1, 1]) {
    const t = new THREE.BoxGeometry(1.2, 0.9, 3.5);
    t.translate(s * (HALF_L + 3.2), 0.45, -HALF_W + 1.5);
    props.push(t);
  }
  g.add(new THREE.Mesh(mergeGeometries(props), new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.7 })));

  return g;
}
