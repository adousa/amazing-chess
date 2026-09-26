# 0005 · A second stage: the painterly "Expedition" battlefield, with armed pieces and duels

**Status:** Accepted · 2026-09-26

## Context
The Seventh Seal stage (ADR 0004) is quiet and elegant. For the "wow factor" the team also wanted a
loud, colourful take, inspired by the painterly Belle Époque look of *Clair Obscur: Expedition 33*.
In that take the pieces are warriors with weapons and every capture is a dramatic fight.

## Decision
- Add a second 3D stage, **Expedition**, next to the Seventh Seal one. The match page has a stage
  toggle, remembered per browser, and Expedition is the default. The 2D board stays as before.
- **Inspired by, not copied from:** everything is procedural (no game assets, logos, characters or
  music). Our engine is **the Expedition** (ivory, gold and blue), and Stockfish is **the Paintress**
  (obsidian with a crimson glow). A Monolith on the horizon shows the Stockfish Elo.
- **Look:** a golden-hour ruined plaza on a headland with a painted sky, sea, floating islands,
  crimson trees, broken columns and Art Nouveau lamps. Across the sea is an island city with a
  bent, curled-over iron tower, a leaning lighthouse and red-sailed boats. On the horizon the
  fractured Monolith stands in a cloud of frozen rock shards. All of these are modelled in code
  from studying the concept art, not taken from it. Post-processing uses
  [`postprocessing`](https://github.com/pmndrs/postprocessing) (pmndrs, zlib) for bloom, ACES tone
  mapping and chromatic aberration. On top of that runs our own painterly pass: a Kuwahara filter
  with brush jitter, a warm/teal grade, canvas weave, a vignette, and letterbox bars during duels.
- **Armed pieces:** pawn = spear + shield, knight = lance under a horse helm, bishop = staff that
  casts a bolt, rook = war-hammer, queen = rapier, king = greatsword + crown.
- **Moves:** each piece moves its own way: pawns march, knights leap, bishops glide, rooks stomp,
  queens dash and kings step. Castling moves both pieces. On promotion a pillar of light dissolves
  the pawn and the new piece paints itself in.
- **The arena is a slow elevator:** the inner circle, and everything that fights on it (units,
  statues, highlights and effects), is one group. It rises and falls on a slow cosine cycle
  (16 m peak, 6 min period), independent of the moves. The
  camera (views and duel shots) is placed in arena space, so it rides along. The sun's
  shadow box follows the arena's height.
- **Captures are duels:** the camera cuts over the attacker's shoulder and both pieces face off.
  The attacker winds up, approaches and strikes. The impact plays in slow motion with sparks,
  flash, bloom and shake. The victim reels, then dissolves top-down into petals with burning edges
  (a shader dissolve). The attacker takes the square and the fallen piece reappears as a small
  statue beside the board. On checkmate the king kneels and half-dissolves.
- The duel can be switched off (**Duels on/off**): no camera cut, letterbox or slow motion.
  Autoplay waits for a duel to finish before the next move. Jumps, going back and key repeat snap.
  `prefers-reduced-motion` snaps every move.

- **Nature:** grass and sea are shaders (instanced wind-blown blades; Gerstner waves with foam,
  fresnel and sun glitter). Trees and bushes are CC0 glTF models by Quaternius, downloaded with
  the team's approval, optimised to WebP textures (1.6 MB total), then re-tinted and animated
  in code. If they fail to load, simple procedural trees are used instead.

## Consequences
- New dependency `postprocessing` (and the Cormorant Garamond font). The Expedition stage is its
  own lazy chunk (~34 kB gzip on top of the shared three.js chunk).
- Five CC0 models (1.6 MB) are served from `frontend/public/models/nature/` and credited there.
- Captures take about 2–3.6 s to play out, so autoplay at "fast" is slower on captures by design.
- No contract change: the stage only uses `Move.uci/fenAfter/san/color/by`, the Stockfish Elo and
  the existing events.
