import Vector from '../../shared/Vector.mjs';
import GL, { GLTexture, resampleTexture8 } from '../client/GL.mjs';
import { eventBus, registry } from '../registry.mjs';
import { CorruptedResourceError, MissingResourceError } from './Errors.mjs';
import Q from '../../shared/Q.mjs';
import W, { translateIndexToRGBA, WadFileInterface } from './W.mjs';
import { CRC16CCITT } from './CRC.mjs';

const Mod = {};

export default Mod;

let { COM, Con, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  COM = registry.COM;
  Con = registry.Con;
  R = registry.R;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

const notexture_mip = {name: 'notexture', width: 16, height: 16, texturenum: null};

/**
 * Mod.BaseModel
 * Mod.BrushModel
 * Mod.SpriteModel
 * Mod.AliasModel
 */

export class BaseModel {
  static STATE = {
    NOT_READY: 'not-ready',
    LOADING: 'loading',
    READY: 'ready',
    FAILED: 'failed',
  };

  constructor(name) {
    this.name = name;
    this.type = null;
    this.reset();
  }

  reset() {
    // private variables
    this._num_frames = 0;
    this._num_skins = 0;
    this._num_tris = 0; // R requires that
    this._num_verts = 0;

    this._scale = new Vector(1.0, 1.0, 1.0);
    this._scale_origin = new Vector();
    this._random = false; // FIXME: read but unused

    // public variables
    /** whether the file still needs loading */
    this.needload = true;
    /** simple CRC checksum to check if things are still the same */
    this.checksum = 0;

    // public variables
    this.mins = []; // required by PF, R, CL, SV (on worldmodel)
    this.maxs = []; // required by PF, R, CL, SV (on worldmodel)

    // public variables just for rendering purposes (IDEA: refactor into ModelRenderer classes)
    this.cmds = []; // required by R
  }
};

export class AliasModel extends BaseModel {
  reset() {
    super.reset();

    this._skin_width = 0;
    this._skin_height = 0;

    this._triangles = [];
    this._stverts = [];

    // public variables
    this.flags = 0; // CL requires that (together with Mod.flags)
    this.frames = []; // required by R, Host (only for name and interval)

    // public variables just for rendering purposes (IDEA: refactor into ModelRenderer classes)
    this.skins = []; // R requires that (to pick the right texture)
    this.boundingradius = 0; // R requires that
    this.player = false; // R requires that (to change colors)
  }
};

export class Plane { // TODO: move to shared
  type = 0;
  signbits = 0;

  constructor(normal, dist) {
    /** @type {Vector} */
    this.normal = normal;
    /** @type {number} */
    this.dist = dist;
  }
};

export class Face {
  submodel = false;
  /** @type {Plane} */
  plane = null;
  firstedge = 0;
  numedges = 0;
  texinfo = 0;
  /** @type {number[]} */
  styles = [];
  lightofs = 0;
  texture = 0;
  texturemins = [0, 0];
  extents = [0, 0];
  turbulent = false;
  sky = false;
};

export class BrushModel extends BaseModel {
  /** @type {Plane[]} */
  planes = [];

  /** @type {Face[]} */
  faces = [];

  /** @type {Vector[]} */
  vertexes = [];

  /** @type {number[][]} */
  edges = [];

  /** @type {number[]} */
  surfedges = [];
};

Mod.type = {brush: 0, sprite: 1, alias: 2};

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

Mod.version = {brush: 29, sprite: 1, alias: 6};

Mod.known = [];

/** @type {WadFileInterface} */
let halflifeWad = null;

Mod.Init = function() {
  Mod.novis = new Array(1024);
  Mod.novis.fill(0xff);
};

Mod.LoadWad = async function() {
  // halflifeWad = await W.LoadFile('halflife.wad');
};

Mod.PointInLeaf = function(p, model) { // public method, static access? (PF, R, S use it)
  if (model == null) {
    throw new Error('Mod.PointInLeaf: bad model');
  }
  if (model.nodes == null) {
    throw new Error('Mod.PointInLeaf: bad model');
  }
  let node = model.nodes[0];
  let normal;
  for (;;) {
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

Mod.DecompressVis = function(i, model) { // private method
  const decompressed = []; let c; let out = 0; let row = (model.leafs.length + 7) >> 3;
  if (model.visdata == null) {
    for (; row >= 0; --row) {
      decompressed[out++] = 0xff;
    }
    return decompressed;
  }
  for (out = 0; out < row; ) {
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

Mod.LeafPVS = function(leaf, model) {
  if (leaf === model.leafs[0]) {
    return Mod.novis;
  }
  return Mod.DecompressVis(leaf.visofs, model);
};

Mod.ClearAll = function() {
  // TODO: clean out all like this
  //        - while length > 0, shift
  //        - model.Free (in turn will call deleteBuffer etc.)
  //        - keep everything non brush

  for (let i = 0; i < Mod.known.length; i++) {
    const mod = Mod.known[i];
    if (mod.type !== Mod.type.brush) {
      continue;
    }
    if (mod.cmds != null) {
      gl.deleteBuffer(mod.cmds);
    }
    Mod.known[i] = {
      name: mod.name,
      needload: true,
    };
  }
};

Mod.FindName = function(name) { // private method (refactor into _RegisterModel)
  if (name.length === 0) {
    throw new Error('Mod.FindName: NULL name');
  }
  let i;
  for (i = 0; i < Mod.known.length; i++) {
    if (Mod.known[i] == null) {
      continue;
    }
    if (Mod.known[i].name === name) {
      return Mod.known[i];
    }
  }
  for (i = 0; i <= Mod.known.length; i++) {
    if (Mod.known[i] != null) {
      continue;
    }
    Mod.known[i] = {name: name, needload: true};
    return Mod.known[i];
  }
  return null;
};

/** @deprecated use Mod.LoadModelAsync instead */
Mod.LoadModel = function(mod, crash) { // private method
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
  const loadmodel = mod; // TODO: refactor into this
  mod.needload = false;
  mod.checksum = CRC16CCITT.Block(new Uint8Array(buf));
  switch ((new DataView(buf)).getUint32(0, true)) {
    case 0x4f504449:
      Mod.LoadAliasModel(loadmodel, buf);
      break;
    case 0x50534449:
      Mod.LoadSpriteModel(loadmodel, buf);
      break;
    default:
      Mod.LoadBrushModel(loadmodel, buf);
  }
  return mod;
};

/**
 * @param {BaseModel} mod model to load into
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.LoadModelAsync = async function(mod, crash) { // private method
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
  const loadmodel = mod; // TODO: refactor into this
  mod.needload = false;
  mod.checksum = CRC16CCITT.Block(new Uint8Array(buf));
  switch ((new DataView(buf)).getUint32(0, true)) {
    case 0x4f504449:
      Mod.LoadAliasModel(loadmodel, buf);
      break;
    case 0x50534449:
      Mod.LoadSpriteModel(loadmodel, buf);
      break;
    default:
      Mod.LoadBrushModel(loadmodel, buf);
  }
  return mod;
};

/**
 * @param {string} name filename
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {BaseModel|null} the loaded model or null if not found
 * @deprecated use Mod.LoadModelAsync instead
 */
Mod.ForName = function(name, crash = false) { // public method
  return Mod.LoadModel(Mod.FindName(name), crash);
};

/**
 * @param {string} name filename
 * @param {boolean} crash whether to throw an error if the model is not found
 * @returns {Promise<BaseModel|null>} the loaded model or null if not found
 */
Mod.ForNameAsync = async function(name, crash = false) { // public method
  return await Mod.LoadModelAsync(Mod.FindName(name), crash);
};

/*
===============================================================================

          BRUSHMODEL LOADING

===============================================================================
*/

Mod.lump =
{
  entities: 0,
  planes: 1,
  textures: 2,
  vertexes: 3,
  visibility: 4,
  nodes: 5,
  texinfo: 6,
  faces: 7,
  lighting: 8,
  clipnodes: 9,
  leafs: 10,
  marksurfaces: 11,
  edges: 12,
  surfedges: 13,
  models: 14,
};

Mod.contents = {
  empty: -1,
  solid: -2,
  water: -3,
  slime: -4,
  lava: -5,
  sky: -6,
  origin: -7,
  clip: -8,
  current_0: -9,
  current_90: -10,
  current_180: -11,
  current_270: -12,
  current_up: -13,
  current_down: -14,
};

Mod.LoadTextures = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.textures << 3) + 4, true);
  // const filelen = view.getUint32((Mod.lump.textures << 3) + 8, true);
  loadmodel.textures = [];
  const nummiptex = view.getUint32(fileofs, true);
  let dataofs = fileofs + 4;
  let i; let miptexofs;
  for (i = 0; i < nummiptex; i++) {
    miptexofs = view.getInt32(dataofs, true);
    dataofs += 4;
    if (miptexofs === -1) {
      loadmodel.textures[i] = notexture_mip;
      continue;
    }
    miptexofs += fileofs;
    const tx = {
      name: Q.memstr(new Uint8Array(buf, miptexofs, 16)),
      width: view.getUint32(miptexofs + 16, true),
      height: view.getUint32(miptexofs + 20, true),
      glt: null,
      sky: false,
      turbulent: false,
    };
    // prototyped an external wad file loading for textures:
    // try {
    //   const tex = halflifeWad.getLumpMipmap(tx.name, 0);
    //   if (tex) {
    //     tx.width = tex.width;
    //     tx.height = tex.height;
    //     tx.glt = GLTexture.Allocate(tx.name, tx.width, tx.height, tex.data);
    //     loadmodel.textures[i] = tx;
    //     continue;
    //   }
    // } catch(e) {
    //   console.error(e);
    // }
    if (!registry.isDedicatedServer) {
      if (tx.name.substring(0, 3).toLowerCase() === 'sky') {
        R.InitSky(new Uint8Array(buf, miptexofs + view.getUint32(miptexofs + 24, true), 32768));
        tx.texturenum = R.solidskytexture;
        R.skytexturenum = i;
        tx.sky = true;
      } else {
        tx.glt = GLTexture.Allocate(tx.name, tx.width, tx.height, translateIndexToRGBA(new Uint8Array(buf, miptexofs + view.getUint32(miptexofs + 24, true), tx.width * tx.height), tx.width, tx.height));
        if (tx.name[0] === '*') {
          tx.turbulent = true;
        }
      }
    }
    loadmodel.textures[i] = tx;
  }

  let j; let tx2; let num; let name;
  for (i = 0; i < nummiptex; i++) {
    const tx = loadmodel.textures[i];
    if (tx.name[0] !== '+') {
      continue;
    }
    if (tx.name[1] !== '0') {
      continue;
    }
    name = tx.name.substring(2);
    tx.anims = [i];
    tx.alternate_anims = [];
    for (j = 0; j < nummiptex; j++) {
      tx2 = loadmodel.textures[j];
      if (tx2.name[0] !== '+') {
        continue;
      }
      if (tx2.name.substring(2) !== name) {
        continue;
      }
      num = tx2.name.charCodeAt(1);
      if (num === 48) {
        continue;
      }
      if ((num >= 49) && (num <= 57)) {
        tx.anims[num - 48] = j;
        tx2.anim_base = i;
        tx2.anim_frame = num - 48;
        continue;
      }
      if (num >= 97) {
        num -= 32;
      }
      if ((num >= 65) && (num <= 74)) {
        tx.alternate_anims[num - 65] = j;
        tx2.anim_base = i;
        tx2.anim_frame = num - 65;
        continue;
      }
      throw new Error('Bad animating texture ' + tx.name);
    }
    for (j = 0; j < tx.anims.length; j++) {
      if (tx.anims[j] == null) {
        throw new Error('Missing frame ' + j + ' of ' + tx.name);
      }
    }
    for (j = 0; j < tx.alternate_anims.length; j++) {
      if (tx.alternate_anims[j] == null) {
        throw new Error('Missing frame ' + j + ' of ' + tx.name);
      }
    }
    loadmodel.textures[i] = tx;
  }

  loadmodel.textures[loadmodel.textures.length] = notexture_mip;
};

Mod.LoadLighting = function(loadmodel, buf) {
  loadmodel.lightdata_rgb = null;
  loadmodel.lightdata = null;

  const litfile = COM.LoadFile(loadmodel.name.replace('.bsp', '.lit'));

  if (litfile) {
    Con.Print(`Mod.LoadLighting: using external .lit file for ${loadmodel.name}\n`);

    loadmodel.lightdata_rgb = new Uint8Array(litfile.slice(8)); // skip header
    // return;
  }

  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.lighting << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.lighting << 3) + 8, true);
  if (filelen === 0) {
    return;
  }
  loadmodel.lightdata = new Uint8Array(new ArrayBuffer(filelen));
  loadmodel.lightdata.set(new Uint8Array(buf, fileofs, filelen));
};

