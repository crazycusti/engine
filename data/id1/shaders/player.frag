#version 300 es
precision highp float;
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

// Shadow mapping
uniform mediump sampler2DShadow tShadowMap;
uniform highp sampler2D tWorldDepthMap;
uniform float uShadowEnabled;
uniform float uShadowDarkness;
uniform float uShadowMaxDist;

// Point light shadow mapping
uniform mediump samplerCubeShadow tPointShadowMap;
uniform vec3 uPointLightPos;
uniform float uPointLightRadius;
uniform float uPointShadowEnabled;

in vec2 vTexCoord;
in float vLightDot;
in float vDynamicLightDot;
in float vFog;
in vec4 vShadowCoord;
in vec3 vWorldPos;
uniform vec3 uFogColor;

void main(void) {
  vec4 texel = texture(tTexture, vTexCoord);
  vec4 player = texture(tPlayer, vTexCoord);

  // Local entity shadow — small local depth map, BSP-light-driven direction.
  // Fades smoothly to fully-lit at the coverage edge (no hard clip).
  float shadow = 1.0;
  if (uShadowEnabled > 0.5) {
    vec3 shadowCoord = vShadowCoord.xyz / vShadowCoord.w * 0.5 + 0.5;
    if (shadowCoord.z >= 0.0 && shadowCoord.z <= 1.0) {
      float edgeDist = max(abs(shadowCoord.x * 2.0 - 1.0), abs(shadowCoord.y * 2.0 - 1.0));
      float fade = 1.0 - smoothstep(0.7, 1.0, edgeDist);
      if (fade > 0.0) {
        float rawShadow = texture(tShadowMap, shadowCoord);
        // Read the closest world surface depth from the light (no comparison).
        // If this fragment is behind a world surface (wall), the entity
        // shadow is bleeding through solid geometry — suppress it.
        float worldDepth = texture(tWorldDepthMap, shadowCoord.xy).r;
        if (worldDepth < 1.0) {
          float depthDiff = shadowCoord.z - worldDepth;
          float wallBlock = smoothstep(uShadowMaxDist * 0.5, uShadowMaxDist, depthDiff);
          rawShadow = mix(rawShadow, 1.0, wallBlock);
        }
        shadow = mix(1.0, mix(uShadowDarkness, 1.0, rawShadow), fade);
      }
    }
  }

  // Point light shadow
  float pointShadow = 1.0;
  if (uPointShadowEnabled > 0.5) {
    vec3 fragToLight = vWorldPos - uPointLightPos;
    float fragDist = length(fragToLight);
    if (fragDist < uPointLightRadius) {
      vec3 absFTL = abs(fragToLight);
      float viewZ = max(absFTL.x, max(absFTL.y, absFTL.z));
      float n = 1.0;
      float f = uPointLightRadius;
      float refDepth = (n * f / (n - f)) / viewZ + n / (n - f);
      refDepth = refDepth * 0.5 + 0.5;
      pointShadow = texture(tPointShadowMap, vec4(fragToLight, refDepth));
    }
  }

  vec3 lighting = vec3(
    vLightDot * uShadeLight.r + uAmbientLight.r + vDynamicLightDot * uDynamicShadeLight.r * pointShadow,
    vLightDot * uShadeLight.g + uAmbientLight.g + vDynamicLightDot * uDynamicShadeLight.g * pointShadow,
    vLightDot * uShadeLight.b + uAmbientLight.b + vDynamicLightDot * uDynamicShadeLight.b * pointShadow
  ) * shadow;

  fragColor.r = mix(mix(texel.r, uTop.r * (1.0 / 191.25) * player.x, player.y), uBottom.r * (1.0 / 191.25) * player.z, player.w) * mix(1.0, lighting.r, texel.a);
  fragColor.g = mix(mix(texel.g, uTop.g * (1.0 / 191.25) * player.x, player.y), uBottom.g * (1.0 / 191.25) * player.z, player.w) * mix(1.0, lighting.g, texel.a);
  fragColor.b = mix(mix(texel.b, uTop.b * (1.0 / 191.25) * player.x, player.y), uBottom.b * (1.0 / 191.25) * player.z, player.w) * mix(1.0, lighting.b, texel.a);

  fragColor.r = pow(fragColor.r, uGamma);
  fragColor.g = pow(fragColor.g, uGamma);
  fragColor.b = pow(fragColor.b, uGamma);
  // apply fog
  vec3 finalRgb = mix(uFogColor, fragColor.rgb, vFog);
  fragColor = vec4(finalRgb, fragColor.a * uAlpha);
}

