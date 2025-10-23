/**
 * Registry for model renderers.
 * Maps model types to their corresponding renderer implementations.
 */
export class ModelRendererRegistry {
  constructor() {
    /** @type {Map<number, import('./ModelRenderer.mjs').ModelRenderer>} Map of model type to renderer */
    this._renderers = new Map();
  }

  /**
   * Register a renderer for a specific model type
   * @param {import('./ModelRenderer.mjs').ModelRenderer} renderer The renderer instance
   */
  register(renderer) {
    /** @type {number} */
    const modelType = renderer.getModelType();
    if (this._renderers.has(modelType)) {
      console.warn(`ModelRendererRegistry: Renderer for type ${modelType} already registered, replacing`);
    }
    this._renderers.set(modelType, renderer);
  }

  /**
   * Get the renderer for a specific model type
   * @param {number} modelType The model type constant
   * @returns {import('./ModelRenderer.mjs').ModelRenderer|null} The renderer or null if not found
   */
  getRenderer(modelType) {
    return this._renderers.get(modelType) || null;
  }

  /**
   * Check if a renderer is registered for a model type
   * @param {number} modelType The model type constant
   * @returns {boolean} True if renderer is registered
   */
  hasRenderer(modelType) {
    return this._renderers.has(modelType);
  }

  /**
   * Unregister a renderer for a specific model type
   * @param {number} modelType The model type constant
   * @returns {boolean} True if renderer was unregistered
   */
  unregister(modelType) {
    return this._renderers.delete(modelType);
  }

  /**
   * Clear all registered renderers
   */
  clear() {
    this._renderers.clear();
  }

  /**
   * Get all registered model types
   * @returns {number[]} Array of model type constants
   */
  getRegisteredTypes() {
    return Array.from(this._renderers.keys());
  }
}

/** @type {ModelRendererRegistry} Singleton instance */
export const modelRendererRegistry = new ModelRendererRegistry();
