// The far side of the sea: an island city of stacked Belle Époque buildings around a great
// iron tower whose top half has been bent, twisted and curled over like wet paint; a leaning
// lighthouse, red-sailed boats, and on the horizon the fractured Monolith inside a frozen
// explosion of rock, the Stockfish Elo painted on it in gold. All procedural — an homage,
// not a copy.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm3, rng } from '../noise';

const SEA_Y = -3;
const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;

function canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// ---- the bent tower -------------------------------------------------------------------

/** Iron lattice: an X-braced panel with a frame; `arch` cuts the great arch out of the legs. */
function latticeTexture(arch: boolean) {
  return canvas(256, 256, (ctx) => {
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'square';
    ctx.lineWidth = 18;
    ctx.strokeRect(9, 0, 238, 256);
    ctx.lineWidth = 9;
    for (let i = 0; i < 4; i++) {
      const y = i * 64;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y + 64);
      ctx.moveTo(256, y);
      ctx.lineTo(0, y + 64);
      ctx.moveTo(0, y);
      ctx.lineTo(256, y);
      ctx.stroke();
    }
    if (arch) {
      // keep only the legs and the arch band above them
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.moveTo(52, 256);
      ctx.lineTo(52, 150);
      ctx.bezierCurveTo(60, 40, 196, 40, 204, 150);
      ctx.lineTo(204, 256);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.moveTo(52, 256);
      ctx.lineTo(52, 150);
      ctx.bezierCurveTo(60, 40, 196, 40, 204, 150);
      ctx.lineTo(204, 256);
      ctx.stroke();
    }
  }, false);
}

interface Spine {
  /** Centre of the tower at normalised height t (0 = ground, 1 = tip). */
  at(t: number): { p: THREE.Vector3; n: THREE.Vector3; b: THREE.Vector3; twist: number };
}

/**
 * The spine: straight up to the second platform, then it leans, bends and curls over into a
 * hook, twisting as it goes, like a brushstroke dragged sideways.
 */
function makeSpine(H: number): Spine {
  const N = 240;
  const pts: { p: THREE.Vector3; th: number }[] = [];
  const s0 = 0.42;
  let x = 0;
  let y = 0;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = Math.max(0, t - s0) / (1 - s0);
    // bend angle (rad): sweeps over sideways like a smear, then curls back up with a flick
    const th = -1.75 * Math.sin(u * Math.PI * 0.92) + 1.1 * u * u * u;
    pts.push({ p: new THREE.Vector3(x, y, 0), th });
    x += Math.sin(th) * (H / N);
    y += Math.cos(th) * (H / N);
  }
  return {
    at(t) {
      const f = Math.min(N, Math.max(0, t * N));
      const i = Math.min(N - 1, Math.floor(f));
      const k = f - i;
      const p = pts[i].p.clone().lerp(pts[i + 1].p, k);
      const th = pts[i].th + (pts[i + 1].th - pts[i].th) * k;
      const u = Math.max(0, t - s0) / (1 - s0);
      return {
        p,
        n: new THREE.Vector3(Math.cos(th), -Math.sin(th), 0), // in the bending plane
        b: new THREE.Vector3(0, 0, 1),
        twist: u * u * 1.6,
      };
    },
  };
}

/** Half-width of the tower at height t: the classic flared curve, frayed near the tip. */
const halfWidth = (t: number, W: number) => W * (0.035 + 0.965 * Math.pow(1 - Math.min(t, 1), 2.6));

function towerGeometry(H: number, W: number, spine: Spine, t0: number, t1: number, segs: number): THREE.BufferGeometry {
  // four faces of a square frustum between t0 and t1, deformed along the spine
  const faces: THREE.BufferGeometry[] = [];
  for (let f = 0; f < 4; f++) {
    const g = new THREE.PlaneGeometry(1, 1, 1, segs);
    const p = g.attributes.position as THREE.BufferAttribute;
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const sx = p.getX(i) * 2; // −1..1 across the face
      const t = t0 + (p.getY(i) + 0.5) * (t1 - t0);
      const w = halfWidth(t, W);
      // square cross-section corners, face f
      const a = (f * Math.PI) / 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      let lx = cx * w - cz * w * sx;
      let lz = cz * w + cx * w * sx;
      const s = spine.at(t);
      const tw = s.twist;
      [lx, lz] = [lx * Math.cos(tw) - lz * Math.sin(tw), lx * Math.sin(tw) + lz * Math.cos(tw)];
      const v = s.p.clone().addScaledVector(s.n, lx).addScaledVector(s.b, lz);
      p.setXYZ(i, v.x, v.y, v.z);
      uv.setXY(i, uv.getX(i), (t * H) / (W * 0.45));
    }
    g.computeVertexNormals();
    faces.push(g);
  }
  return merge(faces);
}

