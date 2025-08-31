import * as Def from '../../shared/Defs.mjs';
import { Octree } from '../../shared/Octree.mjs';
import Vector from '../../shared/Vector.mjs';
import Cvar from '../common/Cvar.mjs';
import { CorruptedResourceError, MissingResourceError, NotImplementedError } from '../common/Errors.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import { BrushModel, Face } from '../common/Mod.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ServerEdict } from './Edict.mjs';

let { CL, COM, Con, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  R = registry.R;
  SV = registry.SV;
});

class Waypoint {
  origin = new Vector();
  /** available clearance on the Z-axis */
  availableHeight = Infinity; // space above the waypoint that is free
  /** whether waypoint is near a ledge */
  nearLedge = false;
  /** whether waypoint is intersection something solid */
  isClipping = false;
  /** whether the point is sitting in the air */
  isFloating = false;

  /** @param {Vector} origin waypoint’s position */
  constructor(origin) {
    this.origin.set(origin);
  }
}

class WalkableSurface {
  /** @type {number} dot product of downwards and plane’s normal, e.g. 1 = flat, down to ~0.7 = slope */
  stability = 0;
  /** @type {Vector} surface’s normal vector */
  normal = new Vector();
  /** @type {Face} */
  face = null;
  /** @type {Waypoint[]} */
  waypoints = [];

  /**
   * @param {Face} face face
   */
  constructor(face) {
    this.face = face;
  }

  serialize() {
    return [
      this.stability,
      [...this.normal],
      null, // TODO
      null, // TODO
    ];
  }
};

/**
 * Navigation graph node
 */
class Node {
  id = -1;
  origin = new Vector();
  availableHeight = 0; // average available height from all waypoints
  nearLedge = false;
  isClipping = false;
  isFloating = false;
  /** @type {Set<WalkableSurface>} */
  surfaces = new Set();
  /** @type {number[][]} list of [id, cost, temporary cost adjustment] */
  neighbors = [];

  /**
   * @param {number} id node ID
   * @param {Vector} origin node position
   */
  constructor(id, origin) {
    this.id = id;
    this.origin.set(origin);
  }

  serialize() {
    return [
      this.id,
      [...this.origin],
      this.availableHeight,
      this.nearLedge,
      this.isClipping,
      this.isFloating,
      Array.from(this.surfaces).map((s) => s.serialize()),
      this.neighbors.slice(),
    ];
  }

  static deserialize(data, navigation) {
    const node = new Node(data[0], new Vector(...data[1]));

    node.availableHeight = data[2];
    node.nearLedge = data[3];
    node.isClipping = data[4];
    node.isFloating = data[5];
    node.surfaces = new Set(data[6].map((id) => null)); // TODO
    node.neighbors = data[7].slice();

    return node;
  }
};

const NAV_FILE_VERSION = 1;

export class Navigation {
  /** maximum slope that is passable */
  maxSlope = 0.7; // ~45 degrees
  /** units of headroom required above waypoint */
  requiredHeight = -Def.hull[0][0][2] + Def.hull[0][1][2]; // hull 1
  requiredRadius = (-Def.hull[0][0][0] + Def.hull[0][1][0]) / 2; // hull 1 (radius, not diameter)

  constructor(worldmodel) {
    console.assert(worldmodel, 'Navigation: worldmodel is required');

    /** @type {BrushModel} */
    this.worldmodel = worldmodel;
    this.graph = {
      /** @type {Node[]} */
      nodes: [],
      /** @type {number[][]} @deprecated unused */
      edges: [],
      /** @type {?Octree<Node>} */
      octree: null,
    };

    this.geometry = {
      /** @type {WalkableSurface[]} */
      walkableSurfaces: [],
    };
  }

  get debugNav() {
    return Cvar.FindVar('developer').value !== 0;
  }

  init() {
    Con.Print('Navigation: initializing navigation graph...\n');

    this.load()
      .then(() => Con.Print('Navigation: navigation graph loaded!\n'))
      .catch((err) => {
        Con.PrintWarning('Navigation: ' + err + '\n');
        setTimeout(() => this.build(), 1000); // wait a bit for the server to be ready
      });
  }

  shutdown() {
    for (const timeout of Object.values(this.relinkEdictCooldown)) {
      clearTimeout(timeout);
    }
  }

  async load() {
    // const filename = `maps/${SV.server.mapname}.nav`;
    // const data = await COM.LoadFileAsync(filename);

    // if (!data) {
    //   throw new MissingResourceError(filename);
    // }

    // TODO: implement loading
    throw new NotImplementedError('Navigation.load');
  }