Mod.LoadVisibility = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.visibility << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.visibility << 3) + 8, true);
  if (filelen === 0) {
    return;
  }
  loadmodel.visdata = new Uint8Array(new ArrayBuffer(filelen));
  loadmodel.visdata.set(new Uint8Array(buf, fileofs, filelen));
};

Mod.LoadEntities = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.entities << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.entities << 3) + 8, true);
  loadmodel.entities = Q.memstr(new Uint8Array(buf, fileofs, filelen));
};

Mod.LoadVertexes = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.vertexes << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.vertexes << 3) + 8, true);
  if ((filelen % 12) !== 0) {
    throw new Error('Mod.LoadVisibility: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 12;
  loadmodel.vertexes = [];
  let i;
  for (i = 0; i < count; i++) {
    loadmodel.vertexes[i] = new Vector(view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true));
    fileofs += 12;
  }
};

Mod.LoadSubmodels = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.models << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.models << 3) + 8, true);
  const count = filelen >> 6;
  if (count === 0) {
    throw new Error('Mod.LoadSubmodels: funny lump size in ' + loadmodel.name);
  }
  loadmodel.submodels = [];

  loadmodel.mins = new Vector(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
  loadmodel.maxs = new Vector(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
  loadmodel.hulls[0].firstclipnode = view.getUint32(fileofs + 36, true);
  loadmodel.hulls[1].firstclipnode = view.getUint32(fileofs + 40, true);
  loadmodel.hulls[2].firstclipnode = view.getUint32(fileofs + 44, true);
  fileofs += 64;

  let i; const clipnodes = loadmodel.hulls[0].clipnodes; let out;
  for (i = 1; i < count; i++) {
    out = Mod.FindName('*' + i); // TODO: out = new BrushModel('*' + 1), Mod._RegisterModel(out)
    out.needload = false;
    out.type = Mod.type.brush;
    out.submodel = true;
    out.mins = new Vector(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
    out.maxs = new Vector(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
    out.origin = new Vector(view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true), view.getFloat32(fileofs + 32, true));
    out.hulls = [
      {
        clipnodes: clipnodes,
        firstclipnode: view.getUint32(fileofs + 36, true),
        lastclipnode: loadmodel.nodes.length - 1,
        planes: loadmodel.planes,
        clip_mins: new Vector(),
        clip_maxs: new Vector(),
      },
      {
        clipnodes: loadmodel.clipnodes,
        firstclipnode: view.getUint32(fileofs + 40, true),
        lastclipnode: loadmodel.clipnodes.length - 1,
        planes: loadmodel.planes,
        clip_mins: new Vector(-16.0, -16.0, -24.0),
        clip_maxs: new Vector(16.0, 16.0, 32.0),
      },
      {
        clipnodes: loadmodel.clipnodes,
        firstclipnode: view.getUint32(fileofs + 44, true),
        lastclipnode: loadmodel.clipnodes.length - 1,
        planes: loadmodel.planes,
        clip_mins: new Vector(-32.0, -32.0, -24.0),
        clip_maxs: new Vector(32.0, 32.0, 64.0),
      },
    ];
    out.textures = loadmodel.textures;
    out.lightdata = loadmodel.lightdata;
    out.faces = loadmodel.faces;
    out.firstface = view.getUint32(fileofs + 56, true);
    out.numfaces = view.getUint32(fileofs + 60, true);
    loadmodel.submodels[i - 1] = out;
    fileofs += 64;

    for (let i = 0; i < out.numfaces; i++) {
      /** @type {Face} */
      const face = out.faces[out.firstface + i];

      face.submodel = true;
    }
  }
};

Mod.LoadEdges = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.edges << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.edges << 3) + 8, true);
  if ((filelen & 3) !== 0) {
    throw new Error('Mod.LoadEdges: funny lump size in ' + loadmodel.name);
  }
  const count = filelen >> 2;
  loadmodel.edges = [];
  let i;
  for (i = 0; i < count; i++) {
    loadmodel.edges[i] = [view.getUint16(fileofs, true), view.getUint16(fileofs + 2, true)];
    fileofs += 4;
  }
};

