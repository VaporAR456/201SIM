import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildAprilTags } from './apriltags.js';
import { HALF_L, HALF_W, FIELD_W, BLUE, RED, fieldToWorld, ALLIANCE_ZONE_DEPTH, STATIONS, GROUP, groups, TRENCH, HUB } from './constants.js';
import { buildField } from './field.js';
import { Maps, MAPS } from './maps.js';
import { Robot, FEEL_NORMAL, FEEL_BABY } from './robot.js';
import { PadNav } from './padnav.js';
import { Humans } from './humans.js';
import { HubLights } from './hublights.js';
import { AIPlayers, resetAiMemory } from './ai.js';
import { Sound } from './sound.js';
import { Input, ACTIONS, PAD } from './input.js';
import { ControlsScreen } from './controls.js';
import { ROBOT_201 } from './robotConfig.js';
import { Fuel, hubCenter } from './fuel.js';
import { Game } from './game.js';
import { loadSettings, buildSettingsPanel } from './settings.js';
import { Match, clock } from './match.js';
import './style.css';

// views the camera button cycles through; the three driver stations are separate from where the robot starts
const CAMERAS = ['Driver station 1', 'Driver station 2', 'Driver station 3', 'Third person', 'Overhead'];
const THIRD = 3;
// stands in for the controls while the robot is disabled
const IDLE = { held: () => false, pressed: () => false, forward: 0, strafe: 0, turn: 0 };
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
  human: document.getElementById('hud-human'),
  countdown: document.getElementById('countdown'),
  resultsBody: document.getElementById('results-body'),
};

