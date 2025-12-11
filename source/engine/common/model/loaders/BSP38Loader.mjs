import Q from '../../../../shared/Q.mjs';
import { CRC16CCITT } from '../../CRC.mjs';
import { BrushModel } from '../BSP.mjs';
import { ModelLoader } from '../ModelLoader.mjs';

/** @typedef {Record<number, DataView>} LumpViews */

const BSP_MAGIC = 1347633737; // 'IBSP' little-endian
const BSP_VERSION = 38;

const lumps = Object.freeze({
  LUMP_ENTITIES: 0,
  LUMP_PLANES: 1,
  LUMP_VERTEXES: 2,
  LUMP_VISIBILITY: 3,
  LUMP_NODES: 4,
  LUMP_TEXINFO: 5,
  LUMP_FACES: 6,
  LUMP_LIGHTING: 7,
  LUMP_LEAFS: 8,
  LUMP_LEAFFACES: 9,
  LUMP_LEAFBRUSHES: 10,
  LUMP_EDGES: 11,
  LUMP_SURFEDGES: 12,
  LUMP_MODELS: 13,
  LUMP_BRUSHES: 14,
  LUMP_BRUSHSIDES: 15,
  LUMP_POP: 16,
  LUMP_AREAS: 17,
  LUMP_AREAPORTALS: 18,
});

export class BSP38Loader extends ModelLoader {
  getMagicNumbers() {
    return [BSP_MAGIC];
  }

  getExtensions() {
    return ['.bsp'];
  }

  getName() {
    return 'Quake 2 BSP38';
  }

  canLoad(buffer, filename) {
    const view = new DataView(buffer);

    return super.canLoad(buffer, filename) && view.getUint32(4, true) === BSP_VERSION;
  }

  _loadLumps(buffer) {
    /** @type {LumpViews} */
    const lumpViews = {};

    const dv = new DataView(buffer);

    for (let i = 0; i < Object.keys(lumps).length; i++) {
      const offset = dv.getUint32(8 + i * 8, true);
      const length = dv.getUint32(8 + i * 8 + 4, true);

      lumpViews[i] = new DataView(buffer, offset, length);
    }

    return lumpViews;
  }

  /**
   * Reads a null-terminated string from a DataView.
   * @param {DataView} dataView data view to read from
   * @param {number} offset optional, offset to start reading
   * @param {number} length optional, length of the string to read
   * @returns {string} string, null-terminated or up to length
   */
  _readString(dataView, offset = 0, length = dataView.byteLength - offset) {
    return Q.memstr(new Uint8Array(dataView.buffer, dataView.byteOffset + offset, length));
  }

  /**
   * @param {DataView} entitiesLump data view of entities lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadEntities(entitiesLump, loadmodel) {
    loadmodel.entities = this._readString(entitiesLump, 0, entitiesLump.byteLength);
  }

  /**
   * @param {DataView} texinfoLump data view of texinfo lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadSurfaces(texinfoLump, loadmodel) {
    loadmodel.texinfo.length = 0;

    // float		vecs[2][4];		// [s/t][xyz offset]
    // int32		flags;			// miptex flags + overrides
    // int32		value;			// light emission, etc
    // char		texture[32];	// texture name (textures/*.wal)
    // int32		nexttexinfo;	// for animations, -1 = end of chain

    const stride = 76;
    const length = texinfoLump.byteLength / stride;
    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.texinfo.push({
        vecs: [
          [
            texinfoLump.getFloat32(offset + 0, true),
            texinfoLump.getFloat32(offset + 4, true),
            texinfoLump.getFloat32(offset + 8, true),
            texinfoLump.getFloat32(offset + 12, true),
          ],
          [
            texinfoLump.getFloat32(offset + 16, true),
            texinfoLump.getFloat32(offset + 20, true),
            texinfoLump.getFloat32(offset + 24, true),
            texinfoLump.getFloat32(offset + 28, true),
          ],
        ],
        flags: texinfoLump.getInt32(offset + 32, true),
        value: texinfoLump.getInt32(offset + 36, true),
        texture: this._readString(texinfoLump, offset + 40, 32),
        nexttexinfo: texinfoLump.getInt32(offset + 72, true),
      });
    }
  }

  /**
   * @param {DataView} leafsLump data view of leafs lump
   * @param {BrushModel} loadmodel brush model
   */
  _loadLeafs(leafsLump, loadmodel) {
    loadmodel.leafs.length = 0;

    // int32			contents;			// OR of all brushes (not needed?)
    // int16			cluster;
    // int16			area;
    // int16			mins[3];			// for frustum culling
    // int16			maxs[3];
    // uint16			firstleafface;
    // uint16			numleaffaces;
    // uint16			firstleafbrush;
    // uint16			numleafbrushes;

    const stride = 28;
    const length = leafsLump.byteLength / stride;
    for (let i = 0; i < length; i++) {
      const offset = i * stride;

      loadmodel.leafs.push({
        contents: leafsLump.getInt32(offset + 0, true),

      });
    }
  }

  async load(buffer, name) {
    const loadmodel = new BrushModel(name);

    loadmodel.version = BSP_VERSION;

    const lviews = this._loadLumps(buffer);
    this._loadEntities(lviews[lumps.LUMP_ENTITIES], loadmodel);
    this._loadSurfaces(lviews[lumps.LUMP_TEXINFO], loadmodel);
    this._loadLeafs(lviews[lumps.LUMP_LEAFS], loadmodel);

    loadmodel.needload = false;
    loadmodel.checksum = CRC16CCITT.Block(new Uint8Array(buffer));

    debugger;

    return loadmodel;
  }
};


