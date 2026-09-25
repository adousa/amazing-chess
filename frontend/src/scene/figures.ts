// The two players, built from primitives: the Knight (our engine, seen from behind) and
// Death (Stockfish) across the board. Each has two arms driven by two-bone IK, so a hand
// can be sent to any point above the board and the body leans in when it has to reach.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rng } from './noise';
import { TABLE_TOP } from './pieces';

type V3 = THREE.Vector3;
const Y = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();

type Profile = [number, number][];
const lathe = (pts: Profile, segs = 36) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), segs);

function limbGeometry(rFrom: number, rTo: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTo, rFrom, 1, 16, 1, false);
  return g.translate(0, 0.5, 0); // base at the origin, pointing +y
}

/** Stretch a limb mesh (built by `limbGeometry`) from a to b. */
function setLimb(m: THREE.Object3D, a: V3, b: V3) {
  const d = tmp.subVectors(b, a);
  const len = Math.max(d.length(), 1e-4);
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(Y, d.divideScalar(len));
  m.scale.set(1, len, 1);
}

/**
 * A hand from wrist (y = 0) to fingertips (y = 1): a palm and four fingers plus a thumb.
 * x/z are in metres, y is stretched to the wrist-to-fingertip length by `setLimb`.
 */
function handGeometry(r: number): THREE.BufferGeometry {
  const w = r * 2.6;
  const parts: THREE.BufferGeometry[] = [];
  const palm = new THREE.BoxGeometry(w, 0.52, r * 0.9);
  palm.translate(0, 0.28, 0);
  parts.push(palm);
  for (let i = 0; i < 4; i++) {
    const len = [0.36, 0.44, 0.46, 0.4][i];
    const f = new THREE.CylinderGeometry(r * 0.22, r * 0.27, len, 6);
    f.translate((i - 1.5) * (w / 4), 0.54 + len / 2, 0);
    parts.push(f);
  }
  // no rotation here: y is stretched later, so a tilted thumb would grow sideways
  const thumb = new THREE.CylinderGeometry(r * 0.24, r * 0.3, 0.36, 6);
  thumb.translate(w * 0.62, 0.36, r * 0.25);
  parts.push(thumb);
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;
}

interface ArmOpts {
  upper: number;
  fore: number;
  hand: number;
  rUpper: [number, number];
  rFore: [number, number];
  rHand: number;
  sleeve: THREE.Material;
  skin: THREE.Material;
}

