// The edit suite: one horizontal world shared by a Three.js scene and DOM chapters.
// Scrolling moves the camera and the DOM track together (1 world unit == 1 CSS px at z=0).
import * as THREE from 'three';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { gsap } from 'gsap';
import VIDEOS from './data/videos.json';
import DESIGNS from './data/designs.json';
import NOTES from './data/notes.json';
import CATS from './data/categories.json';
import graphData from './data/ai-graph.json';
import careerData from './data/career.json';
import { EMAIL, PHONE, DECK_IDS, GHOSTS, BUILT, thumbURL, fallbackThumbURL, previewURL, metaURL, embedURL } from './config.js';

const { nodes: NODES, edges: EDGES } = graphData;
const { lanes: LANES, items: CAREER } = careerData;
// "now" in career.json can pin a month; null follows today's date so running clips keep growing
const today = new Date();
const NOW = careerData.now || [today.getFullYear(), today.getMonth() + 1];

/* ============= HELPERS ============= */
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = matchMedia('(pointer:fine)').matches;
if (fine) document.body.classList.add('fine');
const tcFmt = s => { // 100px of travel = 1s of "footage" at 25fps
  const f = Math.max(0, Math.floor(s / 4));
  const ff = f % 25, ss = Math.floor(f / 25) % 60, mm = Math.floor(f / 1500) % 60, hh = Math.floor(f / 90000);
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':');
};
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ============= RENDERER ============= */
const canvas = $('#gl');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x0f0d0b);
// Sharpness: tilted surfaces (table, career) need anisotropic filtering, and canvas-drawn
// textures are drawn at screen pixel density instead of 1 px per world unit.
const ANISO = renderer.capabilities.getMaxAnisotropy();
const TEX_MAX = Math.min(renderer.capabilities.maxTextureSize, 8192);
const TEX_DPR = Math.max(1.5, renderer.getPixelRatio());
const texW = worldW => Math.min(TEX_MAX, Math.round(worldW * TEX_DPR));
// Screen-facing textures are drawn at exactly the screen's pixel density and sampled without
// mipmaps: trilinear filtering between mip levels is what made text and photos look soft.
const PR = renderer.getPixelRatio();
function sharp(t){ t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.needsUpdate = true; return t; }
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.sortObjects = true;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0f0d0b, 1000, 3000);
const camera = new THREE.PerspectiveCamera(35, 1, 10, 10000);
const FOV_HALF = THREE.MathUtils.degToRad(17.5);

// Text-heavy panels (AI nodes, clapperboard slate) are real HTML placed in the same 3D space by
// CSS3DRenderer with the same camera. The browser rasterises that text as vectors, so it stays
// sharp at any tilt, where text baked into a WebGL texture always gets resampled.
const cssRenderer = new CSS3DRenderer();
cssRenderer.domElement.className = 'css3d';
canvas.after(cssRenderer.domElement);
const cssScene = new THREE.Scene();
cssScene.matrixWorldAutoUpdate = false; // objects are pinned to WebGL meshes by hand, see pinCss()
const tmpM = new THREE.Matrix4();
// matrixWorld = anchor · translate(x, y, z) · scale(s): s maps the element's CSS px to world units
function pinCss(obj, anchor, s, z = 0, x = 0, y = 0){
  obj.matrixWorld.copy(anchor).multiply(tmpM.makeTranslation(x, y, z)).multiply(tmpM.makeScale(s, s, 1));
}
function cssObject(el){
  const o = new CSS3DObject(el);
  el.style.pointerEvents = 'none'; // CSS3DObject sets 'auto'; hover/drag are hit-tested on the WebGL canvas
  o.matrixAutoUpdate = false; o.matrixWorldAutoUpdate = false;
  cssScene.add(o);
  return o;
}

// shared GPU resources
const PLANE = new THREE.PlaneGeometry(1, 1);
// draw() works in w×h logical units; `scale` sets how many texture pixels each unit gets
function canvasTex(w, h, draw, scale = 1){
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const g = c.getContext('2d');
  g.scale(c.width / w, c.height / h);
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = ANISO;
  return t;
}
const roundAlpha = (w, h, r) => canvasTex(w, h, (g) => {
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.beginPath(); g.roundRect(1, 1, w - 2, h - 2, r); g.fill();
});
const ALPHA = roundAlpha(192, 256, 14);
const ALPHA_SOFT = roundAlpha(256, 256, 4);
const ALPHA_NODE = roundAlpha(480, 260, 34);
const SHADOW = canvasTex(128, 128, (g, w, h) => {
  const r = g.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2);
  r.addColorStop(0, 'rgba(0,0,0,.85)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
});
// Cards overlap and tilt into each other, so depth testing would slice them where they intersect.
// Instead every card part skips the depth buffer and draw order is set explicitly each frame.
const mat = o => new THREE.MeshBasicMaterial({transparent:true, depthTest:false, depthWrite:false, ...o});

/* ============= VIEWPORT / LAYOUT STATE ============= */
const V = {w:0, h:0, D:0, hud:64, tl:132, avail:0, cy:0, y0:0, mobile:false};
const L = {cardW:0, cardH:0, gap:0, videoStart:0, dheadX:0, tableX:0, TW:0, TH:0, aheadX:0, graphX:0, GW:0, GH:0, endX:0, worldEnd:0};
let scroll = 0, target = 0, vel = 0, maxScroll = 0;
let filter = 'all';
let viewing = null, hovered = null, dim = 0, dimTarget = 0;
let stackTop = 0;
let lastCareerKey = null, careerPlayheadX = 0; // which career clips sit under the playhead; layout() resets it
const pointer = {x:-9999, y:-9999, ndc:new THREE.Vector2(9, 9), inside:false};
const mouseN = {x:0, y:0, tx:0, ty:0}; // -1..1 for parallax

/* ============= LIGHT TABLE ============= */
const table = new THREE.Group();
scene.add(table);
const tableMat = mat({alphaMap:ALPHA_SOFT});
const tableMesh = new THREE.Mesh(PLANE, tableMat);
tableMesh.renderOrder = 1;
table.add(tableMesh);
table.userData = {W:1, H:1};
const dragPlane = new THREE.Plane();

/* ============= AI NODE GRAPH ============= */
const graph = new THREE.Group();
scene.add(graph);
graph.userData = {W:1, H:1};
const graphMat = mat({alphaMap:ALPHA_SOFT, opacity:.9});
const graphMesh = new THREE.Mesh(PLANE, graphMat);
graphMesh.renderOrder = 1;
graph.add(graphMesh);

// Text printed on the table mat and the node-graph panel, as HTML pinned to those surfaces.
const tableText = cssObject(Object.assign(document.createElement('div'), {className:'surface3d'}));
const graphText = cssObject(Object.assign(document.createElement('div'), {className:'surface3d'}));
function setSurfaceText(o, W, H, html){
  o.element.style.width = W + 'px'; o.element.style.height = H + 'px';
  o.element.innerHTML = html;
}

function drawGraphBg(GW, GH){
  const w = texW(GW), h = Math.round(w * GH / GW), k = w / GW;
  const tex = canvasTex(w, h, g => {
    g.fillStyle = '#14120F'; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(239,231,214,.32)'; // node-editor dot grid, kept visible on dark screens
    const cell = 24 * k, dot = 2.4 * k;
    for (let y = cell; y < h; y += cell) for (let x = cell; x < w; x += cell) g.fillRect(x - dot / 2, y - dot / 2, dot, dot);
  });
  setSurfaceText(graphText, GW, GH,
    '<span class="st-label" style="left:24px;top:16px">NODE VIEW · WORKFLOW · 2026</span>' + (wfState === 'idle' ? '' : '<span class="st-label st-live" style="right:24px;top:16px">● LIVE</span>') + '<i class="st-scan"></i>' +
    (wfState === 'idle' ? '' : // the legend needs the open panel's width
    '<span class="st-label st-lane" style="left:24px;bottom:16px"><i class="st-key"></i>V1 · QUY TRÌNH CHÍNH<i class="st-key st-fx"></i>FX · AI HỖ TRỢ<i class="st-key st-loop"></i>FEEDBACK</span>'));
  tex.colorSpace = THREE.SRGBColorSpace;
  if (graphMat.map) graphMat.map.dispose();
  graphMat.map = tex; graphMat.needsUpdate = true;
}

// wires: camera-facing ribbons along a cubic bezier, rewritten in place every frame (no allocations)
const WIRE_SEG = 40;
const wireIndex = [];
for (let i = 0; i < WIRE_SEG; i++){ const a = i * 2; wireIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
const PULSE_TEX = canvasTex(64, 64, (g, w, h) => {
  const r = g.createRadialGradient(w/2, h/2, 0, w/2, h/2, w/2);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(.35, 'rgba(255,255,255,.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, w, h);
});
const dashIndex = wireIndex.filter((_, i) => Math.floor(i / 6) % 2 === 0); // every other segment: a dashed wire
const PULSES_PER_WIRE = 2;
let wires = [], pulses;
// Wire kinds: plain (out port -> in port, horizontal tangents, like a compositor), "assist" (an AI node
// below feeding up into a workflow step: top -> bottom, vertical tangents, dashed) and "loop" (the
// feedback wire, arcing back over the lane from one node's top to another's).
const c1 = new THREE.Vector3(), c2 = new THREE.Vector3();
function bezier(a, b, t, out){
  const u = 1 - t;
  out.x = u*u*u*a.x + 3*u*u*t*c1.x + 3*u*t*t*c2.x + t*t*t*b.x;
  out.y = u*u*u*a.y + 3*u*u*t*c1.y + 3*u*t*t*c2.y + t*t*t*b.y;
  out.z = lerp(a.z, b.z, t);
  return out;
}
function wireEnds(w){ // sets pA, pB and the control points c1, c2 for this frame
  const ga = w.a.group.position, gb = w.b.group.position;
  if (w.kind === 'assist'){
    pA.set(ga.x, ga.y + w.a.h / 2, ga.z); pB.set(gb.x, gb.y - w.b.h / 2, gb.z);
    const dy = Math.max(40, (pB.y - pA.y) * .5);
    c1.set(pA.x, pA.y + dy, 0); c2.set(pB.x, pB.y - dy, 0);
  } else if (w.kind === 'loop'){
    pA.set(ga.x, ga.y + w.a.h / 2, ga.z); pB.set(gb.x, gb.y + w.b.h / 2, gb.z);
    const top = graph.userData.H / 2 - 12; // keep the arc on the panel
    const lift = Math.max(70, Math.abs(pB.x - pA.x) * .45);
    c1.set(pA.x, Math.min(pA.y + lift, top), 0); c2.set(pB.x, Math.min(pB.y + lift, top), 0);
  } else {
    pA.set(ga.x + w.a.w / 2, ga.y, ga.z); pB.set(gb.x - w.b.w / 2, gb.y, gb.z);
    const dx = Math.max(60, Math.abs(pB.x - pA.x) * .5);
    c1.set(pA.x + dx, pA.y, 0); c2.set(pB.x - dx, pB.y, 0);
  }
}
const WIRE_COLOR = {assist:0x9b8cff, loop:0xefe7d6};
function buildWires(){
  const byKey = Object.fromEntries(nodeCards.map(c => [c.data.key, c]));
  wires = EDGES.map(([from, to, kind], i) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((WIRE_SEG + 1) * 2 * 3), 3));
    g.setIndex(kind === 'assist' ? dashIndex : wireIndex);
    const color = WIRE_COLOR[kind] || 0xefe7d6;
    const m = new THREE.Mesh(g, mat({color, opacity:.35, side:THREE.DoubleSide}));
    m.renderOrder = 5; m.frustumCulled = false;
    graph.add(m);
    return {a:byKey[from], b:byKey[to], kind, color, mesh:m, glow:0, phase:i * .37};
  });
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wires.length * PULSES_PER_WIRE * 3), 3));
  pulses = new THREE.Points(pg, new THREE.PointsMaterial({map:PULSE_TEX, color:0xefe7d6, size:26, transparent:true, depthTest:false, depthWrite:false, blending:THREE.AdditiveBlending}));
  pulses.renderOrder = 6; pulses.frustumCulled = false;
  graph.add(pulses);
}
const pA = new THREE.Vector3(), pB = new THREE.Vector3(), pt = new THREE.Vector3(), pn = new THREE.Vector3();
function updateWires(t){
  const focus = hovered && hovered.kind === 'node' ? hovered : null;
  const pp = pulses.geometry.attributes.position.array;
  const width = V.mobile ? 2 : 2.6;
  wires.forEach((w, wi) => {
    wireEnds(w);
    const arr = w.mesh.geometry.attributes.position.array;
    for (let i = 0; i <= WIRE_SEG; i++){
      bezier(pA, pB, i / WIRE_SEG, pt);
      bezier(pA, pB, Math.min(1, i / WIRE_SEG + .01), pn);
      let tx = pn.x - pt.x, ty = pn.y - pt.y; const len = Math.hypot(tx, ty) || 1; tx /= len; ty /= len;
      const o = i * 6;
      arr[o] = pt.x - ty * width; arr[o+1] = pt.y + tx * width; arr[o+2] = pt.z;
      arr[o+3] = pt.x + ty * width; arr[o+4] = pt.y - tx * width; arr[o+5] = pt.z;
    }
    w.mesh.geometry.attributes.position.needsUpdate = true;
    const lit = focus && (w.a === focus || w.b === focus) ? 1 : 0;
    w.glow = lerp(w.glow, lit, .2);
    const wv = Math.min(w.a.vis, w.b.vis); // a wire appears once both of its nodes are rendered
    w.mesh.material.opacity = (focus ? .15 + w.glow * .85 : w.kind === 'loop' ? .6 : .35) * (1 - dim * .8) * wv;
    w.mesh.material.color.set(lit ? focus.color : w.color);
    for (let k = 0; k < PULSES_PER_WIRE; k++){
      const tt = reduce ? .5 : (t * .22 + w.phase + k / PULSES_PER_WIRE) % 1;
      bezier(pA, pB, tt, pt);
      const o = (wi * PULSES_PER_WIRE + k) * 3;
      pp[o] = pt.x; pp[o+1] = pt.y; pp[o+2] = wv > .9 ? pt.z + 1 : -1e5; // hidden wires park their pulses behind the far plane
    }
  });
  pulses.geometry.attributes.position.needsUpdate = true;
  pulses.material.opacity = 1 - dim * .9;
}

