import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import Cmd from '../common/Cmd.mjs';
import { HostError } from '../common/Errors.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';
import Vector from '../../shared/Vector.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';
import { eventBus, registry } from '../registry.mjs';

/** @typedef {typeof import('./CL.mjs').default} ClientLayer */
/** @typedef {import('./ClientMessages.mjs').ClientMessages} ClientMessages */

/**
 * Carries everything individual server-command handlers need to mutate client state.
 * @typedef {object} ServerCommandContext
 * @property {ClientLayer} CL Client facade coordinating shared state.
 * @property {ClientMessages} parser Message parser bound to the active client.
 * @property {() => void} updateEntities Callback tracking how many entity deltas arrived.
 */

/**
 * Function signature shared by all server command handlers.
 * @callback ServerCommandHandler
 * @param {ServerCommandContext} ctx Shared handler context.
 */

let { Con, SCR, S, R, V, Host, SV, NET, Mod, PR, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  SCR = registry.SCR;
  S = registry.S;
  R = registry.R;
  V = registry.V;
  Host = registry.Host;
  SV = registry.SV;
  NET = registry.NET;
  Mod = registry.Mod;
  PR = registry.PR;
  COM = registry.COM;
});

/**
 * Creates a score slot wrapper that keeps the entity getter wired back to the client state.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 * @param {number} index Player slot index.
 * @returns {{name: string, entertime: number, frags: number, colors: number, ping: number, readonly isActive: boolean, readonly entity: import('./ClientEntities.mjs').ClientEdict}} Scoreboard slot view.
 */
function createScoreSlot(CL, index) {
  return {
    name: '',
    entertime: 0.0,
    frags: 0,
    colors: 0,
    ping: 0,
    get isActive() {
      return this.name !== '';
    },
    get entity() {
      return CL.state.clientEntities.getEntity(index + 1);
    },
  };
}

