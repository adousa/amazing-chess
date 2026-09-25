import type { AnalyzedMove } from '../api/client';

const W = 300;
const H = 90;
const CAP = 1000; // clamp evals to ±10 pawns

/** Tiny SVG eval line (White's point of view). Click to jump to a ply. */
export function EvalGraph({
  analysis,
  plies,
  ply,
  onJump,
}: {
  analysis: AnalyzedMove[];
  plies: number;
  ply: number;
  onJump: (p: number) => void;
}) {
  const total = Math.max(plies, 1);
  const x = (p: number) => (p / total) * W;
  const val = (a: AnalyzedMove) => {
    if (a.mateIn !== undefined && a.mateIn !== null) {
      const sign = a.mateIn === 0 ? (a.ply % 2 === 1 ? 1 : -1) : Math.sign(a.mateIn);
      return sign * CAP;
    }
    return Math.max(-CAP, Math.min(CAP, a.evalCp ?? 0));
  };
  const y = (v: number) => H / 2 - (v / CAP) * (H / 2);
  const sorted = [...analysis].sort((a, b) => a.ply - b.ply);
  const pts = [`0,${y(0)}`, ...sorted.map((a) => `${x(a.ply)},${y(val(a))}`)].join(' ');
  return (
    <svg
      width={W}
      height={H}
      className="evalgraph"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump(Math.round(((e.clientX - r.left) / r.width) * total));
      }}
    >
      <rect width={W} height={H / 2} fill="#eee" />
      <rect y={H / 2} width={W} height={H / 2} fill="#555" />
      <polyline points={pts} fill="none" stroke="#2a7" strokeWidth={2} />
      {sorted
        .filter((a) => a.classification === 'blunder' || a.classification === 'mistake')
        .map((a) => (
          <circle key={a.ply} cx={x(a.ply)} cy={y(val(a))} r={3} fill={a.classification === 'blunder' ? 'red' : 'orange'} />
        ))}
      <line x1={x(ply)} x2={x(ply)} y1={0} y2={H} stroke="#36c" />
    </svg>
  );
}
