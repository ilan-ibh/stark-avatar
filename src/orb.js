import * as THREE from 'three';

/**
 * JARVIS-style holographic construct.
 * Translated from React Three Fiber (Aegis Presence) to vanilla Three.js.
 *
 * Components:
 *   - Faceted core: low-poly icosahedron with separated panels, per-face shimmer
 *   - Triple inner glow: hot center + mid sphere + outer soft sphere
 *   - Edge lines: primary structural edges + secondary outer shell
 *   - Orbital rings: 4 torus rings with ghost duplicates
 *   - Containment field: outer icosahedron cage + scan sweep ring
 */

// ─── Ring Configurations ───────────────────────────────────

const RING_CONFIGS = [
  { radius: 1.55, tube: 0.006, speedMult: 1.0 },
  { radius: 1.75, tube: 0.004, speedMult: -0.7 },
  { radius: 1.95, tube: 0.003, speedMult: 0.5 },
  { radius: 1.35, tube: 0.007, speedMult: -1.4 },
];

const GHOST_CONFIGS = [
  { radius: 1.58, tube: 0.002 },
  { radius: 1.78, tube: 0.0015 },
  { radius: 1.98, tube: 0.0015 },
  { radius: 1.38, tube: 0.002 },
];

const RING_AXES = {
  idle:      [[0,0,0], [0.6,0,0.3], [1.2,0.9,0], [1.8,0,1.2]],
  thinking:  [[0.3,0.5,0.1], [1.0,0.2,0.8], [0.5,1.4,0.3], [1.5,0.7,0.6]],
  speaking:  [[0.1,0,0.05], [0.8,0.1,0.4], [1.5,0.6,0.1], [2.0,0.2,1.0]],
  listening: [[0.15,0.1,0], [0.9,0,0.15], [1.1,1.1,0.1], [1.6,0.1,1.4]],
  alert:     [[0.5,0.8,0.3], [1.3,0.4,1.0], [0.2,1.6,0.7], [2.2,0.3,0.5]],
};

// ─── Faceted Core ──────────────────────────────────────────

export function createCore() {
  const group = new THREE.Group();
  group.name = 'stark-core-group';

  // Build faceted geometry (non-indexed, shrunk panels)
  const base = new THREE.IcosahedronGeometry(1, 1);
  const edgesGeo = new THREE.EdgesGeometry(base);
  const outerBase = new THREE.IcosahedronGeometry(1.06, 1);
  const outerEdgesGeo = new THREE.EdgesGeometry(outerBase);
  const nonIndexed = base.toNonIndexed();
  const pos = nonIndexed.attributes.position;
  const vertCount = pos.count;
  const faceCount = vertCount / 3;

  const newPositions = new Float32Array(vertCount * 3);
  const faceNormals = [];
  const faceCenters = [];

  for (let i = 0; i < vertCount; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);
    const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3, mz = (az + bz + cz) / 3;

    faceNormals.push(new THREE.Vector3(mx, my, mz).normalize());
    faceCenters.push(new THREE.Vector3(mx, my, mz));

    const shrink = 0.15;
    for (let j = 0; j < 3; j++) {
      const idx = (i + j) * 3;
      const vx = pos.getX(i + j), vy = pos.getY(i + j), vz = pos.getZ(i + j);
      newPositions[idx] = vx + (mx - vx) * shrink;
      newPositions[idx + 1] = vy + (my - vy) * shrink;
      newPositions[idx + 2] = vz + (mz - vz) * shrink;
    }
  }

  const facetedGeo = new THREE.BufferGeometry();
  facetedGeo.setAttribute('position', new THREE.Float32BufferAttribute(newPositions, 3));
  facetedGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(vertCount * 3), 3));
  facetedGeo.computeVertexNormals();

  const basePositions = new Float32Array(newPositions);

  // Panel mesh
  const panelMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 1,
    side: THREE.DoubleSide, depthWrite: false,
  });
  const panelMesh = new THREE.Mesh(facetedGeo, panelMat);
  group.add(panelMesh);

  // Primary edges
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.9 });
  group.add(new THREE.LineSegments(edgesGeo, edgeMat));

  // Secondary outer edges
  const outerEdgeMat = new THREE.LineBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.2 });
  group.add(new THREE.LineSegments(outerEdgesGeo, outerEdgeMat));

  // Triple inner glow
  const innerHotMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
  group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.18, 0), innerHotMat));

  const innerMidMat = new THREE.MeshBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.4 });
  group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.38, 0), innerMidMat));

  const innerSoftMat = new THREE.MeshBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.2 });
  group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), innerSoftMat));

  return {
    group,
    facetedGeo, basePositions, faceNormals, faceCenters, faceCount,
    edgeMat, outerEdgeMat, innerHotMat, innerMidMat, innerSoftMat,
  };
}