function drawMat(TW, TH){
  const w = texW(TW), h = Math.round(w * TH / TW), k = w / TW; // k: canvas px per world px
  const tex = canvasTex(w, h, g => {
    g.fillStyle = '#1A1714'; g.fillRect(0, 0, w, h);
    const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * .6);
    rg.addColorStop(0, 'rgba(239,231,214,.09)'); rg.addColorStop(1, 'rgba(239,231,214,0)');
    g.fillStyle = rg; g.fillRect(0, 0, w, h);
    const cell = 28 * k;
    for (let i = 0, x = 0; x < w; i++, x += cell){
      g.fillStyle = i % 5 ? 'rgba(239,231,214,.045)' : 'rgba(239,231,214,.11)'; g.fillRect(x, 0, k, h);
    }
    for (let i = 0, y = 0; y < h; i++, y += cell){
      g.fillStyle = i % 5 ? 'rgba(239,231,214,.045)' : 'rgba(239,231,214,.11)'; g.fillRect(0, y, w, k);
    }
    g.strokeStyle = 'rgba(239,231,214,.1)'; g.lineWidth = k;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(h, h); g.moveTo(w, 0); g.lineTo(w - h, h); g.stroke();
  });
  // ruler numbers and the mat's label are HTML (see surfaceText) so they stay sharp
  const nums = [];
  for (let i = 5; i * 28 < TW; i += 5) nums.push(`<b style="left:${i * 28 + 3}px;top:4px">${i}</b>`);
  for (let i = 5; i * 28 < TH; i += 5) nums.push(`<b style="left:6px;top:${i * 28 - 16}px">${i}</b>`);
  setSurfaceText(tableText, TW, TH, nums.join('') + '<span class="st-label" style="right:24px;bottom:12px">NS · LIGHT TABLE — A1 CUTTING MAT</span>');
  tex.colorSpace = THREE.SRGBColorSpace;
  if (tableMat.map) tableMat.map.dispose();
  tableMat.map = tex; tableMat.needsUpdate = true;
}

/* ============= CAREER SEQUENCE ============= */
// A tilted NLE sequence: ruler + three lanes. One linear time scale from 2022 on, so work clips
// keep their real proportions; the school years before 2022 are squeezed (GAP_SCALE) so the
// university clip comes out about as long as one year of work.
const career = new THREE.Group();
scene.add(career);
career.userData = {W:1, H:1};
const careerMat = mat({alphaMap:ALPHA_SOFT});
const careerMesh = new THREE.Mesh(PLANE, careerMat);
careerMesh.renderOrder = 1;
career.add(careerMesh);

const monthIdx = ([y, m]) => (y - 2018) * 12 + (m - 1);
const GAP_END = monthIdx([2022, 1]), GAP_SCALE = .115; // school years before 2022 shown at ~1/9 of the work-year scale
const END_M = monthIdx(NOW) + 3;
const FIRST_M = Math.min(...CAREER.map(d => monthIdx(d.from)));
const START_M = FIRST_M - 2; // ruler starts just before the first clip
const C = {k:20, padL:120, rulerH:44, laneH:110, SW:1, SH:1}; // k: px per month (after the gap)
const scaled = m => (m < GAP_END ? m * GAP_SCALE : GAP_END * GAP_SCALE + (m - GAP_END)) * C.k; // px from month 0
const monthX = m => -C.SW / 2 + C.padL + 24 + scaled(m) - scaled(START_M);
const xMonth = x => { // inverse of monthX
  const u = x + C.SW / 2 - C.padL - 24 + scaled(START_M), g = GAP_END * GAP_SCALE * C.k;
  return u < g ? u / (C.k * GAP_SCALE) : GAP_END + (u - g) / C.k;
};
const laneY = key => C.SH / 2 - C.rulerH - (LANES.findIndex(l => l.key === key) + .5) * C.laneH;
const clipSpan = d => [monthIdx(d.from), d.to ? monthIdx(d.to) + 1 : monthIdx(NOW) + 1];
const fmtMonth = m => `${String(Math.floor(m) % 12 + 1).padStart(2, '0')}/${2018 + Math.floor(m / 12)}`;

function drawCareerBg(){
  const {SW, SH} = C;
  const w = texW(SW), h = Math.round(w * SH / SW), k = w / SW;
  const X = m => (monthX(m) + SW / 2) * k;
  const tex = canvasTex(w, h, g => {
    g.fillStyle = '#15130F'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1B1814'; g.fillRect(0, 0, w, C.rulerH * k);
    g.fillStyle = '#1B1814'; g.fillRect(0, 0, C.padL * k, h);
    // month ticks + year labels
    for (let m = START_M; m <= END_M; m++){
      const x = X(m), year = m % 12 === 0;
      if (m < GAP_END && !year) continue; // no month ticks inside the squeezed years
      g.fillStyle = year ? 'rgba(239,231,214,.5)' : 'rgba(239,231,214,.14)';
      g.fillRect(x, (C.rulerH - (year ? 18 : 8)) * k, k, (year ? 18 : 8) * k);
      if (year){ g.fillStyle = 'rgba(239,231,214,.06)'; g.fillRect(x, C.rulerH * k, k, h); }
    }
    // squeezed gap marker
    const gx = X(GAP_END);
    g.strokeStyle = 'rgba(239,231,214,.4)'; g.setLineDash([6 * k, 5 * k]); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(gx, C.rulerH * k); g.lineTo(gx, h); g.stroke(); g.setLineDash([]);
    // lanes
    LANES.forEach((l, i) => {
      const y = (C.rulerH + i * C.laneH) * k;
      g.fillStyle = 'rgba(239,231,214,.1)'; g.fillRect(0, y, w, k);
    });
    // "now" marker
    const nx = X(monthIdx(NOW) + 1);
    g.fillStyle = 'rgba(239,231,214,.85)'; g.fillRect(nx, C.rulerH * k, 2 * k, h);
    // cross-dissolve marks where one work clip runs straight into the next
    const work = CAREER.filter(d => d.track === 'work');
    for (let i = 1; i < work.length; i++){
      const a = clipSpan(work[i - 1])[1], b = clipSpan(work[i])[0];
      if (b - a > 1) continue;
      const x = X(b), y = (C.SH / 2 - laneY('work')) * k, s = 12 * k;
      g.fillStyle = 'rgba(239,231,214,.85)';
      g.beginPath(); g.moveTo(x - s, y - s); g.lineTo(x + s, y + s); g.lineTo(x + s, y - s); g.lineTo(x - s, y + s); g.closePath(); g.fill();
    }
  });
  tex.colorSpace = THREE.SRGBColorSpace;
  if (careerMat.map) careerMat.map.dispose();
  careerMat.map = tex; careerMat.needsUpdate = true;
}

// Text on the sequence (years, lane names, NOW, gap note) and the playhead are HTML on top of the
// WebGL grid, so they stay sharp; the canvas texture above only draws lines and ticks.
const careerTextCss = cssObject(Object.assign(document.createElement('div'), {className:'career3d'}));
const playheadCss = cssObject(Object.assign(document.createElement('div'), {className:'ph3d', innerHTML:'<i></i>'}));
function buildCareerOverlay(){
  const {SW, SH} = C, el = careerTextCss.element;
  el.style.width = SW + 'px'; el.style.height = SH + 'px';
  const X = m => monthX(m) + SW / 2; // element x from the sequence's left edge
  const parts = [];
  // the squeezed school years share one label; from 2022 on every year gets its own
  parts.push(`<b class="cy dim" style="left:${X(START_M) + 6}px">2018–2021</b>`);
  for (let m = GAP_END; m <= END_M; m += 12) parts.push(`<b class="cy" style="left:${X(m) + 6}px">${2018 + m / 12}</b>`);
  parts.push(`<em class="cgap" style="left:${X(GAP_END) - 6}px">// nén</em>`);
  parts.push(`<em class="cnow" style="left:${X(monthIdx(NOW) + 1) + 8}px">NOW</em>`);
  LANES.forEach((l, i) => parts.push(`<span class="clane" style="top:${C.rulerH + i * C.laneH}px;height:${C.laneH}px">${l.label}</span>`));
  el.innerHTML = parts.join('');
  el.style.setProperty('--ruler', C.rulerH + 'px');
  playheadCss.element.style.height = SH + 'px';
}

/* ============= CLAPPERBOARD ============= */
// The only solid model in the scene: real boxes with depth testing (nothing overlaps it).
const clap = new THREE.Group();
scene.add(clap);
const clapPivot = new THREE.Group(); // hinge at the left end of the clapstick
clap.add(clapPivot);
const CLAP_W = 640, CLAP_H = 480, CLAP_D = 22, STICK_H = 78; // texture/model units; scaled by layout
const side = new THREE.MeshBasicMaterial({color:0x2a2520});
const sideDark = new THREE.MeshBasicMaterial({color:0x1a1714});
function stripesTex(){
  const t = canvasTex(1024, 128, (g, w, h) => {
    g.fillStyle = '#EFE7D6'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#14110C';
    for (let x = -h; x < w + h; x += 128){ g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 64, 0); g.lineTo(x + 64 - h, h); g.lineTo(x - h, h); g.closePath(); g.fill(); }
    g.fillStyle = '#9E9480'; g.fillRect(0, h - 10, w, 10);
  });
  t.colorSpace = THREE.SRGBColorSpace; return t;
}
const slateMat = new THREE.MeshBasicMaterial({color:0x1b1814});
const STRIPES = stripesTex();
const stripeMat = new THREE.MeshBasicMaterial({map:STRIPES});
const board = new THREE.Mesh(new THREE.BoxGeometry(CLAP_W, CLAP_H, CLAP_D), [side, side, side, sideDark, slateMat, sideDark]);
const lowerStick = new THREE.Mesh(new THREE.BoxGeometry(CLAP_W, STICK_H, CLAP_D), [side, side, side, sideDark, stripeMat, sideDark]);
lowerStick.position.y = CLAP_H / 2 + STICK_H / 2;
const upperStick = new THREE.Mesh(new THREE.BoxGeometry(CLAP_W, STICK_H, CLAP_D), [side, side, side, sideDark, stripeMat, sideDark]);
upperStick.position.set(CLAP_W / 2, STICK_H / 2, 0);
clapPivot.position.set(-CLAP_W / 2, CLAP_H / 2 + STICK_H, 0);
clapPivot.add(upperStick);
clap.add(board, lowerStick);
const clapMeshes = [board, lowerStick, upperStick];
clapMeshes.forEach(m => { m.renderOrder = 4; m.userData.clap = true; });
const clapState = {open:.32, hover:0, busy:false};

