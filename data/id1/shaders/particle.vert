uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uScale;

attribute vec3 aOrigin;
attribute vec2 aCoord;
attribute float aScale;
attribute vec3 aColor;

varying vec2 vCoord;
varying vec3 vColor;
varying float vFog;

uniform vec3 uFogColor;
uniform vec4 uFogParams; // start, end, density, mode

void main(void) {
  vec2 point = aCoord * aScale;
  vec3 position = vec3(point.x, 0.0, point.y) + uViewAngles * (aOrigin - uViewOrigin);

  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);

  vCoord = aCoord;
  vColor = aColor;
  float dist = length(aOrigin - uViewOrigin);
  if (uFogParams.w < 0.5) {
    float denom = max(0.0001, uFogParams.y - uFogParams.x);
    vFog = clamp((uFogParams.y - dist) / denom, 0.0, 1.0);
  } else if (abs(uFogParams.w - 1.0) < 0.5) {
    vFog = clamp(exp(-uFogParams.z * dist), 0.0, 1.0);
  } else {
    vFog = clamp(exp(-uFogParams.z * uFogParams.z * dist * dist), 0.0, 1.0);
  }
}