Mod.LoadTexinfo = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.texinfo << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.texinfo << 3) + 8, true);
  if ((filelen % 40) !== 0) {
    throw new Error('Mod.LoadTexinfo: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 40;
  loadmodel.texinfo = [];
  let i; let out;
  for (i = 0; i < count; i++) {
    out = {
      vecs: [
        [view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true), view.getFloat32(fileofs + 12, true)],
        [view.getFloat32(fileofs + 16, true), view.getFloat32(fileofs + 20, true), view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true)],
      ],
      texture: view.getUint32(fileofs + 32, true),
      flags: view.getUint32(fileofs + 36, true),
    };
    if (out.texture >= loadmodel.textures.length) {
      out.texture = loadmodel.textures.length - 1;
      out.flags = 0;
    }
    loadmodel.texinfo[i] = out;
    fileofs += 40;
  }
};

Mod.LoadFaces = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.faces << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.faces << 3) + 8, true);
  if ((filelen % 20) !== 0) {
    throw new Error('Mod.LoadFaces: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 20;
  loadmodel.firstface = 0;
  loadmodel.numfaces = count;
  loadmodel.faces = [];
  for (let i = 0; i < count; i++) {
    let mins; let maxs; let j; let e; let tex; let v; let val;
    const styles = new Uint8Array(buf, fileofs + 12, 4);
    const out = Object.assign(new Face(), {
      plane: loadmodel.planes[view.getUint16(fileofs, true)],
      firstedge: view.getUint16(fileofs + 4, true),
      numedges: view.getUint16(fileofs + 8, true),
      texinfo: view.getUint16(fileofs + 10, true),
      styles: [],
      lightofs: view.getInt32(fileofs + 16, true),
    });
    if (styles[0] !== 255) {
      out.styles[0] = styles[0];
    }
    if (styles[1] !== 255) {
      out.styles[1] = styles[1];
    }
    if (styles[2] !== 255) {
      out.styles[2] = styles[2];
    }
    if (styles[3] !== 255) {
      out.styles[3] = styles[3];
    }

    mins = [Infinity, Infinity];
    maxs = [-Infinity, -Infinity];
    tex = loadmodel.texinfo[out.texinfo];
    out.texture = tex.texture;
    for (j = 0; j < out.numedges; j++) {
      e = loadmodel.surfedges[out.firstedge + j];
      if (e >= 0) {
        v = loadmodel.vertexes[loadmodel.edges[e][0]];
      } else {
        v = loadmodel.vertexes[loadmodel.edges[-e][1]];
      }
      val = v.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3];
      if (val < mins[0]) {
        mins[0] = val;
      }
      if (val > maxs[0]) {
        maxs[0] = val;
      }
      val = v.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3];
      if (val < mins[1]) {
        mins[1] = val;
      }
      if (val > maxs[1]) {
        maxs[1] = val;
      }
    }
    out.texturemins = [Math.floor(mins[0] / 16) * 16, Math.floor(mins[1] / 16) * 16];
    out.extents = [Math.ceil(maxs[0] / 16) * 16 - out.texturemins[0], Math.ceil(maxs[1] / 16) * 16 - out.texturemins[1]];

    if (loadmodel.textures[tex.texture].turbulent === true) {
      out.turbulent = true;
    } else if (loadmodel.textures[tex.texture].sky === true) {
      out.sky = true;
    }

    loadmodel.faces[i] = out;
    fileofs += 20;
  }
};

