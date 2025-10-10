uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;
uniform float uAlpha;

attribute vec3 aPositionA;
attribute vec3 aPositionB;
attribute vec3 aNormal;
attribute vec2 aTexCoord;

varying vec2 vTexCoord;
varying float vLightDot;
varying float vFog;

uniform vec3 uFogColor;
uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 lerpPos = mix(aPositionA, aPositionB, uAlpha);
  vec3 worldPos = uAngles * lerpPos + uOrigin;
  vec3 position = uViewAngles * (worldPos - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vTexCoord = aTexCoord;
  vLightDot = dot(aNormal, normalize(worldPos - uLightVec));

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
