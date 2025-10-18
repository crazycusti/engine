import MSG from '../network/MSG.mjs';
import Q from '../../shared/Q.mjs';
import * as Def from '../common/Def.mjs';
import * as Protocol from '../network/Protocol.mjs';
import Vector from '../../shared/Vector.mjs';
import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { MoveVars, Pmove, PmovePlayer } from '../common/Pmove.mjs';
import { eventBus, registry } from '../registry.mjs';
import { ClientEngineAPI } from '../common/GameAPIs.mjs';
import { gameCapabilities, solid } from '../../shared/Defs.mjs';
import ClientDemos from './ClientDemos.mjs';
import { HostError } from '../common/Errors.mjs';
import { ClientDlight, ClientEdict } from './ClientEntities.mjs';
import { ClientPlayerState } from './ClientMessages.mjs';
import VID from './VID.mjs';
import { clientRuntimeState, clientStaticState } from './ClientState.mjs';
import ClientConnection from './ClientConnection.mjs';
import ClientLifecycle from './ClientLifecycle.mjs';
import { parseServerMessage as parseServerCommandMessage } from './ClientServerCommandHandlers.mjs';

/** @typedef {import('./Sound.mjs').SFX} SFX */

let { COM, Con, Draw, Host, Mod, PR, R, S, Sbar } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
  Mod = registry.Mod;
  PR = registry.PR;
  R = registry.R;
  S = registry.S;
  Sbar = registry.Sbar;
});

export default class CL {
  /** @deprecated – use Def.contentShift */
  static cshift = Def.contentShift;

  /** @deprecated – use Def.clientConnectionState */
  static active = Def.clientConnectionState;

  /** @type {Pmove} */
  static pmove = new Pmove();

  static #clientDemos = new ClientDemos();
  static #connection = null;

  /** @type {gameCapabilities[]} */
  static gameCapabilities = [];

  /** @type {boolean} */
  static sbarDisabled = false;
  static cls = clientStaticState;
  static state = clientRuntimeState;

