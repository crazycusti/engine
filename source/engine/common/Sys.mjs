import { NotImplementedError } from './Errors.mjs';

/** Base class for Sys implementations. */
export default class Sys {
  static async Init() {
    throw new NotImplementedError('Sys.Init must be implemented in a subclass');
  }

  static Quit() {
    throw new NotImplementedError('Sys.Quit must be implemented in a subclass');
  }

  // eslint-disable-next-line no-unused-vars
  static Print(text) {
    throw new NotImplementedError('Sys.Print must be implemented in a subclass');
  }

  /** @returns {number} uptime in seconds */
  static FloatTime() {
    throw new NotImplementedError('Sys.GetTime must be implemented in a subclass');
    // eslint-disable-next-line no-unreachable
    return 0;
  }

  /** @returns {number} uptime in milliseconds, containing microseconds */
  static FloatMilliTime() {
    throw new NotImplementedError('Sys.FloatMilliTime must be implemented in a subclass');
    // eslint-disable-next-line no-unreachable
    return 0;
  }

  /**
   * Spawns a worker thread and sets up event forwarding.
   * @param {string} script Path to worker script
   * @param {string[]} events list of events the worker wants to subscribe to
   * @returns {import('../server/WorkerManager.mjs').WorkerThread} worker thread wrapper
   */
  // eslint-disable-next-line no-unused-vars
  static SpawnWorker(script, events) {
    throw new NotImplementedError('Sys.SpawnWorker must be implemented in a subclass');
    // eslint-disable-next-line no-unreachable
    return null;
  }
};
