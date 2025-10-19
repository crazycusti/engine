import { Pmove, Trace } from '../common/Pmove.mjs';
import { eventBus, registry } from '../registry.mjs';

let { SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
});

export class ServerPmove extends Pmove {
  constructor() {
    super();
    /** @type {?import('./Edict.mjs').ServerEdict} */
    this._currentEdict = null;
  }

  beginPlayerMove(edict) {
    this._currentEdict = edict;
    return this;
  }

  endPlayerMove() {
    this._currentEdict = null;
  }

  clipPlayerMove(start, end) {
    if (!this._currentEdict) {
      return super.clipPlayerMove(start, end);
    }

    const edict = this._currentEdict;
    const trace = SV.collision.move(start, edict.entity.mins, edict.entity.maxs, end, SV.move.nomonsters, edict);

    const result = new Trace();
    result.allsolid = !!trace.allsolid;
    result.startsolid = !!trace.startsolid;
    result.fraction = trace.fraction ?? 1.0;
    result.endpos.set(trace.endpos ?? end);
    if (trace.plane?.normal) {
      result.plane.normal.set(trace.plane.normal);
      result.plane.dist = trace.plane.dist ?? 0;
    }
    result.ent = trace.ent ? trace.ent.num : 0;
    result.inopen = !!trace.inopen;
    result.inwater = !!trace.inwater;

    return result;
  }

  pointContents(point) {
    return SV.collision.pointContents(point);
  }

  isValidPlayerPosition(position) {
    if (!this._currentEdict) {
      return super.isValidPlayerPosition(position);
    }

    const edict = this._currentEdict;
    const trace = SV.collision.move(position, edict.entity.mins, edict.entity.maxs, position, SV.move.nomonsters, edict);
    return !trace.startsolid;
  }
};
