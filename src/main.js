import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { HALF_L, BLUE, RED, fieldToWorld, ALLIANCE_ZONE_DEPTH, STATIONS } from './constants.js';
import { buildField } from './field.js';
import { buildArena } from './arena.js';
import { Robot } from './robot.js';
import { Input, ACTIONS, PAD } from './input.js';
import { ControlsScreen } from './controls.js';
import { ROBOT_201 } from './robotConfig.js';
import { Fuel } from './fuel.js';
import { Game } from './game.js';
import { loadSettings, buildSettingsPanel } from './settings.js';
import { Match, clock } from './match.js';
import './style.css';

// views the camera button cycles through; the three driver stations are separate from where the robot starts
const CAMERAS = ['Driver station 1', 'Driver station 2', 'Driver station 3', 'Third person', 'Overhead'];
const THIRD = 3;
const STEP = 1 / 60;
const MAX_STEPS = 4; // per frame; on a slow computer the sim slows down instead of freezing

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
  held: document.getElementById('hud-held'),
  scoreBlue: document.getElementById('score-blue'),
  scoreRed: document.getElementById('score-red'),
  shot: document.getElementById('hud-shot'),
  net: document.getElementById('hud-net'),
  scorebar: document.getElementById('scorebar'),
  sbClock: document.getElementById('sb-clock'),
  sbPhase: document.getElementById('sb-phase'),
  sbLeft: document.getElementById('sb-left'),
  results: document.getElementById('results'),
  resultsBody: document.getElementById('results-body'),
};

const settings = { alliance: BLUE, station: 1, mode: 'match', cam: 'ds' };
try { settings.cam = localStorage.getItem('201sim.startCam') || 'ds'; } catch { /* default */ }

