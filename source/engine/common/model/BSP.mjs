import { content } from '../../../shared/Defs.mjs';
import { BaseModel } from './BaseModel.mjs';

/** @typedef {import('../../../shared/Vector.mjs').default} Vector */
/** @typedef {import('./BaseModel.mjs').Face} Face */
/** @typedef {import('./BaseModel.mjs').Plane} Plane */

/**
 * @typedef {object} Clipnode
 * @property {number} planenum - Index into planes array
 * @property {number[]} children - Child node indices [front, back]
 */

/**
 * @typedef {object} Hull
 * @property {Clipnode[]} clipnodes - Clipnodes for this hull
 * @property {Plane[]} planes - Planes for collision detection
 * @property {number} [firstclipnode] - Index of first clipnode (optional)
 * @property {number} lastclipnode - Index of last clipnode
 * @property {Vector} clip_mins - Minimum bounding box for this hull
 * @property {Vector} clip_maxs - Maximum bounding box for this hull
 */

/**
 * @typedef {Record<string, string>} WorldspawnInfo
 * Parsed worldspawn entity key-value pairs
 */

/**
 * @typedef {Record<string, {fileofs: number, filelen: number}>} BSPXLumps
 * BSPX extended lump data (RGBLIGHTING, LIGHTINGDIR, etc.)
 */

const VISDATA_SIZE = 1024; // CR: might be too little (TODO: dynamic size based on leaf count)

/**
 * Visibility data for PVS/PHS
 */
export class Visibility {
  #data = new Uint8Array(VISDATA_SIZE);

  #model = /** @type {BrushModel} */ (null);

  constructor(model = null) {
    this.#model = model;

    if (model !== null && model.visdata === null) {
      this.revealAll();
    }
  }

  /**
   * Create a Visibility instance from a BrushModel.
   * @param {BrushModel} model map model
   * @param {number} visofs offset into model visdata
   * @returns {Visibility} visibility instance
   */
  static fromBrushModel(model, visofs) {
    console.assert(model instanceof BrushModel);

    const modelVisSize = (model.leafs.length + 7) >> 3;

    console.assert(modelVisSize <= VISDATA_SIZE);

    const visibility = new Visibility(model);

    if (model.visdata !== null) {
      for (let _out = 0, _in = visofs; _out < modelVisSize;) {
        if (model.visdata[_in] !== 0) {
          visibility.#data[_out++] = model.visdata[_in++];
          continue;
        }

        for (let c = model.visdata[_in + 1]; c > 0; c--) {
          visibility.#data[_out++] = 0x00;
        }

        _in += 2;
      }
    }

    return visibility;
  }

  /**
   * Will reveal all leafs.
   * @returns {Visibility} this
   */
  revealAll() {
    this.#data.fill(0xff);

    return this;
  }

  /**
   * Will hide all leafs.
   * @returns {Visibility} this
   */
  hideAll() {
    this.#data.fill(0x00);

    return this;
  }

  /**
   * Recursive helper for addFatPoint.
   * @param {Vector} p point in world
   * @param {Node} node current BSP node
   */
  #addToFatPoint(p, node) {
    while (true) {
      if (node.contents < 0) {
        if (node.contents !== content.CONTENT_SOLID) {
          const vis = Visibility.fromBrushModel(this.#model, node.visofs);

          for (let i = 0; i < this.#data.length; i++) { // merge visibility from node to ours
            this.#data[i] |= vis.#data[i];
          }
        }
        return;
      }

      const normal = node.plane.normal;
      const d = p.dot(normal) - node.plane.dist;

      if (d > 8.0) {
        node = node.children[0];
        continue;
      }

      if (d < -8.0) {
        node = node.children[1];
        continue;
      }

      this.#addToFatPoint(p, node.children[0]);
      node = node.children[1];
    }
  }

  /**
   * Adds a point to the visibility, merging visibility from all leafs connected.
   * @param {Vector} p point in world
   * @returns {Visibility} this
   */
  addFatPoint(p) {
    this.#addToFatPoint(p, this.#model.nodes[0]);

    return this;
  }