function buildTower(H: number, W: number): THREE.Group {
  const g = new THREE.Group();
  const spine = makeSpine(H);
  const iron = (arch: boolean) => {
    const tex = latticeTexture(arch);
    tex.wrapT = arch ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    return new THREE.MeshStandardMaterial({
      color: 0x3a3030,
      roughness: 0.7,
      metalness: 0.4,
      alphaMap: tex,
      alphaTest: 0.5,
      side: THREE.DoubleSide,
      emissive: 0x3a1a10,
      emissiveIntensity: 0.25,
    });
  };
  // legs + great arch
  const legs = towerGeometry(H, W, spine, 0, 0.13, 6);
  const luv = legs.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < luv.count; i++) luv.setY(i, (luv.getY(i) * (W * 0.45)) / (H * 0.13));
  g.add(new THREE.Mesh(legs, iron(true)));
  g.add(new THREE.Mesh(towerGeometry(H, W, spine, 0.13, 0.985, 220), iron(false)));

  // platforms at the first and second levels, with a lit gallery
  const deck = new THREE.MeshStandardMaterial({ color: 0x2c2424, roughness: 0.8, metalness: 0.3 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x241810, emissive: 0xffb060, emissiveIntensity: 2.2 });
  for (const [t, h] of [[0.13, 0.9], [0.3, 0.7]] as const) {
    const w = halfWidth(t, W) * 2.3;
    const d = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), deck);
    d.position.y = t * H;
    const l = new THREE.Mesh(new THREE.BoxGeometry(w * 0.96, h * 0.35, w * 0.96), glow);
    l.position.y = t * H - h * 0.15;
    g.add(d, l);
  }
  // the frayed tip: a few twisted shards trailing off the hook, like dry brush
  const tip = spine.at(0.985);
  const shardMat = new THREE.MeshStandardMaterial({ color: 0x3a3030, roughness: 0.7, metalness: 0.4, emissive: 0x3a1a10, emissiveIntensity: 0.25 });
  const r = rng(5);
  for (let i = 0; i < 9; i++) {
    const sh = new THREE.Mesh(new THREE.ConeGeometry(0.35 + r() * 0.5, 3 + r() * 6, 4), shardMat);
    sh.position.copy(tip.p).add(new THREE.Vector3((r() - 0.5) * 4, -r() * 3, (r() - 0.5) * 4));
    sh.rotation.set(r() * 3, r() * 3, r() * 3);
    g.add(sh);
  }
  g.traverse((o) => ((o as THREE.Mesh).castShadow = false));
  return g;
}

// ---- the city ---------------------------------------------------------------------------

/** Facade + a matching emissive map holding only the lit windows. */
function facadeTextures() {
  const lit: [number, number][] = [];
  const r = rng(12);
  for (let fl = 0; fl < 5; fl++) for (let w = 0; w < 6; w++) if (r() < 0.22) lit.push([w, fl]);
  const isLit = (w: number, fl: number) => lit.some(([a, b]) => a === w && b === fl);
  const map = canvas(256, 256, (ctx) => {
    ctx.fillStyle = '#d9c7a6';
    ctx.fillRect(0, 0, 256, 256);
    for (let fl = 0; fl < 5; fl++) {
      ctx.fillStyle = 'rgba(120,95,70,0.35)';
      ctx.fillRect(0, fl * 51 + 44, 256, 4); // cornices
      for (let w = 0; w < 6; w++) {
        ctx.fillStyle = isLit(w, fl) ? '#ffcf7a' : '#2e3440';
        ctx.fillRect(w * 42 + 12, fl * 51 + 10, 18, 30);
        ctx.fillStyle = 'rgba(40,30,20,0.6)';
        ctx.fillRect(w * 42 + 10, fl * 51 + 40, 22, 3); // balconies
      }
    }
  });
  const glow = canvas(256, 256, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#ffcf7a';
    for (const [w, fl] of lit) ctx.fillRect(w * 42 + 12, fl * 51 + 10, 18, 30);
  });
  return { map, glow };
}

