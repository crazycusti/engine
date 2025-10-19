/**
 * Physics and movement constants for the Quake engine.
 * @module PhysicsConstants
 */

/**
 * Minimum ground angle normal (Z component) to be considered "on ground".
 * Normal vectors with Z >= this value are walkable slopes.
 * @constant {number}
 */
export const GROUND_ANGLE_THRESHOLD = 0.7;

/**
 * Maximum step height an entity can climb automatically (in units).
 * @constant {number}
 */
export const STEP_HEIGHT = 18.0;

/**
 * Epsilon value for velocity comparisons and clipping.
 * Values smaller than this are considered negligible.
 */
export const VELOCITY_EPSILON = 0.1;

/**
 * Water movement speed multiplier (reduces speed to 70% in water).
 */
export const WATER_SPEED_FACTOR = 0.7;

/**
 * Number of bump iterations allowed in fly/move physics.
 */

/**
 * Overbounce factor for wall/floor collisions.
 * Values > 1.0 make objects bounce slightly, < 1.0 absorb energy.
 * @constant {number}
 */
export const BOUNCE_OVERBOUNCE = 1.0;

/**
 * Overbounce factor for stopping movement.
 * @constant {number}
 */
export const STOP_OVERBOUNCE = 1.0;

/**
 * Maximum number of collision planes to slide against in flyMove.
 * @constant {number}
 */
export const MAX_CLIP_PLANES = 5;

/**
 * Maximum number of bump iterations in flyMove.
 * @constant {number}
 */
export const MAX_BUMP_COUNT = 4;

/**
 * Blocked flags for movement traces.
 * @readonly
 * @enum {number}
 */
export const BlockedFlags = {
  /** Movement not blocked */
  NONE: 0,
  /** Blocked by floor */
  FLOOR: 1,
  /** Blocked by wall/step */
  WALL: 2,
  /** Blocked by floor and wall */
  BOTH: 3,
};
