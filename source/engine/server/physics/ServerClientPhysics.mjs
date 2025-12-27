import Vector from '../../../shared/Vector.mjs';
import * as Defs from '../../../shared/Defs.mjs';
import { eventBus, registry } from '../../registry.mjs';
import {
  GROUND_ANGLE_THRESHOLD,
  STEP_HEIGHT,
  VELOCITY_EPSILON,
  WATER_SPEED_FACTOR,
} from './Defs.mjs';
import { ServerClient } from '../Client.mjs';

let { Host, SV, V } = registry;

eventBus.subscribe('registry.frozen', () => {
  Host = registry.Host;
  SV = registry.SV;
  V = registry.V;
});

/**
 * Handles player-specific movement functions (walking, swimming, noclip, etc.)
 */
export class ServerClientPhysics {
  constructor() {
  }

  /**
   * @param {import('../Edict.mjs').ServerEdict} ent edict
   */
  walkMove(ent) {
    const oldonground = ent.entity.flags & Defs.flags.FL_ONGROUND;
    ent.entity.flags ^= oldonground;
    const oldorg = ent.entity.origin.copy();
    const oldvel = ent.entity.velocity.copy();
    let result = SV.physics.flyMove(ent, Host.frametime);
    let clip = result.blocked;
    if ((clip & 2) === 0) {
      return;
    }
    if ((oldonground === 0) && (ent.entity.waterlevel === Defs.waterlevel.WATERLEVEL_NONE)) {
      return;
    }
    if (ent.entity.movetype !== Defs.moveType.MOVETYPE_WALK) {
      return;
    }
    if (ent.entity.waterjump_time) {
      return;
    }
    if (SV.nostep.value !== 0.0) {
      return;
    }
    const nosteporg = ent.entity.origin.copy();
    const nostepvel = ent.entity.velocity.copy();
    ent.entity.origin = ent.entity.origin.set(oldorg);
    SV.physics.pushEntity(ent, new Vector(0.0, 0.0, STEP_HEIGHT));
    ent.entity.velocity = new Vector(oldvel[0], oldvel[1], 0.0);
    result = SV.physics.flyMove(ent, Host.frametime);
    clip = result.blocked;
    if (clip !== 0) {
      const curorg = ent.entity.origin;
      if (Math.abs(oldorg[1] - curorg[1]) < 0.03125 && Math.abs(oldorg[0] - curorg[0]) < 0.03125) {
        clip = SV.physics.tryUnstick(ent, oldvel);
      }
      if ((clip & 2) !== 0) {
        // Now properly handle the trace from flyMove
        if (result.steptrace) {
          SV.physics.wallFriction(ent, result.steptrace);
        }
      }
    }
    const downtrace = SV.physics.pushEntity(ent, new Vector(0.0, 0.0, oldvel[2] * Host.frametime - STEP_HEIGHT));
    if (downtrace.plane.normal[2] > GROUND_ANGLE_THRESHOLD) {
      if (downtrace.ent.entity.solid === Defs.solid.SOLID_BSP || downtrace.ent.entity.solid === Defs.solid.SOLID_BBOX) {
        ent.entity.flags |= Defs.flags.FL_ONGROUND;
        ent.entity.groundentity = downtrace.ent.entity;
      }
      return;
    }
    ent.entity.origin = ent.entity.origin.set(nosteporg);
    ent.entity.velocity = ent.entity.velocity.set(nostepvel);
  }

  /**
   * Handles noclip movement for a player entity.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   * @param {import('../Client.mjs').ServerClient} client client connection
   */
  noclipMove(ent, client) {
    const cmd = client.cmd;
    const viewAngles = ent.entity.v_angle ?? ent.entity.angles;
    const { forward, right } = viewAngles.angleVectors();

    const wishvel = new Vector(
      forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
      forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
      forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
    );

    ent.entity.velocity = ent.entity.velocity.set(wishvel.multiply(2.0));
  }

  /**
   * Updates the ideal pitch for a client when standing on the ground.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   */
  setIdealPitch(ent) {
    if (!ent || (ent.entity.flags & Defs.flags.FL_ONGROUND) === 0) {
      return;
    }

    const origin = ent.entity.origin;
    const angleval = ent.entity.angles[1] * (Math.PI / 180.0);
    const sinval = Math.sin(angleval);
    const cosval = Math.cos(angleval);
    const top = new Vector(0.0, 0.0, origin[2] + ent.entity.view_ofs[2]);
    const bottom = new Vector(0.0, 0.0, top[2] - 160.0);
    const z = [];

    for (let i = 0; i < 6; i++) {
      top[0] = bottom[0] = origin[0] + cosval * (i + 3) * 12.0;
      top[1] = bottom[1] = origin[1] + sinval * (i + 3) * 12.0;

      const tr = SV.collision.move(top, Vector.origin, Vector.origin, bottom, 1, ent);

      if (tr.allsolid || tr.fraction === 1.0) {
        return;
      }

      z[i] = top[2] - tr.fraction * 160.0;
    }

    let dir = 0.0;
    let steps = 0;

    for (let i = 1; i < 6; i++) {
      const step = z[i] - z[i - 1];

      if (Math.abs(step) <= VELOCITY_EPSILON) {
        continue;
      }

      if (dir !== 0.0 && Math.abs(step - dir) > VELOCITY_EPSILON) {
        return;
      }

      steps++;
      dir = step;
    }

    if (dir === 0.0) {
      ent.entity.idealpitch = 0.0;
      return;
    }

    if (steps >= 2) {
      ent.entity.idealpitch = -dir * SV.idealpitchscale.value;
    }
  }

