import Cvar from '../common/Cvar.mjs';
import { MoveVars } from '../common/Pmove.mjs';
import Vector from '../../shared/Vector.mjs';
import MSG, { SzBuffer } from '../network/MSG.mjs';
import * as Protocol from '../network/Protocol.mjs';
import * as Def from './../common/Def.mjs';
import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import { ED, ServerEdict } from './Edict.mjs';
import { EventBus, eventBus, registry } from '../registry.mjs';
import { ServerEngineAPI } from '../common/GameAPIs.mjs';
import * as Defs from '../../shared/Defs.mjs';
import { Navigation } from './Navigation.mjs';
import { ServerPhysics } from './physics/ServerPhysics.mjs';
import { ServerClientPhysics } from './physics/ServerClientPhysics.mjs';
import { ServerMessages } from './ServerMessages.mjs';
import { ServerMovement } from './physics/ServerMovement.mjs';
import { ServerArea } from './physics/ServerArea.mjs';
import { ServerCollision } from './physics/ServerCollision.mjs';

let { COM, Con, Host, Mod, NET, PR } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  NET = registry.NET;
  PR = registry.PR;
});

/** @typedef {import('./Client.mjs').ServerClient} ServerClient */

/**
 * @typedef {{
      fraction: number;
      allsolid: boolean;
      startsolid: boolean;
      endpos: any;
      plane: {
          normal: Vector;
          dist: number;
      };
      ent: any;
      inopen?: boolean;
      inwater?: boolean;
  }} Trace
 */

/** @typedef {import('../../shared/GameInterfaces').SerializableType} SerializableType */

export class ServerEntityState {
  constructor(num = null) {
    this.num = num;
    this.flags = 0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0;
    this.free = false;
    this.classname = null;
    this.mins = new Vector();
    this.maxs = new Vector();
    this.velocity = new Vector(0, 0, 0);
    this.nextthink = 0;

    /** @type {Record<string, SerializableType>} */
    this.extended = {};
  }

  /** @param {ServerEntityState} other other state to copy */
  set(other) {
    this.num = other.num;
    this.flags = other.flags;
    this.origin.set(other.origin);
    this.angles.set(other.angles);
    this.velocity.set(other.velocity);
    this.modelindex = other.modelindex;
    this.frame = other.frame;
    this.colormap = other.colormap;
    this.skin = other.skin;
    this.effects = other.effects;
    this.solid = other.solid;
    this.free = other.free;
    this.classname = other.classname;
    this.mins.set(other.mins);
    this.maxs.set(other.maxs);
    this.nextthink = other.nextthink;

    for (const [key, value] of Object.entries(other.extended)) {
      this.extended[key] = value;
    }
  }

  freeEdict() {
    this.free = true;
    this.flags = 0;
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.velocity.setTo(0, 0, 0);
    this.nextthink = 0;
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0;
    this.classname = null;
  }
}

/**
 * Main server class with all server-related functionality.
 * All properties and methods are static.
 */
export default class SV {
  /** Core server state */
  static server = {
    time: 0,
    num_edicts: 0,
    datagram: new SzBuffer(16384, 'SV.server.datagram'),
    expedited_datagram: new SzBuffer(16384, 'SV.server.expedited_datagram'),
    reliable_datagram: new SzBuffer(16384, 'SV.server.reliable_datagram'),
    /** sent during client prespawn */
    signon: new SzBuffer(16384, 'SV.server.signon'),
    /** @type {ServerEdict[]} */
    edicts: [],
    mapname: null,
    worldmodel: null,
    /** server game event bus, will be reset on every map load */
    eventBus: new EventBus('server-game'),
    /** @type {Navigation} navigation graph management */
    navigation: null,
    /** @type {import('../../shared/GameInterfaces').ServerGameInterface} */
    gameAPI: null,
    /** @type {string?} game version string */
    gameVersion: null,
    /** @type {string?} game identification (e.g. Quake) */
    gameName: null,
    /** @type {Defs.gameCapabilities[]} game capability flags */
    gameCapabilities: [],
    /** @type {string[]} clientdata field names */
    clientdataFields: [],
    /** @type {MSG.WriteByte|MSG.WriteShort|MSG.WriteLong} */
    clientdataFieldsBitsWriter: null,
    /** @type {Record<string, { fields: string[], bitsWriter: MSG.WriteByte|MSG.WriteShort|MSG.WriteLong}>} maps classname to its fields and the apropriate bits writer  */
    clientEntityFields: {},
  };

