// Builds the REBUILT field: visuals in three.js and static colliders in Rapier.
import * as THREE from 'three';
import {
  IN, FIELD_L, FIELD_W, HALF_L, HALF_W, BLUE, RED, fieldToWorld, ALLIANCE_ZONE_DEPTH,
  WALL, HUB, BUMP, TRENCH, TOWER, DEPOT, OUTPOST, COLORS, GROUP, groups,
} from './constants.js';

export function buildField(scene, RAPIER, world) {
  const group = new THREE.Group();
  scene.add(group);

  const mat = {
    carpet: new THREE.MeshStandardMaterial({ color: COLORS.carpet, roughness: 0.95 }),
    tape: new THREE.MeshBasicMaterial({ color: COLORS.tape }),
    steel: new THREE.MeshStandardMaterial({ color: COLORS.steel, metalness: 0.6, roughness: 0.4 }),
    poly: new THREE.MeshStandardMaterial({ color: COLORS.poly, transparent: true, opacity: 0.18, roughness: 0.1 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23272b, roughness: 0.8 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xb08a5a, roughness: 0.8 }),
    [BLUE]: new THREE.MeshStandardMaterial({ color: COLORS.blue, roughness: 0.6 }),
    [RED]: new THREE.MeshStandardMaterial({ color: COLORS.red, roughness: 0.6 }),
    tapeBlue: new THREE.MeshBasicMaterial({ color: COLORS.blue }),
    tapeRed: new THREE.MeshBasicMaterial({ color: COLORS.red }),
  };

  // Fixed body that every static collider hangs off
  const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const collider = (desc, x, y, z, rotY = 0) => {
    desc.setTranslation(x, y, z).setFriction(0.8);
    if (rotY) desc.setRotation(quatY(rotY));
    world.createCollider(desc, fixed);
  };

  // A box: visual + collider. Position is the box center.
  const box = (w, h, d, x, y, z, material, { solid = true, shadow = true } = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    m.receiveShadow = true;
    group.add(m);
    if (solid) collider(RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), x, y, z);
    return m;
  };

  // ------------------------------------------------------------ carpet and outer area
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), new THREE.MeshStandardMaterial({ color: 0x15181b, roughness: 1 }));
  outer.rotation.x = -Math.PI / 2;
  outer.position.y = -0.005;
  outer.receiveShadow = true;
  group.add(outer);

  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(FIELD_L, FIELD_W), mat.carpet);
  carpet.rotation.x = -Math.PI / 2;
  carpet.receiveShadow = true;
  group.add(carpet);
  collider(RAPIER.ColliderDesc.cuboid(HALF_L + 2, 0.5, HALF_W + 2), 0, -0.5, 0);

  // Tape lines (flat strips just above the carpet)
  const tape = (x, z, len, alongX, material = mat.tape, w = 2 * IN) => {
    const g = new THREE.PlaneGeometry(alongX ? len : w, alongX ? w : len);
    const m = new THREE.Mesh(g, material);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.002, z);
    group.add(m);
  };
  tape(0, 0, FIELD_W, false); // center line
  for (const a of [BLUE, RED]) {
    const { x } = fieldToWorld(ALLIANCE_ZONE_DEPTH, 0, a);
    tape(x, 0, FIELD_W, false, a === BLUE ? mat.tapeBlue : mat.tapeRed, 2 * IN);
  }

  // ------------------------------------------------------------ guardrails and alliance walls
  const t = WALL.thick;
  for (const s of [-1, 1]) {
    box(FIELD_L + 2 * t, WALL.sideHeight, t, 0, WALL.sideHeight / 2, s * (HALF_W + t / 2), mat.poly, { shadow: false });
    // steel cap along the top of the guardrail
    box(FIELD_L, 0.04, 0.05, 0, WALL.sideHeight, s * (HALF_W + t / 2), mat.steel, { solid: false });
  }
  for (const a of [BLUE, RED]) {
    const s = a === BLUE ? -1 : 1;
    const x = s * (HALF_L + t / 2);
    // lower kick plate in alliance color, glass above
    box(t, 0.9, FIELD_W, x, 0.45, 0, mat[a]);
    box(t, WALL.allianceHeight - 0.9, FIELD_W, x, 0.9 + (WALL.allianceHeight - 0.9) / 2, 0, mat.poly, { shadow: false });
  }

  // ------------------------------------------------------------ alliance-side elements
  for (const a of [BLUE, RED]) {
    const side = a === BLUE ? 1 : -1; // red is the blue layout turned 180 degrees
    const at = (fx, fy) => fieldToWorld(fx, fy, a);

    // HUB: a 47in box with a hexagonal funnel on top
    {
      const p = at(HUB.fx, HALF_W);
      const boxH = 1.5;
      box(HUB.size, boxH, HUB.size, p.x, boxH / 2, p.z, mat.dark);
      // alliance-colored band
      box(HUB.size + 0.01, 0.12, HUB.size + 0.01, p.x, boxH - 0.2, p.z, mat[a], { solid: false });
      // funnel (open hexagon) up to the 72in rim
      const rimR = HUB.openingAcross / 2 / Math.cos(Math.PI / 6);
      const funnelH = HUB.rim - boxH;
      const funnel = new THREE.Mesh(
        new THREE.CylinderGeometry(rimR, rimR - 0.68 * funnelH, funnelH, 6, 1, true),
        new THREE.MeshStandardMaterial({ color: COLORS.poly, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      );
      funnel.position.set(p.x, boxH + funnelH / 2, p.z);
      funnel.rotation.y = Math.PI / 6;
      group.add(funnel);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.02, 6, 6), mat[a]);
      rim.rotation.x = Math.PI / 2;
      rim.rotation.z = Math.PI / 6;
      rim.position.set(p.x, HUB.rim, p.z);
      group.add(rim);
      // funnel walls: six thin panels at the rim, open on top so FUEL can drop in and score
      const apo = HUB.openingAcross / 2;
      const edge = rimR; // a regular hexagon's side equals its circumradius
      for (let k = 0; k < 6; k++) {
        const th = (k * Math.PI) / 3;
        collider(
          RAPIER.ColliderDesc.cuboid(edge / 2 + 0.02, funnelH / 2, 0.01),
          p.x + apo * Math.sin(th), boxH + funnelH / 2, p.z + apo * Math.cos(th), th,
        );
      }
    }

    // BUMPS either side of the HUB: ramps robots drive over
    for (const s of [-1, 1]) {
      const fy = HALF_W + s * (HUB.size / 2 + BUMP.width / 2);
      const p = at(HUB.fx, fy);
      addBump(group, collider, RAPIER, p.x, p.z, mat[a]);
    }

    // TRENCHES along each guardrail: an opening under an arm, then a skirt next to the BUMP
    for (const s of [-1, 1]) {
      // fy measured from the near guardrail
      const edgeFy = s < 0 ? 0 : FIELD_W;
      const inward = s < 0 ? 1 : -1;
      const openMid = at(HUB.fx, edgeFy + inward * (TRENCH.clearWidth / 2));
      const skirtW = TRENCH.width - TRENCH.clearWidth;
      const skirtMid = at(HUB.fx, edgeFy + inward * (TRENCH.clearWidth + skirtW / 2));
      // skirt (solid, robots can't cross it)
      box(TRENCH.depth, TRENCH.skirtHeight, skirtW, skirtMid.x, TRENCH.skirtHeight / 2, skirtMid.z, mat.dark);
      // arm across the opening; robots taller than 22.25in hit it
      const armH = TRENCH.armTop - TRENCH.clearHeight;
      box(6 * IN, armH, TRENCH.clearWidth, openMid.x, TRENCH.clearHeight + armH / 2, openMid.z, mat[a]);
      // posts holding the AprilTag mount
      box(6 * IN, TRENCH.tagTop - TRENCH.armTop, 11.5 * IN, openMid.x, TRENCH.armTop + (TRENCH.tagTop - TRENCH.armTop) / 2, openMid.z, mat.steel);
    }

    // TOWER against the alliance wall
    {
      const p = at(TOWER.depth / 2, TOWER.fy);
      box(TOWER.baseDepth, 0.0064, TOWER.baseWidth, p.x, 0.0032, p.z, mat.steel, { solid: false });
      for (const s of [-1, 1]) {
        const up = at(TOWER.depth / 2, TOWER.fy + s * TOWER.uprightGap / 2);
        box(3.5 * IN, TOWER.uprightHeight, 1.5 * IN, up.x, TOWER.uprightHeight / 2, up.z, mat.steel);
      }
      // rungs (visual only for now; climbing comes later)
      for (const h of [27, 45, 63]) {
        const r = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, TOWER.uprightGap + 0.3, 12), mat.steel);
        r.rotation.x = Math.PI / 2;
        r.position.set(p.x + side * 0.1, h * IN, p.z);
        r.castShadow = true;
        group.add(r);
      }
      // backboard
      box(1 * IN, TOWER.height, TOWER.width, at(1 * IN, TOWER.fy).x, TOWER.height / 2, p.z, mat[a]);
    }

    // DEPOT floor marking against the alliance wall
    {
      const p = at(DEPOT.depth / 2, DEPOT.fy);
      const m = new THREE.Mesh(new THREE.BoxGeometry(DEPOT.depth, DEPOT.barrierH, DEPOT.width), mat.wood);
      m.position.set(p.x, DEPOT.barrierH / 2, p.z);
      m.receiveShadow = true;
      group.add(m);
    }

    // OUTPOST (human player station) in the alliance wall corner
    {
      const p = at(OUTPOST.depth / 2, OUTPOST.fy);
      box(OUTPOST.depth, 8 * IN, OUTPOST.width, p.x, 4 * IN, p.z, mat[a]);
    }
  }

  return group;
}

function addBump(group, collider, RAPIER, x, z, material) {
  // Cross-section along X: ramp up, flat top, ramp down
  const d = BUMP.depth / 2;
  const top = BUMP.topDepth / 2;
  const h = BUMP.height;
  const w = BUMP.width / 2;
  const profile = [[-d, 0], [-top, h], [top, h], [d, 0]];
  const verts = [];
  for (const [px, py] of profile) {
    verts.push(px, py, -w, px, py, w);
  }
  const pts = new Float32Array(verts);
  // BUMPS are their own group so the low intake can ride over them
  const desc = RAPIER.ColliderDesc.convexHull(pts).setCollisionGroups(groups(GROUP.TERRAIN));
  collider(desc, x, 0, z);

  const shape = new THREE.Shape();
  shape.moveTo(-d, 0);
  shape.lineTo(-top, h);
  shape.lineTo(top, h);
  shape.lineTo(d, 0);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: BUMP.width, bevelEnabled: false });
  geo.translate(0, 0, -w);
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, 0, z);
  m.castShadow = true;
  m.receiveShadow = true;
  group.add(m);
}

function quatY(a) {
  return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) };
}