Mod.SetParent = function(node, parent) {
  node.parent = parent;
  if (node.contents < 0) {
    return;
  }
  Mod.SetParent(node.children[0], node);
  Mod.SetParent(node.children[1], node);
};

Mod.LoadNodes = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.nodes << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.nodes << 3) + 8, true);
  if ((filelen === 0) || ((filelen % 24) !== 0)) {
    throw new Error('Mod.LoadNodes: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 24;
  loadmodel.nodes = [];
  let i; let out;
  for (i = 0; i < count; i++) {
    loadmodel.nodes[i] = {
      num: i,
      contents: 0,
      planenum: view.getUint32(fileofs, true),
      children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
      mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
      maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
      firstface: view.getUint16(fileofs + 20, true),
      numfaces: view.getUint16(fileofs + 22, true),
      cmds: [],
    };
    fileofs += 24;
  }
  for (i = 0; i < count; i++) {
    out = loadmodel.nodes[i];
    out.plane = loadmodel.planes[out.planenum];
    if (out.children[0] >= 0) {
      out.children[0] = loadmodel.nodes[out.children[0]];
    } else {
      out.children[0] = loadmodel.leafs[-1 - out.children[0]];
    }
    if (out.children[1] >= 0) {
      out.children[1] = loadmodel.nodes[out.children[1]];
    } else {
      out.children[1] = loadmodel.leafs[-1 - out.children[1]];
    }
  }
  Mod.SetParent(loadmodel.nodes[0]);
};

Mod.LoadLeafs = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.leafs << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.leafs << 3) + 8, true);
  if ((filelen % 28) !== 0) {
    throw new Error('Mod.LoadLeafs: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 28;
  loadmodel.leafs = [];
  let i; let out;
  for (i = 0; i < count; i++) {
    out = {
      num: i,
      contents: view.getInt32(fileofs, true),
      visofs: view.getInt32(fileofs + 4, true),
      mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
      maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
      firstmarksurface: view.getUint16(fileofs + 20, true),
      nummarksurfaces: view.getUint16(fileofs + 22, true),
      ambient_level: [view.getUint8(fileofs + 24), view.getUint8(fileofs + 25), view.getUint8(fileofs + 26), view.getUint8(fileofs + 27)],
      cmds: [],
      skychain: 0,
      waterchain: 0,
    };
    loadmodel.leafs[i] = out;
    fileofs += 28;
  };
};

Mod.LoadClipnodes = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.clipnodes << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.clipnodes << 3) + 8, true);
  const count = filelen >> 3;
  loadmodel.clipnodes = [];

  loadmodel.hulls = [];
  loadmodel.hulls[1] = {
    clipnodes: loadmodel.clipnodes,
    firstclipnode: 0,
    lastclipnode: count - 1,
    planes: loadmodel.planes,
    clip_mins: new Vector(-16.0, -16.0, -24.0),
    clip_maxs: new Vector(16.0, 16.0, 32.0),
  };
  loadmodel.hulls[2] = {
    clipnodes: loadmodel.clipnodes,
    firstclipnode: 0,
    lastclipnode: count - 1,
    planes: loadmodel.planes,
    clip_mins: new Vector(-32.0, -32.0, -24.0),
    clip_maxs: new Vector(32.0, 32.0, 64.0),
  };
  let i;
  for (i = 0; i < count; i++) {
    loadmodel.clipnodes[i] = {
      planenum: view.getUint32(fileofs, true),
      children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
    };
    fileofs += 8;
  }
};

