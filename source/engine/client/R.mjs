import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import * as Def from '../common/Def.mjs';

import { eventBus, registry } from '../registry.mjs';
import Chase from './Chase.mjs';
import MSG from '../network/MSG.mjs';
import W from '../common/W.mjs';
import VID from './VID.mjs';
import GL, { GLTexture } from './GL.mjs';
import { content, effect, gameCapabilities } from '../../shared/Defs.mjs';
import { ClientEdict } from './ClientEntities.mjs';
import { modelRendererRegistry } from './renderer/ModelRendererRegistry.mjs';
import { BrushModelRenderer } from './renderer/BrushModelRenderer.mjs';
import { AliasModelRenderer } from './renderer/AliasModelRenderer.mjs';
import { SpriteModelRenderer } from './renderer/SpriteModelRenderer.mjs';

let { CL, COM, Con, Host, Mod, SCR, SV, Sys, V  } = registry;

/**
 * @typedef {{
    name: string;
    width: number;
    height: number;
    glt: GLTexture;
    sky: boolean;
    turbulent: boolean;
}} BrushModelTexture
 */

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
  SCR = registry.SCR;
  SV = registry.SV;
  Sys = registry.Sys;
  V = registry.V;
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

const R = {};

export default R;

// efrag

R.SplitEntityOnNode = function(node) {
  if (node.contents === content.CONTENT_SOLID) {
    return;
  }
  if (node.contents < 0) {
    R.currententity.leafs[R.currententity.leafs.length] = node.num - 1;
    return;
  }
  const sides = Vector.boxOnPlaneSide(R.emins, R.emaxs, node.plane);
  if ((sides & 1) !== 0) {
    R.SplitEntityOnNode(node.children[0]);
  }
  if ((sides & 2) !== 0) {
    R.SplitEntityOnNode(node.children[1]);
  }
};

// light

R.dlightframecount = 0;

R.lightstylevalue_a = new Uint8Array(new ArrayBuffer(64));
R.lightstylevalue_b = new Uint8Array(new ArrayBuffer(64));

R.AnimateLight = function() {
  if (R.fullbright.value === 0) {
    const i = Math.floor(CL.state.time * 10.0);
    for (let j = 0; j < 64; j++) {
      const ls = CL.state.clientEntities.lightstyle[j];
      if (ls.length === 0) {
        R.lightstylevalue_a[j] = 12;
        R.lightstylevalue_b[j] = 12;
        continue;
      }
      R.lightstylevalue_a[j] = ls.charCodeAt(i % ls.length) - 97;
      R.lightstylevalue_b[j] = ls.charCodeAt((i + 1) % ls.length) - 97;
    }
  } else {
    for (let j = 0; j < 64; j++) {
      R.lightstylevalue_a[j] = 12;
      R.lightstylevalue_b[j] = 12;
    }
  }
  GL.Bind(0, R.lightstyle_texture_a);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 64, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, R.lightstylevalue_a);
  GL.Bind(0, R.lightstyle_texture_b);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, 64, 1, 0, gl.ALPHA, gl.UNSIGNED_BYTE, R.lightstylevalue_b);
};

R.RenderDlights = function() {
  if (R.flashblend.value === 0) {
    return;
  }
  R.dlightframecount++;
  gl.enable(gl.BLEND);
  const program = GL.UseProgram('dlight'); let a;
  gl.bindBuffer(gl.ARRAY_BUFFER, R.dlightvecs);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 0, 0);
  for (let i = 0; i < Def.limits.dlights; i++) {
    const l = CL.state.clientEntities.dlights[i];
    if ((l.die < CL.state.time) || (l.radius === 0.0)) {
      continue;
    }
    if (l.origin.copy().subtract(R.refdef.vieworg).len() < (l.radius * 0.35)) {
      a = l.radius * 0.0003;
      V.blend[3] += a * (1.0 - V.blend[3]);
      a /= V.blend[3];
      V.blend[0] = V.blend[1] * (1.0 - a) + (255.0 * a);
      V.blend[1] = V.blend[1] * (1.0 - a) + (127.5 * a);
      V.blend[2] *= 1.0 - a;
      continue;
    }
    gl.uniform3fv(program.uOrigin, l.origin);
    gl.uniform1f(program.uRadius, l.radius);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 18);
  }
  gl.disable(gl.BLEND);
};

R.MarkLights = function(light, bit, node) {
  if (node.contents < 0) {
    return;
  }
  const normal = node.plane.normal;
  const dist = light.origin[0] * normal[0] + light.origin[1] * normal[1] + light.origin[2] * normal[2] - node.plane.dist;
  if (dist > light.radius) {
    R.MarkLights(light, bit, node.children[0]);
    return;
  }
  if (dist < -light.radius) {
    R.MarkLights(light, bit, node.children[1]);
    return;
  }
  let i; let surf;
  for (i = 0; i < node.numfaces; i++) {
    surf = CL.state.worldmodel.faces[node.firstface + i];
    // if ((surf.sky === true) || (surf.turbulent === true)) {
    if (surf.sky) {
      continue;
    }
    if (surf.dlightframe !== (R.dlightframecount + 1)) {
      surf.dlightbits = 0;
      surf.dlightframe = R.dlightframecount + 1;
    }
    surf.dlightbits += bit;
  }
  R.MarkLights(light, bit, node.children[0]);
  R.MarkLights(light, bit, node.children[1]);
};

R.PushDlights = function() {
  if (R.flashblend.value !== 0) {
    return;
  }
  for (let i = 0; i <= 1023; i++) {
    R.lightmap_modified[i] = false;
  }

  let bit = 1; let j;

  for (let i = 0; i < Def.limits.dlights; i++) {
    const l = CL.state.clientEntities.dlights[i];

    if (!l.isFree()) {
      R.MarkLights(l, bit, CL.state.worldmodel.nodes[0]);
      for (const ent of CL.state.clientEntities.getVisibleEntities()) {
        if (ent.model === null) {
          continue;
        }
        if ((ent.model.type !== Mod.type.brush) || (ent.model.submodel !== true)) {
          continue;
        }
        R.MarkLights(l, bit, CL.state.worldmodel.nodes[ent.model.hulls[0].firstclipnode]);
      }
    }
    bit += bit;
  }

  let surf;
  for (let i = 0; i < CL.state.worldmodel.faces.length; i++) {
    surf = CL.state.worldmodel.faces[i];
    if (surf.dlightframe === R.dlightframecount) {
      R.RemoveDynamicLights(surf);
    } else if (surf.dlightframe === (R.dlightframecount + 1)) {
      R.AddDynamicLights(surf);
    }
  }

  GL.Bind(0, R.dlightmap_rgba_texture);
  for (let i = 0; i < 1024; i++) {
    if (R.lightmap_modified[i] !== true) {
      continue;
    }
    for (j = 1023; j >= i; --j) {
      if (R.lightmap_modified[j] !== true) {
        continue;
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, i, 1024, j - i + 1, gl.RGBA, gl.UNSIGNED_BYTE, R.dlightmaps_rgba.subarray(i * 1024 * 4, (j + 1) * 1024 * 4));
      break;
    }
    break;
  }

  R.dlightframecount++;
};

R.RecursiveLightPoint = function(node, start, end) {
  if (node.contents < 0) {
    return null;
  }

  const normal = node.plane.normal;
  const front = start[0] * normal[0] + start[1] * normal[1] + start[2] * normal[2] - node.plane.dist;
  const back = end[0] * normal[0] + end[1] * normal[1] + end[2] * normal[2] - node.plane.dist;
  const side = front < 0;

  if ((back < 0) === side) {
    return R.RecursiveLightPoint(node.children[side ? 1 : 0], start, end);
  }

  const frac = front / (front - back);
  const mid = new Vector(
    start[0] + (end[0] - start[0]) * frac,
    start[1] + (end[1] - start[1]) * frac,
    start[2] + (end[2] - start[2]) * frac,
  );

  const r = R.RecursiveLightPoint(node.children[side ? 1 : 0], start, mid);

  if (r !== null) {
    return r;
  }

  if ((back < 0) === side) {
    return null;
  }

  for (let i = 0; i < node.numfaces; i++) {
    const surf = CL.state.worldmodel.faces[node.firstface + i];

    if (surf.sky) {
      continue;
    }

    const tex = CL.state.worldmodel.texinfo[surf.texinfo];
    const s = mid.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3];
    const t = mid.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3];
    if ((s < surf.texturemins[0]) || (t < surf.texturemins[1])) {
      continue;
    }

    let ds = s - surf.texturemins[0];
    let dt = t - surf.texturemins[1];
    if ((ds > surf.extents[0]) || (dt > surf.extents[1])) {
      continue;
    }

    if (surf.lightofs === 0) {
      return [new Vector(), mid];
    }

    ds >>= surf.lmshift;
    dt >>= surf.lmshift;

    const smax = (surf.extents[0] >> surf.lmshift) + 1;
    const tmax = (surf.extents[1] >> surf.lmshift) + 1;

    const r3 = new Vector();
    const haveRGB = CL.state.worldmodel.lightdata_rgb !== null;
    const lightdata = haveRGB ? CL.state.worldmodel.lightdata_rgb : CL.state.worldmodel.lightdata;
    const channels = haveRGB ? 3 : 1;
    const uAlpha = R.interpolation.value ? (CL.state.time % .2) / .2 : 0;

    for (let k = 0; k < channels; k++) {
      let lightmap = surf.lightofs + dt * smax + ds;

      for (let maps = 0; maps < surf.styles.length; maps++) {
        const scale = (
          R.lightstylevalue_a[surf.styles[maps]] * (1 - uAlpha) +
          R.lightstylevalue_b[surf.styles[maps]] * uAlpha
        ) * 22.0;

        r3[k] += lightdata[lightmap * channels + k] * scale;

        lightmap += tmax * smax;
      }
    }

    if (!haveRGB) {
      // replicate for green and blue
      r3[1] = r3[0];
      r3[2] = r3[0];
    }

    r3[0] = r3[0] >> 8;
    r3[1] = r3[1] >> 8;
    r3[2] = r3[2] >> 8;

    // console.log('light at', mid, 'is', r3);

    return [
      r3,
      mid.add(surf.plane.normal.copy().multiply(16.0)),
    ];


    // return [r3, mid];
  }

  return R.RecursiveLightPoint(node.children[!side ? 1 : 0], mid, end);
};

R.LightPoint = function(p) {
  if (CL.state.worldmodel.lightdata === null && CL.state.worldmodel.lightdata_rgb === null) {
    return [new Vector(255, 255, 255), new Vector(0, 0, 0)];
  }

  const r = R.RecursiveLightPoint(CL.state.worldmodel.nodes[0], p, new Vector(p[0], p[1], p[2] - 2048.0));

  if (r === null) {
    return [new Vector(0, 0, 0), new Vector(0, 0, 0)];
  }

  return r;
};

// main

R.visframecount = 0;

R.frustum = [{}, {}, {}, {}];

R.vup = new Vector();
R.vpn = new Vector();
R.vright = new Vector();

R.refdef = {
  vrect: {
    width: 0,
    height: 0,
  },
  vieworg: new Vector(),
  viewangles: new Vector(),
};

R.CullBox = function(mins, maxs) {
  if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[0]) === 2) {
    return true;
  }
  if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[1]) === 2) {
    return true;
  }
  if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[2]) === 2) {
    return true;
  }
  if (Vector.boxOnPlaneSide(mins, maxs, R.frustum[3]) === 2) {
    return true;
  }
  return false;
};

