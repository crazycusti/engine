import { BaseModel } from './BaseModel.mjs';

/**
 * Sprite model (.spr) - Quake's 2D billboard sprite format.
 * Used for explosions, particles, and other effects that always face the camera.
 */
export class SpriteModel extends BaseModel {
  constructor(name) {
    super(name);
    this.type = 1; // Mod.type.sprite
  }

  reset() {
    super.reset();

    /** @type {boolean} Whether sprite orientation is fixed or faces camera */
    this.oriented = false;

    /** @type {number} Bounding sphere radius */
    this.boundingradius = 0;

    /** @type {number} Sprite width */
    this.width = 0;

    /** @type {number} Sprite height */
    this.height = 0;

    /** @type {number} Number of frames in file (used during loading) */
    this._frames = 0;

    /** @type {Array} Sprite frames (single or groups) */
    this.frames = [];

    /** @type {boolean} Random frame selection */
    this.random = false;

    /** @type {number} Total number of frames */
    this.numframes = 0;
  }
}
