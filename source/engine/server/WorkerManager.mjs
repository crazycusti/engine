
import { Worker } from 'node:worker_threads';
import { registry, eventBus } from '../registry.mjs';
import { SysError } from '../common/Errors.mjs';

let { Con, COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
});

/** Worker wrapper class to manage it. */
export class WorkerThread {
  /**
   * @param {Worker} worker worker
   */
  constructor(worker) {
    this.worker = worker;
  }

  /**
   * Shuts down the worker thread.
   * @returns {Promise<boolean>} true if terminated without error
   */
  async shutdown() {
    return await this.worker.terminate() === 0;
  }
}

export default class WorkerManager {
  static Init() {
    eventBus.subscribe('com.ready', () => {
      const worker = this.SpawnWorker('server/DummyWorker.mjs', ['worker.test']);

      worker.shutdown().then((success) => {
        if (!success) {
          Con.PrintWarning('WorkerManager: Dummy worker shut down with errors.\n');
        }
      });
    });
  }

  /**
   * Spawns a worker thread and sets up event forwarding.
   * @param {string} script Path to worker script
   * @param {string[]} events list of events the worker wants to subscribe to
   * @returns {WorkerThread} worker thread wrapper
   */
  static SpawnWorker(script, events) {
    const worker = new Worker(`./source/engine/${script}`, {
      name: script,
    });

    // worker thread --> main thread
    worker.on('message', ({ event, data }) => {
      // Handle special events directly, otherwise publish to event bus
      switch (event) {
        case 'worker.con.print':
          Con.Print(data[0]);
          break;

        case 'worker.con.dprint':
          Con.DPrint(data[0]);
          break;

        default:
          eventBus.publish(event, ...data);
          break;
      }
    });

    worker.on('error', (error) => {
      throw new SysError(`Worker error in ${script}: ${error.message}`);
    });

    /** all subscribed events need to be unsubscribed once the worker finished */
    const unsubscribeFunctions = [];

    // eslint-disable-next-line no-unused-vars
    worker.on('exit', (code) => {
      for (const unsubscribe of unsubscribeFunctions) {
        unsubscribe();
      }
    });

    // Initial worker framework setup
    worker.postMessage({
      event: 'worker.framework.init',
      args: [
        [COM.searchpaths, COM.gamedir, COM.game], // COM
      ],
    });

    // main thread --> worker thread
    for (const event of events) {
      unsubscribeFunctions.push(eventBus.subscribe(event, (...args) => {
        worker.postMessage({
          event,
          args,
        });
      }));
    }

    return new WorkerThread(worker);
  }
};
