import Vector from '../../../shared/Vector.mjs';
import { ModelRenderer } from './ModelRenderer.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL from '../GL.mjs';
import { materialFlags } from './Materials.mjs';
import { BrushModel, Node } from '../../common/model/BSP.mjs';
import { ClientEdict } from '../ClientEntities.mjs';
import Mesh from './Mesh.mjs';
import PostProcess from './PostProcess.mjs';

let { CL, Host, R } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, R } = registry);
});

let gl = /** @type {WebGL2RenderingContext} */ (null);

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

// Lightmap atlas configuration
// This defines the width of the dynamic lightmap texture atlas.
// The height is LIGHTMAP_BLOCK_SIZE * 4 because we pack 4 lightstyles in RGBA channels.
// The 3 RGB color channels are stacked vertically (see shader for details).
// Increase this value for larger maps (e.g., 2048 or 4096).
// NOTE: Memory usage scales quadratically (2048 = 4x memory, 4096 = 16x memory).
export const LIGHTMAP_BLOCK_SIZE = 2048;
export const LIGHTMAP_BLOCK_HEIGHT = LIGHTMAP_BLOCK_SIZE * 4; // 4 lightstyles in RGBA

/**
 * Renderer for BSP brush models (maps and inline models like doors, platforms).
 * Handles both static world geometry and dynamic brush entities.
 */
export class BrushModelRenderer extends ModelRenderer {
  /**
   * Get the model type this renderer handles
   * @returns {number} Mod.type.brush (0)
   */
  getModelType() {
    return 0; // Mod.type.brush
  }

  /**
   * Setup rendering state for brush models.
   * Binds shared textures and prepares GL state for brush rendering.
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  // eslint-disable-next-line no-unused-vars
  setupRenderState(_pass = 0) {
    // Brush models bind their own buffers and state per-entity
    // No shared setup needed at this level
  }

  /**
   * Render a single brush model entity.
   * Handles frustum culling, transforms, lighting, and both opaque and turbulent surfaces.
   * @param {BrushModel} model The brush model to render
   * @param {ClientEdict} entity The entity being rendered
   * @param {number} pass Rendering pass (0=opaque, 1=transparent)
   */
  render(model, entity, pass = 0) {
    const clmodel = model;
    const e = entity;

    // Check if this is the world entity (entity 0)
    // World uses leafs structure, entities use chains structure
    if (e === CL.state.clientEntities.getEntity(0)) {
      if (pass === 0) {
        this.renderWorld(clmodel);
      } else if (pass === 1 && R.drawturbolents.value) {
        this.renderWorldTurbolents(clmodel);
      } else if (pass === 2) {
        this.renderWorldTransparent(clmodel);
      }
      return;
    }

    // Regular brush entity rendering (doors, platforms, etc)
    // Frustum culling
    if (clmodel.submodel === true) {
      if (R.CullBox(
        new Vector(
          e.origin[0] + clmodel.mins[0],
          e.origin[1] + clmodel.mins[1],
          e.origin[2] + clmodel.mins[2],
        ),
        new Vector(
          e.origin[0] + clmodel.maxs[0],
          e.origin[1] + clmodel.maxs[1],
          e.origin[2] + clmodel.maxs[2],
        )) === true) {
        return;
      }
    } else {
      if (R.CullBox(
        new Vector(
          e.origin[0] - clmodel.radius,
          e.origin[1] - clmodel.radius,
          e.origin[2] - clmodel.radius,
        ),
        new Vector(
          e.origin[0] + clmodel.radius,
          e.origin[1] + clmodel.radius,
          e.origin[2] + clmodel.radius,
        )) === true) {
        return;
      }
    }

    // Bind vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;
    const viewMatrix = e.lerp.angles.toRotationMatrix();

    // Render opaque surfaces (pass 0), turbulent surfaces (pass 1), or transparent surfaces (pass 2)
    if (pass === 0) {
      this._renderOpaqueSurfaces(clmodel, e, viewMatrix);
    } else if (pass === 1 && R.drawturbolents.value) {
      this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
    } else if (pass === 2) {
      this._renderTransparentSurfaces(clmodel, e, viewMatrix);
    }
  }

