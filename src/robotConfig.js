// Every number that controls how 201's robot drives lives here, so the team can tune the feel
// without touching the rest of the code. Units: meters, seconds, kilograms, radians.
//
// Size and module positions are measured from 201's CAD (2026 Rebuilt Robot, Onshape).
// Speed, acceleration and weight are still PLACEHOLDERS typical for an SDS MK5n + Kraken X60
// swerve; replace them with 201's real numbers (gear ratio, weight) once we have them.

const IN = 0.0254;

export const ROBOT_201 = {
  name: 'FRC 201',

  // Size
  frameLength: 27.5 * IN, // frame perimeter, front to back (without bumpers); 34in with bumpers
  frameWidth: 27.5 * IN,
  bumperThickness: 3.25 * IN,
  bumperHeight: 5 * IN, // bumper zone thickness
  bumperBottom: 2 * IN, // gap between carpet and bottom of bumpers
  height: 0.559, // tallest point (top of the shooter in CAD, 22.0in); under 22.25in fits the TRENCH
  // deployed intake reaches this far past the front bumper (CAD: 8.1in)
  intakeReach: 0.207,
  intakeWidth: 0.72,
  mass: 56, // kg, with battery and bumpers

  // Swerve
  maxSpeed: 4.6, // m/s free speed at the wheel
  maxAccel: 9.0, // m/s^2, traction-limited acceleration
  maxOmega: 2 * Math.PI * 1.6, // rad/s top turn rate
  maxAlpha: 30, // rad/s^2 turn acceleration
  // swerve module centers from the robot center (CAD: SDS MK5n), x forward, z right
  modules: [[0.276, 0.283], [0.276, -0.283], [-0.276, 0.283], [-0.276, -0.283]],
  wheelRadius: 2 * IN,

  // Driver feel
  slowModeScale: 0.35,
};
