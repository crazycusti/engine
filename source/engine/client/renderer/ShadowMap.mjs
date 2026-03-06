import GL from '../GL.mjs';
import Cvar from '../../common/Cvar.mjs';
import { limits } from '../../common/Def.mjs';
import { eventBus, registry } from '../../registry.mjs';
import { materialFlags } from './Materials.mjs';
import { effect } from '../../../shared/Defs.mjs';
import Vector from '../../../shared/Vector.mjs';

let { CL, COM, Mod, R, SV } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ CL, COM, Mod, R, SV } = registry);
});

/** @type {WebGL2RenderingContext} */
let gl = null;

eventBus.subscribe('gl.ready', () => {
  gl = GL.gl;
});

eventBus.subscribe('gl.shutdown', () => {
  gl = null;
});

/** Shadow map resolution (px). Local coverage keeps this sharp at 1024. */
const SHADOW_SIZE = 2048;

/** Point light cube shadow map resolution (px per face). */
const POINT_SHADOW_SIZE = 256;

/** Near plane for point light perspective projection. */
const POINT_NEAR = 1.0;

/**
 * The 6 cube face directions and their up vectors.
 * Order matches GL_TEXTURE_CUBE_MAP_POSITIVE_X .. NEGATIVE_Z.
 * Each entry: [targetX, targetY, targetZ, upX, upY, upZ]
 */
const CUBE_FACES = [
  [ 1,  0,  0,   0, -1,  0], // +X
  [-1,  0,  0,   0, -1,  0], // -X
  [ 0,  1,  0,   0,  0,  1], // +Y
  [ 0, -1,  0,   0,  0, -1], // -Y
  [ 0,  0,  1,   0, -1,  0], // +Z
  [ 0,  0, -1,   0, -1,  0], // -Z
];

/**
 * Directional shadow mapping for a single "sun" light.
 *
 * Renders the world BSP into a depth-only FBO from the light's perspective,
 * then the scene shaders sample this depth texture (via `sampler2DShadow`)
 * to darken fragments that are occluded. The result is a coarse, soft shadow
 * that integrates naturally with the baked lightmaps.
 */
export default class ShadowMap {
  // ─── FBO & textures ──────────────────────────────────────────────

  /** @type {WebGLFramebuffer} Depth-only framebuffer for the shadow pass */
  static fbo = null;

  /** @type {WebGLTexture} Depth texture with hardware comparison (sampler2DShadow) */
  static depthTexture = null;

  /** @type {WebGLTexture} 1×1 always-lit dummy texture used when shadows are off */
  static dummyTexture = null;

  // ─── Matrices ────────────────────────────────────────────────────

  /** @type {Float64Array} Column-major 4×4 light-space view-projection matrix */
  static lightSpaceMatrix = new Float64Array(16);

  // ─── Cvars ───────────────────────────────────────────────────────

  /** @type {Cvar} Master toggle (0 = off, 1 = on) */
  static enabled = null;

  /** @type {Cvar} Orthographic half-size in world units — kept small for a local blob-style shadow */
  static range = null;

  /** @type {Cvar} Minimum brightness in shadow (0 = pitch black, 1 = no shadow) */
  static darkness = null;

  /** @type {Cvar} Fallback shadow yaw when no nearby light is found (degrees, 0 = +X, 90 = +Y) */
  static sunYaw = null;

  /** @type {Cvar} Fallback shadow pitch when no nearby light is found (degrees, negative = downward) */
  static sunPitch = null;

  /** @type {Cvar} Wall-block depth threshold in world units (entity shadows behind a world surface thicker than this are suppressed) */
  static maxDist = null;

  // ─── Local light direction ────────────────────────────────────────

  /**
   * Normalised direction vector the shadow light travels (light → scene).
   * Derived each frame from the closest visible light entity parsed from
   * the BSP entity lump.  Falls back to the configured fallback angles
   * when no visible light entity is found.
   * @type {Float32Array}
   */
  static localLightDir = new Float32Array([0, 0, -1]);

  /**
   * Shadow intensity multiplier passed to the fragment shader as `uShadowEnabled`.
   * Always 1.0 when using static BSP light data; edge fade in the shader
   * handles the coverage boundary.
   * @type {number}
   */
  static localLightFalloff = 1.0;

  // ─── Static light entity cache ────────────────────────────────────

  /**
   * Parsed light entities from the BSP entity lump.
   * Each entry holds a position and radius (derived from the entity's
   * `light` key, defaulting to 300).  Populated once per map load by
   * `parseLightEntities()` and reused every frame.
   * @type {Array<{origin: Float32Array, radius: number}>}
   */
  static lightEntities = [];

  /**
   * Reference to the worldmodel whose entities were last parsed.
   * Used to detect map changes and re-parse lazily.
   * @type {import('../../common/model/BSP.mjs').BrushModel|null}
   */
  static _parsedWorldmodel = null;

  /** @type {number} Maximum number of light entities to test per frame (performance cap) */
  static _MAX_LIGHT_TRACES = 8;

  /** @type {Float32Array} Scratch buffer for shadow caster centroid computation */
  static _centroidScratch = new Float32Array(3);

  // ─── Point light shadow ──────────────────────────────────────────

  /** @type {WebGLFramebuffer} Depth-only FBO for point light shadow (reused for all 6 faces) */
  static pointFBO = null;

  /** @type {WebGLTexture} Depth cubemap with hardware comparison (samplerCubeShadow) */
  static pointDepthCube = null;

