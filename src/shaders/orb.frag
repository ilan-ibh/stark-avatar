uniform vec3 uColor;
uniform vec3 uCoreColor;
uniform float uFresnelIntensity;
uniform float uTime;
uniform float uAudioLevel;

varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;
varying float vDisplacement;
varying float vFresnel;
varying float vAudioWave;
varying float vNoiseDetail;

void main() {
  // ── Multi-layer Fresnel ──
  // Multiple falloff powers create layered depth: sharp rim + soft halo + broad gradient
  float fresnelSharp = pow(vFresnel, 4.0);    // very tight rim line
  float fresnelMid   = pow(vFresnel, 2.0);    // medium edge glow
  float fresnelSoft  = pow(vFresnel, 1.0);    // broad gradient
  float fresnelCore  = pow(1.0 - vFresnel, 2.0); // center intensity

  // ── Base color: deep core to bright edge ──
  vec3 deepCore = uCoreColor * 0.25;
  vec3 midTone  = mix(uCoreColor, uColor, 0.5) * 0.55;
  vec3 edge     = uColor * 1.1;

  // Three-stop gradient from center to rim
  vec3 baseColor = mix(deepCore, midTone, fresnelSoft * 0.7);
  baseColor = mix(baseColor, edge, fresnelMid * uFresnelIntensity * 0.8);

  // ── Sharp rim highlight (the "contained energy" edge) ──
  // Crisp line at the very edge — like light refracting at a boundary
  vec3 rimColor = uColor * 1.6;
  baseColor += rimColor * fresnelSharp * 0.35;

  // ── Spectral edge shift ──
  // Slight color temperature shift at the rim — holographic quality
  vec3 spectralShift = vec3(
    uColor.r * 0.7,
    uColor.g * 1.1,
    uColor.b * 1.3
  );
  baseColor = mix(baseColor, spectralShift * 1.2, fresnelSharp * 0.2);

  // ── Inner core glow ──
  // Center of the orb has a soft glow — energy source within
  float coreGlow = fresnelCore * 0.2;
  coreGlow *= 0.85 + sin(uTime * 1.5) * 0.15;
  baseColor += uColor * coreGlow;

  // ── Energy veins ──
  // Noise-based bright lines that flow across the surface
  // Creates the look of contained energy pathways / plasma filaments
  float veins = smoothstep(0.25, 0.45, vNoiseDetail) * smoothstep(0.65, 0.45, vNoiseDetail);
  veins = pow(veins, 0.8) * 1.5;
  // Veins pulse gently
  veins *= 0.7 + sin(uTime * 2.5 + vObjectPosition.y * 3.0) * 0.3;
  baseColor += uColor * veins * 0.35;

  // ── Displacement ridges ──
  // Peaks glow brighter — gives surface topology visual depth
  float ridgeGlow = smoothstep(0.0, 0.12, vDisplacement);
  ridgeGlow = pow(ridgeGlow, 1.5) * 0.35;
  baseColor += uColor * ridgeGlow * 0.8;

  // Valleys get slightly darker for depth
  float valley = smoothstep(0.0, -0.05, vDisplacement) * 0.15;
  baseColor *= (1.0 - valley);

  // ── Audio wave glow (speaking state) ──
  float audioGlow = vAudioWave * uAudioLevel * 1.4;
  baseColor += uColor * audioGlow;

  // ── Subsurface scattering approximation ──
  // Light wrapping around the edges — translucent energy look
  float sss = pow(vFresnel, 1.5) * (1.0 - pow(vFresnel, 4.0)) * 0.15;
  baseColor += uColor * sss;

  // ── Micro shimmer ──
  // Very fine surface detail that catches light — like energy micro-structure
  float shimmer = sin(vWorldPosition.x * 40.0 + vWorldPosition.y * 35.0 + uTime * 3.0)
                * sin(vWorldPosition.y * 45.0 + vWorldPosition.z * 30.0 - uTime * 2.0);
  shimmer = shimmer * 0.03 * (0.5 + fresnelMid * 0.5);
  baseColor += uColor * shimmer;

  // ── Subtle HDR boost for bloom ──
  // Only the very hottest spots push above 1.0 — keeps detail readable
  float bloomBoost = fresnelSharp * 0.4 + ridgeGlow * 0.2 + audioGlow * 0.15;
  baseColor *= (1.0 + bloomBoost * 0.3);

  gl_FragColor = vec4(baseColor, 1.0);
}
