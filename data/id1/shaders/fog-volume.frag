precision mediump float;

uniform vec3 uViewOrigin;
uniform mat3 uViewAngles;
uniform mat4 uPerspective;
uniform float uGamma;

uniform vec3 uFogVolumeColor;
uniform float uFogVolumeDensity;
uniform float uFogVolumeMaxOpacity;
uniform vec3 uFogVolumeMins;
uniform vec3 uFogVolumeMaxs;

uniform sampler2D tDepth;
uniform sampler2D tLightProbe;
uniform vec3 uLightProbeRes;
uniform float uHasLightProbe;
uniform vec2 uScreenSize;

// Dynamic lights (point lights): position.xyz + radius in w, color.rgb + unused w
const int MAX_FOG_DLIGHTS = 8;
uniform int uDlightCount;
uniform vec4 uDlightPos[MAX_FOG_DLIGHTS];
uniform vec4 uDlightColor[MAX_FOG_DLIGHTS];

varying vec3 vWorldPos;

/**
 * Compute the 2D texture UV for a light probe texel at integer grid position (ix, iy, iz).
 * The 3D grid is packed into a 2D texture with Z slices laid out horizontally.
 * Texture width = resX * resZ, height = resY.
 */
vec2 lightProbeUV(float ix, float iy, float iz) {
  float texWidth = uLightProbeRes.x * uLightProbeRes.z;
  float px = iz * uLightProbeRes.x + ix;
  return vec2((px + 0.5) / texWidth, (iy + 0.5) / uLightProbeRes.y);
}

/**
 * Sample the light probe grid at a world position using manual trilinear interpolation.
 * Maps the world position into the fog volume's [0,1] space, then samples 8 corner
 * texels and interpolates to get the light color at that point.
 */
vec3 sampleLightProbe(vec3 worldPos) {
  if (uHasLightProbe < 0.5) {
    return vec3(1.0);
  }

  // Normalize world position to [0,1] within the fog volume AABB
  vec3 size = uFogVolumeMaxs - uFogVolumeMins;
  vec3 uvw = clamp((worldPos - uFogVolumeMins) / size, 0.0, 1.0);

  // Scale to grid coordinates (0..res-1)
  vec3 gridPos = uvw * (uLightProbeRes - 1.0);

  // 8 corner integer positions
  vec3 g0 = floor(gridPos);
  vec3 g1 = min(g0 + 1.0, uLightProbeRes - 1.0);
  vec3 f = gridPos - g0;

  // Sample 8 corners of the enclosing grid cell
  vec3 c000 = texture2D(tLightProbe, lightProbeUV(g0.x, g0.y, g0.z)).rgb;
  vec3 c100 = texture2D(tLightProbe, lightProbeUV(g1.x, g0.y, g0.z)).rgb;
  vec3 c010 = texture2D(tLightProbe, lightProbeUV(g0.x, g1.y, g0.z)).rgb;
  vec3 c110 = texture2D(tLightProbe, lightProbeUV(g1.x, g1.y, g0.z)).rgb;
  vec3 c001 = texture2D(tLightProbe, lightProbeUV(g0.x, g0.y, g1.z)).rgb;
  vec3 c101 = texture2D(tLightProbe, lightProbeUV(g1.x, g0.y, g1.z)).rgb;
  vec3 c011 = texture2D(tLightProbe, lightProbeUV(g0.x, g1.y, g1.z)).rgb;
  vec3 c111 = texture2D(tLightProbe, lightProbeUV(g1.x, g1.y, g1.z)).rgb;

  // Trilinear interpolation
  vec3 c00 = mix(c000, c100, f.x);
  vec3 c10 = mix(c010, c110, f.x);
  vec3 c01 = mix(c001, c101, f.x);
  vec3 c11 = mix(c011, c111, f.x);

  vec3 c0 = mix(c00, c10, f.y);
  vec3 c1 = mix(c01, c11, f.y);

  return mix(c0, c1, f.z);
}

/**
 * Convert a depth buffer value (non-linear) to linear view-space distance.
 * Derives near/far from the actual perspective matrix elements:
 *   uPerspective[2][2] = -(far+near)/(far-near)
 *   uPerspective[3][2] = -2*near*far/(far-near)
 */
