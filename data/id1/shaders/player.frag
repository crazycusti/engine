precision mediump float;

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

varying vec2 vTexCoord;
varying float vLightDot;
varying float vDynamicLightDot;
varying float vFog;
uniform vec3 uFogColor;

void main(void) {
  vec4 texture = texture2D(tTexture, vTexCoord);
  vec4 player = texture2D(tPlayer, vTexCoord);

  gl_FragColor.r = mix(mix(texture.r, uTop.r * (1.0 / 191.25) * player.x, player.y), uBottom.r * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.r + uAmbientLight.r + vDynamicLightDot * uDynamicShadeLight.r, texture.a);
  gl_FragColor.g = mix(mix(texture.g, uTop.g * (1.0 / 191.25) * player.x, player.y), uBottom.g * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.g + uAmbientLight.g + vDynamicLightDot * uDynamicShadeLight.g, texture.a);
  gl_FragColor.b = mix(mix(texture.b, uTop.b * (1.0 / 191.25) * player.x, player.y), uBottom.b * (1.0 / 191.25) * player.z, player.w) * mix(1.0, vLightDot * uShadeLight.b + uAmbientLight.b + vDynamicLightDot * uDynamicShadeLight.b, texture.a);

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a * uAlpha);
}

