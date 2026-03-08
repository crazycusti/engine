#version 300 es
precision highp float;

uniform vec3 uOrigin;
uniform mat3 uAngles;
uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;

in vec3 aPosition;

out vec3 vWorldPos;

void main(void) {
  vec3 worldPos = uAngles * aPosition + uOrigin;
  vWorldPos = worldPos;

  vec3 viewPos = uViewAngles * (worldPos - uViewOrigin);
  gl_Position = uPerspective * vec4(viewPos.xz, -viewPos.y, 1.0);
}
