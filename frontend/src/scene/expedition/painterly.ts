// Post-process for the Expedition stage: turns the render into an oil painting (a Kuwahara
// filter with a brush jitter), then grades it like a golden-hour canvas: warm highlights,
// teal shadows, canvas weave, vignette and cinematic letterbox bars for the duels.
import * as THREE from 'three';
import { Effect, EffectAttribute } from 'postprocessing';

const frag = /* glsl */ `
  uniform float uRadius;
  uniform float uTime;
  uniform float uLetterbox;
  uniform float uFlash;
  uniform float uSat;

  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
  }

  // one Kuwahara quadrant: mean and variance of a (R+1)x(R+1) block
  void quad(vec2 uv, vec2 dir, vec2 px, out vec3 mean, out float var) {
    vec3 s = vec3(0.0), s2 = vec3(0.0);
    float n = 0.0;
    for (int j = 0; j <= 3; j++) {
      for (int i = 0; i <= 3; i++) {
        if (float(i) > uRadius || float(j) > uRadius) continue;
        vec3 c = texture2D(inputBuffer, uv + vec2(float(i), float(j)) * dir * px).rgb;
        s += c; s2 += c * c; n += 1.0;
      }
    }
    mean = s / n;
    vec3 v = abs(s2 / n - mean * mean);
    var = v.r + v.g + v.b;
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    vec2 px = texelSize;
    // brush jitter: strokes lean along a slowly varying direction field
    float ang = vn(uv * vec2(9.0, 7.0)) * 6.2831;
    vec2 jit = vec2(cos(ang), sin(ang)) * px * 0.9;
    vec2 p = uv + jit;
    vec3 m0, m1, m2, m3; float v0, v1, v2, v3;
    quad(p, vec2(-1.0, -1.0), px, m0, v0);
    quad(p, vec2( 1.0, -1.0), px, m1, v1);
    quad(p, vec2(-1.0,  1.0), px, m2, v2);
    quad(p, vec2( 1.0,  1.0), px, m3, v3);
    vec3 col = m0; float best = v0;
    if (v1 < best) { best = v1; col = m1; }
    if (v2 < best) { best = v2; col = m2; }
    if (v3 < best) { best = v3; col = m3; }
    // keep a little of the original so fine highlights (sword edges, eyes) survive
    col = mix(col, inputColor.rgb, 0.12);

    // grade in a perceptual-ish space
    vec3 g = pow(max(col, 0.0), vec3(1.0 / 2.2));
    float l = dot(g, vec3(0.299, 0.587, 0.114));
    g = mix(vec3(l), g, uSat);
    vec3 shadowTint = vec3(0.10, 0.20, 0.26);
    vec3 lightTint = vec3(1.06, 0.97, 0.84);
    g = mix(g + shadowTint * (1.0 - smoothstep(0.0, 0.45, l)) * 0.22, g * lightTint, smoothstep(0.35, 1.0, l));
    // canvas weave + brush grain
    vec2 fp = uv / px;
    float weave = (sin(fp.x * 1.35) * sin(fp.y * 1.35)) * 0.012;
    float grain = (vn(fp * 0.55 + uTime * 0.3) - 0.5) * 0.035;
    g += weave + grain;
    // vignette (oval, warm)
    vec2 d = uv - 0.5;
    float vig = smoothstep(0.35, 0.95, length(d * vec2(1.25, 1.0)));
    g *= 1.0 - vig * 0.45;
    g = mix(g, g * vec3(1.0, 0.86, 0.72), vig * 0.35);
    // impact flash
    g = mix(g, vec3(1.0, 0.96, 0.88), uFlash);
    // letterbox bars
    float bar = uLetterbox * 0.11;
    if (uv.y < bar || uv.y > 1.0 - bar) g = vec3(0.02, 0.018, 0.016);
    outputColor = vec4(pow(max(g, 0.0), vec3(2.2)), inputColor.a);
  }
`;

export class PainterlyEffect extends Effect {
  constructor(radius = 3) {
    super('PainterlyEffect', frag, {
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, THREE.Uniform>([
        ['uRadius', new THREE.Uniform(radius)],
        ['uTime', new THREE.Uniform(0)],
        ['uLetterbox', new THREE.Uniform(0)],
        ['uFlash', new THREE.Uniform(0)],
        ['uSat', new THREE.Uniform(1.12)],
      ]),
    });
  }
  set(name: 'uRadius' | 'uTime' | 'uLetterbox' | 'uFlash' | 'uSat', v: number) {
    this.uniforms.get(name)!.value = v;
  }
  get(name: 'uLetterbox' | 'uFlash'): number {
    return this.uniforms.get(name)!.value as number;
  }
}
