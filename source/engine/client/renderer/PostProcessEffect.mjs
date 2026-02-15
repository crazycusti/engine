/**
 * Base class for post-process effects.
 *
 * Each effect receives an input color texture and renders its output into
 * either another FBO (when chaining) or the default framebuffer (when it is
 * the last effect in the pipeline). Subclasses override `apply` to
 * bind their shader, set uniforms, and draw a fullscreen quad.
 *
 * Effects that require the depth texture (e.g. volumetric fog) are handled
 * separately by PostProcess during scene rendering and are not part of
 * this pipeline.
 */
export default class PostProcessEffect {
  /** @type {string} Unique name identifying this effect */
  name;

  /** @type {boolean} Whether this effect is currently enabled */
  active = false;

  /**
   * @param {string} name - Unique identifier for this effect
   */
  constructor(name) {
    this.name = name;
  }

  /**
   * Apply the effect by drawing a fullscreen quad with the appropriate shader.
   * The caller has already bound the correct output framebuffer and viewport.
   * @param {WebGLTexture} _inputTexture - The scene (or previous effect's) color texture
   * @param {number} _x - Viewport x position (screen-space)
   * @param {number} _y - Viewport y position (screen-space)
   * @param {number} _width - Viewport width (screen-space)
   * @param {number} _height - Viewport height (screen-space)
   */
  // eslint-disable-next-line no-unused-vars
  apply(_inputTexture, _x, _y, _width, _height) {
    throw new Error(`PostProcessEffect.apply() not implemented for '${this.name}'`);
  }

  /**
   * Called when the effect's FBO textures need resizing.
   * Override if the effect maintains its own GPU resources that depend on
   * viewport dimensions.
   * @param {number} _width - New width in pixels
   * @param {number} _height - New height in pixels
   */
  // eslint-disable-next-line no-unused-vars
  resize(_width, _height) {
    // Default: no-op. Override if needed.
  }

  /**
   * Initialize GPU resources. Called once during PostProcess.addEffect().
   */
  init() {
    // Default: no-op.
  }

  /**
   * Clean up GPU resources on shutdown.
   */
  shutdown() {
    // Default: no-op.
  }
};