  static {
    this.#connection = new ClientConnection({ clientDemos: this.#clientDemos });
    this.cls.bindClientDemos(this.#clientDemos);
    this.svc_strings = Object.keys(Protocol.svc);
  }

  /** @type {Cvar} */ static nolerp = null;
  /** @type {Cvar} */ static rcon_password = null;
  /** @type {Cvar} */ static shownet = null;
  /** @type {Cvar} */ static name = null;
  /** @type {Cvar} */ static color = null;
  /** @type {Cvar} */ static upspeed = null;
  /** @type {Cvar} */ static forwardspeed = null;
  /** @type {Cvar} */ static backspeed = null;
  /** @type {Cvar} */ static sidespeed = null;
  /** @type {Cvar} */ static movespeedkey = null;
  /** @type {Cvar} */ static yawspeed = null;
  /** @type {Cvar} */ static pitchspeed = null;
  /** @type {Cvar} */ static anglespeedkey = null;
  /** @type {Cvar} */ static lookspring = null;
  /** @type {Cvar} */ static lookstrafe = null;
  /** @type {Cvar} */ static sensitivity = null;
  /** @type {Cvar} */ static m_pitch = null;
  /** @type {Cvar} */ static m_yaw = null;
  /** @type {Cvar} */ static m_forward = null;
  /** @type {Cvar} */ static m_side = null;
  /** @type {Cvar} */ static nopred = null;
  /** @type {Cvar} */ static nohud = null;

  /** @type {SFX} */ static sfx_wizhit = null;
  /** @type {SFX} */ static sfx_knighthit = null;
  /** @type {SFX} */ static sfx_tink1 = null;
  /** @type {SFX} */ static sfx_ric1 = null;
  /** @type {SFX} */ static sfx_ric2 = null;
  /** @type {SFX} */ static sfx_ric3 = null;
  /** @type {SFX} */ static sfx_r_exp3 = null;
  /** @type {SFX} */ static sfx_talk = null;

  /** @type {number} */ static _processingServerDataState = 0;
  /** @type {string[]} */ static _lastServerMessages = [];
  /** @type {Protocol.UserCmd} */ static nullcmd = new Protocol.UserCmd();


  static StartDemos(demos) {
    this.#clientDemos.startDemos(demos);
  }

  static StartPlayback(demoname, timedemo = false) {
    this.#clientDemos.startPlayback(demoname, timedemo);
  }

  static StopPlayback() { // public, by Host.js
    this.#clientDemos.stopPlayback();
  }

  static StartRecording(demoname, forcetrack = -1) {
    this.#clientDemos.startRecording(demoname, forcetrack);
  }

  static StopRecording() {
    this.#clientDemos.stopRecording();
  }

  static NextDemo() { // public, by Host.js, M.js
    this.#clientDemos.playNext();
  };

  static async Init() {
    return ClientLifecycle.init();
  }

  static InitGame() {
    return ClientLifecycle.initGame();
  }

  static InitPmove() {
    this.pmove = new Pmove();
    this.pmove.movevars = new MoveVars();
  }

  static SetConnectingStep(percentage, message) {
    CL.#connection.setConnectingStep(percentage, message);
  }

  static GetMessage() {
    return CL.#connection.getMessage();
  }

  static SendCmd() {
    CL.#connection.sendCmd();
  }

  static ResetCheatCvars() {
    CL.#connection.resetCheatCvars();
  }

  static ClearState() {
    CL.#connection.clearState();
  }

  static ConfigureConnectionIdentity(cvars) {
    CL.#connection.configureIdentityCvars(cvars);
  }

  static Disconnect() {
    CL.#connection.disconnect();
  }

  static CheckConnectingState() {
    CL.#connection.checkConnectingState();
  }

  static Connect(host) {
    CL.#connection.connect(host);
  }

  static SignonReply() {
    CL.#connection.signonReply();
  }

  static Stop_f = class StopRecordingCommand extends ConsoleCommand { // private
    run() {
      if (this.client) {
        return;
      }

      CL.StopRecording();
    }
  };

  static Record_f = class StartRecordingCommand extends ConsoleCommand { // private
    run(demoname, map, track) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: record <demoname> [<map> [cd track]]\n');
        return;
      }

      if (demoname.indexOf('..') !== -1) {
        Con.PrintWarning('Relative pathnames are not allowed.\n');
        return;
      }

      if (map === undefined && CL.cls.state === Def.clientConnectionState.connected) {
        Con.PrintWarning('Can not record - already connected to server\nClient demo recording must be started before connecting\n');
        return;
      }

      Cmd.ExecuteString('map ' + map);

      CL.StartRecording(demoname, Q.atoi(track));
    }
  };

  static StartDemos_f = class StartDemosCommand extends ConsoleCommand {
    run(...demos) {
      if (this.client) {
        return;
      }

      if (demos.length === 0) {
        Con.Print('Usage: startdemos <demoname1> [<demoname2> ...]\n');
        return;
      }

      Con.Print(demos.length + ' demo(s) in loop\n');

      Host.ScheduleForNextFrame(() => {
        CL.StartDemos(demos);
      });
    }
  };

  static Demos_f = class NextDemoCommand extends ConsoleCommand {
    run() {
      if (CL.#clientDemos.demonum === -1) {
        CL.#clientDemos.demonum = 1;
      }

      CL.Disconnect();
      CL.#clientDemos.playNext();
    }
  };

  static StopDemo_f = class StopPlaybackCommand extends ConsoleCommand {
    run() {
      if (this.client) {
        return;
      }

      if (!CL.#clientDemos.demoplayback) {
        return;
      }

      CL.StopPlayback();
    }
  };

  static PlayDemo_f = class StartPlaybackCommand extends ConsoleCommand {
    run(demoname) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: playdemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      CL.StartPlayback(demoname);
    }
  };

  static TimeDemo_f = class TimeDemoCommand extends ConsoleCommand { // private
    run(demoname) {
      if (this.client) {
        return;
      }

      if (demoname === undefined) {
        Con.Print('Usage: timedemo <demoname>\n');
        return;
      }

      CL.Disconnect();
      CL.StartPlayback(demoname, true);
    }
  };

  static Rcon_f = class extends ConsoleCommand {
    run(...args) { // private
      if (args.length === 0) {
        Con.Print('Usage: rcon <command>\n');
        return;
      }

      const password = CL.rcon_password.string;

      if (!password) {
        Con.Print('You must set \'rcon_password\' before issuing an rcon command.\n');
        return;
      }

      MSG.WriteByte(CL.cls.message, Protocol.clc.rconcmd);
      MSG.WriteString(CL.cls.message, password);
      MSG.WriteString(CL.cls.message, this.args.substring(5));
    }
  };

  static Draw() { // public, called by SCR.js // FIXME: maybe put that into M?, called by SCR
    if (this.cls.connecting !== null && this.cls.state !== Def.clientConnectionState.disconnected && !this.cls.changelevel) {
      const x0 = 32, y0 = 32;
      Draw.BlackScreen();
      Draw.String(x0, y0, 'Connecting', 2);
      Draw.StringWhite(x0, y0 + 32, this.cls.connecting.message);

      const len = 30;
      const p = this.cls.connecting.percentage;
      Draw.String(x0, y0 + 48, `[${'#'.repeat(p / 100 * len).padEnd(len, '_')}] ${p.toFixed(0).padStart(0, ' ')}%`);
      return;
    }

    if (this.cls.changelevel) {
      Draw.String(VID.width / 2 - 64, VID.height / 2 - 16, 'Loading', 2);
    }
  }

  static DrawHUD() {
    if (this.nohud.value !== 0) {
      return;
    }

    if (this.state.gameAPI) {
      this.state.gameAPI.draw();
    }

    if (!this.sbarDisabled) {
      Sbar.Draw();
    }
  }

  static ClientFrame() {
    if (this.cls.signon !== 4) {
      return; // not ready yet
    }

    if (this.state.gameAPI) {
      this.state.gameAPI.startFrame();
    }

    this.state.clientEntities.think();
  }

  static ParseLightstylePacket() { // private
    const i = MSG.ReadByte();
    if (i >= Def.limits.lightstyles) {
      throw new HostError('svc_lightstyle > MAX_LIGHTSTYLES');
    }

    this.state.clientEntities.setLightstyle(i, MSG.ReadString());
  }

  /**
   * Will get the client entity by its edict number.
   * If it’s not found, it will return a new ClientEdict with the given number.
   * This should never be called to allocate entities explictly, use `ClientEntities.allocateClientEntity` instead.
   * @param {number} num edict Id
   * @returns {ClientEdict} client entity
   */
  static EntityNum(num) {
    return this.state.clientEntities.getEntity(num);
  };

  /**
   * Allocates a dynamic light for the given entity Id.
   * @param {number} num edict Id, can be 0
   * @returns {ClientDlight} dynamic light
   */
  static AllocDlight(num) {
    return this.state.clientEntities.allocateDynamicLight(num);
  }

  /**
   * Builds the visedicts list.
   * Made up of: clients, packet_entities, nails, and tents.
   */
  static EmitEntities() { // public, by Host.js
    if (this.cls.state !== Def.clientConnectionState.connected) {
      return;
    }

    this.state.clientEntities.emit();
  }

  static SetSolidEntities() {
    this.pmove.clearEntities();

    // NOTE: not adding world, it’s already in pmove AND we are not adding static entities, they are never affecting the game play

    for (const clent of this.state.clientEntities.getEntities()) {
      if (clent.num === 0 || !clent.model) {
        continue;
      }

      this.pmove.addEntity(clent, clent.solid === solid.SOLID_BSP ? clent.model : null);
    }
  }

  static ResumeGame(clientdata, particles) {
    ClientLifecycle.resumeGame(clientdata, particles);
  }
};

