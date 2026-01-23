import { eventBus, registry } from '../registry.mjs';
import Mod from './Mod.mjs';
import Sys from './Sys.mjs';

class Con {
  static Print(message) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static PrintError(message) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static PrintWarning(message) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static DPrint(message) {
    WorkerFramework.Publish('worker.con.dprint', message);
  }
}

class WorkerSys extends Sys {
  static Print(message) {
    WorkerFramework.Publish('worker.con.print', message);
  }

  static FloatTime() {
    return Date.now() / 1000;
  }
}

/**
 * Worker Framework
 *
 * Initializes the worker framework, setting up the registry and event bus.
 * Listens for messages from the parent thread and publishes them to the event bus.
 *
 * Also prepares lean versions of Con, Sys, and COM for use within the worker.
 *
 * Usage: `await WorkerFramework.Init();` at the top of the worker script.
 */
export default class WorkerFramework {
  static port = null;

  static #InitRegistry(COM) {
    registry.isDedicatedServer = true;
    registry.isInsideWorker = true;
    registry.Con = Con;
    registry.Sys = WorkerSys;
    registry.COM = COM;
    registry.Mod = Mod;

    eventBus.publish('registry.frozen');
  }

  static #InitModules() {
    Mod.Init();
  }

  static async Init() {
    let COM;
    const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

    if (isNode) {
      const { parentPort } = await import('node:worker_threads');
      this.port = parentPort;
      const comModule = await import('../server/Com.mjs');
      COM = comModule.default;

      this.port.on('message', ({ event, args }) => {
        eventBus.publish(event, ...args);
      });
    } else {
      this.port = self;
      const comModule = await import('./Com.mjs');
      COM = comModule.default;

      this.port.addEventListener('message', (e) => {
        const { event, args } = e.data;
        eventBus.publish(event, ...args);
      });
    }

    this.#InitRegistry(COM);
    this.#InitModules();

    eventBus.subscribe('worker.framework.init', (comParams) => {
      COM.searchpaths = comParams[0];
      COM.gamedir = comParams[1];
      COM.game = comParams[2];
    });

    console.log('Worker Framework initialized.');
  }

  static Publish(event, ...data) {
    this.port.postMessage({ event, data });
  }
};

