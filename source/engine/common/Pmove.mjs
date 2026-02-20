/*
 * Pmove — shared player movement code, designed to run identically on both
 * client (for prediction) and server (for authoritative simulation).
 *
 * Inspired by Quake 2's pmove.c with structural elements from QuakeWorld.
 * Original id Software sources: pmove.c, pmovetst.c (Q2), pmove.c (QW).
 */

import { eventBus, registry } from '../registry.mjs';
import Vector from '../../shared/Vector.mjs';
import * as Protocol from '../network/Protocol.mjs';
import { content, solid } from '../../shared/Defs.mjs';

/** @typedef {import('../../shared/Vector.mjs').DirectionalVectors} DirectionalVectors */

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DIST_EPSILON = 0.03125;
export const STOP_EPSILON = 0.1;
export const STEPSIZE = 18.0;

/** Minimum ground normal Z component — slopes steeper than ~45° are not walkable */
export const MIN_STEP_NORMAL = 0.7;

/** Maximum number of planes to clip against during slide moves */
export const MAX_CLIP_PLANES = 5;

/**
 * Player movement flags (pmove-specific, separate from entity flags).
 * These travel with the player state and are used for prediction.
 * @readonly
 * @enum {number}
 */
export const PMF = Object.freeze({
  /** Player is ducked */
  DUCKED: (1 << 0),
  /** Player has jump button held (prevent re-jump) */
  JUMP_HELD: (1 << 1),
  /** Player is on the ground */
  ON_GROUND: (1 << 2),
  /** Timing: landing cooldown (prevents immediate re-jump after hard landing) */
  TIME_LAND: (1 << 3),
  /** Timing: water jump is active */
  TIME_WATERJUMP: (1 << 4),
  /** Timing: teleport freeze */
  TIME_TELEPORT: (1 << 5),
});

/**
 * Player movement types.
 * @readonly
 * @enum {number}
 */
export const PM_TYPE = Object.freeze({
  /** Normal movement */
  NORMAL: 0,
  /** Spectator noclip flight */
  SPECTATOR: 1,
  /** Dead — reduced input, extra friction */
  DEAD: 2,
  /** Frozen — no movement at all */
  FREEZE: 3,
});

// ---------------------------------------------------------------------------
// MoveVars — shared physics tuning knobs
// ---------------------------------------------------------------------------

/**
 * Pmove variable defaults — physics tuning knobs shared between client and server.
 */
export class MoveVars { // movevars_t
  constructor() {
    /** @type {number} world gravity (units/sec²) */
    this.gravity = 800;
    /** @type {number} speed below which friction acts at full strength */
    this.stopspeed = 100;
    /** @type {number} maximum walking speed */
    this.maxspeed = 320;
    /** @type {number} maximum spectator speed */
    this.spectatormaxspeed = 500;
    /** @type {number} duck speed cap */
    this.duckspeed = 100;
    /** @type {number} ground acceleration factor */
    this.accelerate = 10;
    /** @type {number} air acceleration factor */
    this.airaccelerate = 0.7;
    /** @type {number} water acceleration factor */
    this.wateraccelerate = 10;
    /** @type {number} ground friction factor */
    this.friction = 6;
    /** @type {number} water friction factor */
    this.waterfriction = 1;
    /** @type {number} maximum water speed */
    this.waterspeed = 400;
    /** @type {number} per-entity gravity multiplier (1.0 = normal) */
    this.entgravity = 1.0;
    /** @type {number} edge friction multiplier */
    this.edgefriction = 2;
  }
};

// ---------------------------------------------------------------------------
// Geometry primitives — Plane, Trace, ClipNode, Hull, BoxHull
// ---------------------------------------------------------------------------

export class Plane { // mplane_t
  constructor() {
    this.normal = new Vector();
    this.dist = 0;
    /** @type {number} for texture axis selection and fast side tests */
    this.type = 0;
    /** @type {number} signx + signy<<1 + signz<<1 */
    this.signBits = 0;
  }
};

export class Trace { // pmtrace_t
  constructor() {
    /** if true, plane is not valid */
    this.allsolid = true;
    /** if true, the initial point was in a solid area */
    this.startsolid = false;
    /** time completed, 1.0 = didn't hit anything */
    this.fraction = 1.0;
    /** final position */
    this.endpos = new Vector();
    /** surface normal at impact */
    this.plane = new Plane();
    /** @type {?number} edict number the surface is on, if applicable */
    this.ent = null;
    /** true if the surface is in a open area */
    this.inopen = false;
    /** true if the surface is in water */
    this.inwater = false;
  }

  /**
   * Sets this trace to the other trace.
   * @param {Trace} other other trace
   * @returns {Trace} this
   */
  set(other) {
    console.assert(other instanceof Trace, 'other must be a Trace');

    this.allsolid = other.allsolid;
    this.startsolid = other.startsolid;
    this.fraction = other.fraction;
    this.endpos.set(other.endpos);
    this.plane.normal.set(other.plane.normal);
    this.plane.dist = other.plane.dist;
    this.ent = other.ent;
    this.inopen = other.inopen;
    this.inwater = other.inwater;

    return this;
  }

  /**
   * Creates a copy.
   * @returns {Trace} copy of this trace
   */
  copy() {
    const trace = new Trace();
    trace.set(this);
    return trace;
  }
};

export class ClipNode { // dclipnode_t
  constructor(planeNum = 0) {
    this.planeNum = planeNum;
    this.children = [0, 0];
  }
};

export class Hull { // hull_t
  constructor() {
    this.clipMins = new Vector();
    this.clipMaxs = new Vector();
    this.firstClipNode = 0;
    this.lastClipNode = 0;
    /** @type {ClipNode[]} */
    this.clipNodes = [];
    /** @type {Plane[]} */
    this.planes = [];
  }

  static fromModelHull(hull) {
    const newHull = new Hull();
    newHull.clipMins = hull.clip_mins.copy();
    newHull.clipMaxs = hull.clip_maxs.copy();
    newHull.firstClipNode = hull.firstclipnode;
    newHull.lastClipNode = hull.lastclipnode;
    newHull.clipNodes = hull.clipnodes.map((clipnode) => {
      const node = new ClipNode(clipnode.planenum);
      node.children[0] = clipnode.children[0];
      node.children[1] = clipnode.children[1];
      return node;
    });
    newHull.planes = hull.planes.map((plane) => {
      const newPlane = new Plane();
      newPlane.normal = plane.normal.copy();
      newPlane.dist = plane.dist;
      newPlane.type = plane.type;
      newPlane.signBits = plane.signbits;
      return newPlane;
    });

    return newHull;
  }

