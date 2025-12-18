import MSG, { SzBuffer } from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Defs from '../../shared/Defs.mjs';
import Cvar from '../common/Cvar.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ServerClient } from './Client.mjs';

let { COM, Con, Host, NET, PR, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  NET = registry.NET;
  PR = registry.PR;
  SV = registry.SV;
});

/**
 * Handles all server to client message assembly and related helpers.
 */
export class ServerMessages {
  constructor() {
    this.nullcmd = new Protocol.UserCmd();
  }

  startParticle(org, dir, color, count) {
    const datagram = SV.server.datagram;
    if (datagram.cursize >= 1009) {
      return;
    }
    MSG.WriteByte(datagram, Protocol.svc.particle);
    MSG.WriteCoord(datagram, org[0]);
    MSG.WriteCoord(datagram, org[1]);
    MSG.WriteCoord(datagram, org[2]);
    for (let i = 0; i <= 2; i++) {
      let v = (dir[i] * 16.0) >> 0;
      if (v > 127) {
        v = 127;
      } else if (v < -128) {
        v = -128;
      }
      MSG.WriteChar(datagram, v);
    }
    MSG.WriteByte(datagram, Math.min(count, 255));
    MSG.WriteByte(datagram, color);
  }

  startSound(edict, channel, sample, volume, attenuation) {
    console.assert(volume >= 0 && volume <= 255, 'volume out of range', volume);
    console.assert(attenuation >= 0.0 && attenuation <= 4.0, 'attenuation out of range', attenuation);
    console.assert(channel >= 0 && channel <= 7, 'channel out of range', channel);

    const datagram = SV.server.datagram;
    if (datagram.cursize >= 1009) {
      return;
    }

    let i;
    for (i = 1; i < SV.server.soundPrecache.length; i++) {
      if (sample === SV.server.soundPrecache[i]) {
        break;
      }
    }
    if (i >= SV.server.soundPrecache.length) {
      Con.Print('SV.StartSound: ' + sample + ' was not precached\n');
      SV.server.soundPrecache.push(sample);
      MSG.WriteByte(datagram, Protocol.svc.loadsound);
      MSG.WriteByte(datagram, i);
      MSG.WriteString(datagram, sample);
    }

    let fieldMask = 0;

    if (volume !== 255) {
      fieldMask |= 1;
    }
    if (attenuation !== 1.0) {
      fieldMask |= 2;
    }

    MSG.WriteByte(datagram, Protocol.svc.sound);
    MSG.WriteByte(datagram, fieldMask);
    if ((fieldMask & 1) !== 0) {
      MSG.WriteByte(datagram, volume);
    }
    if ((fieldMask & 2) !== 0) {
      MSG.WriteByte(datagram, Math.floor(attenuation * 64.0));
    }
    MSG.WriteShort(datagram, (edict.num << 3) + channel);
    MSG.WriteByte(datagram, i);
    MSG.WriteCoordVector(datagram, edict.entity.origin.copy().add(edict.entity.mins.copy().add(edict.entity.maxs).multiply(0.5)));
  }

