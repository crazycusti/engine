precision mediump float;

uniform float uGamma;
uniform float uInterpolation;
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
uniform vec3 uDynamicShadeLight;

varying vec4 vTexCoord;
varying vec4 vLightStyle;
varying float vLightDot;
varying float vDynamicLightDot;
varying float vFog;
varying vec3 vNormal;
varying vec3 vLightVec;
varying float vLightMix;
varying vec3 vTangent;
varying vec3 vViewVec;
uniform vec3 uFogColor;
varying mat3 vAngles;

void main(void) {
  // Combine texture samples at the start
  vec4 textureA = texture2D(tTextureA, vTexCoord.xy);
  vec4 textureB = texture2D(tTextureB, vTexCoord.xy);
  vec4 luminance = texture2D(tLuminance, vTexCoord.xy);

  // interpolation
  vec4 texture = mix(textureA, textureB, uInterpolation);

  // Pre-calculate lightstyle constant
  const float LIGHTSTYLE_SCALE = 43.828125;

  // Optimize lightstyle sampling - use texture lookups more efficiently
  vec4 lightstyleA = vec4(
    texture2D(tLightStyleA, vec2(vLightStyle.x, 0.0)).a,
    texture2D(tLightStyleA, vec2(vLightStyle.y, 0.0)).a,
    texture2D(tLightStyleA, vec2(vLightStyle.z, 0.0)).a,
    texture2D(tLightStyleA, vec2(vLightStyle.w, 0.0)).a
  );
  vec4 lightstyleB = vec4(
    texture2D(tLightStyleB, vec2(vLightStyle.x, 0.0)).a,
    texture2D(tLightStyleB, vec2(vLightStyle.y, 0.0)).a,
    texture2D(tLightStyleB, vec2(vLightStyle.z, 0.0)).a,
    texture2D(tLightStyleB, vec2(vLightStyle.w, 0.0)).a
  );
  vec4 lightstyle = mix(lightstyleA, lightstyleB, uInterpolation) * LIGHTSTYLE_SCALE;

  // Pre-calculate shared texture coordinates
  float lightmapW = vTexCoord.w * 0.25; // divide once instead of three times
  vec2 lightmapCoordR = vec2(vTexCoord.z, lightmapW);
  vec2 lightmapCoordG = vec2(vTexCoord.z, lightmapW + 0.25);
  vec2 lightmapCoordB = vec2(vTexCoord.z, lightmapW + 0.5);

  // Sample all lightmap channels
  vec4 lightmapR = texture2D(tLightmap, lightmapCoordR);
  vec4 lightmapG = texture2D(tLightmap, lightmapCoordG);
  vec4 lightmapB = texture2D(tLightmap, lightmapCoordB);

  vec3 lightmap = vec3(
    dot(lightmapR, lightstyle),
    dot(lightmapG, lightstyle),
    dot(lightmapB, lightstyle)
  );

  vec3 staticLight = lightmap + texture2D(tDlight, vTexCoord.zw).rgb;

  float bumpLightDot = 1.0;
  float specFactor = 0.0;
  float lightFactor = 1.0;

  if (uPerformDotLighting) {
    vec3 lightDirection;

    if (uHaveDeluxemap) {
      // Reuse pre-calculated deluxemap coordinates
      vec4 deluxemapR = texture2D(tDeluxemap, lightmapCoordR);
      vec4 deluxemapG = texture2D(tDeluxemap, lightmapCoordG);
      vec4 deluxemapB = texture2D(tDeluxemap, lightmapCoordB);

      lightDirection = vec3(
        dot(deluxemapR, lightstyle),
        dot(deluxemapG, lightstyle),
        dot(deluxemapB, lightstyle)
      );

      // CR: Since we are fixing normals when loading the faces, we need to fix the deluxemap accordingly
      lightDirection.x *= vNormal.x > 0.0 ? 1.0 : -1.0;
      lightDirection.y *= vNormal.y > 0.0 ? 1.0 : -1.0;

      // need to adjust for rotation of the surface
      lightDirection *= vAngles;
    } else {
      // fallback to what the vertex shader has for us
      lightDirection = vLightVec;
    }

    // Sample normal and specular maps once
    vec3 normalPoint = texture2D(tNormal, vTexCoord.xy).xyz;
    float specIntensity = texture2D(tSpecular, vTexCoord.xy).r;

    // Convert normal from [0,1] to [-1,1] and invert X,Y in one operation
    vec3 normalMap = normalize(vec3(
      -(normalPoint.x * 2.0 - 1.0),
      -(normalPoint.y * 2.0 - 1.0),
      normalPoint.z * 2.0 - 1.0
    ));

    // Gram-Schmidt orthogonalize tangent against normal (inline to avoid extra variables)
    vec3 t = normalize(vTangent - vNormal * dot(vNormal, vTangent));
    vec3 b = normalize(cross(vNormal, t));

    // Build TBN transform and apply to normal
    vec3 N = normalize(t * normalMap.x + b * normalMap.y + vNormal * normalMap.z);
    vec3 L = normalize(lightDirection);
    vec3 V = normalize(vViewVec);

    // Calculate lighting (removed duplicate lightFactor assignment)
    lightFactor = max(dot(N, L), 0.0);
    vec3 H = normalize(L + V);
    specFactor = specIntensity * pow(max(dot(N, H), 0.0), 16.0);

    // Add dynamic light contribution
    float dynLightDot = max(dot(N, vLightVec), 0.0);
    vec3 dynH = normalize(vLightVec + V);
    float dynSpecFactor = specIntensity * pow(max(dot(N, dynH), 0.0), 16.0);

    // Combine both light sources
    lightFactor += dynLightDot * vLightMix;
    specFactor += dynSpecFactor * vLightMix;
  }

  // Calculate bump mapping factor - blend between full lighting and bump-modified lighting
  // This prevents completely black surfaces while still allowing bump mapping to have effect
  const float minAmbient = 0.5;
  float bumpFactor = minAmbient + (1.0 - minAmbient) * pow(lightFactor, 0.7);

  // Pre-calculate common factors to avoid redundant calculations
  vec3 shadeAmbient = vLightDot * uShadeLight + uAmbientLight + vDynamicLightDot * uDynamicShadeLight;
  vec3 lightingFactor = staticLight * bumpFactor * shadeAmbient;
  vec3 luminanceMask = texture.a * (vec3(1.0) - luminance.rgb);

  // Combine lighting in one operation per channel
  vec3 finalColor = texture.rgb * mix(vec3(1.0), lightingFactor, luminanceMask) + specFactor * staticLight;

  // Apply gamma correction using pow on vec3 (single operation instead of 3)
  finalColor = pow(finalColor, vec3(uGamma));

  // Apply fog
  finalColor = mix(uFogColor, finalColor, vFog);

  gl_FragColor = vec4(finalColor, texture.a * uAlpha);
}