R.avertexnormals = [
  new Vector(-0.525731, 0.0, 0.850651),
  new Vector(-0.442863, 0.238856, 0.864188),
  new Vector(-0.295242, 0.0, 0.955423),
  new Vector(-0.309017, 0.5, 0.809017),
  new Vector(-0.16246, 0.262866, 0.951056),
  new Vector(0.0, 0.0, 1.0),
  new Vector(0.0, 0.850651, 0.525731),
  new Vector(-0.147621, 0.716567, 0.681718),
  new Vector(0.147621, 0.716567, 0.681718),
  new Vector(0.0, 0.525731, 0.850651),
  new Vector(0.309017, 0.5, 0.809017),
  new Vector(0.525731, 0.0, 0.850651),
  new Vector(0.295242, 0.0, 0.955423),
  new Vector(0.442863, 0.238856, 0.864188),
  new Vector(0.16246, 0.262866, 0.951056),
  new Vector(-0.681718, 0.147621, 0.716567),
  new Vector(-0.809017, 0.309017, 0.5),
  new Vector(-0.587785, 0.425325, 0.688191),
  new Vector(-0.850651, 0.525731, 0.0),
  new Vector(-0.864188, 0.442863, 0.238856),
  new Vector(-0.716567, 0.681718, 0.147621),
  new Vector(-0.688191, 0.587785, 0.425325),
  new Vector(-0.5, 0.809017, 0.309017),
  new Vector(-0.238856, 0.864188, 0.442863),
  new Vector(-0.425325, 0.688191, 0.587785),
  new Vector(-0.716567, 0.681718, -0.147621),
  new Vector(-0.5, 0.809017, -0.309017),
  new Vector(-0.525731, 0.850651, 0.0),
  new Vector(0.0, 0.850651, -0.525731),
  new Vector(-0.238856, 0.864188, -0.442863),
  new Vector(0.0, 0.955423, -0.295242),
  new Vector(-0.262866, 0.951056, -0.16246),
  new Vector(0.0, 1.0, 0.0),
  new Vector(0.0, 0.955423, 0.295242),
  new Vector(-0.262866, 0.951056, 0.16246),
  new Vector(0.238856, 0.864188, 0.442863),
  new Vector(0.262866, 0.951056, 0.16246),
  new Vector(0.5, 0.809017, 0.309017),
  new Vector(0.238856, 0.864188, -0.442863),
  new Vector(0.262866, 0.951056, -0.16246),
  new Vector(0.5, 0.809017, -0.309017),
  new Vector(0.850651, 0.525731, 0.0),
  new Vector(0.716567, 0.681718, 0.147621),
  new Vector(0.716567, 0.681718, -0.147621),
  new Vector(0.525731, 0.850651, 0.0),
  new Vector(0.425325, 0.688191, 0.587785),
  new Vector(0.864188, 0.442863, 0.238856),
  new Vector(0.688191, 0.587785, 0.425325),
  new Vector(0.809017, 0.309017, 0.5),
  new Vector(0.681718, 0.147621, 0.716567),
  new Vector(0.587785, 0.425325, 0.688191),
  new Vector(0.955423, 0.295242, 0.0),
  new Vector(1.0, 0.0, 0.0),
  new Vector(0.951056, 0.16246, 0.262866),
  new Vector(0.850651, -0.525731, 0.0),
  new Vector(0.955423, -0.295242, 0.0),
  new Vector(0.864188, -0.442863, 0.238856),
  new Vector(0.951056, -0.16246, 0.262866),
  new Vector(0.809017, -0.309017, 0.5),
  new Vector(0.681718, -0.147621, 0.716567),
  new Vector(0.850651, 0.0, 0.525731),
  new Vector(0.864188, 0.442863, -0.238856),
  new Vector(0.809017, 0.309017, -0.5),
  new Vector(0.951056, 0.16246, -0.262866),
  new Vector(0.525731, 0.0, -0.850651),
  new Vector(0.681718, 0.147621, -0.716567),
  new Vector(0.681718, -0.147621, -0.716567),
  new Vector(0.850651, 0.0, -0.525731),
  new Vector(0.809017, -0.309017, -0.5),
  new Vector(0.864188, -0.442863, -0.238856),
  new Vector(0.951056, -0.16246, -0.262866),
  new Vector(0.147621, 0.716567, -0.681718),
  new Vector(0.309017, 0.5, -0.809017),
  new Vector(0.425325, 0.688191, -0.587785),
  new Vector(0.442863, 0.238856, -0.864188),
  new Vector(0.587785, 0.425325, -0.688191),
  new Vector(0.688191, 0.587785, -0.425325),
  new Vector(-0.147621, 0.716567, -0.681718),
  new Vector(-0.309017, 0.5, -0.809017),
  new Vector(0.0, 0.525731, -0.850651),
  new Vector(-0.525731, 0.0, -0.850651),
  new Vector(-0.442863, 0.238856, -0.864188),
  new Vector(-0.295242, 0.0, -0.955423),
  new Vector(-0.16246, 0.262866, -0.951056),
  new Vector(0.0, 0.0, -1.0),
  new Vector(0.295242, 0.0, -0.955423),
  new Vector(0.16246, 0.262866, -0.951056),
  new Vector(-0.442863, -0.238856, -0.864188),
  new Vector(-0.309017, -0.5, -0.809017),
  new Vector(-0.16246, -0.262866, -0.951056),
  new Vector(0.0, -0.850651, -0.525731),
  new Vector(-0.147621, -0.716567, -0.681718),
  new Vector(0.147621, -0.716567, -0.681718),
  new Vector(0.0, -0.525731, -0.850651),
  new Vector(0.309017, -0.5, -0.809017),
  new Vector(0.442863, -0.238856, -0.864188),
  new Vector(0.16246, -0.262866, -0.951056),
  new Vector(0.238856, -0.864188, -0.442863),
  new Vector(0.5, -0.809017, -0.309017),
  new Vector(0.425325, -0.688191, -0.587785),
  new Vector(0.716567, -0.681718, -0.147621),
  new Vector(0.688191, -0.587785, -0.425325),
  new Vector(0.587785, -0.425325, -0.688191),
  new Vector(0.0, -0.955423, -0.295242),
  new Vector(0.0, -1.0, 0.0),
  new Vector(0.262866, -0.951056, -0.16246),
  new Vector(0.0, -0.850651, 0.525731),
  new Vector(0.0, -0.955423, 0.295242),
  new Vector(0.238856, -0.864188, 0.442863),
  new Vector(0.262866, -0.951056, 0.16246),
  new Vector(0.5, -0.809017, 0.309017),
  new Vector(0.716567, -0.681718, 0.147621),
  new Vector(0.525731, -0.850651, 0.0),
  new Vector(-0.238856, -0.864188, -0.442863),
  new Vector(-0.5, -0.809017, -0.309017),
  new Vector(-0.262866, -0.951056, -0.16246),
  new Vector(-0.850651, -0.525731, 0.0),
  new Vector(-0.716567, -0.681718, -0.147621),
  new Vector(-0.716567, -0.681718, 0.147621),
  new Vector(-0.525731, -0.850651, 0.0),
  new Vector(-0.5, -0.809017, 0.309017),
  new Vector(-0.238856, -0.864188, 0.442863),
  new Vector(-0.262866, -0.951056, 0.16246),
  new Vector(-0.864188, -0.442863, 0.238856),
  new Vector(-0.809017, -0.309017, 0.5),
  new Vector(-0.688191, -0.587785, 0.425325),
  new Vector(-0.681718, -0.147621, 0.716567),
  new Vector(-0.442863, -0.238856, 0.864188),
  new Vector(-0.587785, -0.425325, 0.688191),
  new Vector(-0.309017, -0.5, 0.809017),
  new Vector(-0.147621, -0.716567, 0.681718),
  new Vector(-0.425325, -0.688191, 0.587785),
  new Vector(-0.16246, -0.262866, 0.951056),
  new Vector(0.442863, -0.238856, 0.864188),
  new Vector(0.16246, -0.262866, 0.951056),
  new Vector(0.309017, -0.5, 0.809017),
  new Vector(0.147621, -0.716567, 0.681718),
  new Vector(0.0, -0.525731, 0.850651),
  new Vector(0.425325, -0.688191, 0.587785),
  new Vector(0.587785, -0.425325, 0.688191),
  new Vector(0.688191, -0.587785, 0.425325),
  new Vector(-0.955423, 0.295242, 0.0),
  new Vector(-0.951056, 0.16246, 0.262866),
  new Vector(-1.0, 0.0, 0.0),
  new Vector(-0.850651, 0.0, 0.525731),
  new Vector(-0.955423, -0.295242, 0.0),
  new Vector(-0.951056, -0.16246, 0.262866),
  new Vector(-0.864188, 0.442863, -0.238856),
  new Vector(-0.951056, 0.16246, -0.262866),
  new Vector(-0.809017, 0.309017, -0.5),
  new Vector(-0.864188, -0.442863, -0.238856),
  new Vector(-0.951056, -0.16246, -0.262866),
  new Vector(-0.809017, -0.309017, -0.5),
  new Vector(-0.681718, 0.147621, -0.716567),
  new Vector(-0.681718, -0.147621, -0.716567),
  new Vector(-0.850651, 0.0, -0.525731),
  new Vector(-0.688191, 0.587785, -0.425325),
  new Vector(-0.587785, 0.425325, -0.688191),
  new Vector(-0.425325, 0.688191, -0.587785),
  new Vector(-0.425325, -0.688191, -0.587785),
  new Vector(-0.587785, -0.425325, -0.688191),
  new Vector(-0.688191, -0.587785, -0.425325),
];

R._CalculateLightValues = function (e) {
  const [ambientlight, lightOrigin] = R.LightPoint(e.lerp.origin);
  const shadelight = ambientlight.copy();

  // never have a pitch black view model
  if ((e === CL.state.viewent) && (ambientlight.average() < 24.0)) {
    if (ambientlight.average() === 0) {
      ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
    }
    ambientlight.multiply(24.0);
    shadelight.set(ambientlight);
  }

  const nearestLightOrigin = lightOrigin.copy();

  // add dynamic lights
  for (let i = 0; i < Def.limits.dlights; i++) {
    const dl = CL.state.clientEntities.dlights[i];

    if (dl.isFree()) {
      continue;
    }

    const add = dl.radius - e.lerp.origin.distanceTo(dl.origin);

    if (add > 0.0) {
      const color = dl.color.copy();
      const vadd = color.multiply(add);
      ambientlight.add(vadd);
      shadelight.add(vadd);

      nearestLightOrigin.set(dl.origin);
    }
  }

  // do not overbright
  const alavg = ambientlight.greatest();
  if (alavg > 128.0) {
    ambientlight.multiply(128.0 / alavg);
  }

  const alslavg = (ambientlight.copy().add(shadelight)).greatest();
  if (alslavg > 192.0) {
    ambientlight.multiply(192.0 / alslavg);
    shadelight.set(ambientlight);
  }

  // never let players go totally dark either
  if (((e.num >= 1) && (e.num <= CL.state.maxclients) && (ambientlight.greatest() < 8.0)) || (e.effects & effect.EF_MINLIGHT)) {
    if (ambientlight.average() === 0) {
      ambientlight.setTo(1.0, 1.0, 1.0); // no color, set to white
    }
    ambientlight.multiply(8.0);
    shadelight.set(ambientlight);
  }

  if (e.effects & effect.EF_FULLBRIGHT) { // TODO: move this up before we do all the math
    ambientlight.setTo(255.0, 255.0, 255.0);
    shadelight.set(ambientlight);
  }

  ambientlight.multiply(0.0078125); // / 128.0
  shadelight.multiply(0.0078125); // / 128.0

  return [ ambientlight, shadelight, nearestLightOrigin ];
};