  /**
   * Determine if a point is inside the hull and if so, return the content type.
   * @param {Vector} point point to test
   * @param {number} num clip node to start
   * @returns {number} content type
   */
  pointContents(point, num = this.firstClipNode) {
    // as long as num is a valid node, keep going down the tree
    while (num >= 0) {
      console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid hull node', num);

      console.assert(this.clipNodes[num], 'valid hull node', num);
      const node = this.clipNodes[num];

      console.assert(this.planes[node.planeNum], 'valid hull plane', node.planeNum);
      const plane = this.planes[node.planeNum];

      let d = 0;

      if (plane.type < 3) {
        d = point[plane.type] - plane.dist;
      } else {
        d = plane.normal.dot(point) - plane.dist;
      }

      // WinQuake: d < 0 → children[1], else children[0].
      // Must match hull.check's `t1 >= 0 && t2 >= 0 → children[0]`
      // so that pointContents and check agree on boundary classification.
      num = node.children[d < 0 ? 1 : 0];
    }

    return num;
  }

  /**
   * Check against hull.
   * @param {number} p1f fraction at p1 (usually 0.0)
   * @param {number} p2f fraction at p2 (usually 1.0)
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {Trace} trace object to store trace results
   * @param {number} num starting clipnode number (typically hull.firstclipnode)
   * @returns {boolean} true means going down, false means going up
   */
  check(p1f, p2f, p1, p2, trace, num = this.firstClipNode) {
    // check for empty
    if (num < 0) {
      if (num !== content.CONTENT_SOLID) {
        trace.allsolid = false;
        if (num === content.CONTENT_EMPTY) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true; // going down the tree
    }

    console.assert(num >= this.firstClipNode && num <= this.lastClipNode, 'valid node number', num);

    // find the point distances
    const node = this.clipNodes[num];
    const plane = this.planes[node.planeNum];
    const t1 = (plane.type < 3 ? p1[plane.type] : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
    const t2 = (plane.type < 3 ? p2[plane.type] : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

    // checking children on side 1
    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[0]);
    }

    // checking children on side 2
    if (t1 < 0.0 && t2 < 0.0) {
      return this.check(p1f, p2f, p1, p2, trace, node.children[1]);
    }

    // put the crosspoint DIST_EPSILON pixels on the near side
    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2))); // epsilon value of 0.03125 = 1/32
    let midf = p1f + (p2f - p1f) * frac;
    const mid = new Vector(p1[0] + frac * (p2[0] - p1[0]), p1[1] + frac * (p2[1] - p1[1]), p1[2] + frac * (p2[2] - p1[2]));
    const side = t1 < 0.0 ? 1 : 0;

    // move up to the node
    if (!this.check(p1f, midf, p1, mid, trace, node.children[side])) {
      return false;
    }

    // go past the node
    if (this.pointContents(mid, node.children[1 - side]) !== content.CONTENT_SOLID) {
      return this.check(midf, p2f, mid, p2, trace, node.children[1 - side]);
    }

    // never got out of the solid area
    if (trace.allsolid) {
      return false;
    }

    // the other side of the node is solid, this is the impact point
    if (side === 0) {
      trace.plane.normal = plane.normal.copy();
      trace.plane.dist = plane.dist;
    } else {
      trace.plane.normal = plane.normal.copy().multiply(-1);
      trace.plane.dist = -plane.dist;
    }

    while (this.pointContents(mid) === content.CONTENT_SOLID) {
      // shouldn't really happen, but does occasionally
      frac -= 0.1;
      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos = mid.copy();
        console.warn('fraction < 0.0', frac, trace);
        return false;
      }
      midf = p1f + (p2f - p1f) * frac;
      mid[0] = p1[0] + frac * (p2[0] - p1[0]);
      mid[1] = p1[1] + frac * (p2[1] - p1[1]);
      mid[2] = p1[2] + frac * (p2[2] - p1[2]);
    }

    trace.fraction = midf;
    trace.endpos = mid.copy();

    return false;
  }
};

// ---------------------------------------------------------------------------
// BoxHull — AABB → BSP conversion for non-BSP entity collision
// ---------------------------------------------------------------------------

/**
 * Set up the planes and clipnodes so that the six floats of a bounding box
 * can just be stored out and get a proper hull_t structure.
 * To keep everything totally uniform, bounding boxes are turned into small
 * BSP trees instead of being compared directly.
 * Use setSize() to set the box size.
 */
export class BoxHull extends Hull {
  constructor() {
    super();

    this.clipNodes = [
      new ClipNode(0),
      new ClipNode(1),
      new ClipNode(2),
      new ClipNode(3),
      new ClipNode(4),
      new ClipNode(5),
    ];

    this.firstClipNode = 0;
    this.lastClipNode = 5;

    this.planes = [
      new Plane(), // 0
      new Plane(), // 1
      new Plane(), // 2
      new Plane(), // 3
      new Plane(), // 4
      new Plane(), // 5
    ];

    for (let i = 0; i < 6; i++) {
      const side = i & 1;

      this.clipNodes[i].children[side] = content.CONTENT_EMPTY;
      this.clipNodes[i].children[side ^ 1] = i !== 5 ? i + 1 : content.CONTENT_SOLID;

      this.planes[i].type = i >> 1;
      // Axis-aligned unit normal — matches WinQuake: box_planes[i].normal[i>>1] = 1
      const normal = new Vector(0, 0, 0);
      normal[i >> 1] = 1;
      this.planes[i].normal = normal;
    }
  }

  /**
   * @param {Vector} mins mins
   * @param {Vector} maxs maxs
   * @returns {BoxHull} this
   */
  setSize(mins, maxs) {
    console.assert(mins instanceof Vector, 'mins must be a Vector');
    console.assert(maxs instanceof Vector, 'maxs must be a Vector');

    // Even planes (0,2,4) use maxs; odd planes (1,3,5) use mins.
    // Matches WinQuake's SV_HullForBox.
    for (let i = 0; i < 6; i++) {
      this.planes[i].dist = (i & 1) ? mins[i >> 1] : maxs[i >> 1];
    }

    return this;
  }
};

// ---------------------------------------------------------------------------
// PhysEnt — a physics entity stored in the Pmove world
// ---------------------------------------------------------------------------