  /** @type {WebGLTexture} 1×1 always-lit dummy cubemap used when point shadows are off */
  static pointDummyCube = null;

  /** @type {Float32Array} Column-major 4×4 per-face view-projection matrix */
  static pointFaceMatrix = new Float32Array(16);

  /** @type {Float32Array} Active point light position [x, y, z] for this frame */
  static pointLightOrigin = new Float32Array(3);

  // ─── World occluder depth map ────────────────────────────────

  /** @type {WebGLFramebuffer} Depth-only FBO for the world occluder pass */
  static worldFBO = null;

  /** @type {WebGLTexture} Depth texture (sampler2D, no comparison) storing closest world surface depth from the light */
  static worldDepthTexture = null;

  /** @type {WebGLTexture} 1×1 dummy texture (depth = 1.0) used when shadows are off */
  static worldDummyTexture = null;

  /** @type {number} Active point light radius for this frame */
  static pointLightRadius = 0;

  /** @type {boolean} Whether a point light shadow was rendered this frame */
  static pointLightActive = false;

  /** @type {Cvar} Enable point light shadow mapping (0 = off, 1 = on) */
  static pointEnabled = null;

  /** @type {Cvar} Normal offset bias for point light shadows (world units) */
  static pointNormalBias = null;

  /** @type {number} Shadow map resolution in pixels (read by shaders for PCF texel size) */
  static size = SHADOW_SIZE;

