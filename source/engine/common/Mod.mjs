import GL from '../client/GL.mjs';
import { eventBus, registry } from '../registry.mjs';
import { MissingResourceError } from './Errors.mjs';
import { ModelLoaderRegistry } from './model/ModelLoaderRegistry.mjs';
import { AliasMDLLoader } from './model/loaders/AliasMDLLoader.mjs';
import { SpriteSPRLoader } from './model/loaders/SpriteSPRLoader.mjs';
import { BSP29Loader } from './model/loaders/BSP29Loader.mjs';
import { BSP2Loader } from './model/loaders/BSP2Loader.mjs';
import { WavefrontOBJLoader } from './model/loaders/WavefrontOBJLoader.mjs';
import ParsedQC from './model/parsers/ParsedQC.mjs';
import { BSP38Loader } from './model/loaders/BSP38Loader.mjs';

/** @typedef {import('./model/BaseModel.mjs').BaseModel} BaseModel */

const Mod = {};

export default Mod;

let { COM } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

// Re-export model classes for backward compatibility
export { AliasModel } from './model/AliasModel.mjs';
export { BrushModel } from './model/BSP.mjs';
export { SpriteModel } from './model/SpriteModel.mjs';
export { MeshModel } from './model/MeshModel.mjs';

Mod.type = { brush: 0, sprite: 1, alias: 2, mesh: 3 };

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

Mod.known = /** @type {Record<string, BaseModel>} */ ({});

Mod.modelLoaderRegistry = new ModelLoaderRegistry();

Mod.Init = function () {
  Mod.novis = new Array(1024);
  Mod.novis.fill(0xff);

  Mod.modelLoaderRegistry.clear();
  Mod.modelLoaderRegistry.register(new BSP38Loader());
  Mod.modelLoaderRegistry.register(new BSP2Loader()); // Register BSP2 before BSP29 so it’s checked first (more specific format)
  Mod.modelLoaderRegistry.register(new BSP29Loader());
  Mod.modelLoaderRegistry.register(new AliasMDLLoader());
  Mod.modelLoaderRegistry.register(new SpriteSPRLoader());
  Mod.modelLoaderRegistry.register(new WavefrontOBJLoader());
};

Mod.PointInLeaf = function (p, model) { // public method, static access? (PF, R, S use it)
  if (!model) {
    throw new Error('Mod.PointInLeaf: bad model');
  }
  if (!model.nodes) {
    throw new Error('Mod.PointInLeaf: bad model, missing nodes');
  }
  let node = model.nodes[0];
  let normal;
  while (true) {
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

/**
 * Despite the name, it clears brush models only.
 */
Mod.ClearAll = function () {
  for (const name of Object.keys(Mod.known)) {
    const mod = Mod.known[name];

    if (mod.type !== Mod.type.brush) {
      continue;
    }

    if (mod.cmds !== null) { // TODO: move responsibility to model.free or the renderer
      gl.deleteBuffer(mod.cmds);
    }

    delete Mod.known[name];
  }
};

Mod.LoadModelFromBuffer = async function (name, buffer) {
  // FIXME: maybe catch at least NotImplementedError here and give a better
  //        error message, right now it will simply crash the whole engine
  const model = await Mod.modelLoaderRegistry.load(buffer, name);

  Mod.RegisterModel(model);

  return model;
};

Mod.RegisterModel = function (model) {
  Mod.known[model.name] = model;
};

/**
 * @param {string} name model to load
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.LoadModelAsync = async function (name, crash) { // private method
  const buf = await COM.LoadFile(name);
  if (buf === null) {
    if (crash === true) {
      throw new MissingResourceError(name);
    }
    return null;
  }
  return await Mod.LoadModelFromBuffer(name, buf);
};

/**
 * Load submodels. For anything else, use Mod.ForNameAsync instead.
 * @param {string} name filename
 * @returns {BaseModel|null} the loaded model or null if not found
 */
Mod.ForName = function (name) { // public method
  console.assert(name[0] === '*', 'only submodels supported in Mod.ForName');

  return Mod.known[name] || null;
};

/**
 * @param {string} name filename
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.ForNameAsync = async function (name, crash = false) { // public method
  if (name[0] === '*') {
    return Mod.ForName(name);
  }

  return await Mod.LoadModelAsync(name, crash);
};

Mod.ParseQC = function (qcContent) {
  const data = new ParsedQC();

  return data.parseQC(qcContent);
};
