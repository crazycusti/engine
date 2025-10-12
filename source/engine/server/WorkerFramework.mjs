import { eventBus, registry } from '../registry.mjs';
import { parentPort } from 'node:worker_threads';
import NodeCOM from './Com.mjs';
import Mod from '../common/Mod.mjs';

class Con {
  static Print(message) {
    parentPort.postMessage({
      event: 'worker.con.print',
      data: [message],
    });
  }

  static PrintError(message) {
    parentPort.postMessage({
      event: 'worker.con.print',
      data: [message],
    });
  }

  static PrintWarning(message) {
    parentPort.postMessage({
      event: 'worker.con.print',
      data: [message],
    });
  }

  static DPrint(message) {
    parentPort.postMessage({
      event: 'worker.con.dprint',
      data: [message],
    });
  }
}

class Sys {
  static Print(message) {
    parentPort.postMessage({
      event: 'worker.con.print',
      data: [message],
    });
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
 * Usage: `WorkerFramework.Init();` at the top of the worker script.
 */
export default class WorkerFramework {
  static Init() {
    registry.isDedicatedServer = true;
    registry.Con = Con;
    registry.Sys = Sys;
    registry.COM = NodeCOM;
    registry.Mod = Mod;

    eventBus.publish('registry.frozen');

    eventBus.subscribe('worker.framework.init', (comParams) => {
      NodeCOM.searchpaths = comParams[0];
      NodeCOM.gamedir = comParams[1];
      NodeCOM.game = comParams[2];
    });

    parentPort.on('message', ({ event, args }) => {
      eventBus.publish(event, ...args);
    });
  }

  static Publish(event, ...data) {
    parentPort.postMessage({ event, data });
  }
};