  /** state across maps */
  static svs = {
    changelevel_issued: false,
    /** @type {ServerClient[]} */
    clients: [],
    maxclients: 0,
    maxclientslimit: 32,
    /** gamestate across maps */
    gamestate: null,
  };

  static areanodes = [];

  // Physics box hull (used for collision detection)
  static box_clipnodes = null;
  static box_planes = null;
  static box_hull = null;

  // Class instances for modular functionality
  static physics = new ServerPhysics();
  static clientPhysics = new ServerClientPhysics();
  static messages = new ServerMessages();
  static movement = new ServerMovement();
  static area = new ServerArea();
  static collision = new ServerCollision();

  // Entity state class
  static EntityState = ServerEntityState;

  // Cvars (initialized in Init())
  static maxvelocity = null;
  static edgefriction = null;
  static stopspeed = null;
  static accelerate = null;
  static idealpitchscale = null;
  static aim = null;
  static nostep = null;
  static cheats = null;
  static gravity = null;
  static friction = null;
  static maxspeed = null;
  static airaccelerate = null;
  static wateraccelerate = null;
  static spectatormaxspeed = null;
  static waterfriction = null;
  static rcon_password = null;
  static public = null;

  /** Scheduled game commands */
  static _scheduledGameCommands = [];

  // ===== STATIC METHODS =====

  static InitPmove() {
    // TODO: pmove
  }

  static Init() {
    SV.maxvelocity = new Cvar('sv_maxvelocity', '2000');
    SV.edgefriction = new Cvar('edgefriction', '2');
    SV.stopspeed = new Cvar('sv_stopspeed', '100');
    SV.accelerate = new Cvar('sv_accelerate', '10');
    SV.idealpitchscale = new Cvar('sv_idealpitchscale', '0.8');
    SV.aim = new Cvar('sv_aim', '0.93');
    SV.nostep = new Cvar('sv_nostep', '0');
    SV.cheats = new Cvar('sv_cheats', '0', Cvar.FLAG.SERVER);
    SV.gravity = new Cvar('sv_gravity', '800', Cvar.FLAG.SERVER);
    SV.friction = new Cvar('sv_friction', '4', Cvar.FLAG.SERVER);
    SV.maxspeed = new Cvar('sv_maxspeed', '320', Cvar.FLAG.SERVER);
    SV.airaccelerate = new Cvar('sv_airaccelerate', '0.7');
    SV.wateraccelerate = new Cvar('sv_wateraccelerate', '10');
    SV.spectatormaxspeed = new Cvar('sv_spectatormaxspeed', '500');
    SV.waterfriction = new Cvar('sv_waterfriction', '4');
    SV.rcon_password = new Cvar('sv_rcon_password', '', Cvar.FLAG.ARCHIVE);
    SV.public = new Cvar('sv_public', '1', Cvar.FLAG.ARCHIVE | Cvar.FLAG.SERVER, 'Make this server publicly listed in the master server');

    Navigation.Init();

    Cmd.AddCommand('nav', class extends ConsoleCommand {
      run() {
        if (!SV.server.navigation) {
          Con.Print('navigation not initialized, you have to spawn a server first\n');
          return;
        }

        SV.server.navigation.build();
      }
    });

    eventBus.subscribe('cvar.changed', (name) => {
      const cvar = Cvar.FindVar(name);

      if ((cvar.flags & Cvar.FLAG.SERVER) && SV.server.active) {
        SV.CvarChanged(cvar);
      }
    });

    // TODO: we need to observe changes to those pmove vars and resend them to all clients when changed

    SV.InitPmove();

    // SV.nop = new SzBuffer(4);
    // SV.cursize = 1;
    // MSG.WriteByte(SV.nop, Protocol.svc.nop);

    SV.area.initBoxHull(); // pmove, remove
  }

