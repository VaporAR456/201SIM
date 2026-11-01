// Field geometry for 2026 REBUILT. Measurements are from the 2026 FRC Game Manual
// (Section 5, ARENA) and the official field drawings. Units: meters.
//
// Coordinates
//   Field frame (WPILib style): origin at the right corner of the BLUE alliance wall from the
//   blue drivers' view. fx runs toward the red wall, fy runs to the blue drivers' left.
//   World frame (three.js / Rapier): Y up, field centered on the origin.
//     X = fx - L/2   (blue wall at -X, red wall at +X)
//     Z = W/2 - fy   (blue drivers' right is +Z)
//   The red half is the blue half turned 180 degrees about Y: (x, z) -> (-x, -z).

export const IN = 0.0254;

export const FIELD_L = 651.2 * IN; // 16.54 m
export const FIELD_W = 317.7 * IN; // 8.07 m
export const HALF_L = FIELD_L / 2;
export const HALF_W = FIELD_W / 2;

export const BLUE = 'blue';
export const RED = 'red';

/** Blue-side field coords -> world {x, z}, mirrored onto the red half when asked. */
export function fieldToWorld(fx, fy, alliance = BLUE) {
  const x = fx - HALF_L;
  const z = HALF_W - fy;
  return alliance === BLUE ? { x, z } : { x: -x, z: -z };
}

export const ALLIANCE_ZONE_DEPTH = 158.6 * IN; // ROBOT STARTING LINE

export const WALL = {
  sideHeight: 20 * IN,
  allianceHeight: 78 * IN, // alliance wall plus driver station glass
  thick: 0.1,
};

export const HUB = {
  size: 47 * IN,
  fx: 158.6 * IN + (47 * IN) / 2,
  rim: 72 * IN,
  openingAcross: 41.7 * IN,
};

export const BUMP = {
  width: 73.0 * IN, // along fy
  depth: 44.4 * IN, // along fx
  height: 6.513 * IN,
  topDepth: 12 * IN, // flat on top of the ramp (approximate)
};

export const TRENCH = {
  width: 62.28 * IN, // field edge to the BUMP side of the skirt
  depth: 47.0 * IN,
  clearWidth: 50.34 * IN, // the drivable opening
  clearHeight: 22.25 * IN, // robots taller than this hit the arm
  armTop: 26.25 * IN,
  skirtHeight: 18.86 * IN,
  tagTop: 40.25 * IN,
};

export const TOWER = {
  fy: 3.7457,
  width: 49.25 * IN,
  depth: 45.0 * IN,
  height: 78.25 * IN,
  baseWidth: 39.0 * IN,
  baseDepth: 45.18 * IN,
  uprightHeight: 72.1 * IN,
  uprightGap: 32.25 * IN,
};

export const DEPOT = { fy: 5.965, width: 42.0 * IN, depth: 27.0 * IN, barrierH: 1.125 * IN };
export const OUTPOST = { fy: 0.666, width: 35.8 * IN, depth: 37.6 * IN };

// Driver station centers along the alliance wall (blue fy), left/center/right from the drivers' view
export const STATIONS = [
  { name: 'Left', fy: 7.2 },
  { name: 'Center', fy: 5.45 },
  { name: 'Right', fy: 2.35 },
];

export const COLORS = {
  blue: 0x1f6fff,
  red: 0xe8322f,
  carpet: 0x3a3f44,
  tape: 0xf2f2f2,
  steel: 0x9aa3ab,
  poly: 0xcfe8ff,
};

// Rapier collision groups: (membership << 16) | filter
export const GROUP = {
  FIELD: 0x0001, // walls, HUBS, TRENCH arms, TOWERS...
  TERRAIN: 0x0002, // BUMPS
  INTAKE: 0x0004,
  FUEL: 0x0008,
  GATE: 0x0010,
  HELD: 0x0020, // FUEL riding in the robot's hopper // the hopper's front: FUEL being fed by the intake passes through it, nothing else does
};
export const groups = (member, filter = 0xffff) => (member << 16) | filter;