// The slate face is HTML (crisp text), laid out on a 1280×960 board and pinned onto the box's
// front face every frame. Coordinates match the old canvas drawing.
const SLATE_W = CLAP_W * 2, SLATE_H = CLAP_H * 2;
function buildSlate(){
  const el = document.createElement('div');
  el.className = 'slate3d';
  el.style.width = SLATE_W + 'px'; el.style.height = SLATE_H + 'px';
  const rows = [0, .3, .56, .8, 1].map(f => 24 + f * (SLATE_H - 48));
  const line = (x, y, w, h) => `<i style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"></i>`;
  const cell = (label, value, x, y, size, accent) =>
    `<div class="sl-cell" style="left:${x}px;top:${y}px"><small>${label}</small><b style="font-size:${size}px${accent ? ';color:#FFFFFF' : ''}">${value}</b></div>`;
  const W = SLATE_W;
  el.innerHTML = [
    ...rows.map(y => line(24, y - 1.5, W - 48, 3)),
    line(22.5, rows[0], 3, rows[4] - rows[0]), line(W - 25.5, rows[0], 3, rows[4] - rows[0]),
    line(W / 3 - 1.5, rows[1], 3, rows[2] - rows[1]), line(W * 2 / 3 - 1.5, rows[1], 3, rows[2] - rows[1]),
    line(W / 2 - 1.5, rows[2], 3, rows[4] - rows[2]),
    cell('PROD.', 'NGUYỄN SƠN — PORTFOLIO 2026', 48, rows[0] + 18, 60),
    cell('SCENE', '05', 48, rows[1] + 18, 80, true),
    cell('TAKE', '01', W / 3 + 24, rows[1] + 18, 80),
    cell('ROLL', 'A', W * 2 / 3 + 24, rows[1] + 18, 80),
    cell('DIRECTOR', 'Bạn?', 48, rows[2] + 18, 54),
    cell('CAMERA', 'Visual · Video · AI', W / 2 + 24, rows[2] + 18, 40),
    cell('DATE', new Date().toLocaleDateString('vi-VN'), 48, rows[3] + 18, 44),
    cell('BASE', 'Tây Hồ, Hà Nội', W / 2 + 24, rows[3] + 18, 44),
  ].join('');
  return cssObject(el);
}
const slateCss = buildSlate();
function clapAction(){
  if (clapState.busy) return;
  clapState.busy = true;
  const d = reduce ? 0 : 1;
  gsap.timeline({onComplete:() => { clapState.busy = false; }})
    .to(clapState, {open:.75, duration:.25 * d, ease:'power2.out'})
    .to(clapState, {open:0, duration:.12 * d, ease:'power4.in'})
    .add(() => {
      if (!reduce) gsap.fromTo('#flash', {opacity:.55}, {opacity:0, duration:.5});
      if (!reduce) gsap.fromTo(clap.position, {y:clap.position.y - 10}, {y:clap.position.y, duration:.4, ease:'elastic.out(1,.4)'});
      toast('ACTION! — Scene 05, take 01');
    })
    .to(clapState, {open:.32, duration:.6 * d, ease:'power2.inOut', delay:.25 * d});
}

/* ============= CARD ============= */
// kind: 'video' (reel grid + intro deck), 'print' / 'note' (on the light table), 'node' (on the AI graph)
// Cards with a surface live in that group's local space and can be dragged across it.
let loaded = 0, bootTotal = Infinity, booted = false; // bootTotal is set once all cards exist
const NODE_TEX_W = 480, NOTE_W = 320; // logical widths of the HTML node and note faces
class Card {
  constructor(o){
    Object.assign(this, {kind:o.kind, title:o.title, label:o.label, index:o.index ?? 0, deckSlot:o.deckSlot ?? -1, data:o.data});
    this.surface = o.surface || null;
    this.onSurface = !!this.surface;
    this.static = !!o.static; // on a surface but pinned in place (career clips sit at their dates)
    this.color = new THREE.Color(o.color);
    this.group = new THREE.Group();
    this.inner = new THREE.Group();
    this.group.add(this.inner);
    const alpha = this.onSurface ? ALPHA_SOFT : ALPHA;

    this.matShadow = mat({map:SHADOW, opacity:.55});
    this.shadow = new THREE.Mesh(PLANE, this.matShadow);
    this.group.add(this.shadow);

    this.matGlow = mat({color:this.color, alphaMap:o.kind === 'node' ? ALPHA_NODE : alpha, opacity:0});
    this.glow = new THREE.Mesh(PLANE, this.matGlow);
    this.inner.add(this.glow);



    // Every card face is HTML that CSS3DRenderer draws over the canvas (images and text stay
    // crisp at any tilt). The WebGL mesh stays, invisible, for hit-testing and draw order;
    // glow, shadow and the flip side of reel cards are still WebGL underneath.
    this.matFront = mat({});
    this.matFront.visible = false;
    this.front = new THREE.Mesh(PLANE, this.matFront);
    this.front.userData.card = this;
    this.inner.add(this.front);
    this.css = cssObject(
      o.kind === 'node' ? this.buildNodeEl() : o.kind === 'clip' ? this.buildClipEl()
      : o.kind === 'note' ? this.buildNoteEl() : o.kind === 'print' ? this.buildPrintEl(o) : this.buildVideoEl(o));
    this.parts = [this.shadow, this.glow, this.front];

    this.base = {x:0, y:0, rot:o.rot || 0};
    this.home = {x:0, y:0};
    this.frac = {fx:o.fx || 0, fy:o.fy || 0};
    this.vis = 0; this.hover = 0; this.flash = 0; this.lift = 0; this.fade = 0;
    this.tilt = {x:0, y:0, tx:0, ty:0};
    this.shown = true;
    this.aspect = o.aspect || (o.kind === 'video' ? .75 : (o.kind === 'note' ? 1 : 1.3));
    this.w = 1; this.h = 1;
    (this.surface || scene).add(this.group);
  }
  // <img> with retries. Cloudinary builds a new thumbnail size on first request and can refuse
  // some when many arrive at once; retry, then fall back to a size the old site already generated.
  loadImg(img, sources, onload){
    let attempt = 0;
    img.onload = () => { img.onload = img.onerror = null; if (onload) onload(img); bootTick(); };
    img.onerror = () => {
      if (++attempt < sources.length) setTimeout(() => { img.src = sources[attempt]; }, 900 * attempt);
      else { img.onload = img.onerror = null; bootTick(); }
    };
    img.src = sources[0];
  }
  buildVideoEl(o){
    const d = this.data, el = document.createElement('div');
    el.className = 'vcard3d';
    el.style.setProperty('--c', CATS[d.cat].color);
    const img = this.img = new Image();
    img.alt = ''; img.decoding = 'async';
    el.append(img);
    this.loadImg(img, [o.thumb, o.thumb, o.thumbFallback].filter(Boolean)); // object-fit crops the uncropped fallback
    if (this.deckSlot < 0){ // name bar along the bottom edge of reel cards
      // date: month/year set in videos.json ("T10/26"); ids only carry day.month, the year came from upload dates
      // it sits as a badge on the thumbnail so the name bar keeps its width for the title
      el.insertAdjacentHTML('beforeend', `${d.date ? `<span class="vdate">${d.date}</span>` : ''}<div class="vbar"><b>${this.title}</b></div>`);
    }
    return el;
  }
  buildPrintEl(o){
    const el = document.createElement('div');
    el.className = 'print3d';
    el.style.setProperty('--tape', ((Math.random() - .5) * 16).toFixed(1) + 'deg');
    const img = new Image();
    img.alt = this.title; img.decoding = 'async';
    el.append(img);
    this.loadImg(img, [o.thumb], i => { this.aspect = clamp(i.naturalWidth / i.naturalHeight, .6, 1.8); this.setSize(this.h); });
    return el;
  }
  buildNoteEl(){ // laid out at NOTE_W × NOTE_W px and scaled down to the note's size
    const n = this.data, el = document.createElement('div');
    el.className = 'note3d';
    el.style.width = el.style.height = NOTE_W + 'px';
    el.style.setProperty('--c', n.color);
    el.style.setProperty('--ink-on', n.color === '#D97757' ? '#fff' : '#14110C');
    el.style.setProperty('--tape', ((Math.random() - .5) * 16).toFixed(1) + 'deg');
    el.innerHTML = `<small>NOTE</small><b>${n.lines.join('<br>')}</b>`;
    return el;
  }
  setSize(h){
    this.h = h; this.w = h * this.aspect;
    const {w} = this;
    this.front.scale.set(w, h, 1);
    this.glow.scale.set(w + 8, h + 8, 1);
    const s = this.css.element.style;
    if (this.kind === 'print'){ // white photo-paper border around the image
      const b = Math.max(8, h * .04);
      this.glow.scale.set(w + b * 2 + 8, h + b * 2 + 8, 1);
      s.width = w + 'px'; s.height = h + 'px'; s.setProperty('--paper', b + 'px');
    } else if (this.kind !== 'node' && this.kind !== 'note'){ s.width = w + 'px'; s.height = h + 'px'; } // node/note: fixed layout, scaled in syncCss
    if (this.kind === 'video') s.setProperty('--bar', Math.max(30, Math.round(h * .16)) + 'px');
    // node face is inset 12px per side (of 480) so its ports can overhang; the glow hugs the body
    if (this.kind === 'node') this.glow.scale.set(w * (456 / NODE_TEX_W) + 10, h + 10, 1);
    if (this.kind === 'clip') this.shadow.scale.set(w + 40, h * 1.4, 1);
    else this.shadow.scale.set(w * 1.5, h * 1.25, 1);
  }
  setOrder(n){ this.rank = n; this.parts.forEach((m, i) => m.renderOrder = 10 + n * 8 + i); }
  // Career clip face as HTML (stays crisp at the sequence's tilt); sized to the clip in layout()
  buildClipEl(){
    const d = this.data;
    const el = document.createElement('div');
    el.className = 'clip3d';
    el.style.setProperty('--c', d.color);
    el.innerHTML = `<small>${d.tag.toUpperCase()}${d.to ? '' : '<em>● ĐANG CHẠY</em>'}</small><b>${d.short || d.title}</b><span>${d.when}</span>`; // short: the clip is narrower than the monitor
    return el;
  }
  // Node face as HTML, NODE_TEX_W px wide (ports overhang a 12px inset on each side).
  buildNodeEl(){
    const n = this.data;
    const darkText = ['#EFE7D6', '#E3B341', '#6FBF8E', '#5FB3D9'].includes(n.color);
    const el = document.createElement('div');
    el.className = 'node3d' + (n.solid ? ' solid' : '');
    el.style.width = NODE_TEX_W + 'px'; el.style.height = nodeTexH(n) + 'px';
    el.style.setProperty('--c', n.color);
    el.style.setProperty('--on-c', darkText ? '#14110C' : '#fff');
    el.innerHTML = `<div class="nd-body">
        <header><small>${n.tag || 'N' + String(this.index + 1).padStart(2, '0')}</small><b>${n.title}</b></header>
        <ul>${n.lines.map(l => { // "Label|value" lines get a label column, so a device is not read as a job type
          const [k, v] = l.split('|');
          return v === undefined ? `<li>${l}</li>` : `<li class="kv"><small>${k}</small>${v}</li>`;
        }).join('')}</ul>
      </div><i class="nd-port in"></i><i class="nd-port out"></i>${n.generate ? '<span class="nd-gen">▶ Generate</span>' : ''}`;
    return el;
  }
  play(){
    if (this.kind !== 'video') return;
    if (!this.video){ // preview plays in a real <video> over the thumbnail, shown once frames arrive
      const el = document.createElement('video');
      el.muted = true; el.setAttribute('muted', ''); el.loop = true; el.playsInline = true; el.preload = 'auto';
      el.src = previewURL(this.data.id);
      el.addEventListener('playing', () => this.css.element.classList.add('playing'), {once:true});
      this.img.after(el);
      this.video = el;
    }
    this.video.play().catch(() => {});
  }
  pause(){ if (this.video && !this.video.paused) this.video.pause(); }

  // resting pose for this frame (before hover); table cards are in the table's local space
  pose(t){
    if (this.onSurface) return {x:this.base.x, y:this.base.y, z:0, ry:0, rz:this.base.rot};
    if (this.deckSlot >= 0){
      const k = this.deckSlot - 2;
      const par = -scroll * .25; // deck leaves faster than the page -> foreground parallax
      const spread = V.mobile ? .3 : .32;
      return {
        x: L.deckX + k * this.w * spread + par + mouseN.x * 14 * (k + 3),
        y: L.deckY - Math.abs(k) * 14 + Math.sin(t * .9 + k) * 6 - mouseN.y * 10,
        z: -Math.abs(k) * 50 + (k === 0 ? 30 : 0) + Math.min(scroll, V.w) * .15,
        ry: -k * .12 + mouseN.x * .18,
        rz: -k * .07,
      };
    }
    const {z, ry} = reelCurve(this.base.x);
    return {x:this.base.x, y:this.base.y, z, ry, rz:0};
  }
  update(t){
    const on = this === hovered ? 1 : 0;
    this.hover = lerp(this.hover, on, .22);
    this.tilt.x = lerp(this.tilt.x, this.tilt.tx * on, .3);
    this.tilt.y = lerp(this.tilt.y, this.tilt.ty * on, .3);
    this.flash *= .96;
    const carried = cardDrag && cardDrag.card === this && cardDrag.moved;
    this.lift = lerp(this.lift, carried ? 1 : 0, .18);
    // others dim while the viewer is open; the opened card hides, the viewer frame stands in for it
    this.fade = viewing === this && vwFrame.classList.contains('shown') ? 1 : 0;
    const op = viewing && viewing !== this ? 1 - dim * .88 : 1 - this.fade;
    this.matFront.opacity = op;
    this.op = op;
    this.matShadow.opacity = (.55 - this.lift * .2) * op;
    this.matGlow.opacity = Math.max(this.hover * .9, this.flash) * op;

    this.group.visible = this.vis > .01;
    const p = this.pose(t);
    // The deck's cards overlap, and HTML faces in one 3D space get sliced where planes cross.
    // So a hovered deck card does not tilt: it turns square to the camera and pops well clear
    // of its neighbours (they sit within ±100 of z=0 and turn at most ±.24 rad).
    const inDeck = this.deckSlot >= 0;
    const up = this.onSurface ? this.hover * 30 + this.lift * 150 : this.hover * (inDeck ? 160 : 90);
    this.group.position.set(p.x, p.y, p.z + up);
    this.group.rotation.set(0, p.ry * (inDeck ? 1 - this.hover : 1), p.rz * (1 - this.hover * (this.onSurface ? .5 : 1)));
    const tk = this.kind === 'clip' ? .15 : inDeck ? 0 : 1; // long clips would swing far out of the lane
    this.inner.rotation.set(-this.tilt.y * .35 * tk, this.tilt.x * .45 * tk, 0);
    // table cards: the shadow stays on the mat and spreads as the card is lifted
    if (this.onSurface) this.shadow.position.set(up * .12, -this.h * .05 - up * .2, -up);
    else this.shadow.position.set(0, -this.h * .06, -60);
    const s = this.vis * (1 + (this.kind === 'clip' ? 0 : this.flash * .06)); // clips must keep their date span
    this.group.scale.setScalar(Math.max(s, .0001));
  }
  // draw order: whatever is lifted, hovered or opened goes on top
  sortKey(){
    const top = (this === viewing ? 3e6 : 0) + (cardDrag && cardDrag.card === this ? 2e6 : 0) + (this === hovered ? 1e6 : 0);
    return top + (this.onSurface ? 1e4 + this.stack : this.group.position.z);
  }
}
// the reel bends away from the camera toward the screen edges, like the inside of a drum
function reelCurve(x){
  const dx = (x - scroll - V.w / 2) / V.w;
  const dz = clamp(dx, -1.5, 1.5); // past the screen edge the drum stops bending, so far cards do not sink toward the vanishing point
  return {z:reduce ? 0 : -dz * dz * 480, ry:reduce ? 0 : clamp(-dx * .55 + vel * .0012, -.9, .9)};
}

