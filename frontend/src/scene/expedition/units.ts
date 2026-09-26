// The armed chess pieces of the Expedition stage. Each piece is a small masked warrior on a
// plinth whose silhouette still reads as its chess piece (crown, mitre, horse helm, tower
// shoulders…), holding a weapon in a pivoting arm so it can be swung. Our engine's army is
// ivory and gold ("the Expedition"); Stockfish's is obsidian with a crimson glow ("the
// Paintress's Nevrons"). Every material can dissolve into petals (the gommage).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PieceColor, PieceType } from '../pieces';

export type Faction = 'exp' | 'nev' | 'stone';
export type WeaponKind = 'spear' | 'lance' | 'staff' | 'hammer' | 'rapier' | 'greatsword';
export const WEAPON: Record<PieceType, WeaponKind> = {
  p: 'spear',
  n: 'lance',
  b: 'staff',
  r: 'hammer',
  q: 'rapier',
  k: 'greatsword',
};
/** Unit heights (top of the headgear), in squares. */
export const UNIT_H: Record<PieceType, number> = { p: 0.92, n: 1.28, b: 1.36, r: 1.2, q: 1.34, k: 1.56 };

type P = [number, number];
const lathe = (pts: P[], segs = 28) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);
const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
function cyl(rt: number, rb: number, h: number, x: number, y: number, z: number, segs = 12) {
  return new THREE.CylinderGeometry(rt, rb, h, segs).translate(x, y, z);
}
function sph(r: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) {
  return new THREE.SphereGeometry(r, 20, 14).scale(sx, sy, sz).translate(x, y, z);
}
function bx(w: number, h: number, d: number, x: number, y: number, z: number) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// ---- dissolvable materials ----------------------------------------------------------

export interface DissolveUniforms {
  uDissolve: { value: number };
  uFlash: { value: number };
  uEdge: { value: THREE.Color };
  uBaseY: { value: number };
  uHeight: { value: number };
  uGlow: { value: number };
}

const DISSOLVE_NOISE = /* glsl */ `
  float dh(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float dn3(vec3 p) {
    vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(dh(i), dh(i + vec3(1,0,0)), u.x), mix(dh(i + vec3(0,1,0)), dh(i + vec3(1,1,0)), u.x), u.y),
               mix(mix(dh(i + vec3(0,0,1)), dh(i + vec3(1,0,1)), u.x), mix(dh(i + vec3(0,1,1)), dh(i + vec3(1,1,1)), u.x), u.y), u.z);
  }
`;

function dissolvable<T extends THREE.MeshStandardMaterial>(base: T, u: DissolveUniforms): T {
  const m = base.clone() as T;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvDW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vDW;
        uniform float uDissolve, uFlash, uBaseY, uHeight, uGlow;
        uniform vec3 uEdge;
        ${DISSOLVE_NOISE}`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        float hn = clamp((vDW.y - uBaseY) / uHeight, 0.0, 1.0);
        float dval = dn3(vDW * 9.0) * 0.55 + dn3(vDW * 23.0) * 0.15 + (1.0 - hn) * 0.3;
        if (uDissolve > 0.0 && dval < uDissolve) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        if (uDissolve > 0.0) totalEmissiveRadiance += uEdge * smoothstep(uDissolve + 0.07, uDissolve, dval) * 9.0;
        totalEmissiveRadiance += vec3(1.0, 0.93, 0.82) * uFlash * 1.2 + uEdge * uGlow;`,
      );
  };
  m.customProgramCacheKey = () => 'dissolve1';
  return m;
}

interface Palette {
  body: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  mask: THREE.MeshStandardMaterial;
  eye: THREE.MeshStandardMaterial;
  blade: THREE.MeshStandardMaterial;
  edge: THREE.Color;
}