/**
 * Parses the serverdata payload and prepares the client for the new map.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseServerData(CL) {
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = MSG.ReadByte();

  if (version !== Protocol.version) {
    throw new HostError('Server returned protocol version ' + version + ', not ' + Protocol.version + '\n');
  }

  const isHavingClientQuakeJS = MSG.ReadByte() === 1;

  if (isHavingClientQuakeJS) {
    Con.DPrint('Server is running QuakeJS with ClientGameAPI provided.\n');

    if (!PR.QuakeJS?.ClientGameAPI) {
      throw new HostError('Server is running QuakeJS with client code provided,\nbut client code is not imported.\nTry clearing your cache and connect again.');
    }

    const name = MSG.ReadString();
    const author = MSG.ReadString();
    const serverVersion = [MSG.ReadByte(), MSG.ReadByte(), MSG.ReadByte()];

    const identification = PR.QuakeJS.identification;

    if (identification.name !== name || identification.author !== author) {
      throw new HostError(`Cannot connect, game mismatch.\nThe server is running ${name}\nand you are running ${identification.name}.`);
    }

    if (!PR.QuakeJS.ClientGameAPI.IsServerCompatible(serverVersion)) {
      throw new HostError(`Server (v${serverVersion.join('.')} ) is not compatible. You are running v${identification.version.join('.')}\nTry clearing your cache and connect again.`);
    }

    CL.state.gameAPI = new PR.QuakeJS.ClientGameAPI(ClientEngineAPI);
  } else {
    const game = MSG.ReadString();

    if (game !== COM.game) {
      throw new HostError('Server is running game ' + game + ', not ' + COM.game + '\n');
    }

    document.title = `${game} on ${Def.productName} (${Def.productVersion})`;
  }

  CL.state.maxclients = MSG.ReadByte();
  if ((CL.state.maxclients <= 0) || (CL.state.maxclients > 32)) {
    throw new HostError('Bad maxclients (' + CL.state.maxclients + ') from server!');
  }

  CL.state.scores.length = 0;

  for (let i = 0; i < CL.state.maxclients; i++) {
    CL.state.scores[i] = createScoreSlot(CL, i);
  }

  CL.state.levelname = MSG.ReadString();

  parsePmovevars(CL);

  Con.Print('\n\n\x1d\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1e\x1f\n\n');
  Con.Print('\x02' + CL.state.levelname + '\n\n');

  CL.SetConnectingStep(15, 'Received server info');

  let str;
  let nummodels; const model_precache = [];
  for (nummodels = 1; ; nummodels++) {
    str = MSG.ReadString();
    if (str.length === 0) {
      break;
    }
    model_precache[nummodels] = str;
  }
  let numsounds; const sound_precache = [];
  for (numsounds = 1; ; numsounds++) {
    str = MSG.ReadString();
    if (str.length === 0) {
      break;
    }
    sound_precache[numsounds] = str;
  }

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_DYNAMIC)) {
    const clientdataFields = [];

    while (true) {
      const fields = MSG.ReadString();
      if (fields === '') {
        break;
      }
      clientdataFields.push(fields);
    }

    CL.state.clientMessages.clientdataFields = clientdataFields;
  }

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_ENTITY_EXTENDED)) {
    while (true) {
      const classname = MSG.ReadString();

      if (classname === '') {
        break;
      }

      const fields = [];

      while (true) {
        const field = MSG.ReadString();

        if (field === '') {
          break;
        }

        fields.push(field);
      }

      let bitsReader = null;

      console.assert(fields.length <= 32, 'entity fields must not have more than 32 fields');

      if (fields.length <= 8) {
        bitsReader = MSG.ReadByte;
      } else if (fields.length <= 16) {
        bitsReader = MSG.ReadShort;
      } else {
        bitsReader = MSG.ReadLong;
      }

      if (fields.length > 0) {
        CL.state.clientEntityFields[classname] = { fields, bitsReader };
      }
    }
  }

  CL.connection.processingServerDataState = 1;

  (async () => {
    const models = [null];
    const sounds = [null];

    models[1] = await Mod.ForNameAsync(model_precache[1]);
    nummodels--;

    while (nummodels > 0) {
      const chunksize = Math.min(nummodels, 10);
      nummodels -= chunksize;

      CL.SetConnectingStep(25 + (models.length / model_precache.length) * 30, 'Loading models');
      models.push(...await Promise.all(model_precache.slice(models.length, models.length + chunksize).map((m) => Mod.ForNameAsync(m))));

      CL.SendCmd();
    }

    while (numsounds > 0) {
      const chunksize = Math.min(numsounds, 10);
      numsounds -= chunksize;
      CL.SetConnectingStep(55 + (sounds.length / sound_precache.length) * 30, 'Loading sounds');
      sounds.push(...await Promise.all(sound_precache.slice(sounds.length, sounds.length + chunksize).map((s) => S.PrecacheSoundAsync(s))));

      CL.SendCmd();
    }

    return { models, sounds };
  })().then(({ models, sounds }) => {
    CL.state.model_precache.length = 0;
    CL.state.sound_precache.length = 0;

    CL.state.model_precache.push(...models);
    CL.state.sound_precache.push(...sounds);

  CL.connection.processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1];
    CL.pmove.setWorldmodel(CL.state.worldmodel);
  const ent = CL.state.clientEntities.getEntity(0);
    ent.classname = 'worldspawn';
    ent.loadHandler();
    ent.model = CL.state.worldmodel;
    ent.spawn();
    CL.SetConnectingStep(85, 'Preparing map');
    CL.SendCmd();
    R.NewMap();
    CL.SendCmd();
    Host.noclip_anglehack = false;
    if (CL.state.gameAPI) {
      CL.state.gameAPI.init();
      if (CL.state.loadClientData && CL.state.loadClientData[0]) {
        CL.state.gameAPI.loadGame(CL.state.loadClientData[0]);
      }
    }
    if (CL.state.loadClientData && CL.state.loadClientData[1]) {
      R.DeserializeParticles(CL.state.loadClientData[1]);
    }
    CL.state.loadClientData = null;
  });
}

/**
 * Reads pmove configuration values from the network stream.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parsePmovevars(CL) {
  const movevars = CL.pmove.movevars;
  movevars.gravity = MSG.ReadFloat();
  movevars.stopspeed = MSG.ReadFloat();
  movevars.maxspeed = MSG.ReadFloat();
  movevars.spectatormaxspeed = MSG.ReadFloat();
  movevars.accelerate = MSG.ReadFloat();
  movevars.airaccelerate = MSG.ReadFloat();
  movevars.wateraccelerate = MSG.ReadFloat();
  movevars.friction = MSG.ReadFloat();
  movevars.waterfriction = MSG.ReadFloat();
  movevars.entgravity = MSG.ReadFloat();

  Con.DPrint('Reconfigured Pmovevars.\n');
}

/**
 * Parses a lightstyle definition.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseLightstylePacket(CL) {
  const index = MSG.ReadByte();
  if (index >= Def.limits.lightstyles) {
    throw new HostError('svc_lightstyle > MAX_LIGHTSTYLES');
  }

  CL.state.clientEntities.setLightstyle(index, MSG.ReadString());
}

/**
 * Parses a spatialized sound start request.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseStartSoundPacket(CL) {
  const fieldMask = MSG.ReadByte();
  const volume = ((fieldMask & 1) !== 0) ? MSG.ReadByte() : 255;
  const attenuation = ((fieldMask & 2) !== 0) ? MSG.ReadByte() * 0.015625 : 1.0;
  const entchannel = MSG.ReadShort();
  const soundNum = MSG.ReadByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = MSG.ReadCoordVector();

  S.StartSound(ent, channel, CL.state.sound_precache[soundNum], pos, volume / 255.0, attenuation);
}

/**
 * Parses a static entity definition.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseStaticEntity(CL) {
  const ent = CL.state.clientEntities.allocateClientEntity(MSG.ReadString());
  ent.model = CL.state.model_precache[MSG.ReadByte()];
  ent.frame = MSG.ReadByte();
  ent.colormap = MSG.ReadByte();
  ent.skinnum = MSG.ReadByte();
  ent.effects = MSG.ReadByte();
  ent.solid = MSG.ReadByte();
  ent.angles.set(MSG.ReadAngleVector());
  ent.setOrigin(MSG.ReadCoordVector());
  ent.spawn();
}

/**
 * Parses a static ambient sound definition.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseStaticSound(CL) {
  const org = MSG.ReadCoordVector();
  const soundId = MSG.ReadByte();
  const vol = MSG.ReadByte();
  const attn = MSG.ReadByte();
  S.StaticSound(CL.state.sound_precache[soundId], org, vol / 255.0, attn);
}

/**
 * Applies server cvar updates.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseServerCvars(CL) {
  let count = MSG.ReadByte();

  while (count-- > 0) {
    const name = MSG.ReadString();
    const value = MSG.ReadString();

    CL.cls.serverInfo[name] = value;

    if (CL.cls.signon === 4) {
      Con.Print(`"${name}" changed to "${value}"\n`);
      eventBus.publish('client.server-info.updated', name, value);
    }

    if (name === 'sv_cheats' && value === '0') {
      CL.ResetCheatCvars();
    }
  }
}

/**
 * Parses beam-style temporary entities.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 * @param {import('../common/model/BaseModel.mjs').BaseModel} model Model to attach to the beam.
 */