  /**
   * Sends the serverdata message to a specific client.
   * Needs to be done in order to complete the signon process step 1.
   * @param {ServerClient} client client
   */
  sendServerData(client) {
    const message = client.message;

    MSG.WriteByte(message, Protocol.svc.print);
    MSG.WriteString(message, `\x02\nVERSION ${Host.version.string} SERVER (${SV.server.gameVersion})\n`);

    MSG.WriteByte(message, Protocol.svc.serverdata);
    MSG.WriteByte(message, Protocol.version);

    if (PR.QuakeJS?.ClientGameAPI) {
      const { author, name, version } = PR.QuakeJS.identification;
      MSG.WriteByte(message, 1);
      MSG.WriteString(message, name);
      MSG.WriteString(message, author);
      MSG.WriteByte(message, version[0]);
      MSG.WriteByte(message, version[1]);
      MSG.WriteByte(message, version[2]);
    } else {
      MSG.WriteByte(message, 0);
      MSG.WriteString(message, COM.game);
    }

    MSG.WriteByte(message, SV.svs.maxclients);
    MSG.WriteString(message, SV.server.edicts[0].entity.message || SV.server.mapname);
    // SV.pmove.movevars.sendToClient(message);
    for (let i = 1; i < SV.server.modelPrecache.length; i++) {
      MSG.WriteString(message, SV.server.modelPrecache[i]);
    }
    MSG.WriteByte(message, 0);
    for (let i = 1; i < SV.server.soundPrecache.length; i++) {
      MSG.WriteString(message, SV.server.soundPrecache[i]);
    }
    MSG.WriteByte(message, 0);

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_CLIENTDATA_DYNAMIC)) {
      for (const field of SV.server.clientdataFields) {
        MSG.WriteString(message, field);
      }
      MSG.WriteByte(message, 0);
    }

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_ENTITY_EXTENDED)) {
      for (const [classname, { fields }] of Object.entries(SV.server.clientEntityFields)) {
        MSG.WriteString(message, classname);
        for (const field of fields) {
          MSG.WriteString(message, field);
        }
        MSG.WriteByte(message, 0);
      }
      MSG.WriteByte(message, 0);
    }

    // sounds on worldspawn defines the cd track
    const cdtrack = /** @type {number} */ (/** @type {import('./Edict.mjs').WorldspawnEntity} */(SV.server.edicts[0].entity).sounds);

    // only play cd track automatically if set in worldspawn
    if (typeof cdtrack === 'number') {
      MSG.WriteByte(message, Protocol.svc.cdtrack);
      MSG.WriteByte(message, cdtrack);
      MSG.WriteByte(message, 0); // unused
    }

    MSG.WriteByte(message, Protocol.svc.setview);
    MSG.WriteShort(message, client.edict.num);

    const serverCvars = Array.from(Cvar.Filter((/** @type {Cvar} */ cvar) => (cvar.flags & Cvar.FLAG.SERVER) !== 0));
    if (serverCvars.length > 0) {
      MSG.WriteByte(client.message, Protocol.svc.cvar);
      MSG.WriteByte(client.message, serverCvars.length);
      for (const serverCvar of serverCvars) {
        this.writeCvar(client.message, serverCvar);
      }
    }

    // make sure the client knows about the paused state
    if (SV.server.paused) {
      MSG.WriteByte(client.message, Protocol.svc.setpause);
      MSG.WriteByte(client.message, 1);
    }

    MSG.WriteByte(message, Protocol.svc.signonnum);
    MSG.WriteByte(message, 1);

    client.sendsignon = true;
    client.spawned = false;
  }

  writeCvar(msg, cvar) {
    if (cvar.flags & Cvar.FLAG.SECRET) {
      MSG.WriteString(msg, cvar.name);
      MSG.WriteString(msg, cvar.string ? 'REDACTED' : '');
    } else {
      MSG.WriteString(msg, cvar.name);
      MSG.WriteString(msg, cvar.string);
    }
  }

  cvarChanged(cvar) {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (!client.active || !client.spawned) {
        continue;
      }

      MSG.WriteByte(client.message, Protocol.svc.cvar);
      MSG.WriteByte(client.message, 1);
      this.writeCvar(client.message, cvar);
    }
  }

  *traversePVS(pvs, ignoreEdictIds = [], alwaysIncludeEdictIds = [], includeFree = false) {
    for (let e = 1; e < SV.server.num_edicts; e++) {
      const ent = SV.server.edicts[e];

      if (alwaysIncludeEdictIds.includes(e)) {
        yield ent;
        continue;
      }

      if (!includeFree && ent.isFree()) {
        continue;
      }

      if (ignoreEdictIds.includes(e)) {
        continue;
      }

      if (!ent.isInPVS(pvs)) {
        continue;
      }

      yield ent;
    }
  }

  writePlayersToClient(clientEdict, pvs, msg) {
    let changes = false;

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const cl = SV.svs.clients[i];
      const playerEntity = cl.edict.entity;

      if (!cl.spawned) {
        continue;
      }

      if (!clientEdict.equals(cl.edict) && !clientEdict.isInPVS(pvs)) {
        continue;
      }

      let pflags = Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND;

      if (playerEntity.model !== 'progs/player.mdl') {
        pflags |= Protocol.pf.PF_MODEL;
      }

      if (!playerEntity.velocity.isOrigin()) {
        pflags |= Protocol.pf.PF_VELOCITY;
      }

      if (playerEntity.effects) {
        pflags |= Protocol.pf.PF_EFFECTS;
      }

      if (playerEntity.skin) {
        pflags |= Protocol.pf.PF_SKINNUM;
      }

      if (playerEntity.health <= 0) {
        pflags |= Protocol.pf.PF_DEAD;
      }

      if (clientEdict.equals(cl.edict)) {
        pflags &= ~(Protocol.pf.PF_MSEC | Protocol.pf.PF_COMMAND);

        if (playerEntity.weaponframe) {
          pflags |= Protocol.pf.PF_WEAPONFRAME;
        }
      }

      MSG.WriteByte(msg, Protocol.svc.playerinfo);
      MSG.WriteByte(msg, i);
      MSG.WriteShort(msg, pflags);

      MSG.WriteCoordVector(msg, playerEntity.origin);
      MSG.WriteByte(msg, playerEntity.frame);

      if (pflags & Protocol.pf.PF_MSEC) {
        const msec = 1000 * (SV.server.time - cl.local_time);
        MSG.WriteByte(msg, Math.max(0, Math.min(msec, 255)));
      }

      if (pflags & Protocol.pf.PF_COMMAND) {
        const cmd = cl.cmd;

        if (pflags & Protocol.pf.PF_DEAD) {
          cmd.angles.setTo(0, playerEntity.angles[1], 0);
        }

        cmd.buttons = 0;
        cmd.impulse = 0;

        MSG.WriteDeltaUsercmd(msg, this.nullcmd, cmd);
      }

      if (pflags & Protocol.pf.PF_VELOCITY) {
        MSG.WriteCoordVector(msg, playerEntity.velocity);
      }

      if (pflags & Protocol.pf.PF_MODEL) {
        MSG.WriteByte(msg, playerEntity.modelindex);
      }

      if (pflags & Protocol.pf.PF_EFFECTS) {
        MSG.WriteByte(msg, playerEntity.effects);
      }

      if (pflags & Protocol.pf.PF_SKINNUM) {
        MSG.WriteByte(msg, playerEntity.skin);
      }

      if (pflags & Protocol.pf.PF_WEAPONFRAME) {
        MSG.WriteByte(msg, playerEntity.weaponframe);
      }

      changes = true;
    }

    return changes;
  }

  writeDeltaEntity(msg, from, to) {
    const EPSILON = 0.01;

    let bits = 0;

    if (from.classname !== to.classname) {
      bits |= Protocol.u.classname;
    }

    if (from.free !== to.free) {
      bits |= Protocol.u.free;
    }

    if (from.modelindex !== to.modelindex) {
      bits |= Protocol.u.model;
    }

    if (from.frame !== to.frame) {
      bits |= Protocol.u.frame;
    }

    if ((from.colormap || 0) !== (to.colormap || 0)) {
      bits |= Protocol.u.colormap;
    }

    if (from.skin !== to.skin) {
      bits |= Protocol.u.skin;
    }

    if (from.effects !== to.effects) {
      bits |= Protocol.u.effects;
    }

    if (from.solid !== to.solid) {
      bits |= Protocol.u.solid;
    }

    if (to.nextthink >= SV.server.time && (to.nextthink - from.nextthink) > 0.001) {
      bits |= Protocol.u.nextthink;
    }

    for (let i = 0; i < 3; i++) {
      if (isFinite(to.origin[i]) && Math.abs(from.origin[i] - to.origin[i]) > EPSILON) {
        bits |= Protocol.u.origin1 << i;
      }

      if (isFinite(to.angles[i]) && Math.abs(from.angles[i] - to.angles[i]) > EPSILON) {
        bits |= Protocol.u.angle1 << i;
      }

      if (isFinite(to.velocity[i]) && Math.abs(from.velocity[i] - to.velocity[i]) > EPSILON) {
        bits |= Protocol.u.angle1 << i;
      }
    }

    if (!from.maxs.equals(to.maxs)) {
      bits |= Protocol.u.size;
    }

    if (!from.mins.equals(to.mins)) {
      bits |= Protocol.u.size;
    }

    if (bits === 0) {
      return false;
    }

    console.assert(to.num > 0, 'valid entity num', to.num);

    MSG.WriteShort(msg, to.num);
    MSG.WriteShort(msg, bits);

    if (bits & Protocol.u.classname) {
      MSG.WriteString(msg, to.classname);
    }

    if (bits & Protocol.u.free) {
      MSG.WriteByte(msg, to.free ? 1 : 0);
    }

    if (bits & Protocol.u.frame) {
      MSG.WriteByte(msg, to.frame);
    }

    if (bits & Protocol.u.model) {
      MSG.WriteByte(msg, to.modelindex);
    }

    if (bits & Protocol.u.colormap) {
      MSG.WriteByte(msg, to.colormap);
    }

    if (bits & Protocol.u.skin) {
      MSG.WriteByte(msg, to.skin);
    }

    if (bits & Protocol.u.effects) {
      MSG.WriteByte(msg, to.effects);
    }

    if (bits & Protocol.u.solid) {
      MSG.WriteByte(msg, to.solid);
    }

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        MSG.WriteCoord(msg, to.origin[i]);
      }

      if (bits & (Protocol.u.angle1 << i)) {
        MSG.WriteAngle(msg, to.angles[i]);
        MSG.WriteCoord(msg, to.velocity[i]);
      }
    }

    if (bits & Protocol.u.size) {
      MSG.WriteCoordVector(msg, to.maxs);
      MSG.WriteCoordVector(msg, to.mins);
    }

    if (bits & Protocol.u.nextthink) {
      if (from.nextthink <= 0) {
        from.nextthink = SV.server.time;
      }
      MSG.WriteByte(msg, to.nextthink - from.nextthink < 0.250 ? Math.min(255, (to.nextthink - from.nextthink) * 255.0) : 0);
    }

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_ENTITY_EXTENDED)) {
      if (SV.server.clientEntityFields[to.classname]) {
        const entityFields = SV.server.clientEntityFields[to.classname];
        const fields = entityFields.fields;
        const bitsWriter = entityFields.bitsWriter;

        let fieldbits = 0;
        const values = [];

        for (const field of fields) {
          if (from.extended[field] !== to.extended[field]) {
            fieldbits |= 1 << fields.indexOf(field);
            values.push(to.extended[field]);
          }
        }

        bitsWriter(msg, fieldbits);

        if (fieldbits > 0) {
          MSG.WriteSerializables(msg, values);
        }
      }
    }

    return true;
  }

  writeEntitiesToClient(clientEdict, msg) {
    const origin = clientEdict.entity.origin.copy().add(clientEdict.entity.view_ofs);
    const pvs = SV.server.worldmodel.getFatPvsByPoint(origin);

    let changes = this.writePlayersToClient(clientEdict, pvs, msg) ? 1 : 0;

    const cl = SV.svs.clients[clientEdict.num - 1];

    MSG.WriteByte(msg, Protocol.svc.deltapacketentities);

    const visedicts = [];

    for (const ent of this.traversePVS(pvs, [], [clientEdict.num])) {
      if ((msg.data.byteLength - msg.cursize) < 16) {
        Con.PrintWarning('SV.WriteEntitiesToClient: packet overflow, not writing more entities\n');
        break;
      }

      const toState = new SV.EntityState(ent.num);
      toState.classname = ent.entity.classname;
      toState.modelindex = ent.entity.model ? ent.entity.modelindex : 0;
      toState.frame = ent.entity.frame;
      toState.colormap = ent.entity?.colormap || 0;
      toState.skin = ent.entity.skin;
      toState.solid = ent.entity.solid;
      toState.origin.set(ent.entity.origin);
      toState.angles.set(ent.entity.angles);
      toState.velocity.set(ent.entity.velocity);
      toState.effects = ent.entity.effects;
      toState.free = false;
      toState.maxs.set(ent.entity.maxs);
      toState.mins.set(ent.entity.mins);
      toState.nextthink = ent.entity.nextthink || 0;

      if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_ENTITY_EXTENDED)) {
        if (SV.server.clientEntityFields[ent.entity.classname]) {
          const entityFields = SV.server.clientEntityFields[ent.entity.classname];
          const fields = entityFields.fields;

          for (const field of fields) {
            toState.extended[field] = ent.entity[field];
          }
        }
      }

      const fromState = cl.getEntityState(ent.num);

      changes |= this.writeDeltaEntity(msg, fromState, toState) ? 1 : 0;

      fromState.set(toState);

      visedicts.push(ent.num);
    }

    for (let i = 1; i < SV.server.num_edicts; i++) {
      const ent = SV.server.edicts[i];

      if (visedicts.includes(ent.num)) {
        continue;
      }

      const fromState = cl.getEntityState(ent.num);
      const toState = new SV.EntityState(ent.num);
      toState.freeEdict();

      changes |= this.writeDeltaEntity(msg, fromState, toState) ? 1 : 0;
      fromState.set(toState);
    }

    MSG.WriteShort(msg, 0);

    return changes > 0;
  }

  writeClientdataToMessage(clientEdict, msg) {
    if ((clientEdict.entity.dmg_take || clientEdict.entity.dmg_save) && clientEdict.entity.dmg_inflictor) {
      const other = clientEdict.entity.dmg_inflictor.edict ? clientEdict.entity.dmg_inflictor.edict : clientEdict.entity.dmg_inflictor;
      const vec = !other.isFree() ? other.entity.origin.copy().add(other.entity.mins.copy().add(other.entity.maxs).multiply(0.5)) : clientEdict.entity.origin;
      MSG.WriteByte(msg, Protocol.svc.damage);
      MSG.WriteByte(msg, Math.min(255, clientEdict.entity.dmg_save));
      MSG.WriteByte(msg, Math.min(255, clientEdict.entity.dmg_take));
      MSG.WriteCoordVector(msg, vec);
      clientEdict.entity.dmg_take = 0.0;
      clientEdict.entity.dmg_save = 0.0;
    }

    if (clientEdict.entity.fixangle) {
      MSG.WriteByte(msg, Protocol.svc.setangle);
      MSG.WriteAngleVector(msg, clientEdict.entity.angles);
      clientEdict.entity.fixangle = false;
    }

    let bits = Protocol.su.items + Protocol.su.weapon;
    if (clientEdict.entity.view_ofs[2] !== Protocol.default_viewheight) {
      bits += Protocol.su.viewheight;
    }
    if (clientEdict.entity.idealpitch !== 0.0) {
      bits += Protocol.su.idealpitch;
    }

    const serverflags = SV.server.gameAPI?.serverflags ?? 0;

    let items;
    if (clientEdict.entity.items2 !== undefined) {
      if (clientEdict.entity.items2 !== 0.0) {
        items = (clientEdict.entity.items >> 0) + ((clientEdict.entity.items2 << 23) >>> 0);
      } else {
        items = (clientEdict.entity.items >> 0) + ((serverflags << 28) >>> 0);
      }
    } else {
      items = (clientEdict.entity.items >> 0) + ((serverflags << 28) >>> 0);
    }

    if (clientEdict.entity.flags & Defs.flags.FL_ONGROUND) {
      bits += Protocol.su.onground;
    }
    if (clientEdict.entity.waterlevel >= Defs.waterlevel.WATERLEVEL_WAIST) {
      bits += Protocol.su.inwater;
    }

    const punchangle = clientEdict.entity.punchangle;

    if (punchangle[0] !== 0.0) {
      bits |= Protocol.su.punch1;
    }
    if (punchangle[1] !== 0.0) {
      bits |= Protocol.su.punch2;
    }
    if (punchangle[2] !== 0.0) {
      bits |= Protocol.su.punch3;
    }

    if (clientEdict.entity.weaponframe !== 0.0) {
      bits |= Protocol.su.weaponframe;
    }
    if (clientEdict.entity.armorvalue !== 0.0) {
      bits |= Protocol.su.armor;
    }

    MSG.WriteByte(msg, Protocol.svc.clientdata);
    MSG.WriteShort(msg, bits);
    if ((bits & Protocol.su.viewheight) !== 0) {
      MSG.WriteChar(msg, clientEdict.entity.view_ofs[2]);
    }
    if ((bits & Protocol.su.idealpitch) !== 0) {
      MSG.WriteChar(msg, clientEdict.entity.idealpitch);
    }

    if ((bits & Protocol.su.punch1) !== 0) {
      MSG.WriteShort(msg, punchangle[0] * 90);
    }
    if ((bits & Protocol.su.punch2) !== 0) {
      MSG.WriteShort(msg, punchangle[1] * 90.0);
    }
    if ((bits & Protocol.su.punch3) !== 0) {
      MSG.WriteShort(msg, punchangle[2] * 90.0);
    }

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_CLIENTDATA_LEGACY)) {
      MSG.WriteLong(msg, items);
      if ((bits & Protocol.su.weaponframe) !== 0) {
        MSG.WriteByte(msg, clientEdict.entity.weaponframe);
      }
      if ((bits & Protocol.su.armor) !== 0) {
        MSG.WriteByte(msg, clientEdict.entity.armorvalue);
      }
      MSG.WriteByte(msg, SV.ModelIndex(clientEdict.entity.weaponmodel));
      MSG.WriteShort(msg, clientEdict.entity.health);
      MSG.WriteByte(msg, clientEdict.entity.currentammo);
      MSG.WriteByte(msg, clientEdict.entity.ammo_shells);
      MSG.WriteByte(msg, clientEdict.entity.ammo_nails);
      MSG.WriteByte(msg, clientEdict.entity.ammo_rockets);
      MSG.WriteByte(msg, clientEdict.entity.ammo_cells);
      if (COM.standard_quake === true) {
        MSG.WriteByte(msg, clientEdict.entity.weapon & 0xff);
      } else {
        const weapon = clientEdict.entity.weapon;
        for (let i = 0; i <= 31; i++) {
          if ((weapon & (1 << i)) !== 0) {
            MSG.WriteByte(msg, i);
            break;
          }
        }
      }
    }

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_CLIENTDATA_DYNAMIC)) {
      const clientdataFields = SV.server.clientdataFields;
      const destination = msg;

      let fieldbits = 0;
      const values = [];

      for (let i = 0; i < clientdataFields.length; i++) {
        const field = clientdataFields[i];
        const value = clientEdict.entity[field];

        if (!value) {
          continue;
        }

        fieldbits |= (1 << i);
        values.push(value);
      }

      const bitsWriter = SV.server.clientdataFieldsBitsWriter;
      console.assert(bitsWriter, 'clientdataFieldsBitsWriter must be configured when CAP_CLIENTDATA_DYNAMIC is enabled');
      if (bitsWriter) {
        bitsWriter(destination, fieldbits);
        MSG.WriteSerializables(destination, values);
      }
    }

    return true;
  }

  /**
   * Sends a datagram to a specific client.
   * @param {import('./Client.mjs').ServerClient} client client to send to
   * @returns {boolean} success
   */
  sendClientDatagram(client) {
    const msg = new SzBuffer(16000, 'SV.SendClientDatagram');
    MSG.WriteByte(msg, Protocol.svc.time);
    MSG.WriteFloat(msg, SV.server.time);

    let changes = 0;

    if (Host.realtime - client.last_ping_update >= 1) {
      for (let i = 0; i < SV.svs.clients.length; i++) {
        const pingClient = SV.svs.clients[i];

        if (!pingClient.active) {
          continue;
        }

        MSG.WriteByte(msg, Protocol.svc.updatepings);
        MSG.WriteByte(msg, i);
        MSG.WriteShort(msg, Math.max(0, Math.min(Math.round(pingClient.ping * 10), 30000)));

        changes |= 1;
      }

      client.last_ping_update = Host.realtime;
    }

    if (client.expedited_message.cursize > 0 && (msg.cursize + client.expedited_message.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(client.expedited_message.data), client.expedited_message.cursize);
      client.expedited_message.clear();
      changes |= 1;
    }

    if ((msg.cursize + SV.server.expedited_datagram.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(SV.server.expedited_datagram.data), SV.server.expedited_datagram.cursize);
      changes |= 1;
    }

    changes |= this.writeClientdataToMessage(client.edict, msg) ? 1 : 0;
    changes |= this.writeEntitiesToClient(client.edict, msg) ? 1 : 0;

    if (!client.spawned) {
      Con.DPrint('SV.SendClientDatagram: not spawned\n');
      return true;
    }

    if (!changes) {
      Con.DPrint('SV.SendClientDatagram: no changes for client ' + client.num + '\n');
    }

    client.last_update = SV.server.time;

    if ((msg.cursize + SV.server.datagram.cursize) < msg.data.byteLength) {
      msg.write(new Uint8Array(SV.server.datagram.data), SV.server.datagram.cursize);
    }

    if (NET.SendUnreliableMessage(client.netconnection, msg) === -1) {
      Host.DropClient(client, true, 'Connectivity issues');
      return false;
    }
    return true;
  }

  updateToReliableMessages() {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const currentClient = SV.svs.clients[i];
      const frags = currentClient.edict.entity ? currentClient.edict.entity.frags | 0 : 0;
      if (currentClient.old_frags === frags) {
        continue;
      }
      for (let j = 0; j < SV.svs.maxclients; j++) {
        const client = SV.svs.clients[j];
        if (!client.active) {
          continue;
        }
        MSG.WriteByte(client.message, Protocol.svc.updatefrags);
        MSG.WriteByte(client.message, i);
        MSG.WriteShort(client.message, frags);
      }
      currentClient.old_frags = frags;
    }

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (client.active) {
        client.message.write(new Uint8Array(SV.server.reliable_datagram.data), SV.server.reliable_datagram.cursize);
      }
    }

    SV.server.reliable_datagram.clear();
  }

  sendClientMessages() {
    this.updateToReliableMessages();

    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (!client.active) {
        continue;
      }
      if (client.spawned) {
        if (!this.sendClientDatagram(client)) {
          continue;
        }
      }
      if (client.message.overflowed) {
        Host.DropClient(client, true, 'Connectivity issues, too many messages');
        client.message.overflowed = false;
        continue;
      }
      if (client.dropasap) {
        if (NET.CanSendMessage(client.netconnection)) {
          Host.DropClient(client, false, 'Connectivity issues, ASAP drop requested');
        }
      } else if (client.message.cursize !== 0) {
        if (!NET.CanSendMessage(client.netconnection)) {
          continue;
        }
        if (NET.SendMessage(client.netconnection, client.message) === -1) {
          Host.DropClient(client, true, 'Connectivity issues, failed to send message');
        }
        client.message.clear();
        client.sendsignon = false;
      }
    }

    for (let i = 1; i < SV.server.num_edicts; i++) {
      if (SV.server.edicts[i].isFree()) {
        continue;
      }

      SV.server.edicts[i].entity.effects &= ~Defs.effect.EF_MUZZLEFLASH;
    }
  }
};