CL.PrintEntities_f = function() { // private
  Con.Print('Entities:\n');
  for (const ent of CL.state.clientEntities.getEntities()) {
    if (ent.model === null) {
      continue;
    }

    Con.Print(`${ent}\n`);
  }
};

CL.ReadFromServer = function() { // public, by Host.js
  let ret;
  while (true) {
    if (CL._processingServerDataState === 1) {
      return;
    }
    if (CL._processingServerDataState === 2) {
      CL._processingServerDataState = 3;
    } else {
      ret = CL.GetMessage();
      if (ret === -1) {
        // if (CL._processingServerDataState === 0 && CL.cls.signon < 4) {
        //   break;
        // }
        throw new HostError('CL.ReadFromServer: lost server connection');
      }
      if (ret === 0) {
        break;
      }
    }
    CL.state.last_received_message = Host.realtime;
    // console.debug('CL.ReadFromServer: ', NET.message.toHexString());
    CL.ParseServerMessage();
    if (CL.cls.state !== CL.active.connected) {
      break;
    }
  }
  if (CL.shownet.value !== 0) {
    Con.Print('\n');
  }

  // CL.RelinkEntities();
  // CL.UpdateTEnts();
};

CL.ServerInfo_f = function() { // private
  if (CL.cls.state !== CL.active.connected) {
    Con.Print('Can\'t "serverinfo", not connected\n');
    return;
  }

  for (const [key, value] of Object.entries(CL.cls.serverInfo)) {
    Con.Print(`${key}: ${value}\n`);
  }
};

