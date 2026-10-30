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
          circle: { on: false, timbre: 0.5, volume: 0.7, angle: 0, doubled: false },
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
      this.placed = {};                 // last placement sent to the audio engine, per voice
      this.progRow = -1;

      this.ui = new GP.UI(this.stageEl);
      this.grid = new GP.Grid(this.stageEl.querySelector('#grid-canvas'));
      this.world = new GP.Collisions.CollisionWorld();
      for (const b of this.ui.bodies) this.world.add(b.id, b.type, b.poly);

      this.ix = new GP.Interactions(this.ui, {
        onAnyGesture: () => this.unlock(),
        onTap: (b, part, ring, x, y) => this.tap(b, part, ring, x, y),
        onDragStart: (b) => { this.resume(); b.touched = true; b.el.style.zIndex = ++this.zTop; },
        onDragEnd: () => {},
        onArrowRotate: (b, deg) => this.setArrowAngle(deg),
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

      this.story = new GP.Story(this);
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
      a.setOvalShape(this.ovalAmount());
      a.setLayers('square', v.square.layers);
      a.setLayers('rect', v.rect.layers);
      const dbl = {};
      for (const id of VOICE_IDS) dbl[id] = v[id].doubled;
      a.setDoubles(this.state.doubler.on, dbl);
      this.placed = {};                 // force every placement to be re-sent
      this.syncPlacement();
    }

    /* oval arrow length → 0..1 within the range that keeps it inside the oval */
    ovalAmount() {
      const R = this.ui.byId.oval.arrowRange;
      return clamp((this.state.voices.oval.length - R.min) / (R.max - R.min), 0, 1);
    }

    /* the poster is the score: x → pan + rhythmic rotation, y → register + depth,
       the circle's height chooses the progression */
    syncPlacement() {
      const a = this.audio, ui = this.ui;
      if (!a.ready || !ui.vw) return;
      const { xs, ys } = ui.gridLines();
      for (const id of VOICE_IDS) {
        const b = ui.byId[id];
        const x01 = clamp(b.px.x / ui.vw, 0, 1), y01 = clamp(b.px.y / ui.vh, 0, 1);
        const col = xs.filter((x) => x < b.px.x).length, row = ys.filter((y) => y < b.px.y).length;
        const last = this.placed[id];
        if (last && last.col === col && last.row === row && Math.abs(last.x01 - x01) < 0.004 && Math.abs(last.y01 - y01) < 0.004) continue;
        const p = { x01, y01, col, row };
        this.placed[id] = p;
        a.setPlacement(id, p);
      }
    }
    anyArmed() { return VOICE_IDS.some((id) => this.state.voices[id].on); }

    /* ---------------- instrument logic ---------------- */
    tap(b, part, ring, x, y) {
      this.story.beforeTap(b);
      const st = this.state, v = st.voices;
      const wasPaused = !st.scene.playing;
      const armedBefore = this.anyArmed();
      const before = this.voiceSnapshot();
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

      // state first, then the scene: a voice switched on from silence lands on the very first downbeat
      this.resume();
      if (part !== 'ring') b.pulse = Math.max(b.pulse, 0.05);   // frames must stay put under the finger
      this.ui.spawnGood(x, y);
      this.ui.announce(msg);
      this.syncAudio();
      this.markPending(before);
      this.story.afterTap(b);
      if (armedBefore && !this.anyArmed() && !wasPaused) this.audio.resolve();   // the last voice left: resolve
      this.refresh();
    }

    voiceSnapshot() {
      const o = {};
      for (const id of VOICE_IDS) o[id] = this.state.voices[id].on;
      return o;
    }
    /* a voice switched on/off waits for the next beat: blink until it lands */
    markPending(before) {
      if (!this.audio.ready) return;
      const now = this.audio.ctx.currentTime;
      for (const id of VOICE_IDS) {
        if (before[id] === this.state.voices[id].on) continue;
        const v = this.audio.voices[id], b = this.ui.byId[id];
        const at = this.state.voices[id].on ? v.onAt : v.offAt;
        const ms = Math.max(0, (at - now) * 1000);
        if (ms < 30) continue;
        b.el.classList.add('is-pending');
        clearTimeout(b.pendingTimer);
        b.pendingTimer = setTimeout(() => b.el.classList.remove('is-pending'), ms);
      }
    }

    setLayers(id, k) {
      const v = this.state.voices[id];
      if (!v.on) { v.on = true; v.layers = k; }
      else if (v.layers === k) { v.layers = k - 1; if (v.layers === 0) { v.on = false; v.layers = 1; } }
      else v.layers = k;
    }

    /* circle arrow turns like a dial: up (as in Figma) = middle timbre,
       clockwise → brighter, counter-clockwise → darker, all the way round */
    setArrowAngle(deg) {
      const c = this.state.voices.circle;
      c.angle = deg;
      c.timbre = 0.5 + 0.5 * Math.sin((deg * Math.PI) / 180);
      this.ui.setArrowRotation(this.ui.byId.circle, deg);
      if (this.audio.ready) this.audio.setTimbre(c.timbre);
    }
    setOvalLength(k) {
      const R = this.ui.byId.oval.arrowRange;
      k = clamp(k, R.min, R.max);
      this.state.voices.oval.length = k;
      this.ui.setArrowLength(this.ui.byId.oval, k);
      if (this.audio.ready) this.audio.setOvalShape(this.ovalAmount());
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
            case 'louder':
            case 'quieter': {
              // the top corners are the master volume: about ±2 dB per press
              this.unlock();
              const k = c.def.id === 'louder' ? 1.26 : 1 / 1.26;
              const v = Math.max(0.08, Math.min(1.3, (this.audio.userVolume || 0.85) * k));
              this.audio.setMasterVolume(v);
              this.ui.announce(`volume ${Math.round(v / 1.3 * 100)}%`);
              break;
            }
            case 'kill': {
              if (this.story.scene === 'light') { this.story.finale(); this.ui.announce('finale'); break; }
              const had = this.anyArmed();
              for (const id of VOICE_IDS) { st.voices[id].on = false; st.voices[id].doubled = false; }
              st.doubler.on = false;
              this.syncAudio();
              if (had && st.scene.playing) this.audio.resolve();
              this.ui.announce('all voices off');
              break;
            }
            case 'zero':
              this.story.restart(true);
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
            this.setArrowAngle(st.voices.circle.angle + (e.key === 'ArrowRight' ? 10 : -10));
          } else if (b.kind === 'oval' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            this.setOvalLength(st.voices.oval.length + (e.key === 'ArrowUp' ? 0.04 : -0.04));
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
      this.grid.resize(this.ui.vw, this.ui.vh, xs, ys, this.ui.cornerHoles());
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
      if (st.scene.playing) this.syncPlacement();

      // overlap → hybrid voices (fade in from first contact, full at ~35 %)
      const pairs = this.world.compute();
      const jit = {};
      pairs.forEach((p, key) => {
        // the poster's own overlaps (e.g. circle × square in Figma) stay neutral until the user moves one of the pair
        // …and only while one of the pair is sounding (the capsule sounds while the doubler is on),
        // so that switching everything off lets the piece end in silence
        const sounding = (id) => (id === 'capsule' ? st.doubler.on : !!(st.voices[id] && st.voices[id].on));
        const awake = (ui.byId[p.a].touched || ui.byId[p.b].touched) && (sounding(p.a) || sounding(p.b));
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

      // the story moves on when the two meet, merge, and give birth
      this.story.update(dt, pairs);

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
      this.story.onVisual(ev);
      if (ev.id === 'resolve') {                    // the closing chord: everything breathes once
        for (const x of this.ui.bodies) x.pulse = Math.max(x.pulse, 0.035);
        return;
      }
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