const BIN_LABEL_H = 30, BIN_LABEL_W = 260;
// shared by layout() and the thumbnail request (which happens before the first layout)
const gridRows = avail => avail > 560 ? 3 : 2;
const gridCardH = (avail, mobile) => Math.min((avail - 70 - BIN_LABEL_H - (mobile ? 12 : 18) * (gridRows(avail) - 1)) / gridRows(avail), 230);
const deckCardH = (avail, w, mobile) => mobile ? Math.min(avail * (avail < 560 ? .26 : .3), 220) : // short phones: a smaller deck leaves the copy its size
   Math.min(avail * .74, 520, w * .28);
// How far the fanned deck reaches above / below its centre, in px for card height h. The middle card
// sits nearer the camera (~4% bigger); the outer ones drop 28px, tilt 0.14 rad and bob 6px (see pose()).
const deckUp = h => h * .53 + 8;
const deckDown = h => h * .56 + 24;
// Thumbnails are requested at the size they will be drawn at (in screen pixels), so they stay crisp
// without mipmaps. Viewport is not measured yet here, so read it directly.
// a few fixed sizes, so visitors share thumbnails Cloudinary has already generated
const thumbPx = cssH => [480, 720, 960, 1280].find(b => b >= cssH * PR) || 1280;
const vw0 = innerWidth || screen.availWidth, vh0 = innerHeight || screen.availHeight; // background tabs report 0×0
const startAvail = vh0 - (vw0 < 720 ? 56 + 104 : 64 + 132);
const GRID_THUMB = thumbPx(gridCardH(startAvail, vw0 < 720));
const DECK_THUMB = thumbPx(deckCardH(startAvail, vw0, vw0 < 720));
const videoOpts = (v, i, slot) => ({kind:'video', title:v.title, label:CATS[v.cat].label, color:CATS[v.cat].color, thumb:thumbURL(v.id, slot >= 0 ? DECK_THUMB : GRID_THUMB), thumbFallback:fallbackThumbURL(v.id), index:i, deckSlot:slot, data:v});
const gridCards = VIDEOS.map((v, i) => new Card(videoOpts(v, i)));
const deckCards = DECK_IDS.map((vi, slot) => new Card(videoOpts(VIDEOS[vi], vi, slot)));
const printCards = DESIGNS.map((d, i) => new Card({kind:'print', surface:table, title:d.title, label:d.label, color:'#EFE7D6', thumb:d.img, index:i, data:d, fx:d.fx, fy:d.fy, rot:d.rot}));
const noteCards = NOTES.map((n, i) => new Card({kind:'note', surface:table, title:n.url ? 'Behance' : 'Note', label:'Note', color:n.color, index:i, data:n, fx:n.fx, fy:n.fy, rot:n.rot}));
const nodeTexH = n => 96 + n.lines.length * 42 + 22;
const nodeCards = NODES.map((n, i) => new Card({kind:'node', surface:graph, title:n.title, label:n.lines.length + ' tools', color:n.color, index:i, data:n, fx:n.fx, fy:n.fy, aspect:NODE_TEX_W / nodeTexH(n)}));
const careerCards = CAREER.map((d, i) => new Card({kind:'clip', surface:career, static:true, title:d.title, label:d.when, color:d.color, index:i, data:d}));
const surfaceCards = [...printCards, ...noteCards, ...nodeCards, ...careerCards];
surfaceCards.forEach((c, i) => { c.stack = i; c.vis = 1; });

/* ============= WORKFLOW GENERATE ============= */
// The workflow graph opens on the Brief alone; "Generate" (above it) renders the rest: a scan line sweeps the panel
// while the nodes pop in left to right, each wire appearing once both of its ends are in.
const briefCard = nodeCards.find(c => c.data.generate);
const genEl = briefCard ? briefCard.css.element.querySelector('.nd-gen') : null;
let wfState = 'idle', genHovered = false;
if (briefCard) nodeCards.forEach(c => { if (c !== briefCard) c.vis = 0; });
function genUnderPointer(){
  if (!genEl || !briefCard.group.visible) return false;
  const r = genEl.getBoundingClientRect();
  return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
}
function generate(){
  if (!genEl || wfState === 'rendering') return;
  const opening = wfState === 'idle';
  wfState = 'rendering';
  if (opening) layout(); // widen the panel to the full graph; the chapters after it move right
  genEl.classList.add('busy'); genEl.classList.remove('done');
  const rest = nodeCards.filter(c => c !== briefCard).sort((a, b) => a.base.x - b.base.x);
  rest.forEach(c => { gsap.killTweensOf(c); c.vis = 0; });
  const scan = graphText.element.querySelector('.st-scan');
  const dur = reduce ? 0 : 2.2, prog = {p:0};
  genEl.classList.remove('hot'); genEl.textContent = 'Rendering 0%';
  if (scan) scan.style.opacity = reduce ? 0 : 1;
  // scan line and counter run on the same clock as the node pops, so they stay in step on a slow device
  gsap.to(prog, {p:100, duration:dur, ease:'none', onUpdate:() => {
    genEl.textContent = 'Rendering ' + Math.round(prog.p) + '%';
    if (scan) scan.style.left = prog.p + '%';
  }});
  rest.forEach((c, i) => {
    const at = reduce ? 0 : .25 + i / rest.length * (dur - .5); // roughly when the scan line passes the node
    gsap.to(c, {vis:1, duration:reduce ? 0 : .55, delay:at, ease:'back.out(1.7)', onStart:() => { c.flash = 1; }});
  });
  gsap.delayedCall(dur + .3, () => {
    wfState = 'done';
    genEl.classList.remove('busy'); genEl.classList.add('done');
    genEl.textContent = '↻ Render lại';
    if (scan){ scan.style.opacity = 0; scan.style.left = '0%'; }
  });
}
stackTop = surfaceCards.length;
const allCards = [...deckCards, ...gridCards, ...surfaceCards];
buildWires();

/* ============= DUST ============= */
let dust;
function buildDust(){
  if (dust){ scene.remove(dust); dust.geometry.dispose(); }
  const n = 1100, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++){
    pos[i*3]   = -V.w + Math.random() * (L.worldEnd + V.w * 2);
    pos[i*3+1] = (Math.random() - .5) * V.h * 2.2;
    pos[i*3+2] = -200 - Math.random() * 1800;
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dust = new THREE.Points(g, new THREE.PointsMaterial({color:0xefe7d6, size:2.4, transparent:true, opacity:.35, depthWrite:false}));
  dust.renderOrder = 0;
  scene.add(dust);
}

/* ============= LAYOUT ============= */
const track = $('#track');
const elIntro = $('#intro'), elVHead = $('#vhead'), elDHead = $('#dhead'), elAHead = $('#ahead'), elCHead = $('#chead'), elOHead = $('#ohead'), elContact = $('#contact-scene'), elClapCap = $('#clap-caption'), elClapEnd = $('#clap-end'), elCaption = $('#deck-caption');

function measureViewport(){
  // use the size the page is actually laid out at: on iOS innerHeight can include the
  // area behind the browser bars, which shifts every 3D card down against the HTML
  V.w = canvas.clientWidth || innerWidth; V.h = canvas.clientHeight || innerHeight; V.mobile = V.w < 720;
  V.hud = V.mobile ? 56 : 64; V.tl = V.mobile ? 104 : 132;
  V.avail = V.h - V.hud - V.tl;
  V.cy = (V.hud + V.h - V.tl) / 2;
  V.y0 = V.h / 2 - V.cy;
  V.D = (V.h / 2) / Math.tan(FOV_HALF); // at z=0, 1 world unit == 1 CSS px
  renderer.setSize(V.w, V.h, false);
  cssRenderer.setSize(V.w, V.h);
  camera.aspect = V.w / V.h;
  camera.position.z = V.D;
  camera.near = 10; camera.far = V.D + 4000;
  camera.updateProjectionMatrix();
  scene.fog.near = V.D + 300; scene.fog.far = V.D + 2400;
}

// Under "Tất cả" each bin shows one column of its newest clips, with a tall thin "+N" strip
// beside it; a bin opens in full when the strip is pressed, or when its filter is picked.
const expandedBins = new Set();
const clipKey = c => { // newest first: year and month from date ("T10/26"), day from the id ("13.10-…")
  const m = (c.data.date || '').match(/T(\d+)\/(\d+)/), day = +(c.data.id.match(/^(\d{1,2})\./) || [])[1] || 0;
  return m ? +m[2] * 10000 + +m[1] * 100 + day : -1;
};
function binCards(cat){
  const all = gridCards.filter(c => c.data.cat === cat).sort((a, b) => clipKey(b) - clipKey(a));
  const cap = gridRows(V.avail);
  if (filter !== 'all' || all.length <= cap) return {cards:all, more:0};
  return expandedBins.has(cat) ? {cards:all, more:-1} : {cards:all.slice(0, cap), more:all.length - cap}; // more -1: show "Thu gọn"
}
function visibleCards(){ return Object.keys(CATS).filter(cat => filter === 'all' || cat === filter).flatMap(cat => binCards(cat).cards); }

/* ============= REEL BINS ============= */
// One HTML label per category above its group of cards; it rides the same drum curve as the cards.
const bins = Object.entries(CATS).map(([cat, info]) => {
  const el = document.createElement('div');
  el.className = 'bin3d';
  el.style.width = BIN_LABEL_W + 'px'; el.style.height = BIN_LABEL_H + 'px';
  el.style.setProperty('--c', info.color);
  const b = {cat, info, css:cssObject(el), anchor:new THREE.Object3D(), base:{x:0, y:0}, home:{x:0, y:0}, vis:0, drawnFor:-1};
  b.drawLabel = n => {
    if (n === b.drawnFor) return;
    b.drawnFor = n;
    el.innerHTML = `<i></i><b>${info.label.toUpperCase()}</b><span>· ${n} clip</span>`;
  };
  // the expand / collapse tile, sized like a card and sitting in the bin's next free slot
  const mel = document.createElement('div');
  mel.className = 'more3d';
  mel.style.setProperty('--c', info.color);
  b.more = {el:mel, css:cssObject(mel), anchor:new THREE.Object3D(), base:{x:0, y:0}, vis:0, n:0};
  return b;
});
let moreHovered = null; // the bin whose tile is under the pointer
function moreUnderPointer(){
  return bins.find(b => {
    if (b.more.vis < .5 || !b.more.css.visible) return false;
    const r = b.more.el.getBoundingClientRect();
    return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
  }) || null;
}
function toggleBin(b){
  if (expandedBins.has(b.cat)) expandedBins.delete(b.cat); else expandedBins.add(b.cat);
  moreHovered = null;
  layout(true);
}
function updateBins(){
  bins.forEach(b => {
    const m = b.more;
    m.css.visible = m.vis > .01 && onScreen(m.base.x, L.cardW);
    const mz = reelCurve(m.base.x);
    m.anchor.position.set(m.base.x, m.base.y, mz.z);
    m.anchor.rotation.set(0, mz.ry, 0);
    m.anchor.updateMatrixWorld();
    pinCss(m.css, m.anchor.matrixWorld, 1);
    m.el.style.opacity = m.vis * (viewing ? 1 - dim * .88 : 1);
    m.el.classList.toggle('hot', moreHovered === b);
  });
  bins.forEach(b => {
    b.css.visible = b.vis > .01 && onScreen(b.base.x + BIN_LABEL_W / 2, BIN_LABEL_W);
    const x = b.base.x + BIN_LABEL_W / 2; // label is left-aligned with the bin's first column
    const {z, ry} = reelCurve(x);
    b.anchor.position.set(x, b.base.y, z);
    b.anchor.rotation.set(0, ry, 0);
    b.anchor.updateMatrixWorld();
    pinCss(b.css, b.anchor.matrixWorld, 1);
    b.css.element.style.opacity = b.vis * (viewing ? 1 - dim * .88 : 1);
  });
}

