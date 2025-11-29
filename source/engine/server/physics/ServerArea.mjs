import Vector from '../../../shared/Vector.mjs';
import * as Defs from '../../../shared/Defs.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { Mod, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  Mod = registry.Mod;
  SV = registry.SV;
});

/**
 * Manages spatial partitioning and entity linking for efficient collision detection.
 * Handles the area node BSP tree used for spatial queries.
 */
export class ServerArea {
  constructor() {
  }

  /**
   * Initializes the temporary hull data used for axis-aligned clipping.
   */
  initBoxHull() {
    SV.box_clipnodes = [];
    SV.box_planes = [];
    SV.box_hull = {
      clipnodes: SV.box_clipnodes,
      planes: SV.box_planes,
      firstclipnode: 0,
      lastclipnode: 5,
    };

    for (let i = 0; i <= 5; i++) {
      const node = {};
      SV.box_clipnodes[i] = node;
      node.planenum = i;
      node.children = [];
      node.children[i & 1] = Defs.content.CONTENT_EMPTY;
      if (i !== 5) {
        node.children[1 - (i & 1)] = i + 1;
      } else {
        node.children[1 - (i & 1)] = Defs.content.CONTENT_SOLID;
      }

      const plane = {};
      SV.box_planes[i] = plane;
      plane.type = i >> 1;
      plane.normal = new Vector();
      plane.normal[i >> 1] = 1.0;
      plane.dist = 0.0;
    }
  }

  /**
   * Resolves the hull that should be used when clipping against a given entity.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to create a hull for
   * @param {Vector} mins minimum extents of the moving object
   * @param {Vector} maxs maximum extents of the moving object
   * @param {Vector} out_offset receives the hull offset relative to entity origin
   * @returns {*} the hull structure used for collision tests
   */
  hullForEntity(ent, mins, maxs, out_offset) {
    const origin = ent.entity.origin;
    if (ent.entity.solid !== Defs.solid.SOLID_BSP) {
      const emaxs = ent.entity.maxs;
      const emins = ent.entity.mins;
      SV.box_planes[0].dist = emaxs[0] - mins[0];
      SV.box_planes[1].dist = emins[0] - maxs[0];
      SV.box_planes[2].dist = emaxs[1] - mins[1];
      SV.box_planes[3].dist = emins[1] - maxs[1];
      SV.box_planes[4].dist = emaxs[2] - mins[2];
      SV.box_planes[5].dist = emins[2] - maxs[2];
      out_offset.set(origin);
      return SV.box_hull;
    }

    console.assert(ent.entity.movetype !== Defs.moveType.MOVETYPE_NONE,
      'requires SOLID_BSP with MOVETYPE_NONE, use MOVETYPE_PUSH instead');

    const model = SV.server.models[ent.entity.modelindex];
    console.assert(model && model.type === Mod.type.brush, 'model is null or not a brush');

    const size = maxs[0] - mins[0];
    let hull;
    if (size < 3.0) {
      hull = model.hulls[0];
    } else if (size <= 32.0) {
      hull = model.hulls[1];
    } else {
      hull = model.hulls[2];
    }

    out_offset.setTo(
      hull.clip_mins[0] - mins[0] + origin[0],
      hull.clip_mins[1] - mins[1] + origin[1],
      hull.clip_mins[2] - mins[2] + origin[2],
    );

    return hull;
  }

  /**
   * Recursively builds the area node BSP used for spatial queries.
   * @param {number} depth recursion depth
   * @param {Vector} mins minimum bounds
   * @param {Vector} maxs maximum bounds
   * @returns {*} constructed area node
   */
  createAreaNode(depth, mins, maxs) {
    const anode = { depth, mins, maxs };
    SV.areanodes[0] = anode;

    anode.trigger_edicts = { ent: null };
    anode.trigger_edicts.prev = anode.trigger_edicts.next = anode.trigger_edicts;
    anode.solid_edicts = { ent: null };
    anode.solid_edicts.prev = anode.solid_edicts.next = anode.solid_edicts;

    if (depth === 4) {
      anode.axis = -1;
      anode.children = [];
      return anode;
    }

    anode.axis = (maxs[0] - mins[0]) > (maxs[1] - mins[1]) ? 0 : 1;
    anode.dist = 0.5 * (maxs[anode.axis] + mins[anode.axis]);

    const maxs1 = maxs.copy();
    const mins2 = mins.copy();
    maxs1[anode.axis] = mins2[anode.axis] = anode.dist;
    anode.children = [
      this.createAreaNode(depth + 1, mins2, maxs),
      this.createAreaNode(depth + 1, mins, maxs1),
    ];

    return anode;
  }

