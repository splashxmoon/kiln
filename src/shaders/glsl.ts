import type { ShaderKind } from '../editor/types'

/**
 * Kiln shader sources. WebGL1 / GLSL ES 1.00.
 *
 * Shared uniforms:
 *   u_time        seconds, already multiplied by the layer's speed
 *   u_resolution  drawing buffer size in pixels
 *   u_pixelRatio  buffer pixels per CSS (layout) pixel, so px-sized params (dot size, pixel size, grain) stay crisp
 *   u_c0..u_c3    colour params in param order (sRGB 0..1)
 *   u_p0..u_p4    numeric params in param order
 *
 * The vertex stage draws one oversized triangle that covers the viewport.
 */

export const VERTEX_SOURCE = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`

const COMMON = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform float u_time;
uniform vec2 u_resolution;
uniform float u_pixelRatio;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform float u_p0;
uniform float u_p1;
uniform float u_p2;
uniform float u_p3;
uniform float u_p4;

const float TAU = 6.283185307;

// Colours are blended in (approximately) linear light for clean, rich mixes.
vec3 toLinear(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(2.2)); }
vec3 toDisplay(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(0.4545)); }

float hash21(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1047, 0.1123, 0.0891));
  q += dot(q, q.zxy + 31.71);
  return fract((q.x + q.z) * q.y);
}

vec2 hash22(vec2 p) {
  vec3 q = fract(p.xyx * vec3(0.1047, 0.1123, 0.0891));
  q += dot(q, q.yzx + 31.71);
  return fract(vec2((q.x + q.y) * q.z, (q.y + q.z) * q.x));
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// rotate ~37 degrees and double the frequency each octave
const mat2 OCTAVE = mat2(1.6, 1.2, -1.2, 1.6);

float fbm3(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * vnoise(p);
    p = OCTAVE * p + vec2(13.7, 7.3);
    a *= 0.5;
  }
  return s / 0.875;
}

float fbm5(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = OCTAVE * p + vec2(13.7, 7.3);
    a *= 0.5;
  }
  return s / 0.96875;
}

float minRes() { return max(min(u_resolution.x, u_resolution.y), 1.0); }

// Aspect-correct coordinates centred on the layer, shorter side spans 1.0
vec2 centered() { return (gl_FragCoord.xy - 0.5 * u_resolution) / minRes(); }
vec2 halfExtent() { return 0.5 * u_resolution / minRes(); }

// Static per-CSS-pixel grain in 0..1
float grainAt() { return hash21(floor(gl_FragCoord.xy / max(u_pixelRatio, 1.0)) + 0.37); }

vec3 ramp3(vec3 a, vec3 b, vec3 c, float t) {
  t = clamp(t, 0.0, 1.0) * 2.0;
  return mix(mix(a, b, smoothstep(0.0, 1.0, t)), c, smoothstep(1.0, 2.0, t));
}

vec3 ramp4(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  vec3 col = mix(a, b, smoothstep(0.0, 1.0, t));
  col = mix(col, c, smoothstep(1.0, 2.0, t));
  return mix(col, d, smoothstep(2.0, 3.0, t));
}

// Linear colour -> display, plus optional film grain and a 1/255 dither against banding
vec4 finish(vec3 lin, float grain) {
  vec3 c = toDisplay(lin);
  c += (grainAt() - 0.5) * grain;
  c += (hash21(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) / 255.0;
  return vec4(clamp(c, 0.0, 1.0), 1.0);
}
`

