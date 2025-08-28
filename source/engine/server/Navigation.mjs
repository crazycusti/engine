import Vector from '../../shared/Vector.mjs';
import { MissingResourceError } from '../common/Errors.mjs';
import { BrushModel, Face } from '../common/Mod.mjs';
import { eventBus, registry } from '../registry.mjs';

let { COM, Con, Mod, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Mod = registry.Mod;
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

  /** @param {Face} face face */
  constructor(face) {
    this.face = face;
  }
};

export class Navigation {
  /** maximum slope that is passable */
  maxSlope = 0.7; // ~45 degrees
  /** units of headroom required above waypoint */
  playerHeight = 56;

  constructor(worldmodel) {
    console.assert(worldmodel, 'Navigation: worldmodel is required');

    /** @type {BrushModel} */
    this.worldmodel = worldmodel;
    this.graph = null;

    this.geometry = {
      /** @type {WalkableSurface[]} */
      walkableSurfaces: [],
    };
  }

  init() {
    Con.Print('Navigation: initializing navigation graph...\n');

    this.load()
      .then(() => Con.Print('Navigation: navigation graph loaded\n'))
      .catch((err) => {
        Con.PrintWarning('Navigation: ' + err + '\n');
        if (registry.isDedicatedServer) { // TODO: remove later
          return;
        }
        setTimeout(() => this.build(), 1000); // wait a bit for the server to be ready
      });
  }

  shutdown() {

  }

  async load() {
    const filename = `maps/${SV.server.mapname}.nav`;
    const data = await COM.LoadFileAsync(filename);

    if (!data) {
      throw new MissingResourceError(filename);
    }
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
      const step = 16;

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

    /**
     * @param {Vector} startpos start position (waypoint)
     * @param {Vector} endpos end position (waypoint), will overwrite!
     * @returns {number} fraction of unobstructed trace, 0 = completely blocked, 1 = fully clear
     */
    const quicktrace = (startpos, endpos) => {
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
    };

    for (const surface of walkableSurfaces) {
      for (const wp of surface.waypoints) {
        const startpos = wp.origin.copy();
        const endpos = startpos.copy();

        // trace up 56 units (player eye height)
        const fractionTop = quicktrace(startpos, endpos.add(new Vector(0, 0, 56)));

        if (fractionTop <= 0.9) {
          wp.availableHeight = 0; // immediately disqualify
          continue;
        }

        wp.availableHeight = endpos[2] - startpos[2];

        if (surface.stability < 1) {
          continue; // skip special checks for sloped surfaces for the time being
        }

        // trace around, taking surface.normal into account to follow the slope
        for (const baseDir of [
          new Vector(16, 0, 0),
          new Vector(-16, 0, 0),
          new Vector(0, 0 ,0),
          new Vector(0, 16, 0),
          new Vector(0, -16, 0),
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
          dir.multiply(16);
          const sideStart = wp.origin.copy();
          const sideEnd = sideStart.copy().add(dir);
          const frac = quicktrace(sideStart, sideEnd);
          if (frac < 1) {
            wp.isClipping = true;
            break;
          }
        }

        // trace around downwards to detect ledges
        for (const dir of [
          new Vector(-16, -16, -128), new Vector(  0, -16, -128), new Vector( 16, -16, -128),
          new Vector(-16,   0, -128), new Vector(  0,   0, -128), new Vector( 16,   0, -128),
          new Vector(-16,  16, -128), new Vector(  0,  16, -128), new Vector( 16,  16, -128),
        ]) {
          // TODO: apply normal vector to dir to follow slope
          const sideStart = wp.origin.copy().add(new Vector(dir[0], dir[1], 0));
          const sideEnd = sideStart.copy().add(new Vector(0, 0, dir[2]));
          const frac = quicktrace(sideStart, sideEnd);
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

          if (sideStart[2] - sideEnd[2] > 64) {
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

  #optimizeWalkpoints() {
    // TODO: merge nearby waypoints, create links etc.

    for (const surface of this.geometry.walkableSurfaces) {
      for (const wp of surface.waypoints) {

      }
    }
  }

  #emitDot(position, color = 15) {
    const pn = R.AllocParticles(1);

    if (pn.length !== 1) {
      Con.PrintWarning(`Navigation: failed to allocate particle for debug dot at [${position}]\n`);
      return;
    }

    const p = R.particles[pn[0]];
    p.die = Infinity;
    p.color = color;
    p.vel = new Vector();
    p.org = position.copy();
  }

  #debugNavigation() {
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
    console.log('Navigation: building navigation graph...', this.worldmodel);

    this.#extractWalkableSurfaces();
    this.#optimizeWalkpoints();

    if (R) {
      setTimeout(() => this.#debugNavigation(), 1000); // wait a bit for renderer to initialize
    }
  }
};