const PALETTES: Record<Faction, () => Palette> = {
  exp: () => ({
    body: new THREE.MeshStandardMaterial({ color: 0xeee3cf, roughness: 0.42, metalness: 0.02 }),
    trim: new THREE.MeshStandardMaterial({ color: 0xd9a646, roughness: 0.3, metalness: 0.95 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0x2c4a78, roughness: 0.8 }),
    mask: new THREE.MeshStandardMaterial({ color: 0xfaf5ea, roughness: 0.25 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x7fb6ff, emissiveIntensity: 0.6 }),
    blade: new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.16, metalness: 1 }),
    edge: new THREE.Color(1.0, 0.72, 0.35),
  }),
  nev: () => ({
    body: new THREE.MeshStandardMaterial({ color: 0x17131b, roughness: 0.32, metalness: 0.35 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x7a1420, roughness: 0.35, metalness: 0.7 }),
    cloth: new THREE.MeshStandardMaterial({ color: 0x250c12, roughness: 0.85 }),
    mask: new THREE.MeshStandardMaterial({ color: 0x0c0b0e, roughness: 0.2, metalness: 0.5 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2238, emissiveIntensity: 4 }),
    blade: new THREE.MeshStandardMaterial({ color: 0x241018, roughness: 0.2, metalness: 0.8, emissive: 0x9a0f22, emissiveIntensity: 0.9 }),
    edge: new THREE.Color(1.0, 0.16, 0.24),
  }),
  stone: () => {
    const s = new THREE.MeshStandardMaterial({ color: 0x8d877c, roughness: 0.95 });
    return { body: s, trim: s, cloth: s, mask: s, eye: s, blade: s, edge: new THREE.Color(0.6, 0.55, 0.45) };
  },
};

// ---- geometry per piece -------------------------------------------------------------

type Part = keyof Omit<Palette, 'edge'>;
interface Spec {
  parts: Partial<Record<Part, THREE.BufferGeometry>>;
  shoulder: THREE.Vector3;
  weapon: Partial<Record<Part, THREE.BufferGeometry>>;
  shield?: Partial<Record<Part, THREE.BufferGeometry>>;
}

const PLINTH: P[] = [[0, 0], [0.38, 0], [0.38, 0.05], [0.34, 0.08], [0.3, 0.1], [0, 0.1]];
const RIM = () => new THREE.TorusGeometry(0.36, 0.018, 8, 40).rotateX(Math.PI / 2).translate(0, 0.055, 0);

function head(y: number, r: number): { mask: THREE.BufferGeometry; eye: THREE.BufferGeometry } {
  return {
    mask: sph(r, 0, y, 0, 1, 1.12, 1),
    eye: merge([bx(r * 0.42, r * 0.13, r * 0.2, -r * 0.36, y + r * 0.12, r * 0.9), bx(r * 0.42, r * 0.13, r * 0.2, r * 0.36, y + r * 0.12, r * 0.9)]),
  };
}

// horse head profile (from the classic knight), facing +z after rotation
const HORSE: P[] = [
  [-11, 16], [11, 16], [8, 28], [16, 35], [21, 39], [22, 45], [16, 48], [9, 53], [5, 61], [1, 56],
  [-4, 58], [-10, 51], [-14, 41], [-14, 28],
];

function weaponGeo(kind: WeaponKind): Partial<Record<Part, THREE.BufferGeometry>> {
  // held at the grip (origin), pointing +y
  switch (kind) {
    case 'spear':
      return { trim: cyl(0.014, 0.014, 0.95, 0, 0.3, 0, 6), blade: new THREE.ConeGeometry(0.035, 0.16, 4).translate(0, 0.85, 0) };
    case 'lance':
      return {
        blade: new THREE.ConeGeometry(0.045, 1.05, 10).translate(0, 0.62, 0),
        trim: merge([new THREE.ConeGeometry(0.075, 0.12, 12).rotateX(Math.PI).translate(0, 0.08, 0), cyl(0.018, 0.018, 0.25, 0, -0.05, 0, 6)]),
      };
    case 'staff':
      return {
        cloth: cyl(0.016, 0.02, 1.0, 0, 0.3, 0, 6),
        trim: new THREE.TorusGeometry(0.075, 0.012, 6, 20).translate(0, 0.86, 0),
        eye: sph(0.055, 0, 0.86, 0),
      };
    case 'hammer':
      return { cloth: cyl(0.022, 0.022, 0.72, 0, 0.2, 0, 6), blade: bx(0.3, 0.16, 0.16, 0, 0.58, 0), trim: bx(0.32, 0.03, 0.18, 0, 0.58, 0) };
    case 'rapier':
      return {
        blade: bx(0.018, 0.78, 0.008, 0, 0.47, 0),
        trim: merge([new THREE.TorusGeometry(0.05, 0.008, 6, 16, Math.PI).rotateY(Math.PI / 2).translate(0, 0.05, 0), bx(0.12, 0.012, 0.012, 0, 0.07, 0), sph(0.02, 0, -0.06, 0)]),
      };
    case 'greatsword':
      return {
        blade: merge([bx(0.075, 0.92, 0.014, 0, 0.58, 0), new THREE.ConeGeometry(0.053, 0.1, 4).rotateY(Math.PI / 4).scale(1, 1, 0.2).translate(0, 1.09, 0)]),
        trim: merge([bx(0.26, 0.03, 0.04, 0, 0.1, 0), cyl(0.018, 0.018, 0.16, 0, 0.0, 0, 6), sph(0.028, 0, -0.09, 0)]),
      };
  }
}