export class PhysEnt { // physent_t
  /**
   * @param {Pmove} pmove parent pmove instance
   */
  constructor(pmove) {
    /** only for bsp models @type {Hull[]} */
    this.hulls = [];
    /** origin */
    this.origin = new Vector();
    /** only for non-bsp models */
    this.mins = new Vector();
    /** only for non-bsp models */
    this.maxs = new Vector();
    /** actual edict index, used to map back to edicts @type {?number} */
    this.edictId = null;

    /** @type {WeakRef<Pmove>} @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove} pmove @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  /**
   * Returns clipping hull for this entity.
   * NOTE: This is not async/wait safe, since it will modify pmove's boxHull in-place.
   * @returns {Hull} hull
   */
  getClippingHull() {
    if (this.hulls.length > 0) {
      return this.hulls[1]; // player hull
    }

    const mins = this.mins.copy().subtract(Pmove.PLAYER_MAXS);
    const maxs = this.maxs.copy().subtract(Pmove.PLAYER_MINS);

    return this._pmove.boxHull.setSize(mins, maxs);
  }

  // CR: we can add getClippingHullCrouch() for BSP30 hulls here later
};

// ---------------------------------------------------------------------------
// PmovePlayer — the core player movement simulation
//
// Follows Q2's Pmove() structure:
//   1. ClampAngles         — resolve view angles from cmd + deltas
//   2. CheckDuck           — set player bounds based on stance
//   3. SnapPosition (init) — nudge into valid position
//   4. CatagorizePosition  — determine ground entity, water level
//   5. CheckSpecialMovement — ladders, water jumps
//   6. Drop timing counter — pm_time for land/waterjump/teleport
//   7. Movement dispatch   — jump, friction, then air/water/fly
//   8. CatagorizePosition  — final ground + water check
//   9. SnapPosition        — quantize for network
//
// This class is designed to be called identically from both client
// (for prediction) and server (for authoritative movement). It reads
// input from `cmd` and `pmFlags`/`pmTime`, and writes output to
// `origin`, `velocity`, `pmFlags`, etc.
// ---------------------------------------------------------------------------

/**
 * Q2-style player movement simulation.
 *
 * Can be called by both server and client. All state lives on this object —
 * the caller is responsible for copying state in before `move()` and reading
 * it back after.
 */
export class PmovePlayer { // pmove_t (player state only)
  /** @type {boolean} Enable verbose movement debugging */
  static DEBUG = false;

  /**
   * @param {Pmove} pmove pmove instance (world + physents)
   */
  constructor(pmove) {
    // --- Public state (read/write by caller) ---

    /** @type {number} computed from cmd.msec */
    this.frametime = 0;
    /** @type {number} 0-3 water depth */
    this.waterlevel = 0;
    /** @type {number} content type of water */
    this.watertype = 0;

    /** @type {?number} ground edict number; null if airborne */
    this.onground = null;

    /** @type {Vector} player position (full float precision) */
    this.origin = new Vector();
    /** @type {Vector} player velocity (full float precision) */
    this.velocity = new Vector();
    /** @type {Vector} resolved view angles */
    this.angles = new Vector();

    /** @type {number} movement type (PM_TYPE enum) */
    this.pmType = PM_TYPE.NORMAL;
    /** @type {number} PM flag bitmask (PMF enum) */
    this.pmFlags = 0;
    /** @type {number} timing counter for special states (in msec/8 units) */
    this.pmTime = 0;

    /** @type {number} view height offset from origin */
    this.viewheight = 22;

    /** @type {number} remembered old buttons for edge detection */
    this.oldbuttons = 0;
    /** @type {number} deprecated compat — waterjump time remaining */
    this.waterjumptime = 0.0;
    /** @type {boolean} backwards compat flag */
    this.spectator = false;
    /** @type {boolean} backwards compat flag */
    this.dead = false;

    /** @type {Protocol.UserCmd} input command */
    this.cmd = new Protocol.UserCmd();

    /** @type {number[]} list of touched edict numbers */
    this.touchindices = [];

    // --- Private ---

    /** @type {boolean} whether we are on a ladder this frame */
    this._ladder = false;

    /** @type {DirectionalVectors} cached angle vectors @private */
    this._angleVectors = null;

    /** @type {WeakRef<Pmove>} @private */
    this._pmove_wf = new WeakRef(pmove);
  }

  /** @returns {Pmove} parent Pmove instance @private */
  get _pmove() {
    return this._pmove_wf.deref();
  }

  // =========================================================================
  // Public entry point
  // =========================================================================

  /**
   * Execute one frame of player movement.
   * Caller must set origin, velocity, angles, cmd, pmFlags, pmTime, pmType etc.
   * before calling, and read them back after.
   */
  move() { // Q2: Pmove()
    console.assert(this.cmd instanceof Protocol.UserCmd, 'valid cmd');

    // derive frametime
    this.frametime = this.cmd.msec / 1000.0;
    this.touchindices = [];

    const _dbg = PmovePlayer.DEBUG;
    const _dbgOriginBefore = _dbg ? this.origin.copy() : null;

    // resolve view angles
    this._clampAngles();

    // handle backwards-compat flags
    if (this.spectator) {
      this.pmType = PM_TYPE.SPECTATOR;
    }
    if (this.dead) {
      this.pmType = PM_TYPE.DEAD;
    }

    // spectator
    if (this.pmType === PM_TYPE.SPECTATOR) {
      this._flyMove();
      this._snapPosition();
      return;
    }

    // dead players have no input
    if (this.pmType >= PM_TYPE.DEAD) {
      this.cmd.forwardmove = 0;
      this.cmd.sidemove = 0;
      this.cmd.upmove = 0;
    }

    // frozen — no movement at all
    if (this.pmType === PM_TYPE.FREEZE) {
      return;
    }

    // set mins/maxs/viewheight (duck check)
    this._checkDuck();

    // nudge into valid position
    this._nudgePosition();

    // determine ground entity, water type, and water level
    this._categorizePosition();

    // dead movement (extra friction, nothing else)
    if (this.pmType === PM_TYPE.DEAD) {
      this._deadMove();
    }

    // check for ladders and water jumps
    this._checkSpecialMovement();

    // drop timing counter
    if (this.pmTime) {
      let msec = this.cmd.msec >> 3;
      if (!msec) {
        msec = 1;
      }
      if (msec >= this.pmTime) {
        this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
        this.pmTime = 0;
      } else {
        this.pmTime -= msec;
      }
    }

    // movement dispatch
    if (this.pmFlags & PMF.TIME_TELEPORT) {
      // teleport pause — no movement
    } else if (this.pmFlags & PMF.TIME_WATERJUMP) {
      // waterjump: no control, but gravity applies
      this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
      if (this.velocity[2] < 0) {
        this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
        this.pmTime = 0;
      }
      this._stepSlideMove();
    } else {
      this._checkJump();
      this._friction();

      if (this.waterlevel >= 2) {
        this._waterMove();
      } else {
        // scale pitch for ground movement (Q2 divides pitch by 3)
        const pitchedAngles = this.angles.copy();
        let pitch = pitchedAngles[0];
        if (pitch > 180) {
          pitch -= 360;
        }
        pitchedAngles[0] = pitch / 3.0;
        this._angleVectors = pitchedAngles.angleVectors();

        this._airMove();
      }
    }

    // final ground + water classification
    this._categorizePosition();

    const _dbgBeforeSnap = _dbg ? this.origin.copy() : null;

    // quantize position for network
    this._snapPosition();

    if (_dbg) {
      const moved = !this.origin.equals(_dbgOriginBefore);
      const snapMoved = !this.origin.equals(_dbgBeforeSnap);
      if (moved) {
        console.log(`[Pmove] frame: origin ${_dbgOriginBefore} -> ${_dbgBeforeSnap} -> snap ${this.origin} vel=${this.velocity} onground=${this.onground} flags=${this.pmFlags}${snapMoved ? ' (SNAP MOVED)' : ''}`);
      }
    }
  }

