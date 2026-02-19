#version 300 es
uniform mat4 uOrtho;

in vec2 aPosition;
in vec2 aTexCoord;

out vec2 vTexCoord;

void main(void) {
  gl_Position = uOrtho * vec4(aPosition, 0.0, 1.0);
  vTexCoord = aTexCoord;
}