  // =============================================================================
  // GAME COMMANDS & SCHEDULING
  // Schedule and run commands from the game logic
  // =============================================================================

  static RunScheduledGameCommands() {
    while (SV._scheduledGameCommands.length > 0) {
      const command = SV._scheduledGameCommands.shift();

      command();
    }
  }

  static ScheduleGameCommand(command) {
    SV._scheduledGameCommands.push(command);
  }

  static ConnectClient(client, netconnection) {
    Con.DPrint('Client ' + netconnection.address + ' connected\n');

    const old_spawn_parms = SV.server.loadgame ? client.spawn_parms : null;

    client.clear();
    client.name = 'unconnected';
    client.netconnection = netconnection;
    client.active = true;

    client.old_frags = Infinity; // trigger a update frags

    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_SPAWNPARMS_DYNAMIC)) {
      client.entity.restoreSpawnParameters(old_spawn_parms);
    } else if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_SPAWNPARMS_LEGACY)) {
      if (SV.server.loadgame) {
        console.assert(old_spawn_parms instanceof Array, 'old_spawn_parms is an array');

        for (let i = 0; i < client.spawn_parms.length; i++) {
          client.spawn_parms[i] = old_spawn_parms[i];
        }
      } else {
        SV.server.gameAPI.SetNewParms();
        for (let i = 0; i < client.spawn_parms.length; i++) {
          client.spawn_parms[i] = SV.server.gameAPI[`parm${i + 1}`];
        }
      }
    }

    SV.messages.sendServerData(client);
  }

  static CheckForNewClients() {
    for (; ;) {
      const ret = NET.CheckNewConnections();
      if (!ret) {
        return;
      }
      let i;
      for (i = 0; i < SV.svs.maxclients; i++) {
        if (!SV.svs.clients[i].active) {
          break;
        }
      }
      if (i === SV.svs.maxclients) {
        Con.Print('SV.CheckForNewClients: Server is full\n');
        const message = new SzBuffer(32);
        MSG.WriteByte(message, Protocol.svc.disconnect);
        MSG.WriteString(message, 'Server is full');
        NET.SendUnreliableMessage(ret, message);
        NET.Close(ret);
        return;
      }
      const client = SV.svs.clients[i];
      SV.ConnectClient(client, ret);
      NET.activeconnections++;
      eventBus.publish('server.client.connected', client.num, client.name);
    }
  }

  // =============================================================================
  // UTILITIES & HELPERS
  // Miscellaneous helper functions for models, spawn parameters, etc.
  // =============================================================================

  static ModelIndex(name) {
    if (!name) {
      return 0;
    }
    for (let i = 0; i < SV.server.model_precache.length; i++) {
      if (SV.server.model_precache[i] === name) {
        return i;
      }
    }
    console.assert(false, 'model must be precached', name);
    return null;
  }

  static SaveSpawnparms() {
    if ('serverflags' in SV.server.gameAPI) {
      SV.svs.serverflags = SV.server.gameAPI.serverflags;
    }

    for (let i = 0; i < SV.svs.maxclients; i++) {
      /** @type {ServerClient} */
      const client = SV.svs.clients[i];

      if (!client.active) {
        continue;
      }

      client.saveSpawnparms();
    }
  }

  static HasMap(mapname) {
    console.trace('SV.HasMap called');
    return Mod.ForName('maps/' + mapname + '.bsp') !== null;
  }

  static async SpawnServer(mapname) {
    // Ensure hostname is set
    if (NET.hostname.string.trim() === '') {
      NET.hostname.set('UNNAMED');
    }

    eventBus.publish('server.spawning', { mapname });
    Con.DPrint('SpawnServer: ' + mapname + '\n');

    // If server is already active, notify clients about map change
    if (SV.server.active) {
      SV.#notifyClientsOfMapChange(mapname);
    }

    // Clear memory and load game progs
    Con.DPrint('Clearing memory\n');
    Mod.ClearAll();
    SV.#loadGameProgs();

    // Initialize edicts and server state
    SV.#initializeEdicts();

    // Load world model
    if (!await SV.#loadWorldModel(mapname)) {
      return false;
    }

    // Setup area nodes for spatial partitioning
    // eslint-disable-next-line require-atomic-updates
    SV.areanodes.length = 0;
    SV.area.createAreaNode(0, SV.server.worldmodel.mins, SV.server.worldmodel.maxs);

    // Setup model and sound precache
    SV.#setupModelPrecache();

    // Setup player entities
    if (!SV.#setupPlayerEntities()) {
      return false;
    }

    // Initialize light styles
    SV.#initializeLightStyles();

    // Setup dynamic field compression
    SV.#setupClientDataFields();
    SV.#setupExtendedEntityFields();

    // Reset event bus subscriptions
    SV.server.eventBus.unsubscribeAll();

    // Initialize navigation graph
    SV.server.navigation = new Navigation(SV.server.worldmodel);

    // Initialize the game
    SV.server.gameAPI.init(mapname, SV.svs.serverflags);

    // Spawn worldspawn entity
    if (!SV.#spawnWorldspawnEntity()) {
      return false;
    }

    // Wait on all precached models to load
    await SV.WaitForPrecachedResources();

    // Populate all edicts by the entities file
    await ED.LoadFromFile(SV.server.worldmodel.entities);

    // Finalize and notify clients
    SV.#finalizeServerSpawn(mapname);

    SV.svs.changelevel_issued = false;

    return true;
  }

  static ShutdownServer(isCrashShutdown) {
    // tell the game we are shutting down the game
    SV.server.gameAPI.shutdown(isCrashShutdown);

    // make sure all references are dropped
    SV.server.active = false;
    SV.server.loading = false;
    SV.server.worldmodel = null;
    SV.server.gameAPI = null;

    // unlink all edicts from client structures, reset data
    for (const client of SV.svs.clients) {
      client.clear();
    }

    // purge out all edicts
    for (const edict of SV.server.edicts) {
      // explicitly tell entities to free memory
      edict.clear();
      edict.freeEdict();
    }

    SV.server.edicts.length = 0;
    SV.server.num_edicts = 0;

    if (SV.server.navigation) {
      SV.server.navigation.shutdown();
      SV.server.navigation = null;
    }

    SV.server.eventBus.unsubscribeAll();

    if (isCrashShutdown) {
      Con.Print('Server shut down due to a crash!\n');
      return;
    }

    // reset all static server state
    SV.svs.changelevel_issued = false;

    Con.Print('Server shut down.\n');
  }

  /**
   * Writes a cvar to a message stream.
   * @param {SzBuffer} msg message stream
   * @param {Cvar} cvar cvar to write
   */
  static WriteCvar(msg, cvar) {
    if (cvar.flags & Cvar.FLAG.SECRET) {
      MSG.WriteString(msg, cvar.name);
      MSG.WriteString(msg, cvar.string ? 'REDACTED' : '');
    } else {
      MSG.WriteString(msg, cvar.name);
      MSG.WriteString(msg, cvar.string);
    }
  }

  /**
   * Called when a cvar changes.
   * @param {Cvar} cvar cvar that changed
   */
  static CvarChanged(cvar) {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (!client.active || !client.spawned) {
        continue;
      }

      MSG.WriteByte(client.message, Protocol.svc.cvar);
      MSG.WriteByte(client.message, 1);
      SV.WriteCvar(client.message, cvar);
    }
  }

  // =============================================================================
  // CLIENT COMMUNICATION
  // Functions for reading client input and handling client messages
  // =============================================================================

  /**
   * Reads the movement command from a client.
   * @param {ServerClient} client client
   */
  static ReadClientMove(client) {
    client.cmd.msec = MSG.ReadByte();
    client.cmd.angles = MSG.ReadAngleVector();
    client.cmd.forwardmove = MSG.ReadShort();
    client.cmd.sidemove = MSG.ReadShort();
    client.cmd.upmove = MSG.ReadShort();
    // CR: we could restructure this a bit and let the ServerGameAPI handle the rest
    client.cmd.buttons = MSG.ReadByte();
    client.edict.entity.button0 = (client.cmd.buttons & Protocol.button.attack) === 1; // QuakeC
    client.edict.entity.button1 = ((client.cmd.buttons & Protocol.button.use) >> 2) === 1; // QuakeC
    client.edict.entity.button2 = ((client.cmd.buttons & Protocol.button.jump) >> 1) === 1; // QuakeC
    client.edict.entity.v_angle = client.cmd.angles;
    client.cmd.impulse = MSG.ReadByte();
    if (client.cmd.impulse !== 0) {
      client.edict.entity.impulse = client.cmd.impulse; // QuakeC
    }
    // console.log('client.cmd', client.cmd);
  }

  /**
   * Handles a rcon request from a client.
   * @param {ServerClient} client client
   */
  static HandleRconRequest(client) {
    const message = client.message;

    const password = MSG.ReadString();
    const cmd = MSG.ReadString();

    const rconPassword = SV.rcon_password.string;

    if (rconPassword === '' || rconPassword !== password) {
      MSG.WriteByte(message, Protocol.svc.print);
      MSG.WriteString(message, 'Wrong rcon password!\n');
      if (rconPassword === '') {
        Con.Print(`SV.HandleRconRequest: rcon attempted by ${client.name} from ${client.netconnection.address}: ${cmd}\n`);
      }
      return;
    }

    Con.Print(`[${client.name}@${client.netconnection.address}] ${cmd}\n`);

    Con.StartCapturing();
    Cmd.ExecuteString(cmd);

    const response = Con.StopCapturing();
    MSG.WriteByte(message, Protocol.svc.print);
    MSG.WriteString(message, response);
  }

  /**
   * Reads the movement command from a client.
   * @param {ServerClient} client client
   * @returns {boolean} true if successful, false if failed
   */
  static ReadClientMessage(client) {
    // Process all pending network messages
    while (true) {
      const ret = NET.GetMessage(client.netconnection);

      if (ret === -1) {
        Con.Print('SV.ReadClientMessage: NET.GetMessage failed\n');
        return false;
      }

      if (ret === 0) {
        return true; // No more messages
      }

      MSG.BeginReading();

      // Process all commands in this message
      while (true) {
        if (!client.active) {
          return false;
        }

        if (MSG.badread) {
          Con.Print('SV.ReadClientMessage: badread\n');
          return false;
        }

        // Update client ping time
        client.ping_times[client.num_pings++ % client.ping_times.length] = SV.server.time - client.sync_time;

        const cmd = MSG.ReadChar();

        if (cmd === -1) {
          break; // End of message
        }

        if (!SV.#processClientCommand(client, cmd)) {
          return false; // Client should disconnect
        }
      }
    }
  }

  static RunClients() {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (!client.active) {
        continue;
      }
      if (!SV.ReadClientMessage(client)) {
        Host.DropClient(client, false, 'Connectivity issues, failed to read message');
        continue;
      }
      if (!client.spawned) {
        client.cmd.reset();
        continue;
      }
      // TODO: drop clients without an update
      SV.clientPhysics.clientThink(client.edict, client);
    }
  }

  /**
   * Finds a client by name.
   * @param {string} name name of the client
   * @returns {ServerClient|null} the client if found, null otherwise
   */
  static FindClientByName(name) {
    return SV.svs.clients
      .filter((client) => client.active)
      .find((client) => client.name === name) || null;
  }

  /**
   * Notifies all connected clients about a map change and resets their state.
   * @param {string} mapname name of the new map
   */
  static #notifyClientsOfMapChange(mapname) {
    // Make sure that all client states are partially reset and ready for a new map
    for (const client of SV.svs.clients) {
      if (!client.active) {
        continue;
      }

      client.changelevel(mapname);
    }

    // Shut down navigation, since map has changed
    if (SV.server.navigation) {
      SV.server.navigation.shutdown();
      SV.server.navigation = null;
    }
  }

  /**
   * Loads the game progs and initializes game API.
   * Sets up gameAPI, gameVersion, gameName, and gameCapabilities.
   */
  static #loadGameProgs() {
    SV.server.gameAPI = PR.QuakeJS ? new PR.QuakeJS.ServerGameAPI(ServerEngineAPI) : PR.LoadProgs();
    SV.server.gameVersion = `${(PR.QuakeJS ? `${PR.QuakeJS.identification.version.join('.')} QuakeJS` : `${PR.crc} CRC`)}`;
    SV.server.gameName = PR.QuakeJS ? PR.QuakeJS.identification.name : COM.game;
    SV.server.gameCapabilities = PR.QuakeJS ? PR.QuakeJS.identification.capabilities : PR.capabilities;

    Con.DPrint('Game progs loaded\n');
  }

  /**
   * Initializes the edict array and server state.
   * Preallocates edicts and resets server state variables.
   */
  static #initializeEdicts() {
    SV.server.edicts.length = 0;

    // Preallocating up to Def.limits.edicts, we can extend that later during runtime
    for (let i = 0; i < Def.limits.edicts; i++) {
      SV.server.edicts[i] = new ServerEdict(i);
    }

    // Clear message buffers
    SV.server.datagram.clear();
    SV.server.reliable_datagram.clear();
    SV.server.signon.clear();

    // Hooking up the edicts reserved for clients
    SV.server.num_edicts = SV.svs.maxclients + 1;

    // Reset server state
    SV.server.loading = true;
    SV.server.paused = false;
    SV.server.loadgame = false;
    SV.server.time = 1.0;
    SV.server.lastcheck = 0;
    SV.server.lastchecktime = 0.0;

    Con.DPrint('Edicts initialized\n');
  }

  /**
   * Loads and initializes the world model for the given map.
   * @param {string} mapname name of the map to load
   * @returns {Promise<boolean>} true if successful, false if map couldn't be loaded
   */
  static async #loadWorldModel(mapname) {
    SV.server.mapname = mapname;
    SV.server.worldmodel = await Mod.ForNameAsync('maps/' + mapname + '.bsp');

    if (SV.server.worldmodel === null) {
      Con.PrintWarning('SV.SpawnServer: Cannot start server, unable to load map ' + mapname + '\n');
      SV.server.active = false;
      return false;
    }

    Con.DPrint('World model loaded\n');

    return true;
  }

  /**
   * Sets up model precache array including world model and submodels.
   */
  static #setupModelPrecache() {
    SV.server.models = [];
    SV.server.models[1] = SV.server.worldmodel;

    SV.server.sound_precache = [''];
    SV.server.model_precache = ['', SV.server.worldmodel.name];

    // Precache all submodels (brushes connected to entities like doors)
    for (let i = 1; i <= SV.server.worldmodel.submodels.length; i++) {
      SV.server.model_precache[i + 1] = '*' + i;
      SV.server.models[i + 1] = Mod.ForName('*' + i);
    }

    Con.DPrint('Model precache setup complete\n');
  }

  /**
   * Prepares player entities in the client edict slots.
   * @returns {boolean} true if successful, false if game doesn't support player entities
   */
  static #setupPlayerEntities() {
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const ent = SV.server.edicts[i + 1];

      // We need to spawn the player entity in those client edict slots
      if (!SV.server.gameAPI.prepareEntity(ent, 'player')) {
        Con.PrintWarning('SV.SpawnServer: Cannot start server, because game does not know what a player entity is.\n');
        SV.server.active = false;
        return false;
      }
    }

    Con.DPrint('Player entities setup complete\n');

    return true;
  }

  /**
   * Initializes light styles array.
   */
  static #initializeLightStyles() {
    SV.server.lightstyles = [];
    for (let i = 0; i <= Def.limits.lightstyles; i++) {
      SV.server.lightstyles[i] = '';
    }

    Con.DPrint('Light styles initialized\n');
  }

  /**
   * Configures clientdata compression fields for dynamic entity serialization.
   */
  static #setupClientDataFields() {
    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_CLIENTDATA_DYNAMIC)) {
      const fields = SV.server.edicts[1].entity.clientdataFields;

      // Configure clientdata fields
      SV.server.clientdataFields.length = 0;
      SV.server.clientdataFields.push(...fields);
      console.assert(SV.server.clientdataFields.length <= 32, 'clientdata must not have more than 32 fields');

      // Select appropriate bits writer based on field count
      if (fields.length <= 8) {
        SV.server.clientdataFieldsBitsWriter = MSG.WriteByte;
      } else if (fields.length <= 16) {
        SV.server.clientdataFieldsBitsWriter = MSG.WriteShort;
      } else if (fields.length <= 32) {
        SV.server.clientdataFieldsBitsWriter = MSG.WriteLong;
      }

      // Double check that all fields are actually defined
      for (const field of fields) {
        console.assert(SV.server.edicts[1].entity[field] !== undefined, `Undefined clientdata field ${field}`);
      }
    }

    Con.DPrint('Clientdata fields setup complete\n');
  }

  /**
   * Configures extended entity field compression for client-side entities.
   */
  static #setupExtendedEntityFields() {
    if (SV.server.gameCapabilities.includes(Defs.gameCapabilities.CAP_ENTITY_EXTENDED)) {
      const fields = SV.server.gameAPI.getClientEntityFields();

      for (const [classname, extendedFields] of Object.entries(fields)) {
        const clientEntityField = {
          fields: [],
          bitsWriter: null,
        };

        clientEntityField.fields.push(...extendedFields);

        // Select appropriate bits writer based on field count
        if (extendedFields.length <= 8) {
          clientEntityField.bitsWriter = MSG.WriteByte;
        } else if (extendedFields.length <= 16) {
          clientEntityField.bitsWriter = MSG.WriteShort;
        } else if (extendedFields.length <= 32) {
          clientEntityField.bitsWriter = MSG.WriteLong;
        }

        SV.server.clientEntityFields[classname] = clientEntityField;
      }
    }

    Con.DPrint('Extended entity fields setup complete\n');
  }

  /**
   * Spawns the worldspawn entity (edict 0).
   * @returns {boolean} true if successful, false if worldspawn couldn't be created
   */
  static #spawnWorldspawnEntity() {
    const ent = SV.server.edicts[0];

    if (!SV.server.gameAPI.prepareEntity(ent, 'worldspawn', {
      model: SV.server.worldmodel.name,
      modelindex: 1,
      solid: Defs.solid.SOLID_BSP,
      movetype: Defs.moveType.MOVETYPE_PUSH,
    })) {
      Con.PrintWarning('SV.SpawnServer: Cannot start server, because the game does not know what a worldspawn entity is.\n');
      SV.server.active = false;
      return false;
    }

    // Invoke the spawn function for the worldspawn
    SV.server.gameAPI.spawnPreparedEntity(ent);

    Con.DPrint('Worldspawn entity spawned\n');

    return true;
  }

  static async WaitForPrecachedResources() {
    for (let i = 0; i < SV.server.models.length; i++) {
      const model = SV.server.models[i];

      if (model instanceof Promise) {
        // eslint-disable-next-line require-atomic-updates
        SV.server.models[i] = await model;
      }
    }

    Con.DPrint('Pending precached resources loaded\n');
  }

  /**
   * Finalizes server spawn by loading entities and notifying clients.
   * @param {string} mapname name of the spawned map
   */
  static #finalizeServerSpawn(mapname) {
    SV.server.active = true;
    SV.server.loading = false;

    // Run physics twice to settle entities
    Host.frametime = 0.1;
    SV.physics.physics();
    SV.physics.physics();

    // Notify all active clients about the new map
    for (let i = 0; i < SV.svs.maxclients; i++) {
      const client = SV.svs.clients[i];
      if (client.active) {
        SV.messages.sendServerData(client);
      }
    }

    // Initialize navigation
    SV.server.navigation.init();

    eventBus.publish('server.spawned', { mapname });
    Con.PrintSuccess('Server spawned.\n');
    Cmd.ExecuteString('status\n');
  }

  /**
   * Handles a string command from the client.
   * @param {ServerClient} client client sending the command
   * @param {string} input command string
   */
  static #handleClientStringCommand(client, input) {
    const ALLOWED_CLIENT_COMMANDS = [
      'status',
      'god',
      'notarget',
      'fly',
      'name',
      'noclip',
      'say',
      'say_team',
      'tell',
      'color',
      'kill',
      'pause',
      'spawn',
      'begin',
      'prespawn',
      'kick',
      'ping',
      'give',
      'ban',
    ];

    const matchedCommand = ALLOWED_CLIENT_COMMANDS.find((command) =>
      input.toLowerCase().startsWith(command),
    );

    if (matchedCommand) {
      Cmd.ExecuteString(input, client);
    } else {
      Con.Print(`${client.name} tried to ${input}!\n`);
    }
  }

  /**
   * Processes a single client command from the message buffer.
   * @param {ServerClient} client client
   * @param {number} cmd command type
   * @returns {boolean} false if client should disconnect, true otherwise
   */
  static #processClientCommand(client, cmd) {
    switch (cmd) {
      case Protocol.clc.nop:
        Con.DPrint(`${client.netconnection.address} sent a nop\n`);
        return true;

      case Protocol.clc.stringcmd: {
        const input = MSG.ReadString();
        SV.#handleClientStringCommand(client, input);
        return true;
      }

      case Protocol.clc.sync:
        client.sync_time = MSG.ReadFloat();
        return true;

      case Protocol.clc.rconcmd:
        SV.HandleRconRequest(client);
        return true;

      case Protocol.clc.disconnect:
        return false; // Client disconnect

      case Protocol.clc.move:
        SV.ReadClientMove(client);
        return true;

      default:
        Con.Print(`SV.ReadClientMessage: unknown command ${cmd}\n`);
        return false;
    }
  }
};