  // =========================================================================
  // Angle resolution
  // =========================================================================

  /** Resolve view angles from command input. */
  _clampAngles() { // Q2: PM_ClampAngles
    // take angles directly from command
    this.angles.set(this.cmd.angles);

    // clamp pitch
    if (this.angles[0] > 89 && this.angles[0] < 180) {
      this.angles[0] = 89;
    } else if (this.angles[0] < 271 && this.angles[0] >= 180) {
      this.angles[0] = 271;
    }

    this._angleVectors = this.angles.angleVectors();
  }

  // =========================================================================
  // Duck handling
  // =========================================================================

  /** Sets viewheight based on duck state. */
  _checkDuck() { // Q2: PM_CheckDuck
    if (this.pmType === PM_TYPE.DEAD) {
      this.pmFlags |= PMF.DUCKED;
    } else if (this.cmd.upmove < 0 && (this.pmFlags & PMF.ON_GROUND)) {
      // duck requested while on ground
      this.pmFlags |= PMF.DUCKED;
    } else if (this.pmFlags & PMF.DUCKED) {
      // try to stand up
      if (this._pmove.isValidPlayerPosition(this.origin)) {
        this.pmFlags &= ~PMF.DUCKED;
      }
    }

    if (this.pmFlags & PMF.DUCKED) {
      this.viewheight = -2;
    } else {
      this.viewheight = 22;
    }
  }

  // =========================================================================
  // Position categorization
  // =========================================================================

  /** Determine ground entity, water type and water level. */
  _categorizePosition() { // Q2: PM_CatagorizePosition
    // --- Ground check ---
    const point = this.origin.copy();
    point[2] -= 0.25; // Q2 uses 0.25 below feet

    if (this.velocity[2] > 180) {
      // moving up fast enough — not on ground
      this.pmFlags &= ~PMF.ON_GROUND;
      this.onground = null;
    } else {
      const trace = this._pmove.clipPlayerMove(this.origin, point);

      if (!trace.ent && trace.ent !== 0) {
        // didn't hit anything
        this.onground = null;
        this.pmFlags &= ~PMF.ON_GROUND;
      } else if (trace.plane.normal[2] < MIN_STEP_NORMAL && !trace.startsolid) {
        // too steep
        this.onground = null;
        this.pmFlags &= ~PMF.ON_GROUND;
      } else {
        this.onground = trace.ent;

        // hitting solid ground ends a waterjump
        if (this.pmFlags & PMF.TIME_WATERJUMP) {
          this.pmFlags &= ~(PMF.TIME_WATERJUMP | PMF.TIME_LAND | PMF.TIME_TELEPORT);
          this.pmTime = 0;
        }

        if (!(this.pmFlags & PMF.ON_GROUND)) {
          // just hit the ground — apply landing time
          this.pmFlags |= PMF.ON_GROUND;

          if (this.velocity[2] < -200) {
            this.pmFlags |= PMF.TIME_LAND;
            if (this.velocity[2] < -400) {
              this.pmTime = 25;
            } else {
              this.pmTime = 18;
            }
          }
        }
      }

      // record touch
      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }
    }

    // --- Water level check ---
    this.waterlevel = 0;
    this.watertype = content.CONTENT_EMPTY;

    point[0] = this.origin[0];
    point[1] = this.origin[1];
    point[2] = this.origin[2] + Pmove.PLAYER_MINS[2] + 1.0;

    let contents = this._pmove.pointContents(point);

    if (contents <= content.CONTENT_WATER) {
      this.watertype = contents;
      this.waterlevel = 1;

      // half-way point
      point[2] = this.origin[2] + (Pmove.PLAYER_MINS[2] + Pmove.PLAYER_MAXS[2]) / 2.0;
      contents = this._pmove.pointContents(point);

      if (contents <= content.CONTENT_WATER) {
        this.waterlevel = 2;

        // eye level
        point[2] = this.origin[2] + this.viewheight;
        contents = this._pmove.pointContents(point);

        if (contents <= content.CONTENT_WATER) {
          this.waterlevel = 3;
        }
      }
    }
  }

  // =========================================================================
  // Special movement checks (ladders, water jump)
  // =========================================================================

  /** Check for ladder / water jump opportunities. */
  _checkSpecialMovement() { // Q2: PM_CheckSpecialMovement
    if (this.pmTime) {
      return;
    }

    this._ladder = false;

    // check for ladder
    const flatforward = new Vector(this._angleVectors.forward[0], this._angleVectors.forward[1], 0);
    flatforward.normalize();

    const spot = this.origin.copy().add(flatforward);
    let trace = this._pmove.clipPlayerMove(this.origin, spot);

    if (trace.fraction < 1) {
      // Q2 checks trace.contents & CONTENTS_LADDER — we use content type
      const ladderPoint = trace.endpos.copy().add(flatforward.copy().multiply(0.5));
      const ladderContents = this._pmove.pointContents(ladderPoint);
      // In Q1 BSP, there is no CONTENTS_LADDER. Ladder detection should
      // be implemented via trigger_ladder entities or texture flags.
      // For now this is a placeholder — ladder support requires map support.
      void ladderContents;
    }

    // check for water jump
    if (this.waterlevel !== 2) {
      return;
    }

    const wjspot = this.origin.copy().add(flatforward.copy().multiply(30));
    wjspot[2] += 4;

    let cont = this._pmove.pointContents(wjspot);
    if (cont !== content.CONTENT_SOLID) {
      return;
    }

    wjspot[2] += 16;
    cont = this._pmove.pointContents(wjspot);
    if (cont !== content.CONTENT_EMPTY) {
      return;
    }

    // jump out of water
    this.velocity.set(flatforward).multiply(50);
    this.velocity[2] = 350;

    this.pmFlags |= PMF.TIME_WATERJUMP;
    this.pmTime = 255;
  }

  // =========================================================================
  // Jump
  // =========================================================================

  /** Check and execute jump. */
  _checkJump() { // Q2: PM_CheckJump
    if (this.pmFlags & PMF.TIME_LAND) {
      // landing cooldown not expired
      return;
    }

    if (this.cmd.upmove < 10) {
      // not holding jump
      this.pmFlags &= ~PMF.JUMP_HELD;
      return;
    }

    // must wait for jump button release
    if (this.pmFlags & PMF.JUMP_HELD) {
      return;
    }

    if (this.pmType === PM_TYPE.DEAD) {
      return;
    }

    // swimming, not jumping
    if (this.waterlevel >= 2) {
      this.onground = null;

      if (this.velocity[2] <= -300) {
        return;
      }

      switch (this.watertype) {
        case content.CONTENT_WATER:
          this.velocity[2] = 100;
          break;
        case content.CONTENT_SLIME:
          this.velocity[2] = 80;
          break;
        default:
          this.velocity[2] = 50;
      }
      return;
    }

    // not on ground — no effect
    if (this.onground === null) {
      return;
    }

    this.pmFlags |= PMF.JUMP_HELD;

    this.onground = null;
    this.pmFlags &= ~PMF.ON_GROUND;
    this.velocity[2] += 270;
    if (this.velocity[2] < 270) {
      this.velocity[2] = 270;
    }
  }

