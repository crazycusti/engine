import GL from '../GL.mjs';
import PostProcessEffect from './PostProcessEffect.mjs';
import { eventBus, registry } from '../../registry.mjs';

let { Host } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ Host } = registry);
});

/** @type {WebGL2RenderingContext} */
let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Underwater warp distortion post-process effect.
 *
 * Applies a sinusoidal coordinate warp with a 3x3 Gaussian blur,
 * simulating the visual distortion seen when the camera is submerged
 * in water, slime, or lava.
 *
 * This replaces the previous R.WarpScreen / R.warpbuffer implementation.
 * The warp FBO, texture, and renderbuffer are now owned by this effect.
 */
export default class WarpEffect extends PostProcessEffect {
  /** @type {WebGLFramebuffer} Warp scene FBO — scene renders here when warp is the only post-process */
  static fbo = null;

  /** @type {WebGLTexture} Color texture for the warp FBO */
  static texture = null;

  /** @type {WebGLRenderbuffer} Depth renderbuffer for the warp FBO */
  static renderbuffer = null;

  /** @type {number} Current FBO width in pixels */
  static width = 0;

  /** @type {number} Current FBO height in pixels */
  static height = 0;

  constructor() {
    super('warp');
  }

  /**
   * Create the warp FBO, color texture, and depth renderbuffer.
   */
  init() {
    WarpEffect.fbo = gl.createFramebuffer();

    WarpEffect.texture = gl.createTexture();
    GL.Bind(0, WarpEffect.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    WarpEffect.renderbuffer = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, WarpEffect.renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 0, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, WarpEffect.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, WarpEffect.texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, WarpEffect.renderbuffer);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Resize the warp FBO to match the given dimensions, clamped to 2048.
   * @param {number} width - New width in pixels
   * @param {number} height - New height in pixels
   */
  resize(width, height) {
    const w = Math.min(width, 2048);
    const h = Math.min(height, 2048);

    if (WarpEffect.width === w && WarpEffect.height === h) {
      return;
    }

    WarpEffect.width = w;
    WarpEffect.height = h;

    GL.Bind(0, WarpEffect.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindRenderbuffer(gl.RENDERBUFFER, WarpEffect.renderbuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  /**
   * Apply the warp distortion effect by drawing a fullscreen quad with
   * the 'warp' shader.
   * @param {WebGLTexture} inputTexture - Scene color texture to distort
   * @param {number} x - Viewport x position
   * @param {number} y - Viewport y position
   * @param {number} width - Viewport width
   * @param {number} height - Viewport height
   */
  apply(inputTexture, x, y, width, height) {
    const program = GL.UseProgram('warp');
    GL.Bind(program.tTexture, inputTexture);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
    GL.StreamDrawTexturedQuad(x, y, width, height, 0.0, 1.0, 1.0, 0.0);
    GL.StreamFlush();
  }

  /**
   * Clean up all GPU resources.
   */
  shutdown() {
    if (WarpEffect.fbo) {
      gl.deleteFramebuffer(WarpEffect.fbo);
      WarpEffect.fbo = null;
    }
    if (WarpEffect.texture) {
      gl.deleteTexture(WarpEffect.texture);
      WarpEffect.texture = null;
    }
    if (WarpEffect.renderbuffer) {
      gl.deleteRenderbuffer(WarpEffect.renderbuffer);
      WarpEffect.renderbuffer = null;
    }
    WarpEffect.width = 0;
    WarpEffect.height = 0;
    this.active = false;
  }
};