function layout(animate){
  const m = V.mobile;
  // intro: deck sits right of the copy on desktop, below it on mobile
  elIntro.style.left = '0px'; elIntro.style.width = V.w + 'px';
  // fanned deck spans ~2.2 card widths; keep it inside the right ~46% so it never covers the copy
  const deckH = deckCardH(V.avail, V.w, m);
  L.deckX = m ? V.w * .5 : V.w * .73;
  // mobile: deck sits on the bottom edge of the content area, under the copy
  L.deckH = L.deckBase = deckH; // mobile: placeDeck may grow it into the space the copy leaves
  L.deckY = m ? V.h / 2 - (V.h - V.tl - deckH / 2 - 28) : V.y0 + 10;
  deckCards.forEach(c => c.setSize(deckH));
  elCaption.style.left = L.deckX + 'px';
  elCaption.style.top = (V.h / 2 - L.deckY + deckH / 2 + 34 - V.hud) + 'px';
  // on mobile placeDeck moves it under the deck; it is the only swipe cue there (the intro hint is hidden)
  // mobile: the copy ends above the deck (fitScenes shrinks it if it does not fit)
  if (m){ elIntro.style.justifyContent = 'flex-start'; elIntro.style.paddingTop = '24px'; elIntro.style.paddingBottom = (deckUp(deckH) + deckDown(deckH) + 22 + 16) + 'px'; } // fan + caption + margins
  else { elIntro.style.justifyContent = ''; elIntro.style.paddingTop = ''; elIntro.style.paddingBottom = ''; }

  // video chapter header
  const pad = m ? 20 : 80;
  const headW = m ? V.w - 40 : Math.min(480, V.w * .36);
  L.videoStart = V.w;
  const vheadX = V.w + pad;
  elVHead.style.left = vheadX + 'px'; elVHead.style.width = headW + 'px';

  // card grid: aligned rows, grouped into one bin per category with a label on top,
  // so the reel reads section by section instead of as one long wall
  const rows = L.rows = gridRows(V.avail);
  L.gap = m ? 12 : 18;
  L.cardH = gridCardH(V.avail, m);
  L.cardW = L.cardH * .75;
  const step = L.cardW + L.gap, binGap = m ? 44 : 80;
  const blockTop = V.y0 + (BIN_LABEL_H + rows * L.cardH + (rows - 1) * L.gap) / 2;
  const list = visibleCards();
  let xLeft = vheadX + headW + (m ? 40 : 90), lastX = xLeft, j = 0;
  bins.forEach(b => {
    const inBin = list.filter(c => c.data.cat === b.cat);
    const show = inBin.length > 0;
    const {more} = show ? binCards(b.cat) : {more:0};
    if (show){
      b.home = {x:xLeft, y:blockTop - BIN_LABEL_H / 2 + 2};
      b.drawLabel(gridCards.filter(c => c.data.cat === b.cat).length);
      if (animate && !reduce && b.vis > .05) gsap.to(b.base, {x:b.home.x, y:b.home.y, duration:.9, ease:'power3.inOut'});
      else { b.base.x = b.home.x; b.base.y = b.home.y; }
    }
    if (animate && !reduce) gsap.to(b, {vis:show ? 1 : 0, duration:.5}); else b.vis = show ? 1 : 0;
    inBin.forEach((c, k) => {
      const col = Math.floor(k / rows), row = k % rows;
      const x = xLeft + L.cardW / 2 + col * step;
      const y = blockTop - BIN_LABEL_H - L.cardH / 2 - row * (L.cardH + L.gap);
      lastX = Math.max(lastX, x);
      c.home = {x, y}; // final slot; base may still be tweening towards it
      c.slot = (row - (rows - 1) / 2) * step / rows; // spreads a column's cards along the bottom timeline
      c.setSize(L.cardH);
      const delay = .15 + j++ * .012;
      if (animate && !reduce){
        const fresh = c.vis < .05;
        if (fresh){ c.base.x = x; c.base.y = y - 60; }
        gsap.to(c.base, {x, y, duration:fresh ? .7 : .9, ease:'power3.inOut', delay:fresh ? delay : 0});
        gsap.to(c, {vis:1, duration:.6, delay:fresh ? delay : 0, ease:'power2.out'});
      } else { c.base.x = x; c.base.y = y; if (animate || c.shown) c.vis = 1; }
      c.shown = true;
    });
    // expand / collapse strip: a narrow column as tall as the bin, after its last column of cards
    const m = b.more, cols = Math.ceil(inBin.length / rows), hasTile = more !== 0;
    const tileW = Math.max(40, L.cardW * .26), tileH = rows * L.cardH + (rows - 1) * L.gap;
    if (hasTile){
      const x = xLeft + cols * step + tileW / 2;
      const y = blockTop - BIN_LABEL_H - tileH / 2;
      lastX = Math.max(lastX, x + tileW / 2 - L.cardW / 2); // lastX is a card centre: keep its right edge in step
      m.el.style.width = tileW + 'px'; m.el.style.height = tileH + 'px';
      m.el.innerHTML = more > 0 ? `<b>+${more}</b>` : `<b>←</b>`; // the strip carries just the count; hover names it
      if (animate && !reduce && m.vis > .05) gsap.to(m.base, {x, y, duration:.9, ease:'power3.inOut'});
      else { m.base.x = x; m.base.y = y; }
    }
    if (animate && !reduce) gsap.to(m, {vis:hasTile ? 1 : 0, duration:.4}); else m.vis = hasTile ? 1 : 0;
    if (show) xLeft += cols * step + (hasTile ? tileW + L.gap : 0) - L.gap + binGap;
  });
  gridCards.filter(c => !list.includes(c)).forEach(c => {
    c.shown = false;
    if (animate && !reduce) gsap.to(c, {vis:0, duration:.4, ease:'power2.in'}); else c.vis = 0;
  });

  // design chapter: header, then the tilted light table
  const chGap = m ? 60 : 130; // space between chapters
  L.dheadX = lastX + L.cardW / 2 + chGap;
  elDHead.style.left = L.dheadX + 'px'; elDHead.style.width = headW + 'px';
  L.TW = m ? V.w * 1.25 : clamp(V.w * .62, 760, 1000); // narrow table: prints stacked in two columns
  L.TH = V.avail * (m ? .85 : 1);
  L.tableX = L.dheadX + headW + (m ? 40 : 60) + L.TW / 2;
  table.position.set(L.tableX, V.y0 + (m ? 0 : 10), -60);
  table.rotation.set(m ? -.3 : -.48, 0, 0);
  tableMesh.scale.set(L.TW, L.TH, 1);
  drawMat(L.TW, L.TH);
  const printH = L.TH * .17, noteH = L.TH * .12; // small, with clear table between the prints
  table.userData = {W:L.TW, H:L.TH};
  [...printCards, ...noteCards].forEach(c => {
    c.setSize(c.kind === 'print' ? printH : noteH);
    c.base.x = c.frac.fx * L.TW; c.base.y = c.frac.fy * L.TH;
  });

  // AI chapter: header, then the node graph (wide enough that node text stays readable)
  L.aheadX = L.tableX + L.TW / 2 + chGap;
  elAHead.style.left = L.aheadX + 'px'; elAHead.style.width = (m ? V.w - 40 : Math.max(headW, 440)) + 'px';
  L.GW = m ? 1050 : clamp(V.w * 1.25, 1600, 2000); // narrower, but the staggered nodes still breathe
  L.GH = V.avail * (m ? .86 : .94);
  const graphLeft = L.aheadX + (m ? V.w - 40 : Math.max(headW, 440)) + (m ? 40 : 60);
  L.graphX = graphLeft + L.GW / 2;
  graph.position.set(L.graphX, V.y0, -40);
  graph.userData = {W:L.GW, H:L.GH};
  // short screens: Quay and Thiết kế share a column 0.3·GH apart, so a 3-line node (aspect ~1.97) must stay under that
  const nodeW = Math.min(m ? 185 : clamp(L.GW * .12, 260, 300), (L.GH * .3 - 16) * 1.97);
  nodeCards.forEach(c => {
    c.setSize(nodeW * (c.data.mini ? .85 : 1) / c.aspect); // the AI lane's helper nodes sit a size down
    c.base.x = c.frac.fx * L.GW; c.base.y = c.frac.fy * L.GH;
  });
  // Until "Generate" the panel only spans the Brief (its left part), so the chapter is short to scroll past;
  // nodes keep their full-graph positions, so nothing moves when it opens, the chapters after it shift right.
  L.GWshown = wfState === 'idle' && briefCard ? Math.min(L.GW, L.GW / 2 + briefCard.base.x + nodeW / 2 + (m ? 70 : 120)) : L.GW;
  L.graphShift = -(L.GW - L.GWshown) / 2; // panel centre relative to the graph's (full) centre
  graphMesh.scale.set(L.GWshown, L.GH, 1);
  graphMesh.position.x = L.graphShift;
  drawGraphBg(L.GWshown, L.GH);

  // career chapter: header, then the tilted sequence; the monitor floats above it (see updateCareer)
  L.cheadX = graphLeft + L.GWshown + chGap;
  elCHead.style.left = L.cheadX + 'px'; elCHead.style.width = headW + 'px';
  C.k = m ? 14 : clamp(V.w * .011, 16, 22); // px per month from 2022 on
  C.padL = m ? 92 : 120;
  C.laneH = m ? 78 : clamp(V.avail * .16, 90, 112); // phones: tall enough for tag, name and dates
  C.SH = C.rulerH + LANES.length * C.laneH + 16;
  C.SW = C.padL + 24 + scaled(END_M) - scaled(START_M) + 40;
  L.careerX = L.cheadX + headW + (m ? 40 : 80) + C.SW / 2;
  const seqCY = V.hud + V.avail * .66; // screen y of the sequence center, under the monitor
  career.position.set(L.careerX, V.h / 2 - seqCY, -30);
  career.rotation.set(m ? -.35 : -.42, 0, 0); // flatter tilt keeps the small text readable
  careerMesh.scale.set(C.SW, C.SH, 1);
  career.userData = {W:C.SW, H:C.SH};
  drawCareerBg();
  careerCards.forEach(c => {
    const [a, b] = clipSpan(c.data), x0 = monthX(a);
    const w = Math.max(monthX(b) - x0 - 4, 24), h = C.laneH - 18; // true duration; text truncates
    c.aspect = w / h; c.setSize(h);
    c.base.x = x0 + 2 + w / 2; c.base.y = laneY(c.data.track);
  });
  buildCareerOverlay();
  L.careerStart = L.careerX - C.SW / 2; L.careerEnd = L.careerX + C.SW / 2;
  lastCareerKey = null;

  // contact chapter: header, contact card, then the clapperboard
  L.oheadX = L.careerEnd + chGap;
  elOHead.style.left = L.oheadX + 'px'; elOHead.style.width = headW + 'px';
  const ctW = m ? V.w - 40 : 460;
  L.contactX = L.oheadX + headW + (m ? 40 : 70);
  elContact.style.left = L.contactX + 'px'; elContact.style.width = ctW + 'px';
  const clapS = Math.min(m ? (V.w - 60) / CLAP_W : 1, V.avail * .62 / (CLAP_H + STICK_H * 2), V.w * (m ? .62 : .34) / CLAP_W); // phones: the slate is the last screen's hero
  L.clapX = L.contactX + ctW + (m ? 40 : 110) + CLAP_W * clapS / 2;
  clap.scale.setScalar(clapS);
  // phones: the caption and end line stack under the slate, so lift the whole group
  clap.position.set(L.clapX, V.y0 - STICK_H * clapS * .6 + (m ? 28 : 0), 0); // optical centre: the open stick on top is light, the slate below is heavy
  elClapCap.style.left = L.clapX + 'px';
  elClapCap.style.width = m ? CLAP_W * clapS + 'px' : ''; // phones: wrap under the slate
  elClapCap.style.top = (V.h / 2 - clap.position.y + CLAP_H * clapS / 2 + 30) + 'px';

  // end line under the clapperboard: the reel ends on the slate (no separate end screen)
  elClapEnd.style.left = L.clapX + 'px';
  elClapEnd.style.width = m ? CLAP_W * clapS + 'px' : ''; // phones: wrap under the slate instead of running off screen
  elClapEnd.style.top = (V.h / 2 - clap.position.y + CLAP_H * clapS / 2 + (m ? 84 : 62)) + 'px'; // phones: room for a two-line caption
  L.worldEnd = m ? L.clapX + V.w / 2 : L.clapX + CLAP_W * clapS / 2 + 80; // phones end with the slate centred
  maxScroll = Math.max(0, L.worldEnd - V.w);
  fitScenes(); placeDeck();
  target = clamp(target, 0, maxScroll);
  buildTimeline();
}

