precision mediump float;

uniform float uGamma;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;
uniform vec3 uDynamicShadeLight;
uniform float uTime;
uniform sampler2D tTexture;

varying vec2 vTexCoord;
varying float vLightDot;
varying float vDynamicLightDot;
varying float vFog;
uniform vec3 uFogColor;

void main(void){
  vec4 texture = texture2D(tTexture, vTexCoord);
  gl_FragColor = vec4(
    texture.r * mix(1.0, vLightDot * uShadeLight.r + uAmbientLight.r + vDynamicLightDot * uDynamicShadeLight.r, texture.a),
    texture.g * mix(1.0, vLightDot * uShadeLight.g + uAmbientLight.g + vDynamicLightDot * uDynamicShadeLight.g, texture.a),
    texture.b * mix(1.0, vLightDot * uShadeLight.b + uAmbientLight.b + vDynamicLightDot * uDynamicShadeLight.b, texture.a),
    1.0
  );
  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a);
}
