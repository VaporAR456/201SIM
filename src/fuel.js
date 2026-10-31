// FUEL: the REBUILT game pieces. Every ball is a Rapier rigid body drawn with one InstancedMesh.
// Balls a robot is holding, or that are waiting to come out of a HUB, are switched off and hidden.
import * as THREE from 'three';
import { IN, HALF_W, BLUE, RED, fieldToWorld, HUB, DEPOT, GROUP, groups } from './constants.js';

export const FUEL_RADIUS = (5.91 * IN) / 2;
const FUEL_MASS = 0.215;
const TOTAL = 504;

export class Fuel {
  constructor(scene, RAPIER, world) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.balls = [];
    const geo = new THREE.SphereGeometry(FUEL_RADIUS, 14, 10);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffd21f, roughness: 0.75 });
    this.mesh = new THREE.InstancedMesh(geo, mat, TOTAL);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);

    const r = FUEL_RADIUS;
    const vol = (4 / 3) * Math.PI * r ** 3;
    for (let i = 0; i < TOTAL; i++) {
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setLinearDamping(0.08)
          .setAngularDamping(0.6)
          .setCcdEnabled(false)
          .setCanSleep(true),
      );
      world.createCollider(
        RAPIER.ColliderDesc.ball(r).setCollisionGroups(groups(GROUP.FUEL)).setDensity(FUEL_MASS / vol).setRestitution(0.45).setFriction(0.5),
        body,
      );
      this.balls.push({ body, active: true, id: i });
    }
    this.tmpM = new THREE.Matrix4();
    this.tmpQ = new THREE.Quaternion();
    this.tmpP = new THREE.Vector3();
    this.zero = new THREE.Vector3(0, 0, 0);
    this.one = new THREE.Vector3(1, 1, 1);
  }

  /** Lay out the match-start FUEL: the NEUTRAL ZONE field, both DEPOTS. Returns the leftover balls. */
  reset() {
    let i = 0;
    const place = (x, y, z) => {
      const b = this.balls[i++];
      this.enable(b, x, y, z, 0, 0, 0);
      b.body.sleep(); // resting FUEL costs nothing until something touches it
    };
    // NEUTRAL ZONE: a 12 x 30 grid in the middle of the field
    const gap = FUEL_RADIUS * 2 + 0.012;
    for (let a = 0; a < 12; a++) {
      for (let c = 0; c < 30; c++) {
        place((a - 5.5) * gap, FUEL_RADIUS + 0.002, (c - 14.5) * gap);
      }
    }
    // DEPOTS: 24 each, two rows against the alliance wall
    for (const al of [BLUE, RED]) {
      for (let k = 0; k < 24; k++) {
        const fx = DEPOT.depth * 0.25 + (k % 2) * gap;
        const fy = DEPOT.fy - (5.5 * gap) + Math.floor(k / 2) * gap;
        const p = fieldToWorld(fx, fy, al);
        place(p.x, FUEL_RADIUS + 0.03, p.z);
      }
    }
    // the rest start out of play (preloads, OUTPOST chutes)
    const spare = [];
    for (; i < this.balls.length; i++) {
      this.disable(this.balls[i]);
      spare.push(this.balls[i]);
    }
    return spare;
  }

  enable(b, x, y, z, vx, vy, vz) {
    b.active = true;
    b.body.setEnabled(true);
    b.body.setTranslation({ x, y, z }, true);
    b.body.setLinvel({ x: vx, y: vy, z: vz }, true);
    b.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // fast shots need continuous collision so they can't tunnel through the HUB walls
    b.body.enableCcd(Math.hypot(vx, vy, vz) > 3);
    b.body.wakeUp();
  }

  disable(b) {
    b.active = false;
    b.body.setEnabled(false);
    b.body.setTranslation({ x: 0, y: -10 - b.id * 0.01, z: 0 }, false);
  }

  /** A switched-off ball to launch or drop, or null if every ball is in play. */
  takeSpare() {
    return this.balls.find((b) => !b.active) || null;
  }

  /** Copy physics to the instanced mesh. */
  sync() {
    for (const b of this.balls) {
      if (b.active) {
        const p = b.body.translation();
        const q = b.body.rotation();
        this.tmpP.set(p.x, p.y, p.z);
        this.tmpQ.set(q.x, q.y, q.z, q.w);
        this.tmpM.compose(this.tmpP, this.tmpQ, this.one);
      } else {
        this.tmpM.compose(this.tmpP.set(0, -20, 0), this.tmpQ.identity(), this.zero);
      }
      this.mesh.setMatrixAt(b.id, this.tmpM);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Where each alliance's HUB is, in world coordinates. */
export function hubCenter(alliance) {
  const p = fieldToWorld(HUB.fx, HALF_W, alliance);
  return { x: p.x, z: p.z };
}
