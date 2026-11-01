// 201's robot: a swerve drive on a Rapier rigid body, with a three.js model.
import * as THREE from 'three';
import { BLUE, GROUP, groups } from './constants.js';

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
    // Free to pitch and roll so it tilts over the BUMPS; the heavy bumpers and belly keep the
    // center of mass low so it settles back instead of tipping.

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
      this.intakeX = L + cfg.intakeReach / 2;
      this.intakeY = cfg.bumperBottom + ih;
      this.intakeCollider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(cfg.intakeReach / 2, ih, cfg.intakeWidth / 2)
          // the intake doesn't catch on BUMPS, and lets FUEL through to be collected
          .setCollisionGroups(groups(GROUP.INTAKE, 0xffff & ~GROUP.TERRAIN & ~GROUP.FUEL))
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
    this.speedScale = cfg.speedLevels[cfg.speedLevels.length - 1];
    this.fieldForward = 0;
    this.moduleAngles = [0, 0, 0, 0];
    this.wheelSpin = [0, 0, 0, 0];
  }

  buildPlaceholder() {
    const cfg = this.cfg;
    const g = new THREE.Group();
    const allianceColor = this.alliance === BLUE ? 0x1f6fff : 0xe8322f;
    const bumperMat = new THREE.MeshStandardMaterial({ color: allianceColor, roughness: 0.85, flatShading: true, side: THREE.DoubleSide });
    this.bumperMat = bumperMat;
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2b2f33, metalness: 0.5, roughness: 0.5 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.5 });

    const L = this.halfL * 2;
    const W = this.halfW * 2;
    const t = cfg.bumperThickness;
    const h = cfg.bumperHeight;
    const y = cfg.bumperBottom + h / 2;
    const bumpers = new THREE.Group();
    this.root.add(bumpers);
    let target = bumpers;
    const add = (geo, mat, x, yy, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, yy, z);
      m.castShadow = true;
      m.receiveShadow = true;
      target.add(m);
      return m;
    };
    // Bumpers: a padded ring at the CAD bumper size and height, rounded at the corners like the
    // real fabric covers, with big white 201s on every side
    const ring = new THREE.Shape();
    const rr = 0.05;
    const rect = (path, hx, hz, rad) => {
      path.moveTo(-hx + rad, -hz);
      path.lineTo(hx - rad, -hz); path.quadraticCurveTo(hx, -hz, hx, -hz + rad);
      path.lineTo(hx, hz - rad); path.quadraticCurveTo(hx, hz, hx - rad, hz);
      path.lineTo(-hx + rad, hz); path.quadraticCurveTo(-hx, hz, -hx, hz - rad);
      path.lineTo(-hx, -hz + rad); path.quadraticCurveTo(-hx, -hz, -hx + rad, -hz);
    };
    const bev = 0.018;
    rect(ring, L / 2 - bev, W / 2 - bev, rr);
    const hole = new THREE.Path();
    rect(hole, L / 2 - t + bev, W / 2 - t + bev, 0.01);
    ring.holes.push(hole);
    const ringGeo = new THREE.ExtrudeGeometry(ring, { depth: h - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 4 });
    ringGeo.rotateX(Math.PI / 2);
    ringGeo.translate(0, y + h / 2 - bev, 0);
    this.bumperBoxes = [add(ringGeo, bumperMat, 0, 0, 0)];
    // team numbers
    const num = makeNumberTexture('201');
    const plateMat = new THREE.MeshBasicMaterial({ map: num, transparent: true, depthWrite: false });
    const ph = h * 0.86;
    for (const [px, pz, ry, wdt] of [[0, W / 2 + 0.002, 0, 0.44], [0, -W / 2 - 0.002, Math.PI, 0.44], [L / 2 + 0.002, 0, Math.PI / 2, 0.36], [-L / 2 - 0.002, 0, -Math.PI / 2, 0.36]]) {
      const p = add(new THREE.PlaneGeometry(wdt, ph), plateMat, px, y, pz);
      p.rotation.y = ry;
      p.castShadow = false;
    }
    target = g;
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

  /**
   * Move the expanding hopper (and the intake on its end). pos and out are inches; `out` is the
   * fully-out position shown in the CAD.
   */
  setHopper(pos, out) {
    const off = (pos - out) * 0.0254;
    if (this.intakeNode) this.intakeNode.position.x = this.intakeBase + off;
    if (this.intakeCollider) {
      this.intakeCollider.setTranslationWrtParent({ x: this.intakeX + off, y: this.intakeY, z: 0 });
      this.intakeCollider.setEnabled(pos > out / 2);
    }
  }

  /** Spin the spindexer while it feeds the shooter. */
  spinIndexer(dt) {
    if (this.spindexerPivot) this.spindexerPivot.rotation.y += dt * 9;
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
    // Each part's color is baked into its vertices, so the whole robot is a handful of draw calls.
    const cadMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, metalness: 0.2, roughness: 0.6 });
    object3d.traverse((o) => {
      if (!o.isMesh) return;
      if (o.name === 'bumper_mesh' || o.material?.name === 'bumper') {
        // the CAD bumper is only a thin outline; the padded bumper built at its size stands in
        o.visible = false;
        return;
      }
      o.material = o.geometry.attributes.color ? cadMat
        : new THREE.MeshStandardMaterial({ color: o.material.color, flatShading: true, metalness: 0.2, roughness: 0.6 });
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

    // Moving parts: the intake slides with the expanding hopper; the spindexer spins
    const intake = object3d.getObjectByName('intake');
    if (intake) { this.intakeNode = intake; this.intakeBase = intake.position.x; }
    const spx = object3d.getObjectByName('spindexer');
    if (spx) {
      const c = new THREE.Box3().setFromObject(spx).getCenter(new THREE.Vector3());
      this.root.worldToLocal(c);
      const pivot = new THREE.Group();
      pivot.position.set(c.x, 0, c.z);
      this.root.add(pivot);
      pivot.attach(spx);
      this.spindexerPivot = pivot;
    }
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
    // heading of the robot's forward (+X) axis, ignoring pitch and roll
    const q = this.body.rotation();
    const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const fz = 2 * (q.x * q.z - q.w * q.y);
    return Math.atan2(-fz, fx);
  }

  /**
   * Turn driver input into a chassis velocity, limited by the robot's acceleration, and apply it.
   * forward / strafe / turn are in [-1, 1].
   */
  drive(forward, strafe, turn, dt) {
    const cfg = this.cfg;
    const scale = this.speedScale;
    const yaw = this.yaw();

    // Desired velocity in the world frame
    const v = Math.min(1, Math.hypot(forward, strafe)) * cfg.maxSpeed * scale;
    const n = Math.hypot(forward, strafe) || 1;
    const f = (forward / n) * v;
    const s = (strafe / n) * v;
    const ref = !this.fieldRelative ? yaw : this.driveRef ?? this.fieldForward;
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
    // keep whatever pitch/roll the BUMPS give it, with a little damping so it settles
    this.body.setAngvel({ x: av.x * 0.97, y: omega, z: av.z * 0.97 }, true);
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
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.font = 'italic 900 150px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 86, 500);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
