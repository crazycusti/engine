import Vector from '../../shared/Vector.mjs';
import GL, { GLTexture, resampleTexture8 } from '../client/GL.mjs';
import { eventBus, registry } from '../registry.mjs';
import { CorruptedResourceError, MissingResourceError, NotImplementedError } from './Errors.mjs';
import Q from '../../shared/Q.mjs';
import W, { readWad3Texture, translateIndexToRGBA, WadFileInterface } from './W.mjs';
import { CRC16CCITT } from './CRC.mjs';
import { BaseModel, Face, Plane } from './model/BaseModel.mjs';
import { BSP29 } from './model/BSP.mjs';

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

const notexture_mip = {
  name: 'notexture', width: 16, height: 16, texturenum: null,

  glt: null,
  sky: false,
  turbulent: false,
  anims: [],
  anim_base: null,
  alternate_anims: [],
  luminance: null,
  specular: null,
  normal: null,
};

/**
 * Mod.BaseModel
 * Mod.BrushModel
 * Mod.SpriteModel
 * Mod.AliasModel
 */

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

export class BrushModel extends BaseModel {
  /** @type {29|844124994} */
  version = null;

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

  nodes = [];

  bspxoffset = 0;
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

Mod.version = {brush: 29, sprite: 1, alias: 6, bsp2: 844124994};

Mod.known = [];

Mod.Init = function() {
  Mod.novis = new Array(1024);
  Mod.novis.fill(0xff);
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

Mod.LoadModelFromBuffer = function (loadmodel, buffer) {
  loadmodel.needload = false;
  loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));
  const ident = (new DataView(buffer)).getUint32(0, true);
  switch (ident) {
    case 0x4f504449: // IDPO
      return Mod.LoadAliasModel(loadmodel, buffer);
    case 0x50534449: // IDSP
      return Mod.LoadSpriteModel(loadmodel, buffer);
    case Mod.version.brush:
      return Mod.LoadBrushModel(loadmodel, buffer);
      // return new BSP29(loadmodel.name).load(buffer);
    case Mod.version.bsp2:
      throw new NotImplementedError('BSP2 loading not implemented yet');
    default:
      throw new NotImplementedError('Unknown model format ' + ident + ' for ' + loadmodel.name);
  }
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
  return Mod.LoadModelFromBuffer(mod, buf);
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
  return Mod.LoadModelFromBuffer(mod, buf);
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

/** @deprecated */
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

Mod.LoadTextures = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.textures << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.textures << 3) + 8, true);
  loadmodel.textures = [];
  const nummiptex = view.getUint32(fileofs, true);
  let dataofs = fileofs + 4;
  let miptexofs;
  for (let i = 0; i < nummiptex; i++) {
    miptexofs = view.getInt32(dataofs, true);
    dataofs += 4;
    if (miptexofs === -1) {
      loadmodel.textures[i] = notexture_mip;
      continue;
    }
    miptexofs += fileofs;
    const tx = { // TODO: material class
      name: Q.memstr(new Uint8Array(buf, miptexofs, 16)),
      width: view.getUint32(miptexofs + 16, true),
      height: view.getUint32(miptexofs + 20, true),
      glt: null,
      sky: false,
      turbulent: false,
      anims: [],
      anim_base: null,
      alternate_anims: [],
      luminance: null,
      specular: null,
      normal: null,
    };

    // dedicated server is not interested in loading textures
    if (!registry.isDedicatedServer) {
      if (tx.name.substring(0, 3).toLowerCase() === 'sky') {
        R.InitSky(new Uint8Array(buf, miptexofs + view.getUint32(miptexofs + 24, true), 32768));
        tx.texturenum = R.solidskytexture;
        R.skytexturenum = i;
        tx.sky = true;
      } else {
        // HACK: awful hack to load WAD3 textures if available
        //       we check if after the textures there is a uint64 with value 256
        const len = (
          40 +
          tx.width / 1 * tx.height / 1 +
          tx.width / 2 * tx.height / 2 +
          tx.width / 4 * tx.height / 4 +
          tx.width / 8 * tx.height / 8 +
          2 + 768
        );

        if (miptexofs + len - 2 - 768 < buf.byteLength) {
          const magic = view.getInt16(miptexofs + len - 2 - 768, true);

          if (magic === 256) { // guessing it’s WAD3 texmip
            const data = new ArrayBuffer(len);
            new Uint8Array(data).set(new Uint8Array(buf, miptexofs, len));
            const wtex = readWad3Texture(data, tx.name, 0);

            tx.glt = GLTexture.FromLumpTexture(wtex);
          }
        }
      }

      if (!tx.glt) {
        tx.glt = GLTexture.Allocate(tx.name, tx.width, tx.height, translateIndexToRGBA(new Uint8Array(buf, miptexofs + view.getUint32(miptexofs + 24, true), tx.width * tx.height), tx.width, tx.height, W.d_8to24table_u8, tx.name[0] === '{' ? 255 : null, 240));
      }

      if (tx.name[0] === '*' || tx.name[0] === '!') {
        tx.turbulent = true;
      }
    }
    loadmodel.textures[i] = tx;
  }

  for (let i = 0; i < nummiptex; i++) {
    const tx = loadmodel.textures[i];
    if (tx.name[0] !== '+') {
      continue;
    }
    if (tx.name[1] !== '0') {
      continue;
    }
    const name = tx.name.substring(2);
    tx.anims = [i];
    tx.alternate_anims = [];
    for (let j = 0; j < nummiptex; j++) {
      const tx2 = loadmodel.textures[j];
      if (tx2.name[0] !== '+') {
        continue;
      }
      if (tx2.name.substring(2) !== name) {
        continue;
      }
      // animation groups
      let num = tx2.name.charCodeAt(1);
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
    for (let j = 0; j < tx.anims.length; j++) {
      if (tx.anims[j] === undefined) {
        throw new Error('Missing frame ' + j + ' of ' + tx.name);
      }
    }
    for (let j = 0; j < tx.alternate_anims.length; j++) {
      if (tx.alternate_anims[j] === undefined) {
        throw new Error('Missing frame ' + j + ' of ' + tx.name);
      }
    }
    loadmodel.textures[i] = tx;
  }

  loadmodel.textures[loadmodel.textures.length] = notexture_mip;

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

/** @typedef {{luminance: string|undefined, diffuse: string|undefined, specular: string|undefined, normal: string|undefined}} MaterialDataMaterialT */
/** @typedef {{version: number, materials: Record<string,MaterialDataMaterialT>}} MaterialDataT */

Mod.LoadMaterials = function(loadmodel) {
  const matfile = COM.LoadTextFile(loadmodel.name.replace('.bsp', '.qsmat.json'));

  if (!matfile) {
    return;
  }

  Con.DPrint(`Mod.LoadMaterials: found materials file for ${loadmodel.name}\n`);

  /** @type {MaterialDataT} */
  const materialData = JSON.parse(matfile);

  console.assert(materialData.version === 1);

  for (const [txName, textures] of Object.entries(materialData.materials)) {
    const texture = loadmodel.textures.find((t) => t.name === txName);

    if (!texture) {
      Con.PrintWarning(`Mod.LoadMaterials: referenced material (${txName}) is not used\n`);
      continue;
    }

    for (const category of ['luminance', 'diffuse', 'specular', 'normal']) {
      if (textures[category]) {
        GLTexture.FromImageFile(textures[category]).then((function(glt) {
          const { texture, category } = this;
          texture[category === 'diffuse' ? 'glt' : category] = glt;
          Con.DPrint(`Mod.LoadMaterials: loaded ${category} texture for ${texture.name} from ${textures[category]}\n`);
        }).bind({ texture, category })).catch((e) => {
          Con.PrintError(`Mod.LoadMaterials: failed to load ${textures[category]}: ${e.message}\n`);
        });
      }
    }

    // if (textures.luminance) {
    //   GLTexture.FromImageFile(textures.luminance).then((function(glt) {
    //     texture.luminance = glt;
    //   }).bind(texture)).catch((e) => {
    //     Con.PrintError(`Mod.LoadMaterials: failed to load ${textures.luminance}: ${e.message}\n`);
    //   });
    // }

    // if (textures.diffuse) {
    //   GLTexture.FromImageFile(textures.diffuse).then((function(glt) {
    //     texture.glt = glt;
    //   }).bind(texture)).catch((e) => {
    //     Con.PrintError(`Mod.LoadMaterials: failed to load ${textures.diffuse}: ${e.message}\n`);
    //   });
    // }
  }
};

Mod.LoadLighting = function(loadmodel, buf) {
  loadmodel.lightdata_rgb = null;
  loadmodel.lightdata = null;

  // const litfile = COM.LoadFile(loadmodel.name.replace('.bsp', '.lit'));

  // if (litfile) {
  //   Con.DPrint(`Mod.LoadLighting: using external .lit file for ${loadmodel.name}\n`);

  //   loadmodel.lightdata_rgb = new Uint8Array(litfile.slice(8)); // skip header
  //   // return;
  // }

  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.lighting << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.lighting << 3) + 8, true);
  if (filelen === 0) {
    return;
  }
  loadmodel.lightdata = new Uint8Array(new ArrayBuffer(filelen));
  loadmodel.lightdata.set(new Uint8Array(buf, fileofs, filelen));

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadEntities = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.entities << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.entities << 3) + 8, true);
  loadmodel.entities = Q.memstr(new Uint8Array(buf, fileofs, filelen));

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadEdges = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.edges << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.edges << 3) + 8, true);
  if ((filelen & 3) !== 0) {
    throw new CorruptedResourceError(loadmodel.name, 'funny lump size');
  }
  const count = filelen >> 2;
  loadmodel.edges = [];
  for (let i = 0; i < count; i++) {
    loadmodel.edges[i] = [view.getUint16(fileofs, true), view.getUint16(fileofs + 2, true)];
    fileofs += 4;
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadEdgesBSP2 = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.edges << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.edges << 3) + 8, true);
  if ((filelen & 3) !== 0) {
    throw new CorruptedResourceError(loadmodel.name, 'funny lump size');
  }
  const count = filelen >> 2;
  loadmodel.edges = [];
  for (let i = 0; i < count; i++) {
    loadmodel.edges[i] = [view.getUint32(fileofs, true), view.getUint32(fileofs + 4, true)];
    fileofs += 8;
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadFaces = function(loadmodel, buf) {
  const view = new DataView(buf);
  let fileofs = view.getUint32((Mod.lump.faces << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.faces << 3) + 8, true);
  if ((filelen % 20) !== 0) {
    throw new CorruptedResourceError(loadmodel.name, 'Mod.LoadFaces: funny lump size');
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
    const verts = [];
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
      if (j >= 3) {
        verts.push(verts[0]);
        verts.push(verts[verts.length - 2]);
      }
      verts.push(v);
    }
    out.texturemins = [Math.floor(mins[0] / 16) * 16, Math.floor(mins[1] / 16) * 16];
    out.extents = [Math.ceil(maxs[0] / 16) * 16 - out.texturemins[0], Math.ceil(maxs[1] / 16) * 16 - out.texturemins[1]];

    if (loadmodel.textures[tex.texture].turbulent === true) {
      out.turbulent = true;
    } else if (loadmodel.textures[tex.texture].sky === true) {
      out.sky = true;
    }

    // applying Newell's method for properly handling n-gons
    for (let i = 0; i < verts.length; i++) {
      const vCurrent = verts[i];
      const vNext = verts[(i + 1) % verts.length];
      out.normal[0] += (vCurrent[1] - vNext[1]) * (vCurrent[2] + vNext[2]);
      out.normal[1] += (vCurrent[2] - vNext[2]) * (vCurrent[0] + vNext[0]);
      out.normal[2] += (vCurrent[0] - vNext[0]) * (vCurrent[1] + vNext[1]);
    }

    out.normal.normalize();

    loadmodel.faces[i] = out;
    fileofs += 20;
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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
  for (let i = 0; i < count; i++) {
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
  for (let i = 0; i < count; i++) {
    const out = loadmodel.nodes[i];
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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
  for (let i = 0; i < count; i++) {
    const out = {
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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
  for (let i = 0; i < count; i++) {
    loadmodel.clipnodes[i] = {
      planenum: view.getUint32(fileofs, true),
      children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
    };
    fileofs += 8;
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.MakeHull0 = function(loadmodel) {
  const clipnodes = [];
  const hull = {
    clipnodes: clipnodes,
    lastclipnode: loadmodel.nodes.length - 1,
    planes: loadmodel.planes,
    clip_mins: new Vector(),
    clip_maxs: new Vector(),
  };
  for (let i = 0; i < loadmodel.nodes.length; i++) {
    const node = loadmodel.nodes[i];
    const out = {planenum: node.planenum, children: []};
    let child;
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
  for (let i = 0; i < count; i++) {
    const j = view.getUint16(fileofs + (i << 1), true);
    if (j > loadmodel.faces.length) {
      throw new Error('Mod.LoadMarksurfaces: bad surface number');
    }
    loadmodel.marksurfaces[i] = j;
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadSurfedges = function(loadmodel, buf) {
  const view = new DataView(buf);
  const fileofs = view.getUint32((Mod.lump.surfedges << 3) + 4, true);
  const filelen = view.getUint32((Mod.lump.surfedges << 3) + 8, true);
  const count = filelen >> 2;
  loadmodel.surfedges = [];
  for (let i = 0; i < count; i++) {
    loadmodel.surfedges[i] = view.getInt32(fileofs + (i << 2), true);
  }

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
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
    const normal = new Vector(view.getFloat32(fileofs, true), view.getFloat32(fileofs + 4, true), view.getFloat32(fileofs + 8, true));
    const dist = view.getFloat32(fileofs + 12, true);
    const out = new Plane(normal, dist);
    out.type = view.getUint32(fileofs + 16, true);
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

  loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
};

Mod.LoadBSPX = function(loadmodel, buffer) {
  loadmodel.bspxoffset = (loadmodel.bspxoffset + 3) & ~3;

  if (loadmodel.bspxoffset >= buffer.byteLength) {
    Con.DPrint('Mod.LoadBSPX: no BSPX data found\n');
    return;
  }

  const view = new DataView(buffer);

  const magic = view.getUint32(loadmodel.bspxoffset, true); // version

  console.assert(magic === 0x58505342, 'Mod.LoadBSPX: bad magic');

  const numlumps = view.getUint32(loadmodel.bspxoffset + 4, true);

  Con.DPrint('Mod.LoadBSPX: found BSPX data with ' + numlumps + ' lumps\n');

  const bspxLumps = {};

  for (let i = 0, pointer = loadmodel.bspxoffset + 8; i < numlumps; i++, pointer += 32) {
    const name = Q.memstr(new Uint8Array(buffer, pointer, 24));
    const fileofs = view.getUint32(pointer + 24, true);
    const filelen = view.getUint32(pointer + 24 + 4, true);

    bspxLumps[name] = {
      fileofs,
      filelen,
    };
  }

  loadmodel.bspxlumps = bspxLumps;
};

Mod.LoadLightingRGB = function(loadmodel, buf) {
  loadmodel.lightdata_rgb = null;

  if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['RGBLIGHTING']) {
    return;
  }

  const { fileofs, filelen } = loadmodel.bspxlumps['RGBLIGHTING'];

  if (filelen === 0) {
    return;
  }

  loadmodel.lightdata_rgb = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
};

Mod.LoadDeluxeMap = function(loadmodel, buf) {
  loadmodel.deluxemap = null;

  if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTINGDIR']) {
    return;
  }

  const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTINGDIR'];

  if (filelen === 0) {
    return;
  }

  loadmodel.deluxemap = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
};

/**
 *
 * @param {BrushModel} loadmodel
 * @param {ArrayBuffer} buffer
 * @returns {BrushModel}
 */
Mod.LoadBrushModel = function(loadmodel, buffer) {
  loadmodel.type = Mod.type.brush;
  loadmodel.version = /** @type {29|844124994} */ ((new DataView(buffer)).getUint32(0, true));
  loadmodel.bspxoffset = 0;
  Mod.LoadVertexes(loadmodel, buffer); // OK
  Mod.LoadEdges(loadmodel, buffer);
  Mod.LoadSurfedges(loadmodel, buffer); // OK
  Mod.LoadTextures(loadmodel, buffer); // OK
  Mod.LoadMaterials(loadmodel);
  Mod.LoadLighting(loadmodel, buffer); // OK
  Mod.LoadPlanes(loadmodel, buffer); // OK
  Mod.LoadTexinfo(loadmodel, buffer); // OK
  Mod.LoadFaces(loadmodel, buffer);
  Mod.LoadMarksurfaces(loadmodel, buffer);
  Mod.LoadVisibility(loadmodel, buffer);
  Mod.LoadLeafs(loadmodel, buffer);
  Mod.LoadNodes(loadmodel, buffer);
  Mod.LoadClipnodes(loadmodel, buffer);
  Mod.MakeHull0(loadmodel);
  Mod.LoadEntities(loadmodel, buffer);
  Mod.LoadSubmodels(loadmodel, buffer);
  Mod.LoadBSPX(loadmodel, buffer);
  Mod.LoadLightingRGB(loadmodel, buffer);
  Mod.LoadDeluxeMap(loadmodel, buffer);

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
  return loadmodel;
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
    return loadmodel;
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
            console.assert(vert.lightnormalindex < R.avertexnormals.length);
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
        console.assert(vert.lightnormalindex < R.avertexnormals.length);
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

  return loadmodel;
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

  return loadmodel;
};

Mod.Print = function() {
  Con.Print('Cached models:\n');
  for (let i = 0; i < Mod.known.length; i++) {
    Con.Print(Mod.known[i].name + '\n');
  }
};

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

Mod.ParseQC = function(qcContent) {
  const data = new ParsedQC();

  return data.parseQC(qcContent);
};