function parseBeam(CL, model) {
  const ent = MSG.ReadShort();
  const start = MSG.ReadCoordVector();
  const end = MSG.ReadCoordVector();
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = CL.state.clientEntities.beams[i];
    if (beam.entity !== ent) {
      continue;
    }
    beam.model = model;
    beam.endtime = CL.state.time + 0.2;
    beam.start = start.copy();
    beam.end = end.copy();
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const beam = CL.state.clientEntities.beams[i];
    if ((beam.model !== null) && (beam.endtime >= CL.state.time)) {
      continue;
    }
    beam.entity = ent;
    beam.model = model;
    beam.endtime = CL.state.time + 0.2;
    beam.start = start.copy();
    beam.end = end.copy();
    return;
  }
  Con.Print('beam list overflow!\n');
}

/**
 * Decodes temporary entities (explosions, splashes, etc.).
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parseTemporaryEntity(CL) {
  const type = MSG.ReadByte();

  switch (type) {
    case Protocol.te.lightning1:
      parseBeam(CL, Mod.ForName('progs/bolt.mdl', true));
      return;
    case Protocol.te.lightning2:
      parseBeam(CL, Mod.ForName('progs/bolt2.mdl', true));
      return;
    case Protocol.te.lightning3:
      parseBeam(CL, Mod.ForName('progs/bolt3.mdl', true));
      return;
    case Protocol.te.beam:
      parseBeam(CL, Mod.ForName('progs/beam.mdl', true));
      return;
  }

  const pos = MSG.ReadCoordVector();
  const sounds = CL.state.clientEntities.tempEntitySounds;

  switch (type) {
    case Protocol.te.wizspike:
      R.RunParticleEffect(pos, Vector.origin, 20, 20);
      S.StartSound(-1, 0, sounds.wizhit, pos, 1.0, 1.0);
      return;
    case Protocol.te.knightspike:
      R.RunParticleEffect(pos, Vector.origin, 226, 20);
      S.StartSound(-1, 0, sounds.knighthit, pos, 1.0, 1.0);
      return;
    case Protocol.te.spike:
      R.RunParticleEffect(pos, Vector.origin, 0, 10);
      return;
    case Protocol.te.superspike:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.gunshot:
      R.RunParticleEffect(pos, Vector.origin, 0, 20);
      return;
    case Protocol.te.explosion: {
      R.ParticleExplosion(pos);
      const dl = CL.state.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = CL.state.time + 0.5;
      dl.decay = 300.0;
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.tarexplosion:
      R.BlobExplosion(pos);
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      return;
    case Protocol.te.lavasplash:
      R.LavaSplash(pos);
      return;
    case Protocol.te.teleport:
      R.TeleportSplash(pos);
      return;
    case Protocol.te.explosion2: {
      const colorStart = MSG.ReadByte();
      const colorLength = MSG.ReadByte();
      R.ParticleExplosion2(pos, colorStart, colorLength);
      const dl = CL.state.clientEntities.allocateDynamicLight(0);
      dl.origin = pos.copy();
      dl.radius = 350.0;
      dl.die = CL.state.time + 0.5;
      dl.decay = 300.0;
      S.StartSound(-1, 0, sounds.explosion, pos, 1.0, 1.0);
      }
      return;
  }

  throw new Error(`CL.ParseTEnt: bad type ${type}`);
}

/**
 * Applies entity deltas for the current frame.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
function parsePacketEntities(CL) {
  while (true) {
    const edictNum = MSG.ReadShort();

    if (edictNum === 0) {
      break;
    }

    const clent = CL.state.clientEntities.getEntity(edictNum);

    const bits = MSG.ReadShort();

    if (bits & Protocol.u.classname) {
      clent.classname = MSG.ReadString();
      clent.loadHandler();
      clent.spawn();
    }

    if (bits & Protocol.u.free) {
      clent.free = MSG.ReadByte() !== 0;
    }

    if (bits & Protocol.u.frame) {
      clent.framePrevious = clent.frame;
      clent.frame = MSG.ReadByte();
    }

    if (bits & Protocol.u.model) {
      const modelindex = MSG.ReadByte();
      clent.model = CL.state.model_precache[modelindex] || null;

      clent.framePrevious = null;
      clent.frameTime = 0.0;

      if (clent.model) {
        clent.syncbase = clent.model.random ? Math.random() : 0.0;
      }
    }

    if (bits & Protocol.u.colormap) {
      clent.colormap = MSG.ReadByte();
    }

    if (bits & Protocol.u.skin) {
      clent.skinnum = MSG.ReadByte();
    }

    if (bits & Protocol.u.effects) {
      clent.effects = MSG.ReadByte();
    }

    if (bits & Protocol.u.solid) {
      clent.solid = MSG.ReadByte();
    }

    const origin = clent.msg_origins[0];
    const angles = clent.msg_angles[0];
    const velocity = clent.msg_velocity[0];

    for (let i = 0; i < 3; i++) {
      if (bits & (Protocol.u.origin1 << i)) {
        origin[i] = MSG.ReadCoord();
      }

      if (bits & (Protocol.u.angle1 << i)) {
        angles[i] = MSG.ReadAngle();
        velocity[i] = MSG.ReadCoord();
      }
    }

    if (bits & Protocol.u.size) {
      clent.maxs.set(MSG.ReadCoordVector());
      clent.mins.set(MSG.ReadCoordVector());
    }

    if (bits & Protocol.u.nextthink) {
      clent.nextthink = CL.state.clientMessages.mtime[0] + MSG.ReadByte() / 255.0;
    }

    if (CL.gameCapabilities.includes(gameCapabilities.CAP_ENTITY_EXTENDED)) {
      const clientEntityFields = CL.state.clientEntityFields[clent.classname];
      if (clientEntityFields) {
        const fieldbits = clientEntityFields.bitsReader();

        if (fieldbits > 0) {
          const fields = [];

          for (let i = 0; i < clientEntityFields.fields.length; i++) {
            const field = clientEntityFields.fields[i];
            if ((fieldbits & (1 << i)) !== 0) {
              fields.push(field);
            }
          }

          let counter = 0;

          const values = MSG.ReadSerializablesOnClient();

          for (const value of values) {
            clent.extended[fields[counter++]] = value;
          }
        }
      }
    }

    const time = CL.state.clientMessages.mtime[0];

    if (clent.nextthink > time) {
      if (!clent.msg_origins[0].equals(clent.origin)) {
        clent.originTime = time;
        clent.originPrevious.set(clent.origin);
      }

      if (!clent.msg_angles[0].equals(clent.angles)) {
        clent.anglesTime = time;
        clent.anglesPrevious.set(clent.angles);
      }

      if (!clent.msg_velocity[0].equals(clent.velocity)) {
        clent.velocityTime = time;
        clent.velocityPrevious.set(clent.velocity);
      }

      if (bits & Protocol.u.frame) {
        clent.frameTime = time;
      }
    }

    clent.updatecount++;

    clent.msg_origins[1].set(clent.msg_origins[0]);
    clent.msg_angles[1].set(clent.msg_angles[0]);
    clent.msg_velocity[1].set(clent.msg_velocity[0]);

    if (clent.free) {
      clent.freeEdict();
    }
  }
}

/**
 * Handles svc_nop – intentionally does nothing.
 */