  async save() {
    // const filename = `maps/${SV.server.mapname}.nav`;

    // const struct = {
    //   version: NAV_FILE_VERSION,
    //   mapname: SV.server.mapname,
    //   checksum: this.worldmodel.checksum,
    //   edges: this.graph.edges,

    // }

    // TODO: implement saving
    throw new NotImplementedError('Navigation.save');
  }

  /**
   * @param {Vector} startpos start position (waypoint)
   * @param {Vector} endpos end position (waypoint), will overwrite!
   * @returns {number} fraction of unobstructed trace, 0 = completely blocked, 1 = fully clear
   */
  #testTraceStatic(startpos, endpos) {
    const trace = {
      fraction: 1.0,
      allsolid: true,
      startsolid: false,
      endpos,
      plane: {normal: new Vector(), dist: 0.0},
      ent: null,
    };
    SV.RecursiveHullCheck(
      SV.server.worldmodel.hulls[0],
      SV.server.worldmodel.hulls[0].firstclipnode,
      0.0, 1.0,
      startpos.copy(),
      endpos.copy(),
      trace,
    );
    endpos.set(trace.endpos);
    if (trace.allsolid) {
      return -1;
    }
    return trace.fraction;
  }

  #testTraceDynamic(startpos, endpos, mins = Vector.origin, maxs = Vector.origin) {
    const trace = SV.Move(startpos.copy(), mins, maxs, endpos.copy(), SV.move.nomonsters, null);

    if (trace.ent && this.debugNav) {
      console.debug('Navigation: trace hit entity', startpos.toString(), 'to', endpos.toString(), 'at', trace.endpos.toString(), trace.ent.entity);
      this.showPath([startpos, endpos], 244);
      this.#emitDot(trace.endpos, 244, 3);
    }

    return trace;
  }

  #extractWalkableSurfaces() {
    const walkableSurfaces = [];
    const downwards = new Vector(0, 0, -1);

    // Pass 1: collect all potentially walkable surfaces
    for (const face of this.worldmodel.faces) {
      if (face.numedges < 3) {
        continue;
      }

      const walkableSurface = new WalkableSurface(face);

      // Stored normal face is not reliable, recompute it
      const faceNormal = (() => {
        const verts = [];

        for (let i = 0; i < face.numedges; i++) {
          const vec = new Vector();
          const surfedge = this.worldmodel.surfedges[face.firstedge + i];

          if (surfedge > 0) {
            vec.set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
          } else {
            vec.set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
          }

          // triangulate on the fly, absolutely cursed
          if (i >= 3) {
            verts.push(verts[0]);
            verts.push(verts[verts.length - 2]);
          }

          verts.push(vec);
        }

        // applying Newell's method for properly handling n-gons
        const normal = new Vector();

        for (let i = 0; i < verts.length; i++) {
          const vCurrent = verts[i];
          const vNext = verts[(i + 1) % verts.length];
          normal[0] += (vCurrent[1] - vNext[1]) * (vCurrent[2] + vNext[2]);
          normal[1] += (vCurrent[2] - vNext[2]) * (vCurrent[0] + vNext[0]);
          normal[2] += (vCurrent[0] - vNext[0]) * (vCurrent[1] + vNext[1]);
        }

        normal.normalize();

        return normal;
      })();

      // Only accept surfaces whose normals point upward and do not exceed a 45 degrees incline.
      walkableSurface.stability = faceNormal.dot(downwards);

      if (walkableSurface.stability < this.maxSlope) {
        continue;
      }

      // Ignore special surfaces, also submodel faces
      if (face.turbulent === true || face.sky === true || face.submodel === true) {
        continue;
      }

      walkableSurface.normal.set(faceNormal);

      walkableSurfaces.push(walkableSurface);
    }

    // Pass 2: check if the walkable surfaces are really walkable by sampling points on them
    // - create sample points across each walkable face (interior sampling)
    // - approach: build ordered 3D vertex list for the face, project to a local 2D basis
    // - grid-sample the face bounding box and keep points that lie inside the polygon
    for (const surface of walkableSurfaces) {
      const face = surface.face;
      /** collect ordered vertices for this face */
      const verts3 = [];
      for (let i = 0; i < face.numedges; i++) {
        const vec = new Vector();
        const surfedge = this.worldmodel.surfedges[face.firstedge + i];

        if (surfedge > 0) {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
        } else {
          vec.set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
        }

        // triangulate on the fly, absolutely cursed
        if (i >= 3) {
          verts3.push(verts3[0]);
          verts3.push(verts3[verts3.length - 2]);
        }

        verts3.push(vec);
      }

      /** face plane normal */
      const n = surface.normal.copy();

      /** pick arbitrary axis not parallel to normal */
      const arbitrary = Math.abs(n[2]) < 0.9 ? new Vector(0, 0, 1) : new Vector(0, 1, 0);

      // build local orthonormal basis (u, v) on the face plane
      const u = n.cross(arbitrary);
      const uLen = u.normalize();
      if (uLen === 0) {
        continue;
      }

      const v = n.cross(u);
      const vLen = v.normalize();

      if (vLen === 0) {
        continue;
      }

      const origin = verts3[0];

      // project verts to 2D coordinates in [u, v] basis
      const verts2 = verts3.map((p3) => {
        const rel = p3.copy().subtract(origin);
        return [ rel.dot(u), rel.dot(v) ];
      });

      // compute bounding box in 2D
      let minX = Infinity, minY = Infinity;
      let maxX = -Infinity, maxY = -Infinity;

      for (const p of verts2) {
        if (p[0] < minX) {
          minX = p[0];
        }
        if (p[0] > maxX) {
          maxX = p[0];
        }
        if (p[1] < minY) {
          minY = p[1];
        }
        if (p[1] > maxY) {
          maxY = p[1];
        }
      }

      /**
       * point-in-polygon (ray crossing)
       * @param {number[]} pt 2D point
       * @param {number[][]} poly polygon
       * @returns {boolean} true if inside
       */
      const pointInPoly = (pt, poly) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i][0];
          const yi = poly[i][1];
          const xj = poly[j][0];
          const yj = poly[j][1];
          const intersect = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi + 0.0) + xi);
          if (intersect) {
            inside = !inside;
          }
        }
        return inside;
      };

      /**
       * helper: distance from point to segment in 2D
       * @param {number[]} p 2D point, point to measure
       * @param {number[]} a 2D point, edge start
       * @param {number[]} b 2D point, edge end
       * @returns {number} distance
       */
      const distPointToSeg = (p, a, b) => {
        // p, a, b are [x,y]
        const vx = b[0] - a[0];
        const vy = b[1] - a[1];
        const wx = p[0] - a[0];
        const wy = p[1] - a[1];
        const c1 = vx * wx + vy * wy;
        if (c1 <= 0) {
          const dx = p[0] - a[0];
          const dy = p[1] - a[1];
          return Math.sqrt(dx * dx + dy * dy);
        }
        const c2 = vx * vx + vy * vy;
        if (c2 <= c1) {
          const dx = p[0] - b[0];
          const dy = p[1] - b[1];
          return Math.sqrt(dx * dx + dy * dy);
        }
        const t = c1 / c2;
        const projx = a[0] + t * vx;
        const projy = a[1] + t * vy;
        const dx = p[0] - projx;
        const dy = p[1] - projy;
        return Math.sqrt(dx * dx + dy * dy);
      };

      // margin inside polygon to avoid sampling near edges (in world units projected to local 2D)
      const innerMargin = 0;

      // sampling resolution (units between samples on the face)
      const step = 12;

      // grid-sample the bounding box and test inclusion
      for (let sx = Math.floor(minX); sx <= Math.ceil(maxX); sx += step) {
        for (let sy = Math.floor(minY); sy <= Math.ceil(maxY); sy += step) {
          const pt2 = [ sx, sy ];
          if (!pointInPoly(pt2, verts2)) {
            continue;
          }

          // ensure sample is at least `innerMargin` units away from any polygon edge
          let minEdgeDist = Infinity;

          for (let ei = 0, ej = verts2.length - 1; ei < verts2.length; ej = ei++) {
            const a = verts2[ej];
            const b = verts2[ei];
            const d = innerMargin > 0 ? distPointToSeg(pt2, a, b) : 0;
            if (d < minEdgeDist) {
              minEdgeDist = d;
            }
            if (minEdgeDist < innerMargin) {
              break;
            }
          }

          if (minEdgeDist < innerMargin) {
            continue;
          }

          // map 2D point back to 3D: origin + u * x + v * y
          const worldPoint = origin.copy().add(u.copy().multiply(pt2[0])).add(v.copy().multiply(pt2[1]));

          surface.waypoints.push(new Waypoint(worldPoint));
        }
      }
    }

    // Pass 3: prune waypoints that do not have enough headroom
    // - for each waypoint, trace upwards to see how much free space is above it
    const rr = this.requiredRadius;
    const hull2Height = new Vector(0, 0, -Def.hull[1][0][2] + Def.hull[1][1][2]);

    for (const surface of walkableSurfaces) {
      for (const wp of surface.waypoints) {
        const startpos = wp.origin.copy();
        const endpos = startpos.copy();

        // trace up hull2 height, will modify endpos to the actual endpoint
        this.#testTraceStatic(startpos, endpos.add(hull2Height));

        wp.availableHeight = endpos[2] - startpos[2];

        if (wp.availableHeight <= 24.0) { // immediately disqualify
          wp.availableHeight = 0;
          continue;
        }

        if (surface.stability < 1) {
          continue; // skip special checks for sloped surfaces for the time being
        }

        // trace around, taking surface.normal into account to follow the slope
        for (const baseDir of [
          new Vector(rr, 0, 0),
          new Vector(-rr, 0, 0),
          new Vector(0, 0 ,0),
          new Vector(0, rr, 0),
          new Vector(0, -rr, 0),
        ]) {
          // FIXME: this does not work correctly on the other direction (E1M1 stairs)
          // project baseDir onto the plane by removing the component along surface.normal
          const dir = baseDir.copy().subtract(
            surface.normal.copy().multiply(baseDir.dot(surface.normal)),
          );
          if (dir.len() === 0) {
            continue;
          }
          dir.normalize();
          dir.multiply(this.requiredRadius);
          const sideStart = wp.origin.copy();
          const sideEnd = sideStart.copy().add(dir);
          const frac = this.#testTraceStatic(sideStart, sideEnd);
          if (frac < 1) {
            wp.isClipping = true;
            break;
          }
        }

        const ledgeCheckHeight = 18.0 * 2; // 2 step sizes

        // trace around downwards to detect ledges
        for (const dir of [
          new Vector(-rr * 1.4, -rr, -ledgeCheckHeight),  new Vector(  0, -rr, -ledgeCheckHeight), new Vector( rr * 1.4, -rr, -ledgeCheckHeight),
          new Vector(-rr,        0,  -ledgeCheckHeight),  new Vector(  0,   0, -ledgeCheckHeight), new Vector( rr,         0, -ledgeCheckHeight),
          new Vector(-rr * 1.4,  rr, -ledgeCheckHeight),  new Vector(  0,  rr, -ledgeCheckHeight), new Vector( rr * 1.4,  rr, -ledgeCheckHeight),
        ]) {
          // TODO: apply normal vector to dir to follow slope
          const sideStart = wp.origin.copy().add(new Vector(dir[0], dir[1], 0));
          const sideEnd = sideStart.copy().add(new Vector(0, 0, dir[2]));
          const frac = this.#testTraceStatic(sideStart, sideEnd);
          if (frac === -1 && sideEnd[2] === sideStart[2]) { // still on solid ground
            if (sideEnd[0] !== sideStart[0] || sideEnd[1] !== sideStart[1]) { // found a wall
              // TODO: but what if it’s a small protrusion, e.g. stairs?
              wp.isClipping = true;
            }
            continue;
          }

          if (frac > 0 && dir[0] === 0 && dir[1] === 0) {
            wp.isFloating = true;
          }

          if (sideStart[2] - sideEnd[2] >= ledgeCheckHeight) {
            wp.nearLedge = true;
            break;
          }
        }
      }
    }

    // Pass 4: filter out unsuitable waypoints and store the rest
    for (const surface of walkableSurfaces) {
      /** @type {Waypoint[]} */
      const suitableWaypoints = [];

      for (const wp of surface.waypoints) {
        if (wp.availableHeight >= 56 && !wp.isClipping && !wp.isFloating) {
          suitableWaypoints.push(wp);
        }
      }

      if (suitableWaypoints.length === 0) {
        continue;
      }

      surface.waypoints = suitableWaypoints;

      this.geometry.walkableSurfaces.push(surface);
    }
  }

  #buildNavigationGraph() {
    // Build a simple navgraph from the extracted waypoints.
    // Steps:
    // 1) collect all waypoints
    // 2) merge nearby waypoints into graph nodes
    // 3) connect nodes with unobstructed links (trace check)

    const mergeRadius = 24; // units to merge nearby waypoints
    const linkRadius =  64; // max distance to attempt a link

    // 1) collect all waypoints into flat list
    const allWaypoints = [];
    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {
        allWaypoints.push({ wp, surface });
      }
    }

    // 2) merge nearby waypoints into nodes using surface-aware clustering
    /** @type {Node[]} */
    const nodes = this.graph.nodes;
    nodes.length = 0;

    const distance = (a, b) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);

    // Helper function to project a point onto a surface plane
    const projectOntoSurface = (point, surface) => {
      const normal = surface.normal;
      const face = surface.face;

      // Get a point on the surface plane (use first vertex of the face)
      let surfacePoint = null;
      const surfedge = this.worldmodel.surfedges[face.firstedge];
      if (surfedge > 0) {
        surfacePoint = new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[surfedge][0]]);
      } else {
        surfacePoint = new Vector().set(this.worldmodel.vertexes[this.worldmodel.edges[-surfedge][1]]);
      }

      // Project point onto the plane: p' = p - ((p - surfacePoint) · n) * n
      const pointToSurface = point.copy().subtract(surfacePoint);
      const distanceToPlane = pointToSurface.dot(normal);
      return point.copy().subtract(normal.copy().multiply(distanceToPlane));
    };

    // Group waypoints that should be merged together
    const waypointGroups = [];
    const processed = new Set();

    for (let i = 0; i < allWaypoints.length; i++) {
      if (processed.has(i)) {
        continue;
      }

      const { wp: seedWp, surface: seedSurface } = allWaypoints[i];
      const group = [{ wp: seedWp, surface: seedSurface, index: i }];
      processed.add(i);

      // Find all nearby waypoints that should merge with this one
      for (let j = i + 1; j < allWaypoints.length; j++) {
        if (processed.has(j)) {
          continue;
        }

        const { wp: otherWp, surface: otherSurface } = allWaypoints[j];

        // Check if waypoints are close enough and on compatible surfaces
        const d = distance(seedWp.origin, otherWp.origin);
        const heightDiff = Math.abs(seedWp.origin[2] - otherWp.origin[2]);

        if (d <= mergeRadius && heightDiff <= 8) { // allow small height differences for slopes
          group.push({ wp: otherWp, surface: otherSurface, index: j });
          processed.add(j);
        }
      }

      waypointGroups.push(group);
    }

    // Create nodes from waypoint groups
    for (const group of waypointGroups) {
      const id = nodes.length;

      // Compute centroid of all waypoints in the group
      const centroid = new Vector();
      let availableHeight = 0;
      let nearLedge = false;
      let isClipping = false;
      let isFloating = false;
      /** @type {Set<WalkableSurface>} */
      const surfaces = new Set();

      for (const { wp, surface } of group) {
        centroid.add(wp.origin);
        availableHeight = Math.min(availableHeight, wp.availableHeight);
        nearLedge = nearLedge || wp.nearLedge;
        isClipping = isClipping || wp.isClipping;
        isFloating = isFloating || wp.isFloating;
        surfaces.add(surface);
      }

      centroid.multiply(1.0 / group.length);

      // If all waypoints are on the same surface, project centroid onto that surface
      if (surfaces.size === 1) {
        const surface = surfaces.values().next().value;
        centroid.set(projectOntoSurface(centroid, surface));
      }

      const node = new Node(id, centroid);
      node.availableHeight = availableHeight;
      node.nearLedge = nearLedge;
      node.isClipping = isClipping;
      node.isFloating = isFloating;
      node.surfaces = surfaces;

      nodes.push(node);
    }

    // 3) connect nodes: attempt links between node pairs if close and unobstructed
    /** @type {number[][]} @deprecated unused */
    const edges = this.graph.edges;
    edges.length = 0;

    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dist = b.origin.distanceTo(a.origin);

        if (dist > linkRadius) {
          continue;
        }

        // perform a trace between the two node origins to ensure unobstructed path
        const viewOffset = new Vector(0, 0, 22); // trace at roughly head height (FIXME: viewofs)
        const stepOffset = new Vector(0, 0, 18); // maximum allowance to climb steps (FIXME: STEPSIZE)
        const start = a.origin.copy().add(viewOffset);
        const end = b.origin.copy().add(viewOffset);
        const startStepped = start.copy().add(stepOffset);

        const frac = this.#testTraceStatic(start.copy(), end.copy());
        const fracStep = this.#testTraceStatic(startStepped, end.copy());

        if (frac < 1.0 && fracStep < 1.0) {
          // blocked or partially blocked
          continue;
        }

        let costBasis = dist; // simple cost metric: distance
        let costA = 0, costB = 0;

        // add penalties for being near a ledge, twice the sum of two merge radii

        if (a.nearLedge) {
          costA += 96;
        }

        if (b.nearLedge) {
          costB += 96;
        }

        costBasis += Math.max(0, end[2] - start[2]); // prefer lower paths

        a.neighbors.push([ b.id, costBasis + costA, 0 ]);
        b.neighbors.push([ a.id, costBasis + costB, 0 ]);
        edges.push([a.id, b.id, costBasis + costA + costB]);
      }
    }
  }

  /** @type {Record<number,NodeJS.Timeout>} edict number to timeout, we cool down incoming updates here */
  relinkEdictCooldown = {};

  /** @type {Record<number,Node>} */
  relinkEdictLinks = {};

  /** @type {number[]} list of edict numbers that we are not interested in, since it’s dynamic, e.g. func_door */
  relinkSkiplist = [];

  /**
   * updates navigation links based on entity position
   * @param {ServerEdict} edict
   */
  relinkEdict(edict) {
    const entity = edict.entity;

    // only care about world and large static brushes for now
    if (entity.solid !== Def.solid.SOLID_BSP) {
      return;
    }

    // this edict got flagged as not interesting earlier
    if (this.relinkSkiplist.includes(edict.num)) {
      return;
    }

    if (this.relinkEdictCooldown[edict.num]) {
      clearTimeout(this.relinkEdictCooldown[edict.num]);
    }

    this.relinkEdictCooldown[edict.num] = setTimeout(() => {
      delete this.relinkEdictCooldown[edict.num];
      this.#relinkEdict(edict);
    }, 1000);
  }

  /** @param {ServerEdict} edict */
  #relinkEdict(edict) {
    if (edict.isFree()) {
      return;
    }

    const entity = edict.entity;

    const centerPoint = entity.mins.copy().add(entity.maxs).multiply(0.5);

    console.debug('Navigation: relinkEdict', centerPoint, entity);

    for (const node of this.#findNearestNodes(centerPoint, 256)) { // TODO: tune radius
      if (!node) {
        console.warn('Navigation: relinkEdict: no nearby navnode found for', centerPoint, entity);
        continue;
      }

      const a = node.origin.copy();
      a[2] += 18.0; // STEPSIZE

      for (const nb of node.neighbors) {
        if (nb[1] === 0) { // teleporter link, skip
          continue;
        }

        const neighborNode = this.graph.nodes[nb[0]];

        console.assert(neighborNode);

        let penalty = nb[2];

        const b = neighborNode.origin.copy();

        b[2] += 18.0; // STEPSIZE

        // check if the link is blocked or unblocked
        const { fraction } = this.#testTraceDynamic(a, b);
        if (fraction < 1.0) {
          // link is blocked, disable it
          penalty = Infinity;
        } else {
          // link is back open, remove penalty
          penalty = 0;
        }

        nb[2] = penalty;

        // also update the reverse link
        for (const rnb of neighborNode.neighbors) {
          if (rnb[0] === node.id) {
            rnb[2] = penalty;
            break;
          }
        }
      }
    }
  }

  #relinkAll() {
    for (let i = 0; i < SV.server.num_edicts; i++) {
      const edict = SV.server.edicts[i];

      if (edict.isFree()) {
        continue;
      }

      this.#relinkEdict(edict);
    }
  }

  #buildSpecialConnections() {
    this.#buildTeleporterLinks();
    this.#buildDoorLinks();
    this.#relinkAll();
  }

  #buildTeleporterLinks() {
    // looking for teleporters
    for (const teleporterEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'trigger_teleport')) {
      const source = teleporterEdict.entity;
      if (!source.target) {
        continue;
      }

      const destination = ServerEngineAPI.FindByFieldAndValue('targetname', source.target)?.entity;

      if (!destination) {
        console.warn('Navigation: teleporter without a valid target', source);
        continue;
      }

      const sp = source.centerPoint.copy(), dp = destination.centerPoint.copy();

      console.debug('Navigation: found teleporter', sp, '-->', dp);

      const destNode = this.#findNearestNode(dp, 96); // Just grab one in proximity of the destination

      if (!destNode) {
        console.warn('Navigation: teleporter destination has no nearby navnode', destination);
        continue;
      }

      const cost = 0; // no cost for teleporters, since traveling is instant

      // insert a new node here to smooth out the path to the teleporter trigger
      const sourceNode = new Node(this.graph.nodes.length, sp);
      sourceNode.availableHeight = source.maxs[2] - source.mins[2];
      this.graph.nodes.push(sourceNode);
      console.debug('Navigation: adding teleporter source node', sourceNode);

      // link the new node to its neighbors
      for (const sourceNodeNeighbor of this.#findNearestNodes(sp, 64)) {
        console.debug('Navigation: linking teleporter nodes', sourceNodeNeighbor.id, '-->', sourceNode.id);
        sourceNodeNeighbor.neighbors.push([ sourceNode.id, cost, 0 ]); // one-way link
        this.graph.edges.push([ sourceNodeNeighbor.id, sourceNode.id, cost ]);
      }

      // link the new node to the destination node
      console.debug('Navigation: linking teleporter nodes', sourceNode.id, '-->', destNode.id);
      sourceNode.neighbors.push([ destNode.id, cost, 0 ]); // one-way link
      this.graph.edges.push([ sourceNode.id, destNode.id, cost ]);
    }
  }

  #buildDoorLinks() {
    // looking for simple doors
    for (const doorEdict of ServerEngineAPI.FindAllByFieldAndValue('classname', 'func_door')) {
      const door = doorEdict.entity;

      if (door.targetname) { // remote controlled door, skip for now
        continue;
      }

      this.relinkSkiplist.push(doorEdict.num);
    }
  }

  #buildOctree() {
    // compute bounding box of node origins
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (const n of this.graph.nodes) {
      const o = n.origin;
      if (o[0] < minX) { minX = o[0]; }
      if (o[1] < minY) { minY = o[1]; }
      if (o[2] < minZ) { minZ = o[2]; }
      if (o[0] > maxX) { maxX = o[0]; }
      if (o[1] > maxY) { maxY = o[1]; }
      if (o[2] > maxZ) { maxZ = o[2]; }
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const halfSize = Math.max(extentX, extentY, extentZ) / 2 + 1;

    const center = new Vector(cx, cy, cz);
    this.graph.octree = /** @type {Octree<Node>} */(new Octree(center, halfSize, 12, 8));

    for (const n of this.graph.nodes) {
      this.graph.octree.insert(n);
    }
  }

  /**
   * Find nearest graph node to a world position.
   * @param {Vector} position world-space position to query
   * @param {number} maxDist maximum search distance in world units
   * @returns {Node|null} node if found, null if none within maxDist or graph is empty
   */
  #findNearestNode(position, maxDist = 512) {
    if (this.graph.nodes.length === 0) {
      return null;
    }

    // first try octree lookup, if available (linking specials won’t have access to the Octree yet)
    if (this.graph.octree) {
      const n = this.graph.octree.nearest(position, maxDist);

      if (n) {
        return n;
      }
    }

    // fallthrough to full scan if nothing found within maxDist in octree
    console.warn('Navigation: nearest node not found in octree, falling back to linear scan', position, maxDist);

    let best = null;
    let bestDist = Infinity;

    for (const node of this.graph.nodes) {
      const d = position.distanceTo(node.origin);
      if (d < bestDist && d <= maxDist) {
        bestDist = d;
        best = node;
      }
    }

    return best;
  }

  /**
   * Find nearest graph node to a world position. Not using the Octree.
   * @param {Vector} position world-space position to query
   * @param {number} maxDist maximum search distance in world units
   * @yields {Node} node if found, null if none within maxDist or graph is empty
   */
  *#findNearestNodes(position, maxDist = 512) {
    for (const node of this.graph.nodes) {
      const d = position.distanceTo(node.origin);
      if (d <= maxDist) {
        yield node;
      }
    }
  }

  /**
   * Find path between two world positions using A* over the navgraph.
   * Returns an array of Vector positions (node origins) or null if no path.
   * @param {Vector} startPos start position
   * @param {Vector} goalPos goal position
   * @returns {Vector[]|null} path made out of waypoints, or null if no path found, it will include start and end positions
   */
  findPath(startPos, goalPos) {
    if (!this.graph || !this.graph.nodes || this.graph.nodes.length === 0) {
      return null;
    }

    const startNode = this.#findNearestNode(startPos, 512);
    const goalNode = this.#findNearestNode(goalPos, 512);

    if (!startNode || !goalNode) {
      console.log('Navigation: no start or goal node found', startPos, goalPos);
      return null;
    }

    if (startNode.id === goalNode.id) {
      return [ startPos.copy(), goalPos.copy() ];
    }

    // A* structures
    const openSet = new Set([startNode.id]);
    const cameFrom = {}; // id -> id
    const gScore = {}; // id -> cost
    const fScore = {}; // id -> estimated total

    const heuristic = (a, b) => a.distanceTo(b);

    for (const n of this.graph.nodes) {
      gScore[n.id] = Infinity;
      fScore[n.id] = Infinity;
    }

    gScore[startNode.id] = 0;
    fScore[startNode.id] = heuristic(startNode.origin, goalNode.origin);

    // TODO: limit the size, since the graph can be huge and things are moving around anyway all the time
    //       the AI code already knows to refresh the path after some time or distance traveled, so this is fine

    while (openSet.size > 0) {
      // pick node in openSet with lowest fScore
      let currentId = null;
      let currentF = Infinity;
      for (const id of openSet) {
        if (fScore[id] < currentF) {
          currentF = fScore[id];
          currentId = id;
        }
      }

      if (currentId === goalNode.id) {
        // reconstruct path
        const path = [];
        let cur = currentId;
        while (cur !== undefined) {
          const node = this.graph.nodes[cur];
          path.push(node.origin.copy());
          cur = cameFrom[cur];
        }
        path.reverse();
        // prepend exact start and append exact goal for precision
        path[0] = startPos.copy();
        path.push(goalPos.copy());
        return path;
      }

      openSet.delete(currentId);

      for (const nb of this.graph.nodes[currentId].neighbors) {
        const tentativeG = gScore[currentId] + nb[1] + nb[2];
        const nbId = nb[0];
        if (tentativeG < gScore[nbId]) {
          cameFrom[nbId] = currentId;
          gScore[nbId] = tentativeG;
          fScore[nbId] = tentativeG + heuristic(this.graph.nodes[nbId].origin, goalNode.origin);
          if (!openSet.has(nbId)) {
            openSet.add(nbId);
          }
        }
      }
    }

    // no path found
    return null;
  }

  #emitDot(position, color = 15, ttl = Infinity) {
    const pn = R.AllocParticles(1);

    if (pn.length !== 1) {
      Con.PrintWarning(`Navigation: failed to allocate particle for debug dot at [${position}]\n`);
      return;
    }

    const p = R.particles[pn[0]];
    p.die = CL.state.time + ttl;
    p.color = color;
    p.vel = new Vector(0, 0, 0);
    p.org = position.copy();
    p.type = R.ptype.tracer;
  }

  #debugNavigation() {
    for (const node of this.graph.nodes) {
      let color = 144;

      if (node.nearLedge) {
        color = 251;
      }

      this.#emitDot(node.origin.copy().add(new Vector(0, 0, 16)), color);
    }
  }

  /** @param {Vector[]} vectors waypoints */
  showPath(vectors, color = 251) {
    if (!vectors || vectors.length === 0) {
      return;
    }

    const viewOffset = new Vector(0, 0, 22);

    for (let i = 0; i < vectors.length - 1; i++) {
      const start = vectors[i].copy().add(viewOffset);
      const end = vectors[i + 1].copy().add(viewOffset);
      const diff = end.copy().subtract(start);
      const totalDistance = diff.len();
      const stepLength = 4;
      diff.normalize();
      // Sample along the segment every 5 units
      for (let dist = 0; dist <= totalDistance; dist += stepLength) {
        const samplePoint = start.copy().add(diff.copy().multiply(dist));
        this.#emitDot(samplePoint, 251, 10);
      }
    }
  }

  #debugWaypoints() {
    /** @type {{origin: Vector, color: number, surface: WalkableSurface}[]} */
    const debugPoints = [];
    let waypoints = 0;

    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {
        let color = 15;

        if (wp.nearLedge && surface.stability !== 1) {
          color = 47;
        } else if (wp.nearLedge) {
          color = 251;
        } else if (surface.stability !== 1) {
          color = 192;
        }

        debugPoints.push({ origin: wp.origin, color, surface });
        waypoints++;
      }
    }

    console.log('waypoints: ', waypoints);
    console.log('extracted walkable surfaces:', this.geometry.walkableSurfaces);

    for (const { color, origin } of debugPoints) {
      this.#emitDot(origin, color);
    }
  }

  build() {
    Con.Print('Navigation: node graph out of date, rebuilding...\n');

    this.#extractWalkableSurfaces();
    this.#buildNavigationGraph();
    this.#buildSpecialConnections();
    this.#buildOctree();

    Con.Print('Navigation: node graph built with ' + this.graph.nodes.length + ' nodes and ' + this.graph.edges.length + ' edges.\n');

    this.save()
      .then(() => Con.Print('Navigation: navigation graph saved!\n'))
      .catch((err) => Con.PrintError('Navigation: failed to save navigation graph: ' + err + '\n'));

    if (R) {
      setTimeout(() => {
        if (this.debugNav) {
          // this.#debugWaypoints();
          this.#debugNavigation();
        }
      }, 1000); // wait a bit for renderer to initialize
    }
  }
};
