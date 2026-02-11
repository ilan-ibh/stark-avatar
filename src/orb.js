import * as THREE from 'three';
import orbVertexShader from './shaders/orb.vert?raw';
import orbFragmentShader from './shaders/orb.frag?raw';

/**
 * Creates the central orb mesh with custom shader material.
 */
export function createOrb() {
  // High-poly icosahedron — 64 subdivisions for fluid organic surface
  const geometry = new THREE.IcosahedronGeometry(1.0, 64);

  const uniforms = {
    uTime: { value: 0.0 },
    uNoiseSpeed: { value: 0.15 },
    uNoiseAmplitude: { value: 0.02 },
    uBreathScale: { value: 0.012 },
    uAudioLevel: { value: 0.0 },
    uPulseStrength: { value: 0.0 },
    uBass: { value: 0.0 },
    uMid: { value: 0.0 },
    uTreble: { value: 0.0 },
    uColor: { value: new THREE.Color(38 / 255, 128 / 255, 255 / 255) },
    uCoreColor: { value: new THREE.Color(15 / 255, 50 / 255, 140 / 255) },
    uFresnelIntensity: { value: 1.2 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader: orbVertexShader,
    fragmentShader: orbFragmentShader,
    uniforms,
    transparent: false,
    depthWrite: true,
    depthTest: true,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'stark-orb';

  return { mesh, uniforms, material };
}

/**
 * Creates an inner core glow — a small bright sphere inside the orb
 * that simulates a contained energy source.
 */
export function createCore() {
  const geometry = new THREE.IcosahedronGeometry(0.35, 16);

  const uniforms = {
    uTime: { value: 0.0 },
    uColor: { value: new THREE.Color(38 / 255, 128 / 255, 255 / 255) },
    uIntensity: { value: 1.0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        // Gentle core breathing (offset from main orb breath)
        float breath = 1.0 + sin(uTime * 1.2 + 1.0) * 0.08;
        vec3 pos = position * breath;

        vec4 worldPos = modelMatrix * vec4(pos, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);

        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uIntensity;
      varying vec3 vNormal;
      varying vec3 vViewDir;

      void main() {
        float NdotV = max(dot(vNormal, vViewDir), 0.0);

        // Inverse fresnel — brightest at center, falls off at edges
        float centerGlow = pow(NdotV, 1.5);
        // Soft edge fade (no hard silhouette)
        float edgeFade = smoothstep(0.0, 0.3, NdotV);

        // Pulsing brightness
        float pulse = 0.85 + sin(uTime * 1.8) * 0.15;

        // HDR core — push well above 1.0 for bloom to catch
        vec3 color = uColor * 2.0 * centerGlow * edgeFade * pulse * uIntensity;

        // Slight white-hot center
        color += vec3(0.3) * pow(centerGlow, 3.0) * edgeFade * pulse * uIntensity;

        float alpha = edgeFade * 0.7 * uIntensity;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'stark-core';

  return { mesh, uniforms: uniforms };
}

/**
 * Creates an atmospheric halo — a slightly larger sphere around the orb
 * with a pure fresnel glow. This creates the "contained energy field" look.
 */
export function createAtmosphere() {
  const geometry = new THREE.IcosahedronGeometry(1.45, 32);

  const uniforms = {
    uColor: { value: new THREE.Color(38 / 255, 128 / 255, 255 / 255) },
    uIntensity: { value: 1.0 },
    uTime: { value: 0.0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;

      void main() {
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPos = worldPos.xyz;
        vNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(cameraPosition - worldPos.xyz);
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vViewDir;
      varying vec3 vWorldPos;

      void main() {
        float NdotV = max(dot(vNormal, vViewDir), 0.0);

        // Pure fresnel — only visible at the edges
        float fresnel = pow(1.0 - NdotV, 4.0);

        // Outer haze layer (very soft, wide)
        float outerHaze = pow(1.0 - NdotV, 2.5) * 0.08;

        // Subtle breathing modulation
        float breathe = 0.9 + sin(uTime * 0.6) * 0.1;

        float alpha = (fresnel * 0.25 + outerHaze) * uIntensity * breathe;
        vec3 color = uColor * 0.8 * (fresnel + outerHaze * 0.3);

        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide, // render inside faces so it wraps around the orb
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'stark-atmosphere';

  return { mesh, uniforms: uniforms };
}

/**
 * Update all orb-related uniforms from state manager's current values.
 */
export function updateOrb(orbUniforms, coreUniforms, atmosUniforms, stateValues, time, audioBands) {
  const c = stateValues.color;
  const cc = stateValues.coreColor;

  // Main orb
  orbUniforms.uTime.value = time;
  orbUniforms.uNoiseSpeed.value = stateValues.noiseSpeed;
  orbUniforms.uNoiseAmplitude.value = stateValues.noiseAmplitude;
  orbUniforms.uBreathScale.value = stateValues.breathScale;
  orbUniforms.uPulseStrength.value = stateValues.pulseStrength;
  orbUniforms.uAudioLevel.value = audioBands.level;
  orbUniforms.uBass.value = audioBands.bass;
  orbUniforms.uMid.value = audioBands.mid;
  orbUniforms.uTreble.value = audioBands.treble;
  orbUniforms.uColor.value.setRGB(c[0], c[1], c[2]);
  orbUniforms.uCoreColor.value.setRGB(cc[0], cc[1], cc[2]);

  // Inner core
  coreUniforms.uTime.value = time;
  coreUniforms.uColor.value.setRGB(c[0], c[1], c[2]);
  // Core intensity varies slightly with audio
  coreUniforms.uIntensity.value = 0.5 + audioBands.level * 0.3;

  // Atmosphere
  atmosUniforms.uTime.value = time;
  atmosUniforms.uColor.value.setRGB(c[0], c[1], c[2]);
  // Atmosphere — subtle, doesn't overpower surface detail
  atmosUniforms.uIntensity.value = 0.4 + audioBands.level * 0.2;
}
