#version 300 es
precision mediump float;
out vec4 fragColor;

uniform float uGamma;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;
uniform float uTime;
uniform sampler2D tTexture;
uniform float uAlpha;

in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
uniform vec3 uFogColor;

void main(void){
  vec4 texel = texture(tTexture, vTexCoord);
  fragColor = vec4(
    texel.r * mix(1.0, vLightDot * uShadeLight.r + uAmbientLight.r + vDynamicLightDot * uDynamicShadeLight.r, texel.a),
    texel.g * mix(1.0, vLightDot * uShadeLight.g + uAmbientLight.g + vDynamicLightDot * uDynamicShadeLight.g, texel.a),
    texel.b * mix(1.0, vLightDot * uShadeLight.b + uAmbientLight.b + vDynamicLightDot * uDynamicShadeLight.b, texel.a),
    uAlpha
  );
  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a);
}
