// ─── 3D Simplex Noise (Ashima Arts / Stefan Gustavson) ─────
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
  + i.y + vec4(0.0, i1.y, i2.y, 1.0))
  + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// ─── Fractional Brownian Motion (4 octaves) ───────────────
float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 4; i++) {
    value += amplitude * snoise(p * frequency);
    frequency *= 2.2;
    amplitude *= 0.45;
  }
  return value;
}

// ─── Turbulence (absolute noise for sharp creases) ────────
float turbulence(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;
  for (int i = 0; i < 3; i++) {
    value += amplitude * abs(snoise(p * frequency));
    frequency *= 2.0;
    amplitude *= 0.5;
  }
  return value;
}

// ─── Uniforms ─────────────────────────────────────────────
uniform float uTime;
uniform float uNoiseSpeed;
uniform float uNoiseAmplitude;
uniform float uBreathScale;
uniform float uAudioLevel;
uniform float uPulseStrength;
uniform float uBass;
uniform float uMid;
uniform float uTreble;

// ─── Varyings ─────────────────────────────────────────────
varying vec3 vNormal;
varying vec3 vWorldPosition;
varying vec3 vObjectPosition;  // original position on sphere
varying float vDisplacement;
varying float vFresnel;
varying float vAudioWave;
varying float vNoiseDetail;    // fine noise for fragment energy veins

void main() {
  vec3 nPos = normalize(position);
  float theta = atan(nPos.z, nPos.x);
  float phi = acos(clamp(nPos.y, -1.0, 1.0));

  // ── Breathing ──
  float breath = 1.0 + sin(uTime * 0.8) * uBreathScale;
  // Secondary slower breath for organic feel
  breath += sin(uTime * 0.3) * uBreathScale * 0.5;

  // ── 4-Octave FBM displacement (rich, organic surface) ──
  vec3 noisePos = nPos * 2.0 + uTime * uNoiseSpeed;
  float baseNoise = fbm(noisePos);

  // Add turbulence layer for sharp creases (like energy containment lines)
  float creases = turbulence(nPos * 3.0 + uTime * uNoiseSpeed * 0.7) * 0.3;

  float displacement = (baseNoise * 0.75 + creases * 0.25) * uNoiseAmplitude;

  // ── Audio-reactive traveling waves ──
  float bassWave = sin(phi * 2.0 - uTime * 4.5) * 0.6
                 + sin(phi * 3.0 + uTime * 3.0) * 0.4;
  bassWave *= uBass;

  float midWave = sin(theta * 3.0 + phi * 2.0 - uTime * 6.0) * 0.5
                + sin(theta * 2.0 - phi * 3.0 + uTime * 5.0) * 0.3
                + sin(theta * 4.0 + uTime * 7.0) * 0.2;
  midWave *= uMid;

  float trebleWave = sin(theta * 6.0 + phi * 5.0 - uTime * 12.0) * 0.4
                   + sin(theta * 8.0 - phi * 4.0 + uTime * 10.0) * 0.3
                   + sin(phi * 7.0 + uTime * 14.0) * 0.3;
  trebleWave *= uTreble;

  float audioDisp = bassWave * 0.18 + midWave * 0.10 + trebleWave * 0.04;
  audioDisp += uAudioLevel * 0.06;
  displacement += audioDisp;

  vAudioWave = abs(bassWave) * 0.5 + abs(midWave) * 0.35 + abs(trebleWave) * 0.15;

  // ── Pulse ──
  float pulse = sin(uTime * 3.0) * uPulseStrength;
  // Secondary faster pulse for complexity
  pulse += sin(uTime * 7.0) * uPulseStrength * 0.3;
  displacement += pulse;

  vDisplacement = displacement;

  // ── Fine-detail noise for fragment shader energy veins ──
  // Computed here in vertex shader for performance, interpolated to fragment
  vNoiseDetail = snoise(nPos * 5.0 + uTime * uNoiseSpeed * 1.5);

  // ── Displace ──
  vec3 newPosition = position * breath + normal * displacement;
  vec4 worldPos = modelMatrix * vec4(newPosition, 1.0);
  vWorldPosition = worldPos.xyz;
  vObjectPosition = nPos;
  vNormal = normalize(normalMatrix * normal);

  // ── Multi-power fresnel (computed here, used in fragment) ──
  vec3 viewDir = normalize(cameraPosition - worldPos.xyz);
  float NdotV = max(dot(vNormal, viewDir), 0.0);
  vFresnel = 1.0 - NdotV;

  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
