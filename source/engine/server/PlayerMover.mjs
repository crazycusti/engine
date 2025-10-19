import * as Defs from '../../shared/Defs.mjs';
import { eventBus, registry } from '../registry.mjs';

let { SV, Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  SV = registry.SV;
  Host = registry.Host;
});

export class PlayerMover {
  constructor(pmove) {
    this.pmove = pmove;
    this._states = new WeakMap();
  }

  reset() {
    this._states = new WeakMap();
  }

  /**
   * Returns the persistent pmove player wrapper for the given edict.
   * @param {import('./Edict.mjs').ServerEdict} edict server edict being simulated
   * @param {import('../network/Protocol.mjs').UserCmd} cmd latest user command
   * @returns {import('../common/Pmove.mjs').PmovePlayer} pmove player instance
   */
  #ensureState(edict, cmd) {
    let state = this._states.get(edict);

    if (!state) {
      const pmPlayer = this.pmove.newPlayerMove();
      state = {
        pmPlayer,
        bound: false,
      };
      this._states.set(edict, state);
    }

    const pmPlayer = state.pmPlayer;

    if (!state.bound || pmPlayer.origin !== edict.entity.origin) {
      pmPlayer.origin = edict.entity.origin;
      state.bound = true;
    }
    if (pmPlayer.velocity !== edict.entity.velocity) {
      pmPlayer.velocity = edict.entity.velocity;
    }
    if (pmPlayer.angles !== edict.entity.angles) {
      pmPlayer.angles = edict.entity.angles;
    }

    pmPlayer.cmd = cmd;

    if (!pmPlayer.cmd.msec && Host?.frametime) {
      pmPlayer.cmd.msec = Math.max(1, Math.round(Host.frametime * 1000));
    }

    return pmPlayer;
  }

  /**
   * Executes QuakeWorld-style pmove for the given client entity.
   * @param {import('./Edict.mjs').ServerEdict} edict server edict to update
   * @param {import('./Client.mjs').ServerClient} client owning server client
   * @returns {import('../common/Pmove.mjs').PmovePlayer} updated pmove player state
   */
  run(edict, client) {
    const cmd = client.cmd;
    const pmPlayer = this.#ensureState(edict, cmd);

    this.pmove.beginPlayerMove(edict);

    const health = ('health' in edict.entity) ? Number(edict.entity.health) : 0;
    pmPlayer.dead = health <= 0;

    const isSpectator = ('spectator' in client) ? client.spectator : false;
    pmPlayer.spectator = !!isSpectator || edict.entity.movetype === Defs.moveType.MOVETYPE_NOCLIP;
    pmPlayer.waterlevel = edict.entity.waterlevel ?? 0;
    pmPlayer.watertype = edict.entity.watertype ?? Defs.content.CONTENT_EMPTY;

    if ((edict.entity.flags & Defs.flags.FL_WATERJUMP) !== 0) {
      pmPlayer.waterjumptime = Math.max(pmPlayer.waterjumptime, Math.max(0, edict.entity.teleport_time - SV.server.time));
    } else if (edict.entity.teleport_time > SV.server.time) {
      pmPlayer.waterjumptime = edict.entity.teleport_time - SV.server.time;
    } else if (pmPlayer.waterjumptime > 0 && (edict.entity.teleport_time <= SV.server.time)) {
      pmPlayer.waterjumptime = 0;
    }

    pmPlayer.move();

    edict.entity.waterlevel = pmPlayer.waterlevel;
    edict.entity.watertype = pmPlayer.watertype;

    if (pmPlayer.origin !== edict.entity.origin) {
      edict.entity.origin.set(pmPlayer.origin);
    }
    if (pmPlayer.velocity !== edict.entity.velocity) {
      edict.entity.velocity.set(pmPlayer.velocity);
    }

    if (pmPlayer.onground !== null) {
      edict.entity.flags |= Defs.flags.FL_ONGROUND;
      const groundEdict = SV.server.edicts[pmPlayer.onground];
      edict.entity.groundentity = groundEdict ? groundEdict.entity : null;
    } else {
      edict.entity.flags &= ~Defs.flags.FL_ONGROUND;
      edict.entity.groundentity = null;
    }

    if (pmPlayer.waterjumptime > 0) {
      edict.entity.flags |= Defs.flags.FL_WATERJUMP;
      edict.entity.teleport_time = SV.server.time + pmPlayer.waterjumptime;
    } else if (edict.entity.teleport_time <= SV.server.time) {
      edict.entity.flags &= ~Defs.flags.FL_WATERJUMP;
      edict.entity.teleport_time = 0;
    }

    this.pmove.endPlayerMove();

    return pmPlayer;
  }
}