// On short screens (phones with browser toolbars) a chapter's text can be taller than the gap
// between HUD and timeline. Zoom its contents down to fit rather than let the timeline cover it.
// mobile: centre the deck in the space left between the intro copy and the timeline
function placeDeck(){
  if (!V.mobile) return;
  // the copy's end is read from an unzoomed marker placed right after it: Safari reports
  // rects inside a CSS-zoomed element (see fitScenes) at the wrong scale
  let mark = $('#intro-end');
  if (!mark){ mark = document.createElement('div'); mark.id = 'intro-end'; mark.style.cssText = 'height:0;flex:none'; elIntro.querySelector('.intro-copy').after(mark); }
  const top = mark.getBoundingClientRect().top;
  const bottom = Math.min(V.h - V.tl, $('#timeline') ? $('#timeline').getBoundingClientRect().top : Infinity);
  // the fanned deck reaches past its card height (outer cards sit lower and tilt), so centre the
  // whole block (fan + caption under it) in the gap, and keep the caption below the lowest corner
  // grow the deck into whatever the copy leaves (the base size is what fitScenes reserved), up to
  // where the fan would get too wide for the screen; then sit fan + caption just above the timeline
  const capH = 22;
  const free = bottom - top - 12 - 12 - capH - 8; // margins above the fan and below the caption, caption gap
  const h = clamp((free - 32) / 1.09 * .9, L.deckBase, Math.min(240, V.w * .5)); // inverse of deckUp + deckDown, 90% so the fan has air above it
  if (Math.abs(h - L.deckH) > 1){ L.deckH = h; deckCards.forEach(c => c.setSize(h)); }
  const down = deckDown(L.deckH);
  const cy = bottom - 12 - capH - 8 - down; // caption bottom lands 12px above the timeline
  L.deckY = V.h / 2 - cy;
  elCaption.style.zoom = '';
  elCaption.style.top = (cy + down + 8 - V.hud) + 'px';
  if (DEBUG) showDebug({inner:innerHeight, gl:canvas.clientHeight, vv:window.visualViewport && Math.round(visualViewport.height), copy:Math.round(top), zoom:elIntro.querySelector('.intro-copy').style.zoom || 1, tl:Math.round(bottom), deckH:Math.round(L.deckH), cy:Math.round(cy)});
}
// ?debug prints the layout numbers on screen, for checking phones we cannot attach to
const DEBUG = /[?&]debug/.test(location.search);
function showDebug(o){
  let el = $('#dbg');
  if (!el){ el = document.createElement('pre'); el.id = 'dbg'; el.style.cssText = 'position:fixed;left:8px;top:70px;z-index:99;margin:0;padding:6px 8px;font:11px/1.4 monospace;background:#000c;color:#7f7;border-radius:6px;pointer-events:none'; document.body.append(el); }
  el.textContent = Object.entries(o).map(([k, v]) => k + ': ' + v).join('\n');
}
// Phones: the skill chips stay in two rows of four (a grid, see styles.css), zoomed down to the
// copy column's width. Run before fitScenes measures heights and again after it zooms the copy.
const rolesEl = $('.roles');
function fitRoles(){
  if (!rolesEl) return;
  rolesEl.style.zoom = '';
  if (!V.mobile) return;
  const k = rolesEl.parentElement.clientWidth / rolesEl.scrollWidth; // layout px, unaffected by Safari's zoomed rects
  if (k < 1) rolesEl.style.zoom = k.toFixed(3);
}
function fitScenes(){
  fitRoles();
  track.querySelectorAll('.scene').forEach(el => {
    // the mobile deck caption is placed by placeDeck, under the deck: it is not part of the copy to fit
    const kids = [...el.children].filter(c => c.id !== 'intro-end' && !(V.mobile && c === elCaption));
    kids.forEach(k => { k.style.zoom = ''; });
    // measure the children themselves: scrollHeight handles padding differently per browser
    const cs = getComputedStyle(el);
    const space = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const rects = kids.map(c => c.getBoundingClientRect()).filter(r => r.height);
    if (!rects.length) return;
    const k = space / (Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top)) + 8);
    if (k < 1) kids.forEach(c => { c.style.zoom = Math.max(.55, k * .97).toFixed(3); });
  });
  fitRoles();
}

/* ============= CHAPTERS / TIMELINE ============= */
const tlBody = $('#tl-body'), tlScn = $('#tl-scn'), tlV1 = $('#tl-v1'), tlRuler = $('#tl-ruler');
const playhead = $('#playhead'), playheadTc = $('#playhead-tc'), tlProgress = $('#tl-progress');
const fracOf = s => maxScroll ? clamp(s / maxScroll, 0, 1) * BUILT : 0;
const scrollOfFrac = f => clamp(f / BUILT, 0, 1) * maxScroll;
const scrollToCard = c => clamp(c.home.x - V.w / 2, 0, maxScroll);
const surfaceWorldX = c => c.surface.position.x + c.base.x;
let chapters = [], scnClips = [], vClips = [];

function buildTimeline(){
  const pct = f => (f * 100).toFixed(3) + '%';
  const pad = V.mobile ? 20 : 80;
  chapters = [
    {name:'00 Intro', hud:'SCN 00 · <b>INTRO</b>', start:0, jump:0},
    {name:'01 Video & Motion', hud:'SCN 01 · <b>VIDEO &amp; MOTION</b>', start:L.videoStart * .6, jump:L.videoStart},
    {name:'02 Design', hud:'SCN 02 · <b>DESIGN</b>', start:L.dheadX - V.w * .5, jump:L.dheadX - pad},
    {name:'03 Workflow', hud:'SCN 03 · <b>WORKFLOW</b>', start:L.aheadX - V.w * .5, jump:L.aheadX - pad},
    {name:'04 Career', hud:'SCN 04 · <b>CAREER</b>', start:L.cheadX - V.w * .5, jump:L.cheadX - pad},
    {name:'05 Contact', hud:'SCN 05 · <b>CONTACT</b>', start:L.oheadX - V.w * .5, jump:L.oheadX - pad},
  ];
  tlScn.innerHTML = '';
  scnClips = chapters.map((ch, i) => {
    const from = fracOf(ch.start), to = i < chapters.length - 1 ? fracOf(chapters[i + 1].start) : BUILT;
    const el = document.createElement('div');
    el.className = 'clip scn-clip'; el.textContent = ch.name;
    // phones: a name that would be cut ("02 Des") shows just its number
    if (V.mobile && (to - from) * tlBody.clientWidth < ch.name.length * 6 + 10) el.textContent = ch.name.slice(0, 2);
    el.title = ch.name;
    el.style.left = `calc(${pct(from)} + 1px)`; el.style.width = `calc(${pct(to - from)} - 2px)`;
    el.dataset.jump = clamp(ch.jump, 0, maxScroll);
    tlScn.appendChild(el);
    return {el, ...ch};
  });
  const gw = (1 - BUILT) / GHOSTS.length;
  GHOSTS.forEach((g, i) => {
    const el = document.createElement('div');
    el.className = 'clip ghost'; el.textContent = g; el.dataset.ghost = g;
    el.style.left = `calc(${pct(BUILT + i * gw)} + 1px)`; el.style.width = `calc(${pct(gw)} - 2px)`;
    tlScn.appendChild(el);
  });

  // V1: showreel, one clip per visible video card, then design prints and AI nodes
  tlV1.innerHTML = '';
  const addClip = (s, halfW, color, title, onClick) => {
    const el = document.createElement('div');
    el.className = 'clip v'; el.style.setProperty('--c', color);
    const a = fracOf(s - halfW), b = fracOf(s + halfW);
    el.style.left = `calc(${pct(a)} + .5px)`; el.style.width = `max(2px, calc(${pct(b - a)} - 1px))`;
    el.title = title;
    el.go = onClick; // called by the timeline's pointerup when the press did not drag
    tlV1.appendChild(el);
    return el;
  };
  const introEnd = L.videoStart * .6;
  addClip(introEnd / 2, introEnd / 2, '#EFE7D6', 'Showreel', () => { target = 0; });
  const halfStep = (L.cardW + L.gap) / (2 * L.rows); // cards in staggered rows are 1/rows of a column apart
  vClips = visibleCards().map(c => ({c, el:addClip(c.home.x + c.slot - V.w / 2, halfStep, CATS[c.data.cat].color, c.title, () => { target = scrollToCard(c); c.flash = 1; })}));
  [...printCards, ...nodeCards, ...careerCards].forEach(c => {
    const s = surfaceWorldX(c) - V.w / 2;
    const color = c.kind === 'print' ? '#EFE7D6' : c.data.color;
    vClips.push({c, surface:true, el:addClip(s, c.w / 2 || 80, color, c.title, () => { target = clamp(s, 0, maxScroll); c.flash = 1; })});
  });

  tlRuler.innerHTML = '';
  for (let i = 0; i < 10; i++){
    const f = i / 10;
    const sp = document.createElement('span');
    sp.style.left = pct(f);
    sp.textContent = f <= BUILT ? tcFmt(scrollOfFrac(f)).slice(3, 8) : '--:--';
    tlRuler.appendChild(sp);
  }
  drawWave();
}

function drawWave(){
  const c = $('#tl-wave'), r = c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
  c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const W = r.width, H = r.height, n = Math.floor(W / 3);
  for (let i = 0; i < n; i++){
    const x = i * 3, f = x / W;
    const a = Math.abs(Math.sin(i * .31) * .5 + Math.sin(i * .073) * .35 + Math.sin(i * 1.7) * .15);
    const h = Math.max(1, a * (H - 8));
    g.fillStyle = f < BUILT ? 'rgba(239,231,214,.35)' : 'rgba(239,231,214,.08)';
    g.fillRect(x, (H - h) / 2, 2, h);
  }
}

// scrubbing
let scrub = null;
function fracFromEvent(e){ const r = tlBody.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); }
// Press anywhere on the timeline and drag to scrub, clips included. A press on a chapter or V1 clip
// that does not move is a click (jump to it); before, those rows ate the press and dragging did nothing.
tlBody.addEventListener('pointerdown', e => {
  if (viewing) return;
  e.preventDefault(); // no text selection on the ruler and clip labels while dragging
  const ghost = e.target.closest('[data-ghost]');
  if (ghost){ toast(`Chương ${ghost.dataset.ghost} đang dựng ở bản tiếp theo`); return; }
  const clip = e.target.closest('[data-jump]') || e.target.closest('.clip.v');
  scrub = {id:e.pointerId, x:e.clientX, clip, moved:false};
  tlBody.setPointerCapture(e.pointerId);
  if (clip) return; // wait: a click jumps to the clip, a drag scrubs
  const f = fracFromEvent(e);
  if (f > BUILT) toast('Phần này đang dựng ở bản tiếp theo');
  target = scrollOfFrac(f);
});
tlBody.addEventListener('pointermove', e => {
  if (!scrub) return;
  if (!scrub.moved && Math.abs(e.clientX - scrub.x) < 4) return;
  scrub.moved = true;
  target = scrollOfFrac(fracFromEvent(e));
});
const endScrub = () => { scrub = null; };
tlBody.addEventListener('pointerup', () => {
  const c = scrub && !scrub.moved && scrub.clip;
  if (c) c.dataset.jump !== undefined ? target = +c.dataset.jump : c.go();
  endScrub();
});
tlBody.addEventListener('pointercancel', endScrub);

/* ============= FILTERS ============= */
const filtersEl = $('#filters');
function buildFilters(){
  const counts = {}; VIDEOS.forEach(v => counts[v.cat] = (counts[v.cat] || 0) + 1);
  const items = [['all', 'Tất cả', '#EFE7D6', VIDEOS.length], ...Object.entries(CATS).map(([k, c]) => [k, c.label, c.color, counts[k] || 0])];
  filtersEl.innerHTML = items.map(([k, label, color, n]) =>
    `<button type="button" class="chip${k === filter ? ' on' : ''}" data-f="${k}" style="--c:${color}" aria-pressed="${k === filter}"><i></i>${label}<small>${n}</small></button>`).join('');
}
filtersEl.addEventListener('click', e => {
  const b = e.target.closest('[data-f]'); if (!b || b.dataset.f === filter) return;
  filter = b.dataset.f; buildFilters(); layout(true);
});

/* ============= INPUT ============= */
addEventListener('wheel', e => {
  if (viewing || profileOpen) return; // the card scrolls itself when it is taller than the screen
  e.preventDefault();
  const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  target = clamp(target + d * (e.deltaMode === 1 ? 40 : 1) * 1.15, 0, maxScroll);
}, {passive:false});

