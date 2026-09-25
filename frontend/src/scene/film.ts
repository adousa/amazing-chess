// Post-process: 1950s black-and-white film — luminance only, S-curve contrast, vignette,
// grain, a gentle projector flicker and the odd vertical scratch.
import * as THREE from 'three';

export const FilmShader = {
  name: 'SeventhSealFilm',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(1, 1) },
    uGrain: { value: 0.075 },
    uFlicker: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uGrain, uFlicker;
    uniform vec2 uRes;
    varying vec2 vUv;
    float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      l = smoothstep(0.0, 1.0, pow(l, 1.08));                // film S-curve
      float frame = floor(uTime * 24.0);
      l *= 1.0 + uFlicker * (rand(vec2(frame, 1.7)) - 0.5) * 0.05;
      vec2 d = vUv - 0.5; d.x *= uRes.x / uRes.y;
      l *= 1.0 - smoothstep(0.4, 1.05, length(d)) * 0.6;      // vignette
      l += (rand(floor(vUv * uRes / 1.5) + frame * 0.137) - 0.5) * uGrain;
      // an occasional scratch
      float sc = rand(vec2(floor(uTime * 3.0), 9.1));
      if (uFlicker > 0.0 && sc > 0.82) {
        float x = rand(vec2(floor(uTime * 3.0), 3.3));
        l = mix(l, l * 0.55 + 0.35, (1.0 - smoothstep(0.0, 0.0012, abs(vUv.x - x))) * 0.5);
      }
      gl_FragColor = vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
    }`,
};
