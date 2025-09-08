import Vector from '../../../shared/Vector.mjs';
import { CRC16CCITT } from '../CRC.mjs';
import { CorruptedResourceError } from '../Errors.mjs';

import { BaseModel, Face, Plane } from './BaseModel.mjs';

const novis = new Array(1024).fill(0xff);

export class Node {
  /** @type {number} */
  contents = 0;
  /** @type {Plane} dividing plane */
  plane = null;
  /** @type {Node[]} frontside, backside */
  children = [null, null];
};

export class BrushModel extends BaseModel {
  /** @type {29|844124994} */
  version = null;

  radius = 0;

  /** @type {Plane[]} */
  planes = [];

  /** @type {Face[]} */
  faces = [];

  /** @type {Vector[]} */
  vertexes = [];

  /** @type {number[][]} */
  edges = [];

  /** @type {number[]} */
  surfedges = [];

  /** @type {Node[]} */
  nodes = [];

  /**
   * @param {Vector} p position
   * @returns {Node} leaf
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

  #determineRadius() {
    const mins = new Vector(), maxs = new Vector();

    for (let i = 0; i < this.vertexes.length; i++) {
      const vert = this.vertexes[i];
      if (vert[0] < mins[0]) {
        mins[0] = vert[0];
      } else if (vert[0] > maxs[0]) {
        maxs[0] = vert[0];
      }

      if (vert[1] < mins[1]) {
        mins[1] = vert[1];
      } else if (vert[1] > maxs[1]) {
        maxs[1] = vert[1];
      }

      if (vert[2] < mins[2]) {
        mins[2] = vert[2];
      } else if (vert[2] > maxs[2]) {
        maxs[2] = vert[2];
      }
    };

    this.radius = (new Vector(
      Math.abs(mins[0]) > Math.abs(maxs[0]) ? Math.abs(mins[0]) : Math.abs(maxs[0]),
      Math.abs(mins[1]) > Math.abs(maxs[1]) ? Math.abs(mins[1]) : Math.abs(maxs[1]),
      Math.abs(mins[2]) > Math.abs(maxs[2]) ? Math.abs(mins[2]) : Math.abs(maxs[2]),
    )).len();
  }
};

export class BSP29 extends BrushModel {
  /** @type {29} */
  version = 29;

  static #lump = Object.freeze({
    entities: 0,
    planes: 1,
    textures: 2,
    vertexes: 3,
    visibility: 4,
    nodes: 5,
    texinfo: 6,
    faces: 7,
    lighting: 8,
    clipnodes: 9,
    leafs: 10,
    marksurfaces: 11,
    edges: 12,
    surfedges: 13,
    models: 14,
  });

  #loadVertexes(buffer) {
    const view = new DataView(buffer);
    let fileofs = view.getUint32((BSP29.#lump.vertexes << 3) + 4, true);
    const filelen = view.getUint32((BSP29.#lump.vertexes << 3) + 8, true);
    if ((filelen % 12) !== 0) {
      throw new CorruptedResourceError(this.name, 'BSP29: vertexes lump length is not a multiple of 12');
    }
    const count = filelen / 12;
    this.vertexes.length = count;
    let i;
    for (i = 0; i < count; i++) {
      this.vertexes[i] = new Vector(view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true));
      fileofs += 12;
    }
  }

  #loadEdges(buffer) {
    const view = new DataView(buffer);
    let fileofs = view.getUint32((BSP29.#lump.edges << 3) + 4, true);
    const filelen = view.getUint32((BSP29.#lump.edges << 3) + 8, true);
    if ((filelen & 3) !== 0) {
      throw new CorruptedResourceError(this.name, 'BSP29: edges lump length is not a multiple of 8');
    }
    const count = filelen >> 2;
    this.edges.length = count;
    for (let i = 0; i < count; i++) {
      this.edges[i] = [view.getUint16(fileofs, true), view.getUint16(fileofs + 2, true)];
      fileofs += 4;
    }
  }

  #loadSurfedges(buffer) {
    const view = new DataView(buffer);
    const fileofs = view.getUint32((BSP29.#lump.surfedges << 3) + 4, true);
    const filelen = view.getUint32((BSP29.#lump.surfedges << 3) + 8, true);
    const count = filelen >> 2;
    this.surfedges.length = count;
    for (let i = 0; i < count; i++) {
      this.surfedges[i] = view.getInt32(fileofs + (i << 2), true);
    }
  }

  #loadPlanes(buffer) {

  }

  #loadTextures(buffer) {
  }

  load(buffer) {
    console.assert(this.version === (new DataView(buffer)).getUint32(0, true));

    this.#loadVertexes(buffer);
    this.#loadEdges(buffer);
    this.#loadSurfedges(buffer);

    this.checksum = CRC16CCITT.Block(new Uint8Array(buffer));
    this.needload = false;

    return this;
  }
};

export class BSP2 extends BSP29 {
};