export class Arm {
  readonly target = new THREE.Vector3();
  readonly rest: V3;
  /** True while the arm is playing a move: the hand turns down to grip from above. */
  active = false;
  private grip = 0;
  private readonly pole: V3;
  private readonly upper: THREE.Mesh;
  private readonly fore: THREE.Mesh;
  private readonly elbow: THREE.Mesh;
  private readonly hand: THREE.Mesh;
  private readonly S = new THREE.Vector3();
  private readonly E = new THREE.Vector3();
  private readonly W = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    readonly shoulder: THREE.Object3D,
    rest: V3,
    pole: V3,
    private readonly o: ArmOpts,
  ) {
    this.rest = rest.clone();
    this.target.copy(rest);
    this.pole = pole.clone().normalize();
    this.upper = new THREE.Mesh(limbGeometry(o.rUpper[0], o.rUpper[1]), o.sleeve);
    this.fore = new THREE.Mesh(limbGeometry(o.rFore[0], o.rFore[1]), o.sleeve);
    this.elbow = new THREE.Mesh(new THREE.SphereGeometry(o.rUpper[1], 14, 10), o.sleeve);
    this.hand = new THREE.Mesh(handGeometry(o.rHand), o.skin);
    for (const m of [this.upper, this.fore, this.elbow, this.hand]) {
      m.castShadow = true;
      scene.add(m);
    }
  }

  get reach() {
    return this.o.upper + this.o.fore;
  }

  /**
   * Where the wrist is for given fingertips: straight above them when gripping a piece,
   * behind them (hand lying flat on the stone) at rest.
   */
  wristFor(target: V3, out: V3): V3 {
    const s = this.shoulderWorld(tmp);
    const back = new THREE.Vector3(s.x - target.x, 0, s.z - target.z).normalize();
    const g = this.grip;
    out.set(back.x * (1 - g), g + (1 - g) * 0.12, back.z * (1 - g)).normalize();
    return out.multiplyScalar(this.o.hand).add(target);
  }

  easeGrip(dt: number) {
    this.grip += ((this.active ? 1 : 0) - this.grip) * Math.min(1, dt * 7);
  }

  shoulderWorld(out: V3): V3 {
    return this.shoulder.getWorldPosition(out);
  }

  update() {
    const { upper: l1, fore: l2 } = this.o;
    this.shoulderWorld(this.S);
    this.wristFor(this.target, this.W);
    const d = new THREE.Vector3().subVectors(this.W, this.S);
    const dist = THREE.MathUtils.clamp(d.length(), 0.05, (l1 + l2) * 0.999);
    const dir = d.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(l1 * l1 - a * a, 0));
    const n = this.pole.clone().addScaledVector(dir, -this.pole.dot(dir)).normalize();
    this.E.copy(this.S).addScaledVector(dir, a).addScaledVector(n, h);
    const wrist = this.S.clone().addScaledVector(dir, dist);
    setLimb(this.upper, this.S, this.E);
    setLimb(this.fore, this.E, wrist);
    this.elbow.position.copy(this.E);
    // the hand keeps the wrist-to-fingertip offset even if the arm is fully stretched
    setLimb(this.hand, wrist, this.target.clone().add(wrist).sub(this.W));
  }
}

export class Figure {
  readonly group = new THREE.Group();
  /** Pivot at the hips; rotating it on x leans the upper body towards the board. */
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly right: Arm;
  readonly left: Arm;
  thinking = false;
  private lean = 0;
  private readonly phase: number;

  constructor(
    scene: THREE.Scene,
    build: (f: Figure) => { right: Arm; left: Arm },
    seed: number,
  ) {
    this.phase = rng(seed)() * 10;
    scene.add(this.group);
    this.group.add(this.torso);
    this.torso.add(this.head);
    const arms = build(this);
    this.right = arms.right;
    this.left = arms.left;
  }

  get arms() {
    return [this.right, this.left];
  }

  /** Smallest lean that lets every arm reach its target. */
  private neededLean(): number {
    const saved = this.torso.rotation.x;
    const W = new THREE.Vector3();
    const S = new THREE.Vector3();
    let need = 0;
    for (let lean = 0; lean <= 0.6; lean += 0.04) {
      this.torso.rotation.x = lean;
      this.group.updateMatrixWorld(true);
      need = lean;
      if (this.arms.every((a) => a.wristFor(a.target, W).distanceTo(a.shoulderWorld(S)) <= a.reach * 0.96)) break;
    }
    this.torso.rotation.x = saved;
    return need;
  }

  update(t: number, dt: number, still: boolean) {
    const breathe = still ? 0 : Math.sin(t * 1.3 + this.phase) * 0.012;
    const want = Math.max(this.neededLean(), this.thinking ? 0.12 : 0.03);
    this.lean += (want - this.lean) * Math.min(1, dt * 5);
    this.torso.rotation.x = this.lean + breathe;
    const look = still ? 0 : Math.sin(t * 0.37 + this.phase) * 0.06;
    this.head.rotation.set(0.12 + (this.thinking ? 0.18 : 0) + look * 0.4, look, 0);
    this.group.updateMatrixWorld(true);
    for (const a of this.arms) {
      a.easeGrip(dt);
      a.update();
    }
  }
}

function anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  parent.add(o);
  return o;
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, cast = true): THREE.Mesh {
  const x = new THREE.Mesh(g, m);
  x.castShadow = cast;
  x.receiveShadow = true;
  parent.add(x);
  return x;
}

function chainmailTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = '#d0d0d0';
  ctx.lineWidth = 2.2;
  for (let row = 0; row < 5; row++)
    for (let col = 0; col < 5; col++) {
      ctx.beginPath();
      ctx.arc(col * 16 + (row % 2) * 8, row * 16, 6.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function hairTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 128, 128);
  const r = rng(5);
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(60 + r() * 140);
    ctx.strokeStyle = `rgb(${v},${v},${v})`;
    const x = r() * 128, y = r() * 128;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (r() - 0.5) * 3, y + 5 + r() * 6);
    ctx.stroke();
  }
  return new THREE.CanvasTexture(c);
}

/** Our engine: a crusader knight in mail, facing -z, seen over his right shoulder. */
export function buildKnight(scene: THREE.Scene, seatZ: number): Figure {
  return new Figure(
    scene,
    (f) => {
      f.group.position.set(0, 0, seatZ);
      f.group.rotation.y = Math.PI; // model faces +z locally
      f.torso.position.y = 0.48;
      const mailTex = chainmailTexture();
      mailTex.repeat.set(14, 9);
      const mail = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, metalness: 0.65, roughness: 0.5, bumpMap: mailTex, bumpScale: 3 });
      const armMailTex = mailTex.clone();
      armMailTex.repeat.set(4, 6);
      const armMail = new THREE.MeshStandardMaterial({ color: 0x8a8a8a, metalness: 0.65, roughness: 0.5, bumpMap: armMailTex, bumpScale: 3 });
      const cloth = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.95, side: THREE.DoubleSide });
      const skin = new THREE.MeshStandardMaterial({ color: 0xc4ae9a, roughness: 0.75 });
      const hair = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 1, bumpMap: hairTexture(), bumpScale: 4 });

      const body = mesh(
        lathe([[0, 0], [0.18, 0], [0.19, 0.08], [0.16, 0.24], [0.185, 0.4], [0.2, 0.52], [0.19, 0.58], [0.11, 0.64], [0.055, 0.665], [0, 0.67]]),
        mail,
        f.torso,
      );
      body.scale.z = 0.68;
      const surcoat = mesh(lathe([[0.2, -0.04], [0.205, 0.1], [0.178, 0.24], [0.192, 0.36], [0.2, 0.44]]), cloth, f.torso);
      surcoat.scale.z = 0.72;
      const belt = mesh(new THREE.TorusGeometry(0.182, 0.012, 8, 40), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }), f.torso);
      belt.rotation.x = Math.PI / 2;
      belt.position.y = 0.24;
      belt.scale.y = 0.7;
      for (const x of [-0.2, 0.2]) mesh(new THREE.SphereGeometry(0.072, 18, 12), armMail, f.torso).position.set(x, 0.575, 0);
      const neck = mesh(new THREE.CylinderGeometry(0.05, 0.056, 0.12, 16), skin, f.torso);
      neck.position.y = 0.7;
      f.head.position.set(0, 0.76, 0);
      const skull = mesh(new THREE.SphereGeometry(0.1, 28, 20), skin, f.head);
      skull.scale.set(0.88, 1.08, 0.98);
      skull.position.y = 0.08;
      const cap = mesh(new THREE.SphereGeometry(0.105, 28, 18, 0, Math.PI * 2, 0, 2.05), hair, f.head);
      cap.scale.set(0.9, 1.08, 1.0);
      cap.position.set(0, 0.086, -0.004);
      cap.rotation.x = -0.75;
      for (const x of [-0.088, 0.088]) mesh(new THREE.SphereGeometry(0.018, 10, 8), skin, f.head).position.set(x, 0.075, -0.005);

      const opts: ArmOpts = { upper: 0.37, fore: 0.35, hand: 0.09, rUpper: [0.05, 0.044], rFore: [0.043, 0.035], rHand: 0.02, sleeve: armMail, skin };
      // right = local -x (world +x once rotated)
      const right = new Arm(scene, anchor(f.torso, -0.2, 0.575, 0), new THREE.Vector3(0.17, TABLE_TOP + 0.02, seatZ - 0.27), new THREE.Vector3(0.5, -1, 0.5), opts);
      const left = new Arm(scene, anchor(f.torso, 0.2, 0.575, 0), new THREE.Vector3(-0.19, TABLE_TOP + 0.02, seatZ - 0.25), new THREE.Vector3(-0.5, -1, 0.5), opts);
      return { right, left };
    },
    1,
  );
}

