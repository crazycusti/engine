import Vector from './Vector.mjs';

/** @typedef {{origin: Vector}} OctreeItem */

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
   * @returns {boolean} true if inserted
   */
  insert(obj) {
    if (!this.#isInBox(obj.origin)) {
      return false;
    }

    if (this.children === null) {
      // is there enough space? if so, add it here
      if (this.points.length < this.capacity || this.halfSize <= this.minSize) {
        this.points.push(obj);
        return true;
      }

      // split
      this.#subdivide();

      // move points into children
      const old = this.points;
      this.points = [];

      // re-insert old points
      for (const p of old) {
        for (const ch of this.children) {
          if (ch.insert(p)) {
            break;
          }
        }
      }
    }

    // insert into child
    for (const ch of this.children) {
      if (ch.insert(obj)) {
        return true;
      }
    }

    // should not happen
    return false;
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
   * @returns {boolean} true if inserted
   */
  insert(item) {
    return this.root.insert(item);
  }

  /**
   * @param {Vector} point point in space to search nearest to
   * @param {number} maxDist maximum distance to search, default unlimited
   * @returns {T?} nearest item whose origin is within maxDist, or null
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
