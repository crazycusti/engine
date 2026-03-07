#version 300 es
precision highp float;

void main(void) {
  // Depth is written automatically by the rasterizer via the perspective
  // projection. The hardware depth buffer stores the non-linear depth
  // which is compared via samplerCubeShadow.
}
