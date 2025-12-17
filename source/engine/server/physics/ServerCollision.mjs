import Vector from '../../../shared/Vector.mjs';
import * as Defs from '../../../shared/Defs.mjs';
import { DIST_EPSILON } from '../../common/Pmove.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { Con, SV } = registry;

/** @typedef {import('../Client.mjs').ServerEdict} ServerEdict */

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  SV = registry.SV;
});

/**
 * @typedef {object} Trace
 * @property {number} fraction completed movement fraction
 * @property {boolean} allsolid true when trace remained in solid
 * @property {boolean} startsolid whether start position was solid
 * @property {Vector} endpos final position after the trace
 * @property {{normal: Vector, dist: number}} plane collision plane information
 * @property {ServerEdict} ent entity that was hit, if any
 * @property {boolean} [inopen] true if open space was encountered
 * @property {boolean} [inwater] true if water was encountered
 */

/**
 * Handles collision detection and tracing for entities in the world.
 * Manages hull-based collision tests and world traces.
 */
export class ServerCollision {
  constructor() {
  }

  /**
   * Determines the contents inside a hull by descending the clipnode tree.
   * @param {*} hull hull data to test against
   * @param {number} num starting clipnode index
   * @param {Vector} p point to classify
   * @returns {number} content type for the point
   */
  hullPointContents(hull, num, p) {
    while (num >= 0) {
      console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);
      const node = hull.clipnodes[num];
      const plane = hull.planes[node.planenum];

      let d;

      if (plane.type < 3) {
        d = p[plane.type] - plane.dist;
      } else {
        d = plane.normal.dot(p) - plane.dist;
      }

      if (d < 0) {
        num = node.children[1];
      } else {
        num = node.children[0];
      }
    }

