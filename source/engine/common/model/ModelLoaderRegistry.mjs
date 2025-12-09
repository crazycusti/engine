import { NotImplementedError } from '../Errors.mjs';

/**
 * Registry for managing model format loaders.
 * Provides automatic format detection and routing to the appropriate loader.
 */
export class ModelLoaderRegistry {
  constructor() {
    /** @type {import('./ModelLoader.mjs').ModelLoader[]} */
    this.loaders = [];
  }

  /**
   * Register a model loader.
   * Loaders are checked in the order they are registered.
   * @param {import('./ModelLoader.mjs').ModelLoader} loader The loader to register
   */
  register(loader) {
    this.loaders.push(loader);
  }

  /**
   * Find a loader that can handle the given buffer/filename.
   * @param {ArrayBuffer} buffer The file buffer
   * @param {string} filename The filename
   * @returns {import('./ModelLoader.mjs').ModelLoader|null} The loader, or null if none found
   */
  findLoader(buffer, filename) {
    for (const loader of this.loaders) {
      if (loader.canLoad(buffer, filename)) {
        return loader;
      }
    }
    return null;
  }

  /**
   * Load a model using the appropriate loader.
   * @param {ArrayBuffer} buffer The file buffer
   * @param {string} name The model name/path
   * @returns {Promise<import('./BaseModel.mjs').BaseModel>} The loaded model
   * @throws {NotImplementedError} If no suitable loader is found
   */
  async load(buffer, name) {
    const loader = this.findLoader(buffer, name);

    if (!loader) {
      throw new NotImplementedError(`No loader found for model format: ${name}`);
    }

    return await loader.load(buffer, name);
  }

  /**
   * Get all registered loaders.
   * @returns {import('./ModelLoader.mjs').ModelLoader[]} Array of loaders
   */
  getLoaders() {
    return [...this.loaders];
  }

  /**
   * Clear all registered loaders.
   */
  clear() {
    this.loaders.length = 0;
  }
};