R.DrawEntitiesOnList = function() {
  if (R.drawentities.value === 0) {
    return;
  }

  // Group entities by model type for batched rendering
  const entitiesByType = new Map();

  for (const entity of CL.state.clientEntities.getVisibleEntities()) {
    if (entity.model === null) {
      continue;
    }

    const modelType = entity.model.type;
    if (!entitiesByType.has(modelType)) {
      entitiesByType.set(modelType, []);
    }
    entitiesByType.get(modelType).push(entity);
  }

  // Pass 0: Opaque models (brush, alias)
  for (const [modelType, entities] of entitiesByType) {
    if (modelType === Mod.type.sprite) {
      continue; // Sprites are drawn in pass 1
    }

    const renderer = modelRendererRegistry.getRenderer(modelType);
    if (!renderer) {
      continue;
    }

    renderer.setupRenderState(0);
    for (const entity of entities) {
      R.currententity = entity;
      renderer.render(entity.model, entity, 0);
    }
    renderer.cleanupRenderState(0);
  }
  GL.StreamFlush();

  // Pass 1: Transparent sprites with blending
  const spriteEntities = entitiesByType.get(Mod.type.sprite);
  if (spriteEntities) {
    const renderer = modelRendererRegistry.getRenderer(Mod.type.sprite);
    if (renderer) {
      gl.enable(gl.BLEND);
      renderer.setupRenderState(1);
      for (const entity of spriteEntities) {
        R.currententity = entity;
        renderer.render(entity.model, entity, 1);
      }
      renderer.cleanupRenderState(1);
      GL.StreamFlush();
      gl.disable(gl.BLEND);
    }
  }
};

R.DrawViewModel = function() {
  if (R.drawviewmodel.value === 0) {
    return;
  }
  if (Chase.active.value !== 0) {
    return;
  }
  if (R.drawentities.value === 0) {
    return;
  }

  if (!CL.gameCapabilities.includes(gameCapabilities.CAP_VIEWMODEL_MANAGED)) {
    if ((CL.state.items & Def.it.invisibility) !== 0) { // Legacy
      return;
    }
    if (CL.state.stats[Def.stat.health] <= 0) { // Legacy
      return;
    }
    if (!CL.state.viewent.model) {
      return;
    }
  } else if (CL.state.gameAPI) {
    const viewmodel = CL.state.gameAPI.viewmodel;

    if (!viewmodel.visible) {
      return; // game says to not draw the view model
    }

    if (!viewmodel.model) {
      return; // no model to draw
    }
  }

  gl.depthRange(0.0, 0.3);

  let ymax = 4.0 * Math.tan(SCR.fov.value * 0.82 * Math.PI / 360.0);
  R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
  R.perspective[5] = 4.0 / ymax;
  let program = GL.UseProgram('alias');
  gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);

  if (CL.state.viewent.model !== null) {
    const aliasRenderer = modelRendererRegistry.getRenderer(Mod.type.alias);
    if (aliasRenderer) {
      aliasRenderer.setupRenderState(0);
      aliasRenderer.render(CL.state.viewent.model, CL.state.viewent, 0);
      aliasRenderer.cleanupRenderState(0);
    }
  }

  ymax = 4.0 * Math.tan(R.refdef.fov_y * Math.PI / 360.0);
  R.perspective[0] = 4.0 / (ymax * R.refdef.vrect.width / R.refdef.vrect.height);
  R.perspective[5] = 4.0 / ymax;
  program = GL.UseProgram('alias');
  gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);

  gl.depthRange(0.0, 1.0);
};

R.PolyBlend = function() {
  if (R.polyblend.value === 0) {
    return;
  }
  if (V.blend[3] === 0.0) {
    return;
  }
  GL.UseProgram('fill', true);
  const vrect = R.refdef.vrect;
  GL.StreamDrawColoredQuad(vrect.x, vrect.y, vrect.width, vrect.height,
      V.blend[0], V.blend[1], V.blend[2], V.blend[3] * 255.0);
};

R.SetFrustum = function() {
  R.frustum[0].normal = R.vup.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_x * 0.5));
  R.frustum[1].normal = R.vup.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_x * 0.5);
  R.frustum[2].normal = R.vright.rotatePointAroundVector(R.vpn, 90.0 - R.refdef.fov_y * 0.5);
  R.frustum[3].normal = R.vright.rotatePointAroundVector(R.vpn, -(90.0 - R.refdef.fov_y * 0.5));
  for (let i = 0; i < 4; i++) {
    const out = R.frustum[i];
    out.type = 5;
    out.dist = R.refdef.vieworg.dot(out.normal);
    out.signbits = 0;
    if (out.normal[0] < 0.0) {
      out.signbits = 1;
    }
    if (out.normal[1] < 0.0) {
      out.signbits += 2;
    }
    if (out.normal[2] < 0.0) {
      out.signbits += 4;
    }
    if (out.normal[3] < 0.0) {
      out.signbits += 8;
    }
  }
};

R.viewMatrix = null;
R.projectionMatrix = null;

// eslint-disable-next-line jsdoc/require-jsdoc
function multiplyMatrixVec4(m, v) {
  return [
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + m[12]*v[3],
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + m[13]*v[3],
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
    m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3],
  ];
}

/**
 *
 * @param {Vector} origin position in the world
 * @returns {Vector|null} screen coordinates or null if off-screen
 */
R.WorldToScreen = function(origin) {
  const projectionMatrix = R.projectionMatrix;
  const viewMatrix = R.viewMatrix; // This is uViewAngles — rotation only

  // world-space delta from camera
  const delta = [
    origin[0] - R.refdef.vieworg[0],
    origin[1] - R.refdef.vieworg[1],
    origin[2] - R.refdef.vieworg[2],
  ];

  // Apply view rotation
  const x =
    viewMatrix[0] * delta[0] +
    viewMatrix[4] * delta[1] +
    viewMatrix[8] * delta[2];
  const y =
    viewMatrix[1] * delta[0] +
    viewMatrix[5] * delta[1] +
    viewMatrix[9] * delta[2];
  const z =
    viewMatrix[2] * delta[0] +
    viewMatrix[6] * delta[1] +
    viewMatrix[10] * delta[2];

  // Mimic gl_Position = projection * vec4(xz, -y, 1.0)
  const posVec = [x, z, -y, 1.0]; // Swizzle + flip Y

  const clip = multiplyMatrixVec4(projectionMatrix, posVec);

  // If the clip space W coordinate is zero, we can't convert to NDC
  if (clip[3] === 0) {
    return null;
  }

  const ndc = [
    clip[0] / clip[3],
    clip[1] / clip[3],
    clip[2] / clip[3],
  ];

  if (clip[3] > 0 && ndc[0] >= -1 && ndc[0] <= 1 && ndc[1] >= -1 && ndc[1] <= 1 && ndc[2] >= 0 && ndc[2] <= 1) {
    return new Vector(
      R.refdef.vrect.x + (ndc[0] + 1) * 0.5 * R.refdef.vrect.width,
      R.refdef.vrect.y + (1 - ndc[1]) * 0.5 * R.refdef.vrect.height,
      ndc[2],
    );
  }

  return null;
};

R.perspective = [
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, 0.0, 0.0,
  0.0, 0.0, -65540.0 / 65532.0, -1.0,
  0.0, 0.0, -524288.0 / 65532.0, 0.0,
];

R.Perspective = function() {
  const viewangles = [
    R.refdef.viewangles[0] * Math.PI / 180.0,
    (R.refdef.viewangles[1] - 90.0) * Math.PI / -180.0,
    R.refdef.viewangles[2] * Math.PI / -180.0,
  ];
  const sp = Math.sin(viewangles[0]);
  const cp = Math.cos(viewangles[0]);
  const sy = Math.sin(viewangles[1]);
  const cy = Math.cos(viewangles[1]);
  const sr = Math.sin(viewangles[2]);
  const cr = Math.cos(viewangles[2]);
  const viewMatrix = [
    cr * cy + sr * sp * sy,		cp * sy,	-sr * cy + cr * sp * sy,
    cr * -sy + sr * sp * cy,	cp * cy,	-sr * -sy + cr * sp * cy,
    sr * cp,					-sp,		cr * cp,
  ];

  R.viewMatrix = [
    viewMatrix[0], viewMatrix[1], viewMatrix[2], 0.0,
    viewMatrix[3], viewMatrix[4], viewMatrix[5], 0.0,
    viewMatrix[6], viewMatrix[7], viewMatrix[8], 0.0,
    0.0,           0.0,           0.0,           1.0,
  ];

  R.projectionMatrix = R.perspective;

  if (V.gamma.value < 0.5) {
    V.gamma.set(0.5);
  } else if (V.gamma.value > 1.0) {
    V.gamma.set(1.0);
  }

  GL.UnbindProgram();
  for (let i = 0; i < GL.programs.length; i++) {
    const program = GL.programs[i];
    gl.useProgram(program.program);
    if (program.uViewOrigin !== undefined) {
      gl.uniform3fv(program.uViewOrigin, R.refdef.vieworg);
    }
    if (program.uViewAngles !== undefined) {
      gl.uniformMatrix3fv(program.uViewAngles, false, viewMatrix);
    }
    if (program.uPerspective !== undefined) {
      gl.uniformMatrix4fv(program.uPerspective, false, R.perspective);
    }
    if (program.uGamma !== undefined) {
      gl.uniform1f(program.uGamma, V.gamma.value);
    }
    // global fog uniforms (only set when shader declares them)
    if (program.uFogColor !== undefined) {
      const colParts = (R.fog_color.string || '128 128 128').split(/\s+/).map(Number);
      gl.uniform3fv(program.uFogColor, [(colParts[0]||128)/255.0, (colParts[1]||128)/255.0, (colParts[2]||128)/255.0]);
    }
    if (program.uFogParams !== undefined) {
      // uFogParams = vec4(start, end, density, mode)
      gl.uniform4f(program.uFogParams, R.fog_start.value || 100.0, R.fog_end.value || 1000.0, R.fog_density.value || 0.01, R.fog_mode.value || 0.0);
    }
  }
};

R.SetupGL = function() {
  if (R.dowarp === true) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, R.warpbuffer);
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    gl.viewport(0, 0, R.warpwidth, R.warpheight);
  } else {
    const vrect = R.refdef.vrect;
    const pixelRatio = VID.pixelRatio;
    gl.viewport((vrect.x * pixelRatio) >> 0, ((VID.height - vrect.height - vrect.y) * pixelRatio) >> 0, (vrect.width * pixelRatio) >> 0, (vrect.height * pixelRatio) >> 0);
  }
  R.Perspective();
  gl.enable(gl.DEPTH_TEST);
};

R.viewleaf = null;