    return num;
  }

  /**
   * Returns the contents at the specified world position.
   * @param {Vector} p position to sample
   * @returns {number} world content
   */
  pointContents(p) {
    const cont = this.hullPointContents(SV.server.worldmodel.hulls[0], 0, p);
    if ((cont <= Defs.content.CONTENT_CURRENT_0) && (cont >= Defs.content.CONTENT_CURRENT_DOWN)) {
      // all currents are considered water
      return Defs.content.CONTENT_WATER;
    }
    return cont;
  }

  /**
   * Recursively tests a swept hull against the world and aggregates the trace result.
   * @param {*} hull hull to trace against
   * @param {number} num clipnode index
   * @param {number} p1f fraction at the start point
   * @param {number} p2f fraction at the end point
   * @param {Vector} p1 start point
   * @param {Vector} p2 end point
   * @param {Trace} trace trace accumulator
   * @returns {boolean} true if traversal should continue downward
   */
  recursiveHullCheck(hull, num, p1f, p2f, p1, p2, trace) {
    // check for early exit - already hit something nearer
    if (trace.fraction <= p1f) {
      return false;
    }

    if (num < 0) {
      if (num !== Defs.content.CONTENT_SOLID) {
        trace.allsolid = false;
        if (num === Defs.content.CONTENT_EMPTY) {
          trace.inopen = true;
        } else {
          trace.inwater = true;
        }
      } else {
        trace.startsolid = true;
      }
      return true;
    }

    console.assert(num >= hull.firstclipnode && num <= hull.lastclipnode, 'valid node number', num);

    const node = hull.clipnodes[num];
    const plane = hull.planes[node.planenum];
    const t1 = (plane.type < 3 ? p1[plane.type]
      : plane.normal[0] * p1[0] + plane.normal[1] * p1[1] + plane.normal[2] * p1[2]) - plane.dist;
    const t2 = (plane.type < 3 ? p2[plane.type]
      : plane.normal[0] * p2[0] + plane.normal[1] * p2[1] + plane.normal[2] * p2[2]) - plane.dist;

    if (t1 >= 0.0 && t2 >= 0.0) {
      return this.recursiveHullCheck(hull, node.children[0], p1f, p2f, p1, p2, trace);
    }

    if (t1 < 0.0 && t2 < 0.0) {
      return this.recursiveHullCheck(hull, node.children[1], p1f, p2f, p1, p2, trace);
    }

    let frac = Math.max(0.0, Math.min(1.0, (t1 + (t1 < 0.0 ? DIST_EPSILON : -DIST_EPSILON)) / (t1 - t2)));
    let midf = p1f + (p2f - p1f) * frac;
    const mid = new Vector(
      p1[0] + frac * (p2[0] - p1[0]),
      p1[1] + frac * (p2[1] - p1[1]),
      p1[2] + frac * (p2[2] - p1[2]),
    );
    const side = t1 < 0.0 ? 1 : 0;

    if (!this.recursiveHullCheck(hull, node.children[side], p1f, midf, p1, mid, trace)) {
      return false;
    }

    if (this.hullPointContents(hull, node.children[side ^ 1], mid) !== Defs.content.CONTENT_SOLID) {
      return this.recursiveHullCheck(hull, node.children[side ^ 1], midf, p2f, mid, p2, trace);
    }

    if (trace.allsolid) {
      return false;
    }

    if (side === 0) {
      trace.plane.normal = plane.normal.copy();
      trace.plane.dist = plane.dist;
    } else {
      trace.plane.normal = plane.normal.copy().multiply(-1);
      trace.plane.dist = -plane.dist;
    }

    while (this.hullPointContents(hull, hull.firstclipnode, mid) === Defs.content.CONTENT_SOLID) {
      frac -= 0.1;
      if (frac < 0.0) {
        trace.fraction = midf;
        trace.endpos = mid.copy();
        Con.DPrint('backup past 0\n');
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

  /**
   * Traces a moving box against a target entity.
   * @param {ServerEdict} ent entity to collide with
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @returns {Trace} collision result
   */
  clipMoveToEntity(ent, start, mins, maxs, end) {
    const trace = {
      fraction: 1.0,
      allsolid: true,
      startsolid: false,
      endpos: end.copy(),
      plane: { normal: new Vector(), dist: 0.0 },
      ent: null,
    };

    const offset = new Vector();
    const hull = SV.area.hullForEntity(ent, mins, maxs, offset);
    const start_l = start.copy().subtract(offset);
    const end_l = end.copy().subtract(offset);
    this.recursiveHullCheck(hull, hull.firstclipnode, 0.0, 1.0, start_l, end_l, trace);

    // fix trace up by the offset
    if (trace.fraction !== 1.0) {
      trace.endpos.add(offset);
    }

    if ((trace.fraction < 1.0) || trace.startsolid === true) {
      trace.ent = ent;
    }

    return trace;
  }

  /**
   * Recursively checks the links in the area node BSP for collision.
   * @param {*} clip clip data
   */
  clipToLinks(clip) {
    for (const touch of SV.area.tree.queryAABB(clip.boxmins, clip.boxmaxs)) {
      if (touch === clip.passedict) {
        continue;
      }

      if (touch.entity.solid === Defs.solid.SOLID_NOT) {
        continue;
      }

      if (touch.entity.solid === Defs.solid.SOLID_TRIGGER) {
        continue;
      }

      if (clip.type === Defs.moveTypes.MOVE_NOMONSTERS && touch.entity.solid !== Defs.solid.SOLID_BSP) {
        continue;
      }

      if (clip.boxmins[0] > touch.entity.absmax[0] ||
          clip.boxmins[1] > touch.entity.absmax[1] ||
          clip.boxmins[2] > touch.entity.absmax[2] ||
          clip.boxmaxs[0] < touch.entity.absmin[0] ||
          clip.boxmaxs[1] < touch.entity.absmin[1] ||
          clip.boxmaxs[2] < touch.entity.absmin[2]) {
        continue;
      }

      if (clip.passedict) {
        if (clip.passedict.entity.size !== 0.0 && touch.entity.size === 0.0) {
          continue;
        }
      }

      if (clip.trace.allsolid === true) {
        return;
      }

      if (clip.passedict) {
        if (touch.entity.owner && touch.entity.owner.equals(clip.passedict)) {
          continue;
        }
        if (clip.passedict.entity.owner && clip.passedict.entity.owner.equals(touch)) {
          continue;
        }
      }

      const trace = (touch.entity.flags & Defs.flags.FL_MONSTER) !== 0
        ? this.clipMoveToEntity(touch, clip.start, clip.mins2, clip.maxs2, clip.end)
        : this.clipMoveToEntity(touch, clip.start, clip.mins, clip.maxs, clip.end);

      if (trace.allsolid || trace.startsolid || trace.fraction < clip.trace.fraction) {
        trace.ent = touch;
        clip.trace = trace;
        if (clip.trace.allsolid) {
          return;
        }
      }
    }
  }

  /**
   * Fully traces a moving box through the world.
   * @param {Vector} start start position
   * @param {Vector} mins minimum extents of the moving box
   * @param {Vector} maxs maximum extents of the moving box
   * @param {Vector} end end position
   * @param {Defs.moveTypes} type move type constant from Defs.moveTypes
   * @param {ServerEdict} passedict entity to skip
   * @returns {Trace} collision result
   */
  move(start, mins, maxs, end, type, passedict) {
    const clip = {
      trace: this.clipMoveToEntity(SV.server.edicts[0], start, mins, maxs, end),
      start,
      end,
      mins,
      mins2: type === Defs.moveTypes.MOVE_MISSILE ? new Vector(-15.0, -15.0, -15.0) : mins,
      maxs,
      maxs2: type === Defs.moveTypes.MOVE_MISSILE ? new Vector(15.0, 15.0, 15.0) : maxs,
      type,
      passedict,
      boxmins: new Vector(),
      boxmaxs: new Vector(),
    };

    for (let i = 0; i < 3; i++) {
      if (end[i] > start[i]) {
        clip.boxmins[i] = start[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = end[i] + clip.maxs2[i] + 1.0;
      } else {
        clip.boxmins[i] = end[i] + clip.mins2[i] - 1.0;
        clip.boxmaxs[i] = start[i] + clip.maxs2[i] + 1.0;
      }
    }

    this.clipToLinks(clip);
    return clip.trace;
  }

  /**
   * Tests whether an entity is currently stuck in solid geometry.
   * @param {ServerEdict} ent entity to test
   * @returns {boolean} true if the entity is stuck
   */
  testEntityPosition(ent) {
    const origin = ent.entity.origin.copy();
    return this.move(origin, ent.entity.mins, ent.entity.maxs, origin, 0, ent).startsolid;
  }
}
