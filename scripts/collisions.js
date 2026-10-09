/* =========================================================
   collisions.js — convex-polygon overlap for the instruments
   Every shape is convex (circle, ellipse, rotated rect, stadium),
   so overlap area = Sutherland–Hodgman clip + shoelace area.
   Pairs are AABB-culled and only recomputed when something moved.
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  function signedArea(p) {
    let a = 0;
    for (let i = 0, n = p.length; i < n; i++) {
      const q = p[i], r = p[(i + 1) % n];
      a += q[0] * r[1] - r[0] * q[1];
    }
    return a / 2;
  }
  function normalize(p) { return signedArea(p) < 0 ? p.slice().reverse() : p; }

  /* local polygons (design units, relative to body centre) */
  function ellipsePoly(w, h, m, cx = 0, cy = 0, n = 28) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      const lx = (Math.cos(t) * w) / 2, ly = (Math.sin(t) * h) / 2;
      pts.push([cx + m[0] * lx + m[2] * ly, cy + m[1] * lx + m[3] * ly]);
    }
    return normalize(pts);
  }
  function rectPoly(w, h, m, cx = 0, cy = 0) {
    const c = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
    return normalize(c.map(([x, y]) => [cx + m[0] * x + m[2] * y, cy + m[1] * x + m[3] * y]));
  }
  function stadiumPoly(w, h, m, cx = 0, cy = 0, seg = 8) {
    const r = Math.min(w, h) / 2, pts = [];
    const vertical = h >= w;
    const half = (vertical ? h : w) / 2 - r;
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i <= seg; i++) {
        const t = Math.PI * (k + i / seg);
        let x, y;
        if (vertical) { x = Math.cos(t) * r; y = Math.sin(t) * r + (k ? -half : half); }
        else { x = Math.cos(t + Math.PI / 2) * r + (k ? half : -half); y = Math.sin(t + Math.PI / 2) * r; }
        pts.push([cx + m[0] * x + m[2] * y, cy + m[1] * x + m[3] * y]);
      }
    }
    return normalize(pts);
  }

  /* clip `subject` by convex `clip` (both positive orientation) */
  function clipPoly(subject, clip) {
    let out = subject;
    for (let i = 0, n = clip.length; i < n && out.length; i++) {
      const a = clip[i], b = clip[(i + 1) % n];
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const inside = (p) => ex * (p[1] - a[1]) - ey * (p[0] - a[0]) >= 0;
      const input = out; out = [];
      for (let j = 0, m = input.length; j < m; j++) {
        const p = input[j], q = input[(j + 1) % m];
        const pin = inside(p), qin = inside(q);
        if (pin) out.push(p);
        if (pin !== qin) {
          const dx = q[0] - p[0], dy = q[1] - p[1];
          const den = ex * dy - ey * dx;
          if (Math.abs(den) > 1e-9) {
            const t = (ey * (p[0] - a[0]) - ex * (p[1] - a[1])) / den;
            out.push([p[0] + dx * t, p[1] + dy * t]);
          }
        }
      }
    }
    return out;
  }

  class CollisionWorld {
    constructor() {
      this.items = [];          // { id, type, local, world, aabb, area }
      this.pairs = new Map();   // key → { a, b, ratio }
      this.dirty = true;
    }
    add(id, type, localPoly) {
      this.items.push({ id, type, local: localPoly, world: localPoly.map((p) => p.slice()), aabb: [0, 0, 0, 0], area: 1, key: '' });
      this.dirty = true;
    }
    /* tx, ty, s: body centre in px + uniform scale */
    update(id, tx, ty, s) {
      const it = this.items.find((x) => x.id === id);
      if (!it) return;
      const key = tx.toFixed(1) + ',' + ty.toFixed(1) + ',' + s.toFixed(4);
      if (key === it.key) return;
      it.key = key;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < it.local.length; i++) {
        const x = tx + it.local[i][0] * s, y = ty + it.local[i][1] * s;
        it.world[i][0] = x; it.world[i][1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      it.aabb[0] = x0; it.aabb[1] = y0; it.aabb[2] = x1; it.aabb[3] = y1;
      it.area = Math.abs(signedArea(it.world));
      this.dirty = true;
    }
    /* returns Map key → { a, b, typeA, typeB, ratio } ; ratio = overlap / smaller area */
    compute() {
      if (!this.dirty) return this.pairs;
      this.dirty = false;
      const items = this.items;
      const seen = new Set();
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const A = items[i], B = items[j];
          const key = A.id < B.id ? A.id + '|' + B.id : B.id + '|' + A.id;
          let ratio = 0;
          if (!(A.aabb[2] < B.aabb[0] || B.aabb[2] < A.aabb[0] || A.aabb[3] < B.aabb[1] || B.aabb[3] < A.aabb[1])) {
            const inter = clipPoly(A.world, B.world);
            if (inter.length > 2) ratio = Math.abs(signedArea(inter)) / Math.max(1, Math.min(A.area, B.area));
          }
          if (ratio > 0 || this.pairs.has(key)) {
            this.pairs.set(key, { a: A.id, b: B.id, typeA: A.type, typeB: B.type, ratio });
            seen.add(key);
          }
        }
      }
      return this.pairs;
    }
  }

  GP.Collisions = { CollisionWorld, ellipsePoly, rectPoly, stadiumPoly, clipPoly, signedArea };
})();