function setPointer(e){
  pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true;
  pointer.ndc.set(e.clientX / V.w * 2 - 1, -(e.clientY / V.h) * 2 + 1);
}
// pick up a surface card: drag it across its table/graph by intersecting the pointer ray with that plane
let drag = null, cardDrag = null;
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();
function surfaceHit(surface){
  ray.setFromCamera(pointer.ndc, camera);
  return ray.ray.intersectPlane(dragPlane, tmpV) ? surface.worldToLocal(tmpV.clone()) : null;
}
canvas.addEventListener('pointerdown', e => {
  if (viewing) return;
  setPointer(e);
  updateHover(); // hover is refreshed per frame; a click can land before the next one (and taps never hover)
  canvas.setPointerCapture(e.pointerId);
  if (hovered && hovered.onSurface && !hovered.static){
    const s = hovered.surface;
    s.updateMatrixWorld(true);
    dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(s.getWorldQuaternion(tmpQ)), s.getWorldPosition(new THREE.Vector3()));
    const hit = surfaceHit(s);
    if (hit){
      const c = hovered;
      c.stack = ++stackTop;
      cardDrag = {card:c, ox:c.base.x - hit.x, oy:c.base.y - hit.y, sx:e.clientX, sy:e.clientY, moved:false};
      return;
    }
  }
  drag = {x:e.clientX, t0:target, moved:false, lx:e.clientX, lt:performance.now(), v:0};
});
canvas.addEventListener('pointermove', e => {
  if (cardDrag){
    if (Math.hypot(e.clientX - cardDrag.sx, e.clientY - cardDrag.sy) > 5) cardDrag.moved = true;
    const c = cardDrag.card;
    const hit = cardDrag.moved && surfaceHit(c.surface);
    if (hit){
      const {W, H} = c.surface.userData;
      c.base.x = clamp(hit.x + cardDrag.ox, -W / 2 + c.w / 2, W / 2 - c.w / 2);
      c.base.y = clamp(hit.y + cardDrag.oy, -H / 2 + c.h / 2, H / 2 - c.h / 2);
    }
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x;
  if (Math.abs(dx) > 6) drag.moved = true;
  if (drag.moved) target = clamp(drag.t0 - dx * 1.3, 0, maxScroll);
  const now = performance.now(), dt = Math.max(1, now - drag.lt);
  drag.v = lerp(drag.v, (e.clientX - drag.lx) / dt, .5); drag.lx = e.clientX; drag.lt = now;
});
canvas.addEventListener('pointerup', () => {
  if (cardDrag){
    const c = cardDrag.card;
    if (!cardDrag.moved) activate(c);
    else {
      const {W, H} = c.surface.userData;
      c.frac = {fx:c.base.x / W, fy:c.base.y / H}; // keep the spot across resizes
      // things dropped on the table land slightly askew; graph nodes stay square
      if (!reduce && c.surface === table) gsap.to(c.base, {rot:c.base.rot + (Math.random() - .5) * .12, duration:.5, ease:'back.out(2)'});
    }
    cardDrag = null;
    return;
  }
  if (!drag) return;
  if (!drag.moved){ if (hovered) activate(hovered); else if (moreHovered) toggleBin(moreHovered); else if (genHovered) generate(); else if (clapState.hovered) clapAction(); }
  // flick inertia, capped near one screen so a hard swipe on a phone cannot fly past a whole chapter
  else if (!reduce) target = clamp(target - clamp(drag.v * 260, -V.w * .8, V.w * .8), 0, maxScroll);
  if (drag.moved && maxScroll - target < V.w * .3) target = maxScroll; // a swipe that lands near the end settles on it, so the last screen is framed as laid out
  drag = null;
});
canvas.addEventListener('pointercancel', () => { drag = null; cardDrag = null; });

addEventListener('pointermove', e => {
  setPointer(e);
  mouseN.tx = e.clientX / V.w * 2 - 1; mouseN.ty = e.clientY / V.h * 2 - 1;
});
document.addEventListener('pointerleave', () => { pointer.inside = false; pointer.ndc.set(9, 9); });

addEventListener('keydown', e => {
  if (profileOpen){ if (e.key === 'Escape') setProfile(false); return; }
  if (viewing){
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowRight') stepViewer(1);
    if (e.key === 'ArrowLeft') stepViewer(-1);
    return;
  }
  const page = V.w * .6;
  const map = {ArrowRight:page, ArrowDown:page, PageDown:V.w, ' ':V.w, ArrowLeft:-page, ArrowUp:-page, PageUp:-V.w};
  if (e.key in map){ e.preventDefault(); target = clamp(target + map[e.key], 0, maxScroll); }
  if (e.key === 'Home') target = 0;
  if (e.key === 'End') target = maxScroll;
});
$('#hint').addEventListener('click', () => { target = clamp(L.videoStart, 0, maxScroll); });
$('#rewind').addEventListener('click', () => { target = 0; });
/* ============= PROFILE CARD (HUD avatar) ============= */
const profileEl = $('#profile'), avatarBtn = $('#avatar');
let profileOpen = false;
function setProfile(open){
  profileOpen = open;
  profileEl.classList.toggle('open', open);
  profileEl.setAttribute('aria-hidden', String(!open));
  avatarBtn.setAttribute('aria-expanded', String(open));
  if (open){ setHovered(null); $('#pf-close').focus({preventScroll:true}); }
  else avatarBtn.focus({preventScroll:true});
}
avatarBtn.addEventListener('click', () => { if (viewing) closeViewer(true); setProfile(!profileOpen); });
$('#pf-close').addEventListener('click', () => setProfile(false));
profileEl.addEventListener('click', e => { if (e.target === profileEl) setProfile(false); }); // tap outside the card; on click, not pointerdown, so the tap cannot fall through to the HUD once the overlay lets go
$('#pf-contact').addEventListener('click', () => { setProfile(false); $('#hud-contact').click(); });

// HUD contact button: tua straight to chapter 05 (it used to be a mailto link, which does nothing without a mail app)
$('#hud-contact').addEventListener('click', e => {
  e.preventDefault();
  if (viewing) closeViewer();
  const ch = chapters.find(c => c.name === '05 Contact');
  if (ch) target = clamp(ch.jump, 0, maxScroll);
});

/* ============= CONTACT ============= */
$('#ct-copy').addEventListener('click', () => {
  (navigator.clipboard ? navigator.clipboard.writeText(EMAIL) : Promise.reject())
    .then(() => toast('Đã copy email'), () => toast(EMAIL));
});
$('#ct-phone').addEventListener('click', () => {
  (navigator.clipboard ? navigator.clipboard.writeText(PHONE) : Promise.reject())
    .then(() => toast('Đã copy số điện thoại'), () => toast($('#ct-phone').lastChild.textContent)); // no clipboard: show it spaced, as on the card
});

function activate(c){
  if (c.kind === 'video') openCard(c);
  else if (c.kind === 'print') window.open(c.data.url, '_blank', 'noopener'); // the print is only a cover: open the full case
  else if (c.kind === 'clip'){ target = clamp(surfaceWorldX(c) - V.w / 2, 0, maxScroll); c.flash = 1; } // seek the playhead onto it
  else if (c.data.url) window.open(c.data.url, '_blank', 'noopener');
  else if (!reduce) gsap.fromTo(c.base, {rot:c.base.rot - .08}, {rot:c.base.rot, duration:.6, ease:'elastic.out(1.2,.4)'});
}

/* ============= HOVER (raycast) ============= */
const ray = new THREE.Raycaster();
function updateHover(){
  if (cardDrag){ setHovered(cardDrag.card); return; }
  if (viewing || scrub || (drag && drag.moved)){ setHovered(null); moreHovered = null; genHovered = false; return; }
  ray.setFromCamera(pointer.ndc, camera);
  const meshes = allCards.filter(c => c.group.visible && c.vis > .5).map(c => c.front);
  // depth testing is off, so the card you see on top is the one drawn last, not the nearest hit
  const hits = ray.intersectObjects(meshes, false);
  const hit = hits.reduce((best, h) => !best || h.object.renderOrder > best.object.renderOrder ? h : best, null);
  const c = hit ? hit.object.userData.card : null;
  if (c && hit.uv){ c.tilt.tx = (hit.uv.x - .5) * 2; c.tilt.ty = (hit.uv.y - .5) * 2; }
  setHovered(c);
  // a bin's "Xem thêm" tile is HTML, so it is hit-tested by its screen rect
  const mh = c ? null : moreUnderPointer();
  if (mh !== moreHovered){
    moreHovered = mh;
    cursorEl.classList.toggle('on-card', !!mh || !!hovered);
    if (mh){ cursorLabel.textContent = 'OPEN'; cursorTitle.innerHTML = expandedBins.has(mh.cat) ? 'Thu gọn' : `${mh.info.label}<small>xem hết</small>`; }
  }
  // the clapperboard is not a card; check it only when no card is under the pointer
  const gh = !c && !mh && genUnderPointer();
  if (gh !== genHovered){
    genHovered = gh;
    genEl.classList.toggle('hot', gh);
    cursorEl.classList.toggle('on-card', gh || !!mh || !!hovered);
    if (gh){ cursorLabel.textContent = 'RENDER'; cursorTitle.innerHTML = 'Workflow<small>render toàn bộ</small>'; }
  }
  const onClap = !c && !mh && !gh && ray.intersectObjects(clapMeshes, false).length > 0;
  if (onClap !== clapState.hovered){
    clapState.hovered = onClap;
    cursorEl.classList.toggle('on-card', onClap || !!hovered);
    if (onClap){ cursorLabel.textContent = 'ACTION'; cursorTitle.innerHTML = 'Clapperboard<small>bấm để hô diễn</small>'; }
  }
}
const CURSOR_LABEL = {video:'PLAY', print:'OPEN', note:'DRAG', node:'DRAG', clip:'SEEK'};
function setHovered(c){
  if (c === hovered) return;
  if (hovered && hovered.deckSlot !== 2) hovered.pause();
  hovered = c;
  if (c) c.play();
  if (c && c.kind === 'video') videoAspect(c.data.id); // warm the cache for openCard
  cursorEl.classList.toggle('on-card', !!c);
  if (c){
    const opens = c.kind === 'note' && c.data.url;
    cursorLabel.textContent = opens ? 'OPEN' : CURSOR_LABEL[c.kind];
    const hint = c.kind === 'print' ? 'kéo · bấm mở Behance ↗'
      : c.kind === 'node' ? '' // the node's name is enough; the DRAG cursor already says it moves
      : c.kind === 'clip' ? c.data.when
      : c.label;
    cursorTitle.innerHTML = hint ? `${c.title}<small>${hint}</small>` : c.title;
  }
}

/* ============= CURSOR ============= */
const cursorEl = $('#cursor'), cursorLabel = $('#cursor-label'), cursorTitle = $('#cursor-title');
function updateCursor(){
  // follow the pointer exactly; any easing here reads as input lag
  cursorEl.style.transform = `translate3d(${pointer.x}px,${pointer.y}px,0)`;
  const overUI = pointer.y < V.hud || pointer.y > V.h - V.tl;
  cursorEl.classList.toggle('hidden', overUI || !!viewing || !pointer.inside);
  const dragging = !!(drag && drag.moved);
  cursorEl.classList.toggle('drag', dragging && !hovered);
  if (dragging && !hovered) cursorLabel.textContent = 'DRAG';
  const carrying = !!(cardDrag && cardDrag.moved);
  cursorEl.classList.toggle('carrying', carrying);
  if (carrying) cursorLabel.textContent = 'MOVE';
}

/* ============= VIEWER ============= */
const viewer = $('#viewer'), vwFrame = $('#vw-frame');
const metaCache = {};
function videoAspect(id){
  if (metaCache[id]) return Promise.resolve(metaCache[id]);
  return new Promise(res => {
    const img = new Image();
    img.onload = () => res(metaCache[id] = img.naturalWidth / img.naturalHeight || 16/9);
    img.onerror = () => res(16/9);
    img.src = metaURL(id);
    setTimeout(() => res(16/9), 1500);
  });
}
function frameRect(aspect){
  // desktop: leave room for the meta panel on the left where the screen allows it;
  // mobile: the meta panel sits on top and the prev/next buttons below, so fit between them
  // (on mobile the viewer covers the timeline too, so the video gets the full height)
  const top = V.mobile ? Math.max($('.viewer-meta').getBoundingClientRect().bottom, $('#vw-close').getBoundingClientRect().bottom) + 12 : V.hud + 16;
  const bottom = V.mobile ? $('.viewer-nav').getBoundingClientRect().top - 12 : V.h - V.tl - 16;
  const maxW = V.mobile ? V.w * .92 : Math.max(V.w * .5, Math.min(V.w * .58, V.w - 2 * 400));
  const maxH = V.mobile ? bottom - top : V.avail * .84;
  let w = maxW, h = w / aspect;
  if (h > maxH){ h = maxH; w = h * aspect; }
  const cy = V.mobile ? (top + bottom) / 2 : V.cy;
  return {w, h, x:(V.w - w) / 2, y:cy - h / 2};
}
function showMeta(card){
  viewer.setAttribute('aria-hidden', 'false');
  $('#vw-idx').textContent = `CLIP ${String(card.index + 1).padStart(2, '0')} / ${VIDEOS.length}`;
  $('#vw-title').textContent = card.title;
  $('#vw-cat').innerHTML = `<i></i>${card.label}`;
  $('#vw-cat').style.setProperty('--c', CATS[card.data.cat].color);
  dimTarget = 1;
  track.style.transition = 'opacity .4s'; track.style.opacity = .08;
}
// Opening is one continuous move: the frame starts exactly on the card's on-screen rect,
// showing the card's own image, and grows into the player's rect (video aspect); the
// player loads inside it. Closing runs the same move backwards onto the card.
const corner = new THREE.Vector3();
function cardScreenRect(card){
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [sx, sy] of [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]]){
    corner.set(sx, sy, 0).applyMatrix4(card.front.matrixWorld).project(camera);
    const x = (corner.x + 1) / 2 * V.w, y = (1 - corner.y) / 2 * V.h;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return {x:x0, y:y0, w:x1 - x0, h:y1 - y0};
}
let frameTween = null;
function morphFrame(from, to, done){
  if (frameTween) frameTween.kill();
  frameTween = gsap.fromTo(vwFrame,
    {left:from.x, top:from.y, width:from.w, height:from.h},
    {left:to.x, top:to.y, width:to.w, height:to.h, duration:reduce ? 0 : .6, ease:'power3.inOut', onComplete:done});
}
function openViewer(card, aspect){
  viewing = card; setHovered(null);
  showMeta(card);
  // a clone of the card's own, already decoded <img>, so the first frame is never blank
  const poster = card.css.element.querySelector('img').cloneNode();
  poster.className = 'vw-poster'; poster.alt = card.title;
  vwFrame.replaceChildren(poster);
  // the card stays on screen until the frame can actually paint its image, then they swap
  vwFrame.classList.remove('shown');
  poster.decode().catch(() => {}).then(() => { if (viewing === card) vwFrame.classList.add('shown'); });
  viewer.classList.add('open');
  morphFrame(cardScreenRect(card), frameRect(aspect), () => {
    if (viewing !== card) return;
    vwFrame.insertAdjacentHTML('beforeend', `<iframe src="${embedURL(card.data.id)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" title="${card.title}"></iframe>`);
    const f = vwFrame.querySelector('iframe');
    f.addEventListener('load', () => f.classList.add('ready'));
    $('#vw-close').focus({preventScroll:true});
  });
}
async function openCard(card){
  if (viewing) return;
  const aspect = await videoAspect(card.data.id); // usually cached: prefetched on hover
  if (!viewing) openViewer(card, aspect);
}
function closeViewer(instant = false){
  const card = viewing; if (!card) return;
  dimTarget = 0; track.style.opacity = 1;
  const f = vwFrame.querySelector('iframe');
  if (f) f.remove(); // stop the player's audio right away
  const finish = () => {
    if (viewing !== card) return;
    viewing = null;
    viewer.classList.remove('open'); viewer.setAttribute('aria-hidden', 'true');
    vwFrame.classList.remove('shown');
    setTimeout(() => { if (!viewing) vwFrame.innerHTML = ''; }, 350);
  };
  if (instant) return finish();
  const r = vwFrame.getBoundingClientRect();
  morphFrame({x:r.left, y:r.top, w:r.width, h:r.height}, cardScreenRect(card), finish);
}
function stepViewer(dir){
  if (!viewing) return;
  const list = viewing.deckSlot >= 0 ? deckCards : visibleCards();
  const i = list.indexOf(viewing);
  const next = list[(i + dir + list.length) % list.length];
  closeViewer(true);
  if (next.kind === 'video' && next.deckSlot < 0){ target = scroll = scrollToCard(next); }
  // let one frame render at the new scroll so the next card's rect is where it is drawn
  requestAnimationFrame(() => requestAnimationFrame(() => activate(next)));
}
$('#vw-close').addEventListener('click', () => closeViewer());
$('#vw-prev').addEventListener('click', () => stepViewer(-1));
$('#vw-next').addEventListener('click', () => stepViewer(1));
viewer.addEventListener('click', e => { if (e.target === viewer) closeViewer(); }); // click: see the profile overlay