Mod.MakeHull0 = function(loadmodel) {
  let node; let child; const clipnodes = []; let i; let out;
  const hull = {
    clipnodes: clipnodes,
    lastclipnode: loadmodel.nodes.length - 1,
    planes: loadmodel.planes,
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
  };
  for (i = 0; i < loadmodel.nodes.length; i++) {
    node = loadmodel.nodes[i];
    out = {planenum: node.planenum, children: []};
    child = node.children[0];
    out.children[0] = child.contents < 0 ? child.contents : child.num;
    child = node.children[1];
    out.children[1] = child.contents < 0 ? child.contents : child.num;
    clipnodes[i] = out;
  }
  loadmodel.hulls[0] = hull;
};

Mod.LoadMarksurfaces = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.marksurfaces << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.marksurfaces << 3) + 8, true);
  const count = filelen >> 1;
  loadmodel.marksurfaces = [];
  let i; let j;
  for (i = 0; i < count; i++) {
    j = view.getUint16(fileofs + (i << 1), true);
    if (j > loadmodel.faces.length) {
      throw new Error('Mod.LoadMarksurfaces: bad surface number');
    }
    loadmodel.marksurfaces[i] = j;
  }
};

Mod.LoadSurfedges = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.surfedges << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.surfedges << 3) + 8, true);
  const count = filelen >> 2;
  loadmodel.surfedges = [];
  let i;
  for (i = 0; i < count; i++) {
    loadmodel.surfedges[i] = view.getInt32(fileofs + (i << 2), true);
  }
};

Mod.LoadPlanes = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.planes << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.planes << 3) + 8, true);
  if ((filelen % 20) !== 0) {
    throw new Error('Mod.LoadPlanes: funny lump size in ' + loadmodel.name);
  }
  const count = filelen / 20;
  loadmodel.planes = [];
  for (let i = 0; i < count; i++) {
    const out = Object.assign(new Plane(), {
      normal: new Vector(view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true)),
      dist: view.getFloat32(fileofs + 12, true),
      type: view.getUint32(fileofs + 16, true),
      signbits: 0,
    });
    if (out.normal[0] < 0) {
      out.signbits |= 1;
    }
    if (out.normal[1] < 0) {
      out.signbits |= 2;
    }
    if (out.normal[2] < 0) {
      out.signbits |= 4;
    }
    loadmodel.planes[i] = out;
    fileofs += 20;
  }
};

/**
 *
 * @param {BrushModel} loadmodel
 * @param {*} buffer
 */
Mod.LoadBrushModel = function(loadmodel, buffer) {
  loadmodel.type = Mod.type.brush;
  const version = (new DataView(buffer)).getUint32(0, true);
  if (version !== Mod.version.brush) {
    throw new CorruptedResourceError(loadmodel.name, 'wrong version number (' + version + ' should be ' + Mod.version.brush + ')');
  }
  Mod.LoadVertexes(loadmodel, buffer);
  Mod.LoadEdges(loadmodel, buffer);
  Mod.LoadSurfedges(loadmodel, buffer);
  Mod.LoadTextures(loadmodel, buffer);
  Mod.LoadLighting(loadmodel, buffer);
  Mod.LoadPlanes(loadmodel, buffer);
  Mod.LoadTexinfo(loadmodel, buffer);
  Mod.LoadFaces(loadmodel, buffer);
  Mod.LoadMarksurfaces(loadmodel, buffer);
  Mod.LoadVisibility(loadmodel, buffer);
  Mod.LoadLeafs(loadmodel, buffer);
  Mod.LoadNodes(loadmodel, buffer);
  Mod.LoadClipnodes(loadmodel, buffer);
  Mod.MakeHull0(loadmodel);
  Mod.LoadEntities(loadmodel, buffer);
  Mod.LoadSubmodels(loadmodel, buffer);

  const mins = new Vector(), maxs = new Vector();
  for (let i = 0; i < loadmodel.vertexes.length; i++) {
    const vert = loadmodel.vertexes[i];
    if (vert[0] < mins[0]) {
      mins[0] = vert[0];
    } else if (vert[0] > maxs[0]) {
      maxs[0] = vert[0];
    }

    if (vert[1] < mins[1]) {
      mins[1] = vert[1];
    } else if (vert[1] > maxs[1]) {
      maxs[1] = vert[1];
    }

    if (vert[2] < mins[2]) {
      mins[2] = vert[2];
    } else if (vert[2] > maxs[2]) {
      maxs[2] = vert[2];
    }
  };
  loadmodel.radius = (new Vector(
    Math.abs(mins[0]) > Math.abs(maxs[0]) ? Math.abs(mins[0]) : Math.abs(maxs[0]),
    Math.abs(mins[1]) > Math.abs(maxs[1]) ? Math.abs(mins[1]) : Math.abs(maxs[1]),
    Math.abs(mins[2]) > Math.abs(maxs[2]) ? Math.abs(mins[2]) : Math.abs(maxs[2]),
  )).len();
};

/*
==============================================================================

ALIAS MODELS

==============================================================================
*/

Mod.TranslatePlayerSkin = function(loadmodel, data, skin) {
  if (registry.isDedicatedServer) {
    return;
  }

  if ((loadmodel._skin_width !== 512) || (loadmodel._skin_height !== 256)) {
    data = resampleTexture8(data, loadmodel._skin_width, loadmodel._skin_height, 512, 256);
  }

  const out = new Uint8Array(new ArrayBuffer(524288));

  for (let i = 0; i < 131072; i++) {
    const original = data[i];
    if ((original >> 4) === 1) {
      out[i << 2] = (original & 15) * 17;
      out[(i << 2) + 1] = 255;
    } else if ((original >> 4) === 6) {
      out[(i << 2) + 2] = (original & 15) * 17;
      out[(i << 2) + 3] = 255;
    }
  }

  skin.playertexture = GLTexture.Allocate(loadmodel.name + '_playerskin', 512, 256, out);
};

