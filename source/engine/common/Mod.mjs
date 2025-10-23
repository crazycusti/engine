import Vector from '../../shared/Vector.mjs';
import GL from '../client/GL.mjs';
import { eventBus, registry } from '../registry.mjs';
import { MissingResourceError } from './Errors.mjs';
import Q from '../../shared/Q.mjs';
import { modelLoaderRegistry } from './model/ModelLoaderRegistry.mjs';
import { AliasMDLLoader } from './model/loaders/AliasMDLLoader.mjs';
import { SpriteSPRLoader } from './model/loaders/SpriteSPRLoader.mjs';
import { BSP29Loader } from './model/loaders/BSP29Loader.mjs';

/** @typedef {import('./model/BaseModel.mjs').BaseModel} BaseModel */

const Mod = {};

export default Mod;

let { COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Mod.BaseModel - See model/BaseModel.mjs
 * Mod.BrushModel - See model/BSP.mjs
 * Mod.SpriteModel - See model/SpriteModel.mjs
 * Mod.AliasModel - See model/AliasModel.mjs
 */

// Re-export model classes for backward compatibility
export { AliasModel } from './model/AliasModel.mjs';
export { BrushModel } from './model/BSP.mjs';
export { SpriteModel } from './model/SpriteModel.mjs';

Mod.type = { brush: 0, sprite: 1, alias: 2 };

Mod.hull = {
  /** hull0, point intersection */
  normal: 0,
  /** hull1, testing for player (32, 32, 56) */
  player: 1,
  /** hull2, testing for large objects (64, 64, 88) */
  big: 2,
  /** hull3, only used by BSP30 for crouching etc. (32, 32, 36) */
  crouch: 3,
};

Mod.version = { brush: 29, sprite: 1, alias: 6, bsp2: 844124994 };

Mod.known = [];

// Initialize model loader registry at module load time
// This must happen before any models are loaded
(function initializeLoaders() {
  const aliasLoader = new AliasMDLLoader();
  const spriteLoader = new SpriteSPRLoader();
  const bsp29Loader = new BSP29Loader();

  // BSP29Loader needs access to Mod's helper functions
  // We need to defer this until after all Mod functions are defined
  // So we'll use a lazy initialization approach
  let modReferenceSet = false;
  const originalLoad = bsp29Loader.load.bind(bsp29Loader);
  bsp29Loader.load = function (buffer, name, loadmodel) {
    if (!modReferenceSet) {
      bsp29Loader.setModReference(Mod);
      modReferenceSet = true;
    }
    return originalLoad(buffer, name, loadmodel);
  };

  modelLoaderRegistry.register(bsp29Loader);
  modelLoaderRegistry.register(aliasLoader);
  modelLoaderRegistry.register(spriteLoader);
})();

Mod.Init = function () {
  Mod.novis = new Array(1024);
  Mod.novis.fill(0xff);
};

Mod.PointInLeaf = function (p, model) { // public method, static access? (PF, R, S use it)
  // eslint-disable-next-line eqeqeq
  if (model == null) {
    throw new Error('Mod.PointInLeaf: bad model');
  }
  // eslint-disable-next-line eqeqeq
  if (model.nodes == null) {
    throw new Error('Mod.PointInLeaf: bad model');
  }
  let node = model.nodes[0];
  let normal;
  for (; ;) {
    if (node.contents < 0) {
      return node;
    }
    normal = node.plane.normal;
    if ((p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] - node.plane.dist) > 0) {
      node = node.children[0];
    } else {
      node = node.children[1];
    }
  }
};

Mod.DecompressVis = function (i, model) { // private method
  const decompressed = []; let c; let out = 0; let row = (model.leafs.length + 7) >> 3;
  // eslint-disable-next-line eqeqeq
  if (model.visdata == null) {
    for (; row >= 0; --row) {
      decompressed[out++] = 0xff;
    }
    return decompressed;
  }
  for (out = 0; out < row;) {
    if (model.visdata[i] !== 0) {
      decompressed[out++] = model.visdata[i++];
      continue;
    }
    for (c = model.visdata[i + 1]; c > 0; --c) {
      decompressed[out++] = 0;
    }
    i += 2;
  }
  return decompressed;
};

Mod.LeafPVS = function (leaf, model) {
  if (leaf === model.leafs[0]) {
    return Mod.novis;
  }
  return Mod.DecompressVis(leaf.visofs, model);
};

Mod.ClearAll = function () {
  // TODO: clean out all like this
  //        - while length > 0, shift
  //        - model.Free (in turn will call deleteBuffer etc.)
  //        - keep everything non brush

  for (let i = 0; i < Mod.known.length; i++) {
    const mod = Mod.known[i];
    if (mod.type !== Mod.type.brush) {
      continue;
    }
    // eslint-disable-next-line eqeqeq
    if (mod.cmds != null) {
      gl.deleteBuffer(mod.cmds);
    }
    Mod.known[i] = {
      name: mod.name,
      needload: true,
    };
  }
};