/* aurora: p0 scale, p1 distortion, p2 softness, p3 grain */
const AURORA = `
float auroraWeight(vec2 p, vec2 anchor, float power) {
  vec2 d = p - anchor;
  return 1.0 / (0.02 + pow(dot(d, d) * 4.0, power));
}

void main() {
  vec3 c0 = toLinear(u_c0);
  vec3 c1 = toLinear(u_c1);
  vec3 c2 = toLinear(u_c2);
  vec3 c3 = toLinear(u_c3);
  float scale = max(u_p0, 0.05);
  float distortion = max(u_p1, 0.0);
  float softness = clamp(u_p2, 0.0, 1.0);

  vec2 p = centered();
  vec2 he = halfExtent();
  float t = u_time * 0.45 + 17.0;

  // slow domain warp gives the anchors organic, folded boundaries
  vec2 q = p * scale * 1.4;
  vec2 warp = vec2(
    fbm3(q + vec2(0.0, t * 0.5)),
    fbm3(q + vec2(5.2, 1.7) - vec2(t * 0.42, 0.0))
  ) - 0.5;
  vec2 w = p + warp * distortion * 1.1;
  w += 0.06 * distortion * vec2(sin(w.y * 4.0 * scale + t), cos(w.x * 3.4 * scale - t * 0.8));

  float power = mix(2.6, 0.9, softness);
  vec2 a0 = he * 0.78 * vec2(sin(t * 0.31 + 0.4), cos(t * 0.23 + 1.1));
  vec2 a1 = he * 0.82 * vec2(cos(t * 0.27 + 2.3), sin(t * 0.29 + 4.0));
  vec2 a2 = he * 0.74 * vec2(sin(t * 0.19 + 3.7), sin(t * 0.33 + 0.2));
  vec2 a3 = he * 0.86 * vec2(cos(t * 0.26 + 5.1), cos(t * 0.21 + 2.9));
  float w0 = auroraWeight(w, a0, power);
  float w1 = auroraWeight(w, a1, power);
  float w2 = auroraWeight(w, a2, power);
  float w3 = auroraWeight(w, a3, power);
  vec3 col = (c0 * w0 + c1 * w1 + c2 * w2 + c3 * w3) / (w0 + w1 + w2 + w3);

  // a faint sheen so large flat areas still breathe
  float sheen = fbm3(w * scale * 2.2 - vec2(t * 0.2, 0.0));
  col *= 0.94 + 0.12 * sheen;

  gl_FragColor = finish(col, u_p3);
}
`

/* grain: p0 radius, p1 grain, p2 softness, p3 distortion */
const GRAIN = `
void main() {
  vec3 c0 = toLinear(u_c0);
  vec3 c1 = toLinear(u_c1);
  vec3 c2 = toLinear(u_c2);
  vec3 c3 = toLinear(u_c3);
  float radius = max(u_p0, 0.05);
  float grain = clamp(u_p1, 0.0, 1.0);
  float softness = clamp(u_p2, 0.0, 1.0);
  float distortion = max(u_p3, 0.0);

  vec2 p = centered();
  vec2 he = halfExtent();
  float t = u_time * 0.4 + 3.0;

  vec2 n = vec2(
    fbm3(p * 1.8 + vec2(t * 0.21, 0.0)),
    fbm3(p * 1.8 + vec2(3.1, 7.4) - vec2(0.0, t * 0.17))
  ) - 0.5;
  vec2 pw = p + n * distortion * 0.5;

  // grain jitters the gradient lookup itself, so stops dissolve into stipple
  float g = grainAt() - 0.5;
  vec2 core = vec2(-0.18 * he.x, -0.12 * he.y) + 0.07 * vec2(sin(t * 0.7), cos(t * 0.53));
  float r = length(pw - core) / radius + g * grain * 0.55;
  vec3 col = mix(c0, c1, smoothstep(0.0, mix(0.5, 0.9, softness), r));
  col = mix(col, c2, smoothstep(mix(0.55, 0.4, softness), mix(0.95, 1.35, softness), r));

  vec2 glowPos = vec2(0.42 * he.x, 0.36 * he.y) + 0.06 * vec2(cos(t * 0.45), sin(t * 0.6));
  float r2 = length(pw - glowPos) / (radius * 0.75) + g * grain * 0.55;
  col = mix(col, c3, (1.0 - smoothstep(0.0, mix(0.6, 1.1, softness), r2)) * 0.6);

  gl_FragColor = finish(col, grain * 0.16);
}
`

/* halftone: p0 dot size (css px), p1 angle (deg), p2 contrast, p3 scale, p4 softness */
const HALFTONE = `
void main() {
  vec3 paper = toLinear(u_c0);
  vec3 ink = toLinear(u_c1);
  vec3 accent = toLinear(u_c2);
  float pitch = max(u_p0, 1.0) * max(u_pixelRatio, 0.01);
  float ang = u_p1 * 0.01745329;
  float cs = cos(ang);
  float sn = sin(ang);
  float contrast = max(u_p2, 0.0);
  float scale = max(u_p3, 0.05);
  float softness = clamp(u_p4, 0.0, 1.0);
  float t = u_time * 0.35 + 5.0;
  float mr = minRes();

  vec2 frag = gl_FragCoord.xy;
  vec2 uvPix = (frag - 0.5 * u_resolution) / mr;
  vec2 qPix = uvPix * scale * 1.6;
  // the warp varies slowly, so it is evaluated once per pixel and shared by the dot centres
  vec2 warp = (vec2(
    fbm3(qPix * 0.8 + vec2(t * 0.3, 0.0)),
    fbm3(qPix * 0.8 + vec2(4.3, -t * 0.25))
  ) - 0.5) * 1.4;

  // rotated screen space, one unit per dot
  vec2 g = vec2(cs * frag.x + sn * frag.y, -sn * frag.x + cs * frag.y) / pitch;
  vec2 base = floor(g - 0.5);
  float aa = (0.7 + softness * pitch * 0.3) / pitch;

  // union of the four nearest dots so large dots can grow past their cell
  float mask = 0.0;
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 c = base + vec2(float(i), float(j)) + 0.5;
      vec2 cp = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y) * pitch;
      vec2 uv = (cp - 0.5 * u_resolution) / mr;
      float f = fbm3(uv * scale * 1.6 + warp + vec2(0.0, -t * 0.12));
      float tone = clamp((f - 0.5) * contrast * 2.2 + 0.45 + 0.28 * (uv.x * 0.6 - uv.y), 0.0, 1.0);
      float r = sqrt(tone) * 0.66;
      float d = length(g - c);
      float cover = 1.0 - smoothstep(r - aa, r + aa, d);
      mask = max(mask, cover * smoothstep(0.0, 0.04, tone));
    }
  }

  float hue = smoothstep(0.2, 0.8, fbm3(uvPix * scale * 0.7 + vec2(-t * 0.1, 2.0)) + uvPix.x * 0.35);
  vec3 dotCol = mix(ink, accent, hue);
  gl_FragColor = finish(mix(paper, dotCol, mask), 0.0);
}
`

