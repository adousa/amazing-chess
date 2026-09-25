// The empty stony beach: overcast sky, grey sea with surf, pebbles, a sea stack and the
// flat rock the game is played on. Everything is procedural (no image assets).
import * as THREE from 'three';
import { fbm3, rng } from './noise';
import { TABLE_TOP } from './pieces';

export const SEA_LEVEL = -0.3;
export const FOG_LEVEL = 0.36; // linear grey shared by fog and the sky's horizon

const GLSL_NOISE = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 6; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
`;

/** Where the water meets the stones (world z) along x. Shared by the beach and the sea shader. */
const shoreZ = (x: number) => -6.3 + Math.sin(x * 0.12) * 0.6 + Math.sin(x * 0.31 + 1.0) * 0.3;
const SHORE_GLSL = /* glsl */ `float shoreZ(float x) { return -6.3 + sin(x * 0.12) * 0.6 + sin(x * 0.31 + 1.0) * 0.3; }`;

export function groundHeight(x: number, z: number): number {
  const slope = z > -3 ? 0 : (z + 3) * 0.1;
  const bumps = fbm3(x * 0.3, 0, z * 0.3) * 0.25 + fbm3(x * 2.1, 3, z * 2.1) * 0.04;
  const nearTable = Math.min(1, Math.hypot(x, z) / 1.6);
  return slope + bumps * (0.25 + 0.75 * nearTable) - 0.02;
}

export interface Environment {
  update(t: number, camera: THREE.Camera): void;
}

export function buildEnvironment(scene: THREE.Scene): Environment {
  const fogColor = new THREE.Color().setScalar(FOG_LEVEL);
  scene.fog = new THREE.FogExp2(fogColor, 0.02);
  scene.background = fogColor;

  // ---- light: bright overcast from the sea, soft fill from our side ----------------
  scene.add(new THREE.HemisphereLight(0xdedede, 0x2a2a2a, 1.25));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-2.5, 6, -7);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -1.6;
  key.shadow.camera.right = key.shadow.camera.top = 1.6;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 20;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 4;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(3, 4, 6);
  scene.add(fill);

  // ---- sky dome ---------------------------------------------------------------------
  const skyU = { uTime: { value: 0 }, uHorizon: { value: FOG_LEVEL } };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(500, 48, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: skyU,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform float uHorizon;
        varying vec3 vDir;
        ${GLSL_NOISE}
        void main() {
          vec3 d = normalize(vDir);
          float h = max(d.y, 0.0);
          vec2 uv = d.xz / (h + 0.08) * 0.55;
          float n = fbm(uv * 0.9 + vec2(uTime * 0.012, uTime * 0.005));
          float n2 = fbm(uv * 2.6 - vec2(uTime * 0.02, 0.0));
          float clouds = smoothstep(0.38, 0.72, n * 0.75 + n2 * 0.35);
          float hz = exp(-h * 7.0);
          vec3 sky = mix(vec3(0.16), vec3(uHorizon * 1.25), hz);
          // pale light breaking through low over the sea
          float glow = pow(max(dot(d, normalize(vec3(-0.15, 0.06, -1.0))), 0.0), 10.0);
          sky += glow * 0.5 * (1.0 - clouds * 0.6);
          vec3 cloudCol = mix(vec3(0.07), vec3(0.34), n2) + glow * 0.15;
          vec3 col = mix(sky, cloudCol, clouds * (1.0 - hz * 0.85));
          col = mix(col, vec3(uHorizon), smoothstep(0.06, 0.0, d.y));
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  sky.renderOrder = -1;
  scene.add(sky);

  // ---- sea ----------------------------------------------------------------------------
  const seaU = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uCam: { value: new THREE.Vector3() },
  };
  const seaGeo = new THREE.PlaneGeometry(900, 500, 300, 160);
  seaGeo.rotateX(-Math.PI / 2);
  seaGeo.translate(0, 0, -3.5 - 250);
  const sea = new THREE.Mesh(
    seaGeo,
    new THREE.ShaderMaterial({
      fog: true,
      uniforms: seaU,
      vertexShader: /* glsl */ `
        uniform float uTime;
        varying vec3 vWorld; varying float vWave;
        #include <fog_pars_vertex>
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          float wave = sin(w.x * 0.35 + uTime * 0.8) * 0.05
                     + sin(w.z * 0.9 + uTime * 1.3 + w.x * 0.2) * 0.05
                     + sin((w.x + w.z) * 1.7 + uTime * 2.1) * 0.015;
          w.y += wave;
          vWave = wave; vWorld = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCam;
        varying vec3 vWorld; varying float vWave;
        #include <fog_pars_fragment>
        ${GLSL_NOISE}
        ${SHORE_GLSL}
        void main() {
          float dist = length(vWorld.xz - uCam.xz);
          vec3 col = mix(vec3(0.05), vec3(0.3), smoothstep(4.0, 90.0, dist));
          col += smoothstep(0.02, 0.09, vWave) * 0.06;
          col += (noise(vWorld.xz * vec2(0.6, 2.5) + vec2(0.0, uTime * 0.3)) - 0.5) * 0.05;
          // surf: bands of foam rolling in, and a lace of foam on the stones
          float dz = vWorld.z - shoreZ(vWorld.x);
          float band = sin(dz * 2.2 + uTime * 1.1 + sin(vWorld.x * 0.6) * 1.3);
          float breakN = noise(vWorld.xz * vec2(1.3, 3.0) + vec2(uTime * 0.2, 0.0));
          float foam = smoothstep(0.55, 1.0, band) * smoothstep(-7.0, -0.5, dz) * smoothstep(0.35, 0.7, breakN);
          foam += smoothstep(-1.2, 0.2, dz) * (0.55 + 0.45 * sin(uTime * 0.9 + vWorld.x * 0.5)) * breakN;
          col = mix(col, vec3(0.85), clamp(foam, 0.0, 1.0) * 0.85);
          gl_FragColor = vec4(col, 1.0);
          #include <fog_fragment>
        }`,
    }),
  );
  sea.position.y = SEA_LEVEL;
  scene.add(sea);

  // ---- stony beach --------------------------------------------------------------------
  const groundGeo = new THREE.PlaneGeometry(140, 140, 240, 240);
  groundGeo.rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundHeight(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 1, map: grainTexture(40) }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  // pebbles, densest around the players, thinning out towards the water
  const rand = rng(7);
  const pebbleGeo = new THREE.IcosahedronGeometry(1, 1);
  const count = 14000;
  const pebbles = new THREE.InstancedMesh(
    pebbleGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }),
    count,
  );
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const col = new THREE.Color();
  let placed = 0;
  while (placed < count) {
    const r = 0.5 + Math.pow(rand(), 1.5) * 18;
    const a = rand() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (z < shoreZ(x) + 0.3) continue;
    const big = rand() < 0.006;
    const s = big ? 0.05 + rand() * 0.08 : 0.008 + Math.pow(rand(), 2) * 0.032;
    e.set(rand() * 0.4, rand() * Math.PI * 2, rand() * 0.4);
    q.setFromEuler(e);
    m.compose(
      new THREE.Vector3(x, groundHeight(x, z) + s * 0.15, z),
      q,
      new THREE.Vector3(s * (1 + rand() * 0.5), s * (0.45 + rand() * 0.25), s * (1 + rand() * 0.5)),
    );
    pebbles.setMatrixAt(placed, m);
    pebbles.setColorAt(placed, col.setScalar(0.06 + Math.pow(rand(), 1.5) * 0.4));
    placed++;
  }
  pebbles.receiveShadow = true;
  scene.add(pebbles);

  // ---- rocks: a dark sea stack, a few boulders, the players' table and seats -----------
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.95, flatShading: true });
  const addRock = (seed: number, pos: [number, number, number], scale: [number, number, number], rotY = 0) => {
    const r = new THREE.Mesh(rockGeometry(seed), rockMat);
    r.position.set(...pos);
    r.scale.set(...scale);
    r.rotation.y = rotY;
    r.castShadow = r.receiveShadow = true;
    scene.add(r);
    return r;
  };
  addRock(1, [4.2, -0.6, -19], [5.2, 6.5, 3.6], 0.4);
  addRock(2, [8.5, -0.8, -21], [2.6, 3.2, 2.4], 1.2);
  addRock(3, [-7.5, -0.35, -10], [1.6, 0.9, 1.3], 0.2);
  addRock(4, [6.5, -0.3, -4.5], [1.1, 0.7, 1.0], 2.1);
  addRock(5, [-4, -0.1, 3.5], [0.9, 0.5, 0.8], 0.8);
  addRock(6, [0, 0.02, 0.62], [0.32, 0.46, 0.28]); // the Knight's seat
  addRock(8, [0, 0.02, -0.62], [0.34, 0.46, 0.3]); // Death's seat

  const table = new THREE.Mesh(tableGeometry(), new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.9, flatShading: true }));
  table.castShadow = table.receiveShadow = true;
  scene.add(table);

  return {
    update(t, camera) {
      skyU.uTime.value = t;
      seaU.uTime.value = t;
      seaU.uCam.value.copy(camera.position);
      sky.position.copy(camera.position);
    },
  };
}

function rockGeometry(seed: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = fbm3(v.x * 1.4 + seed * 9, v.y * 1.4, v.z * 1.4, 5) * 0.55 + fbm3(v.x * 5 + seed, v.y * 5, v.z * 5) * 0.12;
    v.multiplyScalar(1 + n);
    if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3; // sit flat-ish in the stones
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** A low, flat-topped boulder under the board (an ellipse, wider than deep). */
function tableGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1.14, 1, 13, 5);
  g.translate(0, 0.5, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue;
    const a = Math.atan2(z, x);
    const k = 1 + fbm3(Math.cos(a) * 2.2, y * 2.5, Math.sin(a) * 2.2) * 0.22 - (y > 0.99 ? 0.03 : 0);
    p.setXYZ(i, x * k, y, z * k);
  }
  g.scale(0.56, TABLE_TOP, 0.37);
  g.computeVertexNormals();
  return g;
}

function grainTexture(repeat: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(256, 256);
  const rand = rng(11);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + rand() * 120;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
