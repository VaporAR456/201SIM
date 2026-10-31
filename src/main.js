import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HALF_L, BLUE, RED, fieldToWorld, ALLIANCE_ZONE_DEPTH, STATIONS } from './constants.js';
import { buildField } from './field.js';
import { Robot } from './robot.js';
import { Input, ACTIONS, PAD } from './input.js';
import { ControlsScreen } from './controls.js';
import { ROBOT_201 } from './robotConfig.js';
import './style.css';

const CAMERAS = ['Driver station', 'Chase', 'Overhead'];
const STEP = 1 / 120;

const ui = {
  menu: document.getElementById('menu'),
  pause: document.getElementById('pause'),
  hud: document.getElementById('hud'),
  pad: document.getElementById('pad-status'),
  mode: document.getElementById('hud-mode'),
  speed: document.getElementById('hud-speed'),
  cam: document.getElementById('hud-cam'),
  actions: document.getElementById('hud-actions'),
  fps: document.getElementById('hud-fps'),
  restartBar: document.getElementById('restart-bar'),
};

const settings = { alliance: BLUE, station: 1 };

async function init() {
  await RAPIER.init();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0f12);
  scene.fog = new THREE.Fog(0x0d0f12, 30, 60);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30302a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 6, bottom: -6, near: 1, far: 40 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  buildField(scene, RAPIER, world);

  const robot = new Robot(scene, RAPIER, world, ROBOT_201, settings.alliance);
  loadCad(robot);
  const input = new Input();

  // ------------------------------------------------------------ menu
  let state = 'menu';
  let camIndex = 0;
  const startPose = () => {
    const st = STATIONS[settings.station];
    const fx = ALLIANCE_ZONE_DEPTH - robot.halfL - 0.15;
    const p = fieldToWorld(fx, st.fy, settings.alliance);
    const yaw = settings.alliance === BLUE ? 0 : Math.PI;
    return { ...p, yaw };
  };
  const restart = () => {
    const p = startPose();
    robot.reset(p.x, p.z, p.yaw);
    robot.fieldForward = settings.alliance === BLUE ? 0 : Math.PI;
    robot.bumperMat.color.set(settings.alliance === BLUE ? 0x1f6fff : 0xe8322f);
  };
  restart();

  const allianceBtns = document.querySelectorAll('[data-alliance]');
  const stationBtns = document.querySelectorAll('[data-station]');
  const refreshMenu = () => {
    allianceBtns.forEach((b) => b.classList.toggle('on', b.dataset.alliance === settings.alliance));
    stationBtns.forEach((b) => b.classList.toggle('on', +b.dataset.station === settings.station));
  };
  allianceBtns.forEach((b) => b.addEventListener('click', () => { settings.alliance = b.dataset.alliance; refreshMenu(); restart(); }));
  stationBtns.forEach((b) => b.addEventListener('click', () => { settings.station = +b.dataset.station; refreshMenu(); restart(); }));
  refreshMenu();
  const start = () => { restart(); state = 'play'; ui.menu.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false; };
  document.getElementById('start').addEventListener('click', start);
  document.getElementById('resume').addEventListener('click', () => { state = 'play'; ui.pause.hidden = true; });
  document.getElementById('to-menu').addEventListener('click', () => { state = 'menu'; ui.pause.hidden = true; ui.menu.hidden = false; ui.hud.hidden = true; });

  // Controls screen, opened from the main menu or the pause menu
  let controlsFrom = null;
  const controls = new ControlsScreen(input, document.getElementById('controls'), () => {
    (controlsFrom === 'paused' ? ui.pause : ui.menu).hidden = false;
  });
  const openControls = () => {
    controlsFrom = state;
    ui.menu.hidden = true;
    ui.pause.hidden = true;
    controls.show();
  };
  document.getElementById('open-controls').addEventListener('click', openControls);
  document.getElementById('pause-controls').addEventListener('click', openControls);

  // Menu navigation reads the controller's standard buttons directly, so it works even if the
  // in-game bindings were remapped
  let navPrev = [];
  const navPressed = (pad, i) => !!pad && (pad.buttons[i]?.value ?? 0) > 0.5 && !(navPrev[i] > 0.5);

  // ------------------------------------------------------------ loop
  let acc = 0;
  let last = performance.now();
  let restartHeld = 0;
  let fpsT = 0, fpsN = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.poll();
    ui.pad.textContent = input.padName ? `Controller: ${input.padName.replace(/\(.*?\)/g, '').trim()}` : 'No controller found. Press any button on it, or use the keyboard.';
    ui.pad.classList.toggle('ok', !!input.padName);

    const pad = input.activePad();
    if (controls.open) {
      controls.update();
    } else if (state === 'menu') {
      if (input.pressed('confirm')) start();
      // controller: D-pad picks station, X / B pick alliance, Y opens Controls
      if (navPressed(pad, PAD.LEFT)) { settings.station = Math.max(0, settings.station - 1); refreshMenu(); restart(); }
      if (navPressed(pad, PAD.RIGHT)) { settings.station = Math.min(2, settings.station + 1); refreshMenu(); restart(); }
      if (navPressed(pad, PAD.X)) { settings.alliance = BLUE; refreshMenu(); restart(); }
      if (navPressed(pad, PAD.B)) { settings.alliance = RED; refreshMenu(); restart(); }
      if (navPressed(pad, PAD.Y)) openControls();
    } else if (state === 'paused') {
      if (input.pressed('pause') || input.pressed('confirm')) { state = 'play'; ui.pause.hidden = true; }
      else if (navPressed(pad, PAD.Y)) openControls();
    } else if (state === 'play') {
      if (input.pressed('pause')) { state = 'paused'; ui.pause.hidden = false; }
      if (input.pressed('toggleFieldRel')) robot.fieldRelative = !robot.fieldRelative;
      if (input.pressed('resetGyro')) robot.fieldForward = robot.yaw();
      if (input.pressed('swapCamera')) camIndex = (camIndex + 1) % CAMERAS.length;
      if (input.pressed('speed1')) robot.speedScale = robot.cfg.speedLevels[0];
      if (input.pressed('speed2')) robot.speedScale = robot.cfg.speedLevels[1];
      if (input.pressed('speed3')) robot.speedScale = robot.cfg.speedLevels[2];
      if (input.held('restart')) {
        restartHeld += dt;
        if (restartHeld > 0.8) { restart(); restartHeld = -1; }
      } else restartHeld = 0;
      ui.restartBar.style.width = `${Math.max(0, restartHeld / 0.8) * 100}%`;

      acc += dt;
      while (acc >= STEP) {
        robot.drive(input.forward, input.strafe, input.turn, STEP);
        world.step();
        acc -= STEP;
      }
      // fell through the world somehow: put it back
      if (robot.position(tmp).y < -1) restart();
    }

    navPrev = pad ? pad.buttons.map((b) => b.value) : [];
    robot.sync(dt);
    updateCamera(dt);
    renderer.render(scene, camera);

    // HUD
    if (state === 'play') {
      ui.mode.textContent = robot.fieldRelative ? 'Field relative' : 'Robot relative';
      ui.speed.textContent = `${robot.speed().toFixed(1)} m/s`;
      ui.mode.textContent += ` · speed ${robot.cfg.speedLevels.indexOf(robot.speedScale) + 1}`;
      ui.cam.textContent = CAMERAS[camIndex];
      const on = Object.entries(ACTIONS)
        .filter(([k]) => ['intake', 'autoShoot', 'autoPass', 'manualShoot', 'climb', 'special1', 'special2', 'special3'].includes(k) && input.held(k))
        .map(([, b]) => b.label);
      ui.actions.textContent = on.join(' · ');
    }
    fpsT += dt; fpsN++;
    if (fpsT > 0.5) { ui.fps.textContent = `${Math.round(fpsN / fpsT)} fps`; fpsT = 0; fpsN = 0; }
    requestAnimationFrame(frame);
  }

  function updateCamera(dt) {
    const p = robot.position(tmp);
    const allianceSign = settings.alliance === BLUE ? -1 : 1;
    const mode = state === 'menu' ? 0 : camIndex;
    if (mode === 0) {
      // standing behind the driver station glass, turning to follow the robot
      const st = STATIONS[settings.station];
      const ds = fieldToWorld(0, st.fy, settings.alliance);
      camPos.set(allianceSign * (HALF_L + 0.6), 1.75, ds.z);
      camLook.set(p.x, 0.3, p.z);
      camLook.lerp(new THREE.Vector3(0, 0, ds.z * 0.5), 0.35);
    } else if (mode === 1) {
      const yaw = robot.yaw();
      camPos.set(p.x - Math.cos(yaw) * 2.6, 1.6, p.z + Math.sin(yaw) * 2.6);
      camLook.set(p.x + Math.cos(yaw) * 1.5, 0.3, p.z - Math.sin(yaw) * 1.5);
    } else {
      camPos.set(p.x * 0.6 + allianceSign * 3, 13, p.z * 0.6);
      camLook.set(p.x * 0.6, 0, p.z * 0.6);
    }
    const k = 1 - Math.exp(-dt * (mode === 0 ? 6 : 8));
    camera.position.lerp(camPos, k);
    if (!camera.userData.look) camera.userData.look = camLook.clone();
    camera.userData.look.lerp(camLook, k);
    camera.lookAt(camera.userData.look);
  }

  requestAnimationFrame(frame);
  window.__sim = { robot, world, input, settings }; // handy for debugging in the console
}

/** Load the converted team CAD if it exists; keep the placeholder robot otherwise. */
async function loadCad(robot) {
  const url = `${import.meta.env.BASE_URL}models/robot201.glb`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') || '').includes('text/html')) return;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const model = gltf.scene;
    model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    robot.setCadModel(model);
    robot.useCadVisuals?.();
  } catch (e) {
    console.warn('Robot CAD not loaded, using placeholder', e);
  }
}

init();