  // =========================================================================
  // Dead movement
  // =========================================================================

  /** Extra friction when dead, no player input. */
  _deadMove() { // Q2: PM_DeadMove
    if (this.onground === null) {
      return;
    }

    let forward = this.velocity.len();
    forward -= 20;

    if (forward <= 0) {
      this.velocity.clear();
    } else {
      this.velocity.normalize();
      this.velocity.multiply(forward);
    }
  }

  // =========================================================================
  // Friction
  // =========================================================================

  /** Apply ground and water friction. */
  _friction() { // Q2: PM_Friction
    const vel = this.velocity;
    const speed = Math.sqrt(vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]);

    if (speed < 1) {
      vel[0] = 0;
      vel[1] = 0;
      return;
    }

    let drop = 0;

    // ground friction
    if ((this.onground !== null && !this._ladder) || this._ladder) {
      const friction = this._pmove.movevars.friction;
      const control = speed < this._pmove.movevars.stopspeed ? this._pmove.movevars.stopspeed : speed;
      drop += control * friction * this.frametime;
    }

    // water friction
    if (this.waterlevel && !this._ladder) {
      drop += speed * this._pmove.movevars.waterfriction * this.waterlevel * this.frametime;
    }

    // scale the velocity
    let newspeed = speed - drop;
    if (newspeed < 0) {
      newspeed = 0;
    }
    newspeed /= speed;

