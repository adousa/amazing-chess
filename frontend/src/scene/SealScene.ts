// The Seventh Seal stage: owns the three.js renderer, the beach, the two players and the
// pieces, and turns chess moves into the players physically moving pieces.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Chess } from 'chess.js';
import { buildEnvironment, type Environment } from './environment';
import { buildDeath, buildKnight, type Arm, type Figure } from './figures';
import { FilmShader } from './film';
import {
  BOARD_HALF,
  BOARD_T,
  BOARD_TOP,
  PIECE_H,
  SQ,
  TABLE_TOP,
  makeBoardTexture,
  pieceGeometry,
  pieceMaterials,
  type PieceColor,
  type PieceType,
} from './pieces';

export type Side = 'white' | 'black';
export type View = 'shoulder' | 'above';
/** Types of the pieces of each colour that have left the board, in capture order. */
export type Captured = Record<PieceColor, PieceType[]>;

const SEAT = 0.6;
const VIEWS: Record<View, { pos: THREE.Vector3; look: THREE.Vector3; fov: number }> = {
  shoulder: { pos: new THREE.Vector3(0.55, 1.74, 1.32), look: new THREE.Vector3(-0.07, 0.95, -0.45), fov: 45 },
  above: { pos: new THREE.Vector3(0, 1.52, 0.4), look: new THREE.Vector3(0, BOARD_TOP, -0.05), fov: 42 },
};
// graveyard slots per type (beside the board, on the capturer's side)
const GRAVE_OFFSET: Record<PieceType, number> = { q: 0, r: 1, b: 3, n: 5, p: 7, k: 15 };
const GRAVE_COUNT: Record<PieceType, number> = { q: 1, r: 2, b: 2, n: 2, p: 8, k: 1 };

