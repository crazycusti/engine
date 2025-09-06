import Vector from '../../../shared/Vector.mjs';

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


};

export class BSP29 extends BrushModel {
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
};

export class BSP2 extends BSP29 {
};
