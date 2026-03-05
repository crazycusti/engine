#version 300 es
precision mediump float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec4 uLightVec;
uniform vec3 uDynamicLightVec;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

// Shadow mapping
uniform mat4 uLightSpaceMatrix;

in vec3 aPosition;
in vec3 aNormal;
in vec4 aTexCoord;
in vec4 aLightStyle;
in vec3 aTangent;

out vec4 vTexCoord;
out vec4 vLightStyle;
out float vLightDot;
out float vDynamicLightDot;
out float vFog;
out vec3 vNormal;
out vec3 vLightVec;
out float vLightMix;
out vec3 vTangent;
out mat3 vAngles;

out vec3 vViewVec;
out vec4 vShadowCoord;
out vec3 vWorldPos;
uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  // Calculate world position once and reuse
  vec3 worldPos = uAngles * aPosition + uOrigin;
  vWorldPos = worldPos;

  // Calculate view position and set gl_Position
  vec3 position = uViewAngles * (worldPos - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  // Shadow coordinate in light space
  vShadowCoord = uLightSpaceMatrix * vec4(worldPos, 1.0);

  // Pass through texture coordinates
  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;

  // Calculate view-related vectors once (shared for both paths)
  vec3 worldToView = worldPos - uViewOrigin;
  vViewVec = normalize(worldToView);

  // Calculate distance once for both lighting and fog
  float distToView = length(worldToView);

  // Transform light vector
  vLightVec = normalize(worldPos - uLightVec.xyz * uAngles);

  // Lighting calculations - minimize branching impact
  // Always transform normals (cheaper than branching), fragment shader will use if needed
  vec3 transformedNormal = uAngles * aNormal;
  vNormal = normalize(transformedNormal);
  vTangent = normalize(uAngles * aTangent);
  vAngles = uAngles;

  // Compute both lighting paths, select based on uniform
  // This avoids branching at the cost of a few extra ops (which is faster on GPU)
  float lightDist = length(uLightVec.xyz - worldPos);
  float dynamicLightMix = clamp(uLightVec.w / lightDist, 0.0, 1.0);
  float staticLightDot = dot(transformedNormal, vLightVec);
  vDynamicLightDot = max(0.0, dot(transformedNormal, normalize(worldPos - uDynamicLightVec)));

  // Use mix/step to avoid branching (branchless selection)
  float useDotLighting = float(uPerformDotLighting);
  vLightMix = mix(1.0, dynamicLightMix, useDotLighting);
  vLightDot = mix(staticLightDot, 0.0, useDotLighting);

  // Fog calculation - use branchless approach
  // Pre-calculate all fog modes, then select
  float fogLinear = clamp((uFogParams.y - distToView) / max(0.0001, uFogParams.y - uFogParams.x), 0.0, 1.0);
  float fogExp = clamp(exp(-uFogParams.z * distToView), 0.0, 1.0);
  float fogExp2 = clamp(exp(-uFogParams.z * uFogParams.z * distToView * distToView), 0.0, 1.0);

  // Branchless fog mode selection using step functions
  // fogMode: -1=none, 0=linear, 1=exp, 2=exp2
  float isNoFog = step(uFogParams.w, -0.5);
  float isLinear = step(uFogParams.w, 0.5) * (1.0 - isNoFog);
  float isExp = step(abs(uFogParams.w - 1.0), 0.5) * (1.0 - isNoFog - isLinear);
  float isExp2 = (1.0 - isNoFog - isLinear - isExp);

  vFog = mix(
    mix(
      mix(fogExp2, fogExp, isExp),
      fogLinear,
      isLinear
    ),
    1.0,
    isNoFog
  );
}
