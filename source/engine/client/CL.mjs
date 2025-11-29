import MSG from '../network/MSG.mjs';
import Q from '../../shared/Q.mjs';
import * as Def from '../common/Def.mjs';
import * as Protocol from '../network/Protocol.mjs';
import Cmd, { ConsoleCommand } from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import { Pmove, PmovePlayer } from '../common/Pmove.mjs';
import { eventBus, registry } from '../registry.mjs';
import { gameCapabilities } from '../../shared/Defs.mjs';
import ClientDemos from './ClientDemos.mjs';
import { ClientPlayerState } from './ClientMessages.mjs';
import VID from './VID.mjs';
import { clientRuntimeState, clientStaticState } from './ClientState.mjs';
import ClientConnection from './ClientConnection.mjs';
import ClientLifecycle from './ClientLifecycle.mjs';
/** @typedef {import('./Sound.mjs').SFX} SFX */

let { Con, Draw, Host, S, Sbar } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Draw = registry.Draw;
  Host = registry.Host;
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
  /** @type {ClientConnection} */
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

  /** @type {SFX} */ static sfx_talk = null;
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

  static get connection() {
    return CL.#connection;
  }

  static ReadFromServer() {
    CL.connection.readFromServer();
  }

  static ParseServerMessage() {
    CL.connection.parseServerMessage();
  }

  static PrintLastServerMessages() {
    CL.connection.printLastServerMessages();
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
      Draw.BlackScreen();
      Draw.String(VID.width / 2 - 64, VID.height / 2 - 16, 'Loading', 2); // TODO: use the loading graphic
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

  static ServerInfo_f() { // private
    if (CL.cls.state !== CL.active.connected) {
      Con.Print('Can\'t "serverinfo", not connected\n');
      return;
    }

    for (const [key, value] of Object.entries(CL.cls.serverInfo)) {
      Con.Print(`${key}: ${value}\n`);
    }
  }

  static MoveAround_f() { // private
    if (this.cls.state !== this.active.connected) {
      Con.Print('Can\'t "movearound", not connected\n');
      return;
    }

    if (this.cls.signon !== 4) {
      Con.Print('You must wait for the server to send you the map before moving around.\n');
      return;
    }

    if (this.cls.movearound !== null) {
      clearInterval(this.cls.movearound);
      this.cls.movearound = null;
      Con.Print('Stopped moving around.\n');
      return;
    }

    this.cls.movearound = setInterval(() => {
      if (this.cls.state !== this.active.connected) {
        Con.Print('No longer connected, stopped moving around.\n');
        clearInterval(this.cls.movearound);
        this.cls.movearound = null;
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
  }

  static AppendChatMessage(name, message, direct) { // private // TODO: Client
    eventBus.publish('client.chat.message', name, message, direct);

    if (this.gameCapabilities.includes(gameCapabilities.CAP_CHAT_MANAGED)) {
      return;
    }

    if (this.state.chatlog.length > 5) {
      this.state.chatlog.shift();
    }

    this.state.chatlog.push({name, message, direct});
    S.LocalSound(this.sfx_talk);
  }

  static PredictMove() { // public, by Host.js
    this.state.time = Host.realtime - this.state.latency;

    if (this.nopred.value !== 0) {
      return;
    }

    // const playerEntity = this.state.playerentity;
    // if (!playerEntity) { // no player entity, nothing to predict
    //   return;
    // }

    // const from = this.state.playerstate;
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
  }

  /**
   * @param {PmovePlayer} pmove pmove for player
   * @param {ClientPlayerState} from previous state
   * @param {ClientPlayerState} to current state
   * @param {Protocol.UserCmd} u player commands
   */
  static PredictUsercmd(pmove, from, to, u) { // private
    // split long commands
    if (u.msec > 50) {
      const mid = new ClientPlayerState(pmove);
      const split = u.copy();
      split.msec /= 2;
      this.PredictUsercmd(pmove, from, mid, split);
      this.PredictUsercmd(pmove, mid, to, split);
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
  }

  /**
   * Calculate the new position of players, without other player clipping.
   * We do this to set up real player prediction.
   * Players are predicted twice, first without clipping other players,
   * then with clipping against them.
   * This sets up the first phase.
   */
  static SetUpPlayerPrediction() { // public, by Host.js
    // TODO: implement prediction setup once client prediction is refactored.
  }

};
