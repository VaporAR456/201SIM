# 201SIM

A driver-practice simulator for FRC Team 201's 2026 REBUILT robot. It runs in the browser
with nothing to install, and plays with an Xbox, PlayStation or generic USB controller.

**Status:** milestone 1. You can drive a swerve robot around the REBUILT field (HUBs, BUMPs,
TRENCHES, TOWERS) from the driver station view. FUEL, intake, shooting and scoring come next.

## Play

Open the GitHub Pages link for this repo, plug in a controller and press any button on it,
then press **A** to start.

| Action | Controller | Keyboard |
| --- | --- | --- |
| Drive | Left stick | W A S D |
| Rotate | Right stick | J / L or ← → |
| Intake | LT | Shift |
| Auto shoot | RT | Space |
| Auto pass | RB | E |
| Manual shoot | LB | Q |
| Robot special | Y | R |
| Field / robot relative | B | F |
| Reset gyro | X | G |
| Slow mode (hold) | Left stick click | Ctrl |
| Camera | D-pad ← → | C |
| Pause | Menu | Esc |
| Restart (hold) | View | Backspace |

The layout is a draft and will be matched to MoSim's.

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

### One-time GitHub Pages setup

In the repo, open **Settings → Pages** and set **Source** to **GitHub Actions**.