    vel[0] *= newspeed;
    vel[1] *= newspeed;
    vel[2] *= newspeed;
  }

  // =========================================================================
  // Velocity clipping
  // =========================================================================

  /**
   * Slide off of the impacting surface.
   * @param {Vector} veloIn input velocity
   * @param {Vector} normal surface normal
   * @param {Vector} veloOut output velocity (may alias veloIn)
   * @param {number} overbounce overbounce factor (typically 1.01)
   */
  _clipVelocity(veloIn, normal, veloOut, overbounce) { // Q2: PM_ClipVelocity
    const backoff = veloIn.dot(normal) * overbounce;

    for (let i = 0; i < 3; i++) {
      const change = normal[i] * backoff;
      veloOut[i] = veloIn[i] - change;
      if (veloOut[i] > -STOP_EPSILON && veloOut[i] < STOP_EPSILON) {
        veloOut[i] = 0;
      }
    }
  }

  // =========================================================================
  // Acceleration
  // =========================================================================

  /**
   * Ground/water acceleration.
   * @param {Vector} wishdir desired direction (unit vector)
   * @param {number} wishspeed desired speed
   * @param {number} accel acceleration factor
   */
  _accelerate(wishdir, wishspeed, accel) { // Q2: PM_Accelerate
    const currentspeed = this.velocity.dot(wishdir);
    let addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    let accelspeed = accel * this.frametime * wishspeed;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];
  }

  /**
   * Air acceleration — preserves the Q1/Q2 air-strafe mechanic.
   * wishspeed is capped at 30 for the addspeed check, but the uncapped
   * value is used for accelspeed. This allows bunny-hopping.
   * @param {Vector} wishdir desired direction (unit vector)
   * @param {number} wishspeed desired speed (uncapped)
   * @param {number} accel acceleration factor
   */
  _airAccelerate(wishdir, wishspeed, accel) { // Q2: PM_AirAccelerate
    let wishspd = wishspeed;
    if (wishspd > 30) {
      wishspd = 30;
    }

    const currentspeed = this.velocity.dot(wishdir);
    let addspeed = wishspd - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    // note: uses original wishspeed, not the capped wishspd
    let accelspeed = accel * wishspeed * this.frametime;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];
  }

  // =========================================================================
  // Core slide move (Q2: PM_StepSlideMove_ — inner loop)
  // =========================================================================

  /**
   * The basic solid body movement clip that slides along multiple planes.
   * This is the inner loop — it does NOT attempt step-up.
   */
  _slideMove() { // Q1: SV_FlyMove / Q2: PM_StepSlideMove_
    const _dbg = PmovePlayer.DEBUG;
    const _dbgStartOrigin = _dbg ? this.origin.copy() : null;
    const _dbgStartVelocity = _dbg ? this.velocity.copy() : null;
    const numbumps = 4;
    const primalVelocity = this.velocity.copy();
    // Q1-style: snapshot velocity at the last point of actual movement.
    // The clip loop always clips from this stable reference, not from an
    // already-clipped result. This avoids precision drift when re-clipping
    // against the same BSP hull plane with the 1.01 overbounce factor.
    let originalVelocity = this.velocity.copy();
    let numplanes = 0;
    /** @type {Vector[]} */
    const planes = [];
    let timeLeft = this.frametime;

    for (let bumpcount = 0; bumpcount < numbumps; bumpcount++) {
      const end = new Vector(
        this.origin[0] + timeLeft * this.velocity[0],
        this.origin[1] + timeLeft * this.velocity[1],
        this.origin[2] + timeLeft * this.velocity[2],
      );

      const trace = this._pmove.clipPlayerMove(this.origin, end);

      if (trace.allsolid) {
        // trapped in solid
        if (_dbg) {
          console.warn(`[_slideMove] ALLSOLID at bump ${bumpcount}, origin=${this.origin}, end=${end}`);
        }
        this.velocity[2] = 0;
        return;
      }

      if (trace.fraction > 0) {
        // actually moved some distance
        this.origin.set(trace.endpos);
        originalVelocity = this.velocity.copy();
        numplanes = 0;
      }

      if (trace.fraction === 1) {
        break; // moved the entire distance
      }

      if (_dbg) {
        console.log(`[_slideMove] bump ${bumpcount}: frac=${trace.fraction.toFixed(4)} normal=(${trace.plane.normal[0].toFixed(3)},${trace.plane.normal[1].toFixed(3)},${trace.plane.normal[2].toFixed(3)}) ent=${trace.ent} origin=${this.origin} vel=${this.velocity}`);
      }

      // save entity for contact
      if (trace.ent !== null) {
        this.touchindices.push(trace.ent);
      }

      timeLeft -= timeLeft * trace.fraction;

      // slide along this plane
      if (numplanes >= MAX_CLIP_PLANES) {
        this.velocity.clear();
        break;
      }

      // Q1 hull traces can return near-identical normals for the same
      // surface when the player origin is very close to a BSP plane.
      // Without this guard, two near-duplicate normals cause the crease
      // cross-product to be ~zero, zeroing velocity and sticking the
      // player. This check is standard in Q1 source ports (QS, FTEQW).
      const traceNormal = trace.plane.normal;
      let nearDuplicate = false;
      for (let k = 0; k < numplanes; k++) {
        if (traceNormal.dot(planes[k]) > 0.99) {
          // Nudge velocity away from the surface to help the next trace
          this.velocity[0] += traceNormal[0];
          this.velocity[1] += traceNormal[1];
          this.velocity[2] += traceNormal[2];
          nearDuplicate = true;
          break;
        }
      }
      if (nearDuplicate) {
        continue;
      }

      planes[numplanes] = traceNormal.copy();
      numplanes++;

      // Clip originalVelocity (Q1-style) so each plane attempt starts
      // from the same stable base. Q2 clips the current velocity in-place,
      // but Q1's BSP hull traces need the original reference to avoid
      // precision drift from re-clipping with the 1.01 overbounce.
      let i, j;
      const clipVelocity = new Vector();
      for (i = 0; i < numplanes; i++) {
        this._clipVelocity(originalVelocity, planes[i], clipVelocity, 1.01);

        for (j = 0; j < numplanes; j++) {
          if (j !== i) {
            if (clipVelocity.dot(planes[j]) < 0) {
              break; // not ok
            }
          }
        }
        if (j === numplanes) {
          break; // found a velocity that works with all planes
        }
      }

      if (i !== numplanes) {
        // go along this plane
        this.velocity.set(clipVelocity);
        if (_dbg) {
          console.log(`[_slideMove]   clipped vel=${this.velocity}`);
        }
      } else {
        // go along the crease
        if (numplanes !== 2) {
          if (_dbg) {
            console.log(`[_slideMove]   CLEAR vel: numplanes=${numplanes}`);
          }
          this.velocity.clear();
          break;
        }

        const dir = planes[0].cross(planes[1]);
        const d = dir.dot(this.velocity);
        this.velocity.set(dir.copy().multiply(d));
        if (_dbg) {
          console.log(`[_slideMove]   crease vel=${this.velocity}`);
        }
      }

      // if velocity is against the original velocity, stop dead
      // to avoid tiny oscillations in sloping corners
      if (primalVelocity.dot(this.velocity) <= 0) {
        if (_dbg) {
          console.log('[_slideMove]   DEAD STOP: vel against primal');
        }
        this.velocity.clear();
        break;
      }
    }

    if (_dbg) {
      console.log(`[_slideMove] done: origin ${_dbgStartOrigin} -> ${this.origin}, vel ${_dbgStartVelocity} -> ${this.velocity}`);
    }

    if (this.pmTime) {
      this.velocity.set(primalVelocity);
    }
  }

  // =========================================================================
  // Step + slide move (Q2: PM_StepSlideMove — outer wrapper)
  // =========================================================================

  /**
   * Each intersection will try to step over the obstruction instead of
   * sliding along it. This calls _slideMove twice: once without step-up,
   * once with step-up, and picks whichever went farther horizontally.
   */
  _stepSlideMove() { // Q2: PM_StepSlideMove
    const startOrigin = this.origin.copy();
    const startVelocity = this.velocity.copy();

    // try sliding at current height first
    this._slideMove();

    const downOrigin = this.origin.copy();
    const downVelocity = this.velocity.copy();

    // try stepping up
    const up = startOrigin.copy();
    up[2] += STEPSIZE;

    const upTrace = this._pmove.clipPlayerMove(up, up);
    if (upTrace.allsolid) {
      return; // can't step up
    }

    // try sliding above
    this.origin.set(up);
    this.velocity.set(startVelocity);

    this._slideMove();

    // push down the final amount
    const down = this.origin.copy();
    down[2] -= STEPSIZE;

    const downStepTrace = this._pmove.clipPlayerMove(this.origin, down);
    if (!downStepTrace.allsolid) {
      this.origin.set(downStepTrace.endpos);
    }

    const upOrigin = this.origin.copy();

    // decide which one went farther (2D distance)
    const downDist =
      (downOrigin[0] - startOrigin[0]) * (downOrigin[0] - startOrigin[0]) +
      (downOrigin[1] - startOrigin[1]) * (downOrigin[1] - startOrigin[1]);
    const upDist =
      (upOrigin[0] - startOrigin[0]) * (upOrigin[0] - startOrigin[0]) +
      (upOrigin[1] - startOrigin[1]) * (upOrigin[1] - startOrigin[1]);

    if (downDist > upDist || downStepTrace.plane.normal[2] < MIN_STEP_NORMAL) {
      this.origin.set(downOrigin);
      this.velocity.set(downVelocity);
      return;
    }

    // special case: if we were walking along a plane, copy the Z velocity
    this.velocity[2] = downVelocity[2];
  }

  // =========================================================================
  // Movement modes
  // =========================================================================

  /** Air and ground movement dispatch. */
  _airMove() { // Q2: PM_AirMove
    const fmove = this.cmd.forwardmove;
    const smove = this.cmd.sidemove;

    // Project forward/right onto the horizontal plane and renormalize.
    // This prevents looking up/down from reducing horizontal move speed.
    const forward = this._angleVectors.forward.copy();
    const right = this._angleVectors.right.copy();
    forward[2] = 0;
    right[2] = 0;
    forward.normalize();
    right.normalize();

    const wishvel = new Vector(
      forward[0] * fmove + right[0] * smove,
      forward[1] * fmove + right[1] * smove,
      0,
    );

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    // clamp to server defined max speed
    const maxspeed = (this.pmFlags & PMF.DUCKED) ? this._pmove.movevars.duckspeed : this._pmove.movevars.maxspeed;

    if (wishspeed > maxspeed) {
      wishvel.multiply(maxspeed / wishspeed);
      wishspeed = maxspeed;
    }

    if (this._ladder) {
      // on ladder
      this._accelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);

      if (!wishvel[2]) {
        if (this.velocity[2] > 0) {
          this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
          if (this.velocity[2] < 0) {
            this.velocity[2] = 0;
          }
        } else {
          this.velocity[2] += this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
          if (this.velocity[2] > 0) {
            this.velocity[2] = 0;
          }
        }
      }

      this._stepSlideMove();
    } else if (this.onground !== null) {
      // walking on ground
      this.velocity[2] = 0;
      this._accelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);

      // apply gravity — handle negative gravity fields
      if (this._pmove.movevars.gravity > 0) {
        this.velocity[2] = 0;
      } else {
        this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;
      }

      if (!this.velocity[0] && !this.velocity[1]) {
        return;
      }

      this._stepSlideMove();
    } else {
      // in air — little effect on velocity
      if (this._pmove.movevars.airaccelerate) {
        this._airAccelerate(wishdir, wishspeed, this._pmove.movevars.accelerate);
      } else {
        this._accelerate(wishdir, wishspeed, 1);
      }

      // add gravity
      this.velocity[2] -= this._pmove.movevars.gravity * this._pmove.movevars.entgravity * this.frametime;

      this._stepSlideMove();
    }
  }

  /** Water movement. */
  _waterMove() { // Q2: PM_WaterMove
    const forward = this._angleVectors.forward;
    const right = this._angleVectors.right;

    const wishvel = new Vector(
      forward[0] * this.cmd.forwardmove + right[0] * this.cmd.sidemove,
      forward[1] * this.cmd.forwardmove + right[1] * this.cmd.sidemove,
      forward[2] * this.cmd.forwardmove + right[2] * this.cmd.sidemove,
    );

    if (!this.cmd.forwardmove && !this.cmd.sidemove && !this.cmd.upmove) {
      wishvel[2] -= 60; // drift towards bottom
    } else {
      wishvel[2] += this.cmd.upmove;
    }

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    if (wishspeed > this._pmove.movevars.maxspeed) {
      wishvel.multiply(this._pmove.movevars.maxspeed / wishspeed);
      wishspeed = this._pmove.movevars.maxspeed;
    }
    wishspeed *= 0.5;

    this._accelerate(wishdir, wishspeed, this._pmove.movevars.wateraccelerate);

    this._stepSlideMove();
  }

  /**
   * Fly/spectator movement — noclip with friction.
   * Can be called by spectators or noclip modes.
   */
  _flyMove() { // Q2: PM_FlyMove
    this.viewheight = 22;

    // friction
    const speed = this.velocity.len();
    if (speed < 1) {
      this.velocity.clear();
    } else {
      const friction = this._pmove.movevars.friction * 1.5;
      const control = speed < this._pmove.movevars.stopspeed ? this._pmove.movevars.stopspeed : speed;
      const drop = control * friction * this.frametime;

      let newspeed = speed - drop;
      if (newspeed < 0) {
        newspeed = 0;
      }
      newspeed /= speed;

      this.velocity[0] *= newspeed;
      this.velocity[1] *= newspeed;
      this.velocity[2] *= newspeed;
    }

    // accelerate
    const fmove = this.cmd.forwardmove;
    const smove = this.cmd.sidemove;

    const fwd = this._angleVectors.forward.copy();
    const rgt = this._angleVectors.right.copy();
    fwd.normalize();
    rgt.normalize();

    const wishvel = new Vector(
      fwd[0] * fmove + rgt[0] * smove,
      fwd[1] * fmove + rgt[1] * smove,
      fwd[2] * fmove + rgt[2] * smove,
    );
    wishvel[2] += this.cmd.upmove;

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    if (wishspeed > this._pmove.movevars.maxspeed) {
      wishvel.multiply(this._pmove.movevars.maxspeed / wishspeed);
      wishspeed = this._pmove.movevars.maxspeed;
    }

    const currentspeed = this.velocity.dot(wishdir);
    const addspeed = wishspeed - currentspeed;
    if (addspeed <= 0) {
      return;
    }

    let accelspeed = this._pmove.movevars.accelerate * this.frametime * wishspeed;
    if (accelspeed > addspeed) {
      accelspeed = addspeed;
    }

    this.velocity[0] += accelspeed * wishdir[0];
    this.velocity[1] += accelspeed * wishdir[1];
    this.velocity[2] += accelspeed * wishdir[2];

    // move
    this.origin[0] += this.frametime * this.velocity[0];
    this.origin[1] += this.frametime * this.velocity[1];
    this.origin[2] += this.frametime * this.velocity[2];
  }

  // =========================================================================
  // Position snapping / nudging
  // =========================================================================

  /**
   * Quantize position to 1/8 unit precision for network transmission
   * and nudge into a valid position.
   */
  _snapPosition() { // Q2: PM_SnapPosition
    // snap velocity to 1/8 unit precision
    for (let i = 0; i < 3; i++) {
      this.velocity[i] = Math.round(this.velocity[i] * 8.0) / 8.0;
    }

    // Compute snap direction signs BEFORE rounding origin, so we know
    // which way to jitter when the snapped position lands in solid.
    const sign = [0, 0, 0];
    const base = new Vector();
    for (let i = 0; i < 3; i++) {
      const snapped = Math.round(this.origin[i] * 8.0);
      base[i] = snapped * 0.125;
      if (base[i] === this.origin[i]) {
        sign[i] = 0;
      } else if (this.origin[i] > base[i]) {
        sign[i] = 1;
      } else {
        sign[i] = -1;
      }
    }

    // try all jitter combinations (closest first)
    const jitterbits = [0, 4, 1, 2, 3, 5, 6, 7];
    for (let j = 0; j < 8; j++) {
      const bits = jitterbits[j];
      for (let i = 0; i < 3; i++) {
        this.origin[i] = base[i] + ((bits & (1 << i)) ? sign[i] * 0.125 : 0);
      }
      if (this._pmove.isValidPlayerPosition(this.origin)) {
        return;
      }
    }

    // couldn't find a valid position — stay at snapped base
    if (PmovePlayer.DEBUG) {
      console.warn(`[_snapPosition] FAILED to find valid pos, stuck at base=${base}`);
    }
    this.origin.set(base);
  }

  /**
   * If pmove.origin is in a solid position,
   * try nudging slightly on all axes to
   * allow for the cut precision of the net coordinates.
   */
  _nudgePosition() { // Q2: PM_InitialSnapPosition / QW: NudgePosition
    const offsets = [0, -1, 1];
    const base = this.origin.copy();

    for (let z = 0; z < 3; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          this.origin[0] = base[0] + offsets[x] * 0.125;
          this.origin[1] = base[1] + offsets[y] * 0.125;
          this.origin[2] = base[2] + offsets[z] * 0.125;

          if (this._pmove.isValidPlayerPosition(this.origin)) {
            return;
          }
        }
      }
    }

    if (PmovePlayer.DEBUG) {
      console.warn(`[_nudgePosition] FAILED to find valid pos from base=${base}`);
    }
    this.origin.set(base);
  }
};