function buildCity(): { group: THREE.Group; windows: THREE.MeshStandardMaterial } {
  const group = new THREE.Group();
  const facade = facadeTextures();
  const wall = new THREE.MeshStandardMaterial({ map: facade.map, roughness: 0.9, emissiveMap: facade.glow, emissive: 0xffa040, emissiveIntensity: 1.5 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x3a4454, roughness: 0.6, metalness: 0.3 });
  const rock = new THREE.MeshStandardMaterial({ color: 0x5d544c, roughness: 1, flatShading: true });
  const r = rng(21);
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];

  // island rock and harbour quay
  const isl = new THREE.CylinderGeometry(58, 66, 8, 40, 3);
  const ip = isl.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < ip.count; i++) {
    const x = ip.getX(i), z = ip.getZ(i);
    const k = 1 + fbm3(x * 0.05, 0, z * 0.05) * 0.4;
    ip.setX(i, x * k);
    ip.setZ(i, z * k * 0.55);
  }
  isl.computeVertexNormals();
  const island = new THREE.Mesh(isl, rock);
  island.position.y = SEA_Y - 2;
  group.add(island);
  const quay = new THREE.Mesh(new THREE.BoxGeometry(80, 2.5, 3), new THREE.MeshStandardMaterial({ color: 0xa89878, roughness: 0.9 }));
  quay.position.set(0, SEA_Y + 1, 30);
  group.add(quay);

  // two hills of stacked buildings either side of the tower, rising like a Mont-Saint-Michel
  const hill = (cx: number, cz: number, radius: number, top: number) => {
    for (let i = 0; i < 70; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * radius;
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d * 0.6;
      const base = SEA_Y + 2 + (1 - d / radius) * top;
      const w = 4 + r() * 5, h = 5 + r() * 9, dp = 4 + r() * 4;
      const b = new THREE.BoxGeometry(w, h, dp);
      b.rotateY((r() - 0.5) * 0.5);
      b.translate(x, base + h / 2, z);
      walls.push(b);
      // mansard roof
      const m = new THREE.CylinderGeometry(0.01, 0.75, 1, 4, 1).rotateY(Math.PI / 4).scale(w * 0.95, 2.2 + r() * 2, dp * 0.95);
      m.translate(x, base + h + 1.1, z);
      roofs.push(m);
      if (r() < 0.3) {
        const tur = new THREE.ConeGeometry(1.1, 5, 8).translate(x + w * 0.3, base + h + 2.5, z);
        roofs.push(tur);
      }
    }
  };
  hill(-34, 0, 26, 30);
  hill(32, 4, 24, 26);
  hill(0, -8, 16, 6);
  group.add(new THREE.Mesh(merge(walls), wall), new THREE.Mesh(merge(roofs), roof));
  return { group, windows: wall };
}

function buildLighthouse(): { group: THREE.Group; lamp: THREE.MeshStandardMaterial; beam: THREE.Mesh } {
  const group = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0xd8ccb4, roughness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3230, roughness: 0.8 });
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(5, 1), new THREE.MeshStandardMaterial({ color: 0x4d4640, roughness: 1, flatShading: true }));
  rock.scale.set(1.4, 0.6, 1.2);
  rock.position.y = SEA_Y;
  group.add(rock);
  const tower = new THREE.Group();
  tower.add(new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3, 18, 20).translate(0, 9, 0), stone));
  for (const y of [5, 11, 17]) tower.add(new THREE.Mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.5, 20).translate(0, y, 0), dark));
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffd080, emissiveIntensity: 6 });
  tower.add(new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.4, 12).translate(0, 19.4, 0), lamp));
  tower.add(new THREE.Mesh(new THREE.ConeGeometry(2.4, 2.6, 12).translate(0, 21.9, 0), dark));
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(4, 60, 24, 1, true).rotateZ(Math.PI / 2).translate(30, 0, 0),
    new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  beam.position.y = 19.4;
  tower.add(beam);
  tower.position.y = SEA_Y + 1.5;
  tower.rotation.z = -0.24; // it leans
  tower.rotation.x = -0.05;
  group.add(tower);
  return { group, lamp, beam };
}

function buildBoat(): THREE.Group {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 0.5, 6, 10, 1, false, 0, Math.PI).rotateZ(Math.PI / 2).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.8, side: THREE.DoubleSide }),
  );
  hull.scale.set(1, 1, 0.8);
  g.add(hull);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 6, 6).translate(0, 3, 0), hull.material);
  g.add(mast);
  const sail = new THREE.Shape();
  sail.moveTo(0, 0.6);
  sail.quadraticCurveTo(1.6, 2.5, 0.2, 5.8);
  sail.lineTo(-2.6, 0.9);
  sail.closePath();
  const s = new THREE.Mesh(new THREE.ShapeGeometry(sail, 8), new THREE.MeshStandardMaterial({ color: 0xa3222a, roughness: 0.9, side: THREE.DoubleSide }));
  s.rotation.y = Math.PI / 2 - 0.4;
  g.add(s);
  return g;
}