Mod.FloodFillSkin = function(loadmodel, skin) {
  const fillcolor = skin[0];
  const filledcolor = W.filledColor;

  if (fillcolor === filledcolor) {
    return;
  }

  const width = loadmodel._skin_width;
  const height = loadmodel._skin_height;

  const lifo = [[0, 0]]; let sp; let cur; let x; let y;

  for (sp = 1; sp > 0; ) {
    cur = lifo[--sp];
    x = cur[0];
    y = cur[1];
    skin[y * width + x] = filledcolor;
    if (x > 0) {
      if (skin[y * width + x - 1] === fillcolor) {
        lifo[sp++] = [x - 1, y];
      }
    }
    if (x < (width - 1)) {
      if (skin[y * width + x + 1] === fillcolor) {
        lifo[sp++] = [x + 1, y];
      }
    }
    if (y > 0) {
      if (skin[(y - 1) * width + x] === fillcolor) {
        lifo[sp++] = [x, y - 1];
      }
    }
    if (y < (height - 1)) {
      if (skin[(y + 1) * width + x] === fillcolor) {
        lifo[sp++] = [x, y + 1];
      }
    }
  }
};

Mod.LoadAllSkins = function(loadmodel, buffer, inmodel) {
  loadmodel.skins = [];
  const model = new DataView(buffer);
  let i; let j; let group; let numskins;
  const skinsize = loadmodel._skin_width * loadmodel._skin_height;
  let skin;
  for (i = 0; i < loadmodel._num_skins; i++) {
    inmodel += 4;
    if (model.getUint32(inmodel - 4, true) === 0) {
      skin = new Uint8Array(buffer, inmodel, skinsize);
      Mod.FloodFillSkin(loadmodel, skin);
      const rgba = translateIndexToRGBA(skin, loadmodel._skin_width, loadmodel._skin_height);
      loadmodel.skins[i] = {
        group: false,
        texturenum: !registry.isDedicatedServer ? GLTexture.Allocate(loadmodel.name + '_' + i, loadmodel._skin_width, loadmodel._skin_height, rgba) : null,
      };
      if (loadmodel.player === true) {
        Mod.TranslatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), loadmodel.skins[i]);
      }
      inmodel += skinsize;
    } else {
      group = {
        group: true,
        skins: [],
      };
      numskins = model.getUint32(inmodel, true);
      inmodel += 4;
      for (j = 0; j < numskins; j++) {
        group.skins[j] = {interval: model.getFloat32(inmodel, true)};
        if (group.skins[j].interval <= 0.0) {
          throw new Error('Mod.LoadAllSkins: interval<=0');
        }
        inmodel += 4;
      }
      for (j = 0; j < numskins; j++) {
        skin = new Uint8Array(buffer, inmodel, skinsize);
        Mod.FloodFillSkin(loadmodel, skin);
        const rgba = translateIndexToRGBA(skin, loadmodel._skin_width, loadmodel._skin_height);
        group.skins[j].texturenum = !registry.isDedicatedServer ? GLTexture.Allocate(loadmodel.name + '_' + i + '_' + j, loadmodel._skin_width, loadmodel._skin_height, rgba) : null;
        if (loadmodel.player === true) {
          Mod.TranslatePlayerSkin(loadmodel, new Uint8Array(buffer, inmodel, skinsize), group.skins[j]);
        }
        inmodel += skinsize;
      }
      loadmodel.skins[i] = group;
    }
  }
  return inmodel;
};

Mod.LoadAllFrames = function(loadmodel, buffer, inmodel) {
  // TODO: class AliasModelFrame
  loadmodel.frames = [];
  const model = new DataView(buffer);
  let i; let j; let k; let frame; let group; let numframes;
  for (i = 0; i < loadmodel._frames; i++) {
    inmodel += 4;
    if (model.getUint32(inmodel - 4, true) === 0) {
      frame = {
        group: false,
        bboxmin: new Vector(model.getUint8(inmodel), model.getUint8(inmodel + 1), model.getUint8(inmodel + 2)),
        bboxmax: new Vector(model.getUint8(inmodel + 4), model.getUint8(inmodel + 5), model.getUint8(inmodel + 6)),
        name: Q.memstr(new Uint8Array(buffer, inmodel + 8, 16)),
        v: [],
      };
      inmodel += 24;
      for (j = 0; j < loadmodel._num_verts; j++) {
        frame.v[j] = {
          v: new Vector(model.getUint8(inmodel), model.getUint8(inmodel + 1), model.getUint8(inmodel + 2)),
          lightnormalindex: model.getUint8(inmodel + 3),
        };
        inmodel += 4;
      }
      loadmodel.frames[i] = frame;
    } else {
      group = {
        group: true,
        bboxmin: new Vector(model.getUint8(inmodel + 4), model.getUint8(inmodel + 5), model.getUint8(inmodel + 6)),
        bboxmax: new Vector(model.getUint8(inmodel + 8), model.getUint8(inmodel + 9), model.getUint8(inmodel + 10)),
        frames: [],
      };
      numframes = model.getUint32(inmodel, true);
      inmodel += 12;
      for (j = 0; j < numframes; j++) {
        group.frames[j] = {interval: model.getFloat32(inmodel, true)};
        if (group.frames[j].interval <= 0.0) {
          throw new Error('Mod.LoadAllFrames: interval<=0');
        }
        inmodel += 4;
      }
      for (j = 0; j < numframes; j++) {
        frame = group.frames[j];
        frame.bboxmin = new Vector(model.getUint8(inmodel), model.getUint8(inmodel + 1), model.getUint8(inmodel + 2));
        frame.bboxmax = new Vector(model.getUint8(inmodel + 4), model.getUint8(inmodel + 5), model.getUint8(inmodel + 6));
        frame.name = Q.memstr(new Uint8Array(buffer, inmodel + 8, 16));
        frame.v = [];
        inmodel += 24;
        for (k = 0; k < loadmodel._num_verts; k++) {
          frame.v[k] = {
            v: new Vector(model.getUint8(inmodel), model.getUint8(inmodel + 1), model.getUint8(inmodel + 2)),
            lightnormalindex: model.getUint8(inmodel + 3),
          };
          inmodel += 4;
        }
      }
      loadmodel.frames[i] = group;
    }
  }
};

