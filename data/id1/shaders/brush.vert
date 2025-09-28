uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform vec3 uLightVec;

attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec4 aTexCoord;
attribute vec4 aLightStyle;

varying vec4 vTexCoord;
varying vec4 vLightStyle;
varying float vLightDot;

void main(void) {
  vec3 position = uViewAngles * (uAngles * aPosition + uOrigin - uViewOrigin);
  gl_Position = uPerspective * vec4(position.xz, -position.y, 1.0);
  vTexCoord = aTexCoord;
  vLightStyle = aLightStyle;
  vLightDot = dot(aNormal, uLightVec);
}