  /**
   * Initialize the shadow mapping system.
   * Creates the depth FBO, shadow texture and dummy texture.
   */
  static init() {
    ShadowMap.enabled = new Cvar('r_shadows', '1', Cvar.FLAG.ARCHIVE, 'Enable local entity shadow mapping');
    ShadowMap.range = new Cvar('r_shadow_range', (SHADOW_SIZE / 4).toFixed(0), Cvar.FLAG.ARCHIVE, 'Local shadow map coverage radius in world units');
    ShadowMap.darkness = new Cvar('r_shadow_darkness', '0.66', Cvar.FLAG.ARCHIVE, 'Minimum brightness in shadow (0=black, 1=no shadow)');
    ShadowMap.sunYaw = new Cvar('r_shadow_fallback_yaw', '225', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction yaw when no nearby light is found (degrees)');
    ShadowMap.sunPitch = new Cvar('r_shadow_fallback_pitch', '-90', Cvar.FLAG.ARCHIVE, 'Fallback shadow direction pitch when no nearby light is found (degrees, negative = down)');
    ShadowMap.maxDist = new Cvar('r_shadow_max_dist', '64', Cvar.FLAG.ARCHIVE, 'Wall-block depth threshold in world units (entity shadows behind a world surface thicker than this are suppressed)');

    // ── Shadow depth texture ───────────────────────────────────────
    ShadowMap.depthTexture = gl.createTexture();
    GL.Bind(0, ShadowMap.depthTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    // LINEAR + COMPARE gives free 2×2 PCF via sampler2DShadow
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // ── Depth-only FBO ─────────────────────────────────────────────
    ShadowMap.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, ShadowMap.depthTexture, 0);
    gl.drawBuffers([]);   // no color attachment
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ── 1×1 dummy (always-lit) ─────────────────────────────────────
    ShadowMap.dummyTexture = gl.createTexture();
    GL.Bind(0, ShadowMap.dummyTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xFFFFFFFF]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    // ── Point light cubemap depth texture ──────────────────────────
    ShadowMap.pointEnabled = new Cvar('r_shadow_point', '1', Cvar.FLAG.ARCHIVE, 'Enable point light shadow mapping');
    ShadowMap.pointNormalBias = new Cvar('r_shadow_point_normal_bias', '1.5', Cvar.FLAG.ARCHIVE, 'Normal offset bias for point light shadows (world units)');

    ShadowMap.pointDepthCube = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, ShadowMap.pointDepthCube);
    for (let face = 0; face < 6; face++) {
      gl.texImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24,
        POINT_SHADOW_SIZE, POINT_SHADOW_SIZE, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);

    // ── Point light depth FBO (face attachment swapped each pass) ──
    ShadowMap.pointFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X, ShadowMap.pointDepthCube, 0,
    );
    gl.drawBuffers([]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ── World occluder depth texture (sampler2D, no comparison) ────
    // Stores the closest world surface depth from the light's POV.
    // The fragment shader reads this raw depth to detect walls between
    // shadow-casting entities and the receiving surface, preventing
    // entity shadows from bleeding through solid world geometry.
    ShadowMap.worldDepthTexture = gl.createTexture();
    GL.Bind(0, ShadowMap.worldDepthTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_SIZE, SHADOW_SIZE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // No TEXTURE_COMPARE_MODE — we want raw depth via sampler2D

    ShadowMap.worldFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.worldFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, ShadowMap.worldDepthTexture, 0);
    gl.drawBuffers([]);
    gl.readBuffer(gl.NONE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // 1×1 dummy world depth (depth = 1.0 → no wall anywhere)
    ShadowMap.worldDummyTexture = gl.createTexture();
    GL.Bind(0, ShadowMap.worldDummyTexture);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, 1, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, new Uint32Array([0xFFFFFFFF]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ── 1×1 dummy cubemap (always-lit) ─────────────────────────────
    ShadowMap.pointDummyCube = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, ShadowMap.pointDummyCube);
    const dummyPixel = new Uint32Array([0xFFFFFFFF]);
    for (let face = 0; face < 6; face++) {
      gl.texImage2D(
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, gl.DEPTH_COMPONENT24,
        1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, dummyPixel,
      );
    }
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  }

  /**
   * Recompute the light-space view-projection matrix for the current frame.
   * Uses an orthographic projection centred on the camera.
   * Direction is taken from `localLightDir`, set by `selectLocalLight()`.
   * @param {Float32Array|number[]} viewOrigin Camera position in world space
   */
  static updateLightSpaceMatrix(viewOrigin) {
    const range = ShadowMap.range.value;

    // Light direction (FROM light TO scene), already normalised
    const dirX = ShadowMap.localLightDir[0];
    const dirY = ShadowMap.localLightDir[1];
    const dirZ = ShadowMap.localLightDir[2];

    // Light "eye" — offset back from view origin along the opposite of sun dir
    const eyeX = viewOrigin[0] - dirX * range;
    const eyeY = viewOrigin[1] - dirY * range;
    const eyeZ = viewOrigin[2] - dirZ * range;

    // ── Build an OpenGL-style lookAt matrix ────────────────────────
    // Forward = sun direction (already unit-length)
    const fX = dirX, fY = dirY, fZ = dirZ;

    // Choose a world-up that isn't parallel to forward
    let upX = 0, upY = 0, upZ = 1; // Quake up = +Z
    if (Math.abs(fZ) > 0.99) {
      upX = 1; upY = 0; upZ = 0;
    }

    // right = normalize(forward × up)
    let rX = fY * upZ - fZ * upY;
    let rY = fZ * upX - fX * upZ;
    let rZ = fX * upY - fY * upX;
    const rLen = Math.hypot(rX, rY, rZ);
    rX /= rLen; rY /= rLen; rZ /= rLen;

    // real up = right × forward (already unit since both inputs are unit)
    upX = rY * fZ - rZ * fY;
    upY = rZ * fX - rX * fZ;
    upZ = rX * fY - rY * fX;

    // OpenGL convention: camera looks along -Z in eye space
    const zX = -fX, zY = -fY, zZ = -fZ;

    // Column-major view matrix (rotation rows, translation column)
    const v0 = rX, v1 = upX, v2 = zX;
    const v4 = rY, v5 = upY, v6 = zY;
    const v8 = rZ, v9 = upZ, v10 = zZ;
    let v12 = -(rX * eyeX + rY * eyeY + rZ * eyeZ);
    let v13 = -(upX * eyeX + upY * eyeY + upZ * eyeZ);
    const v14 = -(zX * eyeX + zY * eyeY + zZ * eyeZ);

    // ── Orthographic projection (symmetric) ────────────────────────
    const halfSize = range;
    const near = 0.0;
    const far = range * 2.0;
    const invHS = 1.0 / halfSize;
    const invDepth = -2.0 / (far - near);
    const nfTerm = -(far + near) / (far - near);

    // ── Texel snapping ─────────────────────────────────────────────
    // Snap the light-space XY translation to shadow-map texel boundaries.
    // Without this the ortho projection shifts by sub-texel amounts as the
    // camera moves, causing shadow edges to shimmer ("shadow swimming").
    // We quantise the NDC-space translation (ortho × viewTranslation) so
    // that it always lands on a texel centre.
    const texelSize = (2.0 * halfSize) / SHADOW_SIZE; // world units per texel
    v12 = Math.floor(v12 / texelSize) * texelSize;
    v13 = Math.floor(v13 / texelSize) * texelSize;

    // ── lightSpaceMatrix = ortho × view  (column-major multiply) ───
    // ortho is diagonal-ish, so many terms simplify:
    //   ortho = diag(invHS, invHS, invDepth, 1) + [0,0,0,nfTerm] in col 3
    const m = ShadowMap.lightSpaceMatrix;
    m[0]  = invHS * v0;
    m[1]  = invHS * v1;
    m[2]  = invDepth * v2;
    m[3]  = 0;
    m[4]  = invHS * v4;
    m[5]  = invHS * v5;
    m[6]  = invDepth * v6;
    m[7]  = 0;
    m[8]  = invHS * v8;
    m[9]  = invHS * v9;
    m[10] = invDepth * v10;
    m[11] = 0;
    m[12] = invHS * v12;
    m[13] = invHS * v13;
    m[14] = invDepth * v14 + nfTerm;
    m[15] = 1;
  }

  /**
   * Begin the shadow depth pass.
   * Binds the shadow FBO, clears depth, and sets GL state for depth-only
   * rendering with polygon offset bias to reduce shadow acne.
   */
  static begin() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.fbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST); // required — Set2D disables this at end of previous frame
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.disable(gl.CULL_FACE); // render both sides so front-face depth is captured for thin occluders
  }

  /**
   * End the shadow depth pass and restore GL state.
   */
  static end() {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); // restore engine default
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Begin the raw entity depth pass.
   * Renders shadow-casting entities into a separate depth texture
   * (sampler2D, no comparison mode) so the fragment shader can read
   * the raw caster depth and suppress shadows that exceed the maximum
   * projection distance — preventing bleed-through walls.
   */
  static beginWorldPass() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.worldFBO);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.0, 1.0);
    gl.disable(gl.CULL_FACE);
  }

  /**
   * End the world occluder depth pass and restore GL state.
   */
  static endWorldPass() {
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Render world BSP into the world occluder depth map.
   * Uses a small polygon offset to avoid z-fighting; stores accurate
   * world depth so the fragment shader can detect walls between
   * shadow casters and receiving surfaces.
   */
  static renderWorldOccluder() {
    const worldmodel = /** @type {import('../../common/model/BSP.mjs').BrushModel} */ (CL.state.worldmodel);
    if (!worldmodel) {
      return;
    }

    GL.BindVAO(/** @type {WebGLVertexArrayObject} */ (worldmodel.opaqueVAO));
    const program = GL.UseProgram('shadow-brush');

    gl.uniform3f(program.uOrigin, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.lightSpaceMatrix);

    for (let i = 0; i < worldmodel.leafs.length; i++) {
      const leaf = worldmodel.leafs[i];
      if (leaf.skychain === 0) {
        continue;
      }

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const flags = worldmodel.textures[cmds[0]].flags;

        if (flags & (materialFlags.MF_SKIP | materialFlags.MF_TRANSPARENT)) {
          continue;
        }

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      }
    }

    GL.UnbindVAO();
  }

  /**
   * @returns {WebGLTexture} The world occluder depth texture (real or dummy)
   */
  static getActiveWorldTexture() {
    return ShadowMap.enabled.value ? ShadowMap.worldDepthTexture : ShadowMap.worldDummyTexture;
  }

  /**
   * Render the world BSP opaque geometry into the shadow map.
   * Uses a large polygon offset so the world depth is pushed well behind
   * its true position — this prevents self-shadowing on world surfaces
   * while still acting as an occluder that stops entity shadows from
   * bleeding through walls and floors.
   * Iterates every leaf (no camera-vis culling) because the light's
   * viewpoint differs from the camera's.
   */
  static renderWorldShadow() {
    const worldmodel = /** @type {import('../../common/model/BSP.mjs').BrushModel} */ (CL.state.worldmodel);
    if (!worldmodel) {
      return;
    }

    // Large bias: pushes stored depth far behind the surface so the world
    // never shadows itself, but entity depth (written with normal bias)
    // is still in front and casts shadows correctly.
    gl.polygonOffset(8.0, 4096.0);

    GL.BindVAO(/** @type {WebGLVertexArrayObject} */ (worldmodel.opaqueVAO));
    const program = GL.UseProgram('shadow-brush');

    // World entity: origin = 0, angles = identity
    gl.uniform3f(program.uOrigin, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.lightSpaceMatrix);

    // Draw all opaque leaf commands (skip vis — we need everything the light sees)
    for (let i = 0; i < worldmodel.leafs.length; i++) {
      const leaf = worldmodel.leafs[i];
      if (leaf.skychain === 0) {
        continue;
      }

      for (let j = 0; j < leaf.skychain; j++) {
        const cmds = leaf.cmds[j];
        const flags = worldmodel.textures[cmds[0]].flags;

        // Skip non-renderable and transparent surfaces
        if (flags & (materialFlags.MF_SKIP | materialFlags.MF_TRANSPARENT)) {
          continue;
        }

        gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
      }
    }

    GL.UnbindVAO();

    // Restore normal bias for entity shadow casters
    gl.polygonOffset(1.0, 1.0);
  }

  /**
   * Render visible entities (brush submodels, alias models, mesh models)
   * into the active shadow map.
   * @param {Float64Array} lightSpaceMatrix The light-space VP matrix
   * @param {string} brushProgram Program name for brush/mesh models
   * @param {string} aliasProgram Program name for alias models
   */
  static renderEntitiesShadow(lightSpaceMatrix, brushProgram = 'shadow-brush', aliasProgram = 'shadow-alias') {
    if (R.drawentities.value === 0) {
      return;
    }
    const noShadowEffects = effect.EF_MUZZLEFLASH | effect.EF_NOSHADOW | effect.EF_DIMLIGHT | effect.EF_FULLBRIGHT | effect.EF_BRIGHTLIGHT;
    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (entity.model === null || entity.alpha === 0.0 || entity.alpha < 1.0) {
        continue;
      }
      // Skip entities flagged as not casting shadows, or ones that are effectively fullbright
      if (entity.effects & (noShadowEffects)) {
        continue;
      }
      const model = entity.model;
      switch (model.type) {
        case Mod.type.brush:
          ShadowMap._renderBrushEntityShadow(model, entity, lightSpaceMatrix, brushProgram);
          break;
        case Mod.type.alias:
          ShadowMap._renderAliasEntityShadow(model, entity, lightSpaceMatrix, aliasProgram);
          break;
        case Mod.type.mesh:
          ShadowMap._renderMeshEntityShadow(model, entity, lightSpaceMatrix, brushProgram);
          break;
        default:
          break;
      }
    }
  }

  /**
   * Render a brush submodel entity (door, platform, etc.) into a shadow map.
   * @param {import('../../common/model/BSP.mjs').BrushModel} model
   * @param {import('../ClientEntities.mjs').ClientEdict} entity
   * @param {Float32Array} lightSpaceMatrix
   * @param {string} programName
   */
  static _renderBrushEntityShadow(model, entity, lightSpaceMatrix, programName) {
    if (!model.opaqueVAO || !model.chains || model.chains.length === 0) {
      return;
    }
    GL.BindVAO(/** @type {WebGLVertexArrayObject} */ (model.opaqueVAO));
    const program = GL.UseProgram(programName);

    gl.uniform3fv(program.uOrigin, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, lightSpaceMatrix);

    for (let i = 0; i < model.chains.length; i++) {
      const chain = model.chains[i];
      const flags = model.textures[chain[0]].flags;
      if (flags & (materialFlags.MF_SKIP | materialFlags.MF_TRANSPARENT | materialFlags.MF_TURBULENT)) {
        continue;
      }
      gl.drawArrays(gl.TRIANGLES, chain[1], chain[2]);
    }
    GL.UnbindVAO();
  }

  /**
   * Render an alias model entity (monster, item, weapon) into a shadow map.
   * Handles frame interpolation identically to AliasModelRenderer.
   * @param {import('../../common/model/AliasModel.mjs').AliasModel} model
   * @param {import('../ClientEntities.mjs').ClientEdict} entity
   * @param {Float32Array} lightSpaceMatrix
   * @param {string} programName
   */
  static _renderAliasEntityShadow(model, entity, lightSpaceMatrix, programName) {
    if (!model.cmds) {
      return;
    }
    const program = GL.UseProgram(programName);

    gl.uniform3fv(program.uOrigin, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, lightSpaceMatrix);

    // Frame interpolation (same logic as AliasModelRenderer._selectFrames)
    const time = CL.state.time + entity.syncbase;
    let num = entity.frame;
    if (num >= model.frames.length || num < 0) {
      num = 0;
    }
    let frame = model.frames[num];
    let frameA = frame;
    let frameB = frame;
    let targettime = 0;
    if (frame.group === true) {
      const last = frame.frames.length - 1;
      const fullinterval = frame.frames[last].interval;
      frameA = frame.frames[0];
      frameB = frame.frames[1 % frame.frames.length];
      targettime = time - Math.floor(time / fullinterval) * fullinterval;
      for (let i = 0; i < last; i++) {
        if (frame.frames[i].interval > targettime) {
          frameA = frame.frames[i];
          frameB = frame.frames[(i + 1) % frame.frames.length];
          break;
        }
      }
    } else if (R.interpolation.value) {
      const [previousFrame, nextFrame, f] = entity.lerp.frame;
      frameA = model.frames[previousFrame];
      frameB = model.frames[nextFrame];
      targettime = f;
    }

    gl.uniform1f(program.uInterpolation, R.interpolation.value ? Math.min(1, Math.max(0, targettime)) : 0);

    // Bind vertex buffer and setup attributes (stride=24: 3 floats pos + 3 floats normal)
    gl.bindBuffer(gl.ARRAY_BUFFER, model.cmds);
    gl.enableVertexAttribArray(program.aPositionA.location);
    gl.enableVertexAttribArray(program.aPositionB.location);
    gl.vertexAttribPointer(program.aPositionA.location, 3, gl.FLOAT, false, 24, frameA.cmdofs);
    gl.vertexAttribPointer(program.aPositionB.location, 3, gl.FLOAT, false, 24, frameB.cmdofs);

    // Bind normal attributes for point shadow normal offset bias (offset +12 in same buffer)
    if (program.aNormalA) {
      gl.enableVertexAttribArray(program.aNormalA.location);
      gl.enableVertexAttribArray(program.aNormalB.location);
      gl.vertexAttribPointer(program.aNormalA.location, 3, gl.FLOAT, false, 24, frameA.cmdofs + 12);
      gl.vertexAttribPointer(program.aNormalB.location, 3, gl.FLOAT, false, 24, frameB.cmdofs + 12);
      gl.uniform3fv(program.uLightPos, ShadowMap.pointLightOrigin);
      gl.uniform1f(program.uNormalBias, ShadowMap.pointNormalBias.value);
    }

    gl.drawArrays(gl.TRIANGLES, 0, model._num_tris * 3);

    gl.disableVertexAttribArray(program.aPositionA.location);
    gl.disableVertexAttribArray(program.aPositionB.location);
    if (program.aNormalA) {
      gl.disableVertexAttribArray(program.aNormalA.location);
      gl.disableVertexAttribArray(program.aNormalB.location);
    }
  }

  /**
   * Render a mesh model entity (glTF) into a shadow map.
   * @param {import('../../common/model/MeshModel.mjs').MeshModel} model
   * @param {import('../ClientEntities.mjs').ClientEdict} entity
   * @param {Float32Array} lightSpaceMatrix
   * @param {string} programName
   */
  static _renderMeshEntityShadow(model, entity, lightSpaceMatrix, programName) {
    if (!model.vao) {
      return;
    }
    GL.BindVAO(model.vao);
    const program = GL.UseProgram(programName);

    gl.uniform3fv(program.uOrigin, entity.lerp.origin);
    gl.uniformMatrix3fv(program.uAngles, false, entity.lerp.angles.toRotationMatrix());
    gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, lightSpaceMatrix);

    const indexType = model.indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
    gl.drawElements(gl.TRIANGLES, model.numTriangles * 3, indexType, 0);
    GL.UnbindVAO();
  }

  /**
   * @returns {WebGLTexture} The texture to bind as shadow map (real or dummy)
   */
  static getActiveTexture() {
    return ShadowMap.enabled.value ? ShadowMap.depthTexture : ShadowMap.dummyTexture;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  Point light (cube) shadow mapping
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Parse all light entities from the BSP entity lump and cache them.
   * Scans the raw entity string for entities whose classname starts with
   * `"light"`.  For each one the origin and the light level (from the
   * `"light"` key, default 300) are stored in `ShadowMap.lightEntities`.
   * Called lazily from `selectLocalLight` whenever the worldmodel changes.
   * @param {string} entityString Raw entity lump text from the BSP
   */
  static parseLightEntities(entityString) {
    ShadowMap.lightEntities.length = 0;

    if (!entityString) {
      return;
    }

    let data = entityString;

    while (data) {
      const parsed = COM.Parse(data);
      data = parsed.data;

      if (!data || parsed.token !== '{') {
        break;
      }

      const ent = {};
      while (data) {
        const parsedKey = COM.Parse(data);
        data = parsedKey.data;

        if (!data || parsedKey.token === '}') {
          break;
        }

        const parsedValue = COM.Parse(data);
        data = parsedValue.data;

        if (!data || parsedValue.token === '}') {
          break;
        }

        ent[parsedKey.token] = parsedValue.token;
      }

      if (!ent.classname || !ent.classname.startsWith('light') || !ent.origin) {
        continue;
      }

      const parts = ent.origin.split(' ');
      if (parts.length < 3) {
        continue;
      }

      const origin = new Float32Array([
        parseFloat(parts[0]),
        parseFloat(parts[1]),
        parseFloat(parts[2]),
      ]);

      // The "light" key specifies intensity; default 300 per Quake convention
      const radius = ent.light ? parseFloat(ent.light) : 300;

      if (radius > 0 && !Number.isNaN(origin[0])) {
        ShadowMap.lightEntities.push({ origin, radius });
      }
    }

    console.debug(`Parsed ${ShadowMap.lightEntities.length} light entities from BSP`, ShadowMap.lightEntities);
  }

  /**
   * Test line-of-sight between two points using the world BSP hull 0.
   * @param {Float32Array|number[]} start Start point
   * @param {Float32Array|number[]} end End point
   * @returns {boolean} `true` if the line is unobstructed
   */
  static _traceVisible(start, end) {
    const trace = { plane: {} };
    SV.collision.recursiveHullCheck(
      CL.state.worldmodel.hulls[0], 0, 0.0, 1.0,
      new Vector(start[0], start[1], start[2]),
      new Vector(end[0], end[1], end[2]),
      trace,
    );
    return trace.fraction === 1.0 && !trace.allsolid && !trace.startsolid;
  }

  /**
   * Compute the centroid of all visible shadow-casting entities.
   * Used to select the dominant light relative to the entities rather
   * than the camera, so that shadows remain stable when only the
   * camera moves.
   * @param {Float32Array} out 3-element array to receive the centroid
   * @returns {number} Number of entities that contributed
   */
  static _computeShadowCasterCentroid(out) {
    out[0] = 0; out[1] = 0; out[2] = 0;
    let count = 0;
    const noShadowEffects = effect.EF_MUZZLEFLASH | effect.EF_NOSHADOW
      | effect.EF_DIMLIGHT | effect.EF_FULLBRIGHT | effect.EF_BRIGHTLIGHT;

    for (const entity of CL.state.clientEntities.getVisibleEntities()) {
      if (entity.model === null || entity.alpha === 0.0 || entity.alpha < 1.0) {
        continue;
      }
      if (entity.effects & noShadowEffects) {
        continue;
      }
      const type = entity.model.type;
      if (type !== Mod.type.brush && type !== Mod.type.alias && type !== Mod.type.mesh) {
        continue;
      }
      out[0] += entity.lerp.origin[0];
      out[1] += entity.lerp.origin[1];
      out[2] += entity.lerp.origin[2];
      count++;
    }

    if (count > 0) {
      const inv = 1.0 / count;
      out[0] *= inv;
      out[1] *= inv;
      out[2] *= inv;
    }
    return count;
  }

  /**
   * Determine the local light direction for the entity shadow this frame.
   * Finds the strongest visible light entity (parsed from the BSP entity
   * lump) near the shadow-casting entities and derives the shadow cast
   * direction from the vector pointing FROM the light TO the entity
   * centroid.  This ensures shadows remain stable when only the camera
   * moves — only entity movement changes the shadow direction.
   * When no visible light entity is found the method falls back to the
   * configurable fallback angles (`r_shadow_fallback_yaw` /
   * `r_shadow_fallback_pitch`).
   * @param {Float32Array|number[]} viewOrigin Camera position (used as
   *   fallback when no shadow casters are visible)
   */
  static selectLocalLight(viewOrigin) {
    const worldmodel = CL.state.worldmodel;
    if (!worldmodel) {
      ShadowMap._applyFallbackDirection();
      return;
    }

    // Lazy-parse light entities when worldmodel changes (new map)
    if (ShadowMap._parsedWorldmodel !== worldmodel) {
      ShadowMap.parseLightEntities(worldmodel.entities);
      ShadowMap._parsedWorldmodel = worldmodel;
    }

    // Score all light entities and pick the best visible one.
    // Score = radius / distance — prefers brighter, closer lights.
    const lights = ShadowMap.lightEntities;
    const numLights = lights.length;

    if (numLights === 0) {
      ShadowMap._applyFallbackDirection();
      return;
    }

    // Use the centroid of visible shadow-casting entities as the
    // reference point so the light direction is stable when only the
    // camera moves.  Fall back to viewOrigin when nothing casts shadows.
    const centroid = ShadowMap._centroidScratch;
    const casterCount = ShadowMap._computeShadowCasterCentroid(centroid);
    const refX = casterCount > 0 ? centroid[0] : viewOrigin[0];
    const refY = casterCount > 0 ? centroid[1] : viewOrigin[1];
    const refZ = casterCount > 0 ? centroid[2] : viewOrigin[2];

    // Build scored list, cheaply reject lights that are too far away
    const maxRange = ShadowMap.range.value * 16.0;
    const maxRangeSq = maxRange * maxRange;
    const scored = [];

    for (let i = 0; i < numLights; i++) {
      const light = lights[i];
      const dx = light.origin[0] - refX;
      const dy = light.origin[1] - refY;
      const dz = light.origin[2] - refZ;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq > maxRangeSq || distSq < 0.01) {
        continue;
      }

      const dist = Math.sqrt(distSq);
      const score = light.radius / Math.max(dist, 1.0);
      scored.push({ light, dist, score });
    }

    // Sort descending by score, limit trace count
    scored.sort((a, b) => b.score - a.score);
    const traceLimit = Math.min(scored.length, ShadowMap._MAX_LIGHT_TRACES);

    for (let i = 0; i < traceLimit; i++) {
      const { light, dist } = scored[i];

      // Direction FROM the light TO the entity centroid (shadow cast direction)
      const invDist = 1.0 / dist;
      ShadowMap.localLightDir[0] = (refX - light.origin[0]) * invDist;
      ShadowMap.localLightDir[1] = (refY - light.origin[1]) * invDist;
      ShadowMap.localLightDir[2] = (refZ - light.origin[2]) * invDist;
      ShadowMap.localLightFalloff = 1.0;
      return;
    }

    // No visible light entity found — use fallback direction
    ShadowMap._applyFallbackDirection();
  }

  /**
   * Apply the configurable fallback shadow direction.
   * Used when no light entity from the BSP entity lump is visible.
   */
  static _applyFallbackDirection() {
    const yaw = ShadowMap.sunYaw.value * Math.PI / 180.0;
    const pitch = ShadowMap.sunPitch.value * Math.PI / 180.0;
    const cp = Math.cos(pitch);
    ShadowMap.localLightDir[0] = cp * Math.cos(yaw);
    ShadowMap.localLightDir[1] = cp * Math.sin(yaw);
    ShadowMap.localLightDir[2] = Math.sin(pitch);
    ShadowMap.localLightFalloff = 1.0;
  }

  /**
   * Select the strongest light for point shadow casting.
   * Considers both transient dynamic lights and static BSP light
   * entities.  Picks whichever scores highest (radius / distance).
   * BSP lights are capped at twice their radius so distant map
   * lights don't compete with nearby ones.
   * @param {Float32Array|number[]} viewOrigin Camera position in world space
   * @returns {boolean} True if a suitable light was found
   */
  static selectPointLight(viewOrigin) {
    ShadowMap.pointLightActive = false;

    if (!ShadowMap.pointEnabled.value) {
      return false;
    }

    // Lazy-parse BSP light entities when worldmodel changes (new map)
    const worldmodel = CL.state.worldmodel;
    if (worldmodel && ShadowMap._parsedWorldmodel !== worldmodel) {
      ShadowMap.parseLightEntities(worldmodel.entities);
      ShadowMap._parsedWorldmodel = worldmodel;
    }

    let bestScore = -1;
    let bestOriginX = 0;
    let bestOriginY = 0;
    let bestOriginZ = 0;
    let bestRadius = 0;

    // Score transient dynamic lights
    const dlights = CL.state.clientEntities.dlights;
    for (let i = 0; i < limits.dlights; i++) {
      const l = dlights[i];
      if (l.isFree() || l.radius <= 0) {
        continue;
      }

      const dx = l.origin[0] - viewOrigin[0];
      const dy = l.origin[1] - viewOrigin[1];
      const dz = l.origin[2] - viewOrigin[2];
      const dist = Math.hypot(dx, dy, dz);
      const score = l.radius / Math.max(dist, 1.0);

      if (score > bestScore) {
        bestScore = score;
        bestOriginX = l.origin[0];
        bestOriginY = l.origin[1];
        bestOriginZ = l.origin[2];
        bestRadius = l.radius;
      }
    }

    // // Score static BSP light entities — only consider lights within
    // // twice their radius so distant map lights don't compete.
    // const lights = ShadowMap.lightEntities;
    // for (let i = 0; i < lights.length; i++) {
    //   const light = lights[i];
    //   const dx = light.origin[0] - viewOrigin[0];
    //   const dy = light.origin[1] - viewOrigin[1];
    //   const dz = light.origin[2] - viewOrigin[2];
    //   const distSq = dx * dx + dy * dy + dz * dz;
    //   const maxDist = light.radius * 2.0;

    //   if (distSq > maxDist * maxDist) {
    //     continue;
    //   }

    //   const dist = Math.sqrt(distSq);
    //   const score = light.radius / Math.max(dist, 1.0);

    //   if (score > bestScore) {
    //     bestScore = score;
    //     bestOriginX = light.origin[0];
    //     bestOriginY = light.origin[1];
    //     bestOriginZ = light.origin[2];
    //     bestRadius = light.radius;
    //   }
    // }

    if (bestScore < 0) {
      return false;
    }

    ShadowMap.pointLightOrigin[0] = bestOriginX;
    ShadowMap.pointLightOrigin[1] = bestOriginY;
    ShadowMap.pointLightOrigin[2] = bestOriginZ;
    ShadowMap.pointLightRadius = bestRadius;
    ShadowMap.pointLightActive = true;
    return true;
  }

  /**
   * Build a 90° perspective view-projection matrix for one cube face.
   * Writes into ShadowMap.pointFaceMatrix (column-major).
   * @param {number} faceIndex 0-5 corresponding to +X, -X, +Y, -Y, +Z, -Z
   */
  static buildPointFaceMatrix(faceIndex) {
    const face = CUBE_FACES[faceIndex];
    const ox = ShadowMap.pointLightOrigin[0];
    const oy = ShadowMap.pointLightOrigin[1];
    const oz = ShadowMap.pointLightOrigin[2];
    const far = ShadowMap.pointLightRadius;

    // Target direction
    const tx = face[0], ty = face[1], tz = face[2];
    // Up vector
    let ux = face[3], uy = face[4], uz = face[5];

    // right = normalize(target × up)
    let rx = ty * uz - tz * uy;
    let ry = tz * ux - tx * uz;
    let rz = tx * uy - ty * ux;
    const rLen = Math.hypot(rx, ry, rz);
    rx /= rLen; ry /= rLen; rz /= rLen;

    // Recalculate up = right × target
    ux = ry * tz - rz * ty;
    uy = rz * tx - rx * tz;
    uz = rx * ty - ry * tx;

    // View matrix (lookAt: eye=origin, centre=origin+target, up)
    // Camera looks along -Z in eye space, so negate the forward axis
    const fwX = -tx, fwY = -ty, fwZ = -tz;

    const v12 = -(rx * ox + ry * oy + rz * oz);
    const v13 = -(ux * ox + uy * oy + uz * oz);
    const v14 = -(fwX * ox + fwY * oy + fwZ * oz);

    // Perspective matrix (symmetric, 90° FOV, aspect 1:1)
    // f = 1/tan(45°) = 1.0
    const nf = POINT_NEAR / (POINT_NEAR - far); // = n/(n-f)
    const nf2 = (POINT_NEAR * far) / (POINT_NEAR - far); // = n*f/(n-f)

    // Combined P × V (column-major)
    // P = diag(1, 1, nf, 0) + col3(0, 0, nf2, -1)
    const m = ShadowMap.pointFaceMatrix;
    // Column 0: P * V col0
    m[0]  = rx;
    m[1]  = ux;
    m[2]  = nf * fwX;
    m[3]  = -fwX;
    // Column 1: P * V col1
    m[4]  = ry;
    m[5]  = uy;
    m[6]  = nf * fwY;
    m[7]  = -fwY;
    // Column 2: P * V col2
    m[8]  = rz;
    m[9]  = uz;
    m[10] = nf * fwZ;
    m[11] = -fwZ;
    // Column 3: P * V col3
    m[12] = v12;
    m[13] = v13;
    m[14] = nf * v14 + nf2;
    m[15] = -v14;
  }

  /**
   * Render the point light shadow cube map (all 6 faces).
   * Call after selectPointLight() returns true.
   */
  static renderPointLightShadow() {
    const worldmodel = /** @type {import('../../common/model/BSP.mjs').BrushModel} */ (CL.state.worldmodel);
    if (!worldmodel) {
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, ShadowMap.pointFBO);
    gl.viewport(0, 0, POINT_SHADOW_SIZE, POINT_SHADOW_SIZE);
    gl.enable(gl.DEPTH_TEST);
    gl.colorMask(false, false, false, false);
    gl.disable(gl.CULL_FACE); // render both sides for correct occlusion behind thin geometry

    GL.BindVAO(/** @type {WebGLVertexArrayObject} */ (worldmodel.opaqueVAO));
    const program = GL.UseProgram('shadow-point');

    gl.uniform3f(program.uOrigin, 0, 0, 0);
    gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    gl.uniform3fv(program.uLightPos, ShadowMap.pointLightOrigin);
    gl.uniform1f(program.uLightRadius, ShadowMap.pointLightRadius);
    gl.uniform1f(program.uNormalBias, ShadowMap.pointNormalBias.value);

    for (let face = 0; face < 6; face++) {
      // Attach the correct cube face to the FBO depth
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
        gl.TEXTURE_CUBE_MAP_POSITIVE_X + face,
        ShadowMap.pointDepthCube, 0,
      );
      gl.clear(gl.DEPTH_BUFFER_BIT);

      ShadowMap.buildPointFaceMatrix(face);
      gl.uniformMatrix4fv(program.uLightSpaceMatrix, false, ShadowMap.pointFaceMatrix);

      // Draw all opaque leaf geometry
      for (let i = 0; i < worldmodel.leafs.length; i++) {
        const leaf = worldmodel.leafs[i];
        if (leaf.skychain === 0) {
          continue;
        }
        for (let j = 0; j < leaf.skychain; j++) {
          const cmds = leaf.cmds[j];
          const flags = worldmodel.textures[cmds[0]].flags;
          if (flags & (materialFlags.MF_SKIP | materialFlags.MF_TRANSPARENT)) {
            continue;
          }
          gl.drawArrays(gl.TRIANGLES, cmds[1], cmds[2]);
        }
      }

      // Draw entities into this cube face (exclude the light-emitting entity)
      GL.UnbindVAO();
      ShadowMap.renderEntitiesShadow(ShadowMap.pointFaceMatrix, 'shadow-point', 'shadow-alias-point');

      // Re-bind world VAO and program for next face
      GL.BindVAO(/** @type {WebGLVertexArrayObject} */ (worldmodel.opaqueVAO));
      GL.UseProgram('shadow-point');
      gl.uniform3f(program.uOrigin, 0, 0, 0);
      gl.uniformMatrix3fv(program.uAngles, false, GL.identity);
    }

    GL.UnbindVAO();
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); // restore engine default
    gl.colorMask(true, true, true, true);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @returns {WebGLTexture} The cube texture to bind as point shadow map (real or dummy)
   */
  static getActivePointTexture() {
    return ShadowMap.pointLightActive ? ShadowMap.pointDepthCube : ShadowMap.pointDummyCube;
  }
}