function handleNop() {}

/**
 * Handles svc_time by forwarding to the high-level parser.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleTime(ctx) {
  ctx.parser.parseTime();
}

/**
 * Handles svc_clientdata and populates the incremental client snapshot.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleClientData(ctx) {
  ctx.parser.parseClient();
}

/**
 * Validates the negotiated protocol version and aborts if mismatched.
 */
function handleVersion() {
  const protocol = MSG.ReadLong();
  if (protocol !== Protocol.version) {
    throw new HostError('CL.ParseServerMessage: Server is protocol ' + protocol + ' instead of ' + Protocol.version + '\n');
  }
}

/**
 * Processes svc_disconnect by surfacing the server-supplied message.
 */
function handleDisconnect() {
  Host.EndGame(`Server disconnected: ${MSG.ReadString()}`);
}

/**
 * Routes svc_print text through the console.
 */
function handlePrint() {
  Con.Print(MSG.ReadString());
}

/**
 * Displays server-sent center print text and mirrors it to the console.
 */
function handleCenterPrint() {
  const string = MSG.ReadString();
  SCR.CenterPrint(string);
  Con.Print(string + '\n');
}

/**
 * Handles chat payloads and appends them to the client chat log.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleChatMessage(ctx) {
  ctx.CL.AppendChatMessage(MSG.ReadString(), MSG.ReadString(), MSG.ReadByte() === 1);
}

/**
 * Concatenates svc_stufftext into the pending console buffer.
 */
