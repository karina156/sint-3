/* =========================================================
   interactions.js — pointer gestures + motion physics
   · tap vs drag disambiguation (mouse / pen / touch, multi-touch)
   · drag = critically-under-damped spring to the finger (slight lag)
   · release = inertia with friction, soft bounce at the frame edge
   · intro nudge = impulse + spring back (overshoot)
   · arrow gestures: circle arrow turns around the centre (timbre),
     oval arrow length (phrase + volume), never leaving the oval
   · vertical volume slider for the circle, wheel on the circle
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const DRAG_K = 1300, DRAG_C = 58;        // follow spring
  const BACK_K = 120, BACK_C = 9.5;        // intro / return spring (underdamped → overshoot)
  const HOME_K = 70, HOME_C = 12;          // "z" reset spring
  const FRICTION = 3.4;                    // inertia decay (1/s)

  class Interactions {
    constructor(ui, handlers) {
      this.ui = ui;
      this.h = handlers;
      this.stage = ui.stage;
      this.gestures = new Map();
      this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this._down = this._down.bind(this);
      this._move = this._move.bind(this);
      this._up = this._up.bind(this);
      this.stage.addEventListener('pointerdown', this._down);
      window.addEventListener('pointermove', this._move, { passive: false });
      window.addEventListener('pointerup', this._up);
      window.addEventListener('pointercancel', this._up);

      for (const b of ui.bodies) {
        b.el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { b.hover = true; this.h.onHover(b, true); } });
        b.el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { b.hover = false; this.h.onHover(b, false); } });
      }
      // circle: wheel = volume
      ui.byId.circle.el.addEventListener('wheel', (e) => {
        e.preventDefault();
        this.h.onVolumeDelta(-e.deltaY * 0.0012);
      }, { passive: false });
      ui.slider.addEventListener('pointerenter', () => this.h.onSliderHover(true));
      ui.slider.addEventListener('pointerleave', () => this.h.onSliderHover(false));
    }

    stagePoint(e) {
      const r = this.stage.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    /* ---------------- pointer flow ---------------- */
    _down(e) {
      if (e.button !== undefined && e.button > 0) return;
      this.h.onAnyGesture();
      const [x, y] = this.stagePoint(e);

      if (e.target.closest('.corner')) return;          // corners use click

      if (e.target.closest('.vslider')) {
        e.preventDefault();
        this.gestures.set(e.pointerId, { kind: 'volume', x, y });
        this._volumeAt(y);
        return;
      }

      const partEl = e.target.closest('[data-part]');
      const bodyEl = e.target.closest('.body');
      if (!partEl || !bodyEl) {
        this.gestures.set(e.pointerId, { kind: 'background', x0: x, y0: y, moved: false });
        return;
      }
      const b = this.ui.byId[bodyEl.dataset.id];
      for (const g of this.gestures.values()) if (g.b === b) return;   // one finger per body
      e.preventDefault();
      try { bodyEl.setPointerCapture(e.pointerId); } catch (err) {}

      const part = partEl.dataset.part;
      const g = {
        kind: 'pending', b, part, ring: +partEl.dataset.ring || 0, partEl,
        x0: x, y0: y, x, y, moved: false,
        thresh: e.pointerType === 'touch' ? 9 : 5,
        samples: [[performance.now(), x, y]]
      };
      this.gestures.set(e.pointerId, g);
      partEl.classList.add('is-pressed');
    }

    _move(e) {
      const g = this.gestures.get(e.pointerId);
      if (!g) return;
      const [x, y] = this.stagePoint(e);

      if (g.kind === 'volume') { e.preventDefault(); this._volumeAt(y); return; }
      if (g.kind === 'background') {
        if (Math.hypot(x - g.x0, y - g.y0) > 10) g.moved = true;
        return;
      }
      e.preventDefault();
      const dx = x - g.x, dy = y - g.y;
      g.x = x; g.y = y;
      const now = performance.now();
      g.samples.push([now, x, y]);
      while (g.samples.length > 2 && now - g.samples[0][0] > 110) g.samples.shift();

      if (g.kind === 'pending') {
        if (Math.hypot(x - g.x0, y - g.y0) < g.thresh) return;
        g.moved = true;
        g.partEl.classList.remove('is-pressed');
        const b = g.b;
        if (g.part === 'arrow' && b.kind === 'circle') {
          g.kind = 'rotate';
          g.lastAng = Math.atan2(g.y0 - b.px.y, g.x0 - b.px.x);
          b.el.classList.add('is-turning');
        } else if (g.part === 'arrow' && b.kind === 'oval') {
          g.kind = 'length';
          g.startK = b.arrowLen;
          const p0 = this._ovalProj(b, g.x0, g.y0);
          g.side = p0 < 0 ? -1 : 1;                 // which end was grabbed
          g.startProj = Math.abs(p0);
        } else {
          g.kind = 'drag';
          const p = b.px;
          g.grab = [g.x0 - p.x, g.y0 - p.y];
          b.mode = 'drag';
          b.el.classList.add('is-dragging');
          this.h.onDragStart(b);
        }
      }

      const b = g.b, ui = this.ui;
      if (g.kind === 'drag') {
        const L = ui.layout, home = L.bodies[b.id].home;
        b.dragTarget = [(x - g.grab[0]) / ui.kx - home[0], (y - g.grab[1]) / ui.ky - home[1]];
      } else if (g.kind === 'rotate') {
        // turn around the circle's centre; ignore the unstable zone right at the centre
        if (Math.hypot(x - b.px.x, y - b.px.y) < 14) return;
        const ang = Math.atan2(y - b.px.y, x - b.px.x);
        let d = ang - g.lastAng;
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        g.lastAng = ang;
        this.h.onArrowRotate(b, b.arrowAngle + (d * 180) / Math.PI);
      } else if (g.kind === 'length') {
        const R = b.arrowRange;
        const proj = g.side * this._ovalProj(b, x, y);   // signed: crossing the middle keeps shrinking
        const want = g.startK + (2 * (proj - g.startProj)) / b.arrowL0;
        const k = clamp(want, R.min, R.max);
        // the arrow cannot leave the oval: a small bump tells the hand it hit the edge
        if (want > R.max + 0.01 && !g.atEdge) { g.atEdge = true; b.pulse = Math.max(b.pulse, 0.035); }
        if (want < R.max) g.atEdge = false;
        this.h.onArrowLength(b, k);
      }
    }

    _up(e) {
      const g = this.gestures.get(e.pointerId);
      if (!g) return;
      this.gestures.delete(e.pointerId);
      const [x, y] = this.stagePoint(e);
      if (g.kind === 'volume') return;
      if (g.kind === 'background') {
        if (!g.moved && e.type === 'pointerup') this.h.onBackgroundTap(x, y);
        return;
      }
      g.partEl.classList.remove('is-pressed');
      const b = g.b;
      if (g.kind === 'pending') {
        if (e.type === 'pointerup') this.h.onTap(b, g.part, g.ring, x, y);
        return;
      }
      if (g.kind === 'rotate') b.el.classList.remove('is-turning');
      if (g.kind === 'drag') {
        // release velocity from the last ~100 ms of samples
        const s = g.samples, a = s[0], z = s[s.length - 1];
        const dt = Math.max(16, z[0] - a[0]) / 1000;
        let vx = (z[1] - a[1]) / dt, vy = (z[2] - a[2]) / dt;
        if (performance.now() - z[0] > 90) { vx = 0; vy = 0; }      // finger rested before lifting
        const sp = Math.hypot(vx, vy), max = 2600;
        if (sp > max) { vx *= max / sp; vy *= max / sp; }
        b.vel = [vx / this.ui.kx, vy / this.ui.ky];
        b.mode = 'free';
        b.el.classList.remove('is-dragging');
        this.h.onDragEnd(b);
      }
    }

    _ovalProj(b, x, y) {
      const a = b.arrowGeom, m = a.m;
      const lx = (x - b.px.x) / b.px.s, ly = (y - b.px.y) / b.px.s;
      const mid = [(a.head[0] + a.tail[0]) / 2, (a.head[1] + a.tail[1]) / 2];
      const midB = [a.x + m[0] * mid[0] + m[2] * mid[1], a.y + m[1] * mid[0] + m[3] * mid[1]];
      const ux = a.tail[0] - a.head[0], uy = a.tail[1] - a.head[1], L = Math.hypot(ux, uy);
      const ax = (m[0] * ux + m[2] * uy) / L, ay = (m[1] * ux + m[3] * uy) / L;
      return (lx - midB[0]) * ax + (ly - midB[1]) * ay;
    }

    _volumeAt(y) {
      const t = this.ui.slider._track;
      if (!t) return;
      this.h.onVolume(clamp(1 - (y - t.top) / t.h, 0, 1));
    }

    /* ---------------- physics ---------------- */
    update(dt) {
      const ui = this.ui, L = ui.layout;
      const margin = 14;
      for (const b of ui.bodies) {
        const off = b.off[L.name], v = b.vel;
        if (b.mode === 'drag' && b.dragTarget) {
          const ax = -DRAG_K * (off[0] - b.dragTarget[0]) - DRAG_C * v[0];
          const ay = -DRAG_K * (off[1] - b.dragTarget[1]) - DRAG_C * v[1];
          v[0] += ax * dt; v[1] += ay * dt;
          off[0] += v[0] * dt; off[1] += v[1] * dt;
        } else if (b.mode === 'free') {
          const f = Math.exp(-FRICTION * dt);
          v[0] *= f; v[1] *= f;
          off[0] += v[0] * dt; off[1] += v[1] * dt;
          if (Math.hypot(v[0] * ui.kx, v[1] * ui.ky) < 6) { b.mode = 'rest'; v[0] = v[1] = 0; }
        } else if (b.mode === 'spring') {
          const k = b.springK || BACK_K, c = b.springC || BACK_C;
          const ax = -k * (off[0] - b.anchor[0]) - c * v[0];
          const ay = -k * (off[1] - b.anchor[1]) - c * v[1];
          v[0] += ax * dt; v[1] += ay * dt;
          off[0] += v[0] * dt; off[1] += v[1] * dt;
          if (Math.hypot(off[0] - b.anchor[0], off[1] - b.anchor[1]) < 0.05 && Math.hypot(v[0], v[1]) < 2) {
            off[0] = b.anchor[0]; off[1] = b.anchor[1]; v[0] = v[1] = 0; b.mode = 'rest';
          }
        }

        // keep the centre on the poster; soft bounce (restitution 0.45)
        if (b.mode !== 'rest') {
          const home = L.bodies[b.id].home;
          const minX = margin / ui.kx - home[0], maxX = (ui.vw - margin) / ui.kx - home[0];
          const minY = margin / ui.ky - home[1], maxY = (ui.vh - margin) / ui.ky - home[1];
          if (off[0] < minX) { off[0] = minX; if (v[0] < 0) v[0] *= -0.45; }
          if (off[0] > maxX) { off[0] = maxX; if (v[0] > 0) v[0] *= -0.45; }
          if (off[1] < minY) { off[1] = minY; if (v[1] < 0) v[1] *= -0.45; }
          if (off[1] > maxY) { off[1] = maxY; if (v[1] > 0) v[1] *= -0.45; }
        }

        b.pulse *= Math.exp(-11 * dt);
        if (b.pulse < 0.0005) b.pulse = 0;
      }
    }

    /* intro hint: every draggable body slips a little and springs back */
    intro() {
      if (this.reduced) return;
      const ui = this.ui;
      ui.bodies.forEach((b, i) => {
        setTimeout(() => {
          if (b.mode === 'drag') return;
          const off = b.off[ui.layout.name];
          const ang = Math.random() * Math.PI * 2;
          const mag = 170 + Math.random() * 60;                          // px/s
          b.anchor = [off[0], off[1]];
          b.vel = [(Math.cos(ang) * mag) / ui.kx, (Math.sin(ang) * mag) / ui.ky];
          b.springK = BACK_K; b.springC = BACK_C;
          b.mode = 'spring';
        }, 350 + i * 110);
      });
    }

    returnHome() {
      for (const b of this.ui.bodies) {
        if (b.mode === 'drag') continue;
        b.anchor = [0, 0];
        b.springK = HOME_K; b.springC = HOME_C;
        b.mode = 'spring';
      }
    }

    /* moved ⇢ the collision world needs an update */
    anyMoving() {
      for (const b of this.ui.bodies) if (b.mode !== 'rest' || b.pulse > 0) return true;
      return false;
    }
  }

  GP.Interactions = Interactions;
})();
