import { BaseDriver } from './NetworkDrivers.mjs';

/**
 * DriverRegistry - Manages network drivers and handles driver selection
 *
 * Clean separation of concerns: this class owns driver lifecycle and selection logic,
 * removing the need for global driverlevel state mutation.
 */
export class DriverRegistry {
  constructor() {
    /** @type {Record<string, BaseDriver>} */
    this.drivers = {};

    /** @type {BaseDriver[]} */
    this.orderedDrivers = [];
  }

  /**
   * Register a network driver
   * @param {string} name - Unique driver name
   * @param {BaseDriver} driver - Driver instance
   */
  register(name, driver) {
    this.drivers[name] = driver;
    this.orderedDrivers.push(driver);
  }

  /**
   * Get a driver by name
   * @param {string} name - Driver name
   * @returns {BaseDriver|null} driver or null if not found
   */
  get(name) {
    return this.drivers[name] || null;
  }

  /**
   * Select appropriate driver for a given address
   * @param {string} address - address (e.g., "local", "wss://...", "webrtc://...")
   * @returns {BaseDriver|null} suitable driver or null if none found
   */
  getClientDriver(address) {
    // Fallback: try each initialized driver in order
    for (const driver of this.orderedDrivers) {
      if (driver.initialized && driver.canHandle(address)) {
        return driver;
      }
    }

    return null;
  }

  /**
   * Get all initialized drivers
   * @returns {BaseDriver[]} list of initialized drivers
   */
  getInitializedDrivers() {
    return this.orderedDrivers.filter((d) => d.initialized);
  }

  /**
   * Initialize all registered drivers
   */
  initialize() {
    for (const driver of this.orderedDrivers) {
      driver.Init();
    }
  }

  /**
   * Shutdown all drivers
   */
  shutdown() {
    for (const driver of this.orderedDrivers) {
      driver.Shutdown();
    }
  }
}