function handleStuffText() {
  Cmd.text += MSG.ReadString();
}

/**
 * Delegates svc_damage to the view module so it can spawn impacts.
 */
function handleDamage() {
  V.ParseDamage();
}

/**
 * Parses svc_serverdata and reinitialises renderer state.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleServerData(ctx) {
  parseServerData(ctx.CL);
  SCR.recalc_refdef = true;
}

/**
 * Processes map transitions and resets client signon state.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleChangeLevel(ctx) {
  const mapname = MSG.ReadString();
  ctx.CL.SetConnectingStep(5, 'Changing level to ' + mapname);
  ctx.CL.cls.signon = 0;
  ctx.CL.cls.changelevel = true;
}

/**
 * Updates the authoritative view angles of the local player.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSetAngle(ctx) {
  ctx.CL.state.viewangles.set(MSG.ReadAngleVector());
}

/**
 * Selects the entity the client should render from.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSetView(ctx) {
  ctx.CL.state.viewentity = MSG.ReadShort();
}

/**
 * Updates lightstyle definitions used for dynamic lighting.
 * @param {ServerCommandContext} ctx Shared handler context.
 * @returns {void}
 */
function handleLightStyle(ctx) {
  parseLightstylePacket(ctx.CL);
}

/**
 * Triggers spatialised sounds for the given entity/channel tuple.
 * @param {ServerCommandContext} ctx Shared handler context.
 * @returns {void}
 */
