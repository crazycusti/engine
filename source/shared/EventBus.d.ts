
export interface EventBus {
  /**
   * Initializes the event bus with a name.
   * @param {string} name The name of the event bus.
   */
  constructor(name: string): void;

  /**
   * Publishes an event, calling all registered listeners for that event type.
   * NOTE: Make sure to use arguments that are serializable. Events might be sent over the network or/and to Web Workers.
   * @param {string} eventName The event type to trigger.
   * @param {...any} args The arguments to pass to the event listeners.
   */
  publish(eventName: string, ...args: any): void;

  /**
   * Registers an event listener for a specific event type.
   * @param {string} eventName The event type to listen for.
   * @param {Function} listener The function to call when the event is triggered.
   * @returns {Function} A function to remove the listener.
   */
  subscribe(eventName: string, listener: Function): Function;

  /**
   * Unsubscribes from all events.
   */
  unsubscribeAll(): void;

  /** All subscribed topics. */
  get topics(): string[];
};