  /**
   * Check if any of the given leafs are revealed.
   * @param {number[]} leafnums leaf indices
   * @returns {boolean} whether any of the given leafs are revealed
   */
  areRevealed(leafnums) {
    for (let i = 0; i < leafnums.length; i++) {
      if ((this.#data[leafnums[i] >> 3] & (1 << (leafnums[i] & 7))) !== 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a given leaf is revealed.
   * @param {number} leafnum leaf index
   * @returns {boolean} whether the given leaf is revealed
   */
  isRevealed(leafnum) {
    return (this.#data[leafnum >> 3] & (1 << (leafnum & 7))) !== 0;
  }
};

/** @type {Visibility} @readonly */
export const revealedVisibility = (new Visibility()).revealAll();

/** @type {Visibility} @readonly */
export const hiddenVisibility = (new Visibility()).hideAll();

export class BrushModelComponent {
  /**
   * @param {BrushModel} brushmodel parent brush model
   */
  constructor(brushmodel) {
    /** @type {BrushModel} owning brush model @protected */
    this._brushmodel = brushmodel;
  }
};

/**
 * BSP tree node
 */
export class Node extends BrushModelComponent {
  /** @type {number} node index in the nodes array */
  num = 0;

  /** @type {number} */
  contents = 0;
  /** @type {number} index into planes array */
  planenum = 0;
  /** @type {Plane} splitting plane */
  plane = null;
  /** @type {Node|null} parent node */
  parent = null;
  /** @type {Node[]} frontside, backside - numbers during loading, Node refs after */
  children = [null, null];
  /** @type {number} visibility offset for PVS */
  visofs = 0;
  /** @type {Vector|null} minimum bounding box */
  mins = null;
  /** @type {Vector|null} maximum bounding box */
  maxs = null;
  /** @type {number} first marksurface index (for leafs), aka firstleafface */
  firstmarksurface = 0;
  /** @type {number} number of marksurfaces (for leafs), aka numleaffaces */
  nummarksurfaces = 0;
  /** @type {number} first face index (for nodes) */
  firstface = 0;
  /** @type {number} number of faces (for nodes) */
  numfaces = 0;
  /** @type {number[]} ambient sound levels [water, sky, slime, lava] */
  ambient_level = [0, 0, 0, 0];

  // === Renderer related ===
  /** @type {number} used by the renderer to determine what to draw */
  markvisframe = 0;
  /** @type {number} used by the renderer to determine what to draw */
  visframe = 0;
  /** @type {number} index into skychain list */
  skychain = 0;
  /** @type {number} index into waterchain list */
  waterchain = 0;
  /** @type {number[]} render command list */
  cmds = [];

  // === Quake 2 based features ===
  /** @type {number} cluster for PVS */
  cluster = 0;
  /** @type {number} area for area portals */
  area = 0;
  /** @type {number} first leaf brush index */
  firstleafbrush = 0;
  /** @type {number} number of leaf brushes */
  numleafbrushes = 0;

  *facesIter() {
    for (let i = 0; i < this.numfaces; i++) {
      yield this._brushmodel.faces[this.firstface + i];
    }
  }
};

export class BrushSide extends BrushModelComponent {
  /** @type {number} plane index, facing leaf outwards */
  planenum = 0;
  /** @type {number} texture info index */
  texinfo = 0;
};

export class Brush extends BrushModelComponent {
  /** @type {number} first brush side index */
  firstside = 0;
  /** @type {number} number of brush sides */
  numsides = 0;
  /** @type {number} contents flags, see Def.contents */
  contents = 0;

  *sidesIter() {
    for (let i = 0; i < this.numsides; i++) {
      yield this._brushmodel.brushsides[this.firstside + i];
    }
  }
};

/**
 * Base class for brush-based models (BSP maps)
 * All loading is handled by BSP29Loader.mjs
 */
export class BrushModel extends BaseModel {
  /** @type {number} BSP format version */
  version = null;

  /** @type {number} Bounding radius for culling */
  radius = 0;

  /** @type {Plane[]} All planes in the BSP tree */
  planes = [];

  /** @type {Face[]} All visible faces/surfaces */
  faces = [];

  /** @type {Vector[]} All vertex positions */
  vertexes = [];

  /** @type {number[][]} Edge vertex indices [v1, v2] */
  edges = [];

  /** @type {number[]} Surface edge list (index into edges, negative = reverse) */
  surfedges = [];

  /** @type {Node[]} BSP tree nodes */
  nodes = [];

  /** @type {Node[]} BSP leaf nodes */
  leafs = [];

  /** @type {import('../../client/R.mjs').BrushModelTexture[]} Texture information */
  textures = [];

  /** @type {any[]} Texture coordinate info per face */
  texinfo = [];

  /** @type {number[]} Face indices visible from each leaf */
  marksurfaces = [];

  /** @type {Uint8Array} Lightmap data (grayscale) */
  lightdata = null;

  /** @type {Uint8Array} Lightmap data (RGB) */
  lightdata_rgb = null;

  /** @type {Uint8Array} Deluxemap data (normals) */
  deluxemap = null;

  /** @type {object|null} Lightgrid octree data */
  lightgrid = null;

  /** @type {Uint8Array} Visibility data for PVS */
  visdata = null;

  /** @type {Clipnode[]} Clipnodes for collision detection */
  clipnodes = [];

  /** @type {Hull[]} Collision hulls for physics (hull0, hull1, hull2) */
  hulls = [];

  /** @type {BrushModel[]} Submodels (brush entities) */
  submodels = [];

  /** @type {number} First face index for this submodel */
  firstface = 0;

  /** @type {number} Number of faces in this submodel */
  numfaces = 0;

  /** @type {string} Entity lump as string */
  entities = null;

  /** @type {WorldspawnInfo} Parsed worldspawn entity properties */
  worldspawnInfo = {};

  /** @type {number} Offset for BSPX extended data */
  bspxoffset = 0;

  /** @type {BSPXLumps} BSPX extended lumps */
  bspxlumps = null;

  /** @type {boolean} Whether this is an inline submodel (brush entity) vs the world */
  submodel = false;

  /** @type {Array<number[]>} Rendering chains (texture batches) for optimized drawing */
  chains = [];

  /** @type {number} Offset into vertex buffer for turbulent surfaces (water, slime, lava) */
  waterchain = 0;

  /** @type {number} Offset into vertex buffer for sky surfaces */
  skychain = 0;

  /** @type {boolean} Whether RGB lighting is used */
  coloredlights = false;

  /** @type {number[]|null} Leaf brushes, useful for PHS/PVS (optional) */
  leafbrushes = null;

  /** @type {BrushSide[]|null} Brush sides (optional) */
  brushsides = null;

  /** @type {Brush[]|null} Brushes (optional) */
  brushes = null;

  type = 0; // Mod.type.brush;

  *facesIter() {
    for (let i = 0; i < this.numfaces; i++) {
      yield this.faces[this.firstface + i];
    }
  }

  /**
   * Find the leaf node for a given point in 3D space
   * @param {Vector} p position
   * @returns {Node} leaf node containing the point
   */
  getLeafForPoint(p) {
    let node = this.nodes[0];

    while (true) {
      if (node.contents < 0) {
        // reached a leaf
        return node;
      }

      /** @type {Vector} */
      const normal = node.plane.normal;

      if (p.dot(normal) - node.plane.dist > 0) {
        node = node.children[0];
      } else {
        node = node.children[1];
      }
    }
  }

  /**
   * @param {Vector} point point in world
   * @returns {Visibility} visibility data for the leaf containing the point
   */
  getPvsByPoint(point) {
    return this.getPvsByLeaf(this.getLeafForPoint(point));
  }

  /**
   * @param {Node} leaf leaf node
   * @returns {Visibility} visibility data for the given leaf
   */
  getPvsByLeaf(leaf) {
    if (leaf === this.leafs[0]) {
      return hiddenVisibility;
    }

    return Visibility.fromBrushModel(this, leaf.visofs);
  }

  /**
   * This will merge visibility from all leafs from a given starting point.
   * @param {Vector} point point in world
   * @returns {Visibility} visibility data for the leaf containing the point
   */
  getFatPvsByPoint(point) {
    return Visibility.fromBrushModel(this, this.leafs[0].visofs).addFatPoint(point);
  }
};
