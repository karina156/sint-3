/* =========================================================
   ui.js — Figma geometry, DOM construction, responsive layout,
   per-frame rendering, good! popups, tethers, corner controls.
   All geometry below was extracted from the .fig file
   (node size + 2×2 transform + centre), not eyeballed.
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});
  const SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------- shape geometry (design units, relative to body centre) ---------- */
  const R30 = [0.86185, 0.50717, -0.50717, 0.86185];       // 30.475°
  const R30F = [0.86185, 0.50717, 0.50717, -0.86185];      // 30.475° mirrored (blue rect)
  const R12 = [0.97692, 0.21359, -0.21359, 0.97692];       // 12.333°

  const GEOM = {
    circle: {
      main: { w: 309.063, h: 309.063, cx: 0, cy: 0, m: R12 },
      arrow: {
        w: 159.404, h: 186.464, x: -6.983, y: -122.458, m: [0.79587, 0.60547, -0.60547, 0.79587],
        head: [0, 0], tail: [159.404, 186.464],
        c1: [[14.435, 19.768], [15.531, 34.474], [4.434, 67.408]],
        c2: [[62.974, 13.77], [37.011, 18.832], [22.97, 17.736]]
      }
    },
    oval: {
      main: { w: 246.253, h: 143.154, cx: 0, cy: 0, m: [0.67196, 0.74059, -0.74059, 0.67196] },
      arrow: {
        w: 117.025, h: 146.698, x: -51.236, y: -66.714, m: [1, 0, 0, 1],
        head: [0, 0], tail: [117.025, 146.698],
        c1: [[10.597, 15.552], [11.402, 27.122], [3.255, 53.032]],
        c2: [[46.232, 10.833], [27.171, 14.816], [16.863, 13.953]]
      }
    },
    square: {
      main: { w: 217.09, h: 217.09, cx: 0, cy: 0, m: R30 },
      inner: [
        { w: 195.107, h: 195.107, cx: 4.487, cy: -7.908, m: R30 },
        { w: 162.441, h: 162.441, cx: 12.771, cy: -21.985, m: R30 },
        { w: 128.343, h: 128.343, cx: 21.418, cy: -36.678, m: R30 }
      ],
      slope: [0.24134, -0.41329], drift: 0.35
    },
    rect: {
      main: { w: 112.523, h: 240.492, cx: 0, cy: 0, m: R30F },
      inner: [
        { w: 96.823, h: 206.936, cx: 8.509, cy: -14.46, m: R30F },
        { w: 81.462, h: 174.105, cx: 16.834, cy: -28.608, m: R30F },
        { w: 55.486, h: 118.588, cx: 30.913, cy: -52.532, m: R30F }
      ],
      slope: [0.54198, -0.92101], drift: 0.25
    },
    capsule: {
      front: { w: 93.478, h: 235.561, cx: 0, cy: 0, m: R30 },
      back: { w: 81.832, h: 217.051, cx: 43.723, cy: -25.318, m: R30 },
      dot: { w: 60.165, h: 60.165, cx: -37.092, cy: 66.422, m: [1, 0, 0, 1] },
      dotTravel: [77.15, -131.1],          // along the capsule axis: bottom → top
      spread: [12.07, 7.1]                 // back copy slides out along the short axis
    },
    fx: { main: { w: 52.728, h: 52.728, cx: 0, cy: 0, m: R12 } }
  };

  /* ---------- layouts ---------- */
  const DESKTOP = {
    name: 'desktop', W: 1512, H: 982,
    bg: { cx: 765.833, cy: 677.984, rx: 1223.777, ry: 1067.864 },
    vLines: [73.83, 416.83, 759.83, 1102.83, 1445.83],
    hLines: [60.49, 282.07, 601.32, 922.3],
    texts: [
      { segs: [['web', 1]], cx: 763.16, by: 158.98, size: 133.346, width: 274.3 },
      { segs: [['synth', 1], ['esizer', 0]], cx: 763.13, by: 279.98, size: 133.346, width: 681.05 },
      { segs: [['ge', 0], ['o', 1], ['met', 0], ['r', 1], ['i', 0], ['c', 1]], cx: 756.0, by: 722.58, size: 217.147, width: 1093.6 },
      { segs: [['p', 0], ['e', 1], ['rform', 0], ['a', 1], ['nce', 0]], cx: 756.0, by: 919.58, size: 217.147, width: 1393.43 }
    ],
    goods: { size: 64, width: 188.06, list: [[1274.33, 119.76], [621.71, 404.19], [73.74, 735.58], [1356.74, 486.05]] },
    cornerScale: 1,
    bodies: {
      capsule: { home: [273.413, 244.692], s: 1 },
      square: { home: [222.345, 480.53], s: 1 },
      rect: { home: [1115.975, 470.798], s: 1 },
      circle: { home: [437.739, 472.142], s: 1 },
      fx1: { home: [389.069, 256.426], s: 1 },
      fx2: { home: [1293.63, 595.753], s: 1 },
      fx3: { home: [340.541, 884.918], s: 1 },
      oval: { home: [1252.106, 802.019], s: 1 }
    }
  };

  const MOBILE = {
    name: 'mobile', W: 390, H: 844,
    bg: { cx: 197.5, cy: 582.7, rx: 315.7, ry: 917.8 },
    vLines: [39, 143, 247, 351],
    hLines: [44, 208, 468, 664, 800],
    texts: [
      { segs: [['web', 1]], cx: 195, by: 112, size: 60, width: 123.4 },
      { segs: [['synth', 1], ['esizer', 0]], cx: 195, by: 168, size: 60, width: 306.4 },
      { segs: [['ge', 0], ['o', 1], ['met', 0], ['r', 1], ['i', 0], ['c', 1]], cx: 195, by: 742, size: 74, width: 372.7 },
      { segs: [['p', 0], ['e', 1], ['rform', 0], ['a', 1], ['nce', 0]], cx: 195, by: 809, size: 74, width: 474.8 }
    ],
    goods: { size: 30, width: 88.15, list: [[322, 110], [118, 306], [22, 604], [340, 510]] },
    cornerScale: 0.72,
    bodies: {
      capsule: { home: [86, 262], s: 0.5 },
      square: { home: [116, 410], s: 0.52 },
      rect: { home: [326, 318], s: 0.55 },
      circle: { home: [228, 412], s: 0.52 },
      fx1: { home: [250, 236], s: 0.85 },
      fx2: { home: [342, 668], s: 0.85 },
      fx3: { home: [60, 792], s: 0.85 },
      oval: { home: [286, 586], s: 0.6 }
    }
  };

  const CORNERS = [
    { id: 'louder', ch: '+', anchor: 'tl', c: [35.172, 29.907], dx: -0.5, dy: 18.63, label: 'Louder' },
    { id: 'quieter', ch: '-', anchor: 'tr', c: [32.989, 29.907], dx: 0, dy: 16.0, label: 'Quieter' },
    { id: 'kill', ch: 'f', anchor: 'bl', c: [35.172, 29.612], dx: 0, dy: 20.6, label: 'Finale: all voices end' },
    { id: 'zero', ch: 'r', anchor: 'br', c: [32.989, 29.612], dx: 0, dy: 15.27, label: 'Restart the story' }
  ];

  /* ---------- body definitions ---------- */
  const BODY_DEFS = [
    { id: 'capsule', kind: 'capsule', type: 'capsule', label: 'Doubler: front toggles on/off, back doubles the selected sound' },
    { id: 'square', kind: 'square', type: 'square', label: 'Square: percussive synth, frames add density' },
    { id: 'rect', kind: 'rect', type: 'rect', label: 'Rectangle: glitch voice, child of the square' },
    { id: 'circle', kind: 'circle', type: 'circle', label: 'Circle: soft synth, arrow changes timbre' },
    { id: 'fx1', kind: 'fx', type: 'fx', fx: 'blip', label: 'Small circle: blip loop' },
    { id: 'fx2', kind: 'fx', type: 'fx', fx: 'beep', label: 'Small circle: beep loop' },
    { id: 'fx3', kind: 'fx', type: 'fx', fx: 'chirp', label: 'Small circle: chirp loop' },
    { id: 'oval', kind: 'oval', type: 'oval', label: 'Oval: child voice of the circle, arrow length is volume' }
  ];

  /* ---------- helpers ---------- */
  const r2 = (v) => Math.round(v * 100) / 100;
  function el(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function svg(tag, attrs, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function placePart(e, p) {
    e.style.left = r2(p.cx - p.w / 2) + 'px';
    e.style.top = r2(p.cy - p.h / 2) + 'px';
    e.style.width = r2(p.w) + 'px';
    e.style.height = r2(p.h) + 'px';
    e.style.transform = `matrix(${p.m[0]},${p.m[1]},${p.m[2]},${p.m[3]},0,0)`;
  }
  function part(parent, p, cls, partName) {
    const e = el('div', 'part ' + cls, parent);
    placePart(e, p);
    if (partName) e.dataset.part = partName;
    return e;
  }

  /* arrow path in the arrow's own (Figma) local space.
     oh / ot: shift of head / tail along the arrow axis (design units) */
  function arrowPath(a, oh, ot) {
    const dx = a.tail[0] - a.head[0], dy = a.tail[1] - a.head[1];
    const L = Math.hypot(dx, dy), ux = dx / L, uy = dy / L;
    const H = [a.head[0] + ux * oh, a.head[1] + uy * oh];
    const T = [a.tail[0] + ux * ot, a.tail[1] + uy * ot];
    const s = (p) => r2(p[0] + ux * oh) + ' ' + r2(p[1] + uy * oh);
    return `M${r2(T[0])} ${r2(T[1])}L${r2(H[0])} ${r2(H[1])}` +
      `M${r2(H[0])} ${r2(H[1])}C${s(a.c1[0])} ${s(a.c1[1])} ${s(a.c1[2])}` +
      `M${s(a.c2[0])}C${s(a.c2[1])} ${s(a.c2[2])} ${r2(H[0])} ${r2(H[1])}`;
  }
  function arrowLength(a) { return Math.hypot(a.tail[0] - a.head[0], a.tail[1] - a.head[1]); }

  /* Oval: the longest arrow (k = L / L0) whose whole drawing — square caps, head curves and
     half the 18-unit stroke — still lies inside the oval. Found by bisection on sampled points. */
  function ovalArrowRange(a, ell) {
    const L0 = arrowLength(a), ux = (a.tail[0] - a.head[0]) / L0, uy = (a.tail[1] - a.head[1]) / L0;
    const m = a.m, rx = ell.w / 2 - 9, ry = ell.h / 2 - 9;          // 9 = half the stroke width
    const bez = (p0, p1, p2, p3, t) => [0, 1].map((i) => (1 - t) ** 3 * p0[i] + 3 * (1 - t) ** 2 * t * p1[i] + 3 * (1 - t) * t * t * p2[i] + t ** 3 * p3[i]);
    const fits = (k) => {
      const d = (L0 * k - L0) / 2, sh = (p) => [p[0] - ux * d, p[1] - uy * d];
      const H = sh(a.head), T = [a.tail[0] + ux * d, a.tail[1] + uy * d];
      const pts = [[H[0] - ux * 9, H[1] - uy * 9], [T[0] + ux * 9, T[1] + uy * 9]];
      for (let i = 0; i <= 12; i++) {
        pts.push(bez(H, sh(a.c1[0]), sh(a.c1[1]), sh(a.c1[2]), i / 12));
        pts.push(bez(sh(a.c2[0]), sh(a.c2[1]), sh(a.c2[2]), H, i / 12));
      }
      return pts.every((p) => {
        const gx = a.x + m[0] * p[0] + m[2] * p[1], gy = a.y + m[1] * p[0] + m[3] * p[1];
        const lx = ell.m[0] * gx + ell.m[1] * gy, ly = ell.m[2] * gx + ell.m[3] * gy;   // into the oval's frame
        return (lx / rx) ** 2 + (ly / ry) ** 2 <= 1;
      });
    };
    let lo = 0.35, hi = 2;
    for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    return { min: 0.35, max: lo };
  }

  /* =========================================================
     UI class
     ========================================================= */
  class UI {
    constructor(root) {
      this.stage = root;
      this.bg = root.querySelector('.stage__bg');
      this.typeLayer = root.querySelector('#type-layer');
      this.tetherLayer = root.querySelector('#tether-layer');
      this.bodiesLayer = root.querySelector('#bodies');
      this.cornersLayer = root.querySelector('#corners');
      this.goodsLayer = root.querySelector('#goods');
      this.slider = root.querySelector('#circle-volume');
      this.live = root.querySelector('#live');
      this.layout = DESKTOP;
      this.vw = 0; this.vh = 0; this.kx = 1; this.ky = 1; this.s = 1;
      this.bodies = [];
      this.byId = {};
      this.goods = [];
      this.coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      this.GEOM = GEOM;
      this.LAYOUTS = { desktop: DESKTOP, mobile: MOBILE };
      this.buildBodies();
      this.buildCorners();
      this.buildTethers();
    }

    /* ---------------- construction ---------------- */
    buildBodies() {
      for (const def of BODY_DEFS) {
        const b = {
          id: def.id, kind: def.kind, type: def.type, fx: def.fx, def,
          el: el('div', 'body body--' + def.kind, this.bodiesLayer),
          off: { desktop: [0, 0], mobile: [0, 0] },
          vel: [0, 0], mode: 'rest', anchor: [0, 0],
          pulse: 0, jitter: 0, hover: false,
          px: { x: 0, y: 0, s: 1 }, last: '', rings: [], arrowAngle: 0, arrowLen: 1
        };
        b.el.dataset.id = def.id;
        b.el.tabIndex = 0;
        b.el.setAttribute('role', 'button');
        b.el.setAttribute('aria-label', def.label);
        b.el.setAttribute('aria-pressed', 'false');
        this['build_' + def.kind](b);
        this.bodies.push(b);
        this.byId[def.id] = b;
      }
    }

    build_circle(b) {
      const g = GEOM.circle;
      const ghost = part(b.el, g.main, 'ghost f-circle stroke round');
      ghost.style.setProperty('--gx', '22px'); ghost.style.setProperty('--gy', '-20px');
      b.main = part(b.el, g.main, 'main f-circle stroke round', 'body');
      // the arrow's bounding box is centred on the circle (Figma), so it turns around the circle's own axis
      b.arrowRot = el('div', 'arrow-rot', b.el);
      this.buildArrow(b, g.arrow, b.arrowRot);
      b.arrowAngle = 0;
      b.poly = GP.Collisions.ellipsePoly(g.main.w, g.main.h, g.main.m);
    }
    build_oval(b) {
      const g = GEOM.oval;
      const ghost = part(b.el, g.main, 'ghost f-oval stroke round');
      ghost.style.setProperty('--gx', '14px'); ghost.style.setProperty('--gy', '-12px');
      b.main = part(b.el, g.main, 'main f-oval stroke round', 'body');
      this.buildArrow(b, g.arrow);
      b.poly = GP.Collisions.ellipsePoly(g.main.w, g.main.h, g.main.m);
      b.arrowRange = ovalArrowRange(g.arrow, g.main);
    }
    buildArrow(b, a, parent) {
      const s = svg('svg', { class: 'arrow', width: r2(a.w), height: r2(a.h), viewBox: `0 0 ${r2(a.w)} ${r2(a.h)}` }, parent || b.el);
      s.style.left = r2(a.x) + 'px';
      s.style.top = r2(a.y) + 'px';
      s.style.transform = `matrix(${a.m[0]},${a.m[1]},${a.m[2]},${a.m[3]},0,0)`;
      const d = arrowPath(a, 0, 0);
      b.arrowHit = svg('path', { class: 'hit', d: `M${a.tail[0]} ${a.tail[1]}L${a.head[0]} ${a.head[1]}` }, s);
      b.arrowHit.dataset.part = 'arrow';
      b.arrowStem = svg('path', { class: 'stem', d }, s);
      b.arrowSvg = s;
      b.arrowGeom = a;
      b.arrowL0 = arrowLength(a);
    }
    /* circle: the arrow turns around the circle's centre (degrees, clockwise) */
    setArrowRotation(b, deg) {
      b.arrowAngle = deg;
      b.arrowRot.style.transform = `rotate(${r2(deg)}deg)`;
    }
    /* oval: grow / shrink symmetrically around the arrow midpoint; k = L / L0 */
    setArrowLength(b, k) {
      const a = b.arrowGeom;
      b.arrowLen = k;
      const L0 = b.arrowL0, d = (L0 * k - L0) / 2;
      b.arrowStem.setAttribute('d', arrowPath(a, -d, d));
      const ux = (a.tail[0] - a.head[0]) / L0, uy = (a.tail[1] - a.head[1]) / L0;
      b.arrowHit.setAttribute('d', `M${r2(a.tail[0] + ux * d)} ${r2(a.tail[1] + uy * d)}L${r2(a.head[0] - ux * d)} ${r2(a.head[1] - uy * d)}`);
    }

    buildFramed(b, g, fill) {
      b.ringBox = el('div', 'rings', b.el);
      for (let i = 3; i >= 1; i--) {
        const r = el('div', 'ring', b.ringBox);
        r.dataset.part = 'ring';
        r.dataset.ring = String(i);
        r.style.setProperty('--i', String(i - 1));
        b.rings[i] = r;
      }
      const ghost = part(b.el, g.main, 'ghost ' + fill + ' stroke');
      ghost.style.setProperty('--gx', '22px'); ghost.style.setProperty('--gy', '-20px');
      b.main = part(b.el, g.main, 'main ' + fill + ' stroke', 'body');
      b.inner = g.inner.map((p) => part(b.el, p, fill, 'body'));
      b.poly = GP.Collisions.rectPoly(g.main.w, g.main.h, g.main.m);
      b.frameGeom = g;
    }
    build_square(b) { this.buildFramed(b, GEOM.square, 'f-square'); }
    build_rect(b) { this.buildFramed(b, GEOM.rect, 'f-rect'); }

    /* ring geometry depends on the on-screen scale (band width in px stays usable) */
    layoutRings(b) {
      const g = b.frameGeom;
      const bandPx = this.coarse ? 30 : 22;
      const gap = bandPx / Math.max(0.1, b.px.s);
      for (let i = 1; i <= 3; i++) {
        const W = g.main.w + 2 * gap * i, H = g.main.h + 2 * gap * i;
        const shift = (W - g.main.w) * g.drift;
        placePart(b.rings[i], { w: W, h: H, cx: -g.slope[0] * shift, cy: -g.slope[1] * shift, m: g.main.m });
        b.rings[i].style.borderWidth = '';
      }
      // border widths must not scale down with the body
      const bw = 1 / Math.max(0.1, b.px.s);
      b.el.style.setProperty('--ring-bw', bw + 'px');
      b.ringBorderScale = bw;
      for (let i = 1; i <= 3; i++) {
        const active = b.rings[i].classList.contains('is-active');
        b.rings[i].style.borderWidth = (active ? 2 : 1) * bw + 'px';
      }
    }
    refreshRingBorders(b) {
      if (!b.rings.length) return;
      const bw = b.ringBorderScale || 1;
      for (let i = 1; i <= 3; i++) {
        const active = b.rings[i].classList.contains('is-active');
        b.rings[i].style.borderWidth = (active ? 2 : 1) * bw + 'px';
      }
    }

    build_capsule(b) {
      const g = GEOM.capsule;
      b.back = part(b.el, g.back, 'f-capsule stroke pill capsule-back', 'back');
      b.main = part(b.el, g.front, 'main f-capsule stroke pill capsule-front', 'front');
      b.dot = part(b.el, g.dot, 'f-ink round capsule-dot', 'front');
      b.el.style.setProperty('--dot-x', g.dotTravel[0] + 'px');
      b.el.style.setProperty('--dot-y', g.dotTravel[1] + 'px');
      b.el.style.setProperty('--spread-x', g.spread[0] + 'px');
      b.el.style.setProperty('--spread-y', g.spread[1] + 'px');
      b.poly = GP.Collisions.stadiumPoly(g.front.w, g.front.h, g.front.m);
    }

    build_fx(b) {
      const g = GEOM.fx;
      b.hitpad = el('div', 'hitpad', b.el);
      b.hitpad.dataset.part = 'body';
      const ghost = part(b.el, g.main, 'ghost f-circle stroke round');
      ghost.style.setProperty('--gx', '8px'); ghost.style.setProperty('--gy', '-8px');
      b.main = part(b.el, g.main, 'main f-circle stroke round', 'body');
      b.el.dataset.fx = b.fx;
      b.poly = GP.Collisions.ellipsePoly(g.main.w, g.main.h, g.main.m, 0, 0, 16);
    }

    buildCorners() {
      this.corners = CORNERS.map((c) => {
        const btn = el('button', 'corner', this.cornersLayer);
        btn.type = 'button';
        btn.dataset.action = c.id;
        btn.setAttribute('aria-label', c.label);
        btn.title = c.label;
        const s = svg('svg', { viewBox: '-30.0825 -30.0825 60.165 60.165', 'aria-hidden': 'true' }, btn);
        const t = svg('text', { x: c.dx, y: c.dy, 'text-anchor': 'middle', 'font-size': 52.16 }, s);
        t.textContent = c.ch;
        return { def: c, el: btn };
      });
    }

    buildTethers() {
      this.tethers = {
        circleOval: svg('path', { class: 'tether' }, this.tetherLayer),
        squareRect: svg('path', { class: 'tether' }, this.tetherLayer),
        dbl: []
      };
      this.tetherDash = 0;
    }

    /* ---------------- layout ---------------- */
    pickLayout(vw, vh) {
      const ratio = vw / vh;
      return ratio < 0.8 || (vw < 700 && ratio < 1.05) ? MOBILE : DESKTOP;
    }

    resize() {
      const r = this.stage.getBoundingClientRect();
      const vw = Math.max(1, r.width), vh = Math.max(1, r.height);
      const L = this.pickLayout(vw, vh);
      const changed = L !== this.layout || vw !== this.vw || vh !== this.vh;
      this.layout = L;
      this.vw = vw; this.vh = vh;
      this.kx = vw / L.W; this.ky = vh / L.H;
      this.s = Math.min(this.kx, this.ky);
      this.coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      this.stage.dataset.layout = L.name;

      // background radial field
      const bg = L.bg;
      this.bg.style.background =
        `radial-gradient(${r2(bg.rx * this.kx)}px ${r2(bg.ry * this.ky)}px at ${r2(bg.cx * this.kx)}px ${r2(bg.cy * this.ky)}px, var(--field-center) 0%, var(--field-edge) 100%)`;

      this.buildType();
      this.layoutCorners();
      for (const b of this.bodies) {
        this.computePx(b);
        if (b.rings.length) this.layoutRings(b);
        if (b.hitpad) {
          const d = Math.max(GEOM.fx.main.w + 16, 64 / Math.max(0.1, b.px.s));
          b.hitpad.style.width = b.hitpad.style.height = r2(d) + 'px';
          b.hitpad.style.left = b.hitpad.style.top = r2(-d / 2) + 'px';
        }
        b.last = '';
      }
      return changed;
    }

    gridLines() {
      const L = this.layout;
      return { xs: L.vLines.map((x) => x * this.kx), ys: L.hLines.map((y) => y * this.ky) };
    }

    buildType() {
      const L = this.layout, layer = this.typeLayer;
      while (layer.firstChild) layer.removeChild(layer.firstChild);
      layer.setAttribute('viewBox', `0 0 ${this.vw} ${this.vh}`);
      layer.setAttribute('width', this.vw);
      layer.setAttribute('height', this.vh);
      const s = this.s;
      for (const t of L.texts) {
        const g = svg('g', { transform: `translate(${r2(t.cx * this.kx)} ${r2(t.by * this.ky)}) scale(${s})` }, layer);
        const text = svg('text', {
          x: r2(-t.width / 2), y: 0, 'font-size': t.size,
          textLength: t.width, lengthAdjust: 'spacing'
        }, g);
        for (const [str, bold] of t.segs) {
          const sp = svg('tspan', bold ? { class: 'b' } : {}, text);
          sp.textContent = str;
        }
      }
      const G = L.goods;
      for (const [cx, by] of G.list) {
        const g = svg('g', { transform: `translate(${r2(cx * this.kx)} ${r2(by * this.ky)}) scale(${s})` }, layer);
        const text = svg('text', {
          class: 'b', x: r2(-G.width / 2), y: 0, 'font-size': G.size,
          textLength: G.width, lengthAdjust: 'spacing'
        }, g);
        text.textContent = 'good!';
      }
    }

    layoutCorners() {
      const cs = this.s * this.layout.cornerScale;
      const d = 60.165 * cs;
      for (const c of this.corners) {
        const a = c.def.anchor;
        const cx = a[1] === 'l' ? c.def.c[0] * cs : this.vw - c.def.c[0] * cs;
        const cy = a[0] === 't' ? c.def.c[1] * cs : this.vh - c.def.c[1] * cs;
        Object.assign(c.el.style, {
          width: r2(d) + 'px', height: r2(d) + 'px',
          left: r2(cx - d / 2) + 'px', top: r2(cy - d / 2) + 'px'
        });
      }
    }

    /* body position in px (+ uniform scale) */
    computePx(b) {
      const L = this.layout, home = L.bodies[b.id].home, off = b.off[L.name];
      b.px.x = (home[0] + off[0]) * this.kx;
      b.px.y = (home[1] + off[1]) * this.ky;
      b.px.s = this.s * L.bodies[b.id].s;
      return b.px;
    }
    homeOf(b) { return this.layout.bodies[b.id].home; }

    /* ---------------- per-frame render ---------------- */
    renderBody(b, t) {
      const p = this.computePx(b);
      // velocity squash & stretch (px/s)
      const vx = b.vel[0] * this.kx, vy = b.vel[1] * this.ky;
      const sp = Math.hypot(vx, vy);
      let a = p.s, bb = 0, c = 0, d = p.s;
      const k = Math.min(0.075, sp / 6500);
      const pulse = (1 + b.pulse) * (b.grow == null ? 1 : b.grow);
      if (k > 0.002) {
        const ux = vx / sp, uy = vy / sp;
        const s1 = 1 + k, s2 = 1 - k * 0.8;
        // R · diag(s1, s2) · Rᵀ
        a = (ux * ux * s1 + uy * uy * s2) * p.s;
        bb = ux * uy * (s1 - s2) * p.s;
        c = bb;
        d = (uy * uy * s1 + ux * ux * s2) * p.s;
      }
      a *= pulse; bb *= pulse; c *= pulse; d *= pulse;
      let jx = 0, jy = 0;
      if (b.jitter > 0.01) {
        jx = Math.sin(t * 47 + b.px.s * 9) * b.jitter * 1.6;
        jy = Math.cos(t * 53 + b.px.s * 5) * b.jitter * 1.6;
      }
      const tr = `translate3d(${r2(p.x + jx)}px,${r2(p.y + jy)}px,0) matrix(${a.toFixed(4)},${bb.toFixed(4)},${c.toFixed(4)},${d.toFixed(4)},0,0)`;
      if (tr !== b.last) { b.el.style.transform = tr; b.last = tr; }
    }

    renderTethers(state, dt) {
      this.tetherDash = (this.tetherDash - dt * 18) % 900;
      const T = this.tethers;
      const line = (path, A, B, on, bend) => {
        path.classList.toggle('is-on', on);
        if (!on && path.getAttribute('data-off') === '1') return;
        path.setAttribute('data-off', on ? '0' : '1');
        const mx = (A.px.x + B.px.x) / 2, my = (A.px.y + B.px.y) / 2 - bend;
        path.setAttribute('d', `M${r2(A.px.x)} ${r2(A.px.y)}Q${r2(mx)} ${r2(my)} ${r2(B.px.x)} ${r2(B.px.y)}`);
        path.style.strokeDashoffset = r2(this.tetherDash);
      };
      const by = this.byId, v = state.voices;
      line(T.circleOval, by.circle, by.oval, v.circle.on && v.oval.on, 40 * this.s);
      line(T.squareRect, by.square, by.rect, v.square.on && v.rect.on, 60 * this.s);

      // capsule → every doubled voice while the doubler is on
      const ids = Object.keys(v).filter((id) => v[id].doubled && by[id]);
      while (T.dbl.length < ids.length) T.dbl.push(svg('path', { class: 'tether' }, this.tetherLayer));
      T.dbl.forEach((p, i) => {
        const id = ids[i];
        if (!id) { p.classList.remove('is-on'); return; }
        line(p, by.capsule, by[id], state.doubler.on, -30 * this.s);
      });
    }

    placeSlider(visible, volume) {
      const s = this.slider;
      s.classList.toggle('is-visible', visible);
      if (!visible && !s._wasVisible) return;
      s._wasVisible = visible;
      const b = this.byId.circle;
      const rpx = (GEOM.circle.main.w / 2) * b.px.s;
      const w = s.offsetWidth || 44, h = s.offsetHeight || 150;
      let x = b.px.x + rpx + 18;
      if (x + w > this.vw - 6) x = b.px.x - rpx - 18 - w;
      const y = Math.max(8, Math.min(this.vh - h - 8, b.px.y - h / 2));
      s.style.transform = `translate(${r2(x)}px, ${r2(y)}px)`;
      const trackTop = 10, trackH = h - 32;
      s.querySelector('.vslider__knob').style.top = r2(trackTop + (1 - volume) * trackH) + 'px';
      s.querySelector('.vslider__fill').style.height = r2(volume * trackH) + 'px';
      s.setAttribute('aria-valuenow', String(Math.round(volume * 100)));
      s._track = { top: y + trackTop, h: trackH };
    }

    /* ---------------- good! ---------------- */
    spawnGood(x, y) {
      const MAX = 10;
      while (this.goods.length >= MAX) this.killGood(this.goods.shift(), true);
      const e = el('span', 'good-pop', this.goodsLayer);
      e.textContent = 'good!';
      const size = this.layout.goods.size * this.s * (0.55 + Math.random() * 0.5);
      const ang = Math.random() * Math.PI * 2, dist = (28 + Math.random() * 40) * Math.max(0.6, this.s);
      const gx = Math.max(10, Math.min(this.vw - 10, x + Math.cos(ang) * dist));
      const gy = Math.max(10, Math.min(this.vh - 10, y + Math.sin(ang) * dist * 0.7 - 20 * this.s));
      e.style.left = r2(gx) + 'px';
      e.style.top = r2(gy) + 'px';
      e.style.fontSize = r2(size) + 'px';
      e.style.setProperty('--rot', r2(-14 + Math.random() * 28) + 'deg');
      const item = { el: e, timer: 0 };
      item.timer = setTimeout(() => {
        const i = this.goods.indexOf(item);
        if (i >= 0) this.goods.splice(i, 1);
        this.killGood(item, false);
      }, 4200 + Math.random() * 600);
      this.goods.push(item);
    }
    killGood(item, fast) {
      clearTimeout(item.timer);
      item.el.classList.add('is-out');
      if (fast) item.el.classList.add('is-fast');
      setTimeout(() => item.el.remove(), fast ? 320 : 950);
    }
    clearGoods() {
      const all = this.goods.splice(0);
      all.forEach((g) => this.killGood(g, true));
    }

    announce(msg) {
      if (!this.live) return;
      this.live.textContent = '';
      setTimeout(() => { this.live.textContent = msg; }, 30);
    }
  }

  GP.UI = UI;
  GP.arrowLength = arrowLength;
})();