R.RenderScene = function() {
  R.AnimateLight();
  // FIXME: the next couple of lines need to be moved before requestAnimationFrame
  const {forward, right, up} = R.refdef.viewangles.angleVectors();
  [R.vpn, R.vright, R.vup] = [forward, right, up];
  R.viewleaf = Mod.PointInLeaf(R.refdef.vieworg, CL.state.worldmodel);
  V.SetContentsColor(R.viewleaf.contents);
  V.CalcBlend();
  R.dowarp = (R.waterwarp.value !== 0) && (R.viewleaf.contents <= content.CONTENT_WATER);

  R.SetFrustum();
  R.SetupGL();
  R.MarkLeaves();
  gl.enable(gl.CULL_FACE);
  R.DrawSkyBox();
  R.DrawViewModel();

  // Render world and entities using the renderer registry
  const worldEntity = CL.state.clientEntities.getEntity(0);
  if (worldEntity && worldEntity.model) {
    const brushRenderer = modelRendererRegistry.getRenderer(Mod.type.brush);
    if (brushRenderer) {
      // Pass 0: World opaque surfaces
      brushRenderer.render(worldEntity.model, worldEntity, 0);
    }
  }

  // Draw all other entities (pass 0 for opaque, pass 1 for transparent)
  R.DrawEntitiesOnList();

  // Pass 1: World turbulent surfaces
  if (worldEntity && worldEntity.model) {
    const brushRenderer = modelRendererRegistry.getRenderer(Mod.type.brush);
    if (brushRenderer) {
      brushRenderer.render(worldEntity.model, worldEntity, 1);
    }
  }

  gl.disable(gl.CULL_FACE);
  R.RenderDlights();
  R.DrawParticles();
};

R.RenderView = function() {
  gl.finish();
  // let time1;
  if (R.speeds.value !== 0) {
    // time1 = Sys.FloatTime();
    console.profile('R.RenderView');
  }
  R.c_brush_verts = 0;
  R.c_brush_tris = 0;
  R.c_brush_draws = 0;
  R.c_brush_draws_pbr = 0;  // Draw calls with PBR materials
  R.c_brush_vbos = 0;
  R.c_brush_texture_binds = 0;  // Track texture binding overhead
  R.c_alias_polys = 0;
  gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
  R.RenderScene();
  if (R.speeds.value !== 0) {
    console.profileEnd('R.RenderView');
    const c_brush_polys = R.c_brush_verts / 3;
    const c_alias_polys = R.c_alias_polys;
    const avgTrisPerDraw = (R.c_brush_tris / R.c_brush_draws).toFixed(1);
    Con.DPrint(`Frame Stats: ${R.c_brush_draws} draw calls (${R.c_brush_draws_pbr} PBR), ${R.c_brush_tris} tris (${R.c_brush_verts} verts), ${R.c_brush_vbos} VBO binds, ${c_alias_polys} alias polys, ${c_brush_polys} brush polys\n`);
    Con.DPrint(`  Avg ${avgTrisPerDraw} tris/draw, ${R.c_brush_texture_binds} texture binds\n`);
  }
};

// mesh

R.CalculateTagentBitagents = function(cmds, cutoff) {

  // compute per-triangle tangent/bitangent (stride = 20 floats)
  const stride = 20;
  for (let i = 0; i + stride * 3 <= Math.min(cutoff, cmds.length); i += stride * 3) {
    // vertices of triangle
    const i0 = i;
    const i1 = i + stride;
    const i2 = i + stride * 2;
    const p0 = [cmds[i0 + 0], cmds[i0 + 1], cmds[i0 + 2]];
    const p1 = [cmds[i1 + 0], cmds[i1 + 1], cmds[i1 + 2]];
    const p2 = [cmds[i2 + 0], cmds[i2 + 1], cmds[i2 + 2]];
    const uv0 = [cmds[i0 + 3], cmds[i0 + 4]];
    const uv1 = [cmds[i1 + 3], cmds[i1 + 4]];
    const uv2 = [cmds[i2 + 3], cmds[i2 + 4]];

    const edge1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const edge2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const deltaUV1 = [uv1[0] - uv0[0], uv1[1] - uv0[1]];
    const deltaUV2 = [uv2[0] - uv0[0], uv2[1] - uv0[1]];
    const det = deltaUV1[0] * deltaUV2[1] - deltaUV2[0] * deltaUV1[1];
    let f = 0.0;
    if (Math.abs(det) > 1e-6) {
      f = 1.0 / det;
    }
    const tx = f * (deltaUV2[1] * edge1[0] - deltaUV1[1] * edge2[0]);
    const ty = f * (deltaUV2[1] * edge1[1] - deltaUV1[1] * edge2[1]);
    const tz = f * (deltaUV2[1] * edge1[2] - deltaUV1[1] * edge2[2]);

    for (const base of [i0, i1, i2]) {
      // Get the correct normal from the vertex data
      const nx = cmds[base + 11];
      const ny = cmds[base + 12];
      const nz = cmds[base + 13];

      // Gram-Schmidt: tangent = tangent - normal * dot(normal, tangent)
      const dot_nt = nx * tx + ny * ty + nz * tz;
      const ortho_tx = tx - nx * dot_nt;
      const ortho_ty = ty - ny * dot_nt;
      const ortho_tz = tz - nz * dot_nt;

      // normalize orthogonalized tangent
      const tlen = Math.hypot(ortho_tx, ortho_ty, ortho_tz) || 1.0;
      const tnorm = [ortho_tx / tlen, ortho_ty / tlen, ortho_tz / tlen];

      // bitangent = cross(normal, tangent)
      const bnorm = [
        ny * tnorm[2] - nz * tnorm[1],
        nz * tnorm[0] - nx * tnorm[2],
        nx * tnorm[1] - ny * tnorm[0],
      ];

      cmds[base + 14] = tnorm[0];
      cmds[base + 15] = tnorm[1];
      cmds[base + 16] = tnorm[2];
      cmds[base + 17] = bnorm[0];
      cmds[base + 18] = bnorm[1];
      cmds[base + 19] = bnorm[2];
    }
  }
};

R.MakeBrushModelDisplayLists = function(m) {
  if (m.cmds && typeof m.cmds === 'object' && m.cmds !== null) {
    gl.deleteBuffer(m.cmds);
    m.cmds = null;
  }
  const cmds = [];
  const styles = [0.0, 0.0, 0.0, 0.0];
  let verts = 0;
  let cutoff = 0;
  m.chains = [];
  for (let i = 0; i < m.textures.length; i++) {
    const texture = m.textures[i];
    if ((texture.sky === true) || (texture.turbulent === true)) {
      continue;
    }
    const chain = [i, verts, 0];
    for (let j = 0; j < m.numfaces; j++) {
      const surf = m.faces[m.firstface + j];
      if (surf.texture !== i) {
        continue;
      }
      styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
      for (let l = 0; l < surf.styles.length; l++) {
        styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
      }
      chain[2] += surf.verts.length;
      for (let k = 0; k < surf.verts.length; k++) {
        const vert = surf.verts[k];
        // 28 bytes
        cmds[cmds.length] = vert[0]; // aPosition 0
        cmds[cmds.length] = vert[1]; // aPosition 1
        cmds[cmds.length] = vert[2]; // aPosition 2
        cmds[cmds.length] = vert[3]; // aTexCoord 0
        cmds[cmds.length] = vert[4]; // aTexCoord 1
        cmds[cmds.length] = vert[5]; // aTexCoord 2
        cmds[cmds.length] = vert[6]; // aTexCoord 3
        // 16 bytes
        cmds[cmds.length] = styles[0]; // aLightStyle 0
        cmds[cmds.length] = styles[1]; // aLightStyle 1
        cmds[cmds.length] = styles[2]; // aLightStyle 2
        cmds[cmds.length] = styles[3]; // aLightStyle 3
        // 36 bytes
        cmds[cmds.length] = surf.normal[0]; // aNormal 0
        cmds[cmds.length] = surf.normal[1]; // aNormal 1
        cmds[cmds.length] = surf.normal[2]; // aNormal 2
        cmds[cmds.length] = 0.0; // aTangent 0
        cmds[cmds.length] = 0.0; // aTangent 1
        cmds[cmds.length] = 0.0; // aTangent 2
        cmds[cmds.length] = 0.0; // aBitagent 0
        cmds[cmds.length] = 0.0; // aBitagent 1
        cmds[cmds.length] = 0.0; // aBitagent 2
      }
    }
    if (chain[2] !== 0) {
      m.chains[m.chains.length] = chain;
      verts += chain[2];
    }
  }
  cutoff = cmds.length;
  m.waterchain = verts * 80;
  verts = 0;
  for (let i = 0; i < m.textures.length; i++) {
    const texture = m.textures[i];
    if (texture.turbulent !== true) {
      continue;
    }
    const chain = [i, verts, 0];
    for (let j = 0; j < m.numfaces; j++) {
      const surf = m.faces[m.firstface + j];
      if (surf.texture !== i) {
        continue;
      }
      styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
      for (let l = 0; l < surf.styles.length; l++) {
        styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
      }
      chain[2] += surf.verts.length;
      for (let k = 0; k < surf.verts.length; k++) {
        const vert = surf.verts[k];
        // 28 bytes
        cmds[cmds.length] = vert[0]; // aPosition 0
        cmds[cmds.length] = vert[1]; // aPosition 1
        cmds[cmds.length] = vert[2]; // aPosition 2
        cmds[cmds.length] = vert[3]; // aTexCoord 0
        cmds[cmds.length] = vert[4]; // aTexCoord 1
        cmds[cmds.length] = vert[5]; // aTexCoord 2
        cmds[cmds.length] = vert[6]; // aTexCoord 3
        // 16 bytes
        cmds[cmds.length] = styles[0]; // aLightStyle 0
        cmds[cmds.length] = styles[1]; // aLightStyle 1
        cmds[cmds.length] = styles[2]; // aLightStyle 2
        cmds[cmds.length] = styles[3]; // aLightStyle 3
        // 36 bytes
        cmds[cmds.length] = surf.normal[0]; // aNormal 0
        cmds[cmds.length] = surf.normal[1]; // aNormal 1
        cmds[cmds.length] = surf.normal[2]; // aNormal 2
        cmds[cmds.length] = 0.0; // aTangent 0
        cmds[cmds.length] = 0.0; // aTangent 1
        cmds[cmds.length] = 0.0; // aTangent 2
        cmds[cmds.length] = 0.0; // aBitagent 0
        cmds[cmds.length] = 0.0; // aBitagent 1
        cmds[cmds.length] = 0.0; // aBitagent 2
      }
    }
    if (chain[2] !== 0) {
      m.chains[m.chains.length] = chain;
      verts += chain[2];
    }
  }

  R.CalculateTagentBitagents(cmds, cutoff);

  m.cmds = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
};