/* ============= CAREER PLAYHEAD + MONITOR ============= */
// The page's own scroll drives the sequence: the screen center is the playhead.
const monitorEl = $('#monitor'), monBody = $('#mon-body'), monTc = $('#mon-tc');
const TRACK_RANK = {work:0, side:1, edu:2};
function updateCareer(){
  const center = scroll + V.w / 2;
  // the playhead parks between the first clip and NOW, so the monitor always has something to show
  const lx = clamp(center - L.careerX, monthX(FIRST_M), monthX(monthIdx(NOW) + 1) - 1);
  careerPlayheadX = lx;
  const month = xMonth(lx);
  monTc.textContent = fmtMonth(month);
  const monW = monitorEl.offsetWidth;
  monitorEl.style.left = clamp(center - monW / 2, L.careerStart, L.careerEnd - monW) + 'px';
  monitorEl.style.opacity = 1 - dim;

  const active = careerCards.filter(c => { const [a, b] = clipSpan(c.data); return month >= a && month < b; })
    .sort((a, b) => TRACK_RANK[a.data.track] - TRACK_RANK[b.data.track]);
  active.forEach((c, i) => { c.flash = Math.max(c.flash, i ? .35 : .75); });
  const key = active.map(c => c.index).join(',');
  if (key === lastCareerKey) return;
  lastCareerKey = key;
  const main = active[0];
  const fill = () => {
    $('#mon-when').textContent = main ? `${main.data.when} · ${main.data.tag}` : '';
    $('#mon-title').textContent = main ? main.data.title : 'Trước khi vào nghề';
    $('#mon-role').textContent = main ? main.data.role : '';
    $('#mon-role').style.setProperty('--c', main && main.data.color !== '#EFE7D6' ? main.data.color : 'var(--brand)');
    $('#mon-desc').textContent = main ? main.data.desc : '';
    $('#mon-also').textContent = active.length > 1 ? 'SONG SONG · ' + active.slice(1).map(c => c.data.title).join(' · ') : '';
    monBody.classList.remove('swap');
  };
  if (reduce) fill(); else { monBody.classList.add('swap'); setTimeout(fill, 160); }
}

/* ============= CSS3D SYNC ============= */
// true when a world-x position (with some width) is within the screen plus a margin
const onScreen = (x, w = 0) => Math.abs(x - camera.position.x) < V.w * .75 + w;
// HTML faces follow their WebGL anchors; runs after scene.updateMatrixWorld() each frame.
function syncCss(){
  allCards.forEach(c => {
    // HTML has no camera far plane, so anything off screen is hidden here (also keeps the DOM light)
    c.css.visible = c.group.visible && onScreen(c.inner.matrixWorld.elements[12], c.w);
    // a hair of z per draw-order rank, so overlapping coplanar cards (prints on the table)
    // stack in the same order as their WebGL glow and shadow
    const s = c.kind === 'node' ? c.w / NODE_TEX_W : c.kind === 'note' ? c.w / NOTE_W : 1;
    pinCss(c.css, c.inner.matrixWorld, s, 1 + c.rank * .1);
    c.css.element.style.opacity = c.op ?? 1;
  });
  pinCss(slateCss, board.matrixWorld, CLAP_W / SLATE_W, CLAP_D / 2 + .5);
  pinCss(tableText, table.matrixWorld, 1, .5);
  pinCss(graphText, graph.matrixWorld, 1, .5, L.graphShift || 0); // follows the panel while it is collapsed
  tableText.element.style.opacity = graphText.element.style.opacity = 1 - dim * .7;
  pinCss(careerTextCss, career.matrixWorld, 1, .5);
  pinCss(playheadCss, career.matrixWorld, 1, 60, careerPlayheadX); // floats above lifted clips
  careerTextCss.element.style.opacity = playheadCss.element.style.opacity = 1 - dim * .7;
}

/* ============= HUD ============= */
const tcEl = $('#tc'), sceneName = $('#scene-name');
let lastScene = -1;
function updateHud(){
  const tc = tcFmt(scroll);
  tcEl.textContent = tc;
  const f = fracOf(scroll);
  playhead.style.left = (f * 100) + '%';
  tlProgress.style.width = (f * 100) + '%';
  playheadTc.textContent = tc.slice(3, 11);
  playheadTc.style.transform = `translateX(${(-f * 100).toFixed(1)}%)`; // slides from right of the line to left of it, so neither end is clipped
  let cur = 0;
  chapters.forEach((ch, i) => { if (scroll >= ch.start) cur = i; });
  if (cur !== lastScene){
    lastScene = cur; sceneName.innerHTML = chapters[cur].hud;
    scnClips.forEach((c, i) => c.el.classList.toggle('cur', i === cur));
  }
  const center = scroll + V.w / 2;
  vClips.forEach(v => {
    const x = v.surface ? surfaceWorldX(v.c) : v.c.home.x + v.c.slot;
    v.el.classList.toggle('cur', Math.abs(x - center) < (v.surface ? v.c.w / 2 : (L.cardW + L.gap) / (2 * L.rows)));
  });
}

/* ============= BOOT ============= */
bootTotal = deckCards.length + gridCards.length + printCards.length;

function bootTick(){
  loaded++;
  // the suite opens once the deck and the first grid cards are in; count toward that, not every image
  const need = Math.min(bootTotal, deckCards.length + 12);
  $('#boot-bar').style.width = Math.min(100, loaded / need * 100) + '%';
  $('#boot-txt').textContent = `Đang nạp footage · ${Math.min(loaded, need)}/${need}`;
  if (loaded >= need) finishBoot();
}
function finishBoot(){
  if (booted) return; booted = true;
  $('#boot').classList.add('done');
  const d = reduce ? 0 : 1;
  gsap.from('.reveal', {y:40, opacity:0, duration:.9 * d, stagger:.08 * d, ease:'power3.out', delay:.2 * d});
  deckCards.forEach((c, i) => gsap.to(c, {vis:1, duration:.9 * d, delay:(.35 + i * .08) * d, ease:'back.out(1.4)'}));
  deckCards[2].play();
  setTimeout(placeDeck, 1600 * d + 50); // once the copy has settled from its reveal
}
setTimeout(finishBoot, 3500); // never hold the page hostage to slow thumbnails
(function bootClock(){ if (booted) return; $('#boot-tc').textContent = tcFmt(performance.now() / 10); requestAnimationFrame(bootClock); })();

/* ============= LOOP ============= */
const clock = new THREE.Clock();
function frame(){
  const t = clock.getElapsedTime();
  const prev = scroll;
  if (!viewing){
    const k = reduce ? .35 : (scrub ? .4 : .1); // scrubbing follows the hand closely
    scroll = lerp(scroll, target, k);
    if (Math.abs(target - scroll) < .05) scroll = target;
  }
  vel = lerp(vel, scroll - prev, .2);
  mouseN.x = lerp(mouseN.x, mouseN.tx, .06);
  mouseN.y = lerp(mouseN.y, mouseN.ty, .06);
  dim = lerp(dim, dimTarget, .1);

  camera.position.x = scroll + V.w / 2;
  camera.position.y = 0;
  track.style.transform = `translate3d(${-scroll}px,0,0)`;
  tableMat.opacity = 1 - dim * .7;
  graphMat.opacity = .9 - dim * .7;
  // the graph sways a touch with the pointer while it is on screen, to read as a 3D panel
  if (!reduce) graph.rotation.set(-.1 + mouseN.y * .03, mouseN.x * .06, 0);

  allCards.forEach(c => c.update(t));
  updateWires(t);
  updateBins();
  updateCareer();
  // clapperboard: stick opens a little more on hover, the whole board turns toward the pointer
  clapState.hover = lerp(clapState.hover, clapState.hovered ? 1 : 0, .2);
  clapPivot.rotation.z = clapState.open + (clapState.busy ? 0 : clapState.hover * .12);
  if (!reduce) clap.rotation.set(.08 + mouseN.y * .08, -.32 + mouseN.x * .22, -.03);
  careerMat.opacity = 1 - dim * .7;
  [...allCards].sort((a, b) => a.sortKey() - b.sortKey()).forEach((c, i) => c.setOrder(i));
  scene.updateMatrixWorld();
  syncCss();
  if (pointer.inside && (fine || cardDrag)) updateHover();
  if (dust) dust.rotation.z = Math.sin(t * .05) * .01;
  updateHud();
  updateCursor();
  renderer.render(scene, camera);
  cssRenderer.render(cssScene, camera);
  requestAnimationFrame(frame);
}

/* ============= INIT ============= */
// A page opened in a background tab can report a 0×0 window until it is shown. Everything below
// is sized from the window, so build only once there is a real size (rAF waits until the tab shows).
const hasSize = () => innerWidth > 0 && innerHeight > 0;
function onResize(){ if (!hasSize()) return; measureViewport(); layout(false); buildDust(); }
let rT; addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(onResize, 120); });
if (window.visualViewport) visualViewport.addEventListener('resize', () => { clearTimeout(rT); rT = setTimeout(onResize, 120); }); // iOS bars
buildFilters();
$('#video-count').textContent = VIDEOS.length; // follows videos.json, nothing to update by hand
function start(){
  if (!hasSize()) return requestAnimationFrame(start);
  measureViewport();
  layout(false);
  gridCards.forEach(c => c.vis = 1);
  buildDust();
  document.fonts.ready.then(() => {
    fitScenes(); placeDeck(); // real fonts change text heights
    drawMat(L.TW, L.TH);
    drawGraphBg(L.GWshown, L.GH);
    drawCareerBg();
  });
  frame();
}
start();
