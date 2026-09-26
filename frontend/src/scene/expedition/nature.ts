// The living parts of the Expedition world: a Gerstner-wave sea with foam, sky reflection and
// sun glitter; a meadow of wind-blown grass blades and flowers; swaying trees and bushes
// (Quaternius' CC0 "Stylized Nature MegaKit", see public/models/nature/CREDITS.md); and flocks
// of birds wheeling over the water.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3, rng } from '../noise';

export const SEA_Y = -3;
/** Where the headland drops into the sea (world z). */
const SHORE_Z = -25.5;

/** Height of the meadow at (x, z); shared by the terrain mesh, the grass and the trees. */
export function landHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  let y = -0.72 + fbm3(x * 0.06, 0, z * 0.06) * 3 * Math.min(1, Math.max(0, (r - 12) / 10));
  if (z < -22) y -= Math.pow((-22 - z) * 0.5, 1.6); // cliff edge towards the sea
  return y + Math.max(0, r - 20) * 0.06;
}

/** Shared clock for every wind/wave shader. */
export const windTime = { value: 0 };

const NOISE = /* glsl */ `
  float nh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float nn(vec2 p) {
    vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(nh(i), nh(i + vec2(1, 0)), u.x), mix(nh(i + vec2(0, 1)), nh(i + vec2(1, 1)), u.x), u.y);
  }
`;

// ---- sea ---------------------------------------------------------------------------------