function handleSound(ctx) {
  parseStartSoundPacket(ctx.CL);
}

/**
 * Stops a currently playing sound for an entity/channel pair.
 */
function handleStopSound() {
  const value = MSG.ReadShort();
  S.StopSound(value >> 3, value & 7);
}

/**
 * Updates the server-specified sound precache entry.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleLoadSound(ctx) {
  const index = MSG.ReadByte();
  ctx.CL.state.sound_precache[index] = S.PrecacheSound(MSG.ReadString());
  Con.DPrint(`CL.ParseServerMessage: load sound "${ctx.CL.state.sound_precache[index].name}" (${ctx.CL.state.sound_precache[index].state}) on slot ${index}\n`);
}

/**
 * Mirrors scoreboard name updates and broadcasts change events.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleUpdateName(ctx) {
  const slot = MSG.ReadByte();
  if (slot >= ctx.CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatename > MAX_SCOREBOARD');
  }
  const newName = MSG.ReadString();
  if (ctx.CL.state.scores[slot].name !== '' && newName !== '' && newName !== ctx.CL.state.scores[slot].name) {
    Con.Print(`${ctx.CL.state.scores[slot].name} renamed to ${newName}\n`);
    eventBus.publish('client.players.name-changed', slot, ctx.CL.state.scores[slot].name, newName);
  }
  ctx.CL.state.scores[slot].name = newName;
}

/**
 * Updates frag counts for a player and notifies listeners.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleUpdateFrags(ctx) {
  const slot = MSG.ReadByte();
  if (slot >= ctx.CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatefrags > MAX_SCOREBOARD');
  }
  ctx.CL.state.scores[slot].frags = MSG.ReadShort();
  eventBus.publish('client.players.frags-updated', slot, ctx.CL.state.scores[slot].frags);
}

/**
 * Updates color indices for a player and notifies listeners.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleUpdateColors(ctx) {
  const slot = MSG.ReadByte();
  if (slot >= ctx.CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatecolors > MAX_SCOREBOARD');
  }
  ctx.CL.state.scores[slot].colors = MSG.ReadByte();
  eventBus.publish('client.players.colors-updated', slot, ctx.CL.state.scores[slot].colors);
}

/**
 * Updates ping information for a player.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleUpdatePings(ctx) {
  const slot = MSG.ReadByte();
  if (slot >= ctx.CL.state.maxclients) {
    throw new HostError('CL.ParseServerMessage: svc_updatepings > MAX_SCOREBOARD');
  }
  ctx.CL.state.scores[slot].ping = MSG.ReadShort() / 10;
}

/**
 * Spawns particle effects from svc_particle payloads.
 */
function handleParticle() {
  R.ParseParticleEffect();
}

/**
 * Placeholder for svc_spawnbaseline which is not implemented yet.
 */
function handleSpawnBaseline() {
  console.assert(false, 'spawnbaseline is not implemented');
}

/**
 * Adds a static entity to the scene.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSpawnStatic(ctx) {
  parseStaticEntity(ctx.CL);
}

/**
 * Parses temporary entities such as explosions and beam effects.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleTempEntity(ctx) {
  parseTemporaryEntity(ctx.CL);
}

/**
 * Toggles the paused state and publishes pause events.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSetPause(ctx) {
  ctx.CL.state.paused = MSG.ReadByte() !== 0;
  if (ctx.CL.state.paused) {
    eventBus.publish('client.paused');
  } else {
    eventBus.publish('client.unpaused');
  }
}

/**
 * Tracks the server signon phase and advances the handshake.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSignonNum(ctx) {
  const signon = MSG.ReadByte();
  if (signon <= ctx.CL.cls.signon) {
    throw new HostError('Received signon ' + signon + ' when at ' + ctx.CL.cls.signon);
  }
  console.assert(signon >= 0 && signon <= 4, 'signon must be in range 0-4');
  ctx.CL.cls.signon = /** @type {0|1|2|3|4} */ (signon);
  Con.DPrint(`Received signon ${signon}\n`);
  ctx.CL.SignonReply();
}