  /**
   * Applies friction to a client, reducing horizontal velocity.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   */
  userFriction(ent) {
    if (!ent) {
      return;
    }

    const vel = ent.entity.velocity;
    const speed = Math.hypot(vel[0], vel[1]);

    if (speed === 0.0) {
      return;
    }

    const origin = ent.entity.origin;
    const start = new Vector(origin[0] + vel[0] / speed * 16.0, origin[1] + vel[1] / speed * 16.0, origin[2] + ent.entity.mins[2]);
    let friction = SV.friction.value;

    if (SV.collision.move(start, Vector.origin, Vector.origin, new Vector(start[0], start[1], start[2] - 34.0), 1, ent).fraction === 1.0) {
      friction *= SV.edgefriction.value;
    }

    let newspeed = speed - Host.frametime * (speed < SV.stopspeed.value ? SV.stopspeed.value : speed) * friction;

    if (newspeed < 0.0) {
      newspeed = 0.0;
    }

    newspeed /= speed;
    ent.entity.velocity = ent.entity.velocity.multiply(newspeed);
  }

  /**
   * Accelerates a client towards the desired velocity.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   * @param {Vector} wishvel target direction and speed
   * @param {boolean} [air] whether the acceleration happens in air
   */
  accelerate(ent, wishvel, air = false) {
    if (!ent) {
      return;
    }

    const wishdir = wishvel.copy();
    let wishspeed = wishdir.normalize();

    if (air && wishspeed > 30.0) {
      wishspeed = 30.0;
    }

    const addspeed = wishspeed - ent.entity.velocity.dot(wishdir);

    if (addspeed <= 0.0) {
      return;
    }

    const accelspeed = Math.min(SV.accelerate.value * Host.frametime * wishspeed, addspeed);
    ent.entity.velocity = ent.entity.velocity.add(wishdir.multiply(accelspeed));
  }

  /**
   * Handles movement for clients fully submerged in water.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   * @param {import('../Client.mjs').ServerClient} client client connection
   */
  waterMove(ent, client) {
    if (!ent) {
      return;
    }

    const cmd = client.cmd;
    const viewAngles = ent.entity.v_angle ?? ent.entity.angles;
    const { forward, right } = viewAngles.angleVectors();
    const wishvel = new Vector(
      forward[0] * cmd.forwardmove + right[0] * cmd.sidemove,
      forward[1] * cmd.forwardmove + right[1] * cmd.sidemove,
      forward[2] * cmd.forwardmove + right[2] * cmd.sidemove,
    );

    if ((cmd.forwardmove === 0.0) && (cmd.sidemove === 0.0) && (cmd.upmove === 0.0)) {
      wishvel[2] -= 60.0;
    } else {
      wishvel[2] += cmd.upmove;
    }

    let wishspeed = wishvel.len();

    if (wishspeed > SV.maxspeed.value) {
      const scale = SV.maxspeed.value / wishspeed;
      wishvel.multiply(scale);
      wishspeed = SV.maxspeed.value;
    }

    wishspeed *= WATER_SPEED_FACTOR;
    const speed = ent.entity.velocity.len();
    let newspeed;

    if (speed !== 0.0) {
      newspeed = speed - Host.frametime * speed * SV.friction.value;

      if (newspeed < 0.0) {
        newspeed = 0.0;
      }

      const scale = newspeed / speed;
      ent.entity.velocity = ent.entity.velocity.multiply(scale);
    } else {
      newspeed = 0.0;
    }

    if (wishspeed === 0.0) {
      return;
    }

    const addspeed = wishspeed - newspeed;

    if (addspeed <= 0.0) {
      return;
    }

    const accelspeed = Math.min(SV.accelerate.value * wishspeed * Host.frametime, addspeed);
    ent.entity.velocity = ent.entity.velocity.add(wishvel.multiply(accelspeed / wishspeed));
  }

  /**
   * Handles water jump logic for a client.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   */
  waterJump(ent) {
    if (!ent) {
      return;
    }

    if ((SV.server.time > ent.entity.teleport_time) || (ent.entity.waterlevel === Defs.waterlevel.WATERLEVEL_NONE)) {
      ent.entity.flags &= ~Defs.flags.FL_WATERJUMP;
      ent.entity.teleport_time = 0.0;
    }

    const nvelo = ent.entity.movedir.copy();
    nvelo[2] = ent.entity.velocity[2];
    ent.entity.velocity = nvelo;
  }