// ---------------------------------------------------------------------------
// Pmove — the world container (physents, collision infrastructure)
// ---------------------------------------------------------------------------

/**
 * PlayerMove class.
 * Holds the world (physents) and provides collision primitives.
 * Instantiate one per context (one for client prediction, one for server).
 */
export class Pmove { // pmove_t
  /** @deprecated import DIST_EPSILON instead */
  static DIST_EPSILON = DIST_EPSILON;
  /** @deprecated import STOP_EPSILON instead */
  static STOP_EPSILON = STOP_EPSILON;
  /** @deprecated import STEPSIZE instead */
  static STEPSIZE = STEPSIZE;

  static MAX_CLIP_PLANES = MAX_CLIP_PLANES;

  static PLAYER_MINS = new Vector(-16.0, -16.0, -24.0);
  static PLAYER_MAXS = new Vector(16.0, 16.0, 32.0);

  static MAX_PHYSENTS = 32;

  /** @type {PhysEnt[]} 0 - world */
  physents = [];
  boxHull = new BoxHull();
  movevars = new MoveVars();

  /** @type {Map<string, Hull[]>} cache for pm hulls from mod hulls */
  #modelHullsCache = new Map();

  pointContents(point) {
    console.assert(this.physents[0] instanceof PhysEnt, 'world physent');

    const hull = this.physents[0].hulls[0]; // world
    console.assert(hull instanceof Hull, 'world hull');

    return hull.pointContents(point);
  }

