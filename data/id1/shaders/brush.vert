uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec4 uLightVec;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec4 aTexCoord;
attribute vec4 aLightStyle;
attribute vec3 aTangent;
attribute vec3 aBitangent;

varying vec4 vTexCoord;
varying vec4 vLightStyle;
varying float vLightDot;
varying float vFog;
varying vec3 vNormal;
varying vec3 vLightVec;
varying float vLightMix;
varying vec3 vTangent;
varying vec3 vBitangent;
varying mat3 vAngles;

varying vec3 vViewVec;
uniform vec3 uFogColor;
uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;
  // view vector in world space (from surface to camera)
  vViewVec = normalize(worldPos - uViewOrigin);
  vLightVec = normalize(worldPos - uLightVec.xyz * uAngles);
  // calculate stuff for per-pixel lighting
  if (uPerformDotLighting) {
    float dist = length(uLightVec.xyz - worldPos);
    vLightMix = clamp(uLightVec.w / dist, 0.0, 1.0);
    vNormal = normalize(uAngles * aNormal);
    vTangent = normalize(uAngles * aTangent);
    vBitangent = normalize(uAngles * aBitangent);
    vAngles = uAngles;
  } else {
    vLightDot = dot(uAngles * aNormal, vLightVec);
    vLightMix = 1.0;
  }

  // fog stuff
  float dist = length(aPosition + uOrigin - uViewOrigin);
  if (uFogParams.w < 0.0) {
    vFog = 1.0;
  } else if (uFogParams.w < 0.5) {
    float denom = max(0.0001, uFogParams.y - uFogParams.x);
    vFog = clamp((uFogParams.y - dist) / denom, 0.0, 1.0);
  } else if (abs(uFogParams.w - 1.0) < 0.5) {
    vFog = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  } else {
    vFog = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);
  }
}
