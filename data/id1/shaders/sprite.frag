precision mediump float;

uniform float uGamma;
uniform sampler2D tTexture;

varying vec2 vTexCoord;
varying float vFog;
uniform vec3 uFogColor;

void main(void) {
  gl_FragColor = texture2D(tTexture, vTexCoord);
  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  if (gl_FragColor.a < 0.25) discard;
  gl_FragColor.a = gl_FragColor.a * .7;
  // apply fog
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a);
}
