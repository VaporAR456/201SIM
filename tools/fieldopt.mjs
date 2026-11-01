// Turn the official REBUILT field CAD into a light web model: drop the FUEL (the sim has its own),
// hardware and tiny parts, bake part colors into vertices, keep the clear panels see-through,
// simplify, and merge into a handful of draw calls.
import { NodeIO, getBounds } from '@gltf-transform/core';
import { prune, dedup, simplify, join, flatten, quantize, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions((await import('@gltf-transform/extensions')).ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(process.argv[2] || 'field-raw.glb');
const root = doc.getRoot();
const scene = root.listScenes()[0];
const junk = /Fuel\b|bolt|screw|\bnut\b|washer|rivet|cable tie|PEM |hinge|REV-|bearing|1756A|hook tape|seaming tape|spacer|standoff|insert|bushing|collar|pin\b|clip/i;
const glass = /glass|polycarb|lexan|clear/i;
let dropped = 0, clear = 0;
scene.traverse((n) => {
  const m = n.getMesh();
  if (!m) return;
  const name = n.getName();
  let parent = name;
  if (junk.test(name)) { n.setMesh(null); dropped++; return; }
  // tiny parts are invisible at field scale
  const b = getBounds(n);
  const size = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (size < 0.04) { n.setMesh(null); dropped++; return; }
  n.setExtras({ glass: glass.test(parent), carpet: /carpet/i.test(name) });
  if (glass.test(parent)) clear++;
  n.setName(''); m.setName('');
});
// glass-ness can come from an ancestor's name too
scene.traverse((n) => { if (glass.test(n.getName())) n.traverse((c) => { if (c.getMesh()) { c.setExtras({ glass: true }); } }); });
console.log('dropped', dropped, 'clear', clear);
// red alliance is at -X in the CAD; the sim puts blue there, so turn the field around
const top = scene.listChildren()[0];
top.setRotation([0, 1, 0, 0]);
await doc.transform(prune(), dedup(), flatten());
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) for (const sem of p.listSemantics()) if (sem !== 'POSITION') p.setAttribute(sem, null);
const solid = doc.createMaterial('field').setMetallicFactor(0.1).setRoughnessFactor(0.8);
const clearMat = doc.createMaterial('field_clear').setMetallicFactor(0).setRoughnessFactor(0.1).setBaseColorFactor([0.8, 0.88, 0.95, 0.18]).setAlphaMode('BLEND').setDoubleSided(true);
// group meshes: glass vs solid, and by area so frustum culling still helps
const groups = {};
for (const n of scene.listChildren()) {
  const m = n.getMesh();
  if (!m) continue;
  const isGlass = !!n.getExtras().glass;
  for (const p of m.listPrimitives()) {
    if (isGlass) { p.setMaterial(clearMat); continue; }
    // the CAD carpet is plain white; real field carpet is dark gray
    const c = n.getExtras().carpet ? [0.16, 0.17, 0.18, 1] : p.getMaterial()?.getBaseColorFactor() ?? [0.6, 0.6, 0.6, 1];
    const cnt = p.getAttribute('POSITION').getCount();
    const col = new Float32Array(cnt * 3);
    for (let i = 0; i < cnt; i++) col.set([c[0], c[1], c[2]], i * 3);
    p.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(p.getAttribute('POSITION').getBuffer()));
    p.setMaterial(solid);
  }
  const b = getBounds(n);
  const cx = (b.min[0] + b.max[0]) / 2;
  const key = (isGlass ? 'clear_' : 'solid_') + (cx < -4 ? 'a' : cx > 4 ? 'c' : 'b');
  const g = groups[key] ??= (() => { const x = doc.createNode(key); scene.addChild(x); return x; })();
  g.addChild(n);
}
const count = (l) => { let t = 0; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) t += (p.getIndices()?.getCount() ?? 0) / 3; console.log(l, 'tris', t); };
count('before');
// weld near-equal seam vertices so the simplifier can work across B-rep faces
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const pos = p.getAttribute('POSITION'); let idx = p.getIndices();
  if (!idx) continue;
  const a = pos.getArray(); const map = new Map(); const out = []; const remap = new Uint32Array(pos.getCount());
  for (let i = 0; i < pos.getCount(); i++) {
    const k = Math.round(a[i*3]*2000)+','+Math.round(a[i*3+1]*2000)+','+Math.round(a[i*3+2]*2000);
    let j = map.get(k); if (j === undefined) { j = out.length/3; map.set(k, j); out.push(a[i*3], a[i*3+1], a[i*3+2]); }
    remap[i] = j;
  }
  const col = p.getAttribute('COLOR_0');
  if (col) { const ca = col.getArray(); const nc = new Float32Array(out.length); for (let i = 0; i < pos.getCount(); i++) nc.set(ca.subarray(i*3, i*3+3), remap[i]*3); col.setArray(nc); }
  const ia = idx.getArray(); const ni = new Uint32Array(ia.length);
  for (let i = 0; i < ia.length; i++) ni[i] = remap[ia[i]];
  pos.setArray(new Float32Array(out)); idx.setArray(ni);
}
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.0, error: Number(process.env.ERR || 0.02), lockBorder: false }));
count('simplified');
await doc.transform(join({ keepNamed: true }), prune(), dedup(), quantize({ quantizePosition: 16 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
count('final');
console.log('bounds', JSON.stringify(getBounds(scene)));
await io.write(process.argv[3] || 'field.glb', doc);
