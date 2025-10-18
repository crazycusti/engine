precision mediump float;

uniform float uGamma;
uniform float uAlpha;

uniform sampler2D tTextureA;
uniform sampler2D tTextureB;
uniform sampler2D tLightmap;
uniform sampler2D tDlight;
uniform sampler2D tLightStyleA;
uniform sampler2D tLightStyleB;
uniform sampler2D tLuminance;
uniform sampler2D tNormal;
uniform sampler2D tSpecular;
uniform sampler2D tDeluxemap;

uniform bool uPerformDotLighting;
uniform bool uHaveDeluxemap;

uniform vec3 uAmbientLight;
uniform vec3 uShadeLight;

varying vec4 vTexCoord;
varying vec4 vLightStyle;
varying float vLightDot;
varying float vFog;
varying vec3 vNormal;
varying vec3 vLightVec;
varying float vLightMix;
varying vec3 vTangent;
varying vec3 vBitangent;
varying vec3 vViewVec;
uniform vec3 uFogColor;
varying mat3 vAngles;

void main(void) {
  vec4 textureA = texture2D(tTextureA, vTexCoord.xy);
  vec4 textureB = texture2D(tTextureB, vTexCoord.xy);
  vec4 luminance = texture2D(tLuminance, vTexCoord.xy);

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

  vec3 lightmap;
  lightmap.r = dot(texture2D(tLightmap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.00)), lightstyle * 43.828125);
  lightmap.g = dot(texture2D(tLightmap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.25)), lightstyle * 43.828125);
  lightmap.b = dot(texture2D(tLightmap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.50)), lightstyle * 43.828125);

  vec3 staticLight = lightmap + texture2D(tDlight, vTexCoord.zw).rgb;

  float bumpLightDot = 1.0;
  float specFactor = 0.0;
  float lightFactor = 1.0;

  if (uPerformDotLighting) {
    vec3 lightDirection;

    if (uHaveDeluxemap) {
      lightDirection.x = dot(texture2D(tDeluxemap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.00)), lightstyle * 43.828125);
      lightDirection.y = dot(texture2D(tDeluxemap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.25)), lightstyle * 43.828125);
      lightDirection.z = dot(texture2D(tDeluxemap, vec2(vTexCoord.z, vTexCoord.w / 4.0 + 0.50)), lightstyle * 43.828125);
      lightDirection = lightDirection * 2.0 - 1.0;

      // CR: Since we are fixing normals when loading the faces, we need to fix the deluxemap accordingly
      lightDirection.x *= vNormal.x > 0.0 ? 1.0 : -1.0;
      lightDirection.y *= vNormal.y > 0.0 ? 1.0 : -1.0;

      // need to adjust for rotation of the surface
      lightDirection *= vAngles;
    } else {
      // fallback to what the vertex shader has for us
      lightDirection = vLightVec;
    }

    vec4 specular = texture2D(tSpecular, vTexCoord.xy);

    // Sample normal map and convert from [0,1] to [-1,1] range
    vec3 normalPoint = texture2D(tNormal, vTexCoord.xy).xyz;
    vec3 normalMap = normalize(normalPoint * 2.0 - 1.0);

    // TODO: figure out why we need to invert X and Y (might be the textures)
    normalMap.x = -normalMap.x;
    normalMap.y = -normalMap.y;

    // Use interpolated tangent/bitangent supplied by the vertex stream
    vec3 n = vNormal;
    vec3 t = vTangent;
    vec3 b = vBitangent;

    // Gram-Schmidt orthogonalize tangent against normal
    t = normalize(t - n * dot(n, t));
    b = normalize(cross(n, t));

    vec3 N = normalize(t * normalMap.x + b * normalMap.y + n * normalMap.z);
    vec3 L = normalize(lightDirection);
    vec3 V = normalize(vViewVec);

    // Use bumped normal for lighting calculation
    lightFactor = max(0.0, dot(N, L));

    lightFactor = max(dot(N, L), 0.0);
    float specIntensity = texture2D(tSpecular, vTexCoord.xy).r;
    vec3 H = normalize(L + V);
    specFactor = specIntensity * pow(max(dot(N, H), 0.0), 16.0);

    // Add dynamic light contribution using vLightVec
    vec3 dynLightDir = vLightVec;
    float dynLightDot = max(dot(N, dynLightDir), 0.0);

    // Add specular from dynamic light
    vec3 dynH = normalize(dynLightDir + V);
    float dynSpecFactor = specIntensity * pow(max(dot(N, dynH), 0.0), 16.0);

    // Combine both light sources
    lightFactor += dynLightDot * vLightMix; // Mix in dynamic light at reduced intensity
    specFactor += dynSpecFactor * vLightMix; // Add dynamic specular
  }

  // Calculate bump mapping factor - blend between full lighting and bump-modified lighting
  // This prevents completely black surfaces while still allowing bump mapping to have effect

  float minAmbient = 0.5;
  float bumpFactor = minAmbient + (1.0 - minAmbient) * pow(lightFactor, 0.7);

  gl_FragColor = vec4(vec3(
    texture.r * mix(1.0, staticLight.r * bumpFactor * (vLightDot * uShadeLight.r + uAmbientLight.r), texture.a * (1.0 - luminance.r)),
    texture.g * mix(1.0, staticLight.g * bumpFactor * (vLightDot * uShadeLight.g + uAmbientLight.g), texture.a * (1.0 - luminance.g)),
    texture.b * mix(1.0, staticLight.b * bumpFactor * (vLightDot * uShadeLight.b + uAmbientLight.b), texture.a * (1.0 - luminance.b))
  ) + specFactor * staticLight, texture.a);

  if (gl_FragColor.r == 0.0 && gl_FragColor.g == 0.0 && gl_FragColor.b == 0.0 && texture.a == 0.0) {
    discard;
  }

  gl_FragColor.r = pow(gl_FragColor.r, uGamma);
  gl_FragColor.g = pow(gl_FragColor.g, uGamma);
  gl_FragColor.b = pow(gl_FragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, gl_FragColor.rgb, vFog);
  gl_FragColor = vec4(finalRgb, gl_FragColor.a);
}
