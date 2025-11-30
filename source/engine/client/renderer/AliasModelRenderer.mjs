import Vector from '../../../shared/Vector.mjs';
import { ModelRenderer } from './ModelRenderer.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL from '../GL.mjs';
import W from '../../common/W.mjs';

let { CL, Host, R, Con } = registry;
let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, R, Con } = registry);
});

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/**
 * Renderer for Alias MDL models (animated mesh models like monsters, weapons, items).
 * Handles frame interpolation, skinning, and player color translation.
 */
export class AliasModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles
   * @returns {number} Mod.type.alias (2)
   */
  getModelType() {
    return 2; // Mod.type.alias
  }

  /**
   * Setup rendering state for alias models.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  setupRenderState(_pass = 0) {
    // Alias models setup their own state per-entity (different shaders for players)
    // No shared setup needed at this level
  }

  /**
   * Render a single alias model entity.
   * Handles frustum culling, frame interpolation, skinning, and player color translation.
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} model The alias model to render
   * @param {import('../ClientEntities.mjs').ClientEdict} entity The entity being rendered
   * @param {number} _pass Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  render(model, entity, _pass = 0) {
    const clmodel = model;
    const e = entity;

    // Frustum culling
    if (R.CullBox(
      new Vector(
        e.origin[0] - clmodel.boundingradius,
        e.origin[1] - clmodel.boundingradius,
        e.origin[2] - clmodel.boundingradius,
      ),
      new Vector(
        e.origin[0] + clmodel.boundingradius,
        e.origin[1] + clmodel.boundingradius,
        e.origin[2] + clmodel.boundingradius,
      )) === true) {
      return;
    }

    // Select shader program (player vs normal)
    let program;
    if ((e.colormap !== 0) && (clmodel.player === true) && (R.nocolors.value === 0)) {
      program = GL.UseProgram('player');

      // Calculate player colors
      let top = (CL.state.scores[e.colormap - 1].colors & 0xf0) + 4;
      let bottom = ((CL.state.scores[e.colormap - 1].colors & 0xf) << 4) + 4;
      if (top <= 127) {
        top += 7;
      }
      if (bottom <= 127) {
        bottom += 7;
      }
      top = W.d_8to24table[top];
      bottom = W.d_8to24table[bottom];

      // Set player color uniforms
      gl.uniform3f(program.uTop, top & 0xff, (top >> 8) & 0xff, top >> 16);
      gl.uniform3f(program.uBottom, bottom & 0xff, (bottom >> 8) & 0xff, bottom >> 16);
    } else {
      program = GL.UseProgram('alias');
    }

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, e.lerp.angles.toRotationMatrix());

    // Setup lighting
    const [ambientlight, shadelight, lightVector] = R._CalculateLightValues(e);
    gl.uniform3fv(program.uAmbientLight, ambientlight);
    gl.uniform3fv(program.uShadeLight, shadelight);
    gl.uniform3fv(program.uLightVec, lightVector);

    // Update performance counter
    R.c_alias_polys += clmodel._num_tris;

    // Select animation frames
    const { frameA, frameB, targettime } = this._selectFrames(clmodel, e);

    // Setup interpolation
    gl.uniform1f(program.uAlpha, R.interpolation.value ? Math.min(1, Math.max(0, targettime)) : 0);
    gl.uniform1f(program.uTime, Host.realtime);

    // Bind vertex buffer and setup attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    gl.vertexAttribPointer(program.aPositionA.location, 3, gl.FLOAT, false, 24, frameA.cmdofs);
    gl.vertexAttribPointer(program.aPositionB.location, 3, gl.FLOAT, false, 24, frameB.cmdofs);
    gl.vertexAttribPointer(program.aNormal.location, 3, gl.FLOAT, false, 24, frameA.cmdofs + 12);
    gl.vertexAttribPointer(program.aTexCoord.location, 2, gl.FLOAT, false, 0, 0);

    // Select and bind skin texture
    const skin = this._selectSkin(clmodel, e);
    skin.texturenum.bind(program.tTexture);
    if (clmodel.player === true) {
      skin.playertexture.bind(program.tPlayer);
    }

    // Draw the model
    gl.drawArrays(gl.TRIANGLES, 0, clmodel._num_tris * 3);
  }

  /**
   * Select animation frames for rendering with interpolation
   * @private
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} clmodel The alias model
   * @param {import('../ClientEntities.mjs').ClientEdict} e The entity
   * @returns {{frameA: object, frameB: object, targettime: number}} Selected frames and interpolation factor
   */
  _selectFrames(clmodel, e) {
    const time = CL.state.time + e.syncbase;
    let num = e.frame;

    // Validate frame number
    if ((num >= clmodel.frames.length) || (num < 0)) {
      Con.DPrint('AliasModelRenderer: no such frame ' + num + '\n');
      num = 0;
    }

    let frame = clmodel.frames[num];
    let frameA = frame;
    let frameB = frame;
    let targettime = 0;

    // Handle frame groups (animated sequences)
    if (frame.group === true) {
      num = frame.frames.length - 1;
      const fullinterval = frame.frames[num].interval;
      frameA = frame.frames[0];
      frameB = frame.frames[1 % frame.frames.length];
      targettime = time - Math.floor(time / fullinterval) * fullinterval;

      for (let i = 0; i < num; i++) {
        if (frame.frames[i].interval > targettime) {
          frameA = frame.frames[i];
          frameB = frame.frames[(i + 1) % frame.frames.length];
          break;
        }
      }
    } else if (R.interpolation.value) {
      // Handle lerp-based interpolation
      const [previousFrame, nextFrame, f] = e.lerp.frame;
      frameA = clmodel.frames[previousFrame];
      frameB = clmodel.frames[nextFrame];
      targettime = f;
    }

    return { frameA, frameB, targettime };
  }

  /**
   * Select skin texture for rendering (handles skin groups and animation)
   * @private
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} clmodel The alias model
   * @param {import('../ClientEntities.mjs').ClientEdict} e The entity
   * @returns {object} Selected skin texture
   */
  _selectSkin(clmodel, e) {
    const time = CL.state.time + e.syncbase;
    let num = e.skinnum;

    // Validate skin number
    if ((num >= clmodel.skins.length) || (num < 0)) {
      Con.DPrint('AliasModelRenderer: no such skin # ' + num + '\n');
      num = 0;
    }

    let skin = clmodel.skins[num];

    // Handle skin groups (animated textures)
    if (skin.group === true) {
      num = skin.skins.length - 1;
      const fullinterval = skin.skins[num].interval;
      const targettime = time - Math.floor(time / fullinterval) * fullinterval;

      let i = 0;
      for (i = 0; i < num; i++) {
        if (skin.skins[i].interval > targettime) {
          break;
        }
      }
      skin = skin.skins[i];
    }

    return skin;
  }

  /**
   * Cleanup rendering state after alias models
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    // Alias models clean up their own state per-entity
    // No shared cleanup needed at this level
  }

  /**
   * Prepare alias model for rendering (build vertex buffers from triangle data).
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} model The alias model to prepare
   * @param {boolean} isWorldModel Whether this model is the world model
   */
  // eslint-disable-next-line no-unused-vars
  prepareModel(model, isWorldModel = false) {
    // This will be implemented in a later task
    // For now, vertex buffer building is still done in Mod.mjs
    Con.DPrint(`AliasModelRenderer.prepareModel: TODO - implement for ${model.name}\n`);
  }

  /**
   * Free GPU resources for this alias model.
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} model The alias model to cleanup
   */
  cleanupModel(model) {
    if (model.cmds) {
      gl.deleteBuffer(model.cmds);
      model.cmds = null;
    }
  }
}