R.MakeWorldModelDisplayLists = function(m) {
  if (m.cmds != null) {
    return;
  }
  const cmds = [];
  const styles = [0.0, 0.0, 0.0, 0.0];
  let verts = 0;
  let cutoff = 0;
  for (let i = 0; i < m.textures.length; i++) {
    const texture = m.textures[i];
    if ((texture.sky === true) || (texture.turbulent === true)) {
      continue;
    }
    for (let j = 0; j < m.leafs.length; j++) {
      const leaf = m.leafs[j];
      const chain = [i, verts, 0];
      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (let l = 0; l < surf.verts.length; l++) {
          const vert = surf.verts[l];
          // 28 bytes
          cmds[cmds.length] = vert[0]; // aPosition 0
          cmds[cmds.length] = vert[1]; // aPosition 1
          cmds[cmds.length] = vert[2]; // aPosition 2
          cmds[cmds.length] = vert[3]; // aTexCoord 0
          cmds[cmds.length] = vert[4]; // aTexCoord 1
          cmds[cmds.length] = vert[5]; // aTexCoord 2
          cmds[cmds.length] = vert[6]; // aTexCoord 3
          // 16 bytes
          cmds[cmds.length] = styles[0]; // aLightStyle 0
          cmds[cmds.length] = styles[1]; // aLightStyle 1
          cmds[cmds.length] = styles[2]; // aLightStyle 2
          cmds[cmds.length] = styles[3]; // aLightStyle 3
          // 36 bytes
          cmds[cmds.length] = surf.normal[0]; // aNormal 0
          cmds[cmds.length] = surf.normal[1]; // aNormal 1
          cmds[cmds.length] = surf.normal[2]; // aNormal 2
          cmds[cmds.length] = 0.0; // aTangent 0
          cmds[cmds.length] = 0.0; // aTangent 1
          cmds[cmds.length] = 0.0; // aTangent 2
          cmds[cmds.length] = 0.0; // aBitagent 0
          cmds[cmds.length] = 0.0; // aBitagent 1
          cmds[cmds.length] = 0.0; // aBitagent 2
        }
      }
      if (chain[2] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        leaf.skychain++;
        leaf.waterchain++;
        verts += chain[2];
      }
    }
  }
  cutoff = cmds.length;
  m.skychain = verts * 80;
  verts = 0;
  for (let i = 0; i < m.textures.length; i++) {
    const texture = m.textures[i];
    if (!texture.sky) {
      continue;
    }
    for (let j = 0; j < m.leafs.length; j++) {
      const leaf = m.leafs[j];
      const chain = [verts, 0];
      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        chain[1] += surf.verts.length;
        for (let l = 0; l < surf.verts.length; l++) {
          const vert = surf.verts[l];
          cmds[cmds.length] = vert[0];
          cmds[cmds.length] = vert[1];
          cmds[cmds.length] = vert[2];
        }
      }
      if (chain[1] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        leaf.waterchain++;
        verts += chain[1];
      }
    }
  }
  m.waterchain = m.skychain + verts * 12;
  verts = 0;
  for (let i = 0; i < m.textures.length; i++) {
    const texture = m.textures[i];
    if (texture.turbulent !== true) {
      continue;
    }
    for (let j = 0; j < m.leafs.length; j++) {
      const leaf = m.leafs[j];
      const chain = [i, verts, 0];
      for (let k = 0; k < leaf.nummarksurfaces; k++) {
        const surf = m.faces[m.marksurfaces[leaf.firstmarksurface + k]];
        if (surf.texture !== i) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (let l = 0; l < surf.verts.length; l++) {
          const vert = surf.verts[l];
          // 28 bytes
          cmds[cmds.length] = vert[0]; // aPosition 0
          cmds[cmds.length] = vert[1]; // aPosition 1
          cmds[cmds.length] = vert[2]; // aPosition 2
          cmds[cmds.length] = vert[3]; // aTexCoord 0
          cmds[cmds.length] = vert[4]; // aTexCoord 1
          cmds[cmds.length] = vert[5]; // aTexCoord 2
          cmds[cmds.length] = vert[6]; // aTexCoord 3
          // 16 bytes
          cmds[cmds.length] = styles[0]; // aLightStyle 0
          cmds[cmds.length] = styles[1]; // aLightStyle 1
          cmds[cmds.length] = styles[2]; // aLightStyle 2
          cmds[cmds.length] = styles[3]; // aLightStyle 3
          // 36 bytes
          cmds[cmds.length] = surf.normal[0]; // aNormal 0
          cmds[cmds.length] = surf.normal[1]; // aNormal 1
          cmds[cmds.length] = surf.normal[2]; // aNormal 2
          cmds[cmds.length] = 0.0; // aTangent 0
          cmds[cmds.length] = 0.0; // aTangent 1
          cmds[cmds.length] = 0.0; // aTangent 2
          cmds[cmds.length] = 0.0; // aBitagent 0
          cmds[cmds.length] = 0.0; // aBitagent 1
          cmds[cmds.length] = 0.0; // aBitagent 2
        }
      }
      if (chain[2] !== 0) {
        leaf.cmds[leaf.cmds.length] = chain;
        verts += chain[2];
      }
    }
  }

  R.CalculateTagentBitagents(cmds, cutoff);

  m.cmds = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
};

// misc

const solidskytexture = new GLTexture('r_solidsky', 128, 128);
const alphaskytexture = new GLTexture('r_alphasky', 128, 128);