/* dither: p0 pixel size (css px), p1 scale, p2 contrast, p3 distortion */
const DITHER = `
// 2x2 Bayer index (0..3) from integer coords
float bayer2(vec2 a) {
  a = mod(a, 2.0);
  return 2.0 * abs(a.x - a.y) + a.y;
}

// 8x8 ordered threshold in (0,1): low bits carry the largest weight
float bayer8(vec2 a) {
  a = floor(a);
  float v = 16.0 * bayer2(a) + 4.0 * bayer2(floor(a * 0.5)) + bayer2(floor(a * 0.25));
  return (v + 0.5) / 64.0;
}

void main() {
  float px = max(floor(max(u_p0, 1.0) * max(u_pixelRatio, 0.01) + 0.5), 1.0);
  float scale = max(u_p1, 0.05);
  float contrast = max(u_p2, 0.0);
  float distortion = max(u_p3, 0.0);
  float t = u_time * 0.4 + 2.0;

  vec2 cell = floor(gl_FragCoord.xy / px);
  vec2 uv = ((cell + 0.5) * px - 0.5 * u_resolution) / minRes();
  vec2 q = uv * scale * 2.0;
  vec2 w = vec2(fbm3(q + vec2(t * 0.35, 0.0)), fbm3(q + vec2(3.7, -t * 0.3))) - 0.5;
  float f = fbm5(q + w * distortion * 2.5 + vec2(0.0, -t * 0.15));
  float v = clamp((f - 0.5) * contrast * 2.4 + 0.5 + 0.22 * uv.y, 0.0, 1.0);

  float s = v * 3.0;
  float lvl = floor(s);
  lvl += step(bayer8(cell), s - lvl);
  lvl = min(lvl, 3.0);

  vec3 col = u_c0;
  col = mix(col, u_c1, step(0.5, lvl));
  col = mix(col, u_c2, step(1.5, lvl));
  col = mix(col, u_c3, step(2.5, lvl));
  gl_FragColor = vec4(col, 1.0);
}
`

/* ripple: p0 scale, p1 distortion, p2 sharpness, p3 brightness */
const RIPPLE = `
// zero crossings of a warped lattice form a moving caustic network; returns 0..1 (0 = on a line)
float causticField(vec2 q, float t, float distortion) {
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    q += distortion * 0.5 / (1.0 + fi * 0.5) * vec2(
      cos(q.y * 1.1 + t * (0.55 + 0.1 * fi) + fi * 1.7),
      sin(q.x * 0.9 - t * (0.45 + 0.12 * fi) + fi * 2.3)
    );
  }
  return abs(sin(q.x) + sin(q.y * 0.9 + 1.3)) * 0.5;
}

void main() {
  vec3 deep = toLinear(u_c0);
  vec3 water = toLinear(u_c1);
  vec3 light = toLinear(u_c2);
  float scale = max(u_p0, 0.05);
  float distortion = max(u_p1, 0.0);
  float sharp = max(u_p2, 0.5);
  float bright = max(u_p3, 0.0);

  vec2 p = centered();
  vec2 he = halfExtent();
  float t = u_time * 0.6 + 7.0;

  float depth = smoothstep(-he.y, he.y * 1.1, p.y + 0.35 * (fbm3(p * 1.4 + vec2(t * 0.08, 0.0)) - 0.5));
  vec3 col = mix(deep, water, depth);

  vec2 q = p * scale * 4.0;
  float l1 = exp(-causticField(q, t, distortion) * sharp * 2.0);
  float l2 = exp(-causticField(q * 1.6 + vec2(3.1, 1.3), t * 1.15 + 2.0, distortion) * sharp * 2.4);
  float caustic = l1 * 0.75 + l2 * 0.45;
  caustic *= caustic;
  col = mix(col, light, clamp(caustic * bright * mix(0.55, 1.0, depth), 0.0, 1.0));

  gl_FragColor = finish(col, 0.025);
}
`

