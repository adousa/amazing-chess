// The Expedition world: a ruined Belle Époque plaza on a golden-hour headland. A painted sky,
// a sea, floating islands, crimson trees, broken columns, Art Nouveau lamps and, far across
// the water, the city with its bent tower and the Monolith (see lumiere.ts). All procedural.
import * as THREE from 'three';
import { fbm3, rng } from '../noise';
import { buildLumiere } from './lumiere';
import { buildBirds, buildGrass, buildSea, landHeight, loadTrees, plant, TREE_SPOTS, windTime, type Planting } from './nature';

export const BOARD_Y = 0; // board top
export const HALF = 4; // board half-size in squares (1 square = 1 unit)

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

export const SUN_DIR = new THREE.Vector3(0.55, 0.16, -1).normalize();

function skyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime: { value: 0 }, uSun: { value: SUN_DIR } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uSun;
      varying vec3 vDir;
      ${GLSL_NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zenith = vec3(0.06, 0.12, 0.26);
        vec3 high = vec3(0.22, 0.3, 0.48);
        vec3 mid = vec3(0.78, 0.4, 0.3);
        vec3 horizon = vec3(1.0, 0.74, 0.45);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.12, h));
        col = mix(col, high, smoothstep(0.08, 0.3, h));
        col = mix(col, zenith, smoothstep(0.3, 0.8, h));
        // sun glow
        float sd = max(dot(d, uSun), 0.0);
        col += vec3(1.0, 0.7, 0.4) * pow(sd, 6.0) * 0.55 + vec3(1.0, 0.9, 0.7) * pow(sd, 90.0) * 2.5;
        // brushy clouds in long horizontal strokes
        // walk the noise round a circle so the clouds join up all the way round (no seam)
        vec2 ring = normalize(d.xz + vec2(1e-5));
        float n = fbm(ring * 2.64 + vec2(h * 25.2 * 0.7, h * 25.2) + vec2(uTime * 0.01, 0.0));
        float n2 = fbm(ring * 6.6 + vec2(h * 63.0 * 0.7, h * 63.0) - vec2(uTime * 0.015, 0.0));
        float band = smoothstep(0.02, 0.1, h) * (1.0 - smoothstep(0.35, 0.65, h));
        float cl = smoothstep(0.48, 0.7, n * 0.8 + n2 * 0.3) * band;
        vec3 lit = mix(vec3(0.55, 0.35, 0.45), vec3(1.0, 0.78, 0.5), pow(sd, 2.0) * 0.8 + n2 * 0.4);
        col = mix(col, lit, cl * 0.85);
        // a few painted streaks high up
        float streak = smoothstep(0.62, 0.8, fbm(ring * 1.54 + vec2(0.0, h * 30.0))) * smoothstep(0.25, 0.4, h) * (1.0 - smoothstep(0.6, 0.9, h));
        col = mix(col, vec3(0.95, 0.7, 0.62), streak * 0.35);
        col = mix(col, horizon * 0.95, smoothstep(0.02, -0.04, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function canvasTex(size: number, draw: (ctx: CanvasRenderingContext2D, rand: () => number) => void, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, rng(size + repeat));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
}

/** Painted meadow: short strokes of ochre and green with crimson flower dabs. */
function meadowTexture() {
  return canvasTex(
    512,
    (ctx, r) => {
      ctx.fillStyle = '#7d7a3e';
      ctx.fillRect(0, 0, 512, 512);
      const cols = ['#8f8a45', '#6c7236', '#a3924e', '#5b6431', '#b39a55', '#77803e'];
      for (let i = 0; i < 5000; i++) {
        ctx.strokeStyle = cols[Math.floor(r() * cols.length)];
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2 + r() * 3;
        const x = r() * 512, y = r() * 512, a = -1.2 + r() * 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * 10, y + Math.sin(a) * 10);
        ctx.stroke();
      }
      for (let i = 0; i < 380; i++) {
        ctx.fillStyle = r() < 0.8 ? '#b3182b' : '#f0e2c4';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(r() * 512, r() * 512, 1.5 + r() * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    },
    26,
  );
}

function stoneTexture(base: string, repeat: number) {
  return canvasTex(
    512,
    (ctx, r) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 2600; i++) {
        const v = Math.floor(r() * 50 - 25);
        ctx.fillStyle = `rgba(${128 + v},${120 + v},${105 + v},0.18)`;
        ctx.fillRect(r() * 512, r() * 512, 3 + r() * 14, 2 + r() * 6);
      }
      ctx.strokeStyle = 'rgba(40,30,20,0.45)';
      ctx.lineWidth = 2;
      for (let y = 0; y < 512; y += 64) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(512, y);
        ctx.stroke();
        for (let x = (y / 64) % 2 ? 0 : 48; x < 512; x += 96) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + 64);
          ctx.stroke();
        }
      }
    },
    repeat,
  );
}

