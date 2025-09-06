import Vector from '../../../shared/Vector.mjs';

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
