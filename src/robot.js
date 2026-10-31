// 201's robot: a swerve drive on a Rapier rigid body, with a three.js model.
import * as THREE from 'three';
import { BLUE } from './constants.js';

const tmp = new THREE.Vector3();

export class Robot {
  constructor(scene, RAPIER, world, cfg, alliance = BLUE) {
    this.cfg = cfg;
    this.world = world;
    this.alliance = alliance;

    const L = cfg.frameLength / 2 + cfg.bumperThickness;
    const W = cfg.frameWidth / 2 + cfg.bumperThickness;
    this.halfL = L;
    this.halfW = W;

    // ---------------------------------------------------------- physics
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setLinearDamping(0)
        .setAngularDamping(0),
    );
    // Keep the chassis level: swerve bots don't roll over in normal play, and it keeps the
    // feel predictable going over the BUMPS.
    body.setEnabledRotations(false, true, false, true);

    // Bumpers: the main collision shape, rounded so it rides up the BUMP ramps
    const bH = cfg.bumperHeight / 2;
    const r = 0.02;
    const bumper = RAPIER.ColliderDesc.roundCuboid(L - r, bH - r, W - r, r)
      .setTranslation(0, cfg.bumperBottom + bH, 0)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.05)
      .setDensity(1);
    // Superstructure: frame-sized, up to the robot's real height (catches the TRENCH arm)
    const supH = (cfg.height - cfg.bumperBottom - cfg.bumperHeight) / 2;
    const sup = RAPIER.ColliderDesc.cuboid(cfg.frameLength / 2 - 0.02, supH, cfg.frameWidth / 2 - 0.02)
      .setTranslation(0, cfg.bumperBottom + cfg.bumperHeight + supH, 0)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setDensity(0.2);
    // Skids under the frame, so the body rests on the carpet at bumper height
    const skid = RAPIER.ColliderDesc.ball(cfg.bumperBottom)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setDensity(0.1);
    this.colliders = [world.createCollider(bumper, body), world.createCollider(sup, body)];
    for (const [mx, mz] of cfg.modules) {
      world.createCollider(skid.setTranslation(mx, cfg.bumperBottom, mz), body);
    }
    // Deployed intake sticking out past the front bumper
    if (cfg.intakeReach > 0) {
      const ih = 0.06;
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(cfg.intakeReach / 2, ih, cfg.intakeWidth / 2)
          .setTranslation(L + cfg.intakeReach / 2, cfg.bumperBottom + ih, 0)
          .setFriction(0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setDensity(0.05),
        body,
      );
    }
    // Scale density so total mass matches the config
    const m = body.mass();
    for (let i = 0; i < body.numColliders(); i++) {
      const c = body.collider(i);
      c.setDensity(c.density() * (cfg.mass / m));
    }
    this.body = body;
    this.modulePos = cfg.modules;

    // ---------------------------------------------------------- visuals
    this.root = new THREE.Group();
    scene.add(this.root);
    this.placeholder = this.buildPlaceholder();
    this.root.add(this.placeholder);
    this.cadModel = null;

    // ---------------------------------------------------------- drive state
    this.cmd = { vx: 0, vz: 0, omega: 0 };
    this.fieldRelative = true;
    this.fieldForward = 0;
    this.moduleAngles = [0, 0, 0, 0];
    this.wheelSpin = [0, 0, 0, 0];
  }

  buildPlaceholder() {
    const cfg = this.cfg;
    const g = new THREE.Group();
    const allianceColor = this.alliance === BLUE ? 0x1f6fff : 0xe8322f;
    const bumperMat = new THREE.MeshStandardMaterial({ color: allianceColor, roughness: 0.7 });
    this.bumperMat = bumperMat;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.5, roughness: 0.5 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.5 });

    const L = this.halfL * 2;
    const W = this.halfW * 2;
    const t = cfg.bumperThickness;
    const h = cfg.bumperHeight;
    const y = cfg.bumperBottom + h / 2;
    const add = (geo, mat, x, yy, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, yy, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    // bumpers
    add(new THREE.BoxGeometry(L, h, t), bumperMat, 0, y, W / 2 - t / 2);
    add(new THREE.BoxGeometry(L, h, t), bumperMat, 0, y, -W / 2 + t / 2);
    add(new THREE.BoxGeometry(t, h, W - 2 * t), bumperMat, L / 2 - t / 2, y, 0);
    add(new THREE.BoxGeometry(t, h, W - 2 * t), bumperMat, -L / 2 + t / 2, y, 0);
    // team number plates
    const num = makeNumberTexture('201');
    const plateMat = new THREE.MeshBasicMaterial({ map: num, transparent: true });
    for (const s of [-1, 1]) {
      const p = add(new THREE.PlaneGeometry(0.3, 0.1), plateMat, 0, y, s * (W / 2 + 0.002));
      if (s < 0) p.rotation.y = Math.PI;
    }
    // belly pan and superstructure block
    add(new THREE.BoxGeometry(cfg.frameLength, 0.02, cfg.frameWidth), frameMat, 0, cfg.bumperBottom + 0.01, 0);
    const supH = cfg.height - cfg.bumperBottom - h;
    add(new THREE.BoxGeometry(cfg.frameLength * 0.7, supH, cfg.frameWidth * 0.7), frameMat, -0.03, cfg.bumperBottom + h + supH / 2, 0);
    // front marker so drivers can see which way is forward
    add(new THREE.BoxGeometry(0.04, 0.03, cfg.frameWidth * 0.5), accent, cfg.frameLength / 2 - 0.05, cfg.height - 0.02, 0);

    // swerve modules: a steering housing and a wheel each
    this.moduleMeshes = [];
    const wheelGeo = new THREE.CylinderGeometry(cfg.wheelRadius, cfg.wheelRadius, 0.04, 20);
    wheelGeo.rotateX(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xff7a00, roughness: 0.5 });
    for (const [mx, mz] of this.modulePos) {
      const steer = new THREE.Group();
      steer.position.set(mx, cfg.wheelRadius, mz);
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.castShadow = true;
      const hub = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.045), hubMat);
      wheel.add(hub);
      steer.add(wheel);
      g.add(steer);
      this.moduleMeshes.push({ steer, wheel });
    }
    return g;
  }

  /** Swap the placeholder body for the converted team CAD, keeping the swerve module visuals. */
  setCadModel(object3d) {
    if (this.cadModel) this.root.remove(this.cadModel);
    this.cadModel = object3d;

    // Sit the model on the carpet
    const box = new THREE.Box3().setFromObject(object3d);
    object3d.position.y -= box.min.y;

    // CAD materials export as fully metallic; give them a plain painted look instead.
    // The web model has no normals (smaller file), so shade it flat.
    const cache = new Map();
    object3d.traverse((o) => {
      if (!o.isMesh) return;
      const key = o.material.color.getHexString();
      if (!cache.has(key)) {
        cache.set(key, new THREE.MeshStandardMaterial({
          color: o.material.color, flatShading: true, metalness: 0.25, roughness: 0.6,
        }));
      }
      o.material = cache.get(key);
      o.castShadow = true;
      o.receiveShadow = true;
    });

    // Steering pivots for the four swerve wheels, matched to the nearest module position
    this.root.add(object3d);
    object3d.updateMatrixWorld(true);
    const wheels = [];
    object3d.traverse((o) => { if (/^wheel_\d/.test(o.name)) wheels.push(o); });
    const cadModules = [];
    for (const w of wheels) {
      const c = new THREE.Box3().setFromObject(w).getCenter(new THREE.Vector3());
      this.root.worldToLocal(c);
      let best = 0, bestD = Infinity;
      this.modulePos.forEach(([mx, mz], i) => {
        const d = Math.hypot(c.x - mx, c.z - mz);
        if (d < bestD) { bestD = d; best = i; }
      });
      const pivot = new THREE.Group();
      pivot.position.set(c.x, c.y, c.z);
      this.root.add(pivot);
      pivot.attach(w);
      cadModules[best] = pivot;
    }
    this.cadModules = cadModules;
    this.placeholder.visible = false;
  }

  reset(x, z, yaw) {
    const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
    this.body.setTranslation({ x, y: 0.01, z }, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.cmd = { vx: 0, vz: 0, omega: 0 };
  }

  yaw() {
    const q = this.body.rotation();
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
  }

  /**
   * Turn driver input into a chassis velocity, limited by the robot's acceleration, and apply it.
   * forward / strafe / turn are in [-1, 1].
   */
  drive(forward, strafe, turn, slow, dt) {
    const cfg = this.cfg;
    const scale = slow ? cfg.slowModeScale : 1;
    const yaw = this.yaw();

    // Desired velocity in the world frame
    const v = Math.min(1, Math.hypot(forward, strafe)) * cfg.maxSpeed * scale;
    const n = Math.hypot(forward, strafe) || 1;
    const f = (forward / n) * v;
    const s = (strafe / n) * v;
    const ref = this.fieldRelative ? this.fieldForward : yaw;
    // rotate (forward, right) from the reference heading into world X/Z
    const c = Math.cos(ref), sn = Math.sin(ref);
    let dvx = f * c + s * sn;
    let dvz = -f * sn + s * c;
    const dOmega = -turn * cfg.maxOmega * scale; // stick right turns clockwise

    // Start from what the robot is actually doing (walls and robots stop it)
    const lv = this.body.linvel();
    const av = this.body.angvel();
    let vx = lv.x, vz = lv.z;
    let ex = dvx - vx, ez = dvz - vz;
    const e = Math.hypot(ex, ez);
    const maxDv = cfg.maxAccel * dt;
    if (e > maxDv) { ex *= maxDv / e; ez *= maxDv / e; }
    vx += ex; vz += ez;
    let omega = av.y;
    const eo = dOmega - omega;
    omega += Math.max(-cfg.maxAlpha * dt, Math.min(cfg.maxAlpha * dt, eo));

    this.body.setLinvel({ x: vx, y: lv.y, z: vz }, true);
    this.body.setAngvel({ x: 0, y: omega, z: 0 }, true);
    this.cmd = { vx, vz, omega };
  }

  /** Copy the physics pose onto the model and animate the swerve modules. */
  sync(dt) {
    const p = this.body.translation();
    const q = this.body.rotation();
    this.root.position.set(p.x, p.y, p.z);
    this.root.quaternion.set(q.x, q.y, q.z, q.w);

    // Module states from chassis velocity in the robot frame
    const yaw = this.yaw();
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const { vx, vz, omega } = this.cmd;
    const lx = vx * c - vz * s; // world -> robot frame
    const lz = vx * s + vz * c;
    this.modulePos.forEach(([mx, mz], i) => {
      const mvx = lx + omega * mz;
      const mvz = lz - omega * mx;
      const speed = Math.hypot(mvx, mvz);
      if (speed > 0.05) {
        let target = Math.atan2(-mvz, mvx);
        // swerve modules flip direction rather than turn more than 90 degrees
        let cur = this.moduleAngles[i];
        let d = wrap(target - cur);
        let dir = 1;
        if (Math.abs(d) > Math.PI / 2) { d = wrap(d - Math.PI); dir = -1; }
        cur += Math.max(-dt * 20, Math.min(dt * 20, d));
        this.moduleAngles[i] = cur;
        this.wheelSpin[i] += (dir * speed * dt) / this.cfg.wheelRadius;
      }
      const m = this.moduleMeshes[i];
      m.steer.rotation.y = this.moduleAngles[i];
      m.wheel.rotation.z = -this.wheelSpin[i];
      if (this.cadModules?.[i]) this.cadModules[i].rotation.y = this.moduleAngles[i];
    });
  }

  speed() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  position(out = tmp) {
    const p = this.body.translation();
    return out.set(p.x, p.y, p.z);
  }
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function makeNumberTexture(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.font = 'bold 84px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 52);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