Mod.FindName = function (name) { // private method (refactor into _RegisterModel)
  if (name.length === 0) {
    throw new Error('Mod.FindName: NULL name');
  }
  let i;
  for (i = 0; i < Mod.known.length; i++) {
    // eslint-disable-next-line eqeqeq
    if (Mod.known[i] == null) {
      continue;
    }
    if (Mod.known[i].name === name) {
      return Mod.known[i];
    }
  }
  for (i = 0; i <= Mod.known.length; i++) {
    // eslint-disable-next-line eqeqeq
    if (Mod.known[i] != null) {
      continue;
    }
    Mod.known[i] = { name: name, needload: true };
    return Mod.known[i];
  }
  return null;
};

Mod.LoadModelFromBuffer = function (loadmodel, buffer) {
  // Use the new loader registry system
  return modelLoaderRegistry.load(buffer, loadmodel.name, loadmodel);
};

/**
 * @param {BaseModel} mod model to load into
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {BaseModel|null} the loaded model or null if not found
 * @deprecated use Mod.LoadModelAsync instead
 */
Mod.LoadModel = function (mod, crash) { // private method
  if (mod.needload !== true) {
    return mod;
  }
  const buf = COM.LoadFile(mod.name);
  if (buf === null) {
    if (crash === true) {
      throw new MissingResourceError(mod.name);
    }
    return null;
  }
  return Mod.LoadModelFromBuffer(mod, buf);
};

/**
 * @param {BaseModel} mod model to load into
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.LoadModelAsync = async function (mod, crash) { // private method
  if (mod.needload !== true) {
    return mod;
  }
  const buf = await COM.LoadFileAsync(mod.name);
  if (buf === null) {
    if (crash === true) {
      throw new MissingResourceError(mod.name);
    }
    return null;
  }
  return Mod.LoadModelFromBuffer(mod, buf);
};

/**
 * @param {string} name filename
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {BaseModel|null} the loaded model or null if not found
 * @deprecated use Mod.LoadModelAsync instead
 */
Mod.ForName = function (name, crash = false) { // public method
  return Mod.LoadModel(Mod.FindName(name), crash);
};

/**
 * @param {string} name filename
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.ForNameAsync = async function (name, crash = false) { // public method
  return await Mod.LoadModelAsync(Mod.FindName(name), crash);
};

/*
===============================================================================

          BRUSHMODEL LOADING (Handled by BSP29Loader.mjs)

===============================================================================
*/

// BSP loading has been moved to model/loaders/BSP29Loader.mjs
// The ModelLoaderRegistry automatically routes .bsp files to BSP29Loader

/*
===============================================================================

          ALIAS MODEL LOADING (Handled by AliasMDLLoader.mjs)

===============================================================================
*/

// Alias model loading has been moved to model/loaders/AliasMDLLoader.mjs
// The ModelLoaderRegistry automatically routes .mdl files to AliasMDLLoader

/*
===============================================================================

          SPRITE MODEL LOADING (Handled by SpriteSPRLoader.mjs)

===============================================================================
*/

// Sprite model loading has been moved to model/loaders/SpriteSPRLoader.mjs
// The ModelLoaderRegistry automatically routes .spr files to SpriteSPRLoader

/*
===============================================================================

          QUAKE C PARSING (For future model format support)

===============================================================================
*/


/** @typedef {import('../../shared/GameInterfaces.d.ts').ParsedQC} ParsedQC_t */
/** @augments ParsedQC_t */
export class ParsedQC {
  /** @type {string} */
  cd = null;
  origin = new Vector();
  /** @type {string} */
  base = null;
  /** @type {string} */
  skin = null;
  /** @type {string[]} */
  frames = [];
  /** @type {Record<string, number[]>} */
  animations = {};
  /** @type {number} */
  scale = 1.0;

  /**
   * @param {string} qcContent qc model source
   * @returns {this} this
   */
  parseQC(qcContent) {
    console.assert(typeof qcContent === 'string', 'qcContent must be a string');

    const lines = qcContent.trim().split('\n');

    for (const line of lines) {
      if (line.trim() === '' || line.startsWith('#') || line.startsWith('//')) {
        continue;
      }

      const parts = line.split(/\s+/);
      const [key, value] = [parts.shift(), parts.join(' ')];

      switch (key) {
        case '$cd':
          this.cd = value;
          break;

        case '$origin':
          this.origin = new Vector(...value.split(/\s+/).map((n) => Q.atof(n)));
          break;

        case '$base':
          this.base = value;
          break;

        case '$skin':
          this.skin = value;
          break;

        case '$scale':
          this.scale = +value;
          break;

        case '$frame': {
          const frames = value.split(/\s+/);

          this.frames.push(...frames);

          for (const frame of frames) {
            const matches = frame.match(/^([^0-9]+)([0-9]+)$/);

            if (matches) {
              if (!this.animations[matches[1]]) {
                this.animations[matches[1]] = [];
              }

              this.animations[matches[1]].push(this.frames.indexOf(matches[0]));
            }
          }
        }
          break;

        default:
          console.assert(false, 'QC field unknown', key);
      }
    }

    return this;
  }
};

Mod.ParseQC = function (qcContent) {
  const data = new ParsedQC();

  return data.parseQC(qcContent);
};
