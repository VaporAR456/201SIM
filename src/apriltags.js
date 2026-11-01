// Draw the field's AprilTags (tag36h11) as real, readable tags: one small texture atlas and a
// single merged mesh, so all 32 cost one draw call.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TAGS, TAG_BITS } from './apriltagData.js';

const CELLS = 10; // 1 white border cell, 1 black border cell, 6 data cells, 1 black, 1 white
const SIZE = 0.206; // 8.125in printed tag (6.5in black square)

function drawTag(ctx, ox, code) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(ox, 0, CELLS, CELLS);
  ctx.fillStyle = '#000';
  ctx.fillRect(ox + 1, 1, CELLS - 2, CELLS - 2);
  ctx.fillStyle = '#fff';
  const c = BigInt(`0x${code}`);
  const n = TAG_BITS.x.length;
  for (let i = 0; i < n; i++) {
    if ((c >> BigInt(n - 1 - i)) & 1n) ctx.fillRect(ox + TAG_BITS.x[i] + 1, TAG_BITS.y[i] + 1, 1, 1);
  }
}

export function buildAprilTags(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = CELLS * TAGS.length;
  canvas.height = CELLS;
  const ctx = canvas.getContext('2d');
  TAGS.forEach((t, i) => drawTag(ctx, i * CELLS, t.code));
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;

  const geos = TAGS.map((t, i) => {
    const g = new THREE.PlaneGeometry(SIZE, SIZE);
    const uv = g.attributes.uv;
    for (let k = 0; k < uv.count; k++) uv.setX(k, (i + uv.getX(k)) / TAGS.length);
    // the plane faces +Z; turn it to face along the tag's normal, upright
    g.rotateY(Math.atan2(t.n[0], t.n[2]));
    // out past the clear cover that sits in front of some of the vinyl tags
    g.translate(t.p[0] + t.n[0] * 0.011, t.p[1], t.p[2] + t.n[2] * 0.011);
    return g;
  });
  const mesh = new THREE.Mesh(mergeGeometries(geos), new THREE.MeshLambertMaterial({ map: tex }));
  mesh.name = 'apriltags';
  scene.add(mesh);
  return mesh;
}