R.InitTextures = function() {
  if (Host.dedicated.value) {
    return;
  }

  // make a default texture (a red and black checkerboard)
  const data = new Uint8Array(new ArrayBuffer(256 * 4));
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) {
      data[((i << 4) + j) * 4 + 0] = 255;
      data[((i << 4) + j) * 4 + 1] = 0;
      data[((i << 4) + j) * 4 + 2] = 0;
      data[((i << 4) + j) * 4 + 3] = 255;

      data[(136 + (i << 4) + j) * 4 + 0] = 255;
      data[(136 + (i << 4) + j) * 4 + 1] = 0;
      data[(136 + (i << 4) + j) * 4 + 2] = 0;
      data[(136 + (i << 4) + j) * 4 + 3] = 255;

      data[(8 + (i << 4) + j) * 4 + 0] = 0;
      data[(8 + (i << 4) + j) * 4 + 1] = 0;
      data[(8 + (i << 4) + j) * 4 + 2] = 0;
      data[(8 + (i << 4) + j) * 4 + 3] = 255;

      data[(128 + (i << 4) + j) * 4 + 0] = 0;
      data[(128 + (i << 4) + j) * 4 + 1] = 0;
      data[(128 + (i << 4) + j) * 4 + 2] = 0;
      data[(128 + (i << 4) + j) * 4 + 3] = 255;
    }
  }

  R.notexture = GLTexture.Allocate('r_notexture', 16, 16, data);

  // CR: this combination of texture modes make the sky look more crisp
  alphaskytexture.lockTextureMode('GL_NEAREST');
  solidskytexture.lockTextureMode('GL_LINEAR');

  R.deluxemap_texture = gl.createTexture();
  GL.Bind(0, R.deluxemap_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.lightmap_texture = gl.createTexture();
  GL.Bind(0, R.lightmap_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.dlightmap_rgba_texture = gl.createTexture();
  GL.Bind(0, R.dlightmap_rgba_texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  R.lightstyle_texture_a = gl.createTexture();
  GL.Bind(0, R.lightstyle_texture_a);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.lightstyle_texture_b = gl.createTexture();
  GL.Bind(0, R.lightstyle_texture_b);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.fullbright_texture = gl.createTexture();
  GL.Bind(0, R.fullbright_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.null_texture = gl.createTexture();
  GL.Bind(0, R.null_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  R.normal_up_texture = gl.createTexture();
  GL.Bind(0, R.normal_up_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 255, 128, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
};

R.InitShaders = async function() {
  // rendering alias models
  await Promise.all([
    GL.CreateProgram('alias',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uAlpha', 'uTime', 'uFogColor', 'uFogParams'],
      [
        ['aPositionA', gl.FLOAT, 3],
        ['aPositionB', gl.FLOAT, 3],
        ['aNormal', gl.FLOAT, 3],
        ['aTexCoord', gl.FLOAT, 2],
      ],
      ['tTexture']),

    // rendering brush models (water is down below)
    GL.CreateProgram('brush',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uAlpha', 'uFogColor', 'uFogParams', 'uPerformDotLighting', 'uHaveDeluxemap'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 4],
          ['aLightStyle', gl.FLOAT, 4],
          ['aNormal', gl.FLOAT, 3],
          ['aTangent', gl.FLOAT, 3],
        ],
        ['tTextureA', 'tTextureB', 'tLightmap', 'tDlight', 'tLightStyleA', 'tLightStyleB', 'tLuminance', 'tSpecular', 'tNormal', 'tDeluxemap']),

    // rendering dynamic lights
    GL.CreateProgram('dlight',
        ['uOrigin', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uRadius', 'uGamma'],
        [['aPosition', gl.FLOAT, 3]],
        []),

    // rendering the player model (similar to alias model but with custom colors)
    GL.CreateProgram('player',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uLightVec', 'uGamma', 'uAmbientLight', 'uShadeLight', 'uAlpha', 'uTime', 'uTop', 'uBottom', 'uFogColor', 'uFogParams'],
        [
          ['aPositionA', gl.FLOAT, 3],
          ['aPositionB', gl.FLOAT, 3],
          ['aNormal', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 2],
        ],
        ['tTexture', 'tPlayer']),

    // for rendering sprites (usually effects)
    GL.CreateProgram('sprite',
      ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
        [['aPosition', gl.FLOAT, 3], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture']),

    // for rendering particles (colored round dots)
    GL.CreateProgram('particle',
      ['uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uFogColor', 'uFogParams'],
        [['aOrigin', gl.FLOAT, 3], ['aCoord', gl.FLOAT, 2], ['aScale', gl.FLOAT, 1], ['aColor', gl.UNSIGNED_BYTE, 3, true]],
        []),

    // rendering water brushes
    GL.CreateProgram('turbulent',
      ['uOrigin', 'uAngles', 'uViewOrigin', 'uViewAngles', 'uPerspective', 'uGamma', 'uTime', 'uFogColor', 'uFogParams', 'uPerformDotLighting'],
        [
          ['aPosition', gl.FLOAT, 3],
          ['aTexCoord', gl.FLOAT, 4],
          ['aLightStyle', gl.FLOAT, 4],
          // ['aNormal', gl.FLOAT, 3],
          // ['aTangent', gl.FLOAT, 3],
          // ['aBitangent', gl.FLOAT, 3],
        ],
        ['tTexture', 'tLightmap', 'tDlight', 'tLightStyle', 'tDeluxemap']),

    // warp overlay effect
    GL.CreateProgram('warp',
        ['uOrtho', 'uTime'],
        [['aPosition', gl.FLOAT, 2], ['aTexCoord', gl.FLOAT, 2]],
        ['tTexture']),

    GL.CreateProgram('sky',
      ['uViewAngles', 'uPerspective', 'uScale', 'uGamma', 'uTime', 'uFogColor', 'uFogParams'],
      [['aPosition', gl.FLOAT, 3]],
      ['tSolid', 'tAlpha']),

    GL.CreateProgram('sky-chain',
      ['uViewOrigin', 'uViewAngles', 'uPerspective'],
      [['aPosition', gl.FLOAT, 3]],
      []),
  ]);
};

R.Init = async function() {
  if (registry.isDedicatedServer) {
    console.assert(false, 'R.Init called on dedicated server');
    return;
  }

  Cmd.AddCommand('timerefresh', R.TimeRefresh_f);

  R.waterwarp = new Cvar('r_waterwarp', '1');
  R.fullbright = new Cvar('r_fullbright', '0', Cvar.FLAG.CHEAT);
  R.drawentities = new Cvar('r_drawentities', '1', Cvar.FLAG.CHEAT);
  R.drawviewmodel = new Cvar('r_drawviewmodel', '1');
  R.drawturbolents = new Cvar('r_drawturbolents', '1', Cvar.FLAG.CHEAT);
  R.novis = new Cvar('r_novis', '0', Cvar.FLAG.CHEAT);
  R.speeds = new Cvar('r_speeds', '0');
  R.polyblend = new Cvar('gl_polyblend', '1');
  R.flashblend = new Cvar('gl_flashblend', '0');
  R.nocolors = new Cvar('gl_nocolors', '0');
  R.interpolation = new Cvar('r_interpolation', '1', Cvar.FLAG.ARCHIVE, 'Interpolation of textures and animation groups, 0 - off, 1 - on');
  R.pbr_lod_threshold = new Cvar('r_pbr_lod_threshold', '-1', Cvar.FLAG.ARCHIVE, 'Triangle count threshold to disable PBR (normal mapping) for fillrate optimization. -1 = no limit (always PBR), 0 = PBR off, >0 = disable PBR when triangle count exceeds threshold');
  // fog controls
  R.fog_color = new Cvar('r_fog_color', '128 128 128', Cvar.FLAG.ARCHIVE, 'Fog color: R G B (0-255)');
  R.fog_start = new Cvar('r_fog_start', '100', Cvar.FLAG.ARCHIVE, 'Fog start distance');
  R.fog_end = new Cvar('r_fog_end', '1000', Cvar.FLAG.ARCHIVE, 'Fog end distance (linear)');
  R.fog_density = new Cvar('r_fog_density', '0.01', Cvar.FLAG.ARCHIVE, 'Fog density (for exp/exp2)');
  R.fog_mode = new Cvar('r_fog_mode', '-1', Cvar.FLAG.ARCHIVE, 'Fog mode: 0=linear, 1=exp, 2=exp2, -1=disable');

  R.InitTextures();
  R.InitParticles();
  await R.InitShaders();

  // Register model renderers
  modelRendererRegistry.register(new BrushModelRenderer());
  modelRendererRegistry.register(new AliasModelRenderer());
  modelRendererRegistry.register(new SpriteModelRenderer());

  R.warpbuffer = gl.createFramebuffer();
  R.warptexture = gl.createTexture();
  GL.Bind(0, R.warptexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); // FIXME: mipmap
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST); // FIXME: mipmap
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  R.warprenderbuffer = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, R.warprenderbuffer);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 0, 0);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.warpbuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, R.warptexture, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, R.warprenderbuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  R.dlightvecs = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, R.dlightvecs);
  gl.bufferData(gl.ARRAY_BUFFER, (() => {
    const positions = [];

    // 1) The "down" vector
    positions.push(0, -1, 0);

    // 2) 16 equally spaced vectors around the circle in y=0 plane
    const numSegments = 16;
    for (let i = 0; i <= numSegments; i++) {
      // Angle in radians
      const angle = (2 * Math.PI * i) / numSegments;
      // Match the pattern: x = -sin(angle), z = cos(angle)
      positions.push(-Math.sin(angle), 0, Math.cos(angle));
    }

    return new Float32Array(positions);
  })(), gl.STATIC_DRAW);

  R.MakeSky();
};

R.NewMap = function() {
  if (R.particles) {
    R.particles.length = 0;
  }

  for (let i = 0; i < 64; i++) {
    R.lightstylevalue_a[i] = 12;
    R.lightstylevalue_b[i] = 12;
  }

  R.ClearParticles();
  R.BuildLightmaps();

  for (let i = 0; i <= R.dlightmaps_rgba.length; i++) {
    R.dlightmaps_rgba[i] = 0;
  }

  GL.Bind(0, R.dlightmap_rgba_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 1024, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
};

R.TimeRefresh_f = function() {
  gl.finish();
  let i;
  const start = Sys.FloatTime();
  for (i = 0; i <= 127; i++) {
    R.refdef.viewangles[1] = i * 2.8125;
    R.RenderView();
  }
  gl.finish();
  const time = Sys.FloatTime() - start;
  Con.Print(time.toFixed(6) + ' seconds (' + (128.0 / time).toFixed(6) + ' fps)\n');
};

// part

R.ptype = {
  tracer: 0,
  grav: 1,
  slowgrav: 2,
  fire: 3,
  explode: 4,
  explode2: 5,
  blob: 6,
  blob2: 7,
};

R.ramp1 = [0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61];
R.ramp2 = [0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66];
R.ramp3 = [0x6d, 0x6b, 6, 5, 4, 3];

R.InitParticles = function() {
  R.numparticles = 32786;
  R.avelocities = [];
  for (let i = 0; i <= 161; i++) {
    R.avelocities[i] = [Math.random() * 2.56, Math.random() * 2.56, Math.random() * 2.56];
  }
};

R.SerializeParticles = function() {
  const data = [];
  const round = (num) => Math.round(num * 10) / 10; // we do not need a high precision here

  for (let i = 0; i < R.numparticles; i++) {
    const p = R.particles[i];

    if (p.die < CL.state.time) {
      continue;
    }

    data.push({
      i: i,
      die: round(p.die - CL.state.time),
      color: p.color,
      ramp: round(p.ramp),
      type: round(p.type),
      org: [...p.org].map(round),
      vel: [...p.vel].map(round),
    });
  }

  return data;
};

R.DeserializeParticles = function(data) {
  for (const p of data) {
    console.assert(p.i >= 0 && p.i < R.particles.length, 'valid particle index', p.i);
    R.particles[p.i] = {
      die: p.die + CL.state.time,
      color: p.color,
      ramp: p.ramp,
      type: p.type,
      org: new Vector(...p.org),
      vel: new Vector(...p.vel),
    };
  }
};

R.EntityParticles = function(ent) {
  const allocated = R.AllocParticles(162);

  for (let i = 0; i < allocated.length; i++) {
    const angleP = CL.state.time * R.avelocities[i][0];
    const sp = Math.sin(angleP);
    const cp = Math.cos(angleP);
    const angleY = CL.state.time * R.avelocities[i][1];
    const sy = Math.sin(angleY);
    const cy = Math.cos(angleY);

    R.particles[allocated[i]] = { // TODO: Particle Class
      die: CL.state.time + 0.01,
      color: 0x6f,
      ramp: 0.0,
      type: R.ptype.explode,
      org: [
        ent.origin[0] + R.avertexnormals[i][0] * 64.0 + cp * cy * 16.0,
        ent.origin[1] + R.avertexnormals[i][1] * 64.0 + cp * sy * 16.0,
        ent.origin[2] + R.avertexnormals[i][2] * 64.0 + sp * -16.0,
      ],
      vel: new Vector(),
    };
  }
};

R.ClearParticles = function() {
  R.particles = [];
  for (let i = 0; i < R.numparticles; i++) {
    R.particles[i] = {die: -1.0};
  }
};

R.ParseParticleEffect = function() {
  const org = new Vector(MSG.ReadCoord(), MSG.ReadCoord(), MSG.ReadCoord());
  const dir = new Vector(MSG.ReadChar() * 0.0625, MSG.ReadChar() * 0.0625, MSG.ReadChar() * 0.0625);
  const msgcount = MSG.ReadByte();
  const color = MSG.ReadByte();
  if (msgcount === 255) {
    R.ParticleExplosion(org);
  } else {
    R.RunParticleEffect(org, dir, color, msgcount);
  }
};

R.ParticleExplosion = function(org) {
  const allocated = R.AllocParticles(1024);
  for (let i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 5.0,
      color: R.ramp1[0],
      ramp: Math.floor(Math.random() * 4.0),
      type: ((i & 1) !== 0) ? R.ptype.explode : R.ptype.explode2,
      org: new Vector(
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      ),
      vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
    };
  }
};

R.ParticleExplosion2 = function(org, colorStart, colorLength) {
  const allocated = R.AllocParticles(512);
  let colorMod = 0;
  for (let i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 0.3,
      color: colorStart + (colorMod++ % colorLength),
      type: R.ptype.blob,
      org: new Vector(
        org[0] + Math.random() * 32.0 - 16.0,
        org[1] + Math.random() * 32.0 - 16.0,
        org[2] + Math.random() * 32.0 - 16.0,
      ),
      vel: new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0),
    };
  }
};

R.BlobExplosion = function(org) {
  const allocated = R.AllocParticles(1024);
  for (let i = 0; i < allocated.length; i++) {
    const p = R.particles[allocated[i]];
    p.die = CL.state.time + 1.0 + Math.random() * 0.4;
    if ((i & 1) !== 0) {
      p.type = R.ptype.blob;
      p.color = 66 + Math.floor(Math.random() * 7.0);
    } else {
      p.type = R.ptype.blob2;
      p.color = 150 + Math.floor(Math.random() * 7.0);
    }
    p.org = new Vector(
      org[0] + Math.random() * 32.0 - 16.0,
      org[1] + Math.random() * 32.0 - 16.0,
      org[2] + Math.random() * 32.0 - 16.0,
    );
    p.vel = new Vector(Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0, Math.random() * 512.0 - 256.0);
  }
};

R.RunParticleEffect = function(org, dir, color, count) {
  const allocated = R.AllocParticles(count); let i;
  for (i = 0; i < allocated.length; i++) {
    R.particles[allocated[i]] = {
      die: CL.state.time + 0.6 * Math.random(),
      color: (color & 0xf8) + Math.floor(Math.random() * 8.0),
      type: R.ptype.slowgrav,
      org: new Vector(
        org[0] + Math.random() * 16.0 - 8.0,
        org[1] + Math.random() * 16.0 - 8.0,
        org[2] + Math.random() * 16.0 - 8.0,
      ),
      vel: dir.copy().multiply(15.0),
    };
  }
};

R.LavaSplash = function(org) {
  const allocated = R.AllocParticles(1024);
  let k = 0;
  for (let i = -16; i <= 15; i++) {
    for (let j = -16; j <= 15; j++) {
      if (k >= allocated.length) {
        return;
      }
      const p = R.particles[allocated[k++]];
      p.die = CL.state.time + 2.0 + Math.random() * 0.64;
      p.color = 224 + Math.floor(Math.random() * 8.0);
      p.type = R.ptype.slowgrav;
      const dir = new Vector((j + Math.random()) * 8.0, (i + Math.random()) * 8.0, 256.0);
      p.org = new Vector(org[0] + dir[0], org[1] + dir[1], org[2] + Math.random() * 64.0);
      dir.normalize();
      p.vel = dir.multiply(50.0 + Math.random() * 64.0);
    }
  }
};

R.TeleportSplash = function(org) {
  const allocated = R.AllocParticles(896);
  let l = 0;
  for (let i = -16; i <= 15; i += 4) {
    for (let j = -16; j <= 15; j += 4) {
      for (let k = -24; k <= 31; k += 4) {
        if (l >= allocated.length) {
          return;
        }
        const p = R.particles[allocated[l++]];
        p.die = CL.state.time + 0.2 + Math.random() * 0.16;
        p.color = 7 + Math.floor(Math.random() * 8.0);
        p.type = R.ptype.slowgrav;
        const dir = new Vector(j * 8.0, i * 8.0, k * 8.0);
        p.org = new Vector(
          org[0] + i + Math.random() * 4.0,
          org[1] + j + Math.random() * 4.0,
          org[2] + k + Math.random() * 4.0,
        );
        dir.normalize();
        p.vel = dir.multiply(50.0 + Math.random() * 64.0);
      }
    }
  }
};

R.tracercount = 0;
R.RocketTrail = function(start, end, type) {
  let vec = end.copy().subtract(start);

  const len = vec.len();

  if (len === 0.0) {
    return;
  }

  vec.normalize();

  let allocated;
  if (type === 4) {
    allocated = R.AllocParticles(Math.floor(len / 6.0));
  } else {
    allocated = R.AllocParticles(Math.floor(len / 3.0));
  }

  for (let i = 0; i < allocated.length; i++) {
    const p = R.particles[allocated[i]];
    p.vel = new Vector();
    p.die = CL.state.time + 2.0;
    switch (type) {
      case 7:
        type = 1;
        p.die += 8.0;
      // eslint-disable-next-line no-fallthrough
      case 0:
      case 1:
        p.ramp = Math.floor(Math.random() * 4.0) + (type << 1);
        p.color = R.ramp3[p.ramp];
        p.type = R.ptype.fire;
        p.org = new Vector(
          start[0] + Math.random() * 6.0 - 3.0,
          start[1] + Math.random() * 6.0 - 3.0,
          start[2] + Math.random() * 6.0 - 3.0,
        );
        break;
      case 2:
        p.type = R.ptype.grav;
        p.color = 67 + Math.floor(Math.random() * 4.0);
        p.org = new Vector(
          start[0] + Math.random() * 6.0 - 3.0,
          start[1] + Math.random() * 6.0 - 3.0,
          start[2] + Math.random() * 6.0 - 3.0,
        );
        break;
      case 3:
      case 5:
        p.die = CL.state.time + 0.5;
        p.type = R.ptype.tracer;
        if (type === 3) {
          p.color = 52 + ((R.tracercount++ & 4) << 1);
        } else {
          p.color = 230 + ((R.tracercount++ & 4) << 1);
        }
        p.org = new Vector(start[0], start[1], start[2]);
        if ((R.tracercount & 1) !== 0) {
          p.vel[0] = 30.0 * vec[1];
          p.vel[2] = -30.0 * vec[0];
        } else {
          p.vel[0] = -30.0 * vec[1];
          p.vel[2] = 30.0 * vec[0];
        }
        break;
      case 4:
        p.type = R.ptype.grav;
        p.color = 67 + Math.floor(Math.random() * 4.0);
        p.org = new Vector(
          start[0] + Math.random() * 6.0 - 3.0,
          start[1] + Math.random() * 6.0 - 3.0,
          start[2] + Math.random() * 6.0 - 3.0,
        );
        break;
      case 6:
        p.color = 152 + Math.floor(Math.random() * 4.0);
        p.type = R.ptype.tracer;
        p.die = CL.state.time + 0.3;
        p.org = new Vector(
          start[0] + Math.random() * 16.0 - 8.0,
          start[1] + Math.random() * 16.0 - 8.0,
          start[2] + Math.random() * 16.0 - 8.0,
        );
        break;
      default:
        console.assert(false, 'Unknown particle type: ' + type);
    }
    start.add(vec);
  }
};

R.DrawParticles = function() {
  GL.StreamFlush();

  GL.UseProgram('particle');
  gl.depthMask(false);
  gl.enable(gl.BLEND);

  const frametime = Host.frametime;
  const grav = frametime * SV.gravity.value * 0.05;
  const dvel = frametime * 4.0;
  let scale;

  const coords = [-1.0, -1.0, -1.0, 1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0];
  for (let i = 0; i < R.numparticles; i++) {
    const p = R.particles[i];
    if (p.die < CL.state.time) {
      continue;
    }

    const color = W.d_8to24table[p.color];
    scale = (p.org[0] - R.refdef.vieworg[0]) * R.vpn[0] + (p.org[1] - R.refdef.vieworg[1]) * R.vpn[1] + (p.org[2] - R.refdef.vieworg[2]) * R.vpn[2];
    if (scale < 20.0) {
      scale = 0.375;
    } else {
      scale = 0.375 + scale * 0.0015;
    }

    GL.StreamGetSpace(6);
    for (let j = 0; j < 6; j++) {
      GL.StreamWriteFloat3(p.org[0], p.org[1], p.org[2]);
      GL.StreamWriteFloat2(coords[j * 2], coords[j * 2 + 1]);
      GL.StreamWriteFloat(scale);
      GL.StreamWriteUByte4(color & 0xff, (color >> 8) & 0xff, color >> 16, 255);
    }

    p.org[0] += p.vel[0] * frametime;
    p.org[1] += p.vel[1] * frametime;
    p.org[2] += p.vel[2] * frametime;

    switch (p.type) {
      case R.ptype.fire:
        p.ramp += frametime * 5.0;
        if (p.ramp >= 6.0) {
          p.die = -1.0;
        } else {
          p.color = R.ramp3[Math.floor(p.ramp)];
        }
        p.vel[2] += grav;
        continue;
      case R.ptype.explode:
        p.ramp += frametime * 10.0;
        if (p.ramp >= 8.0) {
          p.die = -1.0;
        } else {
          p.color = R.ramp1[Math.floor(p.ramp)];
        }
        p.vel[0] += p.vel[0] * dvel;
        p.vel[1] += p.vel[1] * dvel;
        p.vel[2] += p.vel[2] * dvel - grav;
        continue;
      case R.ptype.explode2:
        p.ramp += frametime * 15.0;
        if (p.ramp >= 8.0) {
          p.die = -1.0;
        } else {
          p.color = R.ramp2[Math.floor(p.ramp)];
        }
        p.vel[0] -= p.vel[0] * frametime;
        p.vel[1] -= p.vel[1] * frametime;
        p.vel[2] -= p.vel[2] * frametime + grav;
        continue;
      case R.ptype.blob:
        p.vel[0] += p.vel[0] * dvel;
        p.vel[1] += p.vel[1] * dvel;
        p.vel[2] += p.vel[2] * dvel - grav;
        continue;
      case R.ptype.blob2:
        p.vel[0] += p.vel[0] * dvel;
        p.vel[1] += p.vel[1] * dvel;
        p.vel[2] -= grav;
        continue;
      case R.ptype.grav:
      case R.ptype.slowgrav:
        p.vel[2] -= grav;
    }
  }

  GL.StreamFlush();

  gl.disable(gl.BLEND);
  gl.depthMask(true);
};

R.AllocParticles = function(count) {
  const allocated = []; let i;
  for (i = 0; i < R.numparticles; i++) {
    if (count === 0) {
      return allocated;
    }
    if (R.particles[i].die < CL.state.time) {
      allocated[allocated.length] = i;
      --count;
    }
  }
  return allocated;
};

// surf

R.lightmap_modified = [];
R.lightmaps = new Uint8Array(new ArrayBuffer(4194304));
R.lightmaps_rgb = new Uint8Array(new ArrayBuffer(4194304 * 4));
R.dlightmaps_rgba = new Uint8Array(new ArrayBuffer(1048576 * 4)); // TODO: doesn’t need to be 32 bits I guess
R.deluxemap = new Uint8Array(new ArrayBuffer(4194304 * 4));

R.AddDynamicLights = function(surf) {
  const smax = (surf.extents[0] >> surf.lmshift) + 1;
  const tmax = (surf.extents[1] >> surf.lmshift) + 1;
  const size = smax * tmax;

  const blocklights = [];
  for (let i = 0; i < size * 3; i++) {
    blocklights[i] = 0;
  }

  for (let i = 0; i < Def.limits.dlights; i++) {
    if (((surf.dlightbits >>> i) & 1) === 0) {
      continue;
    }
    const light = CL.state.clientEntities.dlights[i];
    let dist = light.origin.dot(surf.plane.normal) - surf.plane.dist;
    const rad = light.radius - Math.abs(dist);
    let minlight = light.minlight;
    if (rad < minlight) {
      continue;
    }
    minlight = rad - minlight;
    const impact = light.origin.copy().subtract(surf.plane.normal.copy().multiply(dist));
    const tex = CL.state.worldmodel.texinfo[surf.texinfo];
    const local = [
      impact.dot(new Vector(...tex.vecs[0])) + tex.vecs[0][3] - surf.texturemins[0],
      impact.dot(new Vector(...tex.vecs[1])) + tex.vecs[1][3] - surf.texturemins[1],
    ];
    for (let t = 0; t < tmax; t++) {
      let td = local[1] - (t << surf.lmshift);
      if (td < 0.0) {
        td = -td;
      }
      td = Math.floor(td);
      for (let s = 0; s < smax; s++) {
        let sd = local[0] - (s << surf.lmshift);
        if (sd < 0) {
          sd = -sd;
        }
        sd = Math.floor(sd);
        if (sd > td) {
          dist = sd + (td >> 1);
        } else {
          dist = td + (sd >> 1);
        }
        if (dist < minlight) {
          const bl = Math.floor((rad - dist) * 256.0);
          const pos = (t * smax + s) * 3;
          for (let i = 0; i < 3; i++) {
            blocklights[pos + i] += bl * light.color[i];
          }
        }
      }
    }
  }

  for (let t = 0, i = 0; t < tmax; t++) {
    R.lightmap_modified[surf.light_t + t] = true;
    const dest = ((surf.light_t + t) << 10) + surf.light_s;
    for (let s = 0; s < smax; s++) {
      const dldest = (dest + s) * 4;
      const blrgb = [
        Math.min(Math.floor(blocklights[i * 3] / 128), 255),
        Math.min(Math.floor(blocklights[i * 3 + 1] / 128), 255),
        Math.min(Math.floor(blocklights[i * 3 + 2] / 128), 255),
      ];
      // console.log(blrgb);
      i++;
      for (let i = 0; i < 3; i++) {
        R.dlightmaps_rgba[dldest + i] = blrgb[i];
      }
    }
  }
};

R.RemoveDynamicLights = function(surf) {
  const smax = (surf.extents[0] >> surf.lmshift) + 1;
  const tmax = (surf.extents[1] >> surf.lmshift) + 1;
  for (let t = 0; t < tmax; t++) {
    R.lightmap_modified[surf.light_t + t] = true;
    const dest = ((surf.light_t + t) << 10) + surf.light_s;
    for (let s = 0; s < smax; s++) {
      const dldest = (dest + s) * 4;
      for (let i = 0; i < 3; i++) {
        R.dlightmaps_rgba[dldest + i] = 0;
      }
      R.dlightmaps_rgba[dldest + 3] = 255; // fully opaque
    }
  }
};

R.BuildLightMap = function(surf) {
  const smax = (surf.extents[0] >> surf.lmshift) + 1;
  const tmax = (surf.extents[1] >> surf.lmshift) + 1;

  for (let k = 0; k < 3; k++) {
    const offset = 4194304 * k;
    let lightmap = surf.lightofs;
    let maps;

    for (maps = 0; maps < surf.styles.length; maps++) {
      let dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
      for (let i = 0; i < tmax; i++) {
        for (let j = 0; j < smax; j++) {
          R.lightmaps_rgb[dest + (j << 2) + offset] = R.currentmodel.lightdata[lightmap + j];
        }
        lightmap += smax;
        dest += 4096;
      }
    }

    for (; maps < 4; maps++) {
      let dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
      for (let i = 0; i < tmax; i++) {
        for (let j = 0; j < smax; j++) {
          R.lightmaps_rgb[dest + (j << 2) + offset] = 0;
        }
        dest += 4096;
      }
    }
  }
};

R.BuildLightMapEx = function(surf) {
  const smax = (surf.extents[0] >> surf.lmshift) + 1;
  const tmax = (surf.extents[1] >> surf.lmshift) + 1;

  for (let k = 0; k < 3; k++) {
    const offset = 4194304 * k;
    let lightmap = surf.lightofs * 3;
    let maps;

    for (maps = 0; maps < surf.styles.length; maps++) {
      let dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
      for (let i = 0; i < tmax; i++) {
        for (let j = 0; j < smax; j++) {
          R.lightmaps_rgb[dest + (j << 2) + offset] = R.currentmodel.lightdata_rgb[(lightmap + j * 3) + k];

          if (R.currentmodel.deluxemap) {
            R.deluxemap[dest + (j << 2) + offset] = R.currentmodel.deluxemap[(lightmap + j * 3) + k];
          }
        }
        lightmap += smax * 3;
        dest += 4096;
      }
    }

    for (; maps < 4; maps++) {
      let dest = (surf.light_t << 12) + (surf.light_s << 2) + maps;
      for (let i = 0; i < tmax; i++) {
        for (let j = 0; j < smax; j++) {
          R.lightmaps_rgb[dest + (j << 2) + offset] = 0;
          R.deluxemap[dest + (j << 2) + offset] = 0;
        }
        dest += 4096;
      }
    }
  }
};

/**
 * @param base
 * @returns {[BrushModelTexture, BrushModelTexture]}
 */
R.TextureAnimation = function(base) {
  let frame = 0;
  if (base.anim_base !== null) {
    frame = base.anim_frame;
    base = R.currententity.model.textures[base.anim_base];
  }
  let anims = base.anims;
  if (anims.length === 0) {
    return [base, base];
  }
  if ((R.currententity.frame !== 0) && (base.alternate_anims.length !== 0)) {
    anims = base.alternate_anims;
  }
  return [
    R.currententity.model.textures[anims[(Math.floor(CL.state.time * 5.0) + frame) % anims.length]],
    R.currententity.model.textures[anims[(Math.floor(CL.state.time * 5.0) + frame + 1) % anims.length]],
  ];
};

R.RecursiveWorldNode = function(node) {
  if (node.contents === content.CONTENT_SOLID) {
    return;
  }
  if (node.contents < 0) {
    if (node.markvisframe !== R.visframecount) {
      return;
    }
    node.visframe = R.visframecount;
    if (node.skychain !== node.waterchain) {
      R.drawsky = true;
    }
    return;
  }
  R.RecursiveWorldNode(node.children[0]);
  R.RecursiveWorldNode(node.children[1]);
};

R.MarkLeaves = function() {
  if ((R.oldviewleaf === R.viewleaf) && (R.novis.value === 0)) {
    return;
  }
  R.visframecount++;
  R.oldviewleaf = R.viewleaf;
  let vis = (R.novis.value !== 0) ? Mod.novis : Mod.LeafPVS(R.viewleaf, CL.state.worldmodel);
  let i; let node;
  for (i = 0; i < CL.state.worldmodel.leafs.length; i++) {
    if ((vis[i >> 3] & (1 << (i & 7))) === 0) {
      continue;
    }
    for (node = CL.state.worldmodel.leafs[i + 1]; node != null; node = node.parent) {
      if (node.markvisframe === R.visframecount) {
        break;
      }
      node.markvisframe = R.visframecount;
    }
  }
  do {
    if (R.novis.value !== 0) {
      break;
    }
    // const p = [R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2]];
    let leaf;
    if (R.viewleaf.contents <= content.CONTENT_WATER) {
      leaf = Mod.PointInLeaf([R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2] + 16.0], CL.state.worldmodel);
      if (leaf.contents <= content.CONTENT_WATER) {
        break;
      }
    } else {
      leaf = Mod.PointInLeaf([R.refdef.vieworg[0], R.refdef.vieworg[1], R.refdef.vieworg[2] - 16.0], CL.state.worldmodel);
      if (leaf.contents > content.CONTENT_WATER) {
        break;
      }
    }
    if (leaf === R.viewleaf) {
      break;
    }
    vis = Mod.LeafPVS(leaf, CL.state.worldmodel);
    for (i = 0; i < CL.state.worldmodel.leafs.length; i++) {
      if ((vis[i >> 3] & (1 << (i & 7))) === 0) {
        continue;
      }
      for (node = CL.state.worldmodel.leafs[i + 1]; node != null; node = node.parent) {
        if (node.markvisframe === R.visframecount) {
          break;
        }
        node.markvisframe = R.visframecount;
      }
    }
  // eslint-disable-next-line no-constant-condition
  } while (false);
  R.drawsky = false;
  R.RecursiveWorldNode(CL.state.worldmodel.nodes[0]);
};

