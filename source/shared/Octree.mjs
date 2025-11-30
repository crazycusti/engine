import Vector from './Vector.mjs';

/** @typedef {{origin: Vector, absmin: Vector, absmax: Vector, octreeNode: OctreeNode|null}} OctreeItem */

/**
 * Octree node holding an spatial indexed item.
 * @template {OctreeItem} T
 */
export class OctreeNode {
  /**
   * @param {Vector} center center point, e.g (mins + maxs) / 2
   * @param {number} halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param {number} capacity maximum items per node before splitting
   * @param {number} minSize minimum halfSize to allow splitting
   */
  constructor(center, halfSize, capacity = 8, minSize = 4) {
    this.center = center; // Vector
    this.halfSize = halfSize; // number
    this.capacity = capacity;
    this.minSize = minSize;
    /** @type {T[]} */
    this.points = []; // stored items: {item}
    /** @type {?OctreeNode[]} */
    this.children = null;
  }

  /**
   * @param {Vector} point position
   * @returns {boolean} true if point is inside this node's box
   */
  #isInBox(point) {
    const dx = Math.abs(point[0] - this.center[0]);
    const dy = Math.abs(point[1] - this.center[1]);
    const dz = Math.abs(point[2] - this.center[2]);

    return dx <= this.halfSize && dy <= this.halfSize && dz <= this.halfSize;
  }

  /**
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @returns {boolean} true if box is fully inside this node's box
   */
  #isBoxInBox(mins, maxs) {
    const nodeMinX = this.center[0] - this.halfSize;
    const nodeMaxX = this.center[0] + this.halfSize;
    const nodeMinY = this.center[1] - this.halfSize;
    const nodeMaxY = this.center[1] + this.halfSize;
    const nodeMinZ = this.center[2] - this.halfSize;
    const nodeMaxZ = this.center[2] + this.halfSize;

    return mins[0] >= nodeMinX && maxs[0] <= nodeMaxX &&
      mins[1] >= nodeMinY && maxs[1] <= nodeMaxY &&
      mins[2] >= nodeMinZ && maxs[2] <= nodeMaxZ;
  }

  #subdivide() {
    const hs = this.halfSize / 2;
    const offs = [-hs, hs];

    this.children = [];

    for (let ix = 0; ix < 2; ix++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let iz = 0; iz < 2; iz++) {
          const c = new Vector(
            this.center[0] + offs[ix],
            this.center[1] + offs[iy],
            this.center[2] + offs[iz],
          );

          this.children.push(new OctreeNode(c, hs, this.capacity, this.minSize));
        }
      }
    }
  }

  /**
   * Inserts item.
   * @param {T} obj item
   * @returns {OctreeNode<T>|null} node where item was inserted, or null
   */
  insert(obj) {
    // if the object has bounds, check if it fits in this node
    if (obj.absmin && obj.absmax) {
      if (!this.#isBoxInBox(obj.absmin, obj.absmax)) {
        return null;
      }
    } else {
      if (!this.#isInBox(obj.origin)) {
        return null;
      }
    }

    if (this.children === null) {
      // is there enough space? if so, add it here
      if (this.points.length < this.capacity || this.halfSize <= this.minSize) {
        this.points.push(obj);
        return this;
      }

      // split
      this.#subdivide();

      // move points into children
      const old = this.points;
      this.points = [];

      // re-insert old points
      for (const p of old) {
        let inserted = false;
        for (const ch of this.children) {
          const node = ch.insert(p);
          if (node) {
            if (p.octreeNode) {
              p.octreeNode = node;
            }
            inserted = true;
            break;
          }
        }
        if (!inserted) {
          this.points.push(p); // keep in parent if it doesn’t fit in any child
          if (p.octreeNode) {
            p.octreeNode = this;
          }
        }
      }
    }

    // insert into child
    for (const ch of this.children) {
      const node = ch.insert(obj);
      if (node) {
        return node;
      }
    }

    // if it didn’t fit in any child (e.g. straddles boundary), keep it here
    this.points.push(obj);
    return this;
  }

  /**
   * Removes item from this node.
   * @param {T} obj item
   * @returns {boolean} true if removed
   */
  remove(obj) {
    const idx = this.points.indexOf(obj);
    if (idx !== -1) {
      this.points.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Collect candidates inside AABB.
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @yields {T} item
   */
  *queryAABB(mins, maxs) {
    // AABB-AABB intersection test
    // node bounds:
    const nodeMinX = this.center[0] - this.halfSize;
    const nodeMaxX = this.center[0] + this.halfSize;
    const nodeMinY = this.center[1] - this.halfSize;
    const nodeMaxY = this.center[1] + this.halfSize;
    const nodeMinZ = this.center[2] - this.halfSize;
    const nodeMaxZ = this.center[2] + this.halfSize;

    if (maxs[0] < nodeMinX || mins[0] > nodeMaxX ||
      maxs[1] < nodeMinY || mins[1] > nodeMaxY ||
      maxs[2] < nodeMinZ || mins[2] > nodeMaxZ) {
      return;
    }

    // check points
    if (this.points.length > 0) {
      for (const p of this.points) {
        // check if point is inside query AABB
        if (p.absmin && p.absmax) {
          // AABB-AABB overlap
          if (p.absmin[0] <= maxs[0] && p.absmax[0] >= mins[0] &&
            p.absmin[1] <= maxs[1] && p.absmax[1] >= mins[1] &&
            p.absmin[2] <= maxs[2] && p.absmax[2] >= mins[2]) {
            yield p;
          }
        } else {
          // point in AABB
          if (p.origin[0] >= mins[0] && p.origin[0] <= maxs[0] &&
            p.origin[1] >= mins[1] && p.origin[1] <= maxs[1] &&
            p.origin[2] >= mins[2] && p.origin[2] <= maxs[2]) {
            yield p;
          }
        }
      }
    }

    // traverse children
    if (this.children) {
      for (const ch of this.children) {
        yield* ch.queryAABB(mins, maxs);
      }
    }
  }

  /**
   * Collect candidates inside sphere centered at pos with radius r.
   * @param {Vector} point position
   * @param {number} radius radius
   * @yields {[number, T]} distance and item
   */
  *querySphere(point, radius) {
    // AABB-sphere intersection test
    const dx = Math.max(0, Math.abs(point[0] - this.center[0]) - this.halfSize);
    const dy = Math.max(0, Math.abs(point[1] - this.center[1]) - this.halfSize);
    const dz = Math.max(0, Math.abs(point[2] - this.center[2]) - this.halfSize);
    const dist2 = dx * dx + dy * dy + dz * dz;

    if (dist2 > radius * radius) {
      // no intersection
      return;
    }

    // check points
    if (this.points.length > 0) {
      for (const p of this.points) {
        const d = p.origin.copy().subtract(point).len();
        if (d <= radius) {
          yield [d, p];
        }
      }
    }

    // traverse children
    if (this.children) {
      for (const ch of this.children) {
        yield* ch.querySphere(point, radius);
      }
    }
  }
}

/**
 * Simple Octree for spatial-indexing of anything.
 * @template {OctreeItem} T
 */
export class Octree {
  /**
   * @param {Vector} center center point, e.g (mins + maxs) / 2
   * @param {number} halfSize half the size of the longest dimension, e.g. (Math.max of (maxs - mins)) / 2 +1
   * @param {number} capacity maximum items per node before splitting, default 8
   * @param {number} minSize minimum halfSize to allow splitting, default 4
   */
  constructor(center, halfSize, capacity = 8, minSize = 4) {
    /** @type {OctreeNode<T>} */
    this.root = new OctreeNode(center, halfSize, capacity, minSize);
  }

  /**
   * Inserts item.
   * @param {T} item item to add
   * @returns {OctreeNode<T>|null} node where item was inserted
   */
  insert(item) {
    return this.root.insert(item);
  }

  /**
   * Removes item.
   * @param {T} item item to remove
   * @returns {boolean} true if removed
   */
  remove(item) {
    // if an item knows its node, use it
    if (item.octreeNode) {
      const removed = item.octreeNode.remove(item);
      if (removed) {
        item.octreeNode = null;
      }
      return removed;
    }

    // otherwise we can’t easily remove without searching, which is slow
    // for now assume item has octreeNode if it was inserted
    // TODO: fallback search removal
    return false;
  }

  /**
   * Collect candidates inside AABB.
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @yields {T} item
   */
  *queryAABB(mins, maxs) {
    yield* this.root.queryAABB(mins, maxs);
  }

  /**
   * @param {Vector} point point in space to search nearest to
   * @param {number} maxDist maximum distance to search, default unlimited
   * @returns {T|null} nearest item whose origin is within maxDist, or null
   */
  nearest(point, maxDist = Infinity) {
    let best = null;
    let bestDist = Infinity;

    for (const [d, item] of this.root.querySphere(point, maxDist)) {
      if (d < bestDist) {
        bestDist = d;
        best = item;
      }
    }

    return best;
  }
};
