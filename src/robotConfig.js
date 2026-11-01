// Every number that controls how 201's robot drives lives here, so the team can tune the feel
// without touching the rest of the code. Units: meters, seconds, kilograms, radians.
//
// Size and module positions are measured from 201's CAD (2026 Rebuilt Robot, Onshape).
// Frame size, weight, drive ratio and the hopper motion come from 201's own MoSim mod
// (201-2026v1.1): frame 27.5 x 27 in, weight 60, swerve ratio 6:1, traction 1.1.

const IN = 0.0254;

export const ROBOT_201 = {
  name: 'FRC 201',

  // Size
  frameLength: 26.5 * IN, // frame, front to back, without bumpers (CAD bumpers are 33 in long outside)
  frameWidth: 27.5 * IN, // frame side to side, without bumpers (CAD bumpers are 34 in wide outside)
  bumperThickness: 3.25 * IN,
  bumperHeight: 5 * IN, // bumper zone thickness
  bumperBottom: 1.75 * IN, // gap between carpet and bottom of bumpers (CAD)
  height: 0.559, // tallest point (top of the shooter in CAD, 22.0in); under 22.25in fits the TRENCH
  // deployed intake reaches this far past the front bumper (CAD: 8.1in)
  intakeReach: 0.207,
  intakeWidth: 0.72,
  // near the 115 lb robot limit + 13 lb bumpers + ~12.5 lb battery = ~138 lb
  mass: 63, // kg

  // Swerve
  // MK5n R3 ("L3"): Kraken X60 (6000 rpm free) through 5.27:1 on a 4in wheel = 6.06 m/s free; ~90% on carpet
  driveRatio: 5.27,
  maxSpeed: 5.45, // m/s
  maxAccel: 9.0, // m/s^2, traction-limited (wheel friction 1.1 x g, minus losses)
  maxOmega: 2 * Math.PI * 1.6, // rad/s top turn rate
  maxAlpha: 30, // rad/s^2 turn acceleration
  // swerve module centers from the robot center (CAD: SDS MK5n), x forward, z right
  modules: [[0.276, 0.283], [0.276, -0.283], [-0.276, 0.283], [-0.276, -0.283]],
  wheelRadius: 2 * IN,

  // Driver feel
  // Expanding hopper (the agitator): out 12in to intake; while shooting it cycles between
  // 12in out (held 1s) and 4in in (held 0.375s) at up to 30 in/s, stirring FUEL into the indexer
  hopper: { outIn: 12, inIn: -4, outHold: 1.0, inHold: 0.375, maxSpeedInPerS: 30 },

  // Shooter. facing: -1 shoots out the back of the robot (where the Kicker & Shooter sits in
  // the CAD), +1 out the front. Angles are hood angles above horizontal.
  preload: 8,
  shooter: {
    facing: -1,
    exit: [-0.22, 0.66, 0], // where FUEL leaves the shooter, robot frame (x forward, y up)
    maxExitSpeed: 9.5, // m/s at normal power; passing multiplies this by the Pass power boost
    angleNear: 72, nearDist: 1.5, // steep lob up close...
    angleFar: 52, farDist: 6, // ...flatter from far away
    aimHeight: 1.95, // m, center of the HUB opening (rim is 72in)
    manualDist: 3.0, // m, manual shoot is a fixed shot tuned for this distance
    passAngle: 45,
    passLandFx: 2.4, // m from your alliance wall where passes aim to land
    spreadDeg: 1.0,
    speedNoise: 0.02,
  },

  // Where held FUEL sits (robot frame, meters), and the net stretched over the top of it
  // where held FUEL is drawn (the open hopper between the side plates, in front of the shooter tower)
  hopperBox: { x: [-0.03, 0.53], z: [-0.32, 0.32], y0: 0.12 }, // x: with the hopper slid all the way out
  // the net is tied to the top of the shooter tower at the back, the side plates, and the top of
  // the intake at the front, so it stretches and goes slack as the hopper slides in and out
  netRig: { rearX: -0.05, rearY: 0.53, frontX: 0.6, frontY: 0.47, sideZ: 0.36, sideY: 0.45 },
  // The net: when the hopper is full, ramming more FUEL into the intake crams one extra in every
  // cramEvery seconds (up to cramExtra); keep forcing it for breakAfter seconds and it tears.
  net: { cramExtra: 3, cramEvery: 1.5, breakAfter: 5, recover: 0.5 },

  // Drive speed presets (fraction of top speed) for the Drive speed 1 / 2 / 3 buttons
  speedLevels: [0.35, 0.7, 1],
};