CL.MoveAround_f = function() { // private
  if (CL.cls.state !== CL.active.connected) {
    Con.Print('Can\'t "movearound", not connected\n');
    return;
  }

  if (CL.cls.signon !== 4) {
    Con.Print('You must wait for the server to send you the map before moving around.\n');
    return;
  }

  if (CL.cls.movearound !== null) {
    clearInterval(CL.cls.movearound);
    CL.cls.movearound = null;
    Con.Print('Stopped moving around.\n');
    return;
  }

  CL.cls.movearound = setInterval(() => {
    if (CL.cls.state !== CL.active.connected) {
      Con.Print('No longer connected, stopped moving around.\n');
      clearInterval(CL.cls.movearound);
      CL.cls.movearound = null;
      return;
    }

    if (Math.random() < 0.1) {
      if (Math.random() < 0.5) {
        Cmd.text += '+back; wait; -back;\n';
      } else {
        Cmd.text += '+forward; wait; -forward;\n';
      }
    }

    if (Math.random() < 0.5) {
      Cmd.text += '+jump; wait; -jump;\n';
    }

    if (Math.random() < 0.2) {
      Cmd.text += '+attack; wait; -attack;\n';
    }
  }, 1000);

  Con.Print('Started moving around.\n');
};

class ClientScoreSlot {
  #num = null;

  constructor(num) {
    this.#num = num;

    this.name = '';
    this.entertime = 0.0;
    this.frags = 0;
    this.colors = 0;
    this.ping = 0;
  }

  get isActive() {
    return this.name !== '';
  }