  /**
   * Render the world (entity 0) opaque surfaces.
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorld(clmodel) {
    const worldspawn = CL.state.clientEntities.getEntity(0);

    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;

    const program = GL.UseProgram('brush');
    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha, 1.0);

    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, 0);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, R.deluxemap_texture);

    gl.uniform1f(program.uHaveDeluxemap, 1.0);

    // wallhack: GL_BLEND is required
    // gl.enable(gl.BLEND);
    // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Iterate through visible leafs
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];

      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }

      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }

      const lightVector = new Vector(0, 0, 0);
      let lightRadius = 0;

      // naive approach of getting the next best light
      for (const l of CL.state.clientEntities.dlights) {
        if (l.die < CL.state.time || l.radius === 0.0) {
          continue;
        }

        lightVector.set(l.origin);
        lightRadius = l.radius;
      }

      gl.uniform4fv(program.uLightVec, [...lightVector, lightRadius]);

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const material = clmodel.textures[cmds[0]];

        if (material.flags & materialFlags.MF_SKIP) {
          continue;
        }

        // Skip transparent surfaces in opaque pass
        if (material.flags & materialFlags.MF_TRANSPARENT) {
          continue;
        }

        R.c_brush_verts += cmds[2];
        R.c_brush_tris += cmds[2] / 3;

        material.emit(worldspawn);
        material.bindTo(program);

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        R.c_brush_draws++;
      }
    }
  }

  /**
   * Render the world (entity 0) transparent surfaces with alpha blending.
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorldTransparent(clmodel) {
    this.beginWorldTransparentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }
      this.renderWorldTransparentLeaf(clmodel, leaf);
    }
    this.endWorldTransparentPass();
  }

  /**
   * Collect visible world leafs that contain transparent surfaces, with
   * squared distance from the given viewpoint for back-to-front sorting.
   * @param {BrushModel} clmodel The world model
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{leaf: Node, dist: number}[]} Transparent leaf items sorted by distance (farthest first)
   */
  getWorldTransparentLeaves(clmodel, vieworg) {
    const items = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if (leaf.visframe !== R.visframecount || leaf.skychain === 0) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs)) {
        continue;
      }
      // Check if this leaf has any transparent surfaces
      let hasTransparent = false;
      for (let j = 0; j < leaf.skychain; j++) {
        if (clmodel.textures[leaf.cmds[j][0]].flags & materialFlags.MF_TRANSPARENT) {
          hasTransparent = true;
          break;
        }
      }
      if (!hasTransparent) {
        continue;
      }
      const cx = (leaf.mins[0] + leaf.maxs[0]) * 0.5;
      const cy = (leaf.mins[1] + leaf.maxs[1]) * 0.5;
      const cz = (leaf.mins[2] + leaf.maxs[2]) * 0.5;
      const dx = cx - vieworg[0];
      const dy = cy - vieworg[1];
      const dz = cz - vieworg[2];
      const dist = Math.hypot(dx, dy, dz);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Setup GL state for world transparent leaf rendering.
   * Call once before one or more `renderWorldTransparentLeaf` calls.
   * @param {BrushModel} clmodel The world model
   */
  beginWorldTransparentPass(clmodel) {
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;

    /** @type {object} */
    const program = GL.UseProgram('brush');
    this._worldTransparentProgram = program;
    this._worldTransparentModel = clmodel;

    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform1f(program.uHaveDeluxemap, 1.0);

    this._setupBrushVertexAttributes(program, 0);
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, R.deluxemap_texture);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Render a single leaf’s transparent surfaces.
   * Must be called between `beginWorldTransparentPass` and `endWorldTransparentPass`.
   * @param {BrushModel} clmodel The world model
   * @param {Node} leaf The BSP leaf to render
   */
  renderWorldTransparentLeaf(clmodel, leaf) {
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTransparentProgram;

    const lightVector = new Vector(0, 0, 0);
    let lightRadius = 0;
    for (const l of CL.state.clientEntities.dlights) {
      if (l.die < CL.state.time || l.radius === 0.0) {
        continue;
      }
      lightVector.set(l.origin);
      lightRadius = l.radius;
    }
    gl.uniform4fv(program.uLightVec, [...lightVector, lightRadius]);

    for (let j = 0; j < leaf.skychain; j++) {
      const cmds = leaf.cmds[j];
      const material = clmodel.textures[cmds[0]];

      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }
      if (!(material.flags & materialFlags.MF_TRANSPARENT)) {
        continue;
      }

      R.c_brush_verts += cmds[2];
      R.c_brush_tris += cmds[2] / 3;

      material.emit(worldspawn);
      material.bindTo(program);

      gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      R.c_brush_draws++;
    }
  }

  /**
   * Cleanup GL state after world transparent leaf rendering.
   */
  endWorldTransparentPass() {
    gl.disable(gl.BLEND);
    this._worldTransparentProgram = null;
    this._worldTransparentModel = null;
  }

  /**
   * Render the world (entity 0) turbulent surfaces.
   * World uses leafs structure instead of chains.
   * @param {BrushModel} clmodel The world model
   */
  renderWorldTurbolents(clmodel) {
    this.beginWorldTurbulentPass(clmodel);
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }
      this.renderWorldTurbulentLeaf(clmodel, leaf);
    }
    this.endWorldTurbulentPass();
  }

  /**
   * Collect visible world leafs that contain turbulent surfaces, with
   * squared distance from the given viewpoint for back-to-front sorting.
   * @param {BrushModel} clmodel The world model
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{leaf: Node, dist: number}[]} Turbulent leaf items sorted by distance (farthest first)
   */
  getWorldTurbulentLeaves(clmodel, vieworg) {
    const items = [];
    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }
      const cx = (leaf.mins[0] + leaf.maxs[0]) * 0.5;
      const cy = (leaf.mins[1] + leaf.maxs[1]) * 0.5;
      const cz = (leaf.mins[2] + leaf.maxs[2]) * 0.5;
      const dx = cx - vieworg[0];
      const dy = cy - vieworg[1];
      const dz = cz - vieworg[2];
      const dist = Math.hypot(dx, dy, dz);
      items.push({ leaf, dist });
    }
    return items;
  }

  /**
   * Setup GL state for world turbulent leaf rendering.
   * Call once before one or more `renderWorldTurbulentLeaf` calls.
   * @param {BrushModel} clmodel The world model
   */
  beginWorldTurbulentPass(clmodel) {
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;

    gl.enable(gl.BLEND);
    const program = GL.UseProgram('turbulent');
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform1f(program.uTime, Host.realtime);
    gl.uniform1f(program.uAlpha, 1.0);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, clmodel.waterchain);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    this._worldTurbulentProgram = program;
    this._worldTurbulentModel = clmodel;
  }

  /**
   * Render a single leaf's turbulent surfaces.
   * Must be called between `beginWorldTurbulentPass` and `endWorldTurbulentPass`.
   * @param {BrushModel} clmodel The world model
   * @param {Node} leaf The BSP leaf to render
   */
  renderWorldTurbulentLeaf(clmodel, leaf) {
    const worldspawn = CL.state.clientEntities.getEntity(0);
    const program = this._worldTurbulentProgram;

    for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
      const cmds = leaf.cmds[j];
      R.c_brush_verts += cmds[2];
      R.c_brush_tris += cmds[2] / 3;
      clmodel.textures[cmds[0]].emit(worldspawn);
      clmodel.textures[cmds[0]].bindTo(program);
      gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      R.c_brush_draws++;
    }
  }

  /**
   * Cleanup GL state after world turbulent leaf rendering.
   */
  endWorldTurbulentPass() {
    gl.disable(gl.BLEND);
    this._worldTurbulentProgram = null;
    this._worldTurbulentModel = null;
  }

  /**
   * Setup common brush shader uniforms and textures.
   * Configures lightmaps, dynamic lights, light styles, and deluxemaps.
   * @private
   * @param {WebGLProgram} program The shader program (brush or turbulent)
   * @param {BrushModel} clmodel The brush model
   * @param {boolean} isWorld Whether this is the world entity (affects deluxemap/dlight settings)
   */
  _setupBrushShaderCommon(program, clmodel, isWorld) {
    // Bind lightmap textures
    if ((R.fullbright.value !== 0) || (clmodel.lightdata === null && clmodel.lightdata_rgb === null)) {
      GL.Bind(program.tLightmap, R.fullbright_texture);
    } else {
      GL.Bind(program.tLightmap, R.lightmap_texture);
    }

    // Bind dynamic light texture
    if (R.flashblend.value === 0 && (isWorld || clmodel.submodel)) {
      GL.Bind(program.tDlight, R.dlightmap_rgba_texture);
    } else {
      GL.Bind(program.tDlight, R.null_texture);
    }
  }

  /**
   * Setup brush shader vertex attributes.
   * All brush geometry uses 80-byte stride with standard layout.
   * @private
   * @param {WebGLProgram} program The shader program
   * @param {number} [offset] Byte offset for vertex data (0 for opaque, waterchain for turbulent)
   */
  _setupBrushVertexAttributes(program, offset = 0) {
    gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 80, offset);
    gl.vertexAttribPointer(program.aTexCoord.location, 4, gl.FLOAT, false, 80, offset + 12);
    gl.vertexAttribPointer(program.aLightStyle.location, 4, gl.FLOAT, false, 80, offset + 28);

    // Normal, tangent only used for 'brush' shader (not 'turbulent')
    if (program.aNormal) {
      gl.vertexAttribPointer(program.aNormal.location, 3, gl.FLOAT, false, 80, offset + 44);
    }
    if (program.aTangent) {
      gl.vertexAttribPointer(program.aTangent.location, 3, gl.FLOAT, false, 80, offset + 56);
    }
  }

  /**
   * Render opaque (non-turbulent) brush surfaces
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderOpaqueSurfaces(clmodel, e, viewMatrix) {
    const program = GL.UseProgram('brush');

    // Setup lighting
    if (!clmodel.submodel) {
      const [ambientlight, shadelight, lightPosition] = R._CalculateLightValues(e);
      gl.uniform3fv(program.uAmbientLight, ambientlight);
      gl.uniform3fv(program.uShadeLight, shadelight);
      gl.uniform4fv(program.uLightVec, [...lightPosition, 64.0]);
      gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);
    } else {
      gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
      gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
      gl.uniform4f(program.uLightVec, 0.0, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);
    }

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, 0);

    // Setup uniforms
    gl.uniform1f(program.uInterpolation, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    gl.uniform1f(program.uAlpha, 1.0);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, clmodel.submodel ? R.deluxemap_texture : R.normal_up_texture);

    gl.uniform1f(program.uHaveDeluxemap, clmodel.submodel ? 1.0 : 0.0);

    // Render each texture chain
    if (!clmodel.chains || clmodel.chains.length === 0) {
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip turbulent and transparent surfaces in opaque pass
      if ((material.flags & materialFlags.MF_TURBULENT) || (material.flags & materialFlags.MF_TRANSPARENT)) {
        continue;
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;

      material.emit(e);
      material.bindTo(program);

      // Setup dynamic lighting
      const lightVector = new Vector(0, 0, 0);
      let lightRadius = 0;

      for (const l of CL.state.clientEntities.dlights) {
        if (l.die < CL.state.time || l.radius === 0.0) {
          continue;
        }
        lightVector.set(l.origin);
        lightRadius = l.radius;
      }

      gl.uniform4fv(program.uLightVec, [...lightVector, lightRadius]);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }
  }

  /**
   * Render transparent brush surfaces with alpha blending
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderTransparentSurfaces(clmodel, e, viewMatrix) {
    const program = GL.UseProgram('brush');

    // Setup lighting
    if (!clmodel.submodel) {
      const [ambientlight, shadelight, lightPosition] = R._CalculateLightValues(e);
      gl.uniform3fv(program.uAmbientLight, ambientlight);
      gl.uniform3fv(program.uShadeLight, shadelight);
      gl.uniform4fv(program.uLightVec, [...lightPosition, 64.0]);
      gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);
    } else {
      gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
      gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
      gl.uniform4f(program.uLightVec, 0.0, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicShadeLight, 0.0, 0.0, 0.0);
      gl.uniform3f(program.uDynamicLightVec, 0.0, 0.0, 0.0);
    }

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, 0);

    // Setup uniforms
    gl.uniform1f(program.uInterpolation, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);
    gl.uniform1f(program.uAlpha, e.alpha);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, clmodel.submodel ? R.deluxemap_texture : R.normal_up_texture);

    gl.uniform1f(program.uHaveDeluxemap, clmodel.submodel ? 1.0 : 0.0);

    // Enable blending for transparent surfaces (depth writes stay ON so
    // the Z-buffer correctly orders transparent geometry against each other)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Render each texture chain (only transparent ones)
    if (!clmodel.chains || clmodel.chains.length === 0) {
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip requested
      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }

      // Only render transparent surfaces in this pass
      if (e.alpha === 1.0 && (
        (material.flags & materialFlags.MF_TURBULENT) || !(material.flags & materialFlags.MF_TRANSPARENT)
      )) {
        continue;
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;

      material.emit(e);
      material.bindTo(program);

      // Setup dynamic lighting
      const lightVector = new Vector(0, 0, 0);
      let lightRadius = 0;

      for (const l of CL.state.clientEntities.dlights) {
        if (l.die < CL.state.time || l.radius === 0.0) {
          continue;
        }
        lightVector.set(l.origin);
        lightRadius = l.radius;
      }

      gl.uniform4fv(program.uLightVec, [...lightVector, lightRadius]);

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Render turbulent (water, slime, lava, teleport) brush surfaces
   * @private
   * @param {BrushModel} clmodel The brush model
   * @param {ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderTurbulentSurfaces(clmodel, e, viewMatrix) {
    gl.enable(gl.BLEND);

    const program = GL.UseProgram('turbulent');
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);
    gl.uniform1f(program.uAlpha, 1.0);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    // Setup vertex attributes (use waterchain offset from clmodel, not e.model)
    this._setupBrushVertexAttributes(program, clmodel.waterchain);

    // Render each turbulent chain
    if (!clmodel.chains || clmodel.chains.length === 0) {
      gl.disable(gl.BLEND);
      return;
    }

    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const material = clmodel.textures[chain[0]];

      // Skip requested
      if (material.flags & materialFlags.MF_SKIP) {
        continue;
      }

      if (!(material.flags & materialFlags.MF_TURBULENT)) {
        continue; // Skip non-turbulent surfaces in this pass
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;
      // GL.Bind(program.tTexture, texture.texturenum);
      R.notexture.bind(program.tTexture); // TODO: fix turbulent texture binding
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Lazily created unit cube VBO for rendering world-level fog volumes.
   * The cube spans [0,1]^3 and is transformed via uOrigin/uAngles to match each fog volume's AABB.
   * @type {WebGLBuffer|null}
   */
  #fogCubeVBO = null;

  /**
   * Get or create the shared unit cube VBO used for world-level fog volumes.
   * @returns {WebGLBuffer} The unit cube VBO
   */
  _getFogCubeVBO() {
    if (this.#fogCubeVBO) {
      return this.#fogCubeVBO;
    }

    // Unit cube [0,1]^3 — 12 triangles, 36 vertices, CW winding from outside
    // (matching Quake BSP convention: outward faces are CW in world space).
    // The fog shader uses gl.cullFace(gl.BACK) which, with the Quake projection's
    // coordinate mapping, culls near-side faces and renders far-side faces.
    // This gives exit-point fragments for correct fog thickness calculation.
    const verts = new Float32Array([
      // Front face (z=1)
      0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1,
      // Back face (z=0)
      1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
      // Top face (y=1)
      0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1,
      // Bottom face (y=0)
      0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0,
      // Right face (x=1)
      1, 0, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 0,
      // Left face (x=0)
      0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1,
    ]);

    this.#fogCubeVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#fogCubeVBO);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    return this.#fogCubeVBO;
  }

  /**
   * Render all fog volumes defined in the world model.
   * Handles both inline brush model fog volumes (*N) and world-level
   * water/slime/lava fog volumes (modelIndex === 0).
   * @param {BrushModel} worldmodel The world model containing fog volume definitions
   */
  renderFogVolumes(worldmodel) {
    if (!this.beginFogVolumePass(worldmodel)) {
      return;
    }
    for (const fogVolume of worldmodel.fogVolumes) {
      this.renderSingleFogVolume(worldmodel, fogVolume);
    }
    this.endFogVolumePass();
  }

  /**
   * Collect fog volumes with distance from the given viewpoint for back-to-front sorting.
   * @param {BrushModel} worldmodel The world model containing fog volume definitions
   * @param {Float32Array|number[]} vieworg Camera position [x, y, z]
   * @returns {{fogVolume: import('../../common/model/BSP.mjs').FogVolumeInfo, dist: number}[]} Fog volume items with distance
   */
  getFogVolumeItems(worldmodel, vieworg) {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return [];
    }
    if (!PostProcess.hasDepthTexture) {
      return [];
    }
    const items = [];
    for (const fogVolume of worldmodel.fogVolumes) {
      const cx = (fogVolume.mins[0] + fogVolume.maxs[0]) * 0.5;
      const cy = (fogVolume.mins[1] + fogVolume.maxs[1]) * 0.5;
      const cz = (fogVolume.mins[2] + fogVolume.maxs[2]) * 0.5;
      const dx = cx - vieworg[0];
      const dy = cy - vieworg[1];
      const dz = cz - vieworg[2];
      const dist = Math.hypot(dx, dy, dz);
      items.push({ fogVolume, dist });
    }
    return items;
  }

  /**
   * Setup GL state for fog volume rendering.
   * Call once before one or more `renderSingleFogVolume` calls.
   * @param {BrushModel} worldmodel The world model
   * @returns {boolean} True if fog volume pass was started, false if skipped
   */
  beginFogVolumePass(worldmodel) {
    if (!worldmodel.fogVolumes || worldmodel.fogVolumes.length === 0) {
      return false;
    }
    if (!PostProcess.hasDepthTexture) {
      return false;
    }

    // Detach depth texture from FBO so we can sample it
    PostProcess.beginDepthSampling();

    const program = GL.UseProgram('fog-volume');

    // GL state for fog volumes:
    // - Blend: src alpha compositing
    // - No depth test: shader handles depth via texture sampling
    // - No depth writes
    // - Cull back faces (Quake winding): renders the far side of the brush,
    //   giving us exit points for the fog ray. The shader computes entry via AABB.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.cullFace(gl.BACK);
    gl.enable(gl.CULL_FACE);

    // Bind scene depth texture
    GL.Bind(program.tDepth, PostProcess.depthTexture);

    // Pass screen dimensions for depth texture UV calculation
    gl.uniform2f(program.uScreenSize, PostProcess.width, PostProcess.height);

    this._fogVolumeProgram = program;
    return true;
  }

  /**
   * Render a single fog volume.
   * Must be called between `beginFogVolumePass` and `endFogVolumePass`.
   * @param {BrushModel} worldmodel The world model
   * @param {import('../../common/model/BSP.mjs').FogVolumeInfo} fogVolume The fog volume to render
   */
  renderSingleFogVolume(worldmodel, fogVolume) {
    const program = this._fogVolumeProgram;

    // Set fog volume parameters
    gl.uniform3f(
      program.uFogVolumeColor,
      fogVolume.color[0] / 255.0,
      fogVolume.color[1] / 255.0,
      fogVolume.color[2] / 255.0,
    );
    gl.uniform1f(program.uFogVolumeDensity, fogVolume.density);
    gl.uniform1f(program.uFogVolumeMaxOpacity, fogVolume.maxOpacity);

    // Pass the AABB of the fog volume for ray intersection
    gl.uniform3f(program.uFogVolumeMins, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);
    gl.uniform3f(program.uFogVolumeMaxs, fogVolume.maxs[0], fogVolume.maxs[1], fogVolume.maxs[2]);

    if (fogVolume.modelIndex === 0) {
      // World-level fog volume: use a unit cube transformed to match the AABB
      const sizeX = fogVolume.maxs[0] - fogVolume.mins[0];
      const sizeY = fogVolume.maxs[1] - fogVolume.mins[1];
      const sizeZ = fogVolume.maxs[2] - fogVolume.mins[2];

      // uAngles becomes a scale matrix (diagonal = AABB size)
      gl.uniformMatrix3fv(program.uAngles, false, new Float32Array([
        sizeX, 0, 0,
        0, sizeY, 0,
        0, 0, sizeZ,
      ]));
      gl.uniform3f(program.uOrigin, fogVolume.mins[0], fogVolume.mins[1], fogVolume.mins[2]);

      const cubeVBO = this._getFogCubeVBO();
      gl.bindBuffer(gl.ARRAY_BUFFER, cubeVBO);
      R.c_brush_vbos++;

      // Unit cube uses compact 12-byte stride (3 floats, position only)
      gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 12, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 36);
      R.c_brush_draws++;
    } else {
      // Submodel fog volume: use the submodel's own VBO
      const submodel = worldmodel.submodels[fogVolume.modelIndex - 1];

      if (!submodel || !submodel.cmds) {
        return;
      }

      gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
      gl.uniformMatrix3fv(program.uAngles, false, GL.identity);

      gl.bindBuffer(gl.ARRAY_BUFFER, submodel.cmds);
      R.c_brush_vbos++;
      gl.vertexAttribPointer(program.aPosition.location, 3, gl.FLOAT, false, 80, 0);

      if (submodel.chains) {
        for (const chain of submodel.chains) {
          gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
          R.c_brush_draws++;
        }
      }
    }
  }

  /**
   * Cleanup GL state after fog volume rendering.
   */
  endFogVolumePass() {
    // Restore GL state for subsequent passes (turbulents, particles, etc.).
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.cullFace(gl.FRONT);
    gl.enable(gl.CULL_FACE);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE);
    gl.disable(gl.BLEND);

    // Reattach depth texture to FBO
    PostProcess.endDepthSampling();
    this._fogVolumeProgram = null;
  }

  // eslint-disable-next-line no-unused-vars
  cleanupRenderState(_pass = 0) {
    // Brush models clean up their own state per-entity
    // No shared cleanup needed at this level
  }

  /**
   * Prepare brush model for rendering (build display lists, upload to GPU).
   * Handles both world models (using leafs) and entity models (using chains).
   * @param {BrushModel} model The brush model to prepare
   * @param {boolean} [isWorldModel] True if this is the actual world map (model index 1)
   */
  prepareModel(model, isWorldModel = false) {
    const m = model;

    // Clean up existing buffer if present
    if (m.cmds && typeof m.cmds === 'object' && m.cmds !== null) {
      gl.deleteBuffer(m.cmds);
      m.cmds = null;
    }

    if (model.name[0] !== '*') {
      for (const face of model.faces) {
        this._buildSurfaceDisplayList(model, face);
      }
    }

    if (isWorldModel) {
      this._buildWorldModelDisplayLists(m);
    } else {
      this._buildBrushModelDisplayLists(m);
    }
  }

  /**
   * Build display lists for regular brush entities (doors, platforms, etc).
   * Uses chains structure to group surfaces by texture.
   * @private
   * @param {BrushModel} m The brush model
   */
  _buildBrushModelDisplayLists(m) {
    const cmds = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    let verts = 0;
    let cutoff = 0;
    m.chains = [];

    // Build opaque surfaces (non-sky, non-turbulent)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if (texture.flags & materialFlags.MF_SKY || texture.flags & materialFlags.MF_TURBULENT) {
        continue;
      }
      const chain = [i, verts, 0];
      for (const surf of m.facesIter()) {
        if (surf.texture !== i) {
          continue;
        }
        if (!surf.verts || surf.verts.length === 0) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (let k = 0; k < surf.verts.length; k++) {
          const vert = surf.verts[k];
          // Position (12 bytes)
          cmds.push(vert[0], vert[1], vert[2]);
          // TexCoord (16 bytes)
          cmds.push(vert[3], vert[4], vert[5], vert[6]);
          // LightStyle (16 bytes)
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
          cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
          cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        }
      }
      if (chain[2] !== 0) {
        m.chains.push(chain);
        verts += chain[2];
      }
    }
    cutoff = cmds.length;
    m.waterchain = verts * 80;
    verts = 0;

    // Build turbulent surfaces (water, lava, slime)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_TURBULENT)) {
        continue;
      }
      const chain = [i, verts, 0];
      for (const surf of m.facesIter()) {
        if (surf.texture !== i) {
          continue;
        }
        if (!surf.verts || surf.verts.length === 0) {
          continue;
        }
        styles[0] = styles[1] = styles[2] = styles[3] = 0.0;
        for (let l = 0; l < surf.styles.length; l++) {
          styles[l] = surf.styles[l] * 0.015625 + 0.0078125;
        }
        chain[2] += surf.verts.length;
        for (let k = 0; k < surf.verts.length; k++) {
          const vert = surf.verts[k];
          // Position (12 bytes)
          cmds.push(vert[0], vert[1], vert[2]);
          // TexCoord (16 bytes)
          cmds.push(vert[3], vert[4], vert[5], vert[6]);
          // LightStyle (16 bytes)
          cmds.push(styles[0], styles[1], styles[2], styles[3]);
          // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
          cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
          cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        }
      }
      if (chain[2] !== 0) {
        m.chains.push(chain);
        verts += chain[2];
      }
    }

    // Calculate tangents and bitangents for PBR normal mapping
    Mesh.CalculateTangentBitangents(cmds, cutoff);

    // Upload to GPU
    m.cmds = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
  }

  /**
   * Build display lists for the world model.
   * Uses leafs structure for visibility-based rendering.
   * @private
   * @param {BrushModel} m The world model
   */
  _buildWorldModelDisplayLists(m) {
    if (m.cmds !== null) {
      return; // Already built
    }

    const cmds = [];
    const styles = [0.0, 0.0, 0.0, 0.0];
    let verts = 0;
    let cutoff = 0;

    // Build opaque surfaces (non-sky, non-turbulent) organized by leaf
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if ((texture.flags & materialFlags.MF_SKY) || (texture.flags & materialFlags.MF_TURBULENT)) {
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
            // Position (12 bytes)
            cmds.push(vert[0], vert[1], vert[2]);
            // TexCoord (16 bytes)
            cmds.push(vert[3], vert[4], vert[5], vert[6]);
            // LightStyle (16 bytes)
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
            cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
            cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
          }
        }
        if (chain[2] !== 0) {
          leaf.cmds.push(chain);
          leaf.skychain++;
          leaf.waterchain++;
          verts += chain[2];
        }
      }
    }
    cutoff = cmds.length;
    m.skychain = verts * 80;
    verts = 0;

    // Build sky surfaces
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_SKY)) {
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
            cmds.push(vert[0], vert[1], vert[2]);
          }
        }
        if (chain[1] !== 0) {
          leaf.cmds.push(chain);
          leaf.waterchain++;
          verts += chain[1];
        }
      }
    }
    m.waterchain = m.skychain + verts * 12;
    verts = 0;

    // Build turbulent surfaces (water, lava, slime)
    for (let i = 0; i < m.textures.length; i++) {
      const texture = m.textures[i];
      if (!(texture.flags & materialFlags.MF_TURBULENT)) {
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
            // Position (12 bytes)
            cmds.push(vert[0], vert[1], vert[2]);
            // TexCoord (16 bytes)
            cmds.push(vert[3], vert[4], vert[5], vert[6]);
            // LightStyle (16 bytes)
            cmds.push(styles[0], styles[1], styles[2], styles[3]);
            // Normal (12 bytes) + Tangent/Bitangent placeholders (24 bytes)
            cmds.push(surf.normal[0], surf.normal[1], surf.normal[2]);
            cmds.push(0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
          }
        }
        if (chain[2] !== 0) {
          leaf.cmds.push(chain);
          verts += chain[2];
        }
      }
    }

    // Calculate tangents and bitangents for PBR normal mapping
    Mesh.CalculateTangentBitangents(cmds, cutoff);

    // Upload to GPU
    m.cmds = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, m.cmds);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cmds), gl.STATIC_DRAW);
  }

  _buildSurfaceDisplayList(model, face) {
    face.verts = [];
    if (face.numedges < 3) {
      return;
    }
    const texinfo = model.texinfo[face.texinfo];
    const texture = model.textures[texinfo.texture];
    for (let i = 0; i < face.numedges; i++) {
      const index = model.surfedges[face.firstedge + i];
      let vec;
      if (index > 0) {
        vec = model.vertexes[model.edges[index][0]];
      } else {
        vec = model.vertexes[model.edges[-index][1]];
      }
      const vert = [vec[0], vec[1], vec[2]];
      if (face.sky !== true) {
        const s = vec.dot(new Vector(...texinfo.vecs[0])) + texinfo.vecs[0][3];
        const t = vec.dot(new Vector(...texinfo.vecs[1])) + texinfo.vecs[1][3];
        vert[3] = s / texture.width;
        vert[4] = t / texture.height;
        vert[5] = (s - face.texturemins[0] + (face.light_s << face.lmshift) + (1 << (face.lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << face.lmshift));
        vert[6] = (t - face.texturemins[1] + (face.light_t << face.lmshift) + (1 << (face.lmshift - 1))) / (LIGHTMAP_BLOCK_SIZE * (1 << face.lmshift));
      }
      if (i >= 3) {
        face.verts[face.verts.length] = face.verts[0];
        face.verts[face.verts.length] = face.verts[face.verts.length - 2];
      }
      face.verts[face.verts.length] = vert;
    }
  }

  /**
   * Free GPU resources for this brush model.
   * Uses global `gl` from registry.
   * @param {BrushModel} model The brush model to cleanup
   */
  cleanupModel(model) {
    if (model.cmds) {
      gl.deleteBuffer(model.cmds);
      model.cmds = null;
    }
  }
}
