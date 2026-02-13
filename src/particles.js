import * as THREE from 'three';

const PARTICLE_COUNT = 800;
const LEAD_COUNT = 40;

/**
 * Standard orbiting particles — small, numerous, forms a shell around the core.
 */
export function createParticles() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const speeds = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.7 + Math.random() * 1.6;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    speeds[i] = 0.3 + Math.random() * 1.4;
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: 0.016,
    color: 0x64b4ff,
    transparent: true,
    opacity: 0.75,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'holo-particles';

  return { points, material, geometry, speeds };
}

/**
 * Lead particles — larger, brighter "data fragment" particles.
 */
export function createLeadParticles() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(LEAD_COUNT * 3);
  const speeds = new Float32Array(LEAD_COUNT);

  for (let i = 0; i < LEAD_COUNT; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.9 + Math.random() * 1.2;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    speeds[i] = 0.5 + Math.random() * 1.0;
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.PointsMaterial({
    size: 0.045,
    color: 0x64b4ff,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.name = 'lead-particles';

  return { points, material, geometry, speeds };
}

/**
 * Update standard particles — orbital motion with boundary clamping.
 */
export function updateParticles(particles, sv, time, dt) {
  const speed = sv.particleSpeed;
  const c = sv.color;
  const intensity = sv.intensity;

  particles.material.color.setRGB(c[0] * intensity, c[1] * intensity, c[2] * intensity);

  const pos = particles.geometry.attributes.position;
  const arr = pos.array;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const idx = i * 3;
    const x = arr[idx], z = arr[idx + 2];
    const angle = speed * particles.speeds[i] * dt * 0.3;

    arr[idx] = x * Math.cos(angle) - z * Math.sin(angle);
    arr[idx + 2] = x * Math.sin(angle) + z * Math.cos(angle);
    arr[idx + 1] += (Math.random() - 0.5) * speed * dt * 0.05;

    // Boundary clamp — keep particles in the shell
    const r = Math.sqrt(arr[idx] ** 2 + arr[idx + 1] ** 2 + arr[idx + 2] ** 2);
    if (r > 3.5 || r < 1.5) {
      const scale = (1.7 + Math.random() * 1.6) / r;
      arr[idx] *= scale;
      arr[idx + 1] *= scale;
      arr[idx + 2] *= scale;
    }
  }

  pos.needsUpdate = true;
}

/**
 * Update lead particles — brighter, pulsing, slightly different orbit.
 */
export function updateLeadParticles(lead, sv, time, dt) {
  const speed = sv.particleSpeed;
  const c = sv.color;
  const intensity = sv.intensity;
  const leadPulse = 1.5 + 0.5 * Math.sin(time * 3);

  lead.material.color.setRGB(c[0] * intensity * leadPulse, c[1] * intensity * leadPulse, c[2] * intensity * leadPulse);
  lead.material.opacity = 0.6 + 0.3 * Math.sin(time * 4);

  const pos = lead.geometry.attributes.position;
  const arr = pos.array;

  for (let i = 0; i < LEAD_COUNT; i++) {
    const idx = i * 3;
    const x = arr[idx], z = arr[idx + 2];
    const angle = speed * lead.speeds[i] * dt * 0.25;

    arr[idx] = x * Math.cos(angle) - z * Math.sin(angle);
    arr[idx + 2] = x * Math.sin(angle) + z * Math.cos(angle);
    arr[idx + 1] += (Math.random() - 0.5) * speed * dt * 0.03;

    const r = Math.sqrt(arr[idx] ** 2 + arr[idx + 1] ** 2 + arr[idx + 2] ** 2);
    if (r > 3.3 || r < 1.6) {
      const scale = (1.9 + Math.random() * 1.2) / r;
      arr[idx] *= scale;
      arr[idx + 1] *= scale;
      arr[idx + 2] *= scale;
    }
  }

  pos.needsUpdate = true;
}
