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
  frameLength: 27.5 * IN, // frame perimeter, front to back (without bumpers); 34in with bumpers
  frameWidth: 27 * IN,
  bumperThickness: 3.25 * IN,
  bumperHeight: 5 * IN, // bumper zone thickness
  bumperBottom: 2 * IN, // gap between carpet and bottom of bumpers
  height: 0.559, // tallest point (top of the shooter in CAD, 22.0in); under 22.25in fits the TRENCH
  // deployed intake reaches this far past the front bumper (CAD: 8.1in)
  intakeReach: 0.207,
  intakeWidth: 0.72,
  mass: 60, // kg, with battery and bumpers (MoSim mod robotWeight 60; check if that was lb)

  // Swerve
  // Kraken X60 (6000 rpm free) through 6:1 on a 4in wheel = 5.32 m/s free; ~90% of that on carpet
  driveRatio: 6,
  maxSpeed: 4.8, // m/s
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

  // Drive speed presets (fraction of top speed) for the Drive speed 1 / 2 / 3 buttons
  speedLevels: [0.35, 0.7, 1],
};
