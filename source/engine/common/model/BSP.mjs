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
 * @typedef {object} Submodel
 * @property {Vector} mins - Minimum bounding box
 * @property {Vector} maxs - Maximum bounding box
 * @property {Vector} origin - Model origin
 * @property {number[]} headnode - Head nodes for each hull
 * @property {number} visleafs - Number of visible leafs
 * @property {number} firstface - First face index
 * @property {number} numfaces - Number of faces
 */

/**
 * @typedef {Record<string, string>} WorldspawnInfo
 * Parsed worldspawn entity key-value pairs
 */

/**
 * @typedef {Record<string, {fileofs: number, filelen: number}>} BSPXLumps
 * BSPX extended lump data (RGBLIGHTING, LIGHTINGDIR, etc.)
 */

/**
 * BSP tree node
 */
export class Node {
  /** @type {number} node index in the nodes array */
  num = 0;
  /** @type {number} */
  contents = 0;
  /** @type {number} index into planes array */
  planenum = 0;
  /** @type {Plane|null} dividing plane */
  plane = null;
  /** @type {Node|null} parent node */
  parent = null;
  /** @type {(Node|number)[]} frontside, backside - numbers during loading, Node refs after */
  children = [null, null];
  /** @type {number} visibility offset for PVS */
  visofs = 0;
  /** @type {Vector|null} minimum bounding box */
  mins = null;
  /** @type {Vector|null} maximum bounding box */
  maxs = null;
  /** @type {number} first marksurface index (for leafs) */
  firstmarksurface = 0;
  /** @type {number} number of marksurfaces (for leafs) */
  nummarksurfaces = 0;
  /** @type {number} first face index (for nodes) */
  firstface = 0;
  /** @type {number} number of faces (for nodes) */
  numfaces = 0;
  /** @type {number[]} render command list */
  cmds = [];
  /** @type {number[]} ambient sound levels [water, sky, slime, lava] */
  ambient_level = [0, 0, 0, 0];
  /** @type {number} index into skychain list */
  skychain = 0;
  /** @type {number} index into waterchain list */
  waterchain = 0;
}

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

  /** @type {any[]} Texture information */
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

  /** @type {Submodel[]} Submodels (brush entities) */
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

  /** @type {boolean} Whether RGB lighting is used */
  coloredlights = false;

  type = 0; // Mod.type.brush;

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
        node = /** @type {Node} */ (node.children[0]);
      } else {
        node = /** @type {Node} */ (node.children[1]);
      }
    }
  }
}
