precision mediump float;

uniform float uGamma;

varying vec2 vCoord;
varying vec3 vColor;
varying float vFog;
uniform vec3 uFogColor;

void main(void) {
  gl_FragColor = vec4(vColor, 1.0 - smoothstep(0.75, 1.0, length(vCoord)));

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  // apply fog (particles keep alpha)
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a);
}
