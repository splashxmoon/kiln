import type { ShaderSpec } from '../editor/types'
import { SHADER_DEFS, shaderPreviewCSS } from './defs'
import { VERTEX_SOURCE, getFragmentSource } from './glsl'
import { resolveUniforms } from './uniforms'

const round = (n: number) => Math.round(n * 10000) / 10000

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Dependency-free vanilla JS + WebGL snippet reproducing a shader layer in exported code.
 * Uses the same GLSL and uniforms as the editor. The canvas fills its parent; the CSS
 * preview gradient stays visible as a fallback when WebGL is unavailable.
 */
export function shaderToStandaloneSnippet(spec: ShaderSpec, id: string): { html: string; js: string } {
  const def = SHADER_DEFS[spec.kind] ?? SHADER_DEFS.aurora
  const u = resolveUniforms({ ...spec, kind: def.kind })
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '-') || 'kiln-shader'
  const speed = Number.isFinite(spec.speed) ? spec.speed : def.defaultSpeed
  const preview = shaderPreviewCSS({ ...spec, kind: def.kind })

  const html =
    `<canvas id="${escapeAttr(safeId)}" data-kiln-shader="${def.kind}" aria-hidden="true" ` +
    `style="display:block;width:100%;height:100%;background:${escapeAttr(preview)}"></canvas>`

  const colors = JSON.stringify(u.colors.map((c) => c.map(round)))
  const params = JSON.stringify(u.numbers.map(round))

  const js = `/* Kiln shader: ${def.label} (${def.kind}). Plain WebGL, no dependencies. */
(function () {
  var canvas = document.getElementById(${JSON.stringify(safeId)});
  if (!canvas) return;
  var VERT = ${JSON.stringify(VERTEX_SOURCE)};
  var FRAG = ${JSON.stringify(getFragmentSource(def.kind))};
  var COLORS = ${colors};
  var PARAMS = ${params};
  var SPEED = ${round(speed)};
  var MAX_DPR = 2, MAX_SIDE = 1600;
  var gl = null, loc = {}, time = 0, last = 0, raf = 0, visible = true;
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  }

  function init() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false }) ||
      canvas.getContext('experimental-webgl');
    if (!gl) return false;
    var vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'a_position');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn(gl.getProgramInfoLog(prog)); return false; }
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (var i = 0; i < 4; i++) gl.uniform3fv(gl.getUniformLocation(prog, 'u_c' + i), COLORS[i]);
    for (var j = 0; j < 5; j++) gl.uniform1f(gl.getUniformLocation(prog, 'u_p' + j), PARAMS[j]);
    loc.time = gl.getUniformLocation(prog, 'u_time');
    loc.res = gl.getUniformLocation(prog, 'u_resolution');
    loc.ratio = gl.getUniformLocation(prog, 'u_pixelRatio');
    return true;
  }

  function draw() {
    if (!gl || gl.isContextLost()) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    var s = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    var longest = Math.max(w, h) * s;
    if (longest > MAX_SIDE) s *= MAX_SIDE / longest;
    var W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.uniform1f(loc.time, time);
    gl.uniform2f(loc.res, W, H);
    gl.uniform1f(loc.ratio, W / w);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function animating() {
    return SPEED !== 0 && !(reduce && reduce.matches) && visible && !document.hidden;
  }

  function frame(now) {
    raf = 0;
    var dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    last = now;
    if (animating()) time += dt * SPEED;
    draw();
    if (animating()) raf = requestAnimationFrame(frame);
    else last = 0;
  }

  function start() { if (!raf && !document.hidden) raf = requestAnimationFrame(frame); }

  if (!init()) return;
  canvas.addEventListener('webglcontextlost', function (e) {
    e.preventDefault();
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }, false);
  canvas.addEventListener('webglcontextrestored', function () { if (init()) start(); }, false);
  if (window.ResizeObserver) new ResizeObserver(start).observe(canvas);
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      visible = entries[entries.length - 1].isIntersecting;
      if (visible) start();
    }).observe(canvas);
  }
  document.addEventListener('visibilitychange', start);
  if (reduce && reduce.addEventListener) reduce.addEventListener('change', start);
  start();
})();
`

  return { html, js }
}
