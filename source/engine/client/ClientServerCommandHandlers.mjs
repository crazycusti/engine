import MSG from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from '../common/Def.mjs';
import Cmd from '../common/Cmd.mjs';
import { HostError } from '../common/Errors.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';
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

let { Con, SCR, S, R, V, Host, SV, NET } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  SCR = registry.SCR;
  S = registry.S;
  R = registry.R;
  V = registry.V;
  Host = registry.Host;
  SV = registry.SV;
  NET = registry.NET;
});

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
  ctx.CL.ParseServerData();
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
  ctx.CL.ParseLightstylePacket();
}

/**
 * Triggers spatialised sounds for the given entity/channel tuple.
 * @param {ServerCommandContext} ctx Shared handler context.
 * @returns {void}
 */
function handleSound(ctx) {
  ctx.CL.ParseStartSoundPacket();
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
  ctx.CL.ParseStaticEntity();
}

/**
 * Parses temporary entities such as explosions and beam effects.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleTempEntity(ctx) {
  ctx.CL.ParseTemporaryEntity();
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
  ctx.CL.ParseStaticSound();
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
  ctx.CL.ParsePmovevars();
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
  ctx.CL.ParsePacketEntities();
}

/**
 * Applies server-sent configuration variables.
 * @param {ServerCommandContext} ctx Shared handler context.
 */
function handleCvar(ctx) {
  ctx.CL.ParseServerCvars();
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

  if (CL._processingServerDataState === 1) {
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

  if (CL._processingServerDataState === 3) {
    CL._processingServerDataState = 0;
  } else {
    CL._lastServerMessages = [];
    MSG.BeginReading();
  }

  while (CL.cls.state > CL.active.disconnected) {
    if (CL._processingServerDataState > 0) {
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

    CL._lastServerMessages.push(CL.svc_strings[cmd]);
    if (CL._lastServerMessages.length > 10) {
      CL._lastServerMessages.shift();
    }

    const handler = serverCommandHandlers.get(cmd);

    if (handler) {
      handler({ CL, parser, updateEntities });
      continue;
    }

    CL._lastServerMessages.pop();
    CL.PrintLastServerMessages();
    throw new HostError('CL.ParseServerMessage: Illegible server message\n');
  }

  if (entitiesReceived > 0) {
    if (CL.cls.signon === 3) {
      CL.cls.signon = 4;
      CL.SignonReply();
    }
  }

  CL.SetSolidEntities();
}
