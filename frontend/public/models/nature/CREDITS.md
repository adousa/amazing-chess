# Nature models

From the **Stylized Nature MegaKit** by **Quaternius** (https://quaternius.com), downloaded from
https://poly.pizza/bundle/Stylized-Nature-MegaKit-T34GZFA0fm. Licence: **CC0 1.0 (public domain)**.

| File | Original model | Poly Pizza id |
|---|---|---|
| `tree_a.glb` | Tree (CommonTree_3) | 2c5938cb-4005-4958-829b-e191be39b3b9 |
| `tree_b.glb` | Tree (CommonTree_2) | 7bf2aa94-cc44-40d9-a93c-9489eb09e008 |
| `twisted.glb` | Twisted Tree (TwistedTree_1) | c6b8d04d-8ca3-4898-a180-e2ca2b936863 |
| `bush.glb` | Bush (Bush_Common) | 5d3066f4-58ac-46d4-899c-39d9e566e9df |
| `bush_flowers.glb` | Bush with Flowers | af83abca-9b41-4229-9652-e336a5f5eaba |

Optimised with `@gltf-transform/cli optimize --texture-compress webp --texture-size 512`
(10.5 MB → 1.6 MB). Leaves are re-tinted and animated in code (`src/scene/expedition/nature.ts`).
