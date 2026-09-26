// Procedural Staunton-ish chess pieces and the board, all in metres.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PieceColor = 'w' | 'b';

export const SQ = 0.064; // square size
export const BORDER = 0.026;
export const BOARD_T = 0.02;
export const BOARD_HALF = 4 * SQ + BORDER;
export const TABLE_TOP = 0.7; // top of the rock the board rests on
export const BOARD_TOP = TABLE_TOP + BOARD_T;

/** Piece heights, used to know where a hand grips a piece. */
export const PIECE_H: Record<PieceType, number> = { p: 0.05, n: 0.061, b: 0.064, r: 0.056, q: 0.067, k: 0.073 };

const MM = 0.001;
type P = [number, number];
const BASE: P[] = [[0, 0], [19, 0], [19, 3], [17, 5], [17, 7], [14, 9]];

const lathe = (pts: P[]) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r * MM, y * MM)), 40);
function sphere(r: number, x: number, y: number, z: number, sy = 1) {
  const g = new THREE.SphereGeometry(r * MM, 24, 14);
  g.scale(1, sy, 1);
  return g.translate(x * MM, y * MM, z * MM);
}
function box(w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0) {
  const g = new THREE.BoxGeometry(w * MM, h * MM, d * MM);
  g.rotateY(rotY);
  return g.translate(x * MM, y * MM, z * MM);
}
const merge = (parts: THREE.BufferGeometry[]) =>
  mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)))!;

// Horse head in side profile, facing +x.
const HORSE: P[] = [
  [-11, 16], [11, 16], [8, 28], [16, 35], [21, 39], [22, 45], [16, 48], [9, 53], [5, 61], [1, 56],
  [-4, 58], [-10, 51], [-14, 41], [-14, 28],
];

function build(t: PieceType): THREE.BufferGeometry {
  switch (t) {
    case 'p':
      return merge([lathe([...BASE, [10, 12], [7, 22], [6, 28], [10, 30], [10, 32], [5, 34], [0, 34]]), sphere(9, 0, 41, 0)]);
    case 'r': {
      const parts: THREE.BufferGeometry[] = [lathe([...BASE, [12, 12], [11, 36], [14, 38], [14, 50], [11, 50], [11, 46], [0, 46]])];
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4;
        parts.push(box(8, 6, 6, 11.5 * Math.cos(a), 53, 11.5 * Math.sin(a), -a));
      }
      return merge(parts);
    }
    case 'b':
      return merge([
        lathe([...BASE, [11, 12], [7, 34], [10, 36], [10, 38], [6, 40], [0, 40]]),
        sphere(8, 0, 49, 0, 1.4),
        sphere(3, 0, 61, 0),
      ]);
    case 'q': {
      const parts: THREE.BufferGeometry[] = [lathe([...BASE, [12, 12], [7, 40], [11, 42], [11, 44], [7, 46], [9, 54], [12, 58], [0, 58]]), sphere(4, 0, 63, 0)];
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        parts.push(sphere(2.5, 11 * Math.cos(a), 59, 11 * Math.sin(a)));
      }
      return merge(parts);
    }
    case 'k':
      return merge([
        lathe([...BASE, [12, 12], [7, 42], [11, 44], [11, 46], [7, 48], [10, 58], [11, 60], [0, 60]]),
        box(3.5, 13, 3.5, 0, 67, 0),
        box(10, 3.5, 3.5, 0, 68, 0),
      ]);
    case 'n': {
      const shape = new THREE.Shape(HORSE.map(([x, y]) => new THREE.Vector2(x * MM, y * MM)));
      const head = new THREE.ExtrudeGeometry(shape, {
        depth: 10 * MM,
        bevelEnabled: true,
        bevelThickness: 2.5 * MM,
        bevelSize: 2 * MM,
        bevelSegments: 3,
        curveSegments: 4,
      });
      head.translate(0, 0, -5 * MM);
      return merge([lathe([...BASE, [12, 12], [10, 18], [0, 18]]), head]);
    }
  }
}

const cache = new Map<PieceType, THREE.BufferGeometry>();
export function pieceGeometry(t: PieceType): THREE.BufferGeometry {
  let g = cache.get(t);
  if (!g) {
    g = build(t);
    cache.set(t, g);
  }
  return g;
}

export function pieceMaterials(): Record<PieceColor, THREE.MeshStandardMaterial> {
  return {
    w: new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.42 }),
    b: new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.3, metalness: 0.15 }),
  };
}

/** Board top texture, drawn as seen from our (the Knight's) seat: canvas top = far side. */
export function makeBoardTexture(ourWhite: boolean): THREE.CanvasTexture {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d')!;
  const k = px / (2 * BOARD_HALF);
  const b = BORDER * k;
  const s = SQ * k;
  ctx.fillStyle = '#262626';
  ctx.fillRect(0, 0, px, px);
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) {
      const file = ourWhite ? j : 7 - j;
      const rank = ourWhite ? 7 - i : i;
      ctx.fillStyle = (file + rank) % 2 === 0 ? '#6e6e6e' : '#d4d4d4';
      ctx.fillRect(b + j * s, b + i * s, s, s);
    }
  // worn speckle + grain
  const img = ctx.getImageData(0, 0, px, px);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 3;
  ctx.strokeRect(b, b, 8 * s, 8 * s);
  // coordinates on the frame
  ctx.fillStyle = '#9a9a9a';
  ctx.font = `${Math.round(b * 0.62)}px "IM Fell English", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let j = 0; j < 8; j++) {
    const file = String.fromCharCode(97 + (ourWhite ? j : 7 - j));
    ctx.fillText(file, b + (j + 0.5) * s, px - b / 2);
  }
  for (let i = 0; i < 8; i++) {
    const rank = String(ourWhite ? 8 - i : i + 1);
    ctx.fillText(rank, b / 2, b + (i + 0.5) * s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}
