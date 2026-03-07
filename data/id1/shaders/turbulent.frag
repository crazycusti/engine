#version 300 es
precision highp float;
out vec4 fragColor;

uniform float uGamma;
uniform float uTime;
uniform sampler2D tTexture;
uniform float uAlpha;

in vec4 vTexCoord;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  // NOTE: it’s possible to apply lightmaps and make the surface transparent, both require recompiled maps though.

  fragColor = vec4(texture(tTexture, vTexCoord.st + vec2(sin(vTexCoord.t * 3.141593 + uTime), sin(vTexCoord.s * 3.141593 + uTime)) * 0.125).rgb, uAlpha);

  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // fog mix
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
}
