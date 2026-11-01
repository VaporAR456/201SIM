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
        .setCcdEnabled(false) // CCD against the FUEL riding inside it made turning stutter
        .setLinearDamping(0)
        .setAngularDamping(0),
    );
    // Free to pitch and roll so it tilts over the BUMPS; the heavy bumpers and belly keep the
    // center of mass low so it settles back instead of tipping.

    // Bumpers: a ring of four rounded strips (rounded so they ride up the BUMP ramps); the
    // middle is open so FUEL can sit inside the hopper
    const bH = cfg.bumperHeight / 2;
    const r = 0.02;
    const t = cfg.bumperThickness / 2;
    const bumperPart = (hx, hz, x, z) => RAPIER.ColliderDesc.roundCuboid(hx - r, bH - r, hz - r, r)
      .setTranslation(x, cfg.bumperBottom + bH, z)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.05)
      .setDensity(1);
    this.colliders = [
      world.createCollider(bumperPart(L, t, 0, W - t), body),
      world.createCollider(bumperPart(L, t, 0, -W + t), body),
      world.createCollider(bumperPart(t, W - 2 * t, L - t, 0), body),
      world.createCollider(bumperPart(t, W - 2 * t, -L + t, 0), body),
    ];
    // The hopper, built from simple boxes so FUEL can roll around inside the robot:
    // a floor, the shooter/spindexer tower at the back, side plates, and the net on top.
    const hb = cfg.hopper.box;
    const solid = (desc, x, y, z, density = 0.4) => world.createCollider(
      desc.setTranslation(x, y, z).setFriction(0.3).setDensity(density), body);
    // belly pan / hopper floor
    solid(RAPIER.ColliderDesc.cuboid(L - 2 * t, 0.02, W - 2 * t), 0, hb.floorY - 0.02, 0, 0.6);
    // tower at the back (also what hits the TRENCH arm)
    const towerLen = hb.rearX + L - 2 * t;
    solid(RAPIER.ColliderDesc.cuboid(towerLen / 2, (cfg.height - hb.floorY) / 2, W - 2 * t), -L + 2 * t + towerLen / 2, (cfg.height + hb.floorY) / 2, 0, 0.6);
    // side plates
    // (they reach up to the net, and back into the tower, so there's no gap for FUEL to slip through)
    const sideH = (hb.netY + 0.04 - hb.floorY) / 2;
    const sideBack = -L + 2 * t;
    const sideLen = (L - sideBack) / 2;
    // the solid part stops below the robot's height so it still fits under the TRENCH arm;
    // above that, up to the net, only FUEL feels it
    const solidTop = cfg.height - 0.01;
    const sH = (solidTop - hb.floorY) / 2, uH = (hb.netY + 0.04 - solidTop) / 2;
    for (const sz of [-1, 1]) {
      solid(RAPIER.ColliderDesc.cuboid(sideLen, sH, 0.03), sideBack + sideLen, hb.floorY + sH, sz * (hb.halfW + 0.03), 0.2);
      world.createCollider(RAPIER.ColliderDesc.cuboid(sideLen, uH, 0.03).setCollisionGroups(groups(GROUP.INTAKE, GROUP.FUEL | GROUP.HELD))
        .setTranslation(sideBack + sideLen, solidTop + uH, sz * (hb.halfW + 0.03)).setFriction(0.3).setDensity(0), body);
    }
    // the net over the fixed part of the hopper (only stops FUEL)
    const fuelOnly = groups(GROUP.INTAKE, GROUP.FUEL | GROUP.HELD);
    this.netColliders = [world.createCollider(
      RAPIER.ColliderDesc.cuboid((L - hb.rearX) / 2, 0.02, hb.halfW + 0.05).setCollisionGroups(fuelOnly)
        .setTranslation((L + hb.rearX) / 2, hb.netY + 0.02, 0).setDensity(0).setFriction(0.2), body)];
    // the part that slides out with the intake: front wall, side extensions, more net
    const ext = 0.42;
    this.hopperFront = L - 0.1;
    this.slide = [
      // low lip at the front: always there
      { c: world.createCollider(RAPIER.ColliderDesc.cuboid(0.02, (hb.frontTop - hb.floorY) / 2, hb.halfW + 0.05).setCollisionGroups(fuelOnly).setDensity(0).setFriction(0.3), body),
        dx: 0.02, y: (hb.frontTop + hb.floorY) / 2, z: 0 },
      ...[-1, 1].map((sz) => ({
        c: world.createCollider(RAPIER.ColliderDesc.cuboid(ext / 2, sideH, 0.03).setCollisionGroups(fuelOnly).setDensity(0).setFriction(0.3), body),
        dx: -ext / 2, y: hb.floorY + sideH, z: sz * (hb.halfW + 0.03) })),
      { c: world.createCollider(RAPIER.ColliderDesc.cuboid(ext / 2, 0.02, hb.halfW + 0.05).setCollisionGroups(fuelOnly).setDensity(0).setFriction(0.2), body),
        dx: -ext / 2, y: hb.netY + 0.02, z: 0, net: true },
      // a floor under the slid-out part
      { c: world.createCollider(RAPIER.ColliderDesc.cuboid(ext / 2, 0.02, hb.halfW + 0.05).setCollisionGroups(fuelOnly).setDensity(0).setFriction(0.3), body),
        dx: -ext / 2, y: hb.floorY - 0.02, z: 0 },
    ];
    this.netColliders.push(this.slide[3].c);
    // above the lip, the intake opening: a one-way door. FUEL the rollers are feeding passes
    // through it (see Game.collect); FUEL already inside can't fall back out the front.
    this.gate = { c: world.createCollider(RAPIER.ColliderDesc.cuboid(0.02, (hb.netY - hb.frontTop) / 2, hb.halfW + 0.05).setCollisionGroups(groups(GROUP.GATE, GROUP.FUEL | GROUP.HELD)).setDensity(0).setFriction(0.3), body),
      dx: 0.02, y: (hb.netY + hb.frontTop) / 2, z: 0 };
    this.slide.push(this.gate);
    // Skids under the frame, so the body rests on the carpet at bumper height
    const skid = RAPIER.ColliderDesc.ball(cfg.bumperBottom)
      .setFriction(0)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setDensity(0.1);
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
          .setCollisionGroups(groups(GROUP.INTAKE, 0xffff & ~GROUP.TERRAIN & ~GROUP.FUEL & ~GROUP.HELD))
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
    // is it off the ground? (a ray down from the middle of the belly to the carpet or a BUMP)
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const groundGroups = groups(0xffff, GROUP.FIELD | GROUP.TERRAIN);
    this.airborne = () => {
      const p = body.translation();
      ray.origin = { x: p.x, y: p.y + 0.3, z: p.z };
      const hit = world.castRay(ray, 0.5, true, undefined, groundGroups, undefined, body);
      return !hit || hit.toi > 0.3 + 0.09;
    };

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
    // bumper fabric: smooth padded shape with a fine cordura weave
    const bumperMat = new THREE.MeshStandardMaterial({ color: allianceColor, map: fabricTexture(), roughness: 0.9, side: THREE.DoubleSide });
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
    const ph = h * 0.95;
    for (const [px, pz, ry, wdt] of [[0, W / 2 + 0.002, 0, 0.5], [0, -W / 2 - 0.002, Math.PI, 0.5], [L / 2 + 0.002, 0, Math.PI / 2, 0.42], [-L / 2 - 0.002, 0, -Math.PI / 2, 0.42]]) {
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
    // the hopper's front wall rides with the intake: at the front bumper when fully out
    this.hopperFront = this.halfL + off - 0.1; // the back of the intake
    for (const s of this.slide) s.c.setTranslationWrtParent({ x: this.hopperFront + s.dx, y: s.y, z: s.z });
    if (this.intakeNode) this.intakeNode.position.x = this.intakeBase + off;
    if (this.intakeCollider) {
      this.intakeCollider.setTranslationWrtParent({ x: this.intakeX + off, y: this.intakeY, z: 0 });
      this.intakeCollider.setEnabled(pos > out / 2);
    }
  }

  /** The net stops FUEL leaving the top of the hopper, until it tears. */
  setNet(intact) {
    for (const c of this.netColliders) c.setEnabled(intact);
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
    this.snapshot(true);
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

    // How far the robot is tipped from upright. Real 201 is low and heavy: it tilts over the
    // BUMPS but doesn't go over, so past a small tilt it is pushed back flat, and if it ever does
    // end up on its side it is set back on its wheels.
    const q = this.body.rotation();
    const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x);
    const tilt = Math.acos(Math.max(-1, Math.min(1, uy)));
    if (tilt > 1.0) {
      const p = this.body.translation();
      const h = yaw / 2;
      this.body.setRotation({ x: 0, y: Math.sin(h), z: 0, w: Math.cos(h) }, true);
      this.body.setTranslation({ x: p.x, y: Math.max(p.y, 0.05), z: p.z }, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.cmd = { vx: 0, vz: 0, omega: 0 };
      return;
    }
    // wheels lose grip as it tips up on two wheels, and have none in the air
    let grip = Math.max(0, Math.min(1, (uy - 0.6) / 0.2));
    if (this.airborne?.()) grip = 0;
    vx = lv.x + (vx - lv.x) * grip;
    vz = lv.z + (vz - lv.z) * grip;
    let ax = av.x * 0.97, az = av.z * 0.97;
    const over = tilt - 0.5; // ~29 degrees of free tilt: the BUMP ramps are ~22
    if (over > 0) {
      // turn about (up x Y) to bring up back to vertical
      const n = Math.hypot(uz, ux) || 1;
      const k = 40 * over * dt;
      ax += (-uz / n) * k;
      az += (ux / n) * k;
      // and don't let it keep rotating further over
      const away = -(ax * -uz + az * ux) / n;
      if (away > 0) { ax += (-uz / n) * away; az += (ux / n) * away; }
    }
    // a 138 lb robot cresting a BUMP hops, it doesn't launch: cap how fast it can rise
    this.body.setLinvel({ x: vx, y: Math.min(lv.y, 0.7), z: vz }, true);
    // keep whatever pitch/roll the BUMPS give it, with a little damping so it settles
    this.body.setAngvel({ x: ax, y: omega, z: az }, true);
    this.cmd = { vx, vz, omega };
  }

  /** Copy the physics pose onto the model and animate the swerve modules. */
  /** Remember the pose after each physics step, so drawing can blend between the last two. */
  snapshot(jump = false) {
    const p = this.body.translation();
    const q = this.body.rotation();
    if (!this.curPos) { this.curPos = new THREE.Vector3(); this.curQ = new THREE.Quaternion(); this.prevPos = new THREE.Vector3(); this.prevQ = new THREE.Quaternion(); jump = true; }
    this.prevPos.copy(this.curPos);
    this.prevQ.copy(this.curQ);
    this.curPos.set(p.x, p.y, p.z);
    this.curQ.set(q.x, q.y, q.z, q.w);
    if (jump) { this.prevPos.copy(this.curPos); this.prevQ.copy(this.curQ); }
  }

  /**
   * Update the model. `alpha` (0..1) is how far the clock is between the last two physics steps:
   * drawing the blend keeps motion smooth on screens faster than the 60 Hz physics.
   */
  sync(dt, alpha = 1) {
    if (!this.curPos) this.snapshot(true);
    this.root.position.lerpVectors(this.prevPos, this.curPos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQ, this.curQ, alpha);

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

function fabricTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const v = 225 + ((x + y) % 2) * 14 + (Math.random() - 0.5) * 16;
    const i = (y * 64 + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(12, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeNumberTexture(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  // big block numbers filling the bumper, like the real ones
  g.font = '900 172px "Arial Black", "Segoe UI Black", Impact, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 88, 470);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