// ─── Orbital Rings ─────────────────────────────────────────

export function createRings() {
  const rings = [];

  for (let i = 0; i < 4; i++) {
    const rc = RING_CONFIGS[i];
    const gc = GHOST_CONFIGS[i];
    const ringGroup = new THREE.Group();
    ringGroup.name = `ring-${i}`;

    const ringMat = new THREE.MeshBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.75 });
    ringGroup.add(new THREE.Mesh(new THREE.TorusGeometry(rc.radius, rc.tube, 16, 128), ringMat));

    const ghostMat = new THREE.MeshBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.2 });
    ringGroup.add(new THREE.Mesh(new THREE.TorusGeometry(gc.radius, gc.tube, 8, 128), ghostMat));

    rings.push({ group: ringGroup, mat: ringMat, ghostMat, config: rc, currentAxes: [...RING_AXES.idle[i]] });
  }

  return rings;
}

// ─── Containment Field ─────────────────────────────────────

export function createContainment() {
  const group = new THREE.Group();
  group.name = 'containment';

  const primaryEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.5, 1));
  const primaryMat = new THREE.LineBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.06, depthWrite: false });
  const primaryLines = new THREE.LineSegments(primaryEdges, primaryMat);
  group.add(primaryLines);

  const secondaryEdges = new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.8, 0));
  const secondaryMat = new THREE.LineBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0.03, depthWrite: false });
  const secondaryLines = new THREE.LineSegments(secondaryEdges, secondaryMat);
  group.add(secondaryLines);

  // Scan sweep ring
  const scanMat = new THREE.MeshBasicMaterial({ color: 0x64b4ff, transparent: true, opacity: 0, depthWrite: false });
  const scanMesh = new THREE.Mesh(new THREE.TorusGeometry(2.5, 0.015, 8, 64), scanMat);
  scanMesh.rotation.x = Math.PI / 2;
  scanMesh.visible = false;
  group.add(scanMesh);

  return {
    group, primaryLines, secondaryLines, primaryMat, secondaryMat,
    scanMesh, scanMat,
    scanActive: 0, scanProgress: 0, scanDirection: 1,
  };
}

// ─── Update Functions ──────────────────────────────────────

const _sweepDir = new THREE.Vector3();
const _sweep2Dir = new THREE.Vector3();