  /**
   * Handles standard ground and air movement for a client.
   * @param {import('../Edict.mjs').ServerEdict} ent player entity
   * @param {import('../Client.mjs').ServerClient} client client connection
   */
  airMove(ent, client) {
    if (!ent) {
      return;
    }

    const cmd = client.cmd;
    const { forward, right } = ent.entity.angles.angleVectors();
    let fmove = cmd.forwardmove;
    const smove = cmd.sidemove;

    if ((SV.server.time < ent.entity.teleport_time) && (fmove < 0.0)) {
      fmove = 0.0;
    }

    const wishvel = new Vector(
      forward[0] * fmove + right[0] * smove,
      forward[1] * fmove + right[1] * smove,
      ent.entity.movetype !== Defs.moveType.MOVETYPE_WALK ? cmd.upmove : 0.0,
    );

    const wishdir = wishvel.copy();

    if (wishdir.normalize() > SV.maxspeed.value) {
      wishvel[0] = wishdir[0] * SV.maxspeed.value;
      wishvel[1] = wishdir[1] * SV.maxspeed.value;
      wishvel[2] = wishdir[2] * SV.maxspeed.value;
    }

    if (ent.entity.movetype === Defs.moveType.MOVETYPE_NOCLIP) {
      ent.entity.velocity = wishvel;
    } else if ((ent.entity.flags & Defs.flags.FL_ONGROUND) !== 0) {
      this.userFriction(ent);
      this.accelerate(ent, wishvel);
    } else {
      this.accelerate(ent, wishvel, true);
    }
  }

  /**
   * Executes per-frame thinking for a client.
   * @param {import('../Edict.mjs').ServerEdict} edict client edict
   * @param {import('../Client.mjs').ServerClient} client client connection
   */
  clientThink(edict, client) {
    const entity = edict.entity;

    if (!edict || entity.movetype === Defs.moveType.MOVETYPE_NONE) {
      return;
    }

    const punchangle = entity.punchangle.copy();
    let len = punchangle.normalize() - 10.0 * Host.frametime;

    if (len < 0.0) {
      len = 0.0;
    }

    entity.punchangle = punchangle.multiply(len);

    if (entity.deadflag > 0) {
      return;
    }

    const angles = entity.angles;
    const viewAngles = entity.v_angle ?? entity.angles;
    const v_angle = viewAngles.copy().add(punchangle);

    angles[2] = V.CalcRoll(angles, entity.velocity) * 4.0;
    if (!entity.fixangle) {
      angles[0] = v_angle[0] / -3.0;
      angles[1] = v_angle[1];
    }

    entity.angles = angles;

    if (entity.flags & Defs.flags.FL_WATERJUMP) {
      this.waterJump(edict);
    } else if (entity.waterlevel >= Defs.waterlevel.WATERLEVEL_WAIST && entity.movetype !== Defs.moveType.MOVETYPE_NOCLIP) {
      this.waterMove(edict, client);
    } else if (entity.movetype === Defs.moveType.MOVETYPE_NOCLIP) {
      this.noclipMove(edict, client);
    } else {
      this.airMove(edict, client);
    }
  }

  /**
   * @param {import('../Edict.mjs').ServerEdict} ent edict
   */
  physicsClient(ent) {
    const client = ent.getClient();

    if (client.state < ServerClient.STATE.CONNECTED) {
      return;
    }

    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.PlayerPreThink(ent);
    SV.physics.checkVelocity(ent);
    const movetype = ent.entity.movetype >> 0;
    if ((movetype === Defs.moveType.MOVETYPE_TOSS) || (movetype === Defs.moveType.MOVETYPE_BOUNCE)) {
      SV.physics.physicsToss(ent);
    } else {
      if (!SV.physics.runThink(ent)) {
        return; // thinking might have freed the edict
      }
      switch (movetype) {
        case Defs.moveType.MOVETYPE_NONE:
          break;
        case Defs.moveType.MOVETYPE_WALK:
          if (!SV.physics.checkWater(ent) && (ent.entity.flags & Defs.flags.FL_WATERJUMP) === 0) {
            SV.physics.addGravity(ent);
          }
          SV.physics.checkStuck(ent);
          this.walkMove(ent);
          break;
        case Defs.moveType.MOVETYPE_FLY:
          SV.physics.flyMove(ent, Host.frametime);
          break;
        case Defs.moveType.MOVETYPE_NOCLIP:
          ent.entity.angles = ent.entity.angles.add(ent.entity.avelocity.copy().multiply(Host.frametime));
          ent.entity.origin = ent.entity.origin.add(ent.entity.velocity.copy().multiply(Host.frametime));
          break;
        default:
          throw new Error('SV.Physics_Client: bad movetype ' + movetype);
      }
    }
    SV.area.linkEdict(ent, true);
    SV.server.gameAPI.time = SV.server.time;
    SV.server.gameAPI.PlayerPostThink(ent);
  }
}