/* voronoi: p0 scale, p1 border, p2 softness, p3 motion */
const VORONOI = `
void main() {
  vec3 c0 = toLinear(u_c0);
  vec3 c1 = toLinear(u_c1);
  vec3 c2 = toLinear(u_c2);
  vec3 seam = toLinear(u_c3);
  float scale = max(u_p0, 0.2);
  float border = max(u_p1, 0.0);
  float softness = clamp(u_p2, 0.0, 1.0);
  float motion = max(u_p3, 0.0);
  float t = u_time * 0.5 + 1.0;

  vec2 p = centered() * scale;
  vec2 ip = floor(p);
  vec2 fp = p - ip;
  float d1 = 8.0;
  float d2 = 8.0;
  vec2 cellId = ip;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 h = hash22(ip + o);
      vec2 pt = o + 0.5 + 0.36 * sin(TAU * h + t * motion * (0.6 + 0.8 * h.yx));
      float d = length(pt - fp);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        cellId = ip + o;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }

  // neighbouring cells share a slow regional hue so the palette reads as a field, not confetti
  float hc = hash21(cellId + 3.7);
  float region = fbm3(cellId * 0.22 + vec2(t * 0.05, 1.3));
  vec3 col = ramp3(c0, c1, c2, clamp(region * 1.3 - 0.15 + (hc - 0.5) * 0.5, 0.0, 1.0));
  col *= mix(1.04, 0.86, smoothstep(0.0, 0.8, d1) * (0.4 + 0.6 * softness));

  float aa = 1.5 * scale / minRes();
  float edge = d2 - d1;
  float b = 1.0 - smoothstep(border, border + aa + softness * 0.3, edge);
  col = mix(col, seam, b * 0.9);

  gl_FragColor = finish(col, 0.03);
}
`

/* waves: p0 bands, p1 amplitude, p2 frequency, p3 softness */
const WAVES = `
void main() {
  vec3 c0 = toLinear(u_c0);
  vec3 c1 = toLinear(u_c1);
  vec3 c2 = toLinear(u_c2);
  vec3 c3 = toLinear(u_c3);
  float bands = max(floor(u_p0 + 0.5), 1.0);
  float amp = max(u_p1, 0.0) * 0.12;
  float freq = max(u_p2, 0.05) * 3.0;
  float softness = clamp(u_p3, 0.0, 1.0);

  vec2 p = centered();
  vec2 he = halfExtent();
  float y = p.y / he.y * 0.5 + 0.5;
  float x = p.x;
  float t = u_time * 0.6 + 4.0;

  // the y terms give every band its own phase
  float disp = sin(x * freq + t + y * 2.3)
    + 0.55 * sin(x * freq * 1.83 - t * 1.27 + y * 4.1)
    + 0.7 * (vnoise(vec2(x * freq * 0.5 + t * 0.25, y * 3.0)) - 0.5);
  float s = (y + amp * disp) * bands;
  float idx = floor(s);
  float f = s - idx;
  float denom = max(bands - 1.0, 1.0);

  // each nearer (lower) band casts a soft shadow onto the band behind it
  float shadowW = mix(0.06, 0.55, softness);
  float lift = mix(0.96, 1.04, f);
  float shade = 1.0 - 0.3 * (1.0 - smoothstep(0.0, shadowW, f));
  vec3 cur = ramp4(c0, c1, c2, c3, idx / denom) * shade * lift;
  vec3 prevTop = ramp4(c0, c1, c2, c3, (idx - 1.0) / denom) * 1.04;

  float aa = min(1.5 * bands / max(u_resolution.y, 1.0), 0.5);
  vec3 col = mix(prevTop, cur, smoothstep(0.0, aa, f));

  gl_FragColor = finish(col, 0.03);
}
`

const BODIES: Record<ShaderKind, string> = {
  aurora: AURORA,
  grain: GRAIN,
  halftone: HALFTONE,
  dither: DITHER,
  ripple: RIPPLE,
  voronoi: VORONOI,
  waves: WAVES,
}

export function getFragmentSource(kind: ShaderKind): string {
  return COMMON + (BODIES[kind] ?? AURORA)
}