const settings = { alliance: BLUE, station: 1, mode: 'match', cam: 'ds' };
try { settings.cam = localStorage.getItem('201sim.startCam') || 'ds'; } catch { /* default */ }
try { settings.preload = localStorage.getItem('201sim.preload') !== 'off'; } catch { settings.preload = true; }
try { settings.spawn = localStorage.getItem('201sim.spawn') || 'station'; } catch { settings.spawn = 'station'; }
// Play vs AI: robots per alliance ("off", or "1v1".."3v3") and the AI's skill
try { settings.vs = localStorage.getItem('201sim.vs') || 'off'; } catch { settings.vs = 'off'; }
try { settings.aiLevel = localStorage.getItem('201sim.aiLevel') || 'Medium'; } catch { settings.aiLevel = 'Medium'; }
settings.aiLevel = { Rookie: 'Easy', District: 'Medium', Champs: 'Hard' }[settings.aiLevel] ?? settings.aiLevel;

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


  const hemi = new THREE.HemisphereLight(0xfff4e0, 0x6b5a45, 1.1);
  scene.add(hemi);
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
  // more solver passes: a hopper full of FUEL pressing on its walls while the robot spins stays put
  world.integrationParameters.numSolverIterations = 8;
  const maps = new Maps(scene, hemi);
  try { settings.map = localStorage.getItem('201sim.map') || 'random'; } catch { settings.map = 'random'; }
  maps.show(settings.map === 'random' ? maps.random() : settings.map);
  const fieldGroup = buildField(scene, RAPIER, world);
  // The field's own colliders: give them a group of their own, so the hopper's FUEL-only
  // parts (net, gate, upper side plates) pass through walls and the TRENCH arm
  world.forEachCollider((c) => { if ((c.collisionGroups() >>> 0) === 0xffffffff) c.setCollisionGroups(groups(GROUP.FIELD)); });
  // the official field CAD replaces the simple field drawing (the simple colliders stay)
  loadFieldCad(scene).then((ok) => {
    if (!ok) return;
    // the CAD draws everything except the carpet, which stays a flat textured plane
    for (const c of fieldGroup.children) c.visible = c.userData.carpet === true || c.userData.keep === true;
  });

  const robot = new Robot(scene, RAPIER, world, ROBOT_201, settings.alliance);
  loadCad(robot);
  const fuel = new Fuel(scene, RAPIER, world);
  const player = loadSettings();
  applyGraphics();
  const game = new Game(scene, robot, fuel, player);
  const match = new Match();
  game.match = match;
  const ai = new AIPlayers(scene, RAPIER, world, fuel);
  game.onScored = (b, al, counted) => {
    if (counted && !b.bot && b.human == null && al === settings.alliance) game.myScored = (game.myScored || 0) + 1;
    ai.credit(b, counted);
  };
  // set up the AI robots for a new match (the field map is built the first time)
  const setupAi = () => {
    if (settings.vs === 'off') { ai.clear(); return; }
    if (!ai.nav) ai.buildNav(robot.body);
    const [mine, theirs] = settings.vs.split('v').map(Number);
    ai.setup({ alliance: settings.alliance, station: settings.station, mine, theirs, level: settings.aiLevel });
    const lineup = ai.bots.filter((b) => b.alliance !== settings.alliance).map((b) => `${b.team} ${b.name}`).join(', ');
    if (ai.elites.length) setTimeout(() => toast(`Heads up: ${ai.elites.map((b) => `${b.team} ${b.name}`).join(' and ')} on the other alliance`, 'info', 5), 300);
    else if (ai.event) setTimeout(() => toast(`Realistic: a ${ai.event.name} level match`, 'info', 4), 300);
    else if (lineup) setTimeout(() => toast(`Opponents: ${lineup}`, 'info', 4), 300);
  };
  const input = new Input();

  // ------------------------------------------------------------ menu
  let state = 'menu';
  let camIndex = 0;
  const startPose = () => {
    // under the left or right TRENCH (left/right as the drivers see it)
    if (settings.spawn === 'trenchL' || settings.spawn === 'trenchR') {
      const fy = settings.spawn === 'trenchL' ? FIELD_W - TRENCH.clearWidth / 2 : TRENCH.clearWidth / 2;
      const p = fieldToWorld(HUB.fx, fy, settings.alliance);
      return { ...p, yaw: settings.alliance === BLUE ? 0 : Math.PI };
    }
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
    game.preloadOn = settings.preload;
    game.myScored = 0;
    humans?.setAlliance(settings.alliance);
    game.reset();
    match.reset(settings.mode === 'match');
    ai?.reset();
    ui.results.hidden = true;
    ui.scorebar?.classList.remove('final');
    ui.hud?.classList.remove('final');
    clearToast?.();
  };
  let clearToast = null;
  let humans = null;
  let hubLights = null;
  restart();

  const modeBtns = document.querySelectorAll('[data-mode]');
  const camStartBtns = document.querySelectorAll('[data-cam]');
  camStartBtns.forEach((b) => b.addEventListener('click', () => {
    settings.cam = b.dataset.cam;
    try { localStorage.setItem('201sim.startCam', settings.cam); } catch { /* not saved */ }
    refreshMenu();
  }));
  modeBtns.forEach((b) => b.addEventListener('click', () => { settings.mode = b.dataset.mode; refreshMenu(); }));
  const spawnBtns = document.querySelectorAll('[data-spawn]');
  spawnBtns.forEach((b) => b.addEventListener('click', () => {
    settings.spawn = b.dataset.spawn;
    try { localStorage.setItem('201sim.spawn', settings.spawn); } catch { /* not saved */ }
    refreshMenu(); restart();
  }));
  const vsBtns = document.querySelectorAll('[data-vs]');
  vsBtns.forEach((b) => b.addEventListener('click', () => {
    settings.vs = b.dataset.vs;
    try { localStorage.setItem('201sim.vs', settings.vs); } catch { /* not saved */ }
    refreshMenu();
  }));
  document.getElementById('ai-forget').addEventListener('click', (e) => {
    resetAiMemory(); ai.forget();
    e.currentTarget.textContent = 'Forgotten';
  });
  const aiLvBtns = document.querySelectorAll('[data-ailevel]');
  aiLvBtns.forEach((b) => b.addEventListener('click', () => {
    settings.aiLevel = b.dataset.ailevel;
    try { localStorage.setItem('201sim.aiLevel', settings.aiLevel); } catch { /* not saved */ }
    refreshMenu();
  }));
  const mapBtns = document.querySelectorAll('[data-map]');
  mapBtns.forEach((b) => b.addEventListener('click', () => {
    settings.map = b.dataset.map;
    try { localStorage.setItem('201sim.map', settings.map); } catch { /* not saved */ }
    if (settings.map !== 'random') maps.show(settings.map); // preview it behind the menu
    refreshMenu();
  }));
  const preloadBtns = document.querySelectorAll('[data-preload]');
  preloadBtns.forEach((b) => b.addEventListener('click', () => {
    settings.preload = b.dataset.preload === 'on';
    try { localStorage.setItem('201sim.preload', settings.preload ? 'on' : 'off'); } catch { /* not saved */ }
    refreshMenu(); restart();
  }));
  // after a match: shrink the score bar back and keep driving in free play, or go again
  const keepDriving = () => {
    ui.results.hidden = true;
    ui.scorebar.classList.remove('final');
    ui.scorebar.hidden = false;
    ui.hud.classList.remove('final');
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
    preloadBtns.forEach((b) => b.classList.toggle('on', (b.dataset.preload === 'on') === settings.preload));
    mapBtns.forEach((b) => b.classList.toggle('on', b.dataset.map === settings.map));
    spawnBtns.forEach((b) => b.classList.toggle('on', b.dataset.spawn === settings.spawn));
    document.querySelectorAll('[data-vs]').forEach((b) => b.classList.toggle('on', b.dataset.vs === settings.vs));
    document.querySelectorAll('[data-ailevel]').forEach((b) => b.classList.toggle('on', b.dataset.ailevel === settings.aiLevel));
    document.getElementById('ai-level-opt').hidden = settings.vs === 'off';
  };
  allianceBtns.forEach((b) => b.addEventListener('click', () => { settings.alliance = b.dataset.alliance; refreshMenu(); restart(); }));
  stationBtns.forEach((b) => b.addEventListener('click', () => { settings.station = +b.dataset.station; settings.camDs = undefined; refreshMenu(); restart(); }));
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
    // remember it, so Play again (and the next visit) keeps this view
    settings.cam = i === THIRD ? 'third' : i === THIRD + 1 ? 'overhead' : 'ds';
    if (i < THIRD) settings.camDs = i;
    try { localStorage.setItem('201sim.startCam', settings.cam); } catch { /* not saved */ }
    refreshMenu();
    [...camBtns.children].forEach((b, k) => b.classList.toggle('on', k === i));
  }
  const camName = () => CAMERAS[camIndex];
  const start = () => {
    // the map: the one picked, or a different random one every match
    maps.show(settings.map === 'random' ? maps.random() : settings.map);
    setupAi();
    restart();
    setCamera(settings.cam === 'third' ? THIRD : settings.cam === 'overhead' ? THIRD + 1 : settings.camDs ?? settings.station);
    snapCam = true;
    // otherwise Space (swap camera) would "click" the Start button again
    document.activeElement?.blur?.();
    state = 'play';
    ui.menu.hidden = true; ui.pause.hidden = true; ui.hud.hidden = false;
    ui.scorebar.hidden = false; ui.scorebar.classList.remove('final');
  };
  document.getElementById('start').addEventListener('click', start);
  const resume = () => { state = 'play'; ui.pause.hidden = true; document.activeElement?.blur?.(); };
  document.getElementById('resume').addEventListener('click', resume);
  document.getElementById('pause-restart').addEventListener('click', () => start());
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
  const sound = new Sound();
  sound.setVolume(player.volume / 100);
  // browsers only start audio from a click or key press
  addEventListener('pointerdown', () => sound.unlock());
  addEventListener('keydown', () => sound.unlock());
  game.onShot = () => sound.shot();
  humans = new Humans(scene);
  hubLights = new HubLights(scene);
  humans.setAlliance(settings.alliance);
  game.onHumanThrow = (al) => humans.throwBall(al);
  let lastPhase = null;
  let lastCountdown = 0;
  const applyFeel = () => { robot.feel = player.controlFeel === 'Baby mode' ? FEEL_BABY : FEEL_NORMAL; };
  applyFeel();
  buildSettingsPanel(settingsPanel, player, (k) => { if (k === 'graphics') applyGraphics(); if (k === 'controlFeel' || k === 'graphics') applyFeel(); });
  settingsPanel.addEventListener('input', () => sound.setVolume(player.volume / 100));
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
  const nav = new PadNav();
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
      else nav.update(settingsPanel, pad, dt);
    } else if (state === 'menu') {
      // controller: D-pad / stick moves, A presses, X / B pick alliance, Y opens Controls
      const used = nav.update(ui.menu, pad, dt);
      if (!used && input.pressed('confirm') && !navPressed(pad, PAD.A)) start();
      else if (navPressed(pad, PAD.X)) { settings.alliance = BLUE; refreshMenu(); restart(); }
      else if (navPressed(pad, PAD.B)) { settings.alliance = RED; refreshMenu(); restart(); }
      else if (navPressed(pad, PAD.Y)) openControls();
    } else if (state === 'paused') {
      const used = nav.update(ui.pause, pad, dt);
      if (used) { /* A pressed the highlighted button */ }
      else if (input.pressed('pause') || navPressed(pad, PAD.B) || (input.pressed('confirm') && !navPressed(pad, PAD.A))) resume();
      else if (navPressed(pad, PAD.Y)) openControls();
      else if (navPressed(pad, PAD.VIEW)) start();
    } else if (state === 'play') {
      if (input.pressed('pause')) { state = 'paused'; ui.pause.hidden = false; nav.reset(); }
      // with the results up, the D-pad moves between its buttons instead
      const resultsUp = match.over && !ui.results.hidden;
      if (!resultsUp) {
        if (input.pressed('toggleFieldRel')) robot.fieldRelative = !robot.fieldRelative;
        if (input.pressed('resetGyro')) robot.fieldForward = robot.yaw();
        if (input.pressed('swapCamera')) setCamera((camIndex + 1) % CAMERAS.length);
        if (input.pressed('flipCamera')) camFlip = !camFlip;
      }
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
        robot.driveRef = camIndex === THIRD ? camYaw : null; // stick forward = away from the camera
        // the pause between AUTO and TELEOP (and after the buzzer): robot disabled
        const inp = match.disabled ? IDLE : input;
        const aimTurn = game.update(inp, STEP, settings.alliance);
        // shooting on the move: the drive slows right down so the shots can land
        const slow = game.aim && game.held > 0 ? 0.3 : 1;
        // baby mode softens the sticks too: small pushes do a lot less
        const ex = robot.feel?.expo ?? 1;
        const soft = (v) => Math.sign(v) * Math.abs(v) ** ex;
        robot.drive(soft(inp.forward) * slow, soft(inp.strafe) * slow, aimTurn ?? soft(inp.turn), STEP);
        ai.step(STEP, robot, game, match);
        world.step();
        robot.snapshot();
        ai.snapshot();
        fuel.snapshot();
        acc -= STEP;
      }
      physMs += performance.now() - p0;
      const wasDisabled = match.disabled;
      if (match.update(dt)) { ai.matchOver(game); showResults(); }
      // match sounds on each change of period
      if (match.on) {
        const ph = match.over ? 'MATCH OVER' : match.phase().name;
        if (lastCountdown > 0 && match.countdown === 0) sound.cue('start');
        else if (lastPhase && ph !== lastPhase) {
          if (ph === 'AUTO DONE') sound.cue('auto-end');
          else if (ph === 'TRANSITION') sound.cue('teleop');
          else if (ph.startsWith('SHIFT')) sound.cue('shift');
          else if (ph === 'END GAME') sound.cue('endgame');
          else if (ph === 'MATCH OVER') sound.cue('end');
        }
        lastPhase = ph;
        lastCountdown = match.countdown;
      } else { lastPhase = null; lastCountdown = 0; }
      if (match.disabled && !match.over && !wasDisabled && match.countdown === 0) toast('AUTO over: robots disabled until TELEOP', 'info', 3);
      if (match.over && !ui.results.hidden) {
        // FUEL still counts for 3 seconds after 0:00: keep the numbers live until then
        if (match.overT < 3.5) renderResults();
        const used = nav.update(ui.results, pad, dt);
        if (used) { /* A pressed the highlighted button */ }
        else if (input.pressed('confirm') && !navPressed(pad, PAD.A)) keepDriving();
        else if (input.pressed('special1')) start();
      }
      // fell through the world somehow: put it back
      if (robot.position(tmp).y < -1) restart();
    }

    if (toastT > 0 && (toastT -= dt) <= 0) toastEl.className = '';
    navPrev = pad ? pad.buttons.map((b) => b.value) : [];
    const alpha = state === 'play' ? acc / STEP : 1;
    robot.sync(dt, alpha);
    ai.sync(alpha);
    humans.update(dt);
    hubLights?.update(match, dt);
    fuel.sync(alpha);
    game.drawAim();
    game.drawHeld(now / 1000);
    sound.updateRobot(robot.speed(), robot.cmd.omega, !!game.aim && game.held > 0, state === 'play');
    updateCamera(dt);
    renderer.render(scene, camera);

    // HUD
    if (state === 'play') {
      setText(ui.mode, `${robot.fieldRelative ? 'Field relative' : 'Robot relative'} · speed ${robot.cfg.speedLevels.indexOf(robot.speedScale) + 1}`);
      setText(ui.speed, `${robot.speed().toFixed(1)} m/s`);
      setText(ui.cam, camName());
      const on = Object.entries(ACTIONS)
        .filter(([k]) => ['intake', 'autoShoot', 'autoPass', 'manualShoot', 'deload', 'special1', 'special2', 'special3'].includes(k) && input.held(k))
        .map(([, b]) => b.label);
      setText(ui.actions, on.join(' · '));
      setText(ui.held, `${game.held} / ${game.capacity}`);
      setText(ui.human, String(game.human.stash));
      // 3-2-1-GO (GO stays up for a moment once the clock starts)
      const cd = match.on ? match.countdown : 0;
      const cdText = cd > 0 ? String(Math.ceil(cd)) : match.on && match.t < 0.8 ? 'GO!' : '';
      setText(ui.countdown, cdText);
      ui.countdown.className = cdText ? (cd > 0 ? 'show' : 'show go') : '';
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
      const nums = (settings.alliance === a ? ['201'] : []).concat(ai.teams[a].map(String));
      document.querySelectorAll(`#sb-teams-${a} span`).forEach((slot, i) => {
        if (!slot.id) slot.id = `sb-${a}-${i}`;
        setClass(slot, settings.alliance === a && i === 0 ? 'us' : nums[i] ? 'ai' : '');
        setText(slot.querySelector('b'), nums[i] ?? '----');
      });
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
    const left = ph.name === 'AUTO' ? ph.left : ph.name === 'AUTO DONE' ? 0 : match.teleopLeft();
    const idx = TELEOP.indexOf(ph.name);
    setText(ui.sbClock, match.over ? 'FINAL' : clock(Math.ceil(left)));
    setText(ui.sbPhase, match.over ? '6 / 6' : idx >= 0 ? `${idx + 1} / 6` : ph.name === 'AUTO DONE' ? 'TELEOP IN' : 'AUTO');
    setText(ui.sbLeft, match.over ? ':00' : `:${String(Math.ceil(ph.left)).padStart(2, '0')}`);
  }

  // short message under the score bar (fouls, the AUTO-to-TELEOP pause)
  const toastEl = document.getElementById('toast');
  let toastT = 0;
  clearToast = () => { toastT = 0; toastEl.className = ''; };
  function toast(msg, kind = 'foul', secs = 3) {
    toastEl.textContent = msg;
    toastEl.className = `show ${kind}`;
    toastT = secs;
  }
  game.onFoul = (msg) => toast(msg);

  // The end-of-match screen, laid out like the FRC broadcast's results: winner, scores, AUTO and
  // TELEOP breakdown, teams and ranking points. RP thresholds are REBUILT's: ENERGIZED at 100
  // FUEL, SUPERCHARGED at 360 FUEL, TRAVERSAL at 50 TOWER points, plus 3 for a win / 1 for a tie.
  const RP_ICONS = {
    fuel: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>',
    super: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="4"/><circle cx="6" cy="13" r="4"/><circle cx="18" cy="13" r="4"/><circle cx="12" cy="19" r="4"/></svg>',
    tower: '<svg viewBox="0 0 24 24"><path d="M5 3h3v3h2.5V3h3v3H16V3h3v6l-2 2v7h2v3H5v-3h2v-7L5 9z"/></svg>',
    win: '<svg viewBox="0 0 24 24"><path d="M6 3h12v2h3v3a5 5 0 0 1-4.6 5A6 6 0 0 1 13 16.9V19h3v2H8v-2h3v-2.1A6 6 0 0 1 7.6 13 5 5 0 0 1 3 8V5h3zM5 7v1a3 3 0 0 0 1.6 2.7A9 9 0 0 1 6 7zm14 0h-1a9 9 0 0 1-.6 3.7A3 3 0 0 0 19 8z"/></svg>',
  };
  function renderResults() {
    const mine = settings.alliance;
    const opp = mine === BLUE ? RED : BLUE;
    const fouls = game.fouls.reduce((a, f) => a + f.pts, 0);
    const side = (al) => {
      const total = match.points[al];
      const pen = (al === opp ? fouls : 0) + (game.aiFouls || []).filter((f) => f.al !== al).reduce((a, f) => a + f.pts, 0);
      const auto = match.autoFuel[al];
      const tower = match.tower?.[al] || 0;
      return { total, auto, tele: Math.max(0, total - auto - pen - tower), pen, tower, fuel: total - pen - tower };
    };
    const S = { [BLUE]: side(BLUE), [RED]: side(RED) };
    const won = S[BLUE].total > S[RED].total ? BLUE : S[RED].total > S[BLUE].total ? RED : null;
    const rp = (al) => {
      const res = won === al ? 3 : won === null ? 1 : 0;
      return [S[al].fuel >= 100 && 'fuel', S[al].fuel >= 360 && 'super', S[al].tower >= 50, res >= 1, res >= 2, res >= 3];
    };
    const icons = (al) => {
      const got = rp(al);
      return ['fuel', 'super', 'tower', 'win', 'win', 'win'].map((k, i) => `<span class="${got[i] ? 'got' : ''}">${RP_ICONS[k]}</span>`).join('');
    };
    const teams = (al) => {
      // each robot: team number and the points it scored itself
      const rows = ai.bots.filter((b) => b.alliance === al).map((b) => ({ n: String(b.team), pts: b.scored + (b.towerPts || 0), note: b.name || b.typeName }));
      if (al === mine) rows.unshift({ n: '201', pts: game.myScored || 0, note: 'you' });
      while (rows.length < 3) rows.push(null);
      const rpTotal = rp(al).filter(Boolean).length;
      return rows.slice(0, 3).map((r) => (r
        ? `<div class="fr-team"><span>${r.n}<small>${r.pts} pts · ${r.note}</small></span><b>${rpTotal}</b></div>`
        : '<div class="fr-team empty"><span>----</span><b></b></div>')).join('');
    };
    const winner = (al) => won === al ? '<div class="fr-winner">' + RP_ICONS.win + 'WINNER</div>'
      : won === null ? '<div class="fr-winner tie">TIE</div>' : '<div class="fr-winner none"></div>';
    const row = (label, k, cls = '') => `<div class="fr-row ${cls}"><b>${S[BLUE][k]}</b><span>${label}</span><b>${S[RED][k]}</b></div>`;
    const pts = game.myScored || 0;
    const acc = game.shots ? Math.round(((pts + game.missedInactive) / game.shots) * 100) : 0;
    ui.resultsBody.innerHTML = `
      <div class="fr-col blue">${winner(BLUE)}<div class="fr-teams">${teams(BLUE)}</div>
        <div class="fr-rp"><h3>RANKING POINTS</h3><div class="fr-icons">${icons(BLUE)}</div></div></div>
      <div class="fr-mid">
        <div class="fr-scores"><div class="blue"><small>BLUE</small>${S[BLUE].total}</div><div class="red"><small>RED</small>${S[RED].total}</div></div>
        <div class="fr-table">
          <div class="fr-head">AUTO</div>${row('FUEL', 'auto')}<div class="fr-row"><b>0</b><span>TOWER</span><b>0</b></div>
          <div class="fr-head">TELEOP</div>${row('FUEL', 'tele', 'lite')}${row('TOWER', 'tower', 'lite')}${row('PENALTY', 'pen', 'lite')}
        </div>
        <div class="fr-stats">201: <b>${game.shots}</b> FUEL shot · <b>${acc}%</b> went in · <b>${game.missedInactive}</b> in an inactive HUB · fouls: <b>${(() => { const l = [...game.fouls.map((f) => `${f.kind} ${f.rule}`), ...(game.aiFouls || []).filter((f) => f.team === 201).map((f) => `${f.kind} (${f.why})`)]; return l.length ? l.join(', ') : 'none'; })()}</b></div>
      </div>
      <div class="fr-col red">${winner(RED)}<div class="fr-teams">${teams(RED)}</div>
        <div class="fr-rp"><h3>RANKING POINTS</h3><div class="fr-icons">${icons(RED)}</div></div></div>`;
  }
  function showResults() {
    updateScorebar();
    ui.scorebar.hidden = true;
    ui.hud.classList.add('final');
    renderResults();
    ui.results.hidden = false;
  }

  let camYaw = 0;
  let camDist = 3.4;
  let snapCam = false;
  let menuT = 0.6;
  const hubs = [hubCenter(BLUE), hubCenter(RED)];
  // the HUB itself plus the net that leans out over its NEUTRAL ZONE side (up to ~1 m out, 3 m up)
  // inside the field only: never out behind a driver station or past a guardrail
  // (the camera rides high enough to look over the alliance wall from just behind it)
  const camBlocked = (x, z) => Math.abs(x) > HALF_L + 1.0 || hubs.some((h) => {
    const dz = Math.abs(z - h.z);
    if (dz > 0.85) return false;
    const out = (x - h.x) * -Math.sign(h.x); // toward the field center
    return out > -0.75 && out < 1.05;
  });
  let camFlip = false; // false: third-person camera at your alliance's end, true: the far end
  function updateCamera(dt) {
    if (camera.userData.freeze) return; // debugging: hold a hand-placed camera
    const p = tmp.copy(robot.root.position); // the drawn (blended) pose, so the camera never jitters against the model
    const allianceSign = settings.alliance === BLUE ? -1 : 1;
    const view = camIndex;
    const mode = state === 'menu' ? 3 : view < THIRD ? 0 : view === THIRD ? 1 : 2;
    if (mode === 3) {
      // main menu: a slow orbit high over the field
      menuT += dt * 0.06;
      camPos.set(Math.cos(menuT) * 11, 5.5, Math.sin(menuT) * 7.5);
      camLook.set(0, 0.3, 0);
    } else if (mode === 0) {
      // standing behind the driver station glass, turning to follow the robot
      const st = STATIONS[view];
      const ds = fieldToWorld(0, st.fy, settings.alliance);
      camPos.set(allianceSign * (HALF_L + 0.6), 1.75, ds.z);
      camLook.set(p.x, 0.3, p.z);
      camLook.lerp(tmp2.set(0, 0, ds.z * 0.5), 0.35);
    } else if (mode === 1) {
      // third person, MoSim style: up high behind the robot, always looking down the field from
      // your alliance's end. It follows where the robot goes but not how it turns, so spinning
      // never swings the view. Flip (T / D-pad right) watches from the other end instead.
      camYaw = robot.fieldForward + (camFlip ? Math.PI : 0);
      const cx = -Math.cos(camYaw), cz = Math.sin(camYaw); // from the robot back toward the camera
      // never sit inside a HUB or its net: slide in closer until the spot is clear, smoothly
      let want = 3.0;
      while (want > 0.8 && camBlocked(p.x + cx * want, p.z + cz * want)) want -= 0.05;
      camDist += (want - camDist) * (1 - Math.exp(-dt * (want < camDist ? 10 : 3)));
      camPos.set(p.x + cx * camDist, 2.6, p.z + cz * camDist);
      camLook.set(p.x - cx * 1.2, 0.3, p.z - cz * 1.2);
    } else {
      camPos.set(p.x * 0.6 + allianceSign * 2.5, 10.2, p.z * 0.6); // under the light panels (10.8 m)
      camLook.set(p.x * 0.6, 0, p.z * 0.6);
    }
    // jump straight there when play starts, rather than sweeping in from the menu view
    const k = snapCam ? 1 : 1 - Math.exp(-dt * (mode === 0 ? 6 : 8));
    if (snapCam && camera.userData.look) camera.userData.look.copy(camLook);
    snapCam = false;
    camera.position.lerp(camPos, k);
    // the follow camera never pokes through the guardrails or the alliance walls, even mid-swing
    if (mode === 1) {
      camera.position.x = Math.max(-HALF_L - 1.0, Math.min(HALF_L + 1.0, camera.position.x));
      camera.position.z = Math.max(-HALF_W - 0.5, Math.min(HALF_W + 0.5, camera.position.z));
    }
    if (!camera.userData.look) camera.userData.look = camLook.clone();
    camera.userData.look.lerp(camLook, k);
    camera.lookAt(camera.userData.look);
  }

  requestAnimationFrame(frame);
  window.__sim = { get hubLights() { return hubLights; }, nav, maps, robot, world, input, settings, game, fuel, player, renderer, scene, camera, sun, fieldGroup, THREE, match, ai }; // handy for debugging in the console
}