R.AllocBlock = function(surf) {
  const w = (surf.extents[0] >> surf.lmshift) + 1;
  const h = (surf.extents[1] >> surf.lmshift) + 1;
  let x; let y; let i; let j; let best = 1024; let best2;
  for (i = 0; i < (1024 - w); i++) {
    best2 = 0;
    for (j = 0; j < w; j++) {
      if (R.allocated[i + j] >= best) {
        break;
      }
      if (R.allocated[i + j] > best2) {
        best2 = R.allocated[i + j];
      }
    }
    if (j === w) {
      x = i;
      y = best = best2;
    }
  }
  best += h;
  if (best > 1024) {
    throw new Error('R.AllocBlock: full');
  }
  for (i = 0; i < w; i++) {
    R.allocated[x + i] = best;
  }
  surf.light_s = x;
  surf.light_t = y;
};

// Based on Quake 2 polygon generation algorithm by Toji - http://blog.tojicode.com/2010/06/quake-2-bsp-quite-possibly-worst-format.html
R.BuildSurfaceDisplayList = function(fa) {
  fa.verts = [];
  if (fa.numedges < 3) {
    return;
  }
  const texinfo = R.currentmodel.texinfo[fa.texinfo];
  const texture = R.currentmodel.textures[texinfo.texture];
  for (let i = 0; i < fa.numedges; i++) {
    const index = R.currentmodel.surfedges[fa.firstedge + i];
    let vec;
    if (index > 0) {
      vec = R.currentmodel.vertexes[R.currentmodel.edges[index][0]];
    } else {
      vec = R.currentmodel.vertexes[R.currentmodel.edges[-index][1]];
    }
    const vert = [vec[0], vec[1], vec[2]];
    if (fa.sky !== true) {
      const s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
      const t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
      vert[3] = s / texture.width;
      vert[4] = t / texture.height;
      vert[5] = (s - fa.texturemins[0] + (fa.light_s << fa.lmshift) + (1 << (fa.lmshift - 1))) / (1024 * (1 << fa.lmshift));
      vert[6] = (t - fa.texturemins[1] + (fa.light_t << fa.lmshift) + (1 << (fa.lmshift - 1))) / (1024 * (1 << fa.lmshift));
    }
    if (i >= 3) {
      fa.verts[fa.verts.length] = fa.verts[0];
      fa.verts[fa.verts.length] = fa.verts[fa.verts.length - 2];
    }
    fa.verts[fa.verts.length] = vert;
  }
};