Mod.LoadAliasModel = function(loadmodel, buffer) {
  let i; let j; let k; let l;

  loadmodel.type = Mod.type.alias;
  loadmodel.player = loadmodel.name === 'progs/player.mdl';
  const model = new DataView(buffer);
  const version = model.getUint32(4, true);
  if (version !== Mod.version.alias) {
    throw new Error(loadmodel.name + ' has wrong version number (' + version + ' should be ' + Mod.version.alias + ')');
  }
  loadmodel._scale = new Vector(model.getFloat32(8, true), model.getFloat32(12, true), model.getFloat32(16, true));
  loadmodel._scale_origin = new Vector(model.getFloat32(20, true), model.getFloat32(24, true), model.getFloat32(28, true));
  loadmodel.boundingradius = model.getFloat32(32, true);
  loadmodel._num_skins = model.getUint32(48, true);
  if (loadmodel._num_skins === 0) {
    throw new Error('model ' + loadmodel.name + ' has no skins');
  }
  loadmodel._skin_width = model.getUint32(52, true);
  loadmodel._skin_height = model.getUint32(56, true);
  loadmodel._num_verts = model.getUint32(60, true);
  if (loadmodel._num_verts === 0) {
    throw new Error('model ' + loadmodel.name + ' has no vertices');
  }
  loadmodel._num_tris = model.getUint32(64, true);
  if (loadmodel._num_tris === 0) {
    throw new Error('model ' + loadmodel.name + ' has no triangles');
  }
  loadmodel._frames = model.getUint32(68, true);
  if (loadmodel._frames === 0) {
    throw new Error('model ' + loadmodel.name + ' has no frames');
  }
  loadmodel.random = model.getUint32(72, true) === 1;
  loadmodel.flags = model.getUint32(76, true);
  loadmodel.mins = new Vector(-16.0, -16.0, -16.0);
  loadmodel.maxs = new Vector(16.0, 16.0, 16.0);

  let inmodel = Mod.LoadAllSkins(loadmodel, buffer, 84);

  loadmodel._stverts = [];
  for (i = 0; i < loadmodel._num_verts; i++) {
    loadmodel._stverts[i] = {
      onseam: model.getUint32(inmodel, true) !== 0,
      s: model.getUint32(inmodel + 4, true),
      t: model.getUint32(inmodel + 8, true),
    };
    inmodel += 12;
  }

  loadmodel._triangles = [];
  for (i = 0; i < loadmodel._num_tris; i++) {
    loadmodel._triangles[i] = {
      facesfront: model.getUint32(inmodel, true) !== 0,
      vertindex: [
        model.getUint32(inmodel + 4, true),
        model.getUint32(inmodel + 8, true),
        model.getUint32(inmodel + 12, true),
      ],
    };
    inmodel += 16;
  }

  Mod.LoadAllFrames(loadmodel, buffer, inmodel);

  if (registry.isDedicatedServer) {
    // skip frontend-only data
    return;
  }

  const cmds = [];

  let triangle; let vert;
  for (i = 0; i < loadmodel._num_tris; i++) {
    triangle = loadmodel._triangles[i];
    if (triangle.facesfront === true) {
      vert = loadmodel._stverts[triangle.vertindex[0]];
      cmds[cmds.length] = (vert.s + 0.5) / loadmodel._skin_width;
      cmds[cmds.length] = (vert.t + 0.5) / loadmodel._skin_height;
      vert = loadmodel._stverts[triangle.vertindex[1]];
      cmds[cmds.length] = (vert.s + 0.5) / loadmodel._skin_width;
      cmds[cmds.length] = (vert.t + 0.5) / loadmodel._skin_height;
      vert = loadmodel._stverts[triangle.vertindex[2]];
      cmds[cmds.length] = (vert.s + 0.5) / loadmodel._skin_width;
      cmds[cmds.length] = (vert.t + 0.5) / loadmodel._skin_height;
      continue;
    }
    for (j = 0; j < 3; j++) {
      vert = loadmodel._stverts[triangle.vertindex[j]];
      if (vert.onseam === true) {
        cmds[cmds.length] = (vert.s + loadmodel._skin_width / 2 + 0.5) / loadmodel._skin_width;
      } else {
        cmds[cmds.length] = (vert.s + 0.5) / loadmodel._skin_width;
      }
      cmds[cmds.length] = (vert.t + 0.5) / loadmodel._skin_height;
    }
  }

  let group; let frame;
  for (i = 0; i < loadmodel._frames; i++) {
    group = loadmodel.frames[i];
    if (group.group === true) {
      for (j = 0; j < group.frames.length; j++) {
        frame = group.frames[j];
        frame.cmdofs = cmds.length * 4;
        for (k = 0; k < loadmodel._num_tris; k++) {
          triangle = loadmodel._triangles[k];
          for (l = 0; l < 3; l++) {
            vert = frame.v[triangle.vertindex[l]];
            if (vert.lightnormalindex >= 162) {
              throw new Error('lightnormalindex >= NUMVERTEXNORMALS');
            }
            cmds[cmds.length] = vert.v[0] * loadmodel._scale[0] + loadmodel._scale_origin[0];
            cmds[cmds.length] = vert.v[1] * loadmodel._scale[1] + loadmodel._scale_origin[1];
            cmds[cmds.length] = vert.v[2] * loadmodel._scale[2] + loadmodel._scale_origin[2];
            cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][0];
            cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][1];
            cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][2];
          }
        }
      }
      continue;
    }
    frame = group;
    frame.cmdofs = cmds.length * 4;
    for (j = 0; j < loadmodel._num_tris; j++) {
      triangle = loadmodel._triangles[j];
      for (k = 0; k < 3; k++) {
        vert = frame.v[triangle.vertindex[k]];
        if (vert.lightnormalindex >= 162) {
          throw new Error('lightnormalindex >= NUMVERTEXNORMALS');
        }
        cmds[cmds.length] = vert.v[0] * loadmodel._scale[0] + loadmodel._scale_origin[0];
        cmds[cmds.length] = vert.v[1] * loadmodel._scale[1] + loadmodel._scale_origin[1];
        cmds[cmds.length] = vert.v[2] * loadmodel._scale[2] + loadmodel._scale_origin[2];
        cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][0];
        cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][1];
        cmds[cmds.length] = R.avertexnormals[vert.lightnormalindex][2];
      }
    }
  }

  loadmodel.cmds = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, loadmodel.cmds);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
};

