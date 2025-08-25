import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../../shared/Q.mjs';
import { eventBus, registry } from '../registry.mjs';

let { COM, Con, S } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  S = registry.S;
});

export default class CDAudio {
  /** @type {Function[]} */
  static #eventListeners = [];
  static initialized = false;
  static enabled = false;
  static playTrack = null;
  /** @type {HTMLAudioElement} */
  static cd = null;
  static cdvolume = 1.0;

  static Play(track, looping) {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.playTrack === track) {
      if (CDAudio.cd !== null) {
        CDAudio.cd.loop = looping;
        if (looping === true && CDAudio.cd.paused === true) {
          CDAudio.cd.play(); // FIXME: await
        }
      }
      return;
    }
    CDAudio.Stop();
    CDAudio.playTrack = track;
    CDAudio.cd = new Audio(`quakefs/music/${track}.opus`);
    CDAudio.cd.loop = looping;
    CDAudio.cd.volume = CDAudio.cdvolume;
    CDAudio.cd.play().catch((e) => {
      Con.PrintWarning(`Could not play track ${track}: ${e}\n`);
      CDAudio.Stop();
    });
  }

  static Stop() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
    CDAudio.playTrack = null;
    CDAudio.cd = null;
  }

  static Pause() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
    }
  }

  static Resume() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.play(); // FIXME: await
    }
  }

  static CD_f(command, track) {
    if (!CDAudio.initialized) {
      Con.PrintWarning('CD Audio not initialized\n');
      return;
    }
    switch (new String(command).toLowerCase()) {
      case 'on':
        CDAudio.enabled = true;
        return;
      case 'off':
        CDAudio.Stop();
        CDAudio.enabled = false;
        return;
      case 'play':
        CDAudio.Play(Q.atoi(track), false);
        return;
      case 'loop':
        CDAudio.Play(Q.atoi(track), true);
        return;
      case 'stop':
        CDAudio.Stop();
        return;
      case 'pause':
        CDAudio.Pause();
        return;
      case 'resume':
        CDAudio.Resume();
        return;
      case 'info':
        if (CDAudio.cd !== null) {
          if (CDAudio.cd.paused !== true) {
            Con.Print('Currently ' + (CDAudio.cd.loop === true ? 'looping' : 'playing') + ' ' + (new URL(CDAudio.cd.src).pathname) + '\n');
          }
        }
        Con.Print('Volume is ' + CDAudio.cdvolume + '\n');
        return;
      default:
        Con.Print('Unknown command.  Commands are on, off, play, loop, stop, pause, resume, info\n');
        return;
    }
  }

  static Update() {
    if (CDAudio.initialized !== true || CDAudio.enabled !== true) {
      return;
    }
    if (S.bgmvolume.value === CDAudio.cdvolume) {
      return;
    }
    if (S.bgmvolume.value < 0.0) {
      Cvar.Set('bgmvolume', 0.0);
    } else if (S.bgmvolume.value > 1.0) {
      Cvar.Set('bgmvolume', 1.0);
    }
    CDAudio.cdvolume = S.bgmvolume.value;
    if (CDAudio.cd !== null) {
      CDAudio.cd.volume = CDAudio.cdvolume;
    }
  }

  static async Init() {
    Cmd.AddCommand('cd', CDAudio.CD_f.bind(CDAudio));
    if (COM.CheckParm('-nocdaudio')) {
      return;
    }
    CDAudio.initialized = CDAudio.enabled = true;
    CDAudio.Update();
    CDAudio.#eventListeners.push(eventBus.subscribe('client.cdtrack', (track) => CDAudio.Play(track, true)));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.paused', () => CDAudio.Pause()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.unpaused', () => CDAudio.Resume()));
    CDAudio.#eventListeners.push(eventBus.subscribe('client.disconnected', () => CDAudio.Stop()));
    Con.Print('CD Audio Initialized\n');
  }

  static Shutdown() {
    for (const unsubscribe of CDAudio.#eventListeners) {
      unsubscribe();
    }
    if (CDAudio.cd !== null) {
      CDAudio.cd.pause();
      CDAudio.cd = null;
    }
    CDAudio.playTrack = null;
    CDAudio.initialized = false;
    CDAudio.enabled = false;
  }
};