// ---- the Monolith ---------------------------------------------------------------------------

/** Height of the Monolith (local units): tall enough to run off the top of the frame. */
const MONO_H = 420;

/**
 * Aerial perspective for the far-off Monolith and its rocks: a dark silhouette with a little
 * facet shading, washed into the warm horizon haze — heavily at the base, less up the spire,
 * and fading back into the sky near the top.
 */
function hazeMaterial(base: number, haze: number, sun: THREE.Vector3) {
  return new THREE.ShaderMaterial({
    fog: false,
    uniforms: { uBase: { value: new THREE.Color(base) }, uHaze: { value: new THREE.Color(haze) }, uSun: { value: sun.clone().normalize() }, uBottom: { value: SEA_Y }, uTop: { value: 260 } },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vec4 w = modelMatrix * p;
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uBase, uHaze, uSun; uniform float uBottom, uTop;
      varying vec3 vW;
      void main() {
        vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
        float shade = 0.72 + 0.4 * max(dot(n, uSun), 0.0);
        float hy = clamp((vW.y - uBottom) / (uTop - uBottom), 0.0, 1.0);
        float haze = 0.66 - 0.3 * smoothstep(0.0, 0.4, hy) + 0.3 * smoothstep(0.55, 1.0, hy);
        gl_FragColor = vec4(mix(uBase * shade, uHaze, clamp(haze, 0.0, 0.92)), 1.0);
      }`,
  });
}

function monolithGeometry(): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(6, 18, MONO_H, 9, 120, false);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = (y + MONO_H / 2) / MONO_H;
    const a = Math.atan2(z, x);
    // deep vertical ridges and stepped, fractured faces
    const ridge = 1 + 0.45 * Math.abs(Math.sin(a * 2.5 + t * 1.5)) + fbm3(Math.cos(a) * 2, y * 0.03, Math.sin(a) * 2, 4) * 1.1;
    const step = Math.floor(fbm3(a * 0.8, y * 0.02, 3, 3) * 6) / 6;
    let k = ridge * (1 + step * 0.6) * (1 - t * 0.3);
    // near the top it splits into prongs
    if (t > 0.78) k *= 1 + Math.max(0, Math.cos(a * 3)) * (t - 0.78) * 4;
    const lean = t * t * 30;
    p.setXYZ(i, x * k + lean, y, z * k);
  }
  g.computeVertexNormals();
  return g.toNonIndexed();
}

function paintNumber(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  if (!text) return;
  ctx.font = `600 ${Math.round(h * 0.78)}px "Cormorant Garamond", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const r = rng(text.length * 7 + text.charCodeAt(0));
  // brush it on in several dry, offset passes: glow, body, highlights
  ctx.shadowColor = 'rgba(255,170,80,0.9)';
  ctx.shadowBlur = 36;
  ctx.fillStyle = 'rgba(255,190,110,0.55)';
  ctx.fillText(text, w / 2, h * 0.54);
  ctx.shadowBlur = 0;
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = `rgba(${240 + r() * 15},${200 + r() * 40},${130 + r() * 60},${0.18 + r() * 0.2})`;
    ctx.fillText(text, w / 2 + (r() - 0.5) * 14, h * 0.54 + (r() - 0.5) * 10);
  }
  // bristle streaks through the strokes
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 70; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.2 + r() * 0.5})`;
    ctx.fillRect(0, r() * h, w, 1 + r() * 2);
  }
  ctx.globalCompositeOperation = 'source-over';
}

export interface Lumiere {
  setNumber(text: string): void;
  update(t: number, reduced: boolean): void;
}

export function buildLumiere(scene: THREE.Scene): Lumiere {
  // the city and its tower, across the water to the right
  const city = buildCity();
  city.group.position.set(36, 0, -125);
  city.group.scale.setScalar(0.6);
  city.group.rotation.y = -0.25;
  scene.add(city.group);
  const tower = buildTower(95, 17);
  tower.position.set(-4, SEA_Y + 2, -6);
  tower.rotation.y = 0.5;
  city.group.add(tower);

  const light = buildLighthouse();
  light.group.position.set(58, 0, -100);
  scene.add(light.group);

  const boats: { g: THREE.Group; x: number; z: number; ph: number; sp: number }[] = [];
  const br = rng(44);
  for (let i = 0; i < 6; i++) {
    const b = buildBoat();
    const x = -30 + br() * 70, z = -40 - br() * 55;
    b.position.set(x, SEA_Y, z);
    b.rotation.y = br() * Math.PI * 2;
    b.scale.setScalar(0.8 + br() * 0.6);
    scene.add(b);
    boats.push({ g: b, x, z, ph: br() * 10, sp: 0.2 + br() * 0.4 });
  }

  // the Monolith on the horizon, inside a frozen explosion of rock
  const mono = new THREE.Group();
  const HAZE = 0xe8b890; // the sky just above the horizon
  const monoMat = hazeMaterial(0x3a2c38, HAZE, new THREE.Vector3(0.55, 0.3, -1));
  const shardMat = hazeMaterial(0x44343c, HAZE, new THREE.Vector3(0.55, 0.3, -1));
  const monolith = new THREE.Mesh(monolithGeometry(), monoMat);
  monolith.position.y = MONO_H / 2 - 8;
  mono.add(monolith);
  const shardCount = 380;
  const shards = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), shardMat, shardCount);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sr = rng(77);
  const shardData: { p: THREE.Vector3; s: number; rot: THREE.Euler; spin: number }[] = [];
  for (let i = 0; i < shardCount; i++) {
    // a hollow shell around the spire, densest around its middle
    const a = sr() * Math.PI * 2;
    const y = 15 + Math.pow(sr(), 0.9) * 300;
    const rad = 18 + sr() * 40 + Math.sin((y / 320) * Math.PI) * 28;
    const p = new THREE.Vector3(Math.cos(a) * rad, y, Math.sin(a) * rad * 0.7);
    const s = 0.8 + Math.pow(sr(), 3) * 7;
    shardData.push({ p, s, rot: new THREE.Euler(sr() * 6, sr() * 6, sr() * 6), spin: (sr() - 0.5) * 0.1 });
  }
  const placeShards = (t: number) => {
    shardData.forEach((d, i) => {
      e.set(d.rot.x + t * d.spin, d.rot.y + t * d.spin * 0.7, d.rot.z);
      m4.compose(d.p, q.setFromEuler(e), new THREE.Vector3(d.s * (0.5 + (i % 3) * 0.3), d.s * (0.7 + (i % 5) * 0.25), d.s * 0.6));
      shards.setMatrixAt(i, m4);
    });
    shards.instanceMatrix.needsUpdate = true;
  };
  placeShards(0);
  mono.add(shards);
  const numCanvas = document.createElement('canvas');
  numCanvas.width = 1024;
  numCanvas.height = 384;
  const numTex = new THREE.CanvasTexture(numCanvas);
  numTex.colorSpace = THREE.SRGBColorSpace;
  const numMat = new THREE.MeshBasicMaterial({ map: numTex, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  const num = new THREE.Mesh(new THREE.PlaneGeometry(84, 31.5), numMat);
  num.position.set(8, 118, 26);
  mono.add(num);
  mono.position.set(-46, SEA_Y, -262);
  mono.rotation.y = 0.3;
  mono.scale.setScalar(0.58);
  scene.add(mono);

  return {
    setNumber(text) {
      paintNumber(numCanvas.getContext('2d')!, text, numCanvas.width, numCanvas.height);
      numTex.needsUpdate = true;
    },
    update(t, reduced) {
      const tt = reduced ? 0 : t;
      numMat.opacity = 0.85 + Math.sin(t * 0.8) * 0.15;
      light.beam.rotation.y = tt * 0.5;
      light.lamp.emissiveIntensity = 5 + Math.sin(t * 2) * 1;
      city.windows.emissiveIntensity = 1.3 + Math.sin(t * 0.4) * 0.2;
      for (const b of boats) {
        b.g.position.set(b.x + Math.sin(tt * 0.05 * b.sp + b.ph) * 6, SEA_Y + Math.sin(tt * 1.1 + b.ph) * 0.15, b.z);
        b.g.rotation.z = Math.sin(tt * 0.9 + b.ph) * 0.05;
        b.g.rotation.x = Math.sin(tt * 0.7 + b.ph * 2) * 0.04;
      }
      if (!reduced) placeShards(t);
    },
  };
}