function build(t: PieceType): Spec {
  const plinth = lathe(PLINTH);
  switch (t) {
    case 'p': {
      const h = head(0.62, 0.12);
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.22, 0.1], [0.2, 0.2], [0.13, 0.42], [0.15, 0.48], [0.1, 0.52], [0, 0.52]])]),
          trim: merge([RIM(), new THREE.TorusGeometry(0.14, 0.018, 6, 24).rotateX(Math.PI / 2).translate(0, 0.47, 0), sph(0.13, 0, 0.66, -0.01, 1, 0.75, 1).translate(0, 0.02, 0)]),
          mask: h.mask,
          eye: h.eye,
        },
        shoulder: new THREE.Vector3(-0.18, 0.46, 0.02),
        weapon: weaponGeo('spear'),
        shield: { trim: cyl(0.13, 0.13, 0.025, 0, 0, 0, 20).rotateX(Math.PI / 2), cloth: cyl(0.1, 0.1, 0.03, 0, 0, 0.002, 20).rotateX(Math.PI / 2) },
      };
    }
    case 'n': {
      const shape = new THREE.Shape(HORSE.map(([x, y]) => new THREE.Vector2(x * 0.012, y * 0.012)));
      const horse = new THREE.ExtrudeGeometry(shape, { depth: 0.13, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.025, bevelSegments: 3, curveSegments: 4 });
      horse.translate(0, 0, -0.065).rotateY(-Math.PI / 2).translate(0, 0.35, 0);
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.26, 0.1], [0.22, 0.22], [0.17, 0.5], [0.2, 0.56], [0, 0.56]])]),
          mask: horse,
          trim: merge([RIM(), new THREE.TorusGeometry(0.19, 0.022, 6, 24).rotateX(Math.PI / 2).translate(0, 0.55, 0)]),
          eye: merge([sph(0.022, -0.1, 0.92, 0.12), sph(0.022, 0.1, 0.92, 0.12)]),
          cloth: new THREE.ConeGeometry(0.05, 0.3, 4).translate(0, 1.12, -0.12).rotateX(-0.3),
        },
        shoulder: new THREE.Vector3(-0.22, 0.54, 0.04),
        weapon: weaponGeo('lance'),
      };
    }
    case 'b': {
      const h = head(0.9, 0.12);
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.27, 0.1], [0.2, 0.3], [0.13, 0.7], [0.16, 0.76], [0.1, 0.8], [0, 0.8]])]),
          cloth: merge([lathe([[0, 0.98], [0.13, 1.0], [0.12, 1.12], [0.06, 1.28], [0, 1.36]]), new THREE.TorusGeometry(0.2, 0.03, 6, 24).rotateX(Math.PI / 2).translate(0, 0.74, 0)]),
          trim: merge([RIM(), bx(0.03, 0.34, 0.2, 0, 1.16, 0.0).rotateY(0), new THREE.TorusGeometry(0.13, 0.014, 6, 24).rotateX(Math.PI / 2).translate(0, 1.0, 0)]),
          mask: h.mask,
          eye: h.eye,
        },
        shoulder: new THREE.Vector3(-0.2, 0.72, 0.03),
        weapon: weaponGeo('staff'),
      };
    }
    case 'r': {
      const h = head(0.86, 0.11);
      const cren: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        cren.push(bx(0.1, 0.14, 0.08, Math.cos(a) * 0.24, 1.1, Math.sin(a) * 0.24).rotateY(0));
      }
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.34, 0.1], [0.3, 0.2], [0.28, 0.78], [0.32, 0.84], [0.3, 1.02], [0.2, 1.02], [0.2, 0.96], [0, 0.96]]), ...cren]),
          trim: merge([RIM(), new THREE.TorusGeometry(0.3, 0.025, 6, 30).rotateX(Math.PI / 2).translate(0, 0.8, 0), new THREE.TorusGeometry(0.29, 0.02, 6, 30).rotateX(Math.PI / 2).translate(0, 0.3, 0)]),
          mask: h.mask,
          eye: h.eye,
        },
        shoulder: new THREE.Vector3(-0.33, 0.78, 0.04),
        weapon: weaponGeo('hammer'),
      };
    }
    case 'q': {
      const h = head(1.02, 0.11);
      const spikes: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        spikes.push(new THREE.ConeGeometry(0.022, 0.16, 5).translate(Math.cos(a) * 0.1, 1.2, Math.sin(a) * 0.1));
      }
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.3, 0.1], [0.24, 0.2], [0.12, 0.72], [0.1, 0.84], [0.15, 0.88], [0.07, 0.92], [0, 0.92]])]),
          cloth: lathe([[0.31, 0.12], [0.26, 0.26], [0.15, 0.55], [0.12, 0.72], [0.0, 0.72]]),
          trim: merge([RIM(), new THREE.TorusGeometry(0.1, 0.016, 6, 24).rotateX(Math.PI / 2).translate(0, 1.12, 0), ...spikes, sph(0.03, 0, 1.3, 0)]),
          mask: h.mask,
          eye: h.eye,
        },
        shoulder: new THREE.Vector3(-0.15, 0.84, 0.03),
        weapon: weaponGeo('rapier'),
      };
    }
    case 'k': {
      const h = head(1.1, 0.12);
      const pts: THREE.BufferGeometry[] = [];
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        pts.push(new THREE.ConeGeometry(0.03, 0.12, 4).translate(Math.cos(a) * 0.12, 1.3, Math.sin(a) * 0.12));
      }
      return {
        parts: {
          body: merge([plinth, lathe([[0, 0.1], [0.32, 0.1], [0.27, 0.22], [0.16, 0.78], [0.2, 0.9], [0.12, 0.98], [0, 0.98]])]),
          cloth: merge([
            // cape behind the king
            lathe([[0.3, 0.14], [0.24, 0.5], [0.2, 0.96], [0.0, 0.96]], 16).scale(1.05, 1, 0.9).translate(0, 0, -0.03),
          ]),
          trim: merge([
            RIM(),
            lathe([[0, 1.2], [0.14, 1.2], [0.14, 1.3], [0.12, 1.3], [0.12, 1.24], [0, 1.24]]),
            ...pts,
            bx(0.035, 0.22, 0.035, 0, 1.45, 0),
            bx(0.14, 0.035, 0.035, 0, 1.49, 0),
            new THREE.TorusGeometry(0.2, 0.025, 6, 24).rotateX(Math.PI / 2).translate(0, 0.88, 0),
          ]),
          mask: h.mask,
          eye: h.eye,
        },
        shoulder: new THREE.Vector3(-0.22, 0.88, 0.04),
        weapon: weaponGeo('greatsword'),
      };
    }
  }
}

