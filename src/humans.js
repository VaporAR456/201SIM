// Human players standing behind each OUTPOST. Simple low-poly people; ours winds up and throws
// whenever the sim's human player launches a FUEL.
import * as THREE from 'three';
import { HALF_L, BLUE, RED, OUTPOST, fieldToWorld } from './constants.js';

function person(shirt) {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0xc89878 });
  const cloth = new THREE.MeshLambertMaterial({ color: shirt });
  const dark = new THREE.MeshLambertMaterial({ color: 0x24262b });
  const part = (geo, mat, x, y, z, parent = g) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m; };
  part(new THREE.CylinderGeometry(0.075, 0.07, 0.85, 8), dark, 0, 0.425, -0.1);
  part(new THREE.CylinderGeometry(0.075, 0.07, 0.85, 8), dark, 0, 0.425, 0.1);
  part(new THREE.BoxGeometry(0.24, 0.6, 0.42), cloth, 0, 1.15, 0);
  part(new THREE.SphereGeometry(0.11, 12, 10), skin, 0, 1.58, 0);
  // safety glasses / cap brim so you can tell which way they face
  part(new THREE.BoxGeometry(0.06, 0.04, 0.2), dark, 0.1, 1.6, 0);
  const arm = (z) => {
    const pivot = new THREE.Group();
    pivot.position.set(0, 1.4, z);
    g.add(pivot);
    part(new THREE.CylinderGeometry(0.05, 0.045, 0.62, 8), cloth, 0, -0.31, 0, pivot);
    part(new THREE.SphereGeometry(0.055, 8, 6), skin, 0, -0.64, 0, pivot);
    return pivot;
  };
  g.userData.armL = arm(-0.27);
  g.userData.armR = arm(0.27);
  return g;
}

export class Humans {
  constructor(scene) {
    this.people = {};
    for (const al of [BLUE, RED]) {
      const p = person(al === BLUE ? 0x1f6fff : 0xe8322f);
      const o = fieldToWorld(OUTPOST.depth / 2, OUTPOST.fy, al);
      const sign = al === BLUE ? -1 : 1;
      p.position.set(sign * (HALF_L + 1.15), 0, o.z); // behind the OUTPOST chute
      // face the field (+X for blue)
      p.rotation.y = al === BLUE ? 0 : Math.PI;
      scene.add(p);
      this.people[al] = { g: p, t: 99, idle: Math.random() * 6 };
    }
  }

  throwBall(al) { this.people[al].t = 0; }

  update(dt) {
    for (const h of Object.values(this.people)) {
      h.t += dt; h.idle += dt;
      const { armR, armL } = h.g.userData;
      // arms hang, swaying a little; a throw winds back then whips forward over the head
      let r = 0.1 * Math.sin(h.idle * 1.3);
      if (h.t < 0.6) {
        const k = h.t / 0.6;
        r = k < 0.35 ? -(k / 0.35) * 2.6 : -2.6 + ((k - 0.35) / 0.65) * 3.4;
      } else if (h.t < 1.0) r = 0.8 * (1 - (h.t - 0.6) / 0.4);
      // rotation about z swings the arm forward (+X local) and back
      armR.rotation.z = r;
      armL.rotation.z = 0.1 * Math.sin(h.idle * 1.3 + 1);
    }
  }
}
