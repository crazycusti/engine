import Vector from '../../shared/Vector.mjs';

/** @typedef {import('../../shared/GameInterfaces').SerializableType} SerializableType */

export const MOVETYPE = Object.freeze({
  none: 0,
  anglenoclip: 1,
  angleclip: 2,
  walk: 3,
  step: 4,
  fly: 5,
  toss: 6,
  push: 7,
  noclip: 8,
  flymissile: 9,
  bounce: 10,
});

export const SOLID = Object.freeze({
  not: 0,
  trigger: 1,
  bbox: 2,
  slidebox: 3,
  bsp: 4,
});

export const DAMAGE = Object.freeze({
  no: 0,
  yes: 1,
  aim: 2,
});

export const FL = Object.freeze({
  fly: 1,
  swim: 2,
  conveyor: 4,
  client: 8,
  inwater: 16,
  monster: 32,
  godmode: 64,
  notarget: 128,
  item: 256,
  onground: 512,
  partialground: 1024,
  waterjump: 2048,
  jumpreleased: 4096,
});

export class ServerEntityState {
  constructor(num = null) {
    this.num = num;
    this.flags = 0;
    this.origin = new Vector(Infinity, Infinity, Infinity);
    this.angles = new Vector(Infinity, Infinity, Infinity);
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0;
    this.free = false;
    this.classname = null;
    this.mins = new Vector();
    this.maxs = new Vector();
    this.velocity = new Vector(0, 0, 0);
    this.nextthink = 0;

    /** @type {Record<string, SerializableType>} */
    this.extended = {};
  }

  /** @param {ServerEntityState} other other state to copy */
  set(other) {
    this.num = other.num;
    this.flags = other.flags;
    this.origin.set(other.origin);
    this.angles.set(other.angles);
    this.velocity.set(other.velocity);
    this.modelindex = other.modelindex;
    this.frame = other.frame;
    this.colormap = other.colormap;
    this.skin = other.skin;
    this.effects = other.effects;
    this.solid = other.solid;
    this.free = other.free;
    this.classname = other.classname;
    this.mins.set(other.mins);
    this.maxs.set(other.maxs);
    this.nextthink = other.nextthink;

    for (const [key, value] of Object.entries(other.extended)) {
      this.extended[key] = value;
    }
  }

  freeEdict() {
    this.free = true;
    this.flags = 0;
    this.angles.setTo(Infinity, Infinity, Infinity);
    this.origin.setTo(Infinity, Infinity, Infinity);
    this.velocity.setTo(0, 0, 0);
    this.nextthink = 0;
    this.modelindex = 0;
    this.frame = 0;
    this.colormap = 0;
    this.skin = 0;
    this.effects = 0;
    this.solid = 0;
    this.classname = null;
  }
};