  /** @returns {ClientEdict} the corresponding client entity for this client score slot */
  get entity() {
    return CL.state.clientEntities.getEntity(this.#num + 1);
  }
};

CL.ParseServerData = function() { // private
  Con.DPrint('Serverdata packet received.\n');
  CL.ClearState();

  const version = MSG.ReadByte();

  if (version !== Protocol.version) {
    throw new HostError('Server returned protocol version ' + version + ', not ' + Protocol.version + '\n');
  }

  const isHavingClientQuakeJS = MSG.ReadByte() === 1;

  // check if client is actually compatible with the server
  if (isHavingClientQuakeJS) {
    Con.DPrint('Server is running QuakeJS with ClientGameAPI provided.\n');

    if (!PR.QuakeJS?.ClientGameAPI) {
      throw new HostError('Server is running QuakeJS with client code provided,\nbut client code is not imported.\nTry clearing your cache and connect again.');
    }

    const name = MSG.ReadString();
    const author = MSG.ReadString();
    const version = [MSG.ReadByte(), MSG.ReadByte(), MSG.ReadByte()];

    const identification = PR.QuakeJS.identification;

    if (identification.name !== name || identification.author !== author) {
      throw new HostError(`Cannot connect, game mismatch.\nThe server is running ${name}\nand you are running ${identification.name}.`);
    }

    if (!PR.QuakeJS.ClientGameAPI.IsServerCompatible(version)) {
      // TODO: show different message for demo playback
      throw new HostError(`Server (v${version.join('.')}) is not compatible. You are running v${identification.version.join('.')}.\nTry clearing your cache and connect again.`);
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
    CL.state.scores[i] = new ClientScoreSlot(i);
  }

  CL.state.levelname = MSG.ReadString();

  CL.ParsePmovevars();

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

  CL._processingServerDataState = 1;

  (async () => {
    const models = [null], sounds = [null]; // index 0 is always null, reserved for “no model”/“no sound”

    // load world first and wait, it will fill up the submodels
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
    // TODO: check if we got another load/map/connect event in before
    CL.state.model_precache.length = 0;
    CL.state.sound_precache.length = 0;

    CL.state.model_precache.push(...models);
    CL.state.sound_precache.push(...sounds);

    CL._processingServerDataState = 2;
    CL.state.worldmodel = CL.state.model_precache[1];
    CL.pmove.setWorldmodel(CL.state.worldmodel);
    const ent = CL.EntityNum(0);
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
      if (CL.state.loadClientData && CL.state.loadClientData[0]) { // let’s check if we have a saved game state to load
        CL.state.gameAPI.loadGame(CL.state.loadClientData[0]);
      }
    }
    if (CL.state.loadClientData && CL.state.loadClientData[1]) { // let’s check if we have a saved particles state to load
      R.DeserializeParticles(CL.state.loadClientData[1]);
    }
    CL.state.loadClientData = null;
  });
};

CL.ParsePmovevars = function() { // private
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
};

CL.ParseStartSoundPacket = function() { // private
  const fieldMask = MSG.ReadByte();
  const volume = ((fieldMask & 1) !== 0) ? MSG.ReadByte() : 255;
  const attenuation = ((fieldMask & 2) !== 0) ? MSG.ReadByte() * 0.015625 : 1.0;
  const entchannel = MSG.ReadShort();
  const soundNum = MSG.ReadByte();
  const ent = entchannel >> 3;
  const channel = entchannel & 7;
  const pos = MSG.ReadCoordVector();

  S.StartSound(ent, channel, CL.state.sound_precache[soundNum], pos, volume / 255.0, attenuation);
};

CL.nullcmd = new Protocol.UserCmd();

CL.ParseStaticEntity = function() { // private
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
};

CL.ParseStaticSound = function() { // private
  const org = MSG.ReadCoordVector();
  const soundId = MSG.ReadByte();
  const vol = MSG.ReadByte();
  const attn = MSG.ReadByte();
  S.StaticSound(CL.state.sound_precache[soundId], org, vol / 255.0, attn);
};

CL.AppendChatMessage = function(name, message, direct) { // private // TODO: Client
  eventBus.publish('client.chat.message', name, message, direct);

  if (CL.gameCapabilities.includes(gameCapabilities.CAP_CHAT_MANAGED)) {
    return;
  }

  if (CL.state.chatlog.length > 5) {
    CL.state.chatlog.shift();
  }

  CL.state.chatlog.push({name, message, direct});
  S.LocalSound(CL.sfx_talk);
};

CL.ParseServerCvars = function () { // private
  let count = MSG.ReadByte();

  while(count-- > 0) {
    const name = MSG.ReadString();
    const value = MSG.ReadString();

    CL.cls.serverInfo[name] = value;

    if (CL.cls.signon === 4) {
      Con.Print(`"${name}" changed to "${value}"\n`);
      eventBus.publish('client.server-info.updated', name, value);
    }

    // special handling for cheats
    if (name === 'sv_cheats' && value === '0') {
      CL.ResetCheatCvars();
    }
  }
};

CL.PrintLastServerMessages = function() { // private
  if (CL._lastServerMessages.length > 0) {
    Con.Print('Last server messages:\n');
    for (const cmd of CL._lastServerMessages) {
      Con.Print(' ' + cmd + '\n');
    }
  }
};

/**
 * as long as we do not have a fully async architecture, we have to cheat
 * processingServerInfoState will hold off parsing and processing any further command
 * - 0 = normal operation
 * - 1 = we entered parsing serverdata, holding off any further processing
 * - 2 = we are done processing, we can continue processing the rest
 * - 3 = we need to re-enter the loop, but not reset the MSG pointer
 * @type {number}
 */
CL._processingServerDataState = 0;
CL._lastServerMessages = [];

CL.ParseServerMessage = function() { // private
  parseServerCommandMessage(CL);
};

// tent

CL.InitTEnts = function() { // private // TODO: move this to ClientAPI / ClientLegacy
  CL.sfx_wizhit = S.PrecacheSound('wizard/hit.wav');
  CL.sfx_knighthit = S.PrecacheSound('hknight/hit.wav');
  CL.sfx_tink1 = S.PrecacheSound('weapons/tink1.wav');
  CL.sfx_ric1 = S.PrecacheSound('weapons/ric1.wav');
  CL.sfx_ric2 = S.PrecacheSound('weapons/ric2.wav');
  CL.sfx_ric3 = S.PrecacheSound('weapons/ric3.wav');
  CL.sfx_r_exp3 = S.PrecacheSound('weapons/r_exp3.wav');
};

CL.ParseBeam = function(m) { // private // TODO: move this to ClientAPI / ClientLegacy
  const ent = MSG.ReadShort();
  const start = MSG.ReadCoordVector();
  const end = MSG.ReadCoordVector();
  for (let i = 0; i < Def.limits.beams; i++) {
    const b = CL.state.clientEntities.beams[i];
    if (b.entity !== ent) {
      continue;
    }
    b.model = m;
    b.endtime = CL.state.time + 0.2;
    b.start = start.copy();
    b.end = end.copy();
    return;
  }
  for (let i = 0; i < Def.limits.beams; i++) {
    const b = CL.state.clientEntities.beams[i];
    if ((b.model !== null) && (b.endtime >= CL.state.time)) {
      continue;
    }
    b.entity = ent;
    b.model = m;
    b.endtime = CL.state.time + 0.2;
    b.start = start.copy();
    b.end = end.copy();
    return;
  }
  Con.Print('beam list overflow!\n');
};

CL.ParseTemporaryEntity = function() { // private // TODO: move this to ClientAPI / ClientLegacy
  const type = MSG.ReadByte();

  switch (type) {
    case Protocol.te.lightning1:
      CL.ParseBeam(Mod.ForName('progs/bolt.mdl', true));
      return;
    case Protocol.te.lightning2:
      CL.ParseBeam(Mod.ForName('progs/bolt2.mdl', true));
      return;
    case Protocol.te.lightning3:
      CL.ParseBeam(Mod.ForName('progs/bolt3.mdl', true));
      return;
    case Protocol.te.beam:
      CL.ParseBeam(Mod.ForName('progs/beam.mdl', true));
      return;
  }

  const pos = MSG.ReadCoordVector();

  switch (type) {
    case Protocol.te.wizspike:
      R.RunParticleEffect(pos, Vector.origin, 20, 20);
      S.StartSound(-1, 0, CL.sfx_wizhit, pos, 1.0, 1.0);
      return;
    case Protocol.te.knightspike:
      R.RunParticleEffect(pos, Vector.origin, 226, 20);
      S.StartSound(-1, 0, CL.sfx_knighthit, pos, 1.0, 1.0);
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
        const dl = CL.AllocDlight(0);
        dl.origin = pos.copy();
        dl.radius = 350.0;
        dl.die = CL.state.time + 0.5;
        dl.decay = 300.0;
        S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
      }
      return;
    case Protocol.te.tarexplosion:
      R.BlobExplosion(pos);
      S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
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
        const dl = CL.AllocDlight(0);
        dl.origin = pos.copy();
        dl.radius = 350.0;
        dl.die = CL.state.time + 0.5;
        dl.decay = 300.0;
        S.StartSound(-1, 0, CL.sfx_r_exp3, pos, 1.0, 1.0);
      }
      return;
  }

  throw new Error(`CL.ParseTEnt: bad type ${type}`);
};

