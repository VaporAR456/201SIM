// The HUB lights: the diffuser band around the top of each HUB (y 1.27-1.51 m in the field CAD).
// Lit in the alliance's color while its HUB counts, gray while it's off, and flashing for the last
// few seconds before it changes.
import * as THREE from 'three';
import { BLUE, RED } from './constants.js';
import { hubCenter } from './fuel.js';

const WARN = 3; // seconds of flashing before a change
const ON = { [BLUE]: new THREE.Color(0x2f7dff), [RED]: new THREE.Color(0xff2d2d) };
const OFF = new THREE.Color(0x4a4e54);

export class HubLights {
  constructor(scene) {
    this.mats = {};
    for (const al of [BLUE, RED]) {
      const c = hubCenter(al);
      const mat = new THREE.MeshBasicMaterial({ color: ON[al].clone(), toneMapped: false, transparent: true, opacity: 0.92 });
      this.mats[al] = mat;
      const half = 0.6, h = 0.24, y = 1.39, t = 0.012;
      for (const [w, d, x, z] of [[2 * half, t, 0, half], [2 * half, t, 0, -half], [t, 2 * half, half, 0], [t, 2 * half, -half, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
        m.position.set(c.x + x, y, c.z + z);
        scene.add(m);
      }
    }
    this.t = 0;
  }

  /** Is `al`'s HUB going to be on a moment after the current period ends? */
  nextActive(match, al) {
    const ph = match.phase();
    const t0 = match.t;
    match.t = t0 + ph.left + 0.05;
    const on = match.phase().name !== 'MATCH OVER' && match.isActive(al);
    match.t = t0;
    return on;
  }

  update(match, dt) {
    this.t += dt;
    const live = match.on && !match.over;
    const ph = live ? match.phase() : null;
    for (const al of [BLUE, RED]) {
      const on = match.on ? live && match.isActive(al) : true;
      let col = on ? ON[al] : OFF;
      // about to change: flash
      if (live && ph.left < WARN && this.nextActive(match, al) !== on) {
        if (Math.floor(this.t * 6) % 2) col = on ? OFF : ON[al];
      }
      this.mats[al].color.copy(col);
    }
  }
}