const specCache = new Map<PieceType, Spec>();
const spec = (t: PieceType) => {
  let s = specCache.get(t);
  if (!s) specCache.set(t, (s = build(t)));
  return s;
};
const armGeo = cyl(0.035, 0.03, 0.28, 0, -0.14, 0, 8);
const plinthGlowGeo = new THREE.RingGeometry(0.4, 0.55, 40).rotateX(-Math.PI / 2);

const tmpW = new THREE.Vector3();

// ---- the unit -----------------------------------------------------------------------

export class Unit {
  readonly root = new THREE.Group();
  /** Posed part: leans, crouches and bobs (child of root). */
  readonly body = new THREE.Group();
  /** Shoulder pivot holding arm + weapon; rotation.x swings it forward/back. */
  readonly arm = new THREE.Group();
  readonly weapon = new THREE.Group();
  readonly shield?: THREE.Group;
  readonly shoulder: THREE.Vector3;
  readonly height: number;
  readonly weaponKind: WeaponKind;
  readonly u: DissolveUniforms;
  private readonly glow: THREE.Mesh;
  private readonly phase = Math.random() * 10;
  /** Direction the unit faces when idle (radians about y). */
  homeYaw = 0;
  /** Overrides the idle animation while a choreography drives the unit. */
  busy = false;
  /** 0..1, set when the side is thinking or the king is in check. */
  aura = 0;
  kneel = 0;

