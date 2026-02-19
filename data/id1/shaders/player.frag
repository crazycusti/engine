#version 300 es
precision mediump float;
out vec4 fragColor;

uniform float uGamma;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;
uniform float uTime;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform sampler2D tTexture;
uniform sampler2D tPlayer;
uniform float uAlpha;

in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
uniform vec3 uFogColor;

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec4 player = texture(tPlayer, vTexCoord);

  fragColor.r = mix(mix(texel.r, uTop.r * (1.0 / 191.25) * player.x, player.y), uBottom.r * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.r + uAmbientLight.r + vDynamicLightDot * uDynamicShadeLight.r, texel.a);
  fragColor.g = mix(mix(texel.g, uTop.g * (1.0 / 191.25) * player.x, player.y), uBottom.g * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.g + uAmbientLight.g + vDynamicLightDot * uDynamicShadeLight.g, texel.a);
  fragColor.b = mix(mix(texel.b, uTop.b * (1.0 / 191.25) * player.x, player.y), uBottom.b * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.b + uAmbientLight.b + vDynamicLightDot * uDynamicShadeLight.b, texel.a);

  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a * uAlpha);
}