/**
 * The CAD has colors but no textures. Give every surface real-looking grain: a fine noise and
 * brushed streak texture, projected from the three world axes (no UVs needed), that varies the
 * color and shine a little, so panels read as painted metal and plastic instead of flat fills.
 */
function addSurfaceDetail(mat) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  const streak = new Float32Array(256);
  for (let y = 0; y < 256; y++) streak[y] = (Math.random() - 0.5) * 0.5;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const v = 128 + (Math.random() - 0.5) * 70 + streak[y] * 60 + Math.sin(x * 0.05 + y * 0.013) * 8;
    const i = (y * 256 + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, v)); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uDetail;\nvarying vec3 vWPos;\nvarying vec3 vWNrm;\nfloat detailAt() {\n  vec3 w = abs(normalize(vWNrm)); w = pow(w, vec3(4.0)); w /= (w.x + w.y + w.z);\n  vec3 q = vWPos * 2.5;\n  return texture2D(uDetail, q.zy).r * w.x + texture2D(uDetail, q.xz).r * w.y + texture2D(uDetail, q.xy).r * w.z;\n}')
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat dtl = detailAt();\ndiffuseColor.rgb *= 0.86 + 0.28 * dtl;')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (dtl - 0.5) * 0.35, 0.25, 1.0);');
  };
}

/** Load the converted official field CAD, if it was built. Returns true when it's in the scene. */
async function loadFieldCad(scene) {
  const url = `${import.meta.env.BASE_URL}models/field.glb`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok || (head.headers.get('content-type') || '').includes('text/html')) return false;
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const solid = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.15, roughness: 0.65 });
    addSurfaceDetail(solid);
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material?.name === 'field_carpet') { o.visible = false; return; }
      if (o.material?.name === 'field_clear') {
        o.material = new THREE.MeshStandardMaterial({ color: 0xcfe0f2, transparent: true, opacity: 0.16, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false });
      } else {
        // smooth round parts, keep box edges crisp (flat shading looked faceted)
        o.geometry = toCreasedNormals(o.geometry, Math.PI / 5);
        o.material = solid;
        o.receiveShadow = true;
        o.castShadow = true;
      }
    });
    scene.add(gltf.scene);
    buildAprilTags(scene);
    return true;
  } catch (e) {
    console.warn('field CAD not loaded', e);
    return false;
  }
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
