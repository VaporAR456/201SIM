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
  frameLength: 27 * IN, // frame, front to back, without bumpers (CAD)
  frameWidth: 28.125 * IN, // frame side to side, without bumpers (CAD)
  bumperThickness: 3.25 * IN,
  bumperHeight: 5 * IN, // bumper zone thickness
  bumperBottom: 2 * IN, // gap between carpet and bottom of bumpers
  height: 0.559, // tallest point (top of the shooter in CAD, 22.0in); under 22.25in fits the TRENCH
  // deployed intake reaches this far past the front bumper (CAD: 8.1in)
  intakeReach: 0.207,
  intakeWidth: 0.72,
  mass: 60, // kg, PLACEHOLDER: from the MoSim mod, which the CAD lead says is not accurate

  // Swerve
  // Kraken X60 (6000 rpm free) through 6:1 on a 4in wheel = 5.32 m/s free; ~90% of that on carpet
  driveRatio: 6,
  maxSpeed: 4.8, // m/s, PLACEHOLDER: from the MoSim mod, waiting on real numbers
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
  hopperBox: { x: [-0.3, 0.3], z: [-0.3, 0.3], y0: 0.1, netY: 0.6 },
  // The net: when the hopper is full, ramming more FUEL into the intake crams one extra in every
  // cramEvery seconds (up to cramExtra); keep forcing it for breakAfter seconds and it tears.
  net: { cramExtra: 3, cramEvery: 1.5, breakAfter: 5, recover: 0.5 },

  // Drive speed presets (fraction of top speed) for the Drive speed 1 / 2 / 3 buttons
  speedLevels: [0.35, 0.7, 1],
};