/**
 * Increments the monster kill statistic.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleKilledMonster(ctx) {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'killedmonster requires CAP_LEGACY_UPDATESTAT');
  ctx.CL.state.stats[Def.stat.monsters]++;
}

/**
 * Increments the secret discovery statistic.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleFoundSecret(ctx) {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'foundsecret requires CAP_LEGACY_UPDATESTAT');
  ctx.CL.state.stats[Def.stat.secrets]++;
}

/**
 * Updates an individual HUD/statistic entry.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleUpdateStat(ctx) {
  console.assert(SV.server.gameCapabilities.includes(gameCapabilities.CAP_CLIENTDATA_UPDATESTAT), 'updatestat requires CAP_LEGACY_UPDATESTAT');
  const index = MSG.ReadByte();
  console.assert(index >= 0 && index < ctx.CL.state.stats.length, 'updatestat must be in range');
  ctx.CL.state.stats[index] = MSG.ReadLong();
}

/**
 * Queues a static ambient sound.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleSpawnStaticSound(ctx) {
  parseStaticSound(ctx.CL);
}

/**
 * Starts or overrides the current CD track.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleCdTrack(ctx) {
  ctx.CL.state.cdtrack = MSG.ReadByte();
  MSG.ReadByte();
  if (((ctx.CL.cls.demoplayback === true) || (ctx.CL.cls.demorecording === true)) && (ctx.CL.cls.forcetrack !== -1)) {
    eventBus.publish('client.cdtrack', ctx.CL.cls.forcetrack);
  } else {
    eventBus.publish('client.cdtrack', ctx.CL.state.cdtrack);
  }
}

/**
 * Enters the intermission state.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleIntermission(ctx) {
  ctx.CL.state.intermission = 1;
  ctx.CL.state.completed_time = ctx.CL.state.time;
  SCR.recalc_refdef = true;
}

/**
 * Displays the finale text block.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleFinale(ctx) {
  ctx.CL.state.intermission = 2;
  ctx.CL.state.completed_time = ctx.CL.state.time;
  SCR.recalc_refdef = true;
  SCR.CenterPrint(MSG.ReadString());
}

/**
 * Plays a cutscene by showing a center print.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleCutscene(ctx) {
  ctx.CL.state.intermission = 3;
  ctx.CL.state.completed_time = ctx.CL.state.time;
  SCR.recalc_refdef = true;
  SCR.CenterPrint(MSG.ReadString());
}

/**
 * Calls the help command when the server requests the sell screen.
 */
function handleSellScreen() {
  Cmd.ExecuteString('help');
}

