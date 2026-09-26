// The Expedition stage: a painterly, golden-hour battlefield where the chess pieces are
// armed warriors. Quiet moves are marched, leapt or glided; every capture is a duel: the
// camera cuts in, the attacker winds up and strikes in slow motion, and the victim
// dissolves into petals (the gommage) before the attacker takes the square.
import * as THREE from 'three';
import { Chess, type Move as ChessMove } from 'chess.js';
import {
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
  ToneMappingMode,
} from 'postprocessing';
import type { PieceColor, PieceType } from '../pieces';
import type { Captured, Side, View } from '../SealScene';
import { AmbientPetals, Petals, Sparks, Transients } from './fx';
import { PainterlyEffect } from './painterly';
import { Unit } from './units';
import { buildWorld, type World } from './world';

const VIEWS: Record<View, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  // low enough that the sea, the city with its bent tower and the Monolith rise behind the board
  shoulder: { pos: new THREE.Vector3(0, 6.4, 12.6), look: new THREE.Vector3(0, 1.3, -9), fov: 52 },
  above: { pos: new THREE.Vector3(0, 13.5, 2.4), look: new THREE.Vector3(0, 0, 0.1), fov: 40 },
};
const WIND = new THREE.Vector3(0.7, 0.55, -0.25);
/** How high the arena rises for a duel. */
/** The arena's slow, endless ascent: peak height (m) and one up-and-down cycle (s). */
const ARENA_PEAK = 16;
const ARENA_CYCLE = 360;
const DUST_WIND = new THREE.Vector3(0.3, -0.2, -0.1);
const PETALS: Record<PieceColor | 'exp' | 'nev', number[]> = {
  exp: [0xf6ecd8, 0xe3b45a, 0xffffff, 0xa9c6ea],
  nev: [0xc41a2e, 0x6a0b18, 0xff4658, 0x2a1418],
  w: [],
  b: [],
};
const HIT = { exp: new THREE.Color(1, 0.8, 0.45), nev: new THREE.Color(1, 0.2, 0.3) };

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeIn = (k: number) => k * k * k;
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const yawTo = (from: THREE.Vector3, to: THREE.Vector3) => Math.atan2(to.x - from.x, to.z - from.z);
function lerpAngle(a: number, b: number, k: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

// ---- a tiny timeline -----------------------------------------------------------------

interface Clip {
  at: number;
  dur: number;
  run?: (k: number) => void;
  start?: () => void;
  end?: () => void;
  s?: boolean;
  e?: boolean;
}
class Timeline {
  t = 0;
  readonly clips: Clip[] = [];
  private readonly slow: { at: number; dur: number; scale: number }[] = [];
  length = 0;
  /** Added to every `at` (lets a choreography be pushed back behind an intro shot). */
  offset = 0;
  add(at: number, dur: number, run?: Clip['run'], start?: Clip['start'], end?: Clip['end']) {
    at += this.offset;
    this.clips.push({ at, dur, run, start, end });
    this.length = Math.max(this.length, at + dur);
  }
  at(at: number, fn: () => void) {
    this.add(at, 0, undefined, fn);
  }
  slowmo(at: number, dur: number, scale: number) {
    this.slow.push({ at: at + this.offset, dur, scale });
  }
  scale(): number {
    for (const s of this.slow) if (this.t >= s.at && this.t < s.at + s.dur) return s.scale;
    return 1;
  }
  realSeconds(): number {
    return this.length + this.slow.reduce((a, s) => a + s.dur / s.scale - s.dur, 0);
  }
  tick(dt: number): boolean {
    this.t += dt;
    for (const c of this.clips) {
      if (c.e || this.t < c.at) continue;
      if (!c.s) {
        c.s = true;
        c.start?.();
      }
      const k = c.dur > 0 ? Math.min(1, (this.t - c.at) / c.dur) : 1;
      c.run?.(k);
      if (k >= 1) {
        c.e = true;
        c.end?.();
      }
    }
    return this.t >= this.length && this.clips.every((c) => c.e);
  }
}

interface Final {
  fen: string;
  captured: Captured;
  uci: string;
}

export class ExpeditionScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 2000);
  private readonly composer: EffectComposer;
  private readonly painterly = new PainterlyEffect(3);
  private readonly bloom: BloomEffect;
  private readonly chroma: ChromaticAberrationEffect;
  private readonly world: World;
  private readonly petals: Petals;
  /** Stone dust shaken loose while the arena rises or sinks (world space). */
  private readonly dust: Petals;
  private readonly ambient: AmbientPetals;
  private readonly sparks: Sparks;
  private readonly fx: Transients;
  private readonly units = new THREE.Group();
  private readonly highlight: THREE.Mesh[];
  private readonly impactLight = new THREE.PointLight(0xffd9a0, 0, 7, 1.5);
  private readonly ro: ResizeObserver;
  private readonly reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  readonly views = VIEWS;
  /** Dev tuning: slows the whole stage down (1 = normal). */
  debugSpeed = 1;

  private ourColor: Side = 'white';
  private bySquare = new Map<string, Unit>();
  private statues: Unit[] = [];
  private placedKey = '';
  private thinking: 'engine' | 'stockfish' | null = null;
  private cinematic = true;
  private tl: Timeline | null = null;
  private final: Final | null = null;
  private view: View = 'shoulder';
  private camPos = VIEWS.shoulder.pos.clone();
  private camLook = VIEWS.shoulder.look.clone();
  private camFov = VIEWS.shoulder.fov;
  /** The viewer's own Battle camera (orbit around a target, arena space), saved in the browser. */
  private orbit: { r: number; theta: number; phi: number; target: THREE.Vector3 } | null = loadOrbit();
  private drag: { mode: 'orbit' | 'pan'; x: number; y: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  /** The duel camera, in arena space (it rides the arena as it rises). */
  private cine: { pos: THREE.Vector3; look: THREE.Vector3; fov: number; speed: number } | null = null;
  private shake = 0;
  /** Arena elevator: seconds into its ascent cycle. */
  private elev = 0;
  private flash = 0;
  private bloomBoost = 0;
  private letterbox = 0;
  private pointer = new THREE.Vector2();
  /** Adaptive resolution: frame-time samples, and the current pixel ratio. */
  private perf = { acc: 0, n: 0, last: 0, ratio: Math.min(window.devicePixelRatio, 1.5) };
  private time = 0;
  private last = performance.now();

  constructor(private readonly el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.setPixelRatio(this.perf.ratio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    el.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.world = buildWorld(this.scene, this.renderer, this.reduced);
    // everything that fights lives on the arena, so it all rides up with it
    const arena = this.world.arena;
    arena.add(this.units, this.impactLight);
    this.petals = new Petals(arena, 1400);
    this.dust = new Petals(this.scene, 500, 0.05);
    this.ambient = new AmbientPetals(this.scene, this.reduced ? 80 : 260);
    this.sparks = new Sparks(arena, 500);
    this.fx = new Transients(arena);
    document.fonts?.ready.then(() => this.world.setOrientation(this.ourColor === 'white'));

    const hlMat = new THREE.MeshBasicMaterial({ color: 0xffc766, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending });
    this.highlight = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2), hlMat);
      m.visible = false;
      arena.add(m);
      return m;
    });

    this.composer = new EffectComposer(this.renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 4 });
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new BloomEffect({ mipmapBlur: true, intensity: 1.0, luminanceThreshold: 0.82, luminanceSmoothing: 0.25, radius: 0.72 });
    this.composer.addPass(new EffectPass(this.camera, this.bloom, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));
    this.composer.addPass(new EffectPass(this.camera, this.painterly));
    this.chroma = new ChromaticAberrationEffect({ offset: new THREE.Vector2(0.0004, 0.0004), radialModulation: true, modulationOffset: 0.25 });
    this.composer.addPass(new EffectPass(this.camera, this.chroma));

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    el.addEventListener('pointermove', this.onPointer);
    el.addEventListener('pointerleave', this.onLeave);
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('dblclick', this.onDblClick);
    el.addEventListener('contextmenu', this.onContext);
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    this.renderer.setAnimationLoop(this.frame);
  }

  // ---- public API -----------------------------------------------------------------

  setOrientation(c: Side) {
    if (c === this.ourColor) return;
    this.ourColor = c;
    this.placedKey = '';
    this.world.setOrientation(c === 'white');
  }
  /** Back to the default Battle camera (and forget the saved one). */
  resetCamera() {
    this.orbit = null;
    saveOrbit(null);
    this.resize();
  }

  setView(v: View) {
    this.view = v;
  }
  setCinematic(on: boolean) {
    this.cinematic = on;
  }
  /** The number painted on the Monolith (we show the Stockfish Elo). */
  setMonolith(text: string) {
    const draw = () => this.world.setMonolith(text);
    draw();
    document.fonts?.ready.then(draw);
  }
  setThinking(side: 'engine' | 'stockfish' | null) {
    this.thinking = side;
    this.applyAuras();
  }

  /** Show a position instantly (jumps, going back, first load). */
  setPosition(fen: string, captured: Captured, lastUci?: string) {
    this.finishAnim();
    this.place(fen, captured);
    this.setHighlight(lastUci);
  }

  /** Play `uci` out on the battlefield. Returns how long it will take, in ms. */
  playMove(fenBefore: string, uci: string, fenAfter: string, capturedAfter: Captured, durationMs: number): number {
    this.finishAnim();
    let mv: ChessMove | null = null;
    try {
      mv = new Chess(fenBefore).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      mv = null;
    }
    if (!mv || this.reduced || durationMs < 150) {
      this.setPosition(fenAfter, capturedAfter, uci);
      return 0;
    }
    const capturedBefore: Captured = { w: [...capturedAfter.w], b: [...capturedAfter.b] };
    if (mv.captured) {
      const lost = mv.color === 'w' ? 'b' : 'w';
      const idx = capturedBefore[lost].lastIndexOf(mv.captured as PieceType);
      if (idx >= 0) capturedBefore[lost].splice(idx, 1);
    }
    this.place(fenBefore, capturedBefore);
    this.setHighlight(undefined);
    this.final = { fen: fenAfter, captured: capturedAfter, uci };
    const tl = new Timeline();
    const pace = Math.max(0.6, Math.min(1.25, durationMs / 1300));
    const mover = this.bySquare.get(mv.from)!;
    const mated = mv.san.includes('#');

    if (mv.captured) {
      const capSq = mv.flags.includes('e') ? mv.to[0] + mv.from[1] : mv.to;
      const victim = this.bySquare.get(capSq)!;
      const lost: PieceColor = mv.color === 'w' ? 'b' : 'w';
      this.duel(tl, mover, victim, this.sqPos(mv.from), this.sqPos(capSq), this.sqPos(mv.to), this.gravePos(lost, capturedBefore[lost].length), pace);
    } else {
      const dur = Math.max(0.55, durationMs / 1000);
      this.march(tl, mover, this.sqPos(mv.from), this.sqPos(mv.to), 0, dur);
      if (mv.flags.includes('k') || mv.flags.includes('q')) {
        const rank = mv.from[1];
        const [rf, rt] = mv.flags.includes('k') ? ['h', 'f'] : ['a', 'd'];
        const rook = this.bySquare.get(rf + rank);
        if (rook) this.march(tl, rook, this.sqPos(rf + rank), this.sqPos(rt + rank), dur * 0.15, dur * 0.85);
      }
    }
    if (mv.promotion) this.promote(tl, mover, mv.promotion as PieceType, this.sqPos(mv.to), tl.length);
    if (mated) this.checkmate(tl, fenAfter, tl.length + 0.1);

    this.tl = tl;
    return tl.realSeconds() * 1000;
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.el.removeEventListener('pointermove', this.onPointer);
    this.el.removeEventListener('pointerleave', this.onLeave);
    this.el.removeEventListener('pointerdown', this.onDown);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    this.el.removeEventListener('dblclick', this.onDblClick);
    this.el.removeEventListener('contextmenu', this.onContext);
    this.fx.clear();
    this.world.dispose();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        for (const v of Object.values(x)) if (v instanceof THREE.Texture) v.dispose();
        x.dispose();
      }
    });
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---- choreography ----------------------------------------------------------------

  /** A non-capturing move, in the manner of the piece. */
  private march(tl: Timeline, u: Unit, from: THREE.Vector3, to: THREE.Vector3, at: number, dur: number) {
    const yaw = yawTo(from, to);
    const t = u.type;
    const turn = Math.min(0.25, dur * 0.25);
    tl.add(at, turn, (k) => (u.root.rotation.y = lerpAngle(u.homeYaw, yaw, easeOut(k))), () => (u.busy = true));
    const hop = t === 'n' ? 1.7 : t === 'p' ? 0.22 : t === 'b' ? 0.35 : 0.08;
    const steps = t === 'r' ? 3 : t === 'k' ? 2 : 1;
    tl.add(at + turn * 0.6, dur - turn * 1.2, (k) => {
      const e = t === 'q' ? easeIn(Math.min(1, k * 1.2)) : ease(k);
      u.root.position.lerpVectors(from, to, e);
      const arc = t === 'n' || t === 'p' || t === 'b' ? Math.sin(Math.PI * k) : Math.abs(Math.sin(Math.PI * k * steps));
      u.root.position.y = from.y + arc * hop;
      u.body.rotation.x = (t === 'q' ? 0.45 : t === 'n' ? -0.3 + 0.6 * k : 0.15) * Math.sin(Math.PI * k);
      if (t === 'n') u.body.rotation.y = Math.sin(Math.PI * k) * 0.4;
    }, undefined, () => {
      u.root.position.copy(to);
      u.body.rotation.set(0, 0, 0);
      if (t === 'n' || t === 'r') {
        this.fx.ring(to, 0xffd9a0, 1.3, 0.5);
        this.shake = Math.max(this.shake, t === 'r' ? 0.05 : 0.04);
        this.petals.burst(to, 12, { colors: [0xb3182b, 0xe8d9b8], speed: 1.2, life: 1.4, radius: 0.4 });
      }
    });
    tl.add(at + dur - turn, turn, (k) => (u.root.rotation.y = lerpAngle(yaw, u.homeYaw, ease(k))), undefined, () => (u.busy = false));
  }

  /** The capture: cut in, wind up, strike in slow motion, gommage, take the square. */
  private duel(tl: Timeline, a: Unit, v: Unit, from: THREE.Vector3, vpos: THREE.Vector3, to: THREE.Vector3, grave: THREE.Vector3, pace: number) {
    const P = (x: number) => x * pace;
    const dir = new THREE.Vector3().subVectors(vpos, from).setY(0).normalize();
    const kind = a.weaponKind;
    const standoff = { spear: 1.0, lance: 0.55, staff: 0, hammer: 0.8, rapier: 0.85, greatsword: 0.9 }[kind];
    const dist = from.distanceTo(vpos);
    const strikeAt = kind === 'staff' || dist <= standoff + 0.05 ? from.clone() : vpos.clone().addScaledVector(dir, -standoff);
    const yawA = yawTo(from, vpos);
    const yawV = yawTo(vpos, from);
    const cine = this.cinematic;
    const hitColor = HIT[a.faction === 'exp' ? 'exp' : 'nev'];
    const petalCols = PETALS[v.faction === 'exp' ? 'exp' : 'nev'];

    // camera: side-on to the line of attack, on the outer side of the board
    const mid = new THREE.Vector3().addVectors(strikeAt, vpos).multiplyScalar(0.5);
    const side = new THREE.Vector3(-dir.z, 0, dir.x);
    const outward = mid.clone().setY(0).add(new THREE.Vector3(0, 0, 2.5)); // bias towards our side
    if (side.dot(outward) < 0) side.negate();
    // wind-up: high over the attacker's shoulder; impact: a side-on close-up; then an orbit
    // (on the attacker's weapon-hand side, so the blade is in shot and the body doesn't hide the victim)
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const camA = strikeAt.clone().addScaledVector(dir, -2.0).addScaledVector(right, 2.3).setY(2.8);
    const camB = mid.clone().addScaledVector(side, 2.7).addScaledVector(dir, -0.4).setY(2.0);
    const look = vpos.clone().setY(0.6);
    const lookB = mid.clone().setY(0.6);
    // orbit whichever way swings the camera further out from the middle of the board
    const spin = (ang: number) => camB.clone().sub(vpos).applyAxisAngle(new THREE.Vector3(0, 1, 0), ang).add(vpos);
    const orbitDir = spin(0.4).setY(0).length() > spin(-0.4).setY(0).length() ? 1 : -1;
    const orbit = (k: number) => {
      const p = spin(orbitDir * k * 0.45);
      p.y = lerp(2.0, 2.9, k);
      return p;
    };

    // 1. the cut and the face-off
    tl.add(0, P(0.45), (k) => {
      a.root.rotation.y = lerpAngle(a.homeYaw, yawA, easeOut(k));
      v.root.rotation.y = lerpAngle(v.homeYaw, yawV, easeOut(k));
      this.windup(a, easeOut(k));
      v.body.rotation.x = -0.12 * k; // brace
    }, () => {
      a.busy = v.busy = true;
      if (cine) this.cine = { pos: camA, look, fov: 40, speed: 9 };
    });

    // 2. approach
    const approach = strikeAt.distanceTo(from) > 0.01;
    if (approach) {
      const hop = kind === 'lance' ? 1.6 : 0.15;
      tl.add(P(0.4), P(0.45), (k) => {
        const e = kind === 'lance' ? ease(k) : easeIn(k);
        a.root.position.lerpVectors(from, strikeAt, e);
        a.root.position.y = from.y + Math.sin(Math.PI * k) * hop;
        a.body.rotation.x = 0.35 * k;
      });
    }
    const impact = P(0.95);

    // 3. the strike
    if (kind === 'staff') {
      tl.add(P(0.45), P(0.4), (k) => {
        a.u.uGlow.value = k * 0.9;
        this.pose(a, -1.2 - 1.4 * k, 2.6 * k + 0.25 * (1 - k));
      });
      tl.at(P(0.62), () => {
        const tip = this.world.arena.worldToLocal(a.tip());
        this.fx.bolt(tip, vpos.clone().setY(v.height * 0.55), hitColor, impact - P(0.62), () => {});
      });
      tl.add(impact, P(0.3), (k) => (a.u.uGlow.value = 0.9 * (1 - k)));
    } else if (kind === 'rapier') {
      for (const [i, t0] of [P(0.8), P(0.86), impact - P(0.03)].entries()) {
        tl.add(t0, P(0.05), (k) => this.thrust(a, k < 0.5 ? k * 2 : 2 - k * 2), undefined, () => {
          if (i < 2) {
            this.sparks.burst(vpos.clone().setY(v.height * (0.45 + i * 0.12)), 12, hitColor, 2.5, dir);
            this.fx.slash(vpos.clone().setY(v.height * 0.55), dir, hitColor, 1.2 + i, 0.6, 0.18);
          }
        });
      }
      tl.add(impact - P(0.03), P(0.03), (k) => this.thrust(a, k));
    } else if (kind === 'greatsword' || kind === 'hammer') {
      tl.add(P(0.8), impact - P(0.8), (k) => this.pose(a, lerp(-3.4, -1.0, easeIn(k)), lerp(0.86, 2.9, easeIn(k))));
    } else {
      tl.add(P(0.82), impact - P(0.82), (k) => this.thrust(a, easeIn(k)));
    }
    // lunge on the blow
    tl.add(impact - P(0.1), P(0.1), (k) => {
      a.body.rotation.x = 0.35 + 0.15 * k;
      a.body.position.z = 0.12 * k;
    });

    // impact!
    if (cine) tl.slowmo(impact - 0.01, 0.12, 0.12);
    tl.at(impact, () => {
      const chest = vpos.clone().setY(v.height * 0.55);
      this.sparks.burst(chest, kind === 'hammer' ? 90 : 60, hitColor, kind === 'hammer' ? 5 : 4, dir);
      this.impactLight.color.copy(hitColor);
      this.impactLight.position.copy(chest).addScaledVector(side, 0.5);
      this.impactLight.intensity = 10;
      this.flash = cine ? 0.16 : 0.08;
      this.bloomBoost = 1.1;
      this.shake = kind === 'hammer' || kind === 'greatsword' ? 0.22 : 0.14;
      v.setFlash(0.6);
      if (kind === 'hammer') this.fx.ring(vpos, hitColor, 2.8, 0.7);
      if (kind === 'greatsword') this.fx.slash(chest, dir, hitColor, -0.6, 1.3, 0.35);
      if (kind === 'spear' || kind === 'lance') this.fx.slash(chest, dir, hitColor, 1.57, 0.8, 0.25);
      this.fx.ring(vpos, 0xfff0d8, 1.4, 0.4);
      if (cine) this.cine = { pos: camB, look: lookB, fov: 36, speed: 7 };
    });

    // victim reels
    tl.add(impact, P(0.35), (k) => {
      const e = easeOut(k);
      v.root.position.copy(vpos).addScaledVector(dir, 0.3 * e);
      v.body.rotation.x = -0.12 - 0.45 * e;
      v.setFlash(0.6 * (1 - k));
      v.arm.rotation.x = lerp(-0.15, 0.9, e);
    });

    // 4. gommage: petals peel away from the top down
    const gStart = impact + P(0.25);
    const gDur = P(1.05);
    let lastK = 0;
    tl.add(gStart, gDur, (k) => {
      v.setDissolve(k * 1.05);
      const n = Math.floor((k - lastK) * 320);
      if (n > 0) {
        lastK = k;
        const p = v.root.position.clone();
        p.y += v.height * (1 - k) * 0.85;
        this.petals.burst(p, n, { colors: petalCols, speed: 0.7, life: 2.6, radius: 0.32, height: 0.2, vel: WIND.clone().multiplyScalar(0.6), size: 0.08 });
      }
    }, undefined, () => {
      v.root.visible = false;
    });
    if (cine) tl.add(gStart, gDur, (k) => this.cine && (this.cine = { pos: orbit(easeOut(k)), look, fov: 38, speed: 3 }));

    // attacker recovers
    tl.add(impact + P(0.2), P(0.5), (k) => {
      const e = ease(k);
      this.pose(a, lerp(a.arm.rotation.x, -0.15, e), lerp(a.weapon.rotation.x, 0.25, e));
      a.body.rotation.x = lerp(a.body.rotation.x, 0, e);
      a.body.position.z = lerp(a.body.position.z, 0, e);
    });

    // 5. take the square; the fallen reappears as a small statue beside the board
    const walk = gStart + gDur - P(0.35);
    tl.add(walk, P(0.55), (k) => {
      const e = ease(k);
      const p = a.root.position;
      p.lerpVectors(strikeAt, to, e);
      p.y = strikeAt.y + Math.sin(Math.PI * k) * 0.12;
      a.root.rotation.y = lerpAngle(yawTo(strikeAt, to) || yawA, a.homeYaw, e);
    }, () => {
      this.cine = null;
    }, () => {
      a.busy = false;
      a.rest();
    });
    const statue = new Unit(v.type, v.color, 'stone', 0.5);
    statue.root.position.copy(grave);
    statue.root.rotation.y = this.facingYaw(v.color);
    statue.homeYaw = statue.root.rotation.y;
    statue.busy = true;
    tl.add(walk, P(0.6), (k) => {
      statue.setDissolve(1.05 * (1 - k));
    }, () => {
      this.units.add(statue.root);
      this.statues.push(statue);
    });
  }

  private promote(tl: Timeline, u: Unit, to: PieceType, pos: THREE.Vector3, at: number) {
    const nu = new Unit(to, u.color, u.faction);
    nu.root.position.copy(pos);
    nu.root.rotation.y = nu.homeYaw = u.homeYaw;
    nu.busy = true;
    tl.at(at, () => {
      this.fx.pillar(pos, u.faction === 'exp' ? 0xffd27a : 0xff3048, 1.4);
      this.petals.burst(pos, 80, { colors: PETALS[u.faction === 'exp' ? 'exp' : 'nev'], speed: 1.5, life: 2, radius: 0.4, height: 1.5 });
      this.bloomBoost = 1.5;
    });
    tl.add(at, 0.5, (k) => u.setDissolve(k * 1.05), undefined, () => (u.root.visible = false));
    tl.add(at + 0.3, 0.7, (k) => nu.setDissolve(1.05 * (1 - k)), () => this.units.add(nu.root), () => (nu.busy = false));
  }

  private checkmate(tl: Timeline, fen: string, at: number) {
    let kingSq: string | undefined;
    try {
      const c = new Chess(fen);
      const turn = c.turn();
      for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === turn) kingSq = p.square;
    } catch {
      return;
    }
    if (!kingSq) return;
    const pos = this.sqPos(kingSq);
    const k0 = this.bySquare.get(kingSq);
    if (!k0) return;
    // in front of the fallen king, high enough to see over the pieces around it
    const front = new THREE.Vector3(Math.sin(k0.homeYaw), 0, Math.cos(k0.homeYaw));
    const look = pos.clone().setY(0.55);
    const camPos = pos.clone().addScaledVector(front, 2.1).add(new THREE.Vector3(0.7, 3.1, 0));
    tl.add(at, 2.2, (k) => {
      k0.kneel = easeOut(Math.min(1, k * 1.6));
      k0.setDissolve(0.55 * easeOut(k));
      if (Math.random() < 0.6) this.petals.burst(pos.clone().setY(0.4 + k), 6, { colors: PETALS[k0.faction === 'exp' ? 'exp' : 'nev'], speed: 1.2, life: 3, radius: 0.5, height: 1 });
    }, () => {
      if (this.cinematic) this.cine = { pos: camPos, look, fov: 30, speed: 2 };
      this.fx.ring(pos, 0xffffff, 4, 1.2);
      this.bloomBoost = 1.8;
      this.shake = 0.1;
    }, () => (this.cine = null));
  }

  private windup(a: Unit, k: number) {
    switch (a.weaponKind) {
      case 'greatsword':
      case 'hammer':
        this.pose(a, lerp(-0.15, -3.4, k), lerp(0.25, 0.86, k));
        break;
      case 'staff':
        this.pose(a, lerp(-0.15, -1.2, k), 0.25);
        break;
      default:
        this.pose(a, lerp(-0.15, 0.45, k), lerp(0.25, 1.1, k));
    }
  }
  /** Thrust pose for spear/lance/rapier: k = 0 wound back, 1 fully extended. */
  private thrust(a: Unit, k: number) {
    this.pose(a, lerp(0.45, -1.45, k), lerp(1.1, 3.0, k));
    a.body.position.z = 0.1 * k;
  }
  private pose(a: Unit, armX: number, weaponX: number) {
    a.arm.rotation.x = armX;
    a.weapon.rotation.x = weaponX;
  }

  // ---- placement --------------------------------------------------------------------

  private facingYaw(color: PieceColor) {
    const ours = (color === 'w') === (this.ourColor === 'white');
    return ours ? Math.PI : 0;
  }

  private sqPos(sq: string): THREE.Vector3 {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    const w = this.ourColor === 'white';
    return new THREE.Vector3(w ? f - 3.5 : 3.5 - f, 0, w ? 3.5 - r : r - 3.5);
  }

  /** k-th fallen piece of colour `lost`, as a statue beside the captor's edge of the board. */
  private gravePos(lost: PieceColor, k: number): THREE.Vector3 {
    const ourCapture = (lost === 'w') !== (this.ourColor === 'white');
    const s = ourCapture ? 1 : -1;
    const col = k % 2;
    const row = Math.floor(k / 2);
    return new THREE.Vector3(s * (5.3 + col * 0.7), -0.3, s * (3.3 - row * 0.9));
  }

  private place(fen: string, captured: Captured) {
    const key = `${fen.split(' ').slice(0, 2).join(' ')}|${captured.w.join('')}|${captured.b.join('')}|${this.ourColor}`;
    if (key === this.placedKey) return;
    this.placedKey = key;
    for (const u of [...this.bySquare.values(), ...this.statues]) u.dispose();
    this.units.clear();
    this.bySquare.clear();
    this.statues = [];
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      return;
    }
    for (const row of chess.board())
      for (const p of row) {
        if (!p) continue;
        const ours = (p.color === 'w') === (this.ourColor === 'white');
        const u = new Unit(p.type as PieceType, p.color as PieceColor, ours ? 'exp' : 'nev');
        u.root.position.copy(this.sqPos(p.square));
        u.root.rotation.y = u.homeYaw = this.facingYaw(p.color as PieceColor);
        this.units.add(u.root);
        this.bySquare.set(p.square, u);
      }
    for (const color of ['w', 'b'] as const)
      captured[color].forEach((t, k) => {
        const s = new Unit(t, color, 'stone', 0.5);
        s.root.position.copy(this.gravePos(color, k));
        s.root.rotation.y = s.homeYaw = this.facingYaw(color);
        s.busy = true;
        this.units.add(s.root);
        this.statues.push(s);
      });
    this.applyAuras(chess);
  }

  private applyAuras(chess?: Chess) {
    let c = chess;
    if (!c && this.placedKey) {
      try {
        c = new Chess(this.placedKey.split('|')[0] + ' - - 0 1');
      } catch {
        c = undefined;
      }
    }
    const turn = c?.turn();
    const inCheck = c?.inCheck() ?? false;
    const mate = c?.isCheckmate() ?? false;
    for (const u of this.bySquare.values()) {
      const ours = u.faction === 'exp';
      const thinks = (this.thinking === 'engine' && ours) || (this.thinking === 'stockfish' && !ours);
      u.aura = thinks ? 0.35 : 0;
      if (u.type === 'k' && u.color === turn && inCheck) u.aura = 1;
      u.kneel = u.type === 'k' && u.color === turn && mate ? 1 : 0;
      u.setDissolve(u.kneel ? 0.55 : 0);
    }
  }

  private setHighlight(uci?: string) {
    const sqs = uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
    this.highlight.forEach((m, i) => {
      m.visible = !!sqs[i];
      if (sqs[i]) m.position.copy(this.sqPos(sqs[i])).setY(0.006);
    });
  }

  private finishAnim() {
    if (!this.tl) return;
    const f = this.final!;
    this.tl = null;
    this.final = null;
    this.cine = null;
    this.fx.clear();
    this.placedKey = '';
    this.place(f.fen, f.captured);
    this.setHighlight(f.uci);
  }

  // ---- frame ------------------------------------------------------------------------

  /**
   * The arena never stops: it climbs slowly out of the plaza on its shaft, eases
   * back down after the peak and climbs again. A thin trickle of dust falls from the seam.
   */
  private updateLift(dt: number) {
    if (this.reduced || dt <= 0) return;
    this.elev += dt;
    const ph = (this.elev / ARENA_CYCLE) * Math.PI * 2;
    const arena = this.world.arena;
    arena.position.y = ARENA_PEAK * (1 - Math.cos(ph)) * 0.5;
    if (Math.random() < 0.35) {
      const a = Math.random() * Math.PI * 2;
      tmpV.set(Math.cos(a) * 7.3, -0.3, Math.sin(a) * 7.3);
      this.dust.emit(tmpV, { colors: [0xb8a488, 0x8c7a60, 0xd8c8a8, 0x6e5e4a], speed: 0.3, spread: 0.5, life: 2.2, size: 0.12, vel: tmpV2.set(Math.cos(a) * 0.3, 0.25, Math.sin(a) * 0.3) });
    }
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05) * this.debugSpeed;
    this.last = now;
    const scale = this.tl ? this.tl.scale() : 1;
    const sdt = dt * scale;
    this.time += sdt;
    if (this.tl && this.tl.tick(sdt)) this.finishAnim();

    for (const u of this.bySquare.values()) u.update(this.time, sdt, this.reduced);
    for (const u of this.statues) u.update(this.time, sdt, true);
    this.petals.update(sdt, this.time, WIND);
    this.dust.update(sdt, this.time, DUST_WIND);
    this.ambient.update(this.time, this.reduced);
    this.sparks.update(sdt);
    this.fx.update(sdt);
    this.updateLift(dt);

    // camera: the chosen view, or the duel camera while a capture plays out
    const v = VIEWS[this.view];
    // (camPos/camLook live in arena space, so the camera rides the rising arena)
    const target = this.cine ?? { ...v, speed: this.drag || this.touches.size ? 14 : 2.5 };
    const k = Math.min(1, dt * target.speed);
    const par = this.reduced || this.cine || this.drag || this.orbit ? 0 : 1;
    const drift = this.reduced ? 0 : Math.sin(this.time * 0.2) * 0.15;
    this.camPos.lerp(tmpV.copy(target.pos).add(tmpV2.set(this.pointer.x * 0.6 * par + drift, this.pointer.y * 0.35 * par, 0)), k);
    this.camLook.lerp(target.look, k);
    this.camFov += (target.fov - this.camFov) * k;
    const arena = this.world.arena;
    arena.updateMatrixWorld();
    this.camera.position.copy(this.camPos);
    arena.localToWorld(this.camera.position);
    const lookW = arena.localToWorld(tmpL.copy(this.camLook));
    if (this.shake > 0.001) {
      this.camera.position.add(tmpV.set((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake));
      this.shake *= Math.pow(0.02, dt);
    }
    this.camera.lookAt(lookW);
    if (Math.abs(this.camera.fov - this.camFov) > 1e-3) {
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }

    // post: flash, bloom boost, letterbox and fringe settle back
    this.flash *= Math.pow(0.004, dt);
    this.bloomBoost *= Math.pow(0.05, dt);
    this.impactLight.intensity *= Math.pow(0.01, dt);
    this.letterbox += ((this.cine ? 1 : 0) - this.letterbox) * Math.min(1, dt * 5);
    this.painterly.set('uFlash', this.flash);
    this.painterly.set('uLetterbox', this.letterbox);
    this.painterly.set('uTime', this.time);
    this.bloom.intensity = 1.0 + this.bloomBoost;
    const ca = 0.0004 + this.bloomBoost * 0.0028;
    this.chroma.offset.set(ca, ca * 0.6);

    this.world.update(this.time, this.camera, this.reduced);
    this.composer.render(dt);
    this.adapt(now);
  };

  /** Drop the render resolution a step while frames take longer than ~22 ms (min 1×). */
  private adapt(now: number) {
    const ft = now - this.perf.last;
    this.perf.last = now;
    if (!(ft > 0 && ft < 250) || this.tl) return; // skip hitches and duels
    this.perf.acc += ft;
    if (++this.perf.n < 90) return;
    const avg = this.perf.acc / this.perf.n;
    this.perf.acc = this.perf.n = 0;
    if (avg > 22 && this.perf.ratio > 1) {
      this.perf.ratio = Math.max(1, this.perf.ratio - 0.25);
      this.renderer.setPixelRatio(this.perf.ratio);
      this.resize();
    }
  }

  private resize() {
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const narrow = w / h < 1.2;
    VIEWS.shoulder.fov = narrow ? 68 : 52;
    VIEWS.shoulder.pos.set(0, narrow ? 8 : 6.4, narrow ? 13.5 : 12.6);
    VIEWS.shoulder.look.set(0, narrow ? 0.4 : 1.3, -9);
    VIEWS.above.fov = narrow ? 60 : 40;
    this.applyOrbit();
    this.camera.updateProjectionMatrix();
  }

  private onPointer = (e: PointerEvent) => {
    this.steer(e);
    const r = this.el.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  };
  private onLeave = () => this.pointer.set(0, 0);

  // ---- free Battle camera: drag = orbit, right/shift-drag = pan, wheel/pinch = zoom ----------

  private canSteer() {
    return this.view === 'shoulder' && !this.cine;
  }

  /**
   * Start from wherever the Battle camera currently is, pivoting around the point on its line of
   * sight nearest the board centre (so the first drag doesn't jump, and it orbits the board).
   */
  private ensureOrbit() {
    if (this.orbit) return this.orbit;
    const pos = VIEWS.shoulder.pos.clone();
    const dir = VIEWS.shoulder.look.clone().sub(pos).normalize();
    const along = new THREE.Vector3(0, 0.5, 0).sub(pos).dot(dir);
    const target = pos.clone().addScaledVector(dir, along);
    const sph = new THREE.Spherical().setFromVector3(pos.sub(target));
    this.orbit = { r: sph.radius, theta: sph.theta, phi: sph.phi, target };
    return this.orbit;
  }

  private applyOrbit() {
    const o = this.orbit;
    if (!o) return;
    o.r = Math.min(34, Math.max(5, o.r));
    o.phi = Math.min(1.35, Math.max(0.1, o.phi)); // from nearly overhead down to just above the plaza
    o.target.x = Math.min(12, Math.max(-12, o.target.x));
    o.target.z = Math.min(12, Math.max(-14, o.target.z));
    VIEWS.shoulder.look.copy(o.target);
    VIEWS.shoulder.pos.setFromSphericalCoords(o.r, o.phi, o.theta).add(o.target);
  }

  private onDown = (e: PointerEvent) => {
    if (!this.canSteer()) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.el.setPointerCapture(e.pointerId);
    if (this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.pinch = Math.hypot(a.x - b.x, a.y - b.y);
      this.drag = null;
      return;
    }
    this.drag = { mode: e.button === 2 || e.shiftKey ? 'pan' : 'orbit', x: e.clientX, y: e.clientY };
    this.el.style.cursor = 'grabbing';
  };

  private onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.el.hasPointerCapture?.(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (this.touches.size === 0 && (this.drag || this.pinch)) saveOrbit(this.orbit);
    if (this.touches.size < 2) this.pinch = 0;
    this.drag = null;
    this.el.style.cursor = 'grab';
  };

  private steer(e: PointerEvent) {
    if (!this.canSteer()) return;
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 2 && this.pinch) {
      const [a, b] = [...this.touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.ensureOrbit().r *= this.pinch / Math.max(1, d);
      this.pinch = d;
      this.applyOrbit();
      return;
    }
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    const o = this.ensureOrbit();
    if (this.drag.mode === 'orbit') {
      o.theta -= dx * 0.006;
      o.phi -= dy * 0.005;
    } else {
      // slide the target across the ground, relative to where the camera faces
      const k = o.r * 0.0016;
      const right = new THREE.Vector3(Math.cos(o.theta), 0, -Math.sin(o.theta));
      const fwd = new THREE.Vector3(-Math.sin(o.theta), 0, -Math.cos(o.theta));
      o.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
    }
    this.applyOrbit();
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.canSteer()) return;
    e.preventDefault();
    this.ensureOrbit().r *= Math.exp(e.deltaY * 0.0012);
    this.applyOrbit();
    clearTimeout(this.wheelSave);
    this.wheelSave = window.setTimeout(() => saveOrbit(this.orbit), 300);
  };
  private wheelSave = 0;

  private onDblClick = () => {
    if (this.canSteer()) this.resetCamera();
  };
  private onContext = (e: Event) => e.preventDefault();
}

const tmpV = new THREE.Vector3();

const ORBIT_KEY = 'ac.battleCamera';
function loadOrbit(): { r: number; theta: number; phi: number; target: THREE.Vector3 } | null {
  try {
    const o = JSON.parse(localStorage.getItem(ORBIT_KEY) ?? 'null');
    if (!o || ![o.r, o.theta, o.phi, ...(o.target ?? [])].every(Number.isFinite)) return null;
    return { r: o.r, theta: o.theta, phi: o.phi, target: new THREE.Vector3(...(o.target as [number, number, number])) };
  } catch {
    return null;
  }
}
function saveOrbit(o: { r: number; theta: number; phi: number; target: THREE.Vector3 } | null) {
  try {
    if (o) localStorage.setItem(ORBIT_KEY, JSON.stringify({ r: o.r, theta: o.theta, phi: o.phi, target: o.target.toArray() }));
    else localStorage.removeItem(ORBIT_KEY);
  } catch {
    /* private mode: not remembered */
  }
}
const tmpL = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
