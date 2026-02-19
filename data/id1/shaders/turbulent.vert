#version 300 es
uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;
// in vec3 aNormal;
in vec4 aTexCoord;
in vec4 aLightStyle;
// in vec3 aTangent;
// in vec3 aBitangent;

out vec4 vTexCoord;
out vec4 vLightStyle;
out float vFog;
uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec3 position = uViewAngles * (uAngles * aPosition + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;
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