float linearizeDepth(float depth) {
  float z_ndc = depth * 2.0 - 1.0;
  return uPerspective[3][2] / (z_ndc + uPerspective[2][2]);
}

/**
 * Intersect a ray with an axis-aligned bounding box.
 * Returns tNear and tFar (signed distances along the ray).
 * If tNear > tFar, there is no intersection.
 */
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir, vec3 boxMin, vec3 boxMax) {
  vec3 invDir = 1.0 / rayDir;
  vec3 t1 = (boxMin - rayOrigin) * invDir;
  vec3 t2 = (boxMax - rayOrigin) * invDir;
  vec3 tMin = min(t1, t2);
  vec3 tMax = max(t1, t2);
  float tNear = max(max(tMin.x, tMin.y), tMin.z);
  float tFar = min(min(tMax.x, tMax.y), tMax.z);
  return vec2(tNear, tFar);
}

void main(void) {
  // Screen UV for depth texture lookup
  vec2 screenUV = gl_FragCoord.xy / uScreenSize;

  // Sample scene depth and linearize
  float rawDepth = texture2D(tDepth, screenUV).r;
  float sceneDepth = linearizeDepth(rawDepth);

  // Ray from camera through this fragment in world space
  vec3 rayDir = normalize(vWorldPos - uViewOrigin);

  // Intersect the ray with the fog volume AABB
  vec2 tHit = intersectAABB(uViewOrigin, rayDir, uFogVolumeMins, uFogVolumeMaxs);

  // Clamp entry to 0 (camera might be inside the volume)
  float tEntry = max(tHit.x, 0.0);
  float tExit = tHit.y;

  // No intersection or volume is entirely behind camera
  if (tEntry >= tExit || tExit <= 0.0) {
    discard;
  }

  // Convert scene view-depth to world-space ray distance.
  // The view-space Y axis IS the forward direction, and linearizeDepth
  // returns the distance along forward. Dividing by the cosine of the angle
  // between the ray and the forward vector gives the radial ray distance.
  vec3 forward = vec3(uViewAngles[0][1], uViewAngles[1][1], uViewAngles[2][1]);
  float cosAngle = dot(rayDir, forward);
  float sceneRayDist = (abs(cosAngle) > 0.001) ? sceneDepth / cosAngle : 100000.0;

  // Also clamp by the back-face distance (useful for non-box brushes)
  float backFaceDist = length(vWorldPos - uViewOrigin);
  tExit = min(tExit, min(backFaceDist, sceneRayDist));

  // Fog thickness is the distance the ray travels through the volume
  float thickness = max(0.0, tExit - tEntry);

  // Exponential fog falloff
  float fogFactor = 1.0 - exp(-uFogVolumeDensity * thickness);
  fogFactor = clamp(fogFactor, 0.0, uFogVolumeMaxOpacity);

  // Discard fully transparent fragments
  if (fogFactor < 0.001) {
    discard;
  }

  // Sample light probe at the midpoint of the fog ray to tint the fog
  // by the local lighting environment (colored lights, etc.)
  vec3 fogMidpoint = uViewOrigin + rayDir * ((tEntry + tExit) * 0.5);
  vec3 lightTint = sampleLightProbe(fogMidpoint);

  // Accumulate dynamic light contributions at the fog midpoint.
  // Each dlight acts as a point light with linear falloff based on radius.
  vec3 dlightContrib = vec3(0.0);
  for (int i = 0; i < MAX_FOG_DLIGHTS; i++) {
    if (i >= uDlightCount) {
      break;
    }
    vec3 dlPos = uDlightPos[i].xyz;
    float dlRadius = uDlightPos[i].w;
    vec3 dlColor = uDlightColor[i].rgb;
    float dist = distance(fogMidpoint, dlPos);
    float atten = max(0.0, 1.0 - dist / dlRadius);
    dlightContrib += dlColor * atten;
  }

  // Apply gamma to light-tinted fog color (static probe + dynamic lights)
  vec3 color = pow(uFogVolumeColor * lightTint + dlightContrib, vec3(uGamma));

  gl_FragColor = vec4(color, fogFactor);
}
