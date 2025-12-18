import { eventBus, registry } from '../../registry.mjs';
import { ClientEdict } from '../ClientEntities.mjs';
import GL, { GLTexture } from '../GL.mjs';

let { CL, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  R = registry.R;
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

export const materialFlags = Object.freeze({
  MF_NONE: 0,
  MF_TRANSPARENT: 1,
  MF_SKY: 2,
  MF_TURBULENT: 4,
});

/**
 * A class representing a material.
 * It holds various properties like texture, flags, etc.
 * Also responsible for managing animations etc.
 */
export class BaseMaterial {
  flags = /** @type {number} */ (materialFlags.MF_NONE);
  name = /** @type {string} */ (null);
  width = /** @type {number} */ (0);
  height = /** @type {number} */ (0);

  /**
   * @param {string} name name
   * @param {number} width width
   * @param {number} height height
   */
  constructor(name, width, height) {
    this.name = name;
    this.width = width;
    this.height = height;
  }

  // eslint-disable-next-line no-unused-vars
  bindTo(program) {
    // to be implemented by subclasses
  }

  // eslint-disable-next-line no-unused-vars
  emit(/** @type {ClientEdict?} */ clientEdict = null) {
    // to be implemented by subclasses
  }

  free() {
    // to be implemented by subclasses
  }

  [Symbol.dispose]() { // make sure we always free resources
    this.free();
  }
};

/**
 * A class representing a Quake-style material with animation frames.
 * It supports multiple frames and alternate frames for different states.
 * No support for PBR or advanced features.
 */
export class QuakeMaterial extends BaseMaterial {
  #textures = /** @type {GLTexture[]} */ ([]);

  #frames = /** @type {number} */ (1);
  #alternateFrames = /** @type {number} */ (0);

  #frame = 0;
  #nextFrame = 0;

  bindTo(program) {
    gl.uniform1i(program.uPerformDotLighting, 0);
    gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);

    if (program.tTextureA !== undefined && program.tTextureB !== undefined) {
      this.#textures[this.#frame].bind(program.tTextureA);
      this.#textures[this.#nextFrame].bind(program.tTextureB);
      R.c_brush_texture_binds += 2;
    }

    if (program.tTexture !== undefined) {
      this.#textures[this.#frame].bind(program.tTexture);
      R.c_brush_texture_binds++;
    }

    // TODO: this could be the full bright map
    if (program.tLuminance !== undefined) {
      R.blacktexture.bind(program.tLuminance);
      R.c_brush_texture_binds++;
    }
  }

  set texture(texture) {
    this.#textures[0] = texture;
    this.#textures.length = 1;
  }

  get texture() {
    return this.#textures[0] || null;
  }

  addAnimationFrame(num, frameTexture) {
    this.#frames = Math.max(this.#frames, num + 1);
    this.#textures[num] = frameTexture;
  }

  addAlternateFrame(num, frameTexture) {
    this.#alternateFrames = Math.max(this.#alternateFrames, num + 1);
    this.#textures[num + 10] = frameTexture;
  }

  emit(/** @type {ClientEdict} */ clientEdict = null) {
    const frame = Math.floor((clientEdict !== null ? clientEdict.frame : 0) + CL.state.time * 5.0);
    const useAlternate = (clientEdict !== null && clientEdict.frame > 0 && this.#alternateFrames > 0);

    if (useAlternate) {
      this.#frame = 10 + (frame % this.#alternateFrames);
      this.#nextFrame = 10 + ((frame + 1) % this.#alternateFrames);
    } else {
      this.#frame = frame % this.#frames;
      this.#nextFrame = (frame + 1) % this.#frames;
    }
  }

  free() {
    for (const tex of this.#textures) {
      tex.free();
    }

    this.#textures.length = 0;
  }
};

/**
 * A class representing a PBR material.
 */
export class PBRMaterial extends BaseMaterial {
  luminance = /** @type {GLTexture} */ (null);
  diffuse = /** @type {GLTexture} */ (null);
  specular = /** @type {GLTexture} */ (null);
  normal = /** @type {GLTexture} */ (null);

  constructor(name, width, height) {
    super(name, width, height);

    this.diffuse = R.notexture;
    this.luminance = R.blacktexture;
    this.specular = R.blacktexture;
    this.normal = R.flatnormalmap;
  }

  bindTo(program) {
    if (program.uPerformDotLighting !== undefined) {
      gl.uniform1i(program.uPerformDotLighting, 1);
    }

    if (program.uAlpha !== undefined) {
      gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    }

    if (program.tTexture !== undefined) {
      this.diffuse.bind(program.tTexture);
      R.c_brush_texture_binds++;
    }

    if (program.tTextureA !== undefined) {
      this.diffuse.bind(program.tTextureA);
      R.c_brush_texture_binds++;
    }

    if (program.tTextureB !== undefined) {
      this.diffuse.bind(program.tTextureB);
      R.c_brush_texture_binds++;
    }

    if (program.tSpecular !== undefined) {
      this.specular.bind(program.tSpecular);
      R.c_brush_texture_binds++;
    }

    if (program.tNormal !== undefined) {
      this.normal.bind(program.tNormal);
      R.c_brush_texture_binds++;
    }

    if (program.tLuminance !== undefined) {
      this.luminance.bind(program.tLuminance);
      R.c_brush_texture_binds++;
    }
  }

  free() {
    if (this.diffuse !== R.notexture) {
      this.diffuse.free();
    }

    if (this.luminance !== R.blacktexture) {
      this.luminance.free();
    }

    if (this.specular !== R.blacktexture) {
      this.specular.free();
    }

    if (this.normal !== R.flatnormalmap) {
      this.normal.free();
    }
  }
};

class NoTextureMaterial extends BaseMaterial {
  constructor() {
    super('notexture', 16, 16);
  }

  bind() {
    R.notexture.bind(0);
  }
}

export const noTextureMaterial = new NoTextureMaterial();
