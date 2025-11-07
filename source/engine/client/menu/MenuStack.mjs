import { eventBus, registry } from '../../registry.mjs';

/**
 * @typedef {import('./MenuPage.mjs').MenuPage} MenuPage
 */

// Destructure registry modules
let { M } = registry;

// Update when registry is frozen
eventBus.subscribe('registry.frozen', () => {
  ({ M } = registry);
});

/**
 * Stack-based menu navigation system
 */
export class MenuStack {
  constructor() {
    /** @type {MenuPage[]} */
    this.stack = [];
    /** @type {Map<string, MenuPage>} Named page registry */
    this.pages = new Map();
  }

  /**
   * Register a named page
   * @param {string} name - Page identifier
   * @param {MenuPage} page - Page instance
   */
  register(name, page) {
    this.pages.set(name, page);
  }

  /**
   * Push a page onto the stack
   * @param {MenuPage|string} pageOrName - Page instance or registered name
   */
  push(pageOrName) {
    // Deactivate current page
    const current = this.current();
    if (current) {
      current.deactivate();
    }

    // Resolve page
    const page = typeof pageOrName === 'string' ?
      this.pages.get(pageOrName) : pageOrName;

    if (!page) {
      console.error('MenuStack: Page not found:', pageOrName);
      return;
    }

    // Push and activate
    this.stack.push(page);
    page.activate();
    M.entersound = true;
  }

  /**
   * Pop the current page
   * @returns {MenuPage|null} The popped page
   */
  pop() {
    if (this.stack.length === 0) {
      return null;
    }

    const page = this.stack.pop();
    page.deactivate();

    // Activate new current page
    const current = this.current();
    if (current) {
      current.activate();
      M.entersound = true;
    }

    return page;
  }

  /**
   * Get current page without removing it
   * @returns {MenuPage|null} The current page or null if stack is empty
   */
  current() {
    return this.stack.length > 0 ?
      this.stack[this.stack.length - 1] : null;
  }

  /**
   * Clear the entire stack
   */
  clear() {
    while (this.stack.length > 0) {
      const page = this.stack.pop();
      page.deactivate();
    }
  }

  /**
   * Get stack depth
   * @returns {number} Number of pages in stack
   */
  depth() {
    return this.stack.length;
  }

  /**
   * Check if stack is empty
   * @returns {boolean} True if stack has no pages
   */
  isEmpty() {
    return this.stack.length === 0;
  }

  /**
   * Replace current page with a new one
   * @param {MenuPage|string} pageOrName - Page instance or registered name
   */
  replace(pageOrName) {
    if (this.stack.length > 0) {
      this.pop();
    }
    this.push(pageOrName);
  }

  /**
   * Pop to a specific page depth
   * @param {number} depth - Target depth
   */
  popTo(depth) {
    while (this.stack.length > depth && this.stack.length > 0) {
      this.pop();
    }
  }

  /**
   * Pop to root (main menu)
   */
  popToRoot() {
    this.popTo(1);
  }
}