CL.PredictMove = function() { // public, by Host.js
  CL.state.time = Host.realtime - CL.state.latency;

  if (CL.nopred.value !== 0) {
    return;
  }

  // const playerEntity = CL.state.playerentity;
  // if (!playerEntity) { // no player entity, nothing to predict
  //   return;
  // }

  // const from = CL.state.playerstate;
  // if (!from) { // no player state, nothing to predict
  //   return;
  // }

  // from.origin.set(playerEntity.origin);
  // from.angles.set(playerEntity.angles);
  // from.velocity.set(playerEntity.velocity);

  // const to = new ClientPlayerState(from.pmove);

  // to.origin.set(playerEntity.msg_origins[0]);
  // to.angles.set(playerEntity.msg_angles[0]);
  // to.velocity.set(playerEntity.msg_velocity[0]);

  // CL.PredictUsercmd(from.pmove, from, to, CL.state.cmd);

  // const f = 1;

  // // console.log('f', f);

  // if (playerEntity.origin.distanceTo(to.origin) > 100) {
  //   Con.PrintWarning(`CL.PredictMove: player origin too far away from predicted origin: ${to.origin.toString()}, ${playerEntity.origin.toString()}\n`);
  //   // return;
  // }

  // const o0 = playerEntity.origin;
  // const o1 = to.origin;

  // playerEntity.origin.setTo(
  //   o1[0] + (o0[0] - o1[0]) * f,
  //   o1[1] + (o0[1] - o1[1]) * f,
  //   o1[2] + (o0[2] - o1[2]) * f,
  // );

  // playerEntity.origin.set(to.origin);
  // playerEntity.angles.set(to.angles);
  // playerEntity.velocity.set(to.velocity);
};

