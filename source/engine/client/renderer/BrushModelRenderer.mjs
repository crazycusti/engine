import Vector from '../../../shared/Vector.mjs';
import { ModelRenderer } from './ModelRenderer.mjs';
import { eventBus, registry } from '../../registry.mjs';
import GL from '../GL.mjs';

let { CL, Host, Mod, R } = registry;
let gl = null;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, Host, Mod, R } = registry);
});

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

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
  setupRenderState(_pass = 0) {
    // Brush models bind their own buffers and state per-entity
    // No shared setup needed at this level
  }

  /**
   * Render a single brush model entity.
   * Handles frustum culling, transforms, lighting, and both opaque and turbulent surfaces.
   * @param {import('../../common/model/BSP.mjs').BrushModel} model The brush model to render
   * @param {import('../ClientEntities.mjs').ClientEdict} entity The entity being rendered
   * @param {number} [pass] Rendering pass (0=opaque, 1=transparent)
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

    // Render opaque surfaces (pass 0) or turbulent surfaces (pass 1)
    if (pass === 0) {
      this._renderOpaqueSurfaces(clmodel, e, viewMatrix);
    } else if (pass === 1 && R.drawturbolents.value) {
      this._renderTurbulentSurfaces(clmodel, e, viewMatrix);
    }
  }

  /**
   * Render the world (entity 0) opaque surfaces.
   * World uses leafs structure instead of chains.
   * @param {import('../../common/model/BSP.mjs').BrushModel} clmodel The world model
   */
  renderWorld(clmodel) {
    R.currententity = CL.state.clientEntities.getEntity(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;

    const program = GL.UseProgram('brush');
    gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
    gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);

    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, 0);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, R.deluxemap_texture);

    gl.uniform1f(program.uHaveDeluxemap, 1.0);

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
        R.c_brush_verts += cmds[2];
        R.c_brush_tris += cmds[2] / 3;
        const [textureA, textureB] = R.TextureAnimation(clmodel.textures[cmds[0]]);
        gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);

        if (textureA.glt) {
          textureA.glt.bind(program.tTextureA);
        } else {
          R.notexture.bind(program.tTextureA);
        }

        if (textureB.glt) {
          textureB.glt.bind(program.tTextureB);
        } else {
          R.notexture.bind(program.tTextureB);
        }
        R.c_brush_texture_binds += 2;  // TextureA + TextureB

        // LOD: Disable expensive normal mapping for large triangles (fillrate optimization)
        // -1 = no limit (always use PBR), 0 = PBR off, >0 = disable when tris > threshold
        const threshold = R.pbr_lod_threshold.value;
        const screenCoverageEstimate = cmds[2] / 3; // Rough proxy
        const usePBR = threshold === 0 ? false :
                       (threshold < 0 ? true : screenCoverageEstimate <= threshold);

        gl.uniform1i(program.uPerformDotLighting,
          (clmodel.textures[cmds[0]].normal && usePBR) ? 1 : 0);

        // Bind PBR textures
        this._bindPBRTextures(program, clmodel.textures[cmds[0]]);
        R.c_brush_texture_binds += 3;  // Luminance + Normal + Specular

        // Track if this is a PBR material
        const texture = clmodel.textures[cmds[0]];
        if (texture.normal || texture.specular || texture.luminance) {
          R.c_brush_draws_pbr++;
        }

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        R.c_brush_draws++;
      }
    }
  }

  /**
   * Render the world (entity 0) turbulent surfaces.
   * World uses leafs structure instead of chains.
   * @param {import('../../common/model/BSP.mjs').BrushModel} clmodel The world model
   */
  renderWorldTurbolents(clmodel) {
    R.currententity = CL.state.clientEntities.getEntity(0);
    gl.bindBuffer(gl.ARRAY_BUFFER, clmodel.cmds);
    R.c_brush_vbos++;

    gl.enable(gl.BLEND);
    const program = GL.UseProgram('turbulent');
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, clmodel.waterchain);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, true);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    for (let i = 0; i < clmodel.leafs.length; i++) {
      const leaf = clmodel.leafs[i];
      if ((leaf.visframe !== R.visframecount) || (leaf.waterchain === leaf.cmds.length)) {
        continue;
      }
      if (R.CullBox(leaf.mins, leaf.maxs) === true) {
        continue;
      }
      for (let j = leaf.waterchain; j < leaf.cmds.length; j++) {
        const cmds = leaf.cmds[j];
        R.c_brush_verts += cmds[2];
        R.c_brush_tris += cmds[2] / 3;
        clmodel.textures[cmds[0]].glt.bind(program.tTexture);
        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        R.c_brush_draws++;
      }
    }
    gl.disable(gl.BLEND);
  }

  /**
   * Setup common brush shader uniforms and textures.
   * Configures lightmaps, dynamic lights, light styles, and deluxemaps.
   * @private
   * @param {WebGLProgram} program The shader program (brush or turbulent)
   * @param {import('../../common/model/BSP.mjs').BrushModel} clmodel The brush model
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
   * Bind PBR texture maps (luminance, normal, specular) for a brush texture.
   * @private
   * @param {WebGLProgram} program The shader program
   * @param {BrushModelTexture} texture The brush texture with optional PBR maps
   */
  _bindPBRTextures(program, texture) {
    for (const [slot, samplerId] of Object.entries({
      luminance: 'tLuminance',
      normal: 'tNormal',
      specular: 'tSpecular',
    })) {
      const t = texture[slot];
      if (t !== null) {
        t.bind(program[samplerId]);
      } else {
        GL.Bind(program[samplerId], R.null_texture);
      }
    }
  }

  /**
   * Render opaque (non-turbulent) brush surfaces
   * @private
   * @param {import('../../common/model/BSP.mjs').BrushModel} clmodel The brush model
   * @param {import('../ClientEntities.mjs').ClientEdict} e The entity
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
    } else {
      gl.uniform3f(program.uAmbientLight, 1.0, 1.0, 1.0);
      gl.uniform3f(program.uShadeLight, 0.0, 0.0, 0.0);
      gl.uniform4f(program.uLightVec, 0.0, 0.0, 0.0, 0.0);
    }

    // Setup transforms
    gl.uniform3fv(program.uOrigin, e.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, 0);

    // Setup uniforms
    gl.uniform1f(program.uAlpha, R.interpolation.value ? (CL.state.time % 0.2) / 0.2 : 0);

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyleA, R.lightstyle_texture_a);
    GL.Bind(program.tLightStyleB, R.lightstyle_texture_b);
    GL.Bind(program.tDeluxemap, clmodel.submodel ? R.deluxemap_texture : R.normal_up_texture);

    gl.uniform1f(program.uHaveDeluxemap, clmodel.submodel ? 1.0 : 0.0);

    // Render each texture chain
    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const [textureA, textureB] = R.TextureAnimation(clmodel.textures[chain[0]]);

      if (textureA.turbulent === true) {
        continue; // Skip turbulent surfaces in this pass
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;
      textureA.glt.bind(program.tTextureA);
      textureB.glt.bind(program.tTextureB);
      R.c_brush_texture_binds += 2;  // TextureA + TextureB

      // LOD: Disable expensive normal mapping for large triangles (fillrate optimization)
      // On weak GPUs, large screen-space triangles with normal maps kill fillrate
      // -1 = no limit (always use PBR), 0 = PBR off, >0 = disable when tris > threshold
      const threshold = R.pbr_lod_threshold.value;
      const screenCoverageEstimate = chain[2] / 3; // Rough proxy for screen coverage
      const usePBR = threshold === 0 ? false :
                     (threshold < 0 ? true : screenCoverageEstimate <= threshold);

      gl.uniform1i(program.uPerformDotLighting,
        (clmodel.textures[chain[0]].normal && usePBR) ? 1 : 0);

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

      // Bind PBR textures
      this._bindPBRTextures(program, clmodel.textures[chain[0]]);
      R.c_brush_texture_binds += 3;  // Luminance + Normal + Specular

      // Track if this is a PBR material (has normal/specular/luminance maps)
      const texture = clmodel.textures[chain[0]];
      if (texture.normal || texture.specular || texture.luminance) {
        R.c_brush_draws_pbr++;
      }

      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }
  }

  /**
   * Render turbulent (water, slime, lava, teleport) brush surfaces
   * @private
   * @param {import('../../common/model/BSP.mjs').BrushModel} clmodel The brush model
   * @param {import('../ClientEntities.mjs').ClientEdict} e The entity
   * @param {number[]} viewMatrix Rotation matrix for entity orientation
   */
  _renderTurbulentSurfaces(clmodel, e, viewMatrix) {
    gl.enable(gl.BLEND);

    const program = GL.UseProgram('turbulent');
    gl.uniform3f(program.uOrigin, 0.0, 0.0, 0.0);
    gl.uniformMatrix3fv(program.uAngles, false, viewMatrix);
    gl.uniform1f(program.uTime, Host.realtime % (Math.PI * 2.0));

    // Bind common textures
    this._setupBrushShaderCommon(program, clmodel, false);
    GL.Bind(program.tLightStyle, R.lightstyle_texture_a);

    // Setup vertex attributes
    this._setupBrushVertexAttributes(program, e.model.waterchain);

    // Render each turbulent chain
    for (let i = 0; i < clmodel.chains.length; i++) {
      const chain = clmodel.chains[i];
      const texture = clmodel.textures[chain[0]];

      if (!texture.turbulent) {
        continue; // Skip non-turbulent surfaces in this pass
      }

      R.c_brush_verts += chain[2];
      R.c_brush_tris += chain[2] / 3;
      GL.Bind(program.tTexture, texture.texturenum);
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
      R.c_brush_draws++;
    }

    gl.disable(gl.BLEND);
  }

  /**
   * Cleanup rendering state after brush models
   * @param {number} [_pass] Rendering pass (0=opaque, 1=transparent)
   */
  cleanupRenderState(_pass = 0) {
    // Brush models clean up their own state per-entity
    // No shared cleanup needed at this level
  }

  /**
   * Prepare brush model for rendering (build display lists, upload to GPU).
   * This is called from Mod.mjs after loading BSP data.
   * Uses global `gl` from registry.
   * @param {import('../../common/model/BSP.mjs').BrushModel} model The brush model to prepare
   */
  prepareModel(model) {
    // This will be implemented in a later task
    // For now, R.MakeBrushModelDisplayLists is still called from Mod.mjs
    if (registry.Con) {
      registry.Con.DPrint(`BrushModelRenderer.prepareModel: TODO - implement for ${model.name}\n`);
    }
  }

  /**
   * Free GPU resources for this brush model.
   * Uses global `gl` from registry.
   * @param {import('../../common/model/BSP.mjs').BrushModel} model The brush model to cleanup
   */
  cleanupModel(model) {
    if (model.cmds) {
      gl.deleteBuffer(model.cmds);
      model.cmds = null;
    }
  }
}