  constructor(
    readonly type: PieceType,
    readonly color: PieceColor,
    readonly faction: Faction,
    scale = 1,
  ) {
    const s = spec(type);
    const pal = PALETTES[faction]();
    this.u = {
      uDissolve: { value: 0 },
      uFlash: { value: 0 },
      uEdge: { value: pal.edge.clone() },
      uBaseY: { value: 0 },
      uHeight: { value: UNIT_H[type] },
      uGlow: { value: 0 },
    };
    const mat = (k: Part) => dissolvable(pal[k], this.u);
    const mats = new Map<Part, THREE.Material>();
    const m = (k: Part) => {
      let x = mats.get(k);
      if (!x) mats.set(k, (x = mat(k)));
      return x;
    };
    const add = (g: THREE.Object3D, parts: Partial<Record<Part, THREE.BufferGeometry>>) => {
      for (const [k, geo] of Object.entries(parts) as [Part, THREE.BufferGeometry][]) {
        const mesh = new THREE.Mesh(geo, m(k));
        mesh.castShadow = faction !== 'stone';
        mesh.receiveShadow = true;
        g.add(mesh);
      }
    };
    add(this.body, s.parts);
    this.shoulder = s.shoulder.clone();
    this.arm.position.copy(s.shoulder);
    const armMesh = new THREE.Mesh(armGeo, m('cloth'));
    armMesh.castShadow = true;
    this.arm.add(armMesh);
    this.weapon.position.set(0, -0.26, 0.06);
    add(this.weapon, s.weapon);
    this.arm.add(this.weapon);
    this.body.add(this.arm);
    if (s.shield) {
      this.shield = new THREE.Group();
      add(this.shield, s.shield);
      this.shield.position.set(0.2, 0.36, 0.1);
      this.shield.rotation.y = 0.5;
      this.body.add(this.shield);
    }
    this.weaponKind = WEAPON[type];
    this.height = UNIT_H[type] * scale;
    this.root.add(this.body);
    this.root.scale.setScalar(scale);

    this.glow = new THREE.Mesh(
      plinthGlowGeo,
      new THREE.MeshBasicMaterial({ color: pal.edge, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.glow.position.y = 0.012;
    this.root.add(this.glow);
    this.rest();
  }

  /** Default pose: weapon held upright at the side, a little forward. */
  rest() {
    this.arm.rotation.set(-0.15, 0, 0.12);
    this.weapon.rotation.set(0.25, 0, 0);
    this.weapon.position.set(0, -0.26, 0.06);
    this.body.position.set(0, 0, 0);
    this.body.rotation.set(0, 0, 0);
    this.body.scale.set(1, 1, 1);
    if (this.weaponKind === 'greatsword' || this.weaponKind === 'hammer') this.weapon.rotation.x = 0.1;
  }

  setDissolve(v: number) {
    this.u.uDissolve.value = v;
  }
  setFlash(v: number) {
    this.u.uFlash.value = v;
  }

  update(time: number, dt: number, reduced: boolean) {
    this.u.uBaseY.value = this.root.getWorldPosition(tmpW).y; // the arena may be raised
    const gm = this.glow.material as THREE.MeshBasicMaterial;
    gm.opacity += ((this.aura > 0 ? 0.35 + 0.35 * Math.sin(time * 5) * this.aura : 0) - gm.opacity) * Math.min(1, dt * 6);
    if (this.busy) return;
    this.u.uGlow.value = this.aura * (0.15 + 0.1 * Math.sin(time * 5));
    const b = reduced ? 0 : 1;
    const ph = time * 1.6 + this.phase;
    this.body.position.y = Math.sin(ph) * 0.012 * b - this.kneel * 0.18;
    this.body.rotation.x = this.kneel * 0.5;
    this.body.scale.y = 1 + Math.sin(ph) * 0.01 * b;
    this.arm.rotation.x = -0.15 + Math.sin(ph * 0.7) * 0.04 * b + this.kneel * 0.9;
    this.root.rotation.y += (this.homeYaw - this.root.rotation.y) * Math.min(1, dt * 5);
  }

  /** World position of the weapon tip (for sparks and bolts). */
  tip(out = new THREE.Vector3()): THREE.Vector3 {
    const len = { spear: 0.92, lance: 1.15, staff: 0.86, hammer: 0.6, rapier: 0.86, greatsword: 1.1 }[this.weaponKind];
    return this.weapon.localToWorld(out.set(0, len, 0));
  }

  dispose() {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        const mm = mesh.material as THREE.Material;
        mm.dispose();
      }
    });
  }
}