interface Step {
  arm: Arm;
  to: THREE.Vector3;
  w: number;
  arc?: number;
  onStart?: () => void;
  onEnd?: () => void;
}
interface Anim {
  steps: Step[];
  total: number;
  i: number;
  t: number;
  from: THREE.Vector3;
  finalFen: string;
  finalCaptured: Captured;
  uci: string;
}

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export class SealScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 16 / 9, 0.05, 1200);
  private readonly composer: EffectComposer;
  private readonly film: ShaderPass;
  private readonly env: Environment;
  private readonly knight: Figure;
  private readonly death: Figure;
  private readonly boardMat: THREE.MeshStandardMaterial;
  private readonly pieces = new THREE.Group();
  private readonly mats = pieceMaterials();
  private readonly highlight: THREE.Mesh[];
  private readonly ro: ResizeObserver;
  private readonly reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  /** Camera presets (exposed for tuning in dev tools). */
  readonly views = VIEWS;
  private ourColor: Side = 'white';
  private bySquare = new Map<string, THREE.Mesh>();
  private anim: Anim | null = null;
  private carry: { mesh: THREE.Mesh; offset: THREE.Vector3; arm: Arm } | null = null;
  private view: View = 'shoulder';
  private camPos = VIEWS.shoulder.pos.clone();
  private camLook = VIEWS.shoulder.look.clone();
  private camFov = VIEWS.shoulder.fov;
  private pointer = new THREE.Vector2();
  private time = 0;
  private last = performance.now();

  constructor(private readonly el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    el.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.env = buildEnvironment(this.scene);
    this.knight = buildKnight(this.scene, SEAT);
    this.death = buildDeath(this.scene, -SEAT);

    this.boardMat = new THREE.MeshStandardMaterial({ roughness: 0.55, map: makeBoardTexture(true) });
    const edge = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7 });
    const board = new THREE.Mesh(new THREE.BoxGeometry(2 * BOARD_HALF, BOARD_T, 2 * BOARD_HALF), [
      edge, edge, this.boardMat, edge, edge, edge,
    ]);
    board.position.y = TABLE_TOP + BOARD_T / 2;
    board.castShadow = board.receiveShadow = true;
    this.scene.add(board, this.pieces);
    document.fonts?.ready.then(() => this.setBoardTexture());

    const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
    this.highlight = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(SQ, SQ), hlMat);
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      this.scene.add(m);
      return m;
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(new OutputPass());
    this.film = new ShaderPass(FilmShader);
    this.film.uniforms.uFlicker.value = this.reduced ? 0 : 1;
    this.composer.addPass(this.film);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    el.addEventListener('pointermove', this.onPointer);
    el.addEventListener('pointerleave', this.onLeave);
    this.renderer.setAnimationLoop(this.frame);
  }

  // ---- public API -----------------------------------------------------------------

  setOrientation(c: Side) {
    if (c === this.ourColor) return;
    this.ourColor = c;
    this.setBoardTexture();
  }

  setView(v: View) {
    this.view = v;
  }

  setThinking(side: 'engine' | 'stockfish' | null) {
    this.knight.thinking = side === 'engine';
    this.death.thinking = side === 'stockfish';
  }

  /** Show a position instantly (jumps, going back, first load). */
  setPosition(fen: string, captured: Captured, lastUci?: string) {
    this.finishAnim();
    this.place(fen, captured);
    this.setHighlight(lastUci);
  }

  /** Let the player whose move it is pick up the piece and play `uci`. */
  playMove(fenBefore: string, uci: string, fenAfter: string, capturedAfter: Captured, durationMs: number) {
    this.finishAnim();
    let mv;
    try {
      mv = new Chess(fenBefore).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      mv = null;
    }
    if (!mv || this.reduced || durationMs < 150) {
      this.setPosition(fenAfter, capturedAfter, uci);
      return;
    }
    // make sure the board shows the position before the move
    const capturedBefore: Captured = { w: [...capturedAfter.w], b: [...capturedAfter.b] };
    if (mv.captured) {
      const lost = mv.color === 'w' ? 'b' : 'w';
      const idx = capturedBefore[lost].lastIndexOf(mv.captured);
      if (idx >= 0) capturedBefore[lost].splice(idx, 1);
    }
    this.place(fenBefore, capturedBefore);
    this.setHighlight(undefined);

    const moverIsKnight = (mv.color === 'w') === (this.ourColor === 'white');
    const arm = (moverIsKnight ? this.knight : this.death).right;
    const steps: Step[] = [];
    const transfer = (mesh: THREE.Mesh | undefined, type: PieceType, from: THREE.Vector3, to: THREE.Vector3, onDrop?: () => void) => {
      if (!mesh) return;
      const grip = (p: THREE.Vector3) => p.clone().setY(p.y + PIECE_H[type] + 0.004);
      const above = (p: THREE.Vector3) => p.clone().setY(BOARD_TOP + PIECE_H[type] + 0.07);
      steps.push({ arm, to: above(from), w: 3 });
      steps.push({ arm, to: grip(from), w: 1.2, onEnd: () => (this.carry = { mesh, offset: mesh.position.clone().sub(arm.target), arm }) });
      steps.push({
        arm,
        to: grip(to),
        w: 3.4,
        arc: 0.07,
        onEnd: () => {
          this.carry = null;
          mesh.position.copy(to);
          onDrop?.();
        },
      });
      steps.push({ arm, to: above(to), w: 0.9 });
    };

    const from = mv.from as string;
    const to = mv.to as string;
    if (mv.captured) {
      const capSq = mv.flags.includes('e') ? to[0] + from[1] : to;
      const lost: PieceColor = mv.color === 'w' ? 'b' : 'w';
      const k = capturedBefore[lost].filter((t) => t === mv.captured).length;
      transfer(this.bySquare.get(capSq), mv.captured as PieceType, this.sqPos(capSq), this.gravePos(lost, mv.captured as PieceType, k));
    }
    const moving = this.bySquare.get(from);
    transfer(moving, mv.piece as PieceType, this.sqPos(from), this.sqPos(to), () => {
      if (mv.promotion && moving) moving.geometry = pieceGeometry(mv.promotion as PieceType);
    });
    if (mv.flags.includes('k') || mv.flags.includes('q')) {
      const rank = from[1];
      const [rf, rt] = mv.flags.includes('k') ? ['h', 'f'] : ['a', 'd'];
      transfer(this.bySquare.get(rf + rank), 'r', this.sqPos(rf + rank), this.sqPos(rt + rank));
    }
    steps.push({ arm, to: arm.rest.clone(), w: 3, onStart: () => (arm.active = false) });

    const wsum = steps.reduce((s, x) => s + x.w, 0);
    const total = durationMs / 1000;
    for (const s of steps) s.w = (s.w / wsum) * total;
    arm.active = true;
    this.anim = { steps, total, i: 0, t: 0, from: arm.target.clone(), finalFen: fenAfter, finalCaptured: capturedAfter, uci };
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    this.el.removeEventListener('pointermove', this.onPointer);
    this.el.removeEventListener('pointerleave', this.onLeave);
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

  // ---- internals ------------------------------------------------------------------

  private setBoardTexture() {
    this.boardMat.map?.dispose();
    this.boardMat.map = makeBoardTexture(this.ourColor === 'white');
    this.boardMat.needsUpdate = true;
  }

  private sqPos(sq: string, y = BOARD_TOP): THREE.Vector3 {
    const f = sq.charCodeAt(0) - 97;
    const r = Number(sq[1]) - 1;
    const w = this.ourColor === 'white';
    return new THREE.Vector3(w ? (f - 3.5) * SQ : (3.5 - f) * SQ, y, w ? (3.5 - r) * SQ : (r - 3.5) * SQ);
  }

  /** k-th captured piece of `type` and colour `lost`, set down beside its captor. */
  private gravePos(lost: PieceColor, type: PieceType, k: number): THREE.Vector3 {
    const captorIsKnight = (lost === 'w') !== (this.ourColor === 'white');
    const slot = GRAVE_OFFSET[type] + Math.min(k, GRAVE_COUNT[type] - 1);
    const col = slot % 3;
    const row = Math.floor(slot / 3);
    const s = captorIsKnight ? 1 : -1;
    return new THREE.Vector3(s * (BOARD_HALF + 0.045 + col * 0.045), TABLE_TOP, s * (0.2 - row * 0.1));
  }

  private place(fen: string, captured: Captured) {
    this.pieces.clear();
    this.bySquare.clear();
    const add = (type: PieceType, color: PieceColor, pos: THREE.Vector3) => {
      const m = new THREE.Mesh(pieceGeometry(type), this.mats[color]);
      m.castShadow = m.receiveShadow = true;
      m.position.copy(pos);
      // knights look towards the other side
      const facesFar = (color === 'w') === (this.ourColor === 'white');
      m.rotation.y = facesFar ? Math.PI / 2 : -Math.PI / 2;
      this.pieces.add(m);
      return m;
    };
    let board;
    try {
      board = new Chess(fen).board();
    } catch {
      return;
    }
    for (const row of board)
      for (const p of row) if (p) this.bySquare.set(p.square, add(p.type as PieceType, p.color as PieceColor, this.sqPos(p.square)));
    for (const color of ['w', 'b'] as const) {
      const seen: Partial<Record<PieceType, number>> = {};
      for (const t of captured[color]) {
        const k = seen[t] ?? 0;
        seen[t] = k + 1;
        add(t, color, this.gravePos(color, t, k));
      }
    }
  }

  private setHighlight(uci?: string) {
    const sqs = uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : [];
    this.highlight.forEach((m, i) => {
      m.visible = !!sqs[i];
      if (sqs[i]) m.position.copy(this.sqPos(sqs[i], BOARD_TOP + 0.0006));
    });
  }

  private finishAnim() {
    const a = this.anim;
    if (!a) return;
    this.anim = null;
    this.carry = null;
    this.place(a.finalFen, a.finalCaptured);
    this.setHighlight(a.uci);
    for (const f of [this.knight, this.death])
      for (const arm of f.arms) {
        arm.target.copy(arm.rest);
        arm.active = false;
      }
  }

  private tick(dt: number) {
    const a = this.anim;
    if (a) {
      let left = dt;
      while (left > 0 && this.anim === a) {
        const s = a.steps[a.i];
        if (a.t === 0) s.onStart?.();
        const remaining = s.w - a.t;
        const use = Math.min(left, remaining);
        a.t += use;
        left -= use;
        const k = s.w > 0 ? Math.min(1, a.t / s.w) : 1;
        s.arm.target.lerpVectors(a.from, s.to, ease(k));
        if (s.arc) s.arm.target.y += Math.sin(Math.PI * k) * s.arc;
        if (k >= 1) {
          s.onEnd?.();
          a.i++;
          a.t = 0;
          a.from = s.to.clone();
          if (a.i >= a.steps.length) this.finishAnim();
        }
      }
    }
    // resting hands drift a little
    for (const f of [this.knight, this.death])
      for (const arm of f.arms) {
        if (a && a.steps.some((s) => s.arm === arm)) continue;
        arm.target.lerp(arm.rest, Math.min(1, dt * 4));
      }
  }

  private frame = () => {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    this.time += dt;
    this.tick(dt);
    this.knight.update(this.time, dt, this.reduced);
    this.death.update(this.time, dt, this.reduced);
    if (this.carry) this.carry.mesh.position.copy(this.carry.offset).add(this.carry.arm.target);

    // camera eases towards the chosen view, with a little parallax from the pointer
    const v = VIEWS[this.view];
    const k = Math.min(1, dt * 2.5);
    const par = this.reduced ? 0 : 1;
    const drift = this.reduced ? 0 : Math.sin(this.time * 0.25) * 0.01;
    this.camPos.lerp(tmpV.copy(v.pos).add(tmpV2.set(this.pointer.x * 0.06 * par + drift, this.pointer.y * 0.03 * par, 0)), k);
    this.camLook.lerp(v.look, k);
    this.camFov += (v.fov - this.camFov) * k;
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    if (Math.abs(this.camera.fov - this.camFov) > 1e-3) {
      this.camera.fov = this.camFov;
      this.camera.updateProjectionMatrix();
    }
    this.env.update(this.time, this.camera);
    this.film.uniforms.uTime.value = this.time;
    this.composer.render(dt);
  };

  private resize() {
    const w = Math.max(1, this.el.clientWidth);
    const h = Math.max(1, this.el.clientHeight);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.film.uniforms.uRes.value.set(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
    this.camera.aspect = w / h;
    // keep the board framed on narrow screens
    VIEWS.shoulder.fov = w / h < 1.2 ? 62 : 45;
    VIEWS.above.fov = w / h < 1.2 ? 56 : 40;
    this.camera.updateProjectionMatrix();
  }

  private onPointer = (e: PointerEvent) => {
    const r = this.el.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
  };
  private onLeave = () => this.pointer.set(0, 0);
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
