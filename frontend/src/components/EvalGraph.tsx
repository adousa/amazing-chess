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
      viewBox={`0 0 ${W} ${H}`}
      className="evalgraph"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onJump(Math.round(((e.clientX - r.left) / r.width) * total));
      }}
    >
      <rect width={W} height={H / 2} fill="#d6d6d6" />
      <rect y={H / 2} width={W} height={H / 2} fill="#1b1b1b" />
      <polyline points={pts} fill="none" stroke="#7d7d7d" strokeWidth={2} />
      {sorted
        .filter((a) => a.classification === 'blunder' || a.classification === 'mistake')
        .map((a) => (
          <circle key={a.ply} cx={x(a.ply)} cy={y(val(a))} r={a.classification === 'blunder' ? 3.5 : 2.5} fill="#000" stroke="#fff" strokeWidth={1} />
        ))}
      <line x1={x(ply)} x2={x(ply)} y1={0} y2={H} stroke="#999" strokeDasharray="3 2" />
    </svg>
  );
}