  /**
   * Removes an edict from any area lists it is currently linked to.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to unlink
   */
  unlinkEdict(ent) {
    if (ent.area.prev) {
      ent.area.prev.next = ent.area.next;
    }
    if (ent.area.next) {
      ent.area.next.prev = ent.area.prev;
    }
    ent.area.prev = ent.area.next = null;
  }

  /**
   * Iterates all trigger edicts that potentially overlap the provided entity.
   * @param {import('../Edict.mjs').ServerEdict} ent subject edict
   * @param {*} node current area node
   */
  touchLinks(ent, node) {
    const absmin = ent.entity.absmin;
    const absmax = ent.entity.absmax;

    for (let l = node.trigger_edicts.next, next = null; l !== node.trigger_edicts; l = next) {
      next = l.next;
      const touch = l.ent;

      if (touch === ent) {
        continue;
      }

      if (!touch.entity.touch || touch.entity.solid !== Defs.solid.SOLID_TRIGGER) {
        continue;
      }

      if (!absmin.lte(touch.entity.absmax) || !absmax.gte(touch.entity.absmin)) {
        continue;
      }

      SV.server.gameAPI.time = SV.server.time;
      touch.entity.touch(!ent.isFree() ? ent.entity : null);
    }

    if (node.axis === -1) {
      return;
    }

    if (absmax[node.axis] > node.dist) {
      this.touchLinks(ent, node.children[0]);
    }

    if (absmax[node.axis] < node.dist) {
      this.touchLinks(ent, node.children[1]);
    }
  }

  /**
   * Populates the leaf list for an entity by traversing the BSP tree.
   * @param {import('../Edict.mjs').ServerEdict} ent subject edict
   * @param {*} node current BSP node
   */
  findTouchedLeafs(ent, node) {
    if (node.contents === Defs.content.CONTENT_SOLID) {
      return;
    }

    if (node.contents < 0) {
      if (ent.leafnums.length === 16) {
        return;
      }

      ent.leafnums[ent.leafnums.length] = node.num - 1;
      return;
    }

    const sides = Vector.boxOnPlaneSide(ent.entity.absmin, ent.entity.absmax, node.plane);

    if ((sides & 1) !== 0) {
      this.findTouchedLeafs(ent, node.children[0]);
    }

    if ((sides & 2) !== 0) {
      this.findTouchedLeafs(ent, node.children[1]);
    }
  }

  /**
   * Inserts an edict into the area lists and optionally processes trigger touches.
   * @param {import('../Edict.mjs').ServerEdict} ent edict to link
   * @param {boolean} touchTriggers whether triggers should be evaluated
   */
  linkEdict(ent, touchTriggers = false) {
    if (ent.equals(SV.server.edicts[0]) || ent.isFree()) {
      return;
    }

    SV.server.navigation.relinkEdict(ent);
    this.unlinkEdict(ent);

    const origin = ent.entity.origin;
    const absmin = origin.copy();
    const absmax = origin.copy();

    absmin.add(ent.entity.mins).add(new Vector(-1.0, -1.0, -1.0));
    absmax.add(ent.entity.maxs).add(new Vector(1.0, 1.0, 1.0));

    if ((ent.entity.flags & Defs.flags.FL_ITEM) !== 0) {
      absmin.add(new Vector(-14.0, -14.0, 1.0));
      absmax.add(new Vector(14.0, 14.0, -1.0));
    }

    ent.entity.absmin = ent.entity.absmin.set(absmin);
    ent.entity.absmax = ent.entity.absmax.set(absmax);

    ent.leafnums = [];
    if (ent.entity.modelindex !== 0) {
      this.findTouchedLeafs(ent, SV.server.worldmodel.nodes[0]);
    }

    if (ent.entity.solid === Defs.solid.SOLID_NOT) {
      return;
    }

    let node = SV.areanodes[0];
    while (node.axis !== -1) {
      if (ent.entity.absmin[node.axis] > node.dist) {
        node = node.children[0];
      } else if (ent.entity.absmax[node.axis] < node.dist) {
        node = node.children[1];
      } else {
        break;
      }
    }

    const before = (ent.entity.solid === Defs.solid.SOLID_TRIGGER) ? node.trigger_edicts : node.solid_edicts;
    ent.area.next = before;
    ent.area.prev = before.prev;
    ent.area.prev.next = ent.area;
    ent.area.next.prev = ent.area;
    ent.area.ent = ent;

    if (ent.entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP && touchTriggers) {
      this.touchLinks(ent, SV.areanodes[0]);
    }
  }
}