/** Stockfish: Death in a black hooded cloak with a pale face, facing +z. */
export function buildDeath(scene: THREE.Scene, seatZ: number): Figure {
  return new Figure(
    scene,
    (f) => {
      f.group.position.set(0, 0, seatZ);
      f.torso.position.y = 0.5;
      const robe = new THREE.MeshStandardMaterial({ color: 0x0b0b0b, roughness: 0.92, side: THREE.DoubleSide });
      const pale = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.85 });
      const paleHand = new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.8 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 1 });

      const skirt = mesh(lathe([[0, 0.02], [0.42, 0.02], [0.4, 0.18], [0.33, 0.42], [0.26, 0.56], [0.2, 0.62], [0, 0.62]]), robe, f.group);
      skirt.scale.z = 0.8;
      const upper = mesh(
        lathe([[0, 0], [0.26, 0], [0.21, 0.12], [0.2, 0.3], [0.23, 0.5], [0.25, 0.58], [0.2, 0.65], [0.1, 0.7], [0, 0.71]]),
        robe,
        f.torso,
      );
      upper.scale.z = 0.8;
      // hood: a shell open towards the board
      f.head.position.set(0, 0.84, 0);
      const gap = 1.5;
      const hood = mesh(new THREE.SphereGeometry(0.15, 36, 24, Math.PI / 2 + gap / 2, Math.PI * 2 - gap, 0, 2.35), robe, f.head);
      hood.scale.set(1, 1.22, 1.08);
      hood.position.y = 0.03;
      const cowl = mesh(lathe([[0.2, -0.1], [0.17, -0.02], [0.14, 0.02]]), robe, f.head);
      cowl.scale.z = 0.85;
      // face
      const face = mesh(new THREE.SphereGeometry(0.08, 28, 20), pale, f.head);
      face.scale.set(0.8, 1.12, 0.78);
      face.position.set(0, 0.0, 0.035);
      const fz = 0.035 + 0.08 * 0.78;
      for (const s of [-1, 1]) {
        const eye = mesh(new THREE.SphereGeometry(0.017, 14, 10), dark, f.head, false);
        eye.scale.set(1.25, 0.8, 0.5);
        eye.position.set(s * 0.027, 0.014, fz - 0.009);
        const brow = mesh(new THREE.BoxGeometry(0.032, 0.005, 0.01), dark, f.head, false);
        brow.position.set(s * 0.027, 0.036, fz - 0.012);
        brow.rotation.z = s * 0.28;
      }
      const mouth = mesh(new THREE.BoxGeometry(0.03, 0.0035, 0.008), dark, f.head, false);
      mouth.position.set(0, -0.046, fz - 0.014);
      const nose = mesh(new THREE.SphereGeometry(0.011, 10, 8), pale, f.head, false);
      nose.position.set(0, -0.008, fz + 0.004);

      const opts: ArmOpts = { upper: 0.37, fore: 0.36, hand: 0.095, rUpper: [0.06, 0.052], rFore: [0.05, 0.075], rHand: 0.018, sleeve: robe, skin: paleHand };
      // right = local -x (Death is not rotated, so world -x)
      const right = new Arm(scene, anchor(f.torso, -0.22, 0.58, 0), new THREE.Vector3(-0.18, TABLE_TOP + 0.02, seatZ + 0.27), new THREE.Vector3(-0.6, -1, -0.5), opts);
      const left = new Arm(scene, anchor(f.torso, 0.22, 0.58, 0), new THREE.Vector3(0.2, TABLE_TOP + 0.02, seatZ + 0.25), new THREE.Vector3(0.6, -1, -0.5), opts);
      return { right, left };
    },
    2,
  );
}