  /**
   * @param {Vector} position player's origin
   * @returns {boolean} Returns false if the given player position is not valid (in solid)
   */
  isValidPlayerPosition(position) {
    for (const pe of this.physents) {
      const hull = pe.getClippingHull();
      console.assert(hull instanceof Hull, 'physent hull');

      const test = position.copy().subtract(pe.origin);

      if (hull.pointContents(test) === content.CONTENT_SOLID) {
        return false;
      }
    }

    return true;
  }

  /**
   * Attempts to move the player from start to end.
   * @param {Vector} start starting point
   * @param {Vector} end end point (e.g. start + velocity * frametime)
   * @returns {Trace} trace object
   */
  clipPlayerMove(start, end) {
    const totalTrace = new Trace();
    totalTrace.allsolid = false; // QW compat: total trace starts non-solid; individual checks mark it solid

    totalTrace.endpos.set(end);

    for (let i = 0; i < this.physents.length; i++) {
      const pe = this.physents[i];
      const hull = pe.getClippingHull();
      console.assert(hull instanceof Hull, 'physent hull');

      const offset = pe.origin.copy();

      const start_l = start.copy().subtract(offset);
      const end_l = end.copy().subtract(offset);

      // fill in a default trace
      const trace = new Trace();
      trace.endpos.set(end);

      // trace a line through the apropriate clipping hull
      hull.check(0.0, 1.0, start_l, end_l, trace);

      if (trace.allsolid) {
        trace.startsolid = true;
      }

      if (trace.startsolid) {
        trace.fraction = 0.0;
        if (PmovePlayer.DEBUG) {
          console.warn(`[clipPlayerMove] startsolid at physent ${i} (edictId=${pe.edictId}), start_l=${start_l}, hull=${pe.hulls.length > 0 ? 'BSP' : 'box'}`);
        }
      }

      // did we clip the move?
      if (trace.fraction < totalTrace.fraction) {
        // fix trace up by the offset
        trace.endpos.add(offset);
        totalTrace.set(trace);
        totalTrace.ent = i;
      }
    }

    return totalTrace;
  }

  /**
   * Sets worldmodel.
   * This will automatically reset all physents.
   * @param {*} model worldmodel
   * @returns {Pmove} this
   */
  setWorldmodel(model) {
    console.assert(model, 'model');
    console.assert(model.hulls instanceof Array, 'model hulls');

    this.physents.length = 0;

    const pe = new PhysEnt(this);

    for (const modelHull of model.hulls) {
      pe.hulls.push(Hull.fromModelHull(modelHull));
    }

    this.physents.push(pe);

    return this;
  }

  /**
   * Clears all entities.
   * @returns {Pmove} this
   */
  clearEntities() {
    this.physents.length = 1;
    return this;
  }

  /**
   * Adds an entity (client or server) to physents.
   * @param {*} entity actual entity
   * @param {*} model model must be provided when entity is SOLID_BSP
   * @returns {Pmove} this
   */
  addEntity(entity, model = null) {
    const pe = new PhysEnt(this);

    console.assert(entity.origin instanceof Vector, 'valid entity origin', entity.origin);

    pe.origin.set(entity.origin);

    if (model !== null) {
      // use cached hulls, generating pm hulls from mod hulls is quite expensive (~3ms per model)
      if (this.#modelHullsCache.has(model.name)) {
        pe.hulls = this.#modelHullsCache.get(model.name);
      } else {
        for (const modelHull of model.hulls) {
          pe.hulls.push(Hull.fromModelHull(modelHull));
        }
        this.#modelHullsCache.set(model.name, pe.hulls);
      }
    } else {
      console.assert(entity.mins instanceof Vector, 'valid entity mins', entity.mins);
      console.assert(entity.maxs instanceof Vector, 'valid entity maxs', entity.maxs);

      pe.mins.set(entity.mins);
      pe.maxs.set(entity.maxs);
    }

    if (entity.edictId !== undefined) {
      pe.edictId = entity.edictId;
    }

    this.physents.push(pe);

    return this;
  }

  /**
   * Returns a new player move engine.
   * @returns {PmovePlayer} player move engine
   */
  newPlayerMove() {
    return new PmovePlayer(this);
  }
};

// ---------------------------------------------------------------------------
// Test function
// ---------------------------------------------------------------------------

/**
 * Test function for serverside Pmove.
 * @returns {Pmove} movevars
 */
export function TestServerside() {
  const pm = new Pmove();

  pm.setWorldmodel(SV.server.worldmodel);

  console.assert(pm.physents[0] instanceof PhysEnt, 'world physent is present');
  console.assert(pm.physents[0].hulls.length === SV.server.worldmodel.hulls.length, 'all hulls copied');

  // we add entities and check if they have been added properly
  for (let i = 1; i < SV.server.num_edicts; i++) {
    const entity = SV.server.edicts[i].entity;

    pm.addEntity(entity, entity.solid === solid.SOLID_BSP ? SV.server.models[entity.modelindex] : null);

    console.assert(pm.physents[i].origin.equals(entity.origin), 'origin must match');
    console.assert(pm.physents[i].edictId === i, 'edictId must match');
  }

  // we added all entities (for testing purposes)
  console.assert(pm.physents.length === SV.server.num_edicts, 'all entities plus world are added');

  const origin = SV.server.edicts[1].entity.origin;
  console.assert(pm.isValidPlayerPosition(origin), 'current player position must be asserted as valid');

  // Test PlayerMove 64 units into the void
  const playerMoveTraceIntoSpace = pm.clipPlayerMove(origin, new Vector(origin[0], origin[1], 999999));
  console.assert(playerMoveTraceIntoSpace instanceof Trace, 'playerMoveTrace is a Trace');
  console.assert(playerMoveTraceIntoSpace.ent === 0, 'trace stopped at world');
  console.assert(playerMoveTraceIntoSpace.fraction < 1.0, 'fraction cannot be 1.0');

  // Test PlayerMove 64 units above the player
  const playerMoveTraceHigher = pm.clipPlayerMove(origin, new Vector(origin[0], origin[1], origin[2] + 64.0));
  console.assert(playerMoveTraceHigher instanceof Trace, 'playerMoveTrace is a Trace');
  console.assert(playerMoveTraceHigher.ent === null, 'trace stopped in air');
  console.assert(playerMoveTraceHigher.fraction === 1.0, 'fraction must be 1.0');

  return pm;
};
