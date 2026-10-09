/* =========================================================
   grid.js — the background grid, drawn on Canvas
   Line positions come from the Figma frame. The grid reacts to the
   real master output (AnalyserNode):
     · jitter            ← overall level
     · soft line bends   ← overall level (slow travelling wave)
     · cell "breathing"  ← per-cell frequency band (cells scale from centre)
   Calm when quiet, livelier when loud, displacement is capped so the
   composition never breaks.
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  class Grid {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.w = 0; this.h = 0; this.dpr = 1;
      this.xs = []; this.ys = [];
      this.cells = [];
      this.t = 0;
      this.quietFrames = 0;
      this.needsDraw = true;
      this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.color = '#2e2e2e';
    }

    resize(w, h, xs, ys) {
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = w; this.h = h;
      this.canvas.width = Math.round(w * this.dpr);
      this.canvas.height = Math.round(h * this.dpr);
      this.xs = xs.slice(); this.ys = ys.slice();
      // cells = rectangles between consecutive lines (and the frame edges)
      const cx = [0].concat(xs, [w]), cy = [0].concat(ys, [h]);
      this.cells = [];
      let k = 0;
      for (let i = 0; i < cx.length - 1; i++) {
        for (let j = 0; j < cy.length - 1; j++) {
          const x0 = cx[i], x1 = cx[i + 1], y0 = cy[j], y1 = cy[j + 1];
          if (x1 - x0 < 2 || y1 - y0 < 2) continue;
          this.cells.push({
            cx: (x0 + x1) / 2, cy: (y0 + y1) / 2,
            hw: (x1 - x0) / 2, hh: (y1 - y0) / 2,
            band: (k * 5 + 3) % 8,                 // spread bands across the poster
            phase: Math.random() * Math.PI * 2,
            e: 0
          });
          k++;
        }
      }
      this.needsDraw = true;
    }

    /* displacement field at (x, y) */
    _disp(x, y, out, level) {
      let dx = 0, dy = 0;
      const t = this.t;
      // 1 · cell breathing: push away from centres of energetic cells
      const cells = this.cells;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        if (c.e < 0.01) continue;
        const nx = (x - c.cx) / c.hw, ny = (y - c.cy) / c.hh;
        const d2 = nx * nx + ny * ny;
        if (d2 > 4.5) continue;
        const fall = Math.exp(-d2 * 0.9);
        const k = c.e * 0.07 * fall;
        dx += (x - c.cx) * k;
        dy += (y - c.cy) * k;
      }
      // 2 · slow travelling bend
      const bend = level * 5;
      dx += Math.sin(t * 1.3 + y * 0.0062 + x * 0.0011) * bend;
      dy += Math.sin(t * 1.1 + x * 0.0058 + y * 0.0013 + 1.7) * bend;
      // 3 · fine jitter
      const j = level * level * 1.6;
      dx += Math.sin(t * 31 + y * 0.09) * j;
      dy += Math.cos(t * 27 + x * 0.08) * j;
      // cap
      const mag = Math.hypot(dx, dy), cap = 16;
      if (mag > cap) { dx *= cap / mag; dy *= cap / mag; }
      out[0] = dx; out[1] = dy;
    }

    draw(dt, levels) {
      const level = this.reduced ? levels.level * 0.35 : levels.level;
      this.t += dt * (0.6 + level * 1.4);

      // per-cell energy follows its band, gated by overall level
      let active = level > 0.004;
      for (let i = 0; i < this.cells.length; i++) {
        const c = this.cells[i];
        const target = levels.bands[c.band] * Math.min(1, level * 2.2) * (0.75 + 0.25 * Math.sin(this.t * 2 + c.phase));
        c.e += (target - c.e) * (target > c.e ? 0.35 : 0.07);
        if (c.e > 0.004) active = true;
      }
      if (!active) {
        this.quietFrames++;
        if (!this.needsDraw && this.quietFrames > 2) return;   // grid is at rest: skip redraw
      } else this.quietFrames = 0;
      this.needsDraw = false;

      const g = this.ctx, dpr = this.dpr;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, this.w, this.h);
      g.strokeStyle = this.color;
      g.lineWidth = 1;
      g.lineJoin = 'round';

      const d = [0, 0];
      const SEG = 22;
      const calm = !active;
      g.beginPath();
      for (const x of this.xs) {
        const X = Math.round(x) + 0.5;
        if (calm) { g.moveTo(X, -2); g.lineTo(X, this.h + 2); continue; }
        const n = Math.ceil((this.h + 4) / SEG);
        for (let i = 0; i <= n; i++) {
          const y = -2 + (i / n) * (this.h + 4);
          this._disp(X, y, d, level);
          if (i === 0) g.moveTo(X + d[0], y + d[1] * 0.35); else g.lineTo(X + d[0], y + d[1] * 0.35);
        }
      }
      for (const y of this.ys) {
        const Y = Math.round(y) + 0.5;
        if (calm) { g.moveTo(-2, Y); g.lineTo(this.w + 2, Y); continue; }
        const n = Math.ceil((this.w + 4) / SEG);
        for (let i = 0; i <= n; i++) {
          const x = -2 + (i / n) * (this.w + 4);
          this._disp(x, Y, d, level);
          if (i === 0) g.moveTo(x + d[0] * 0.35, Y + d[1]); else g.lineTo(x + d[0] * 0.35, Y + d[1]);
        }
      }
      g.stroke();
    }
  }

  GP.Grid = Grid;
})();
