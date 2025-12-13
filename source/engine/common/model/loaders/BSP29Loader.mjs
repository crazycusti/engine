import Vector from '../../../../shared/Vector.mjs';
import Q from '../../../../shared/Q.mjs';
import { GLTexture } from '../../../client/GL.mjs';
import W, { readWad3Texture, translateIndexToRGBA } from '../../W.mjs';
import { CRC16CCITT } from '../../CRC.mjs';
import { CorruptedResourceError } from '../../Errors.mjs';
import { eventBus, registry } from '../../../registry.mjs';
import { ModelLoader } from '../ModelLoader.mjs';
import { BrushModel, Node } from '../BSP.mjs';
import { Face, Plane } from '../BaseModel.mjs';
import { materialFlags, noTextureMaterial, PBRMaterial, QuakeMaterial } from '../../../client/renderer/Materials.mjs';

// Get registry references (will be set by eventBus)
let { COM, Con, Mod, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ COM, Con, Mod, R } = registry);
});

/**
 * Loader for Quake BSP29 format (.bsp)
 * It supports vanilla BSP29 and a few BSPX extensions (such as lightgrid, RGB lighting).
 */
export class BSP29Loader extends ModelLoader {
  /** BSP29 lump indices */
  static #lump = Object.freeze({
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
  });

  constructor() {
    super();
  }

  /**
   * Get magic numbers that identify this format
   * @returns {number[]} Array of magic numbers
   */
  getMagicNumbers() {
    return [29]; // BSP version 29
  }

  /**
   * Get file extensions for this format
   * @returns {string[]} Array of file extensions
   */
  getExtensions() {
    return ['.bsp'];
  }

  /**
   * Get human-readable name of this loader
   * @returns {string} Loader name
   */
  getName() {
    return 'Quake BSP29';
  }

  /**
   * Load a BSP29 map model from buffer
   * @param {ArrayBuffer} buffer - The BSP file data
   * @param {string} name - The model name/path
   * @returns {Promise<BrushModel>} The loaded model
   */
  async load(buffer, name) {
    const loadmodel = new BrushModel(name);

    loadmodel.version = /** @type {29|844124994} */ ((new DataView(buffer)).getUint32(0, true));
    loadmodel.bspxoffset = 0;

    // Load all BSP lumps
    this._loadEntities(loadmodel, buffer);
    this._loadVertexes(loadmodel, buffer);
    this._loadEdges(loadmodel, buffer);
    this._loadSurfedges(loadmodel, buffer);
    this._loadTextures(loadmodel, buffer);
    await this._loadMaterials(loadmodel);
    this._loadLighting(loadmodel, buffer);
    this._loadPlanes(loadmodel, buffer);
    this._loadTexinfo(loadmodel, buffer);
    this._loadFaces(loadmodel, buffer);
    this._loadMarksurfaces(loadmodel, buffer);
    this._loadVisibility(loadmodel, buffer);
    this._loadLeafs(loadmodel, buffer);
    this._loadNodes(loadmodel, buffer);
    this._loadClipnodes(loadmodel, buffer);
    this._makeHull0(loadmodel);
    this._loadBSPX(loadmodel, buffer);
    this._loadLightingRGB(loadmodel, buffer);
    this._loadDeluxeMap(loadmodel, buffer);
    this._loadLightgridOctree(loadmodel, buffer);
    this._loadSubmodels(loadmodel, buffer); // CR: must be last, since it’s creating additional models based on this one

    if (loadmodel.coloredlights && !loadmodel.lightdata_rgb) {
      await this._loadExternalLighting(loadmodel, name);
    }

    // Calculate bounding radius
    this._calculateRadius(loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    return loadmodel;
  }

  /**
   * Calculate the bounding radius of the model from its vertices
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   */
  _calculateRadius(loadmodel) {
    const mins = new Vector();
    const maxs = new Vector();

    for (let i = 0; i < loadmodel.vertexes.length; i++) {
      const vert = loadmodel.vertexes[i];
      if (vert[0] < mins[0]) { mins[0] = vert[0]; }
      else if (vert[0] > maxs[0]) { maxs[0] = vert[0]; }
      if (vert[1] < mins[1]) { mins[1] = vert[1]; }
      else if (vert[1] > maxs[1]) { maxs[1] = vert[1]; }
      if (vert[2] < mins[2]) { mins[2] = vert[2]; }
      else if (vert[2] > maxs[2]) { maxs[2] = vert[2]; }
    }

    loadmodel.radius = (new Vector(
      Math.abs(mins[0]) > Math.abs(maxs[0]) ? Math.abs(mins[0]) : Math.abs(maxs[0]),
      Math.abs(mins[1]) > Math.abs(maxs[1]) ? Math.abs(mins[1]) : Math.abs(maxs[1]),
      Math.abs(mins[2]) > Math.abs(maxs[2]) ? Math.abs(mins[2]) : Math.abs(maxs[2]),
    )).len();
  }

  /**
   * Load texture information and create GL textures from BSP texture lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadTextures(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.textures << 3) + 4, true);
    const filelen = view.getUint32((lump.textures << 3) + 8, true);
    loadmodel.textures.length = 0;
    const nummiptex = view.getUint32(fileofs, true);
    let dataofs = fileofs + 4;

    // const textures = /** @type {Record<string,GLTexture>} */ ({}); // list of textures
    const materials = /** @type {Record<string,QuakeMaterial>} */ ({}); // list of materials

    for (let i = 0; i < nummiptex; i++) {
      const miptexofs = view.getInt32(dataofs, true);
      dataofs += 4;
      if (miptexofs === -1) {
        loadmodel.textures[i] = noTextureMaterial;
        continue;
      }
      const absofs = miptexofs + fileofs;

      const name = Q.memstr(new Uint8Array(buf, absofs, 16));
      const cleanName = name.replace(/^\+[0-9a-j]/, ''); // no anim prefix

      const tx = materials[cleanName] || new QuakeMaterial(name, view.getUint32(absofs + 16, true), view.getUint32(absofs + 20, true));

      materials[cleanName] = tx;

      let glt = null;

      // Load texture data (skip for dedicated server)
      if (!registry.isDedicatedServer) {
        if (tx.name.substring(0, 3).toLowerCase() === 'sky') {
          R.InitSky(new Uint8Array(buf, absofs + view.getUint32(absofs + 24, true), 32768));
          R.skytexturenum = i;
          tx.flags |= materialFlags.MF_SKY;
        } else {
          // Try loading WAD3 texture
          const len = 40 + tx.width * tx.height * (1 + 0.25 + 0.0625 + 0.015625) + 2 + 768;
          if (absofs + len - 2 - 768 < buf.byteLength) {
            const magic = view.getInt16(absofs + len - 2 - 768, true);
            if (magic === 256) {
              const data = new ArrayBuffer(len);
              new Uint8Array(data).set(new Uint8Array(buf, absofs, len));
              const wtex = readWad3Texture(data, tx.name, 0);
              glt = GLTexture.FromLumpTexture(wtex);
            }
          }
        }

        if (!glt) {
          const pixelData = new Uint8Array(buf, absofs + view.getUint32(absofs + 24, true), tx.width * tx.height);
          const rgba = translateIndexToRGBA(pixelData, tx.width, tx.height, W.d_8to24table_u8, tx.name[0] === '{' ? 255 : null, 240);
          const textureId = `${tx.name}/${CRC16CCITT.Block(pixelData)}`; // CR: unique texture ID to avoid conflicts across maps
          glt = GLTexture.Allocate(textureId, tx.width, tx.height, rgba);
        }

        if (tx.name[0] === '*' || tx.name[0] === '!') {
          tx.flags |= materialFlags.MF_TURBULENT;
        }

        // Mark textures with '{' prefix as transparent (for alpha blending)
        if (tx.name[0] === '{') {
          tx.flags |= materialFlags.MF_TRANSPARENT;
        }
      }

      if (name[0] === '+') { // animation prefix
        const frame = name.toUpperCase().charCodeAt(1);

        if (frame >= 48 && frame <= 57) { // '0'-'9'
          const frameIndex = frame - 48;
          tx.addAnimationFrame(frameIndex, glt);
        } else if (frame >= 65 && frame <= 74) { // 'A'-'J'
          const frameIndex = frame - 65;
          tx.addAlternateFrame(frameIndex, glt);
        }
      } else {
        tx.texture = glt;
      }

      loadmodel.textures[i] = tx;
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load material definitions from .qsmat.json file if available
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   */
  async _loadMaterials(loadmodel) {
    const matfile = await COM.LoadTextFile(loadmodel.name.replace(/\.bsp$/i, '.qsmat.json'));

    if (!matfile) {
      return;
    }

    Con.DPrint(`BSP29Loader: found materials file for ${loadmodel.name}\n`);
    const materialData = JSON.parse(matfile);
    console.assert(materialData.version === 1);

    for (const [txName, textures] of Object.entries(materialData.materials)) {
      const textureEntry = Array.from(loadmodel.textures.entries()).find(([, t]) => t.name === txName);

      if (!textureEntry) {
        Con.PrintWarning(`BSP29Loader: referenced material (${txName}) is not used\n`);
        continue;
      }

      const [txIndex, texture] = textureEntry;
      const pbr = new PBRMaterial(texture.name, texture.width, texture.height);

      for (const category of ['luminance', 'diffuse', 'specular', 'normal']) {
        if (textures[category]) {
          try {
            pbr[category] = await GLTexture.FromImageFile(textures[category]);
            Con.DPrint(`BSP29Loader: loaded ${category} texture for ${texture.name} from ${textures[category]}\n`);
          } catch (e) {
            Con.PrintError(`BSP29Loader: failed to load ${textures[category]}: ${e.message}\n`);
          }
        }
      }

      if (textures.flags) {
        for (const flagName of textures.flags) {
          const flagValue = materialFlags[flagName];
          console.assert(typeof flagValue === 'number', `BSP29Loader: unknown material flag ${flagName} in ${loadmodel.name}`);
          pbr.flags |= flagValue;
        }
      }

      if (!textures.diffuse && (texture instanceof QuakeMaterial)) {
        pbr.diffuse = texture.texture; // keep original diffuse as base
      }

      loadmodel.textures[txIndex] = pbr; // replace with PBR material
    }
  }

  /**
   * Load lighting data from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadLighting(loadmodel, buf) {
    loadmodel.lightdata_rgb = null;
    loadmodel.lightdata = null;

    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.lighting << 3) + 4, true);
    const filelen = view.getUint32((lump.lighting << 3) + 8, true);

    if (filelen === 0) {
      return;
    }

    loadmodel.lightdata = new Uint8Array(new ArrayBuffer(filelen));
    loadmodel.lightdata.set(new Uint8Array(buf, fileofs, filelen));
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load visibility data for potentially visible set (PVS) calculations
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadVisibility(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.visibility << 3) + 4, true);
    const filelen = view.getUint32((lump.visibility << 3) + 8, true);

    if (filelen === 0) {
      return;
    }

    loadmodel.visdata = new Uint8Array(new ArrayBuffer(filelen));
    loadmodel.visdata.set(new Uint8Array(buf, fileofs, filelen));
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load entities from BSP lump and parse worldspawn properties.
   * Also this tries to parse light entities to determine if RGB lighting is used and whether we need to load the .lit file.
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadEntities(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.entities << 3) + 4, true);
    const filelen = view.getUint32((lump.entities << 3) + 8, true);
    loadmodel.entities = Q.memstr(new Uint8Array(buf, fileofs, filelen));
    loadmodel.worldspawnInfo = {};

    let data = loadmodel.entities;

    // going for worldspawn and light
    let stillLooking = 2;
    while (stillLooking > 0) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data) {
        break;
      }

      const currentEntity = {};
      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        currentEntity[parsedKey.token] = parsedValue.token;
      }

      if (!currentEntity.classname) {
        break;
      }

      switch (currentEntity.classname) {
        case 'worldspawn':
          Object.assign(loadmodel.worldspawnInfo, currentEntity);
          stillLooking--;
          break;

        case 'light':
          if (currentEntity._color) {
            loadmodel.coloredlights = true;
            stillLooking--;
          }
          break;
      }
    }

    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load vertices from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If vertex lump size is not a multiple of 12
   */
  _loadVertexes(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.vertexes << 3) + 4, true);
    const filelen = view.getUint32((lump.vertexes << 3) + 8, true);
    if ((filelen % 12) !== 0) {
      throw new Error('BSP29Loader: vertexes lump size is not a multiple of 12 in ' + loadmodel.name);
    }
    const count = filelen / 12;
    loadmodel.vertexes.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.vertexes[i] = new Vector(
        view.getFloat32(fileofs, true),
        view.getFloat32(fileofs + 4, true),
        view.getFloat32(fileofs + 8, true),
      );
      fileofs += 12;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load edges from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If edge lump size is not a multiple of 4
   */
  _loadEdges(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.edges << 3) + 4, true);
    const filelen = view.getUint32((lump.edges << 3) + 8, true);
    if ((filelen & 3) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: edges lump size is not a multiple of 4');
    }
    const count = filelen >> 2;
    loadmodel.edges.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.edges[i] = [view.getUint16(fileofs, true), view.getUint16(fileofs + 2, true)];
      fileofs += 4;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load surface edges from BSP lump (indices into edge array, negative = reversed)
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadSurfedges(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.surfedges << 3) + 4, true);
    const filelen = view.getUint32((lump.surfedges << 3) + 8, true);
    const count = filelen >> 2;
    loadmodel.surfedges.length = 0;
    for (let i = 0; i < count; i++) {
      loadmodel.surfedges[i] = view.getInt32(fileofs + (i << 2), true);
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load planes from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If planes lump size is not a multiple of 20
   */
  _loadPlanes(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.planes << 3) + 4, true);
    const filelen = view.getUint32((lump.planes << 3) + 8, true);
    if ((filelen % 20) !== 0) {
      throw new Error('BSP29Loader: planes lump size is not a multiple of 20 in ' + loadmodel.name);
    }
    const count = filelen / 20;
    loadmodel.planes.length = 0;
    for (let i = 0; i < count; i++) {
      const normal = new Vector(
        view.getFloat32(fileofs, true),
        view.getFloat32(fileofs + 4, true),
        view.getFloat32(fileofs + 8, true),
      );
      const dist = view.getFloat32(fileofs + 12, true);
      const out = new Plane(normal, dist);
      out.type = view.getUint32(fileofs + 16, true);
      if (out.normal[0] < 0) { out.signbits |= 1; }
      if (out.normal[1] < 0) { out.signbits |= 2; }
      if (out.normal[2] < 0) { out.signbits |= 4; }
      loadmodel.planes[i] = out;
      fileofs += 20;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load texture coordinate information from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If texinfo lump size is not a multiple of 40
   */
  _loadTexinfo(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.texinfo << 3) + 4, true);
    const filelen = view.getUint32((lump.texinfo << 3) + 8, true);
    if ((filelen % 40) !== 0) {
      throw new Error('BSP29Loader: texinfo lump size is not a multiple of 40 in ' + loadmodel.name);
    }
    const count = filelen / 40;
    loadmodel.texinfo.length = 0;
    for (let i = 0; i < count; i++) {
      const out = {
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
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load faces (surfaces) from BSP lump and calculate face normals
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If faces lump size is not a multiple of 20
   */
  _loadFaces(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.faces << 3) + 4, true);
    const filelen = view.getUint32((lump.faces << 3) + 8, true);
    if ((filelen % 20) !== 0) {
      throw new CorruptedResourceError(loadmodel.name, 'BSP29Loader: faces lump size is not a multiple of 20');
    }

    const lmshift = loadmodel.worldspawnInfo._lightmap_scale ? Math.log2(parseInt(loadmodel.worldspawnInfo._lightmap_scale)) : 4;
    const count = filelen / 20;
    loadmodel.firstface = 0;
    loadmodel.numfaces = count;
    loadmodel.faces.length = 0;

    for (let i = 0; i < count; i++) {
      const styles = new Uint8Array(buf, fileofs + 12, 4);
      const out = Object.assign(new Face(), {
        plane: loadmodel.planes[view.getUint16(fileofs, true)],
        firstedge: view.getUint16(fileofs + 4, true),
        numedges: view.getUint16(fileofs + 8, true),
        texinfo: view.getUint16(fileofs + 10, true),
        styles: [],
        lightofs: view.getInt32(fileofs + 16, true),
        lmshift,
      });

      for (let j = 0; j < 4; j++) {
        if (styles[j] !== 255) { out.styles[j] = styles[j]; }
      }

      const mins = [Infinity, Infinity];
      const maxs = [-Infinity, -Infinity];
      const tex = loadmodel.texinfo[out.texinfo];
      out.texture = tex.texture;
      const verts = [];

      for (let j = 0; j < out.numedges; j++) {
        const e = loadmodel.surfedges[out.firstedge + j];
        const v = e >= 0
          ? loadmodel.vertexes[loadmodel.edges[e][0]]
          : loadmodel.vertexes[loadmodel.edges[-e][1]];

        const val0 = v.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3];
        const val1 = v.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3];
        if (val0 < mins[0]) { mins[0] = val0; }
        if (val0 > maxs[0]) { maxs[0] = val0; }
        if (val1 < mins[1]) { mins[1] = val1; }
        if (val1 > maxs[1]) { maxs[1] = val1; }

        if (j >= 3) {
          verts.push(verts[0], verts[verts.length - 2]);
        }
        verts.push(v);
      }

      const lmscale = 1 << out.lmshift;
      out.texturemins = [Math.floor(mins[0] / lmscale) * lmscale, Math.floor(mins[1] / lmscale) * lmscale];
      out.extents = [Math.ceil(maxs[0] / lmscale) * lmscale - out.texturemins[0], Math.ceil(maxs[1] / lmscale) * lmscale - out.texturemins[1]];

      if (loadmodel.textures[tex.texture].turbulent === true) {
        out.turbulent = true;
      } else if (loadmodel.textures[tex.texture].sky === true) {
        out.sky = true;
      }

      // Calculate face normal using Newell's method
      for (let j = 0; j < verts.length; j++) {
        const vCurrent = verts[j];
        const vNext = verts[(j + 1) % verts.length];
        out.normal[0] += (vCurrent[1] - vNext[1]) * (vCurrent[2] + vNext[2]);
        out.normal[1] += (vCurrent[2] - vNext[2]) * (vCurrent[0] + vNext[0]);
        out.normal[2] += (vCurrent[0] - vNext[0]) * (vCurrent[1] + vNext[1]);
      }
      out.normal.normalize();

      loadmodel.faces[i] = out;
      fileofs += 20;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Recursively set parent references for BSP tree nodes
   * @protected
   * @param {import('../BSP.mjs').Node} node - The node to set parent for
   * @param {import('../BSP.mjs').Node|null} parent - The parent node
   */
  _setParent(node, parent) {
    node.parent = parent;

    if (node.contents < 0) {
      return;
    }

    this._setParent(/** @type {import('../BSP.mjs').Node} */(node.children[0]), node);
    this._setParent(/** @type {import('../BSP.mjs').Node} */(node.children[1]), node);
  }

  /**
   * Load BSP tree nodes from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {CorruptedResourceError} If nodes lump is empty or incorrectly sized
   */
  _loadNodes(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.nodes << 3) + 4, true);
    const filelen = view.getUint32((lump.nodes << 3) + 8, true);

    if ((filelen === 0) || ((filelen % 24) !== 0)) {
      throw new Error('BSP29Loader: nodes lump size is invalid in ' + loadmodel.name);
    }

    const count = filelen / 24;
    loadmodel.nodes.length = 0;

    for (let i = 0; i < count; i++) {
      loadmodel.nodes[i] = Object.assign(new Node(loadmodel), {
        num: i,
        planenum: view.getUint32(fileofs, true),
        children: [view.getInt16(fileofs + 4, true), view.getInt16(fileofs + 6, true)],
        mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
        maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
        firstface: view.getUint16(fileofs + 20, true),
        numfaces: view.getUint16(fileofs + 22, true),
      });
      fileofs += 24;
    }

    for (let i = 0; i < count; i++) {
      const out = loadmodel.nodes[i];
      out.plane = loadmodel.planes[out.planenum];
      // At this point children contain indices, we convert them to Node references
      const child0Idx = /** @type {number} */ (out.children[0]);
      const child1Idx = /** @type {number} */ (out.children[1]);
      out.children[0] = child0Idx >= 0
        ? loadmodel.nodes[child0Idx]
        : loadmodel.leafs[-1 - child0Idx];
      out.children[1] = child1Idx >= 0
        ? loadmodel.nodes[child1Idx]
        : loadmodel.leafs[-1 - child1Idx];
    }

    this._setParent(loadmodel.nodes[0], null);
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSP leaf nodes from BSP lump
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If leafs lump size is not a multiple of 28
   */
  _loadLeafs(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.leafs << 3) + 4, true);
    const filelen = view.getUint32((lump.leafs << 3) + 8, true);
    if ((filelen % 28) !== 0) {
      throw new Error('BSP29Loader: leafs lump size is not a multiple of 28 in ' + loadmodel.name);
    }
    const count = filelen / 28;
    loadmodel.leafs.length = count;

    for (let i = 0; i < count; i++) {
      loadmodel.leafs[i] = /** @type {Node} */ (Object.assign(new Node(loadmodel), {
        num: i,
        contents: view.getInt32(fileofs, true),
        visofs: view.getInt32(fileofs + 4, true),
        mins: new Vector(view.getInt16(fileofs + 8, true), view.getInt16(fileofs + 10, true), view.getInt16(fileofs + 12, true)),
        maxs: new Vector(view.getInt16(fileofs + 14, true), view.getInt16(fileofs + 16, true), view.getInt16(fileofs + 18, true)),
        firstmarksurface: view.getUint16(fileofs + 20, true),
        nummarksurfaces: view.getUint16(fileofs + 22, true),
        ambient_level: [
          view.getUint8(fileofs + 24),
          view.getUint8(fileofs + 25),
          view.getUint8(fileofs + 26),
          view.getUint8(fileofs + 27),
        ],
      }));
      fileofs += 28;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load collision clipnodes and initialize physics hulls
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadClipnodes(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.clipnodes << 3) + 4, true);
    const filelen = view.getUint32((lump.clipnodes << 3) + 8, true);
    const count = filelen >> 3;
    loadmodel.clipnodes.length = 0;

    loadmodel.hulls.length = 0;
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
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Create hull0 (point hull) from BSP nodes for collision detection
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   */
  _makeHull0(loadmodel) {
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
      const out = { planenum: node.planenum, children: [] };
      const child0 = /** @type {import('../BSP.mjs').Node} */ (node.children[0]);
      const child1 = /** @type {import('../BSP.mjs').Node} */ (node.children[1]);
      out.children[0] = child0.contents < 0 ? child0.contents : child0.num;
      out.children[1] = child1.contents < 0 ? child1.contents : child1.num;
      clipnodes[i] = out;
    }
    loadmodel.hulls[0] = hull;
  }

  /**
   * Load marksurfaces (face indices visible from each leaf)
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If marksurface index is out of bounds
   */
  _loadMarksurfaces(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    const fileofs = view.getUint32((lump.marksurfaces << 3) + 4, true);
    const filelen = view.getUint32((lump.marksurfaces << 3) + 8, true);
    const count = filelen >> 1;
    loadmodel.marksurfaces.length = 0;

    for (let i = 0; i < count; i++) {
      const j = view.getUint16(fileofs + (i << 1), true);
      if (j > loadmodel.faces.length) {
        throw new Error('BSP29Loader: bad surface number in marksurfaces');
      }
      loadmodel.marksurfaces[i] = j;
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs + filelen);
  }

  /**
   * Load submodels (brush models for doors, lifts, etc.)
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   * @throws {Error} If no submodels found
   */
  _loadSubmodels(loadmodel, buf) {
    const view = new DataView(buf);
    const lump = BSP29Loader.#lump;
    let fileofs = view.getUint32((lump.models << 3) + 4, true);
    const filelen = view.getUint32((lump.models << 3) + 8, true);
    const count = filelen >> 6;
    if (count === 0) {
      throw new Error('BSP29Loader: no submodels in ' + loadmodel.name);
    }
    loadmodel.submodels.length = 0;

    loadmodel.mins.setTo(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
    loadmodel.maxs.setTo(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
    loadmodel.hulls[0].firstclipnode = view.getUint32(fileofs + 36, true);
    loadmodel.hulls[1].firstclipnode = view.getUint32(fileofs + 40, true);
    loadmodel.hulls[2].firstclipnode = view.getUint32(fileofs + 44, true);
    fileofs += 64;

    const clipnodes = loadmodel.hulls[0].clipnodes;
    for (let i = 1; i < count; i++) {
      const out = new BrushModel('*' + i);
      out.submodel = true;
      out.mins.setTo(view.getFloat32(fileofs, true) - 1.0, view.getFloat32(fileofs + 4, true) - 1.0, view.getFloat32(fileofs + 8, true) - 1.0);
      out.maxs.setTo(view.getFloat32(fileofs + 12, true) + 1.0, view.getFloat32(fileofs + 16, true) + 1.0, view.getFloat32(fileofs + 20, true) + 1.0);
      out.origin.setTo(view.getFloat32(fileofs + 24, true), view.getFloat32(fileofs + 28, true), view.getFloat32(fileofs + 32, true));
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
      out.lightdata_rgb = loadmodel.lightdata_rgb;
      out.faces = loadmodel.faces;
      out.firstface = view.getUint32(fileofs + 56, true);
      out.numfaces = view.getUint32(fileofs + 60, true);
      loadmodel.submodels[i - 1] = out;
      fileofs += 64;

      for (let j = 0; j < out.numfaces; j++) {
        out.faces[out.firstface + j].submodel = true;
      }

      Mod.RegisterModel(out);
    }
    loadmodel.bspxoffset = Math.max(loadmodel.bspxoffset, fileofs);
  }

  /**
   * Load BSPX extended format data (optional extra lumps)
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buffer - The BSP file buffer
   */
  _loadBSPX(loadmodel, buffer) {
    loadmodel.bspxoffset = (loadmodel.bspxoffset + 3) & ~3;
    if (loadmodel.bspxoffset >= buffer.byteLength) {
      Con.DPrint('BSP29Loader: no BSPX data found\n');
      return;
    }

    const view = new DataView(buffer);
    const magic = view.getUint32(loadmodel.bspxoffset, true);
    console.assert(magic === 0x58505342, 'BSP29Loader: bad BSPX magic');

    const numlumps = view.getUint32(loadmodel.bspxoffset + 4, true);
    Con.DPrint('BSP29Loader: found BSPX data with ' + numlumps + ' lumps\n');

    /** @type {import('../BSP.mjs').BSPXLumps} */
    const bspxLumps = {};
    for (let i = 0, pointer = loadmodel.bspxoffset + 8; i < numlumps; i++, pointer += 32) {
      const name = Q.memstr(new Uint8Array(buffer, pointer, 24));
      const fileofs = view.getUint32(pointer + 24, true);
      const filelen = view.getUint32(pointer + 28, true);
      bspxLumps[name] = { fileofs, filelen };
    }
    loadmodel.bspxlumps = bspxLumps;
  }

  /**
   * Load RGB colored lighting from BSPX lump if available
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadLightingRGB(loadmodel, buf) {
    loadmodel.lightdata_rgb = null;
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['RGBLIGHTING']) { return; }

    const { fileofs, filelen } = loadmodel.bspxlumps['RGBLIGHTING'];
    if (filelen === 0) { return; }

    loadmodel.lightdata_rgb = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
  }

  /**
   * Load external RGB lighting from .lit file if available
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {string} filename - The original BSP filename
   */
  async _loadExternalLighting(loadmodel, filename) {
    const rgbFilename = filename.replace(/\.bsp$/i, '.lit');

    const data = await COM.LoadFile(rgbFilename);

    if (!data) {
      Con.DPrint(`BSP29Loader: no external RGB lighting file found: ${rgbFilename}\n`);
      return;
    }

    const dv = new DataView(data);

    console.assert(dv.getUint32(0, true) === 0x54494C51, 'QLIT header');
    console.assert(dv.getUint32(4, true) === 0x00000001, 'QLIT version 1');

    loadmodel.lightdata_rgb = new Uint8Array(data.slice(8)); // Skip header
  }

  /**
   * Load deluxemap (directional lighting normals) from BSPX lump if available
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadDeluxeMap(loadmodel, buf) {
    loadmodel.deluxemap = null;
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTINGDIR']) { return; }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTINGDIR'];
    if (filelen === 0) { return; }

    loadmodel.deluxemap = new Uint8Array(buf.slice(fileofs, fileofs + filelen));
  }

  /**
   * Load lightgrid octree from BSPX lump if available
   * @protected
   * @param {import('../BSP.mjs').BrushModel} loadmodel - The model being loaded
   * @param {ArrayBuffer} buf - The BSP file buffer
   */
  _loadLightgridOctree(loadmodel, buf) {
    loadmodel.lightgrid = null;
    if (!loadmodel.bspxlumps || !loadmodel.bspxlumps['LIGHTGRID_OCTREE']) { return; }

    const { fileofs, filelen } = loadmodel.bspxlumps['LIGHTGRID_OCTREE'];
    if (filelen === 0) { return; }

    try {
      const view = new DataView(buf);
      let offset = fileofs;
      const endOffset = fileofs + filelen;

      // Minimum size check: vec3_t step (12) + ivec3_t size (12) + vec3_t mins (12) + byte numstyles (1) + uint32_t rootnode (4) + uint32_t numnodes (4) + uint32_t numleafs (4) = 49 bytes
      if (filelen < 49) {
        Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE lump too small\n');
        return;
      }

      // vec3_t step
      const step = new Vector(
        view.getFloat32(offset, true),
        view.getFloat32(offset + 4, true),
        view.getFloat32(offset + 8, true),
      );
      offset += 12;

    // ivec3_t size
    const size = [
      view.getInt32(offset, true),
      view.getInt32(offset + 4, true),
      view.getInt32(offset + 8, true),
    ];
    offset += 12;

    // vec3_t mins
    const mins = new Vector(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
    );
    offset += 12;

    // byte numstyles (WARNING: misaligns the rest of the data)
    const numstyles = view.getUint8(offset);
    offset += 1;

    // uint32_t rootnode
    const rootnode = view.getUint32(offset, true);
    offset += 4;

    // uint32_t numnodes
    const numnodes = view.getUint32(offset, true);
    offset += 4;

    // Check if we have enough data for nodes (each node is 44 bytes: 3*4 for mid + 8*4 for children)
    if (offset + (numnodes * 44) > endOffset) {
      Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE nodes data truncated\n');
      return;
    }

    // Parse nodes
    const nodes = [];
    for (let i = 0; i < numnodes; i++) {
      const mid = [
        view.getUint32(offset, true),
        view.getUint32(offset + 4, true),
        view.getUint32(offset + 8, true),
      ];
      offset += 12;

      const child = [];
      for (let j = 0; j < 8; j++) {
        child[j] = view.getUint32(offset, true);
        offset += 4;
      }

      nodes[i] = { mid, child };
    }

    // uint32_t numleafs
    if (offset + 4 > endOffset) {
      Con.DPrint('BSP29Loader: LIGHTGRID_OCTREE numleafs missing\n');
      return;
    }
    const numleafs = view.getUint32(offset, true);
    offset += 4;

    // Parse leafs
    const leafs = [];
    for (let i = 0; i < numleafs; i++) {
      // Check bounds for leaf header (mins + size = 24 bytes)
      if (offset + 24 > endOffset) {
        Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} header truncated\n`);
        return;
      }

      const leafMins = [
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      ];
      offset += 12;

      const leafSize = [
        view.getInt32(offset, true),
        view.getInt32(offset + 4, true),
        view.getInt32(offset + 8, true),
      ];
      offset += 12;

      // Parse per-point data
      const totalPoints = leafSize[0] * leafSize[1] * leafSize[2];
      const points = [];

      for (let p = 0; p < totalPoints; p++) {
        // Check bounds for stylecount byte
        if (offset >= endOffset) {
          Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} point ${p} truncated\n`);
          return;
        }

        const stylecount = view.getUint8(offset);
        offset += 1;

        // Skip points with no data (stylecount = 0xff means missing)
        if (stylecount === 0xff) {
          points.push({ stylecount, styles: [] });
          continue;
        }

        const styles = [];
        for (let s = 0; s < stylecount; s++) {
          // Check bounds for style data (1 byte stylenum + 3 bytes rgb = 4 bytes)
          if (offset + 3 >= endOffset) {
            Con.DPrint(`BSP29Loader: LIGHTGRID_OCTREE leaf ${i} point ${p} style ${s} truncated\n`);
            return;
          }

          const stylenum = view.getUint8(offset);

          offset += 1;

          const rgb = [
            view.getUint8(offset),
            view.getUint8(offset + 1),
            view.getUint8(offset + 2),
          ];
          offset += 3;

          styles.push({ stylenum, rgb });
        }

        points.push({ stylecount, styles });
      }

      leafs.push({ mins: leafMins, size: leafSize, points });
    }

    loadmodel.lightgrid = {
      step,
      size,
      mins,
      numstyles,
      rootnode,
      nodes,
      leafs,
    };

    Con.DPrint(`BSP29Loader: loaded LIGHTGRID_OCTREE with ${numnodes} nodes and ${numleafs} leafs\n`);
    } catch (error) {
      Con.DPrint(`BSP29Loader: error loading LIGHTGRID_OCTREE: ${error.message}\n`);
      loadmodel.lightgrid = null;
    }
  }
}
