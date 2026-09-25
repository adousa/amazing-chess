# 0004 · The replay is a 3D "Seventh Seal" stage (three.js, procedural)

**Status:** Accepted · 2026-09-25

## Context
The bonus prize judges board design, animation, how easy a game is to follow and "wow factor".
The team chose an homage to Ingmar Bergman's *The Seventh Seal*: the Knight plays chess with
Death on an empty stony beach, in black and white. Our engine is the Knight and Stockfish is Death.
Seen from the Knight's side, both players physically play every move. A flat 2D board can't
show two characters reaching for pieces.

## Decision
- Render the match page as a real-time 3D scene with **three.js** (`frontend/src/scene/`).
- Everything is **procedural**: sky, sea, surf, pebbles, rocks, board, pieces and both figures are
  generated in code. No stills, footage or models from the film are used. It is an homage, not a copy.
- Black and white comes from a post-process pass: luminance, contrast curve, grain, flicker,
  vignette and scratches. Materials may keep subtle tones, but the output is always greyscale.
- Moves are animated with **two-bone IK arms**. The mover's hand reaches, grips, lifts, carries
  and sets down each piece. Captured pieces go beside the board on the captor's side, and castling,
  en passant and promotion are all played out. Stepping one ply forward animates the move, while jumps
  and going back snap to the position.
- The chessground **2D board stays** as a view option and is used automatically when WebGL is
  unavailable.
- The 3D stage is lazy-loaded so only the match page pays for three.js.

## Consequences
- The frontend gains `three` (~160 kB gzip, in its own chunk) and two open-licensed font packages.
- No contract change: the scene only uses `Move.uci/fenAfter/color/by` and the existing events.
- `prefers-reduced-motion` turns off move animation, flicker, grain drift and camera sway.