async function init() {
  await RAPIER.init();

  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x2a2d31);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200);
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });


  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x6b5a45, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(-4, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 6, bottom: -6, near: 1, far: 40 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // ------------------------------------------------------------ graphics quality
  // Which GPU is the browser really using? If it fell back to software rendering, say so: that
  // alone can hold a fast PC to ~10 fps.
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch { /* unknown */ }
  const softwareGpu = /swiftshader|llvmpipe|basic render|software|microsoft basic/i.test(gpu);
  {
    const el = document.getElementById('gpu-info');
    el.textContent = `Graphics card in use: ${gpu || 'unknown'}`;
    if (softwareGpu) {
      el.classList.add('warn');
      el.textContent = 'Your browser is not using your graphics card (software rendering), which caps the sim around 10 fps. ' +
        'In Chrome or Edge open Settings > System, turn on "Use graphics acceleration when available", and restart the browser.';
    }
  }
  const LEVELS = { High: { dpr: 1.5, shadow: 2048 }, Medium: { dpr: 1, shadow: 1024 }, Low: { dpr: 0.75, shadow: 0 } };
  let autoLevel = 'High';
  const level = () => (player.graphics === 'Auto' ? autoLevel : player.graphics) || 'High';
  function applyGraphics() {
    const L = LEVELS[level()];
    renderer.setPixelRatio(Math.min(devicePixelRatio, L.dpr));
    renderer.setSize(innerWidth, innerHeight);
    sun.castShadow = L.shadow > 0;
    if (L.shadow && sun.shadow.mapSize.x !== L.shadow) {
      sun.shadow.mapSize.set(L.shadow, L.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    renderer.shadowMap.type = L.shadow >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    renderer.shadowMap.needsUpdate = true;
  }

  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = STEP;
  buildArena(scene);
  buildField(scene, RAPIER, world);

  const robot = new Robot(scene, RAPIER, world, ROBOT_201, settings.alliance);
  loadCad(robot);
  const fuel = new Fuel(scene, RAPIER, world);
  const player = loadSettings();
  applyGraphics();
  const game = new Game(scene, robot, fuel, player);
  const match = new Match();
  game.match = match;
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
    game.reset();
    match.reset(settings.mode === 'match');
    ui.results.hidden = true;
    ui.scorebar?.classList.remove('final');
  };
  restart();

  const modeBtns = document.querySelectorAll('[data-mode]');
  const camStartBtns = document.querySelectorAll('[data-cam]');
  camStartBtns.forEach((b) => b.addEventListener('click', () => {
    settings.cam = b.dataset.cam;
    try { localStorage.setItem('201sim.startCam', settings.cam); } catch { /* not saved */ }
    refreshMenu();
  }));
  modeBtns.forEach((b) => b.addEventListener('click', () => { settings.mode = b.dataset.mode; refreshMenu(); }));
  // after a match: shrink the score bar back and keep driving in free play, or go again
  const keepDriving = () => {
    ui.results.hidden = true;
    ui.scorebar.classList.remove('final');
    match.reset(false);
    document.activeElement?.blur?.();
  };
  document.getElementById('results-free').addEventListener('click', keepDriving);
  document.getElementById('again').addEventListener('click', () => start());
  document.getElementById('results-menu').addEventListener('click', () => {
    ui.results.hidden = true; ui.scorebar.classList.remove('final'); ui.scorebar.hidden = true;
    state = 'menu'; ui.menu.hidden = false; ui.hud.hidden = true;
  });
  const allianceBtns = document.querySelectorAll('[data-alliance]');
  const stationBtns = document.querySelectorAll('[data-station]');
  const refreshMenu = () => {
    allianceBtns.forEach((b) => b.classList.toggle('on', b.dataset.alliance === settings.alliance));
    stationBtns.forEach((b) => b.classList.toggle('on', +b.dataset.station === settings.station));
    modeBtns.forEach((b) => b.classList.toggle('on', b.dataset.mode === settings.mode));
    camStartBtns.forEach((b) => b.classList.toggle('on', b.dataset.cam === settings.cam));
  };
  allianceBtns.forEach((b) => b.addEventListener('click', () => { settings.alliance = b.dataset.alliance; refreshMenu(); restart(); }));
  stationBtns.forEach((b) => b.addEventListener('click', () => { settings.station = +b.dataset.station; refreshMenu(); restart(); }));
  refreshMenu();
  // camera picker in the pause menu
  const camBtns = document.getElementById('pause-cams');
  CAMERAS.forEach((name, i) => {
    const b = document.createElement('button');
    b.textContent = name.replace('Driver station ', 'DS ');
    b.addEventListener('click', () => setCamera(i));
    camBtns.appendChild(b);
  });
  function setCamera(i) {
    camIndex = i;
    camYaw = robot.yaw();
    [...camBtns.children].forEach((b, k) => b.classList.toggle('on', k === i));
  }
  const camName = () => CAMERAS[camIndex];
  const start = () => {
    restart();
    setCamera(settings.cam === 'third' ? THIRD : settings.cam === 'overhead' ? THIRD + 1 : settings.station);
    // otherwise Space (swap camera) would "click" the Start button again
    document.activeElement?.blur?.();
    state = 'play';
    ui.menu.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false;
    ui.scorebar.hidden = false; ui.scorebar.classList.remove('final');
  };
  document.getElementById('start').addEventListener('click', start);
  document.getElementById('resume').addEventListener('click', () => { state = 'play'; ui.pause.hidden = true; document.activeElement?.blur?.(); });
  document.getElementById('to-menu').addEventListener('click', () => { state = 'menu'; ui.pause.hidden = true; ui.menu.hidden = false; ui.hud.hidden = true; ui.scorebar.hidden = true; });

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

  // Settings screen (shooter power, fire rate, hopper size)
  const settingsPanel = document.getElementById('settings');
  let settingsFrom = null;
  buildSettingsPanel(settingsPanel, player, (k) => { if (k === 'graphics') applyGraphics(); });
  const openSettings = () => {
    settingsFrom = state;
    ui.menu.hidden = true;
    ui.pause.hidden = true;
    settingsPanel.hidden = false;
  };
  const closeSettings = () => {
    settingsPanel.hidden = true;
    (settingsFrom === 'paused' ? ui.pause : ui.menu).hidden = false;
  };
  document.getElementById('open-settings').addEventListener('click', openSettings);
  document.getElementById('pause-settings').addEventListener('click', openSettings);
  settingsPanel.querySelector('.settings-close').addEventListener('click', closeSettings);
  addEventListener('keydown', (e) => { if (e.code === 'Escape' && !settingsPanel.hidden) { e.stopPropagation(); closeSettings(); } }, true);
  document.getElementById('pause-controls').addEventListener('click', openControls);

  // Menu navigation reads the controller's standard buttons directly, so it works even if the
  // in-game bindings were remapped
  let navPrev = [];
  const navPressed = (pad, i) => !!pad && (pad.buttons[i]?.value ?? 0) > 0.5 && !(navPrev[i] > 0.5);

  // ------------------------------------------------------------ loop
  let acc = 0;
  let last = performance.now();
  let restartHeld = 0;
  let fpsT = 0, fpsN = 0, physMs = 0, slowSecs = 0;
  const camPos = new THREE.Vector3();
  const camLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    input.poll();
    setText(ui.pad, input.padName ? `Controller: ${input.padName.replace(/\(.*?\)/g, '').trim()}` : 'No controller found. Press any button on it, or use the keyboard.');
    ui.pad.classList.toggle('ok', !!input.padName);

    const pad = input.activePad();
    if (controls.open) {
      controls.update();
    } else if (!settingsPanel.hidden) {
      if (navPressed(pad, PAD.B)) closeSettings();
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
      if (input.pressed('swapCamera')) setCamera((camIndex + 1) % CAMERAS.length);
      if (input.pressed('speed1')) robot.speedScale = robot.cfg.speedLevels[0];
      if (input.pressed('speed2')) robot.speedScale = robot.cfg.speedLevels[1];
      if (input.pressed('speed3')) robot.speedScale = robot.cfg.speedLevels[2];
      if (input.held('restart')) {
        restartHeld += dt;
        if (restartHeld > 0.8) { restart(); restartHeld = -1; }
      } else restartHeld = 0;
      ui.restartBar.style.width = `${Math.max(0, restartHeld / 0.8) * 100}%`;

      acc = Math.min(acc + dt, STEP * MAX_STEPS);
      const p0 = performance.now();
      while (acc >= STEP) {
        // in third person, "forward" on the stick is the way the camera looks
        robot.driveRef = camIndex === THIRD ? camYaw : null;
        const aimTurn = game.update(input, STEP, settings.alliance);
        robot.drive(input.forward, input.strafe, aimTurn ?? input.turn, STEP);
        world.step();
        acc -= STEP;
      }
      physMs += performance.now() - p0;
      if (match.update(dt)) showResults();
      if (match.over && !ui.results.hidden) {
        if (input.pressed('confirm')) keepDriving();
        else if (input.pressed('special1')) start();
      }
      // fell through the world somehow: put it back
      if (robot.position(tmp).y < -1) restart();
    }

    navPrev = pad ? pad.buttons.map((b) => b.value) : [];
    robot.sync(dt);
    fuel.sync();
    game.drawAim();
    game.drawHeld(now / 1000);
    updateCamera(dt);
    renderer.render(scene, camera);

    // HUD
    if (state === 'play') {
      setText(ui.mode, `${robot.fieldRelative ? 'Field relative' : 'Robot relative'} · speed ${robot.cfg.speedLevels.indexOf(robot.speedScale) + 1}`);
      setText(ui.speed, `${robot.speed().toFixed(1)} m/s`);
      setText(ui.cam, camName());
      const on = Object.entries(ACTIONS)
        .filter(([k]) => ['intake', 'autoShoot', 'autoPass', 'manualShoot', 'climb', 'special1', 'special2', 'special3'].includes(k) && input.held(k))
        .map(([, b]) => b.label);
      setText(ui.actions, on.join(' · '));
      setText(ui.held, `${game.held} / ${game.capacity}`);
      setText(ui.net, game.netBroken ? 'NET BROKEN' : game.strain > 1 ? 'NET STRAINING: back off!' : '');
      updateScorebar();
      const a = game.aim;
      setText(ui.shot, !a ? '' : a.short ? 'Too far: raise Pass power boost'
        : a.kind === 'pass' ? `Pass ${a.d.toFixed(1)} m · ${a.spd.toFixed(1)} m/s`
        : a.kind === 'shot' ? `HUB ${a.d.toFixed(1)} m · ${a.spd.toFixed(1)} m/s${a.ready ? '' : ' · aiming'}`
        : 'Manual shot');
    }
    fpsT += dt; fpsN++;
    if (fpsT > 1) {
      const fps = fpsN / fpsT;
      setText(ui.fps, `${Math.round(fps)} fps · ${level()} · physics ${(physMs / fpsN).toFixed(1)} ms${softwareGpu ? ' · SOFTWARE RENDERING' : ''}`);
      ui.fps.title = gpu;
      // Auto graphics: a few slow seconds in a row drops the quality one step
      if (state === 'play' && player.graphics === 'Auto' && document.hasFocus()) {
        slowSecs = fps < 45 ? slowSecs + 1 : 0;
        if (slowSecs >= 3 && autoLevel !== 'Low') {
          autoLevel = autoLevel === 'High' ? 'Medium' : 'Low';
          applyGraphics();
          slowSecs = 0;
        }
      }
      fpsT = 0; fpsN = 0; physMs = 0;
    }
    requestAnimationFrame(frame);
  }

  // only touch the DOM when something changed: rewriting text every frame costs layout time
  const sbCache = new Map();
  function setText(el, v) { if (sbCache.get(el) !== v) { sbCache.set(el, v); el.textContent = v; } }
  function setClass(el, v) { if (sbCache.get(el.id + 'c') !== v) { sbCache.set(el.id + 'c', v); el.className = v; } }
  const TELEOP = ['TRANSITION', 'SHIFT 1', 'SHIFT 2', 'SHIFT 3', 'SHIFT 4', 'END GAME'];
  function updateScorebar() {
    setText(ui.scoreBlue, String(game.score[BLUE]));
    setText(ui.scoreRed, String(game.score[RED]));
    for (const a of [BLUE, RED]) {
      const slot = document.querySelector(`#sb-teams-${a} span`);
      setClass(slot, settings.alliance === a ? 'us' : '');
      setText(slot.querySelector('b'), settings.alliance === a ? '201' : '----');
      const live = match.on && !match.over;
      const on = match.isActive(a);
      const el = document.getElementById(`sb-hub-${a}`);
      setText(el, live ? (on ? 'HUB ACTIVE' : 'HUB INACTIVE') : '');
      setClass(el, `sb-hub ${a} ${on ? 'on' : 'off'}`);
      const dim = live && !on;
      const team = el.parentElement.querySelector(`.sb-team.${a}`);
      const score = a === BLUE ? ui.scoreBlue : ui.scoreRed;
      setClass(team, `sb-team ${a}${dim ? ' dim' : ''}`);
      setClass(score, `sb-score ${a}${dim ? ' dim' : ''}`);
    }
    if (!match.on) {
      setText(ui.sbClock, 'FREE');
      setText(ui.sbPhase, 'PLAY');
      setText(ui.sbLeft, '');
      return;
    }
    const ph = match.phase();
    // the big clock counts down AUTO, then the 2:20 of teleop; below it: period number and time left in it
    const left = ph.name === 'AUTO' ? ph.left : Math.max(0, 160 - match.t);
    const idx = TELEOP.indexOf(ph.name);
    setText(ui.sbClock, match.over ? 'FINAL' : clock(Math.ceil(left)));
    setText(ui.sbPhase, match.over ? '6 / 6' : idx >= 0 ? `${idx + 1} / 6` : 'AUTO');
    setText(ui.sbLeft, match.over ? ':00' : `:${String(Math.ceil(ph.left)).padStart(2, '0')}`);
  }

  function showResults() {
    const mine = settings.alliance;
    const pts = match.points[mine];
    updateScorebar();
    ui.scorebar.classList.add('final');
    ui.resultsBody.innerHTML =
      `<table><tr><td>FUEL shot</td><td>${game.shots}</td></tr>` +
      `<tr><td>Scored in an active HUB</td><td>${pts}</td></tr>` +
      `<tr><td>Went in while inactive (no points)</td><td>${game.missedInactive}</td></tr>` +
      `<tr><td>Accuracy</td><td>${game.shots ? Math.round(((pts + game.missedInactive) / game.shots) * 100) : 0}%</td></tr>` +
      `<tr><td>Scored in AUTO</td><td>${match.autoFuel[mine]}</td></tr></table>`;
    ui.results.hidden = false;
  }

  let camYaw = 0;
  function updateCamera(dt) {
    if (camera.userData.freeze) return; // debugging: hold a hand-placed camera
    const p = robot.position(tmp);
    const allianceSign = settings.alliance === BLUE ? -1 : 1;
    const view = state === 'menu' ? settings.station : camIndex;
    const mode = view < THIRD ? 0 : view === THIRD ? 1 : 2;
    if (mode === 0) {
      // standing behind the driver station glass, turning to follow the robot
      const st = STATIONS[view];
      const ds = fieldToWorld(0, st.fy, settings.alliance);
      camPos.set(allianceSign * (HALF_L + 0.6), 1.75, ds.z);
      camLook.set(p.x, 0.3, p.z);
      camLook.lerp(tmp2.set(0, 0, ds.z * 0.5), 0.35);
    } else if (mode === 1) {
      // third person: behind the robot, swinging round smoothly as it turns
      let d = robot.yaw() - camYaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      camYaw += d * (1 - Math.exp(-dt * 2.5));
      camPos.set(p.x - Math.cos(camYaw) * 3.4, 2.0, p.z + Math.sin(camYaw) * 3.4);
      camLook.set(p.x + Math.cos(camYaw) * 2.0, 0.4, p.z - Math.sin(camYaw) * 2.0);
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
  window.__sim = { robot, world, input, settings, game, fuel, player, renderer, scene, camera, sun }; // handy for debugging in the console
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