export function buildSea(scene: THREE.Scene, sunDir: THREE.Vector3): THREE.Mesh {
  // a grid that is dense near the shore and the middle of the view, sparse far away
  const nx = 320, nz = 220;
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  let k = 0;
  for (let j = 0; j <= nz; j++) {
    const v = j / nz;
    const z = SHORE_Z + 3 - 900 * Math.pow(v, 2.2);
    for (let i = 0; i <= nx; i++) {
      const u = (i / nx) * 2 - 1;
      const x = Math.sign(u) * 900 * Math.pow(Math.abs(u), 1.9);
      pos[k++] = x;
      pos[k++] = 0;
      pos[k++] = z;
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, b, c, b, d, c); // counter-clockwise from above
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);

  const mat = new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uTime: windTime, uSun: { value: sunDir.clone() } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vW; varying vec3 vN; varying float vCrest;
      #include <fog_pars_vertex>
      vec3 wave(vec4 w, vec3 p, float fade, inout vec3 tan, inout vec3 bin) {
        float k = 6.28318 / w.w;
        float c = sqrt(9.8 / k) * 0.55;
        vec2 d = normalize(w.xy);
        float f = k * (dot(d, p.xz) - c * uTime);
        float s = w.z * fade;
        float a = s / k;
        tan += vec3(-d.x * d.x * s * sin(f), d.x * s * cos(f), -d.x * d.y * s * sin(f));
        bin += vec3(-d.x * d.y * s * sin(f), d.y * s * cos(f), -d.y * d.y * s * sin(f));
        return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
      }
      void main() {
        vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
        float dist = length(p.xz - cameraPosition.xz);
        float fadeS = 1.0 - smoothstep(60.0, 220.0, dist); // small waves vanish with distance
        float fadeL = 1.0 - smoothstep(250.0, 700.0, dist);
        vec3 tan = vec3(1, 0, 0), bin = vec3(0, 0, 1);
        vec3 q = p;
        q += wave(vec4(1.0, 0.55, 0.16, 26.0), p, fadeL, tan, bin);
        q += wave(vec4(0.25, 1.0, 0.14, 15.0), p, fadeL, tan, bin);
        q += wave(vec4(-0.7, 0.8, 0.12, 8.5), p, fadeS, tan, bin);
        q += wave(vec4(0.9, -0.35, 0.10, 4.7), p, fadeS, tan, bin);
        q += wave(vec4(-0.2, 1.0, 0.08, 2.9), p, fadeS, tan, bin);
        vN = normalize(cross(bin, tan));
        vCrest = (q.y - p.y);
        vW = q;
        vec4 mvPosition = viewMatrix * vec4(q, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun;
      varying vec3 vW; varying vec3 vN; varying float vCrest;
      #include <fog_pars_fragment>
      ${NOISE}
      vec3 sky(vec3 d) {
        float h = max(d.y, 0.0);
        vec3 c = mix(vec3(1.0, 0.74, 0.45), vec3(0.78, 0.4, 0.3), smoothstep(0.0, 0.12, h));
        c = mix(c, vec3(0.22, 0.3, 0.48), smoothstep(0.08, 0.35, h));
        return c + vec3(1.0, 0.7, 0.4) * pow(max(dot(d, uSun), 0.0), 6.0) * 0.5;
      }
      void main() {
        float t = uTime;
        vec3 N = vN;
        // ripples on top of the swell
        vec2 rp = vW.xz * 0.9;
        N.x += (nn(rp + vec2(t * 0.6, t * 0.2)) - 0.5) * 0.35 + (nn(rp * 2.7 - t * 0.5) - 0.5) * 0.18;
        N.z += (nn(rp + vec2(-t * 0.3, t * 0.5) + 7.0) - 0.5) * 0.35 + (nn(rp * 2.3 + t * 0.4 + 3.0) - 0.5) * 0.18;
        N = normalize(N);
        vec3 V = normalize(cameraPosition - vW);
        float dist = length(vW.xz - cameraPosition.xz);
        float fres = 0.06 + 0.94 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        vec3 R = reflect(-V, N);
        R.y = abs(R.y);
        vec3 deep = vec3(0.015, 0.075, 0.11);
        vec3 shallow = vec3(0.04, 0.2, 0.24);
        vec3 water = mix(shallow, deep, smoothstep(0.0, 60.0, vW.z > -40.0 ? 0.0 : -vW.z - 40.0));
        water += vec3(0.06, 0.26, 0.22) * smoothstep(0.2, 1.1, vCrest) * 0.7; // light through the crests
        vec3 col = mix(water, sky(R) * 0.75, clamp(fres * 0.7, 0.0, 0.55));
        // troughs darker, crests lighter: the swell reads even against the bright horizon
        col *= mix(0.62, 1.12, smoothstep(-0.9, 0.9, vCrest));
        // the sun on the water: a hot core, a wide sheen and glitter
        float sd = max(dot(R, uSun), 0.0);
        col += vec3(1.0, 0.85, 0.6) * (pow(sd, 700.0) * 10.0 + pow(sd, 70.0) * 0.3);
        float gl = step(0.975, nh(floor(vW.xz * 11.0) + floor(t * 5.0)));
        col += vec3(1.0, 0.9, 0.7) * gl * pow(sd, 4.0) * 5.0;
        // foam: on the crests and in bands rolling onto the rocks
        float fn = nn(vW.xz * 1.3 + vec2(t * 0.4, 0.0)) * 0.6 + nn(vW.xz * 4.0 - t * 0.3) * 0.4;
        float crest = vCrest / 1.1;
        float foam = smoothstep(0.78, 1.0, crest * 0.75 + fn * 0.4) * (1.0 - smoothstep(80.0, 200.0, dist));
        float dz = vW.z - ${SHORE_Z.toFixed(1)};
        float surf = smoothstep(-4.0, 0.4, dz) * (0.5 + 0.5 * sin(dz * 2.6 + t * 1.6 + fn * 5.0));
        foam = max(foam, smoothstep(0.55, 0.9, surf * (0.5 + fn)));
        col = mix(col, vec3(1.0, 0.96, 0.9), clamp(foam, 0.0, 1.0) * 0.9);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
      }`,
  });
  const sea = new THREE.Mesh(geo, mat);
  sea.position.y = SEA_Y;
  sea.frustumCulled = false;
  scene.add(sea);
  return sea;
}

// ---- grass and flowers ---------------------------------------------------------------------

/** MeshStandardMaterial whose vertices bend in the wind by uv.y², with a dark base. */
function windyMaterial(opts: THREE.MeshStandardMaterialParameters, bend: number) {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying float vH;\n${NOISE}`)
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace(
        '#include <project_vertex>',
        `vH = uv.y;
        vec4 wp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          wp = instanceMatrix * wp;
        #endif
        wp = modelMatrix * wp;
        // rolling gusts across the field plus a quick flutter
        float gust = nn(wp.xz * 0.045 + vec2(uTime * 0.22, uTime * 0.07));
        float sway = sin(uTime * 1.7 + wp.x * 0.35 + wp.z * 0.22) * 0.35 + sin(uTime * 3.1 + wp.x * 1.3 - wp.z * 0.9) * 0.15;
        float amt = (0.25 + gust * 1.1) * uv.y * uv.y * ${bend.toFixed(3)};
        wp.x += (sway + gust * 0.9) * amt;
        wp.z += (sway * 0.4 - gust * 0.35) * amt;
        wp.y -= amt * amt * 0.25;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vH;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= mix(0.32, 1.18, vH);');
  };
  m.customProgramCacheKey = () => `windy${bend}`;
  return m;
}

/** A tapered, slightly curved blade, base at the origin, uv.y = height fraction. */
function bladeGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.075, 1, 1, 4).translate(0, 0.5, 0);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    p.setX(i, p.getX(i) * (1 - y * 0.92));
    p.setZ(i, y * y * 0.18);
  }
  g.computeVertexNormals();
  return g;
}

function flowerGeometry(): THREE.BufferGeometry {
  const stalk = new THREE.CylinderGeometry(0.008, 0.012, 0.55, 4, 3).translate(0, 0.275, 0);
  const head = new THREE.IcosahedronGeometry(0.055, 0).scale(1, 0.6, 1).translate(0, 0.57, 0);
  const g = mergeGeometries([stalk.toNonIndexed(), head.toNonIndexed()])!;
  const p = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) uv.setY(i, Math.min(1, p.getY(i) / 0.55));
  return g;
}

export function buildGrass(scene: THREE.Scene, reduced: boolean) {
  const r = rng(314);
  const place = (count: number, geo: THREE.BufferGeometry, mat: THREE.Material, colors: number[], hMin: number, hMax: number, minR: number, maxR: number) => {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    let n = 0;
    while (n < count) {
      // densest just around the plaza, thinning out towards the edge of the headland
      const rr = minR + Math.pow(r(), 1.6) * (maxR - minR);
      const a = r() * Math.PI * 2;
      const x = Math.cos(a) * rr, z = Math.sin(a) * rr + 4;
      if (z < -20.5 || Math.hypot(x, z) < 10.2) continue;
      const h = hMin + r() * (hMax - hMin);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), r() * Math.PI * 2);
      m.compose(new THREE.Vector3(x, landHeight(x, z) - 0.03, z), q, new THREE.Vector3(1 + r() * 0.6, h, 1 + r() * 0.6));
      mesh.setMatrixAt(n, m);
      mesh.setColorAt(n, c.set(colors[Math.floor(r() * colors.length)]).offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.08));
      n++;
    }
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return mesh;
  };
  const blades = reduced ? 22000 : 60000;
  place(blades, bladeGeometry(), windyMaterial({}, 0.55), [0x7f8a3c, 0x96963f, 0x6a7a34, 0xa89a4c, 0x5f7032, 0xb8a656], 0.35, 0.95, 10, 44);
  place(reduced ? 1200 : 3200, flowerGeometry(), windyMaterial({ emissive: 0x220404 }, 0.4), [0xc4182e, 0xd92a3a, 0xa0101f, 0xf2e8d2, 0xe8b64a], 0.8, 1.3, 10.5, 36);
}

// ---- trees and bushes (glTF) ---------------------------------------------------------------------

interface TreeSpot {
  model: 'tree_a' | 'tree_b' | 'twisted' | 'bush' | 'bush_flowers';
  x: number;
  z: number;
  h: number;
  tint?: 'crimson' | 'amber' | 'gold';
}

const TINTS: Record<NonNullable<TreeSpot['tint']>, [number, number]> = {
  crimson: [0x5a0712, 0xd8323c],
  amber: [0x6a1a08, 0xe8702c],
  gold: [0x6a3a08, 0xf0b040],
};

/** Adds wind sway to a model material; `leaf` also flutters and can be re-tinted. */
function swayMaterial(src: THREE.MeshStandardMaterial, leaf: boolean, height: number, tint?: [number, number]) {
  const m = src.clone();
  if (leaf) {
    m.transparent = false;
    m.alphaTest = 0.45;
    m.depthWrite = true;
    m.side = THREE.DoubleSide;
  }
  m.metalness = 0;
  m.roughness = 0.85;
  const uA = { value: new THREE.Color(tint?.[0] ?? 0) };
  const uB = { value: new THREE.Color(tint?.[1] ?? 0) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.uniforms.uTintA = uA;
    sh.uniforms.uTintB = uB;
    sh.uniforms.uH = { value: height };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime, uH;').replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vec2 org = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
      float ph = org.x * 0.37 + org.y * 0.21;
      float hh = clamp(transformed.y / uH, 0.0, 1.2);
      float sway = sin(uTime * 0.9 + ph) * 0.6 + sin(uTime * 1.7 + ph * 1.7) * 0.25;
      transformed.x += sway * 0.035 * uH * hh * hh;
      transformed.z += cos(uTime * 0.8 + ph) * 0.018 * uH * hh * hh;
      ${leaf ? 'transformed += normal * sin(uTime * 5.0 + dot(position, vec3(9.0, 7.0, 11.0) / uH * 6.0)) * 0.008 * uH * hh;' : ''}`,
    );
    if (leaf && tint)
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uTintA, uTintB;')
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
          diffuseColor.rgb = mix(uTintA, uTintB, smoothstep(0.05, 0.5, lum));`,
        );
  };
  m.customProgramCacheKey = () => `sway${leaf ? 1 : 0}${tint ? 1 : 0}`;
  return m;
}

let modelsPromise: Promise<Map<string, THREE.Object3D>> | null = null;
/** Loads the tree/bush models once; every caller gets the same cached set. */
function loadModels(): Promise<Map<string, THREE.Object3D>> {
  if (!modelsPromise) {
    const loader = new GLTFLoader();
    const base = `${import.meta.env.BASE_URL}models/nature/`;
    const names: TreeSpot['model'][] = ['tree_a', 'tree_b', 'twisted', 'bush', 'bush_flowers'];
    modelsPromise = Promise.all(names.map((n) => loader.loadAsync(`${base}${n}.glb`).then((g) => [n, g.scene] as const))).then(
      (loaded) => new Map<string, THREE.Object3D>(loaded),
    );
  }
  return modelsPromise;
}

/** One swaying, re-tinted copy of a model, `h` tall, standing on its own origin. */
function makeTree(models: Map<string, THREE.Object3D>, model: TreeSpot['model'], h: number, tint?: TreeSpot['tint']): THREE.Group {
  const obj = models.get(model)!.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const height = Math.max(0.01, box.max.y - box.min.y);
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const next = mats.map((mm) => {
      const sm = mm as THREE.MeshStandardMaterial;
      const leaf = /leaves|flower/i.test(sm.name) || sm.transparent;
      const t = leaf && tint && !/flower/i.test(sm.name) ? TINTS[tint] : undefined;
      return swayMaterial(sm, leaf, height, t);
    });
    mesh.material = Array.isArray(mesh.material) ? next : next[0];
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  // sway works in model units (the shader uses local y), so the scale lives on a parent
  const holder = new THREE.Group();
  holder.add(obj);
  obj.position.y = -box.min.y;
  holder.scale.setScalar(h / height);
  return holder;
}

export interface Planting {
  model: TreeSpot['model'];
  /** Position in the parent's space; the base of the model sits here. */
  pos: THREE.Vector3;
  /** Height in the parent's units. */
  h: number;
  tint?: TreeSpot['tint'];
}

/** Adds trees/bushes to `parent` once the models have loaded; `onFail` if they can't be. */
export function plant(parent: THREE.Object3D, items: Planting[], onFail?: () => void, seed = 9) {
  loadModels()
    .then((models) => {
      const r = rng(seed);
      for (const it of items) {
        const t = makeTree(models, it.model, it.h, it.tint);
        t.position.copy(it.pos);
        t.rotation.y = r() * Math.PI * 2;
        parent.add(t);
      }
    })
    .catch((e) => {
      console.warn('tree models failed to load', e);
      onFail?.();
    });
}

export function loadTrees(scene: THREE.Scene, spots: TreeSpot[], onFail: () => void) {
  plant(
    scene,
    spots.map((s) => ({ model: s.model, h: s.h, tint: s.tint, pos: new THREE.Vector3(s.x, landHeight(s.x, s.z) - 0.1, s.z) })),
    onFail,
  );
}

/** Where the trees stand: groves either side of the plaza, framing the view out to sea. */
export const TREE_SPOTS: TreeSpot[] = [
  { model: 'twisted', x: -16, z: -9, h: 7.5 },
  { model: 'tree_a', x: -21, z: 2, h: 8.5, tint: 'crimson' },
  { model: 'twisted', x: -27, z: -5, h: 9.5 },
  { model: 'tree_b', x: -15, z: 13, h: 7, tint: 'amber' },
  { model: 'tree_a', x: -24, z: 11, h: 9, tint: 'gold' },
  { model: 'twisted', x: 17, z: -12, h: 8 },
  { model: 'tree_b', x: 22, z: 1, h: 8.5, tint: 'crimson' },
  { model: 'tree_a', x: 28, z: -7, h: 9.5, tint: 'amber' },
  { model: 'twisted', x: 16, z: 15, h: 7 },
  { model: 'tree_b', x: 26, z: 12, h: 9, tint: 'gold' },
  { model: 'tree_a', x: -33, z: -14, h: 10, tint: 'crimson' },
  { model: 'twisted', x: 34, z: -16, h: 10 },
  { model: 'bush_flowers', x: -12.5, z: -6, h: 1.3 },
  { model: 'bush', x: -13, z: 4, h: 1.5 },
  { model: 'bush_flowers', x: 12.8, z: -3, h: 1.2 },
  { model: 'bush', x: 13.5, z: 7, h: 1.6 },
  { model: 'bush', x: -18, z: -14, h: 1.8 },
  { model: 'bush_flowers', x: 19, z: -16, h: 1.4 },
  { model: 'bush', x: -11.5, z: 12, h: 1.3 },
  { model: 'bush_flowers', x: 11, z: 13, h: 1.3 },
];

// ---- birds ---------------------------------------------------------------------------------------

export function buildBirds(scene: THREE.Scene) {
  const geo = new THREE.BufferGeometry();
  // a body point, two wing tips (x = ±1); y of the tips is scaled to flap
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0.35, -1, 0.25, -0.2, 0, 0, -0.15, 0, 0, 0.35, 0, 0, -0.15, 1, 0.25, -0.2], 3));
  geo.computeVertexNormals();
  const flocks = [
    { c: new THREE.Vector3(-10, 14, -60), r: 22, n: 14, sp: 0.18 },
    { c: new THREE.Vector3(30, 20, -95), r: 30, n: 18, sp: -0.12 },
    { c: new THREE.Vector3(-40, 26, -150), r: 35, n: 12, sp: 0.1 },
  ];
  const count = flocks.reduce((a, f) => a + f.n, 0);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x231a1a, side: THREE.DoubleSide }), count);
  mesh.frustumCulled = false;
  scene.add(mesh);
  const r = rng(71);
  const birds = flocks.flatMap((f) => Array.from({ length: f.n }, () => ({ f, off: new THREE.Vector3((r() - 0.5) * 8, (r() - 0.5) * 4, (r() - 0.5) * 8), ph: r() * 10, s: 0.5 + r() * 0.3 })));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  return (t: number) => {
    birds.forEach((b, i) => {
      const a = t * b.f.sp + b.ph * 0.05;
      p.set(Math.cos(a) * b.f.r, Math.sin(t * 0.3 + b.ph) * 1.5, Math.sin(a) * b.f.r * 0.6).add(b.f.c).add(b.off);
      const yaw = Math.atan2(-Math.sin(a) * Math.sign(b.f.sp), Math.cos(a) * 0.6 * Math.sign(b.f.sp));
      e.set(0, yaw, Math.sin(a) * 0.3 * Math.sign(b.f.sp));
      const flap = Math.sin(t * 9 + b.ph * 3);
      m.compose(p, q.setFromEuler(e), new THREE.Vector3(b.s, b.s * (flap * 1.6 + 0.2), b.s));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
}
