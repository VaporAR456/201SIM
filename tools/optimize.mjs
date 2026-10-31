import { NodeIO, getBounds } from '@gltf-transform/core';
import { prune, dedup, weld, simplify, join, flatten, quantize, meshopt, instance } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions((await import('@gltf-transform/extensions')).ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read('robot-raw.glb');
const root = doc.getRoot();
const scene = root.listScenes()[0];
const robot = scene.listChildren()[0];

// 1. drop hardware that is invisible at sim scale
const junk = /rivet|screw|nut\b|locknut|washer|SHCS|BHCS|ziptie|spacer|collar|bearing|end screw|origin cube|powerpole|tube plug/i;
let dropped = 0;
robot.traverse(n => { if (n.getMesh() && junk.test(n.getName())) { n.setMesh(null); dropped++; } });

// 2. tag subassemblies and swerve wheels before flattening
const SUB = { 'Chassis': 'chassis', 'Spindexer': 'spindexer', 'Kicker': 'shooter', 'Intake': 'intake' };
let wheel = 0;
for (const sub of robot.listChildren()) {
  const tag = Object.entries(SUB).find(([k]) => sub.getName().startsWith(k))?.[1] ?? 'other';
  sub.traverse(n => {
    if (!n.getMesh()) return;
    if (/SDS MK5 Molded Wheel/.test(n.getName())) n.setName(`wheel_${wheel++}`);
    else n.setName('');
    n.setExtras({ part: tag });
  });
  sub.setName(tag);
}
console.log('dropped', dropped, 'wheels', wheel);

// 3. put the robot in sim coordinates: intake (CAD +Z) forward = +X, wheels on the ground
robot.setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
robot.setTranslation([0, 0.0508, 0]);

await doc.transform(prune(), dedup(), flatten());
// flatten moves meshes to the scene root; regroup them under one node per subassembly
const groups = {};
for (const n of scene.listChildren()) {
  if (!n.getMesh()) continue;
  const tag = n.getExtras().part || 'other';
  const g = groups[tag] ??= (() => { const x = doc.createNode(tag); scene.addChild(x); return x; })();
  g.addChild(n);
}
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { for (const sem of p.listSemantics()) if (sem !== 'POSITION') p.setAttribute(sem, null); }
const count = (l) => { let t=0, v=0; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) { t += (p.getIndices()?.getCount() ?? 0)/3; v += p.getAttribute('POSITION').getCount(); } console.log(l, 'tris', t, 'verts', v); };
count('before');
// OCC writes each B-rep face separately, with near-equal (not identical) seam vertices: snap and merge
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) {
  const pos = p.getAttribute('POSITION'); let idx = p.getIndices();
  if (!idx) { idx = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from({ length: pos.getCount() }, (_, i) => i)).setBuffer(pos.getBuffer()); p.setIndices(idx); }
  const a = pos.getArray(); const map = new Map(); const out = []; const remap = new Uint32Array(pos.getCount());
  for (let i = 0; i < pos.getCount(); i++) {
    const k = Math.round(a[i*3]*3000)+','+Math.round(a[i*3+1]*3000)+','+Math.round(a[i*3+2]*3000);
    let j = map.get(k); if (j === undefined) { j = out.length/3; map.set(k, j); out.push(a[i*3], a[i*3+1], a[i*3+2]); }
    remap[i] = j;
  }
  const ia = idx.getArray(); const ni = new Uint32Array(ia.length);
  for (let i = 0; i < ia.length; i++) ni[i] = remap[ia[i]];
  pos.setArray(new Float32Array(out)); idx.setArray(ni);
}
count('welded');
await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: 0.0, error: Number(process.env.ERR || 0.004), lockBorder: false }));
count('simplified');
await doc.transform(
  join({ keepNamed: true }),
  prune(),
  dedup(),
  quantize({ quantizePosition: 14 }),
  meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
);
let tris = 0; for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices().getCount()/3;
console.log('meshes', root.listMeshes().length, 'tris', tris, 'bounds', JSON.stringify(getBounds(scene)));
for (const n of scene.listChildren()) console.log(n.getName(), n.listChildren().length, n.listChildren().filter(c=>c.getName().startsWith('wheel')).map(c=>c.getName()+JSON.stringify(getBounds(c).min.map((v,i)=>((v+getBounds(c).max[i])/2).toFixed(3)))).join(' '));
await io.write('robot201.glb', doc);