export function updateCore(core, sv, time, audioBands) {
  const c = sv.color;
  const intensity = sv.intensity;
  const disp = sv.displacement;
  const glow = sv.innerGlow;
  const color = new THREE.Color(c[0], c[1], c[2]);

  // Rotation + scale
  core.group.rotation.y += sv.rotationSpeed * 0.016;
  core.group.rotation.x += sv.rotationSpeed * 0.016 * 0.3;
  core.group.scale.setScalar(sv.scale);

  // Seam pulse
  const seamPulse = 0.7 + 0.3 * Math.sin(time * 2.5);
  const seamPulseFast = 0.6 + 0.4 * Math.sin(time * 6);

  // Sweeping highlight directions
  const sweepAngle = time * 0.8;
  _sweepDir.set(Math.cos(sweepAngle), Math.sin(sweepAngle * 0.7), Math.sin(sweepAngle * 0.4)).normalize();
  const sweep2Angle = time * 1.3 + 2.0;
  _sweep2Dir.set(Math.sin(sweep2Angle), Math.cos(sweep2Angle * 0.5), Math.cos(sweep2Angle)).normalize();

  const colors = core.facetedGeo.attributes.color.array;
  const positions = core.facetedGeo.attributes.position.array;

  // Audio-driven displacement (replaces simulated audio from Lovable)
  const audioDisp = disp > 0.001
    ? disp * (1.0 + audioBands.bass * 2.0 + audioBands.mid * 1.0)
    : 0;

  for (let fi = 0; fi < core.faceCount; fi++) {
    const n = core.faceNormals[fi];

    // Rolling shimmer via sweep dot products
    const sweep1 = Math.pow(Math.max(0, _sweepDir.dot(n)), 3) * 0.6;
    const sweep2 = Math.pow(Math.max(0, _sweep2Dir.dot(n)), 4) * 0.35;
    const faceShimmer = 0.08 * Math.sin(time * 3.5 + fi * 1.1) + 0.06 * Math.sin(time * 5.2 + fi * 2.3);

    const baseBrightness = 0.15 + intensity * 0.12;
    const faceBrightness = baseBrightness + sweep1 + sweep2 + faceShimmer;

    for (let v = 0; v < 3; v++) {
      const ci = (fi * 3 + v) * 3;
      colors[ci] = c[0] * faceBrightness * intensity;
      colors[ci + 1] = c[1] * faceBrightness * intensity;
      colors[ci + 2] = c[2] * faceBrightness * intensity;
    }

    // Face displacement from audio
    let faceDisp = 0;
    if (audioDisp > 0.001) {
      const wave =
        Math.sin(time * 6.28 + fi * 0.8) * (0.3 + audioBands.bass * 0.5) +
        Math.sin(time * 12.56 + fi * 1.5) * (0.2 + audioBands.mid * 0.3) +
        Math.sin(time * 25.12 + fi * 2.3) * (0.15 + audioBands.treble * 0.2) +
        Math.abs(Math.sin(time * 3.14 + fi * 0.5)) * 0.35;
      faceDisp = audioDisp * wave;
    }

    for (let v = 0; v < 3; v++) {
      const i = (fi * 3 + v) * 3;
      positions[i] = core.basePositions[i] + n.x * faceDisp;
      positions[i + 1] = core.basePositions[i + 1] + n.y * faceDisp;
      positions[i + 2] = core.basePositions[i + 2] + n.z * faceDisp;
    }
  }

  core.facetedGeo.attributes.color.needsUpdate = true;
  core.facetedGeo.attributes.position.needsUpdate = true;

  // Triple inner glow
  const hotInt = glow * 3;
  core.innerHotMat.color.setRGB(
    Math.min(1, c[0] * hotInt + 0.5),
    Math.min(1, c[1] * hotInt + 0.5),
    Math.min(1, c[2] * hotInt + 0.4),
  );
  core.innerHotMat.opacity = 0.5 + glow * 0.15 * seamPulse;

  core.innerMidMat.color.setRGB(c[0] * glow * 2, c[1] * glow * 2, c[2] * glow * 2);
  core.innerMidMat.opacity = 0.3 + glow * 0.15;

  core.innerSoftMat.color.setRGB(c[0] * glow * 1.2, c[1] * glow * 1.2, c[2] * glow * 1.2);
  core.innerSoftMat.opacity = 0.15 + glow * 0.1;

  // Edge glow
  const edgeInt = intensity * 1.5 * seamPulse;
  core.edgeMat.color.setRGB(c[0] * edgeInt, c[1] * edgeInt, c[2] * edgeInt);
  core.edgeMat.opacity = 0.6 + 0.3 * seamPulse;

  const outerInt = intensity * 0.6 * seamPulseFast;
  core.outerEdgeMat.color.setRGB(c[0] * outerInt, c[1] * outerInt, c[2] * outerInt);
  core.outerEdgeMat.opacity = 0.15 + 0.2 * seamPulseFast;
}

