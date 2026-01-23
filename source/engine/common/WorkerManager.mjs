import { registry, eventBus } from '../registry.mjs';
import { SysError } from './Errors.mjs';

let { Con, COM, Sys } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  Sys = registry.Sys;
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
    if (!this.worker) {
      return true;
    }

    const result = this.worker.terminate();
    this.worker = null; // clear reference right away

    // @ts-ignore
    if (result instanceof Promise) {
      // @ts-ignore
      return (await result) === 0;
    }

    return true;
  }
}

export default class WorkerManager {
  static Init() {
    eventBus.subscribe('com.ready', () => {
      // console.log('WorkerManager: Spawning dummy worker for initialization test.');
      // const worker = this.SpawnWorker('server/DummyWorker.mjs', ['worker.test', 'worker.busy']);

      // worker.shutdown().then((success) => {
      //   if (!success) {
      //     Con.PrintWarning('WorkerManager: Dummy worker shut down with errors.\n');
      //   }
      // }).catch((err) => {
      //   Con.PrintError(`Failed to shutdown the dummy worker: ${err}\n`);
      // });
    });
  }

  /**
   * Spawns a worker thread and sets up event forwarding.
   * @param {string} script Path to worker script
   * @param {string[]} events list of events the worker wants to subscribe to
   * @returns {WorkerThread} worker thread wrapper
   */
  static SpawnWorker(script, events) {
    const worker = Sys.CreateWorker(script);

    // worker thread --> main thread
    const onMessage = ({ event, data }) => {
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
    };

    /** all subscribed events need to be unsubscribed once the worker finished */
    const unsubscribeFunctions = [];
    const cleanup = () => {
      for (const unsubscribe of unsubscribeFunctions) {
        unsubscribe();
      }
      unsubscribeFunctions.length = 0;
    };

    if (!registry.isDedicatedServer) {
      // Browser
      worker.addEventListener('message', (e) => onMessage(e.data));
      worker.addEventListener('error', (e) => {
        console.error(e);
        throw new SysError(`Worker error in ${script}: ${e.message}`);
      });
    } else {
      // Node
      worker.on('message', onMessage);
      worker.on('error', (error) => {
        debugger;
        throw new SysError(`Worker error in ${script}: ${error.message}`);
      });
      // eslint-disable-next-line no-unused-vars
      worker.on('exit', (code) => {
        cleanup();
      });
    }

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

    const thread = new WorkerThread(worker);
    // overload shutdown to cleanup listeners
    const originalShutdown = thread.shutdown.bind(thread);
    // eslint-disable-next-line @typescript-eslint/require-await
    thread.shutdown = async () => {
      cleanup();
      return originalShutdown();
    };

    return thread;
  }
};

