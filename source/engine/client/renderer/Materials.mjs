import { eventBus, registry } from '../../registry.mjs';
import { ClientEdict } from '../ClientEntities.mjs';
import { GLTexture } from '../GL.mjs';

let { CL, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  R = registry.R;
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

  diffuseTextures = /** @type {GLTexture[]} */ ([]);
  specularTextures = /** @type {GLTexture[]} */ ([]);
  normalTextures = /** @type {GLTexture[]} */ ([]);
  luminanceTextures = /** @type {GLTexture[]} */ ([]);

  /** @deprecated */ get glt() {
    return this.diffuse;
  }

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

  get diffuse() {
    return this.diffuseTextures[0] || null;
  }

  get specular() {
    return this.specularTextures[0] || null;
  }

  get normal() {
    return this.normalTextures[0] || null;
  }

  get luminance() {
    return this.luminanceTextures[0] || null;
  }

  emit(/** @type {ClientEdict?} */ clientEdict = null) {
  }

  free() {
    for (const t of this.diffuseTextures) {
      if (t) {
        t.free();
      }
    }

    this.diffuseTextures.length = 0;

    for (const t of this.specularTextures) {
      if (t) {
        t.free();
      }
    }

    this.specularTextures.length = 0;

    for (const t of this.normalTextures) {
      if (t) {
        t.free();
      }
    }

    this.normalTextures.length = 0;

    for (const t of this.luminanceTextures) {
      if (t) {
        t.free();
      }
    }

    this.luminanceTextures.length = 0;
  }

  [Symbol.dispose]() { // make sure we always free resources
    this.free();
  }
};

export class QuakeMaterial extends BaseMaterial {
  #frames = /** @type {number} */ (1);
  #alternateFrames = /** @type {number} */ (0);

  #frame = 0;

  /** @deprecated */ get glt() {
    return this.diffuseTextures[this.#frame] || null;
  }

  set glt (value) {
    this.diffuseTextures = [value];
  }

  addAnimationFrame(num, frameTexture) {
    this.#frames = Math.max(this.#frames, num + 1);
    this.diffuseTextures[num] = frameTexture;
  }

  addAlternateFrame(num, frameTexture) {
    this.#alternateFrames = Math.max(this.#alternateFrames, num + 1);
    this.diffuseTextures[num + 10] = frameTexture;
  }

  emit(/** @type {ClientEdict} */ clientEdict = null) {
    const frame = Math.floor((clientEdict !== null ? clientEdict.frame : 0) + CL.state.time * 5.0);
    const useAlternate = (clientEdict !== null && clientEdict.frame > 0 && this.#alternateFrames > 0);

    if (useAlternate) {
      this.#frame = 10 + (frame % this.#alternateFrames);
    } else {
      this.#frame = frame % this.#frames;
    }
  }
};

class NoTextureMaterial extends BaseMaterial {
  constructor(name, width, height) {
    super(name, width, height);

    eventBus.subscribe('renderer.textures.initialized', () => {
      this.diffuseTextures = [R.notexture];
    });
  }

  free() {
    // do nothing, shared texture
  }
};

export const noTextureMaterial = new NoTextureMaterial('notexture', 16, 16);
