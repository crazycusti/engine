precision mediump float;

uniform float uGamma;
uniform float uAlpha;

uniform sampler2D tTextureA;
uniform sampler2D tTextureB;
uniform sampler2D tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;
uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;

varying vec4 vTexCoord;
varying vec4 vLightStyle;
varying float vLightDot;

void main(void) {
  vec4 textureA = texture2D(tTextureA, vTexCoord.xy);
  vec4 textureB = texture2D(tTextureB, vTexCoord.xy);

  // interpolation
  vec4 texture = mix(textureA, textureB, uAlpha);
  vec4 lightstyle = mix(
    vec4(
      texture2D(tLightStyleA, vec2(vLightStyle.x, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.y, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.z, 0.0)).a,
      texture2D(tLightStyleA, vec2(vLightStyle.w, 0.0)).a
    ),
    vec4(
      texture2D(tLightStyleB, vec2(vLightStyle.x, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.y, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.z, 0.0)).a,
      texture2D(tLightStyleB, vec2(vLightStyle.w, 0.0)).a
    ),
    uAlpha
  );

  vec3 d;

  d.r = dot(
    texture2D(
      tLightmap,
      vec2(vTexCoord.z, vTexCoord.w / 4.0)
    ),
    lightstyle * 43.828125
  );
  d.g = dot(
    texture2D(
      tLightmap,
      vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.25)
    ),
    lightstyle * 43.828125
  );
  d.b = dot(
    texture2D(
      tLightmap,
      vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.5)
    ),
    lightstyle * 43.828125
  );

  gl_FragColor = vec4(
    texture.r * mix(1.0, (d.r + texture2D(tDlight, vTexCoord.zw).r) * (vLightDot * uShadeLight.r + uAmbientLight.r), texture.a),
    texture.g * mix(1.0, (d.g + texture2D(tDlight, vTexCoord.zw).g) * (vLightDot * uShadeLight.g + uAmbientLight.g), texture.a),
    texture.b * mix(1.0, (d.b + texture2D(tDlight, vTexCoord.zw).b) * (vLightDot * uShadeLight.b + uAmbientLight.b), texture.a),
    1.0
  );

  if (gl_FragColor.r == 0.0 && gl_FragColor.g == 0.0 && gl_FragColor.b == 0.0 && texture.a == 0.0) {
    discard;
  }

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
}