/** Marble board, drawn as seen from our side: canvas top = far side (−z). */
export function boardTexture(ourWhite: boolean) {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d')!;
  const r = rng(99);
  const s = px / 8;
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      const file = ourWhite ? j : 7 - j;
      const rank = ourWhite ? 7 - i : i;
      const light = (file + rank) % 2 === 1;
      ctx.fillStyle = light ? '#e9dcc0' : '#2f4a4e';
      ctx.fillRect(j * s, i * s, s, s);
      // marble veins
      ctx.save();
      ctx.beginPath();
      ctx.rect(j * s, i * s, s, s);
      ctx.clip();
      for (let k = 0; k < 5; k++) {
        ctx.strokeStyle = light ? `rgba(150,120,80,${0.15 + r() * 0.2})` : `rgba(160,200,190,${0.08 + r() * 0.15})`;
        ctx.lineWidth = 0.6 + r() * 1.8;
        ctx.beginPath();
        let x = j * s + r() * s, y = i * s;
        ctx.moveTo(x, y);
        for (let q = 0; q < 8; q++) {
          x += (r() - 0.5) * s * 0.35;
          y += s / 7;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  // gold inlay lines
  ctx.strokeStyle = '#c99a3e';
  ctx.lineWidth = 3;
  for (let i = 0; i <= 8; i++) {
    ctx.beginPath();
    ctx.moveTo(i * s, 0);
    ctx.lineTo(i * s, px);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * s);
    ctx.lineTo(px, i * s);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Border frame with coordinates, gold letters on dark lacquer. */
function frameTexture(ourWhite: boolean) {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1512';
  ctx.fillRect(0, 0, px, px);
  const b = px * (0.6 / 9.2);
  const s = (px - 2 * b) / 8;
  ctx.strokeStyle = '#c99a3e';
  ctx.lineWidth = 4;
  ctx.strokeRect(b * 0.3, b * 0.3, px - b * 0.6, px - b * 0.6);
  ctx.lineWidth = 2;
  ctx.strokeRect(b * 0.85, b * 0.85, px - b * 1.7, px - b * 1.7);
  ctx.fillStyle = '#e3bd6a';
  ctx.font = `italic ${Math.round(b * 0.55)}px "Cormorant Garamond", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let j = 0; j < 8; j++) ctx.fillText(String.fromCharCode(97 + (ourWhite ? j : 7 - j)), b + (j + 0.5) * s, px - b / 2);
  for (let i = 0; i < 8; i++) ctx.fillText(String(ourWhite ? 8 - i : i + 1), b / 2, b + (i + 0.5) * s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export interface World {
  /** The round platform with the board; raise it by moving its y. */
  arena: THREE.Group;
  boardMat: THREE.MeshStandardMaterial;
  frameMat: THREE.MeshStandardMaterial;
  setOrientation(ourWhite: boolean): void;
  setMonolith(text: string): void;
  update(t: number, camera: THREE.Camera, reduced: boolean): void;
  dispose(): void;
}

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer, reduced = false): World {
  const fog = new THREE.Color(0xd9a57e);
  scene.fog = new THREE.FogExp2(fog, 0.0042);
  scene.background = fog;

  // ---- light: low golden sun from across the sea, cool sky fill ---------------------
  scene.add(new THREE.HemisphereLight(0x9fb8d8, 0x6b4a30, 1.1));
  const sun = new THREE.DirectionalLight(0xffc68a, 3.4);
  sun.position.copy(SUN_DIR).multiplyScalar(30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -9;
  sc.right = sc.top = 9;
  sc.near = 5;
  sc.far = 70;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight(0xffe2c4, 0.9);
  fill.position.set(-6, 8, 12);
  scene.add(fill);

  // ---- sky + reflections from it ------------------------------------------------------
  const skyMat = skyMaterial();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 48, 24), skyMat);
  sky.renderOrder = -1;
  scene.add(sky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMaterial()));
  const envRT = pmrem.fromScene(envScene, 0.02);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();

  // ---- sea ------------------------------------------------------------------------------
  buildSea(scene, SUN_DIR);

  // ---- headland: meadow with the plaza in the middle -----------------------------------
  const land = new THREE.PlaneGeometry(120, 90, 160, 120).rotateX(-Math.PI / 2).translate(0, 0, 12);
  const lp = land.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < lp.count; i++) {
    lp.setY(i, landHeight(lp.getX(i), lp.getZ(i)));
  }
  land.computeVertexNormals();
  buildGrass(scene, reduced);
  const meadow = new THREE.Mesh(land, new THREE.MeshStandardMaterial({ map: meadowTexture(), roughness: 1 }));
  meadow.receiveShadow = true;
  scene.add(meadow);

  // plaza: round paved terrace, three steps. The inner circle (inside the gold ring) is the
  // arena: it carries the board and slowly rises out of the outer paving on a shaft.
  const ARENA_R = 7.15;
  const arena = new THREE.Group();
  scene.add(arena);
  const paveMat = new THREE.MeshStandardMaterial({ map: stoneTexture('#b6a488', 5), roughness: 0.85 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a24a, metalness: 1, roughness: 0.28 });
  // the outer ring of the top step stays on the ground (a paved annulus around the arena)
  const outer = new THREE.Mesh(
    new THREE.LatheGeometry([new THREE.Vector2(ARENA_R + 0.05, -0.3), new THREE.Vector2(ARENA_R + 0.05, -0.5), new THREE.Vector2(9.3, -0.5), new THREE.Vector2(9.2, -0.3), new THREE.Vector2(ARENA_R + 0.05, -0.3)], 96),
    Object.assign(paveMat.clone(), { side: THREE.DoubleSide }),
  );
  outer.receiveShadow = true;
  scene.add(outer);
  for (let i = 1; i < 3; i++) {
    const step = new THREE.Mesh(new THREE.CylinderGeometry(9.2 + i * 0.9, 9.3 + i * 0.9, 0.2, 72), paveMat);
    step.position.y = -0.4 - i * 0.18;
    step.receiveShadow = true;
    scene.add(step);
  }
  // the inner disc itself, rimmed in gold
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(ARENA_R, ARENA_R, 0.2, 96), paveMat);
  disc.position.y = -0.4;
  disc.receiveShadow = true;
  arena.add(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R, 0.07, 8, 96).rotateX(Math.PI / 2), gold);
  ring.position.y = -0.29;
  arena.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(8.9, 0.04, 8, 96).rotateX(Math.PI / 2), gold);
  ring2.position.y = -0.29;
  scene.add(ring2);
  // the shaft: ashlar stone with gilded bands and glowing seams, hidden below ground at rest
  const shaftTex = stoneTexture('#9c8a70', 1);
  shaftTex.repeat.set(8, 5);
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_R - 0.02, ARENA_R - 0.02, 18, 72, 1, true),
    new THREE.MeshStandardMaterial({ map: shaftTex, roughness: 0.9, side: THREE.DoubleSide }),
  );
  shaft.position.y = -0.5 - 9;
  arena.add(shaft);
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x2a1a08, emissive: 0xffb050, emissiveIntensity: 2.5 });
  for (let y = -0.9; y > -18; y -= 1.5) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R + 0.02, 0.07, 6, 96).rotateX(Math.PI / 2), y > -1 ? gold : seamMat);
    band.position.y = y;
    arena.add(band);
  }

  // ---- the board: a gilded table of marble -----------------------------------------------
  const boardMat = new THREE.MeshStandardMaterial({ map: boardTexture(true), roughness: 0.3, metalness: 0.05 });
  const frameMat = new THREE.MeshStandardMaterial({ map: frameTexture(true), roughness: 0.4, metalness: 0.2 });
  const top = new THREE.Mesh(new THREE.BoxGeometry(8, 0.1, 8), [gold, gold, boardMat, gold, gold, gold]);
  top.position.y = BOARD_Y - 0.05;
  top.receiveShadow = true;
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.26, 9.2), [gold, gold, frameMat, gold, gold, gold]);
  frame.position.y = BOARD_Y - 0.16;
  frame.receiveShadow = frame.castShadow = true;
  const trim = new THREE.Mesh(new THREE.BoxGeometry(9.5, 0.08, 9.5), gold);
  trim.position.y = BOARD_Y - 0.3;
  arena.add(top, frame, trim);

  // ---- broken columns around the plaza ------------------------------------------------------
  const colMat = new THREE.MeshStandardMaterial({ map: stoneTexture('#d8c9ac', 1), roughness: 0.8 });
  const rand = rng(33);
  const colGeo = (() => {
    const g = new THREE.CylinderGeometry(0.42, 0.48, 1, 20, 8);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const a = Math.atan2(z, x);
      const k = 1 - 0.06 * Math.max(0, Math.cos(a * 10)); // flutes
      p.setX(i, x * k);
      p.setZ(i, z * k);
    }
    g.computeVertexNormals();
    return g.translate(0, 0.5, 0);
  })();
  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + 0.3;
    if (Math.abs(a - Math.PI * 1.5) < 0.5) continue; // leave the view open towards the camera
    const r = 11.5 + rand() * 1.5;
    const h = 1.5 + rand() * 5.5;
    const c = new THREE.Mesh(colGeo, colMat);
    c.scale.set(1, h, 1);
    c.position.set(Math.cos(a) * r, -0.6, Math.sin(a) * r);
    c.rotation.set((rand() - 0.5) * 0.12, rand() * 3, (rand() - 0.5) * 0.12);
    c.castShadow = c.receiveShadow = true;
    scene.add(c);
    if (h > 4.5) {
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.35, 1.3), colMat);
      cap.position.set(c.position.x, -0.6 + h + 0.15, c.position.z);
      cap.rotation.y = c.rotation.y;
      cap.castShadow = true;
      scene.add(cap);
    }
  }
  // a fallen drum
  const fallen = new THREE.Mesh(colGeo, colMat);
  fallen.scale.set(1, 3, 1);
  fallen.rotation.set(0, 0.6, Math.PI / 2);
  fallen.position.set(-9.5, -0.2, -5);
  fallen.castShadow = true;
  scene.add(fallen);

  // ---- Art Nouveau lamps -----------------------------------------------------------------
  const iron = new THREE.MeshStandardMaterial({ color: 0x1d2a26, metalness: 0.7, roughness: 0.45 });
  const globe = new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffb45a, emissiveIntensity: 4 });
  for (const [x, z] of [[-6.4, -6.4], [6.4, -6.4], [-6.4, 6.4], [6.4, 6.4]] as const) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.05, 1.6, 0),
      new THREE.Vector3(-0.1, 3.0, 0),
      new THREE.Vector3(0.35, 3.8, 0),
      new THREE.Vector3(0.75, 3.55, 0),
    ]);
    const post = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.06, 8), iron);
    const g = new THREE.Group();
    g.add(post);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 20, 14), globe);
    orb.position.set(0.78, 3.22, 0);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.2, 12), iron);
    cap.position.set(0.78, 3.48, 0);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.22, 0.4, 10), iron);
    foot.position.y = 0.2;
    g.add(orb, cap, foot);
    g.position.set(x, -0.3, z);
    g.rotation.y = Math.atan2(x, z) + Math.PI / 2;
    post.castShadow = true;
    scene.add(g); // the lamps stand on the outer ring
  }

  // ---- crimson trees ----------------------------------------------------------------------
  const bark = new THREE.MeshStandardMaterial({ color: 0x3a2a22, roughness: 0.9 });
  const leafCols = [0xa3162a, 0xc42a33, 0x8a1022, 0xd9563a];
  const leafMats = leafCols.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, flatShading: true }));
  const tree = (x: number, z: number, s: number) => {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.28, 3, 8).translate(0, 1.5, 0), bark);
    trunk.rotation.z = (rand() - 0.5) * 0.25;
    trunk.castShadow = true;
    g.add(trunk);
    for (let i = 0; i < 9; i++) {
      const f = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 + rand() * 0.7, 1), leafMats[Math.floor(rand() * leafMats.length)]);
      f.position.set((rand() - 0.5) * 2.4, 3 + rand() * 1.8, (rand() - 0.5) * 2.4);
      f.castShadow = true;
      g.add(f);
    }
    g.scale.setScalar(s);
    const y = landHeight(x, z);
    g.position.set(x, y - 0.1, z);
    scene.add(g);
  };
  // modelled trees (CC0, Quaternius); the simple ones only if the models can't be loaded
  loadTrees(scene, TREE_SPOTS, () => {
    for (const [x, z, sc] of [[-17, -9, 1.3], [-21, 2, 1.6], [18, -12, 1.2], [22, 1, 1.5], [-15, 14, 1.1], [16, 16, 1.2], [-27, -4, 2], [28, -8, 1.8]] as const) tree(x, z, sc);
  });
  const birds = buildBirds(scene);

  // ---- floating islands over the sea -----------------------------------------------------
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6d5a4d, roughness: 0.95, flatShading: true });
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x77803e, roughness: 1, flatShading: true });
  const islands: { g: THREE.Group; y: number; ph: number }[] = [];
  const island = (x: number, y: number, z: number, s: number, seed: number) => {
    const g = new THREE.Group();
    const geo = new THREE.IcosahedronGeometry(1, 3);
    const p = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      let vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const n = 1 + fbm3(vx * 1.7 + seed * 3, vy * 1.7, vz * 1.7, 5) * 0.9;
      vx *= n; vz *= n;
      // flat top, long jagged root hanging below
      vy = vy > 0.1 ? 0.1 + (vy - 0.1) * 0.15 : vy * (1.6 + fbm3(vx * 3, seed, vz * 3) * 2.5);
      p.setXYZ(i, vx, vy, vz);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, rockMat);
    g.add(rock);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.9, 0.12, 12), grassMat);
    cap.position.y = 0.16;
    g.add(cap);
    // real trees on top, like the ones on the headland (heights in world metres ÷ island scale)
    const r2 = rng(seed * 7);
    const TOP = 0.2;
    const kinds: Planting['model'][] = ['twisted', 'tree_a', 'tree_b'];
    const tints: Planting['tint'][] = ['crimson', 'amber', 'gold'];
    const items: Planting[] = [
      { model: kinds[seed % 3], pos: new THREE.Vector3((r2() - 0.5) * 0.4, TOP, (r2() - 0.5) * 0.4), h: (3.6 + r2() * 1.6) / s * Math.min(1.6, s / 2.2), tint: tints[seed % 3] },
      { model: r2() < 0.5 ? 'bush' : 'bush_flowers', pos: new THREE.Vector3(0.45 + r2() * 0.2, TOP, -0.3 + r2() * 0.3), h: 1.0 / s * Math.min(1.6, s / 2.2) },
    ];
    if (s > 4) items.push({ model: kinds[(seed + 1) % 3], pos: new THREE.Vector3(-0.5, TOP, 0.35), h: (2.8 + r2() * 1.2) / s * Math.min(1.6, s / 2.2), tint: tints[(seed + 1) % 3] });
    plant(g, items, () => {
      for (let i = 0; i < 4; i++) {
        const t = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22 + r2() * 0.18, 1), leafMats[Math.floor(r2() * leafMats.length)]);
        t.position.set((r2() - 0.5) * 1.1, 0.42 + r2() * 0.2, (r2() - 0.5) * 1.1);
        g.add(t);
      }
    }, seed);
    g.scale.setScalar(s);
    g.position.set(x, y, z);
    scene.add(g);
    islands.push({ g, y, ph: seed });
  };
  // kept clear of the city and the Monolith on the horizon
  island(-30, 10, -48, 3.2, 1);
  island(-36, 20, -72, 4.5, 2);
  island(-20, 30, -40, 3.6, 3);
  island(64, 32, -84, 6, 4);
  island(-72, 30, -120, 7, 5);
  island(-40, 5, -34, 1.6, 6);

  // ---- across the sea: the city with its bent tower, and the Monolith --------------------------
  const lumiere = buildLumiere(scene);
  const setMonolith = (text: string) => lumiere.setNumber(text);

  return {
    arena,
    boardMat,
    frameMat,
    setOrientation(ourWhite) {
      boardMat.map?.dispose();
      boardMat.map = boardTexture(ourWhite);
      frameMat.map?.dispose();
      frameMat.map = frameTexture(ourWhite);
      boardMat.needsUpdate = frameMat.needsUpdate = true;
    },
    setMonolith,
    update(t, camera, reduced) {
      // the sun's shadow box follows the arena up
      sun.position.copy(SUN_DIR).multiplyScalar(30).setY(SUN_DIR.y * 30 + arena.position.y);
      sun.target.position.set(0, arena.position.y, 0);
      skyMat.uniforms.uTime.value = t;
      sky.position.copy(camera.position);
      if (!reduced) for (const i of islands) i.g.position.y = i.y + Math.sin(t * 0.3 + i.ph) * 0.6;
      lumiere.update(t, reduced);
      windTime.value = reduced ? 0 : t;
      if (!reduced) birds(t);
    },
    dispose() {
      envRT.dispose();
    },
  };
}
