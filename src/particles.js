import * as THREE from 'three';

const ORBIT_COUNT = 1800;
const DUST_COUNT = 800;

/**
 * Creates the main orbiting particle system around the orb.
 * Larger, brighter particles with clear orbital motion.
 */
export function createParticles() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(ORBIT_COUNT * 3);
  const seeds = new Float32Array(ORBIT_COUNT * 4);
  const sizes = new Float32Array(ORBIT_COUNT);

  for (let i = 0; i < ORBIT_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.3 + Math.random() * 0.9;

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    seeds[i * 4] = 0.2 + Math.random() * 0.8;     // speed
    seeds[i * 4 + 1] = 1.25 + Math.random() * 0.85; // radius
    seeds[i * 4 + 2] = Math.random() * Math.PI * 2;  // phase
    seeds[i * 4 + 3] = (Math.random() - 0.5) * 0.6;  // tilt

    sizes[i] = 0.4 + Math.random() * 1.2;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(38 / 255, 128 / 255, 255 / 255) },
      uParticleSpeed: { value: 0.3 },
      uParticleSpread: { value: 1.0 },
      uAudioLevel: { value: 0.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uParticleSpeed;
      uniform float uParticleSpread;
      uniform float uAudioLevel;
      uniform float uPixelRatio;

      attribute vec4 aSeed;
      attribute float aSize;

      varying float vAlpha;
      varying float vGlow;

      void main() {
        float speed = aSeed.x * uParticleSpeed;
        float radius = aSeed.y * uParticleSpread + uAudioLevel * 0.3;
        float phase = aSeed.z;
        float tilt = aSeed.w;

        float angle = uTime * speed + phase;
        float angle2 = uTime * speed * 0.6 + phase * 1.5;
        float angle3 = uTime * speed * 0.3 + phase * 0.7;

        // More complex 3D orbital path
        vec3 orbitalPos;
        orbitalPos.x = cos(angle) * radius;
        orbitalPos.y = sin(angle) * tilt * radius + sin(angle2) * 0.25 + cos(angle3) * 0.1;
        orbitalPos.z = sin(angle) * radius;

        float dist = length(orbitalPos);
        // Closer particles are brighter
        vAlpha = smoothstep(3.0, 1.1, dist) * (0.25 + 0.75 * aSize);
        // Extra glow for particles near the orb surface
        vGlow = smoothstep(1.8, 1.2, dist);

        vec4 mvPos = modelViewMatrix * vec4(orbitalPos, 1.0);
        gl_Position = projectionMatrix * mvPos;

        float sizeBase = 0.018 * aSize;
        gl_PointSize = sizeBase * uPixelRatio * (300.0 / -mvPos.z);
        gl_PointSize = max(gl_PointSize, 0.5);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;
      varying float vGlow;

      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;

        // Soft gaussian-ish falloff for premium look
        float alpha = exp(-d * d * 8.0) * vAlpha;

        // Hotter center (slightly white), colored edges
        vec3 color = mix(uColor * 1.8, uColor * 1.2 + vec3(0.3), exp(-d * d * 20.0));

        // Particles near the orb glow brighter
        color *= (1.0 + vGlow * 0.5);

        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'stark-particles';

  return { points, material };
}

/**
 * Creates a fine dust layer — very small, slow, wide-spread particles
 * that create atmospheric depth around the orb.
 */
export function createDust() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(DUST_COUNT * 3);
  const seeds = new Float32Array(DUST_COUNT * 4);
  const sizes = new Float32Array(DUST_COUNT);

  for (let i = 0; i < DUST_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.6 + Math.random() * 2.0;

    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);

    seeds[i * 4] = 0.05 + Math.random() * 0.2;    // very slow
    seeds[i * 4 + 1] = 1.6 + Math.random() * 2.0;  // wide radius
    seeds[i * 4 + 2] = Math.random() * Math.PI * 2;
    seeds[i * 4 + 3] = (Math.random() - 0.5) * 0.8; // more tilt variation

    sizes[i] = 0.2 + Math.random() * 0.6;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(38 / 255, 128 / 255, 255 / 255) },
      uParticleSpeed: { value: 0.1 },
      uParticleSpread: { value: 1.0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uParticleSpeed;
      uniform float uParticleSpread;
      uniform float uPixelRatio;

      attribute vec4 aSeed;
      attribute float aSize;

      varying float vAlpha;

      void main() {
        float speed = aSeed.x * uParticleSpeed;
        float radius = aSeed.y * uParticleSpread;
        float phase = aSeed.z;
        float tilt = aSeed.w;

        float angle = uTime * speed + phase;

        vec3 orbitalPos;
        orbitalPos.x = cos(angle) * radius;
        orbitalPos.y = sin(angle * 0.7) * tilt * radius * 0.5;
        orbitalPos.z = sin(angle) * radius;

        float dist = length(orbitalPos);
        // Very dim, fades with distance
        vAlpha = smoothstep(4.5, 1.5, dist) * aSize * 0.15;
        // Twinkle
        vAlpha *= 0.6 + sin(uTime * 0.5 + phase * 10.0) * 0.4;

        vec4 mvPos = modelViewMatrix * vec4(orbitalPos, 1.0);
        gl_Position = projectionMatrix * mvPos;

        gl_PointSize = 0.008 * aSize * uPixelRatio * (300.0 / -mvPos.z);
        gl_PointSize = max(gl_PointSize, 0.3);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAlpha;

      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float alpha = exp(-d * d * 10.0) * vAlpha;
        gl_FragColor = vec4(uColor * 1.2, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'stark-dust';

  return { points, material };
}

/**
 * Update main particle uniforms.
 */
export function updateParticles(material, stateValues, time, audioLevel) {
  material.uniforms.uTime.value = time;
  material.uniforms.uParticleSpeed.value = stateValues.particleSpeed;
  material.uniforms.uParticleSpread.value = stateValues.particleSpread;
  material.uniforms.uAudioLevel.value = audioLevel;
  material.uniforms.uColor.value.setRGB(
    stateValues.color[0], stateValues.color[1], stateValues.color[2]
  );
}

/**
 * Update dust particle uniforms.
 */
export function updateDust(material, stateValues, time) {
  material.uniforms.uTime.value = time;
  material.uniforms.uParticleSpeed.value = stateValues.particleSpeed * 0.3;
  material.uniforms.uParticleSpread.value = stateValues.particleSpread;
  material.uniforms.uColor.value.setRGB(
    stateValues.color[0], stateValues.color[1], stateValues.color[2]
  );
}
