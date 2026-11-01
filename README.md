# 201SIM

A driver-practice simulator for FRC Team 201's 2026 REBUILT robot. It runs in the browser
with nothing to install, and plays with an Xbox, PlayStation or generic USB controller.

**Status:** drive 201's robot around the REBUILT field, pick up FUEL, and shoot or pass it.
Auto shoot aims at your HUB (shoot on the move included), auto pass lobs FUEL back to your
alliance zone with a stronger "pass power boost", and the expanding hopper agitates while
shooting like the real robot. Shooter power, pass boost, fire rate and hopper size are in
**Settings**. Match mode runs the real 2:40 REBUILT clock (AUTO, TRANSITION, four HUB SHIFTS, END GAME) and only counts FUEL in your active HUB. Climbing comes next.

## Play

Open the GitHub Pages link for this repo, plug in a controller and press any button on it,
then press **A** to start.

The default layout matches MoSim's REBUILT keybinds. Everything can be remapped from
**Controls** in the main or pause menu, with a Reset on every row. Bindings save in your browser.

| Action | Controller | Keyboard |
| --- | --- | --- |
| Drive | Left stick | W A S D |
| Steer | Right stick | J / L |
| Drive speed 1 / 2 / 3 | - | 1 / 2 / 3 |
| Intake | LT | Shift |
| Auto shoot | RT | K |
| Auto pass | RB | E |
| Free shoot (no auto-aim) | LB | Q |
| Climb | D-pad down | C |
| Robot special 1 / 2 / 3 | Y / X / B | V / I / O |
| Swap camera (driver stations 1-3, third person, overhead; also in the pause menu) | Right stick click | Space |
| Third person: view from the intake side / the shooter side | D-pad right | T |
| Field / robot relative | D-pad left | F |
| Reset gyro | D-pad up | G |
| Pause | Menu | Esc |
| Restart (hold) | View | Backspace |

## Tune the robot

Everything that controls how the robot drives is in [`src/robotConfig.js`](src/robotConfig.js):
size, weight, top speed, acceleration and turn rate. Change a number, push, and the live site
updates in about a minute.

## Develop

```sh
npm install
npm run dev      # local server with hot reload
npm run build    # production build into dist/
```

Built with [Three.js](https://threejs.org) for 3D and [Rapier](https://rapier.rs) for physics.
Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

Field measurements come from the 2026 FRC Game Manual, Section 5.

### Updating the robot model

`tools/step2glb.py` turns an Onshape STEP export (Y axis up, hidden instances off) into a GLB with
OpenCascade (`pip install cadquery-ocp`). `tools/optimize.mjs` strips hardware, simplifies and
compresses it into `public/models/robot201.glb` (`npm i @gltf-transform/core @gltf-transform/functions
@gltf-transform/extensions meshoptimizer`).

### One-time GitHub Pages setup

In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