export function updateRings(rings, sv, time, dt) {
  const c = sv.color;
  const speed = sv.ringSpeed;
  const intensity = sv.intensity;
  const disp = sv.displacement;
  const state = sv.label;
  const lf = 1 - Math.exp(-dt * 3);
  const axisLf = 1 - Math.exp(-dt * 2.5);
  const targetAxes = RING_AXES[state] || RING_AXES.idle;
  const ringPulse = 0.8 + 0.2 * Math.sin(time * 3);

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i];
    const target = targetAxes[i];

    // Smooth axis orientation
    ring.currentAxes[0] += (target[0] - ring.currentAxes[0]) * axisLf;
    ring.currentAxes[1] += (target[1] - ring.currentAxes[1]) * axisLf;
    ring.currentAxes[2] += (target[2] - ring.currentAxes[2]) * axisLf;

    ring.group.rotation.x = ring.currentAxes[0];
    ring.group.rotation.y = ring.currentAxes[1];
    ring.group.rotation.z = ring.currentAxes[2] + time * speed * ring.config.speedMult * 0.3;

    // Alert wobble
    if (state === 'alert') {
      ring.group.rotation.x += Math.sin(time * 5 + i * 2) * 0.015;
      ring.group.rotation.y += Math.cos(time * 4 + i * 3) * 0.01;
    }

    // Speaking diameter breathe
    if (disp > 0.01) {
      ring.group.scale.setScalar(1 + disp * 0.15 * Math.sin(time * 4 + i * 1.5));
    } else {
      const s = ring.group.scale.x;
      ring.group.scale.setScalar(s + (1 - s) * lf);
    }

    // Ring color
    const pulse = ringPulse * (0.9 + 0.1 * Math.sin(time * 2 + i));
    ring.mat.color.setRGB(c[0] * intensity * 1.3 * pulse, c[1] * intensity * 1.3 * pulse, c[2] * intensity * 1.3 * pulse);

    const ghostPulse = 0.3 + 0.15 * Math.sin(time * 5 + i * 2.5);
    ring.ghostMat.color.setRGB(c[0] * intensity * ghostPulse, c[1] * intensity * ghostPulse, c[2] * intensity * ghostPulse);
    ring.ghostMat.opacity = 0.2 + 0.15 * Math.sin(time * 4 + i);
  }
}

export function updateContainment(cont, sv, time, dt, stateManager) {
  const c = sv.color;
  const pulse = sv.containmentPulse;
  const color = new THREE.Color(c[0], c[1], c[2]);

  cont.primaryMat.color.copy(color);
  cont.primaryMat.opacity = 0.06 + pulse * 0.35 * (0.6 + 0.4 * Math.sin(time * 3));

  cont.secondaryMat.color.copy(color);
  cont.secondaryMat.opacity = 0.03 + pulse * 0.15 * (0.5 + 0.5 * Math.sin(time * 2.5 + 1));

  cont.primaryLines.rotation.y += dt * 0.015;
  cont.primaryLines.rotation.x += dt * 0.008;
  cont.primaryLines.scale.setScalar(1 + pulse * 0.04 * Math.sin(time * 4));

  cont.secondaryLines.rotation.y -= dt * 0.01;
  cont.secondaryLines.rotation.z += dt * 0.006;

  // Scan sweep on state transitions
  if (stateManager.justChanged) {
    stateManager.justChanged = false;
    cont.scanActive = 1.0;
    cont.scanProgress = 0;
    cont.scanDirection = stateManager.scanDirection;
  }

  if (cont.scanActive > 0) {
    cont.scanActive -= dt;
    cont.scanProgress += dt * 1.2;
    const progress = Math.min(cont.scanProgress, 1);
    const startY = -2.8 * cont.scanDirection;
    const endY = 2.8 * cont.scanDirection;
    const eased = 1 - Math.pow(1 - progress, 3);

    cont.scanMesh.position.y = startY + (endY - startY) * eased;
    cont.scanMesh.visible = true;

    const fade = progress < 0.15 ? progress / 0.15
      : progress > 0.7 ? (1 - progress) / 0.3 : 1;
    cont.scanMat.opacity = fade * 0.2;
    cont.scanMat.color.copy(color);
  } else {
    cont.scanMesh.visible = false;
    cont.scanMat.opacity = 0;
  }
}