/**
 * Simple class hooking up all movevars with corresponding cvars.
 */
class PlayerMoveCvars extends MoveVars {
  // @ts-ignore
  get gravity() { return SV.gravity.value; }
  // @ts-ignore
  get stopspeed() { return SV.stopspeed.value; }
  // @ts-ignore
  get maxspeed() { return SV.maxspeed.value; }
  // @ts-ignore
  get spectatormaxspeed() { return SV.spectatormaxspeed.value; }
  // @ts-ignore
  get accelerate() { return SV.accelerate.value; }
  // @ts-ignore
  get airaccelerate() { return SV.airaccelerate.value; }
  // @ts-ignore
  get wateraccelerate() { return SV.wateraccelerate.value; }
  // @ts-ignore
  get friction() { return SV.friction.value; }
  // @ts-ignore
  get waterfriction() { return SV.waterfriction.value; }

  set gravity(_value) { }
  set stopspeed(_value) { }
  set maxspeed(_value) { }
  set spectatormaxspeed(_value) { }
  set accelerate(_value) { }
  set airaccelerate(_value) { }
  set wateraccelerate(_value) { }
  set friction(_value) { }
  set waterfriction(_value) { }

  /**
   * Writes the movevars to the client.
   * @param {SzBuffer} message message stream
   */
  sendToClient(message) {
    MSG.WriteFloat(message, this.gravity);
    MSG.WriteFloat(message, this.stopspeed);
    MSG.WriteFloat(message, this.maxspeed);
    MSG.WriteFloat(message, this.spectatormaxspeed);
    MSG.WriteFloat(message, this.accelerate);
    MSG.WriteFloat(message, this.airaccelerate);
    MSG.WriteFloat(message, this.wateraccelerate);
    MSG.WriteFloat(message, this.friction);
    MSG.WriteFloat(message, this.waterfriction);
    MSG.WriteFloat(message, this.entgravity);
  }

  // CR: leaving out entgravity, it's entity specific
}
