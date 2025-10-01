precision mediump float;

uniform float uGamma;
uniform float uTime;
uniform sampler2D tTexture;

varying vec4 vTexCoord;
varying float vFog;
uniform vec3 uFogColor;

void main(void) {
  // NOTE: it’s possible to apply lightmaps and make the surface transparent, both require recompiled maps though.

  gl_FragColor = vec4(texture2D(tTexture, vTexCoord.st + vec2(sin(vTexCoord.t * 3.141593 + uTime), sin(vTexCoord.s * 3.141593 + uTime)) * 0.125).rgb, 1.0);

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  // fog mix
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a);
}