Mod.LoadSpriteFrame = function(identifier, buffer, inframe, frame) {
  if (registry.isDedicatedServer) {
    return null;
  }

  const model = new DataView(buffer);
  frame.origin = [model.getInt32(inframe, true), -model.getInt32(inframe + 4, true)];
  frame.width = model.getUint32(inframe + 8, true);
  frame.height = model.getUint32(inframe + 12, true);

  const data = new Uint8Array(buffer, inframe + 16, frame.width * frame.height);

  const rgba = translateIndexToRGBA(data, frame.width, frame.height, W.d_8to24table_u8, 255);
  const glt = GLTexture.Allocate(identifier, frame.width, frame.height, rgba);

  frame.glt = glt;
  frame.texturenum = glt.texnum;
  return inframe + 16 + frame.width * frame.height;
};

Mod.LoadSpriteModel = function(loadmodel, buffer) {
  loadmodel.type = Mod.type.sprite;
  const model = new DataView(buffer);
  const version = model.getUint32(4, true);
  if (version !== Mod.version.sprite) {
    throw new Error(loadmodel.name + ' has wrong version number (' + version + ' should be ' + Mod.version.sprite + ')');
  }
  loadmodel.oriented = model.getUint32(8, true) === 3;
  loadmodel.boundingradius = model.getFloat32(12, true);
  loadmodel.width = model.getUint32(16, true);
  loadmodel.height = model.getUint32(20, true);
  loadmodel._frames = model.getUint32(24, true);
  if (loadmodel._frames === 0) {
    throw new Error('model ' + loadmodel.name + ' has no frames');
  }
  loadmodel.random = model.getUint32(32, true) === 1;
  loadmodel.mins = new Vector(loadmodel.width * -0.5, loadmodel.width * -0.5, loadmodel.height * -0.5);
  loadmodel.maxs = new Vector(loadmodel.width * 0.5, loadmodel.width * 0.5, loadmodel.height * 0.5);

  loadmodel.frames = [];
  let inframe = 36; let i; let j; let frame; let group; let numframes;
  for (i = 0; i < loadmodel._frames; i++) {
    inframe += 4;
    if (model.getUint32(inframe - 4, true) === 0) {
      frame = {group: false};
      loadmodel.frames[i] = frame;
      inframe = Mod.LoadSpriteFrame(loadmodel.name + '_' + i, buffer, inframe, frame);
    } else {
      group = {
        group: true,
        frames: [],
      };
      loadmodel.frames[i] = group;
      numframes = model.getUint32(inframe, true);
      inframe += 4;
      for (j = 0; j < numframes; j++) {
        group.frames[j] = {interval: model.getFloat32(inframe, true)};
        if (group.frames[j].interval <= 0.0) {
          throw new Error('Mod.LoadSpriteModel: interval<=0');
        }
        inframe += 4;
      }
      for (j = 0; j < numframes; j++) {
        inframe = Mod.LoadSpriteFrame(loadmodel.name + '_' + i + '_' + j, buffer, inframe, group.frames[j]);
      }
    }
  }
};

Mod.Print = function() {
  Con.Print('Cached models:\n');
  for (let i = 0; i < Mod.known.length; i++) {
    Con.Print(Mod.known[i].name + '\n');
  }
};

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
  /** @type {{[key: string]: number[]}} */
  animations = {};
  /** @type {number} */
  scale = 1.0;
};

Mod.ParseQC = function(qcContent) {
  console.assert(typeof qcContent === 'string', 'qcContent must be a string');

  const data = new ParsedQC();

  const lines = qcContent.trim().split('\n');

  for (const line of lines) {
    if (line.trim() === '' || line.startsWith('#') || line.startsWith('//')) {
      continue;
    }

    const parts = line.split(/\s+/);
    const [key, value] = [parts.shift(), parts.join(' ')];

    switch (key) {
      case '$cd':
        data.cd = value;
        break;

      case '$origin':
        data.origin = new Vector(...value.split(/\s+/).map((n) => Q.atof(n)));
        break;

      case '$base':
        data.base = value;
        break;

      case '$skin':
        data.skin = value;
        break;

      case '$scale':
        data.scale = +value;
        break;

      case '$frame': {
          const frames = value.split(/\s+/);

          data.frames.push(...frames);

          for (const frame of frames) {
            const matches = frame.match(/^([^0-9]+)([0-9]+)$/);

            if (matches) {
              if (!data.animations[matches[1]]) {
                data.animations[matches[1]] = [];
              }

              data.animations[matches[1]].push(data.frames.indexOf(matches[0]));
            }
          }
        }
        break;

      default:
        Con.Print(`Mod.ParseQC: unknown QC field ${key}\n`);
    }
  }

  return data;
};