R.BuildLightmaps = function() {
  R.allocated = (new Array(1024)).fill(0);

  for (let i = 1; i < CL.state.model_precache.length; i++) {
    R.currentmodel = CL.state.model_precache[i];
    if (R.currentmodel.type !== Mod.type.brush) {
      continue;
    }
    if (R.currentmodel.name[0] !== '*') {
      for (let j = 0; j < R.currentmodel.faces.length; j++) {
        const surf = R.currentmodel.faces[j];
        if (!surf.sky) {
          R.AllocBlock(surf);
          if (R.currentmodel.lightdata_rgb !== null) {
            R.BuildLightMapEx(surf);
          } else if (R.currentmodel.lightdata !== null) {
            R.BuildLightMap(surf);
          }
        }
        R.BuildSurfaceDisplayList(surf);
      }
    }
    if (i === 1) {
      R.MakeWorldModelDisplayLists(R.currentmodel);
    } else {
      R.MakeBrushModelDisplayLists(R.currentmodel);
    }
  }

  GL.Bind(0, R.lightmap_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 4096, 0, gl.RGBA, gl.UNSIGNED_BYTE, R.lightmaps_rgb);

  GL.Bind(0, R.deluxemap_texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1024, 4096, 0, gl.RGBA, gl.UNSIGNED_BYTE, R.deluxemap);
};

// scan

R.WarpScreen = function() {
  GL.StreamFlush();
  gl.finish();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  const program = GL.UseProgram('warp');
  GL.Bind(program.tTexture, R.warptexture);
  gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));
  const vrect = R.refdef.vrect;
  GL.StreamDrawTexturedQuad(vrect.x, vrect.y, vrect.width, vrect.height, 0.0, 1.0, 1.0, 0.0);
  GL.StreamFlush();
};

// warp

R.MakeSky = function() {
  const sin = Array.from({ length: 9 }, (_, i) =>
    Number(Math.sin(i * Math.PI / 16).toFixed(6)),
  );
  let vecs = []; let i; let j;

  for (i = 0; i < 7; i += 2) {
    vecs = vecs.concat(
        [
          0.0, 0.0, 1.0,
          sin[i + 2] * sin[1], sin[6 - i] * sin[1], sin[7],
          sin[i] * sin[1], sin[8 - i] * sin[1], sin[7],
        ]);
    for (j = 0; j < 7; j++) {
      vecs = vecs.concat(
          [
            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],
            sin[i] * sin[7 - j], sin[8 - i] * sin[7 - j], sin[j + 1],
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],

            sin[i] * sin[8 - j], sin[8 - i] * sin[8 - j], sin[j],
            sin[i + 2] * sin[7 - j], sin[6 - i] * sin[7 - j], sin[j + 1],
            sin[i + 2] * sin[8 - j], sin[6 - i] * sin[8 - j], sin[j],
          ]);
    }
  }

  R.skyvecs = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, R.skyvecs);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vecs), gl.STATIC_DRAW);
};

R.DrawSkyBox = function() {
  if (R.drawsky !== true) {
    return;
  }

  gl.colorMask(false, false, false, false);
  const clmodel = CL.state.worldmodel;
  let program = GL.UseProgram('sky-chain');
  gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, clmodel.skychain);

  for (let i = 0; i < clmodel.leafs.length; i++) {
    const leaf = clmodel.leafs[i];
    if (leaf.visframe !== R.visframecount || leaf.skychain === leaf.waterchain) {
      continue;
    }
    if (R.CullBox(leaf.mins, leaf.maxs)) {
      continue;
    }
    for (let j = leaf.skychain; j < leaf.waterchain; j++) {
      const cmds = leaf.cmds[j];
      gl.drawArrays(gl.TRIANGLES, cmds[0], cmds[1]);
    }
  }
  gl.colorMask(true, true, true, true);

  gl.depthFunc(gl.GREATER);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);

  program = GL.UseProgram('sky');
  gl.uniform2f(program.uTime, (Host.realtime * 0.125) % 1.0, (Host.realtime * 0.03125) % 1.0);
  solidskytexture.bind(program.tSolid);
  alphaskytexture.bind(program.tAlpha);
  gl.bindBuffer(gl.ARRAY_BUFFER, R.skyvecs);
  gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, 0);

  gl.uniform3f(program.uScale, 2.0, -2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, 2.0, -2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, 2.0, 2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, 2.0, 2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, -2.0, -2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, -2.0, -2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.uniform3f(program.uScale, -2.0, 2.0, 1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);
  gl.uniform3f(program.uScale, -2.0, 2.0, -1.0);
  gl.drawArrays(gl.TRIANGLES, 0, 180);

  gl.enable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.depthFunc(gl.LESS);
};

R.InitSky = function(src) {
  const trans = new ArrayBuffer(65536);
  const trans32 = new Uint32Array(trans);

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      trans32[(i << 7) + j] = COM.LittleLong(W.d_8to24table[src[(i << 8) + j + 128]] + 0xff000000);
    }
  }

  solidskytexture.upload(new Uint8Array(trans));

  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 128; j++) {
      const p = (i << 8) + j;
      if (src[p] !== 0) {
        trans32[(i << 7) + j] = COM.LittleLong(W.d_8to24table[src[p]] + 0xff000000);
      } else {
        trans32[(i << 7) + j] = 0;
      }
    }
  }

  alphaskytexture.upload(new Uint8Array(trans));
};