/**
 * Updates client-only movement variables such as gravity.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handlePmoveVars(ctx) {
  parsePmovevars(ctx.CL);
}

/**
 * Updates player-specific interpolation data.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handlePlayerInfo(ctx) {
  ctx.parser.parsePlayer();
}

/**
 * Applies delta compressed packet entities.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleDeltaPacketEntities(ctx) {
  ctx.updateEntities();
  parsePacketEntities(ctx.CL);
}

/**
 * Applies server-sent configuration variables.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleCvar(ctx) {
  parseServerCvars(ctx.CL);
}

/**
 * Passes custom client events to the game API.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleClientEvent(ctx) {
  console.assert(ctx.CL.state.gameAPI !== null, 'ClientGameAPI required');
  ctx.CL.state.clientMessages.parseClientEvent();
}

/** @type {Map<number, ServerCommandHandler>} */
const serverCommandHandlers = new Map([
  [Protocol.svc.nop, handleNop],
  [Protocol.svc.time, handleTime],
  [Protocol.svc.clientdata, handleClientData],
  [Protocol.svc.version, handleVersion],
  [Protocol.svc.disconnect, handleDisconnect],
  [Protocol.svc.print, handlePrint],
  [Protocol.svc.centerprint, handleCenterPrint],
  [Protocol.svc.chatmsg, handleChatMessage],
  [Protocol.svc.stufftext, handleStuffText],
  [Protocol.svc.damage, handleDamage],
  [Protocol.svc.serverdata, handleServerData],
  [Protocol.svc.changelevel, handleChangeLevel],
  [Protocol.svc.setangle, handleSetAngle],
  [Protocol.svc.setview, handleSetView],
  [Protocol.svc.lightstyle, handleLightStyle],
  [Protocol.svc.sound, handleSound],
  [Protocol.svc.stopsound, handleStopSound],
  [Protocol.svc.loadsound, handleLoadSound],
  [Protocol.svc.updatename, handleUpdateName],
  [Protocol.svc.updatefrags, handleUpdateFrags],
  [Protocol.svc.updatecolors, handleUpdateColors],
  [Protocol.svc.updatepings, handleUpdatePings],
  [Protocol.svc.particle, handleParticle],
  [Protocol.svc.spawnbaseline, handleSpawnBaseline],
  [Protocol.svc.spawnstatic, handleSpawnStatic],
  [Protocol.svc.temp_entity, handleTempEntity],
  [Protocol.svc.setpause, handleSetPause],
  [Protocol.svc.signonnum, handleSignonNum],
  [Protocol.svc.killedmonster, handleKilledMonster],
  [Protocol.svc.foundsecret, handleFoundSecret],
  [Protocol.svc.updatestat, handleUpdateStat],
  [Protocol.svc.spawnstaticsound, handleSpawnStaticSound],
  [Protocol.svc.cdtrack, handleCdTrack],
  [Protocol.svc.intermission, handleIntermission],
  [Protocol.svc.finale, handleFinale],
  [Protocol.svc.cutscene, handleCutscene],
  [Protocol.svc.sellscreen, handleSellScreen],
  [Protocol.svc.pmovevars, handlePmoveVars],
  [Protocol.svc.playerinfo, handlePlayerInfo],
  [Protocol.svc.deltapacketentities, handleDeltaPacketEntities],
  [Protocol.svc.cvar, handleCvar],
  [Protocol.svc.clientevent, handleClientEvent],
]);

/**
 * Dispatches one in-flight server message through dedicated opcode handlers.
 * @param {ClientLayer} CL Client singleton coordinating shared state.
 */
export function parseServerMessage(CL) {
  if (CL.shownet.value === 1) {
    Con.Print(NET.message.cursize + ' ');
  } else if (CL.shownet.value === 2) {
    Con.Print('------------------\n');
  }

  CL.state.onground = false;

  if (CL.connection.processingServerDataState === 1) {
    return;
  }

  const parser = CL.state.clientMessages;
  let entitiesReceived = 0;
  /**
   * Tracks how many entity deltas were parsed in this network frame.
   */
  const updateEntities = () => {
    entitiesReceived++;
  };

  if (CL.connection.processingServerDataState === 3) {
    CL.connection.processingServerDataState = 0;
  } else {
    CL.connection.lastServerMessages.length = 0;
    MSG.BeginReading();
  }

  while (CL.cls.state > CL.active.disconnected) {
    if (CL.connection.processingServerDataState > 0) {
      break;
    }

    if (MSG.badread === true) {
      CL.PrintLastServerMessages();
      MSG.PrintLastRead();
      throw new HostError('CL.ParseServerMessage: Bad server message');
    }

    const cmd = MSG.ReadByte();

    if (cmd === -1) {
      break;
    }

    CL.connection.lastServerMessages.push(CL.svc_strings[cmd]);
    if (CL.connection.lastServerMessages.length > 10) {
      CL.connection.lastServerMessages.shift();
    }

    const handler = serverCommandHandlers.get(cmd);

    if (handler) {
      handler({ CL, parser, updateEntities });
      continue;
    }

    CL.connection.lastServerMessages.pop();
    CL.PrintLastServerMessages();
    throw new HostError('CL.ParseServerMessage: Illegible server message\n');
  }

  if (entitiesReceived > 0) {
    if (CL.cls.signon === 3) {
      CL.cls.signon = 4;
      CL.SignonReply();
    }
  }

  CL.state.clientEntities.setSolidEntities(CL.pmove);
}
