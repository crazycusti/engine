uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;
uniform vec3 uDynamicLightVec;

attribute vec3 aPosition;
attribute vec2 aTexCoord;
attribute vec3 aNormal;

varying vec2 vTexCoord;
varying float vLightDot;
varying float vDynamicLightDot;
varying float vFog;

uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vLightDot = max(0.0, dot(aNormal, normalize(worldPos - uLightVec)));
  vDynamicLightDot = max(0.0, dot(aNormal, normalize(worldPos - uDynamicLightVec)));

  // fog distance (world position)
  float dist = length(worldPos - uViewOrigin);
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