/**
 * @param {PmovePlayer} pmove pmove for player
 * @param {ClientPlayerState} from previous state
 * @param {ClientPlayerState} to current state
 * @param {Protocol.UserCmd} u player commands
 */
CL.PredictUsercmd = function(pmove, from, to, u) { // private
  // split long commands
  if (u.msec > 50) {
    const mid = new ClientPlayerState(pmove);
    const split = u.copy();
    split.msec /= 2;
    CL.PredictUsercmd(pmove, from, mid, split);
    CL.PredictUsercmd(pmove, mid, to, split);
    return;
  }

  pmove.origin.set(from.origin);
  pmove.angles.set(u.angles);
  pmove.velocity.set(from.velocity);

  pmove.oldbuttons = from.oldbuttons;
  pmove.waterjumptime = from.waterjumptime;
  pmove.dead = false; // TODO: cl.stats[STAT_HEALTH] <= 0;
  pmove.spectator = false;

  pmove.cmd.set(u);

  pmove.move();

  to.waterjumptime = pmove.waterjumptime;
  to.oldbuttons = pmove.cmd.buttons;
  to.origin.set(pmove.origin);
  to.velocity.set(pmove.velocity);
  to.angles.set(pmove.angles);
  to.onground = pmove.onground;
  to.weaponframe = from.weaponframe;
};

/**
 * Calculate the new position of players, without other player clipping.
 * We do this to set up real player prediction.
 * Players are predicted twice, first without clipping other players,
 * then with clipping against them.
 * This sets up the first phase.
 */
CL.SetUpPlayerPrediction = function() { // public, by Host.js
  // TODO: implement prediction setup once client prediction is refactored.
};

CL.ParsePacketEntities = function() { // private
  while (true) {
    const edictNum = MSG.ReadShort();

    if (edictNum === 0) {
      break;
    }

    /** @type {ClientEdict} */
    const clent = CL.EntityNum(edictNum);

    const bits = MSG.ReadShort();

    // CR:  this step is important, it will initialize the client-side code for the entity
    //      if there’s no classname, the client entity will be remain pretty dumb, since it wont’t have a handler
    if (bits & Protocol.u.classname) {
      clent.classname = MSG.ReadString();
      clent.loadHandler();
      clent.spawn(); // changing the classname also means we need to spawn the entity again
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

      // a new model will cause the frame lerp to reset
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

    // if ((bits & (Protocol.u.origin1 | Protocol.u.origin2 | Protocol.u.origin3)) && clent.classname === 'player') {
    //   console.log('CL.ParsePacketEntities: receiving origin', clent.num, origin.toString());
    // }

    if (bits & Protocol.u.size) {
      clent.maxs.set(MSG.ReadCoordVector());
      clent.mins.set(MSG.ReadCoordVector());
    }

    if (bits & Protocol.u.nextthink) {
      clent.nextthink = CL.state.clientMessages.mtime[0] + MSG.ReadByte() / 255.0;
    }

    if (CL.gameCapabilities.includes(gameCapabilities.CAP_ENTITY_EXTENDED)) {
      const clientEntityFields = CL.state.clientEntityFields[clent.classname];
      // let’s check if we have any extended fields for this entity
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

    // keep track of time of changes
    const time = CL.state.clientMessages.mtime[0];

    if (clent.nextthink > time) {
      // origin change requested
      if (!clent.msg_origins[0].equals(clent.origin)) {
        clent.originTime = time;
        clent.originPrevious.set(clent.origin);
      }

      // angles change requested
      if (!clent.msg_angles[0].equals(clent.angles)) {
        clent.anglesTime = time;
        clent.anglesPrevious.set(clent.angles);
      }

      // velocity change requested
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
      // make sure that we clear this ClientEntity before we throw it back in
      clent.freeEdict();
    }
  }

  // TODO: send an acknowledge command back
};
