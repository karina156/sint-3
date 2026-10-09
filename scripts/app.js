/* =========================================================
   app.js — state, instrument logic, screen manager, main loop
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

  /* =========================================================
     Screen manager — a screen is active when it covers > 60 %
     of the viewport. Only one screen may hold audio.
     ========================================================= */
  const Screens = {
    list: [],
    active: null,
    register(screen) { this.list.push(screen); this.schedule(); return screen; },
    claimAudio(owner) {
      for (const s of this.list) if (s !== owner && s.stopAudio) s.stopAudio();
    },
    occupancy(el) {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const visible = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      return visible / vh;
    },
    check() {
      this._raf = 0;
      let next = null;
      for (const s of this.list) {
        s.visibility = this.occupancy(s.el);
        if (s.visibility > 0.6) next = s;
      }
      if (next !== this.active) {
        const prev = this.active;
        this.active = next;
        if (prev && prev.onDeactivate) prev.onDeactivate();
        if (next && next.onActivate) next.onActivate();
      }
    },
    schedule() { if (!this._raf) this._raf = requestAnimationFrame(() => this.check()); }
  };
  window.addEventListener('scroll', () => Screens.schedule(), { passive: true });
  window.addEventListener('resize', () => Screens.schedule());
  GP.Screens = Screens;

  /* =========================================================
     Playground screen
     ========================================================= */
  const VOICE_IDS = ['circle', 'oval', 'square', 'rect', 'fx1', 'fx2', 'fx3'];
  const NAMES = { circle: 'circle', oval: 'oval', square: 'square', rect: 'rectangle', fx1: 'blip', fx2: 'beep', fx3: 'chirp' };

  class Playground {
    constructor(section) {
      this.el = section;
      this.stageEl = section.querySelector('.stage');
      this.audio = GP.audio;
      this.state = {
        voices: {
          circle: { on: false, timbre: 0.5, volume: 0.7, arrowOff: 0, doubled: false },
          oval: { on: false, length: 1, doubled: false },
          square: { on: false, layers: 1, doubled: false },
          rect: { on: false, layers: 1, doubled: false },
          fx1: { on: false, doubled: false },
          fx2: { on: false, doubled: false },
          fx3: { on: false, doubled: false }
        },
        doubler: { on: false },
        selected: null,
        scene: { active: false, playing: false }
      };
      this.introDone = false;
      this.sliderHover = false;
      this.circleHover = false;
      this.sliderTimer = 0;
      this.zTop = 10;
      this.hybridLevels = new Map();

      this.ui = new GP.UI(this.stageEl);
      this.grid = new GP.Grid(this.stageEl.querySelector('#grid-canvas'));
      this.world = new GP.Collisions.CollisionWorld();
      for (const b of this.ui.bodies) this.world.add(b.id, b.type, b.poly);

      this.ix = new GP.Interactions(this.ui, {
        onAnyGesture: () => this.unlock(),
        onTap: (b, part, ring, x, y) => this.tap(b, part, ring, x, y),
        onDragStart: (b) => { this.resume(); b.touched = true; b.el.style.zIndex = ++this.zTop; },
        onDragEnd: () => {},
        onArrowSlide: (b, u, t) => this.setTimbre(u, t),
        onArrowLength: (b, k) => this.setOvalLength(k),
        onVolume: (v) => this.setCircleVolume(v),
        onVolumeDelta: (d) => { this.setCircleVolume(this.state.voices.circle.volume + d); this.flashSlider(); },
        onBackgroundTap: () => { this.state.selected = null; this.refresh(); },
        onHover: (b, on) => {
          if (b.id === 'circle') {
            clearTimeout(this.sliderTimer);
            if (on) this.circleHover = true;
            else this.sliderTimer = setTimeout(() => { this.circleHover = false; }, 650);
          }
          this.refresh();
        },
        onSliderHover: (on) => {
          this.sliderHover = on;
          if (on) clearTimeout(this.sliderTimer);
        }
      });

      this.audio.onReady = () => this.syncAudio();
      this.bindCorners();
      this.bindKeys();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(this.stageEl);
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.state.scene.playing) this.pause(250);
      });
      this.refresh();

      this.last = performance.now();
      this.time = 0;
      requestAnimationFrame((t) => this.frame(t));
    }

    /* ---------------- screen hooks ---------------- */
    onActivate() {
      this.state.scene.active = true;
      if (!this.introDone) { this.introDone = true; this.ix.intro(); }
      this.refresh();          // sound does NOT restart by itself; "+" starts calling if voices are armed
    }
    onDeactivate() {
      this.state.scene.active = false;
      this.pause(480);         // 300–600 ms fade
      this.ui.clearGoods();
      this.refresh();
    }
    stopAudio() { if (this.state.scene.playing) this.pause(400); }

    /* ---------------- audio state ---------------- */
    unlock() { this.audio.ensure(); }

    resume() {
      if (!this.state.scene.active) return false;
      const ctx = this.audio.ensure();
      if (!ctx) return false;
      if (!this.state.scene.playing) {
        Screens.claimAudio(this);
        this.state.scene.playing = true;
        this.syncAudio();
        this.audio.startScene();
      }
      return true;
    }
    pause(ms) {
      this.state.scene.playing = false;
      this.audio.stopScene(ms);
      this.refresh();
    }

    syncAudio() {
      const a = this.audio, v = this.state.voices;
      if (!a.ready) return;
      for (const id of VOICE_IDS) a.setVoiceOn(id, v[id].on);
      a.setTimbre(v.circle.timbre);
      a.setVolume('circle', v.circle.volume);
      a.setVolume('oval', this.ovalVolume());
      a.setLayers('square', v.square.layers);
      a.setLayers('rect', v.rect.layers);
      const dbl = {};
      for (const id of VOICE_IDS) dbl[id] = v[id].doubled;
      a.setDoubles(this.state.doubler.on, dbl);
    }

    ovalVolume() { return clamp((this.state.voices.oval.length - 0.35) / 1.1, 0, 1); }
    anyArmed() { return VOICE_IDS.some((id) => this.state.voices[id].on); }

    /* ---------------- instrument logic ---------------- */
    tap(b, part, ring, x, y) {
      const st = this.state, v = st.voices;
      const wasPaused = !st.scene.playing;
      const armedBefore = this.anyArmed();
      this.resume();
      let msg = '';

      if (b.kind === 'capsule') {
        if (part === 'back') {
          const target = st.selected && v[st.selected] ? st.selected : 'circle';
          v[target].doubled = !v[target].doubled;
          if (v[target].doubled && !st.doubler.on) st.doubler.on = true;
          msg = `doubling ${v[target].doubled ? 'added to' : 'removed from'} ${NAMES[target]}`;
        } else {
          st.doubler.on = !st.doubler.on;
          msg = `doubler ${st.doubler.on ? 'on' : 'off'}`;
        }
      } else {
        const voice = v[b.id];
        const justResume = wasPaused && armedBefore && voice.on;     // returning: first tap only brings sound back
        if ((b.kind === 'square' || b.kind === 'rect') && part === 'ring' && ring) {
          this.setLayers(b.id, ring);
        } else if (!justResume) {
          voice.on = !voice.on;
          if (voice.layers !== undefined && voice.on) voice.layers = Math.max(1, voice.layers);
        }
        st.selected = b.id;
        msg = `${NAMES[b.id]} ${voice.on ? 'on' : 'off'}` + (voice.layers !== undefined && voice.on ? `, ${voice.layers} layer${voice.layers > 1 ? 's' : ''}` : '');
      }

      if (part !== 'ring') b.pulse = Math.max(b.pulse, 0.05);   // frames must stay put under the finger
      this.ui.spawnGood(x, y);
      this.ui.announce(msg);
      this.syncAudio();
      this.refresh();
    }

    setLayers(id, k) {
      const v = this.state.voices[id];
      if (!v.on) { v.on = true; v.layers = k; }
      else if (v.layers === k) { v.layers = k - 1; if (v.layers === 0) { v.on = false; v.layers = 1; } }
      else v.layers = k;
    }

    setTimbre(u, t) {
      const c = this.state.voices.circle;
      c.arrowOff = u; c.timbre = t;
      this.ui.setArrowOffset(this.ui.byId.circle, u);
      if (this.audio.ready) this.audio.setTimbre(t);
    }
    setOvalLength(k) {
      this.state.voices.oval.length = k;
      this.ui.setArrowLength(this.ui.byId.oval, k);
      if (this.audio.ready) this.audio.setVolume('oval', this.ovalVolume());
    }
    setCircleVolume(vol) {
      const c = this.state.voices.circle;
      c.volume = clamp(vol, 0, 1);
      if (this.audio.ready) this.audio.setVolume('circle', c.volume);
    }
    flashSlider() {
      this.circleHover = true;
      clearTimeout(this.sliderTimer);
      this.sliderTimer = setTimeout(() => { this.circleHover = false; }, 1200);
    }

    /* ---------------- classes / visual state ---------------- */
    refresh() {
      const st = this.state, v = st.voices, ui = this.ui;
      const coarse = ui.coarse;
      for (const b of ui.bodies) {
        const cl = b.el.classList;
        if (b.kind === 'capsule') {
          cl.toggle('is-on', st.doubler.on);
          const target = st.selected && v[st.selected] ? st.selected : 'circle';
          cl.toggle('is-spread', !!v[target].doubled);
          b.el.setAttribute('aria-pressed', String(st.doubler.on));
          continue;
        }
        const voice = v[b.id];
        cl.toggle('is-on', voice.on);
        cl.toggle('is-selected', st.selected === b.id);
        cl.toggle('is-doubled', !!voice.doubled);
        b.el.setAttribute('aria-pressed', String(voice.on));
        if (b.rings.length) {
          cl.toggle('show-rings', b.hover || (coarse && st.selected === b.id));
          for (let i = 1; i <= 3; i++) b.rings[i].classList.toggle('is-active', voice.on && i <= voice.layers);
          ui.refreshRingBorders(b);
        }
      }
      this.stageEl.classList.toggle('doubler-off', !st.doubler.on);
      const play = ui.corners.find((c) => c.def.id === 'play');
      play.el.classList.toggle('is-calling', st.scene.active && !st.scene.playing && this.anyArmed());
    }

    /* ---------------- corners ---------------- */
    bindCorners() {
      for (const c of this.ui.corners) {
        c.el.addEventListener('click', (e) => {
          const r = this.stageEl.getBoundingClientRect();
          const x = e.clientX ? e.clientX - r.left : c.el.offsetLeft;
          const y = e.clientY ? e.clientY - r.top : c.el.offsetTop;
          const st = this.state;
          switch (c.def.id) {
            case 'play':
              this.unlock();
              if (!this.anyArmed()) { st.voices.circle.on = true; }
              this.resume();
              this.syncAudio();
              this.ui.announce('scene playing');
              break;
            case 'pause':
              this.pause(450);
              this.ui.announce('scene paused');
              break;
            case 'kill':
              for (const id of VOICE_IDS) { st.voices[id].on = false; st.voices[id].doubled = false; }
              st.doubler.on = false;
              this.syncAudio();
              this.ui.announce('all voices off');
              break;
            case 'zero':
              this.ix.returnHome();
              for (const b of this.ui.bodies) b.touched = false;
              this.ui.announce('shapes return home');
              break;
          }
          this.ui.spawnGood(x, y);
          this.refresh();
        });
      }
    }

    /* ---------------- keyboard ---------------- */
    bindKeys() {
      for (const b of this.ui.bodies) {
        b.el.addEventListener('keydown', (e) => {
          const c = () => [b.px.x, b.px.y];
          const st = this.state;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.unlock();
            this.tap(b, b.kind === 'capsule' && e.shiftKey ? 'back' : 'body', 0, ...c());
          } else if ((b.kind === 'square' || b.kind === 'rect') && /^[1-3]$/.test(e.key)) {
            this.unlock();
            this.tap(b, 'ring', +e.key, ...c());
          } else if (b.kind === 'circle' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            this.setCircleVolume(st.voices.circle.volume + (e.key === 'ArrowUp' ? 0.05 : -0.05));
            this.flashSlider();
          } else if (b.kind === 'circle' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            const R = GP.ARROW_RANGE;
            const u = clamp(st.voices.circle.arrowOff + (e.key === 'ArrowLeft' ? 5 : -5), -R, R);
            this.setTimbre(u, (R - u) / (2 * R));
          } else if (b.kind === 'oval' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            this.setOvalLength(clamp(st.voices.oval.length + (e.key === 'ArrowUp' ? 0.05 : -0.05), 0.35, 1.45));
          } else if (e.key === 'Escape') {
            st.selected = null; this.refresh();
          }
        });
      }
    }

    /* ---------------- layout ---------------- */
    resize() {
      this.ui.resize();
      for (const b of this.ui.bodies) b.el.style.setProperty('--bw', (1 / Math.max(0.1, b.px.s)).toFixed(3) + 'px');
      const { xs, ys } = this.ui.gridLines();
      this.grid.resize(this.ui.vw, this.ui.vh, xs, ys);
      this.refresh();
      Screens.schedule();
    }

    /* ---------------- frame loop ---------------- */
    frame(now) {
      requestAnimationFrame((t) => this.frame(t));
      const dt = Math.min(0.033, Math.max(0.001, (now - this.last) / 1000));
      this.last = now;
      this.time += dt;
      if (this.visibility === 0 && !this.state.scene.playing) return;     // off-screen: idle

      const ui = this.ui, st = this.state;
      this.ix.update(dt);
      for (const b of ui.bodies) {
        ui.renderBody(b, this.time);
        this.world.update(b.id, b.px.x, b.px.y, b.px.s);
      }

      // overlap → hybrid voices (fade in from first contact, full at ~35 %)
      const pairs = this.world.compute();
      const jit = {};
      pairs.forEach((p, key) => {
        // the poster's own overlaps (e.g. circle × square in Figma) stay neutral until the user moves one of the pair
        const awake = ui.byId[p.a].touched || ui.byId[p.b].touched;
        const target = awake ? smoothstep(0, 0.35, p.ratio) : 0;
        const prev = this.hybridLevels.get(key) || 0;
        const lvl = prev + (target - prev) * Math.min(1, dt * 6);
        this.hybridLevels.set(key, lvl);
        if (lvl > (jit[p.a] || 0)) jit[p.a] = lvl;
        if (lvl > (jit[p.b] || 0)) jit[p.b] = lvl;
        if (st.scene.playing && this.audio.ready) this.audio.updateHybrid(key, p.typeA, p.typeB, lvl);
        if (p.ratio === 0 && lvl < 0.001 && !this.audio.hybrids.has(key)) { pairs.delete(key); this.hybridLevels.delete(key); }
      });
      for (const b of ui.bodies) {
        const target = (jit[b.id] || 0) * (st.scene.playing ? 1 : 0.25);
        b.jitter += (target - b.jitter) * Math.min(1, dt * 8);
      }

      // audio-scheduled visual events
      this.audio.drainVisual((ev) => this.onVisual(ev));

      // grid reacts to the real master output
      const levels = this.audio.analyse();
      this.grid.draw(dt, levels);
      const lv = levels.level;
      if (st.voices.circle.on) ui.byId.circle.pulse = Math.max(ui.byId.circle.pulse, lv * 0.018);
      if (st.voices.oval.on) ui.byId.oval.pulse = Math.max(ui.byId.oval.pulse, lv * 0.012);

      ui.renderTethers(st, dt);
      const showSlider = this.circleHover || this.sliderHover || st.selected === 'circle';
      ui.placeSlider(showSlider && st.scene.active, st.voices.circle.volume);
    }

    onVisual(ev) {
      const b = this.ui.byId[ev.id];
      if (!b) return;
      if (ev.id === 'square' || ev.id === 'rect') {
        b.pulse = Math.max(b.pulse, 0.03 * ev.vel);
        const r = b.rings[Math.min(3, ev.layer)];
        if (r && r.classList.contains('is-active') && r.animate) {
          r.animate([{ scale: '1.045' }, { scale: '1' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' });
        }
      } else if (ev.id.startsWith('fx')) {
        b.pulse = Math.max(b.pulse, 0.14);
      } else if (ev.id === 'oval') {
        b.pulse = Math.max(b.pulse, 0.025);
      }
    }
  }

  /* =========================================================
     boot
     ========================================================= */
  function boot() {
    const pgEl = document.getElementById('playground');
    const pg = new Playground(pgEl);
    Screens.register({
      el: pgEl,
      get visibility() { return pg.visibility; },
      set visibility(v) { pg.visibility = v; },
      onActivate: () => pg.onActivate(),
      onDeactivate: () => pg.onDeactivate(),
      stopAudio: () => pg.stopAudio()
    });
    // the next screen has no audio of its own yet, but it participates in the
    // one-active-screen rule (activating it silences the playground)
    const next = document.getElementById('screen-2');
    if (next) Screens.register({ el: next, visibility: 0 });
    GP.playground = pg;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
