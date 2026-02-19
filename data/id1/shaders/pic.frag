#version 300 es
precision mediump float;
out vec4 fragColor;

uniform sampler2D tTexture;
uniform vec3 uColor;

in vec2 vTexCoord;

void main(void) {
  fragColor = texture(tTexture, vTexCoord) * vec4(uColor, 1.0);
}
