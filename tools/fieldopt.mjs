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
const glass = /glass|polycarb|lexan|clear|Station Window$|Station Window <\d+>$/i;
let dropped = 0, clear = 0;
// The CAD is nearly all plain gray. Paint the alliance-colored parts by name (red is at -X in the CAD).
const BLUE = [0.05, 0.22, 0.75], RED = [0.78, 0.07, 0.07];
const tint = (c, k) => c.map((v) => v + (1 - v) * k);
const WHITE = [0.88, 0.89, 0.9], BLACK = [0.04, 0.04, 0.05], TEAL = [0.55, 0.78, 0.82];
// first match wins; matched against the part's full assembly path
const paint = [
  [/Glass|Polycarb/i, null],
  [/AprilTag/, () => [0.92, 0.92, 0.92]],
  [/Hub Net\b|Hub Net \(|Hub Net Pole/, () => BLACK],
  [/Hub Side Panel|Hub Front Panel|Hub Rear Panel|Plastic and Vinyl/, () => TEAL],
  [/Hub Roof|Hub Light|Light Assembly|Diffuser/, (al) => al],
  [/Hub Funnel|Hub Ramp|Hub Internal Wall/, () => WHITE],
  [/GE-26300: Hub/, () => WHITE],
  [/Bump/, (al) => al],
  [/Trench/, (al) => al],
  [/Tower (Upright|Rung|Brace|Base)|GE-26502|GE-26503|GE-26504/, (al) => al],
  [/Tower|Outpost/, () => WHITE],
  [/Sponsor Panel|GE-26901|Tread Plate/, () => WHITE],
  [/Driver Station|Guardrail|Perimeter|am-28|am-29/, () => BLACK],
  [/Depot/, () => [0.5, 0.5, 0.52]],
  [/SCORING TABLE/, () => [0.12, 0.12, 0.13]],
];
const pathOf = new Map();
const walkNames = (n, path) => { const p = path + ' / ' + n.getName(); pathOf.set(n, p); for (const c of n.listChildren()) walkNames(c, p); };
for (const n of scene.listChildren()) walkNames(n, '');
scene.traverse((n) => {
  const m = n.getMesh();
  if (!m) return;
  const path = pathOf.get(n) || '';
  // parts the CAD colors pure red or pure blue take the color of the side they're on
  const base = m.listPrimitives()[0]?.getMaterial()?.getBaseColorFactor();
  if (base && ((base[0] > 0.9 && base[1] < 0.1 && base[2] < 0.1) || (base[2] > 0.9 && base[0] < 0.1 && base[1] < 0.1))) {
    const b = getBounds(n);
    n.setExtras({ ...n.getExtras(), paint: (b.min[0] + b.max[0]) / 2 < 0 ? RED : BLUE });
    return;
  }
  const rule = paint.find(([re]) => re.test(path));
  if (rule && rule[1]) {
    const b = getBounds(n);
    const al = (b.min[0] + b.max[0]) / 2 < 0 ? RED : BLUE;
    n.setExtras({ ...n.getExtras(), paint: rule[1](al) });
  }
});
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
  n.setExtras({ ...n.getExtras(), glass: glass.test(parent), carpet: /carpet/i.test(name) });
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
const seenMesh = new Set();
for (const n of scene.listChildren()) {
  let m = n.getMesh();
  if (!m) continue;
  // one mesh can be shared by mirrored copies on both sides of the field: give each copy its own
  // so its vertex colors can differ
  if (seenMesh.has(m)) {
    const copy = doc.createMesh();
    for (const p of m.listPrimitives()) {
      const np = doc.createPrimitive().setMaterial(p.getMaterial()).setAttribute('POSITION', p.getAttribute('POSITION').clone());
      if (p.getIndices()) np.setIndices(p.getIndices().clone());
      copy.addPrimitive(np);
    }
    m = copy;
    n.setMesh(m);
  }
  seenMesh.add(m);
  const isGlass = !!n.getExtras().glass;
  for (const p of m.listPrimitives()) {
    if (isGlass) { p.setMaterial(clearMat); continue; }
    // the CAD carpet is plain white; real field carpet is mid gray
    const ex = n.getExtras();
    let c = ex.carpet ? [0.42, 0.43, 0.45, 1] : ex.paint ?? p.getMaterial()?.getBaseColorFactor() ?? [0.6, 0.6, 0.6, 1];
    // bare aluminum reads as flat white under gym lights; tone it down
    if (!ex.paint && !ex.carpet && c[0] > 0.75 && Math.abs(c[0] - c[2]) < 0.02) c = [0.62, 0.63, 0.65];
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
