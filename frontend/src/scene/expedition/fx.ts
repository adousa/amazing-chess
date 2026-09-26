// Battle effects: petal bursts (the gommage), sparks, impact light, shockwave rings,
// sword slashes and magic bolts. All pooled, all additive or petal-shaded.
import * as THREE from 'three';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();

function petalGeometry(): THREE.BufferGeometry {
  // a cupped teardrop
  const s = new THREE.Shape();
  s.moveTo(0, -0.5);
  s.bezierCurveTo(0.55, -0.25, 0.45, 0.35, 0, 0.5);
  s.bezierCurveTo(-0.45, 0.35, -0.55, -0.25, 0, -0.5);
  const g = new THREE.ShapeGeometry(s, 6);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setZ(i, p.getX(i) * p.getX(i) * 0.6);
  g.computeVertexNormals();
  return g;
}

interface Petal {
  p: THREE.Vector3;
  v: THREE.Vector3;
  rot: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
  max: number;
  size: number;
}

export class Petals {
  readonly mesh: THREE.InstancedMesh;
  private readonly ps: Petal[] = [];
  private next = 0;
  constructor(
    scene: THREE.Object3D,
    private readonly count: number,
    emissive = 0.35,
  ) {
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: emissive, vertexColors: false });
    // emissive follows the instance colour so petals glow in their own hue
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\ntotalEmissiveRadiance *= vColor;\n#endif',
      );
    };
    this.mesh = new THREE.InstancedMesh(petalGeometry(), mat, count);
    this.mesh.frustumCulled = false;
    for (let i = 0; i < count; i++) {
      this.ps.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, max: 0, size: 0 });
      this.mesh.setColorAt(i, tmpC.set(0xffffff));
      this.mesh.setMatrixAt(i, tmpM.makeScale(0, 0, 0));
    }
    scene.add(this.mesh);
  }

  emit(pos: THREE.Vector3, opts: { vel?: THREE.Vector3; spread?: number; speed?: number; life?: number; size?: number; colors: number[]; radius?: number; height?: number }) {
    const i = this.next;
    this.next = (this.next + 1) % this.count;
    const q = this.ps[i];
    const r = opts.radius ?? 0;
    const a = Math.random() * Math.PI * 2;
    q.p.set(pos.x + Math.cos(a) * r * Math.random(), pos.y + Math.random() * (opts.height ?? 0), pos.z + Math.sin(a) * r * Math.random());
    const sp = opts.speed ?? 1;
    q.v.set((Math.random() - 0.5) * 2, Math.random() * 1.2 + 0.3, (Math.random() - 0.5) * 2).multiplyScalar(sp * (opts.spread ?? 1));
    if (opts.vel) q.v.add(opts.vel);
    q.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    q.spin.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8);
    q.max = q.life = (opts.life ?? 2.4) * (0.7 + Math.random() * 0.6);
    q.size = (opts.size ?? 0.09) * (0.6 + Math.random() * 0.8);
    this.mesh.setColorAt(i, tmpC.set(opts.colors[Math.floor(Math.random() * opts.colors.length)]));
    this.mesh.instanceColor!.needsUpdate = true;
  }

  burst(pos: THREE.Vector3, n: number, opts: Parameters<Petals['emit']>[1]) {
    for (let i = 0; i < n; i++) this.emit(pos, opts);
  }

  update(dt: number, time: number, wind: THREE.Vector3) {
    for (let i = 0; i < this.count; i++) {
      const q = this.ps[i];
      if (q.life <= 0) continue;
      q.life -= dt;
      // flutter: drag towards the wind plus a little lift and swirl
      q.v.x += (wind.x - q.v.x) * dt * 0.9 + Math.sin(time * 3 + i) * dt * 0.6;
      q.v.z += (wind.z - q.v.z) * dt * 0.9 + Math.cos(time * 2.6 + i * 1.3) * dt * 0.6;
      q.v.y += (wind.y - q.v.y) * dt * 0.8;
      q.p.addScaledVector(q.v, dt);
      q.rot.addScaledVector(q.spin, dt);
      const k = q.life / q.max;
      const s = q.life <= 0 ? 0 : q.size * Math.min(1, (1 - k) * 8) * Math.min(1, k * 3);
      tmpQ.setFromEuler(tmpE.set(q.rot.x, q.rot.y, q.rot.z));
      this.mesh.setMatrixAt(i, tmpM.compose(q.p, tmpQ, tmpS.set(s, s, s)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Always-on petals drifting through the whole scene. */
export class AmbientPetals {
  readonly mesh: THREE.InstancedMesh;
  private readonly seeds: Float32Array;
  constructor(scene: THREE.Scene, private readonly count = 260) {
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.7, emissive: 0xffffff, emissiveIntensity: 0.25 });
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n#ifdef USE_INSTANCING_COLOR\ntotalEmissiveRadiance *= vColor;\n#endif',
      );
    };
    this.mesh = new THREE.InstancedMesh(petalGeometry(), mat, count);
    this.mesh.frustumCulled = false;
    this.seeds = new Float32Array(count * 4);
    const cols = [0xc81d2c, 0xe8394a, 0xf2e6d0, 0xe0a84a, 0xb3122a];
    for (let i = 0; i < count; i++) {
      this.seeds.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
      this.mesh.setColorAt(i, tmpC.set(cols[i % cols.length]));
    }
    scene.add(this.mesh);
  }
  update(time: number, reduced: boolean) {
    const t = reduced ? 0 : time;
    for (let i = 0; i < this.count; i++) {
      const [a, b, c, d] = this.seeds.subarray(i * 4, i * 4 + 4);
      const span = 34;
      const x = ((a * span + t * (0.6 + c * 0.5)) % span) - span / 2;
      const z = ((b * span + t * 0.25) % span) - span / 2 - 4;
      const y = 0.3 + c * 7 + Math.sin(t * (0.5 + d) + a * 20) * 0.6;
      tmpQ.setFromEuler(tmpE.set(t * (1 + d) + a * 9, t * 0.7 + b * 9, t * (0.6 + c) + d * 9));
      const s = 0.06 + d * 0.07;
      this.mesh.setMatrixAt(i, tmpM.compose(tmpS.set(x, y, z), tmpQ, new THREE.Vector3(s, s, s)));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Hot sparks flying from a clash, with gravity. */
export class Sparks {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly col: Float32Array;
  private next = 0;
  constructor(scene: THREE.Object3D, private readonly count = 400) {
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.col = new Float32Array(count * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({ size: 0.07, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  burst(at: THREE.Vector3, n: number, color: THREE.Color, speed = 4, dir?: THREE.Vector3) {
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.count;
      this.pos.set([at.x, at.y, at.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      if (dir) v.addScaledVector(dir, speed * 0.6);
      this.vel.set([v.x, v.y, v.z], i * 3);
      this.life[i] = 0.35 + Math.random() * 0.5;
      this.col.set([color.r * 3, color.g * 3, color.b * 3], i * 3);
    }
  }
  update(dt: number) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9 * dt;
      for (let j = 0; j < 3; j++) this.pos[i * 3 + j] += this.vel[i * 3 + j] * dt;
      if (this.life[i] <= 0) this.pos[i * 3 + 1] = -100;
      const f = Math.max(0, Math.min(1, this.life[i] * 3));
      this.col[i * 3] *= 0.9 + 0.1 * f;
      this.col[i * 3 + 1] *= 0.86 + 0.14 * f;
      this.col[i * 3 + 2] *= 0.8 + 0.2 * f;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }
}

/** Short-lived additive meshes: shockwave rings, slash arcs, bolts. */
interface Transient {
  mesh: THREE.Mesh;
  t: number;
  dur: number;
  tick: (k: number, m: THREE.Mesh) => void;
}

function glowMaterial(color: THREE.ColorRepresentation) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
}

export class Transients {
  private readonly items: Transient[] = [];
  private readonly ringGeo = new THREE.RingGeometry(0.85, 1, 64).rotateX(-Math.PI / 2);
  private readonly slashGeo = (() => {
    // a crescent swept through ~200°, thick in the middle, fading at the ends via vertex colour
    const g = new THREE.RingGeometry(0.55, 0.78, 48, 1, -0.2, Math.PI * 1.15);
    const p = g.attributes.position as THREE.BufferAttribute;
    const c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const a = Math.atan2(p.getY(i), p.getX(i));
      const k = Math.sin(Math.max(0, Math.min(1, (a + 0.2) / (Math.PI * 1.15))) * Math.PI);
      c.set([k, k, k], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    return g;
  })();
  private readonly boltGeo = new THREE.SphereGeometry(0.09, 16, 10);
  constructor(private readonly scene: THREE.Object3D) {}

  private add(mesh: THREE.Mesh, dur: number, tick: Transient['tick']) {
    this.scene.add(mesh);
    this.items.push({ mesh, t: 0, dur, tick });
    tick(0, mesh);
  }

  ring(at: THREE.Vector3, color: THREE.ColorRepresentation, maxR = 2.2, dur = 0.6) {
    const m = new THREE.Mesh(this.ringGeo, glowMaterial(color));
    m.position.copy(at).setY(at.y + 0.03);
    this.add(m, dur, (k, mm) => {
      mm.scale.setScalar(0.1 + maxR * (1 - Math.pow(1 - k, 3)));
      (mm.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 1.4;
    });
  }

  /** A slash crescent at `at`, in the plane facing `dir`, tilted by `roll`. */
  slash(at: THREE.Vector3, dir: THREE.Vector3, color: THREE.ColorRepresentation, roll = 0, size = 1, dur = 0.32) {
    const mat = glowMaterial(color);
    mat.vertexColors = true;
    const m = new THREE.Mesh(this.slashGeo, mat);
    m.position.copy(at);
    m.lookAt(at.clone().add(new THREE.Vector3(-dir.z, 0, dir.x)));
    m.rotateZ(roll);
    this.add(m, dur, (k, mm) => {
      mm.scale.setScalar(size * (0.7 + k * 0.5));
      mm.rotateZ(0.05);
      (mm.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.min(1, k * 1.3) * Math.PI) * 1.6;
    });
  }

  /** A glowing bolt that flies from a to b and calls onHit when it lands. */
  bolt(a: THREE.Vector3, b: THREE.Vector3, color: THREE.ColorRepresentation, dur: number, onHit: () => void) {
    const m = new THREE.Mesh(this.boltGeo, glowMaterial(color));
    const light = new THREE.PointLight(color, 0, 4, 1.6);
    m.add(light);
    const trail: THREE.Mesh[] = [];
    let hit = false;
    this.add(m, dur, (k, mm) => {
      const e = k * k;
      mm.position.lerpVectors(a, b, e);
      mm.position.y += Math.sin(k * Math.PI) * 0.6;
      mm.scale.setScalar(0.8 + Math.sin(k * 40) * 0.2);
      light.intensity = 6;
      if (trail.length < 14 && k < 0.95) {
        const t = new THREE.Mesh(this.boltGeo, glowMaterial(color));
        t.position.copy(mm.position);
        this.add(t, 0.3, (kk, tm) => {
          tm.scale.setScalar(0.7 * (1 - kk));
          (tm.material as THREE.MeshBasicMaterial).opacity = (1 - kk) * 0.8;
        });
        trail.push(t);
      }
      if (k >= 1 && !hit) {
        hit = true;
        onHit();
      }
    });
  }

  /** A column of light (promotion). */
  pillar(at: THREE.Vector3, color: THREE.ColorRepresentation, dur = 1.2) {
    const g = new THREE.CylinderGeometry(0.45, 0.6, 8, 32, 1, true).translate(0, 4, 0);
    const m = new THREE.Mesh(g, glowMaterial(color));
    m.position.copy(at);
    this.add(m, dur, (k, mm) => {
      (mm.material as THREE.MeshBasicMaterial).opacity = Math.sin(k * Math.PI) * 0.7;
      mm.scale.set(1 - k * 0.6, 1, 1 - k * 0.6);
    });
  }

  update(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;
      const k = Math.min(1, it.t / it.dur);
      it.tick(k, it.mesh);
      if (k >= 1) {
        this.scene.remove(it.mesh);
        (it.mesh.material as THREE.Material).dispose();
        it.mesh.traverse((o) => (o as THREE.PointLight).isPointLight && (o as THREE.PointLight).dispose());
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      (it.mesh.material as THREE.Material).dispose();
    }
    this.items.length = 0;
  }
}
