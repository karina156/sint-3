/* =========================================================
   audio.js — Web Audio engine for the playground
   - one AudioContext, one master chain with AnalyserNode
   - lookahead transport (16th steps) shared by every voice
   - voices: soft pad (circle), arp (oval), percussion (square),
     glitch percussion (rect), 4 FX loop characters (small circles)
   - per-voice doubler (modulated short delay + pan = detuned copy)
   - hybrid voices created on demand for overlapping shapes
   All gain moves are ramped → no clicks / pops.
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  const BPM = 112;
  const STEP = 60 / BPM / 4;               // 16th note
  const LOOKAHEAD = 0.12;                   // seconds scheduled ahead
  const TICK_MS = 25;

  // A-minor progression: Am – F – C – G (two bars each)
  const ROOTS = [110.0, 87.307, 130.813, 97.999];
  const THIRDS = [3, 4, 4, 4];
  const PENTA = [0, 3, 5, 7, 10, 12, 15, 17];   // A minor pentatonic (semitones)
  const A5 = 880;

  const semi = (f, s) => f * Math.pow(2, s / 12);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* smooth param move (exponential approach, click-free) */
  function glide(param, value, ctx, tau = 0.03, at) {
    const t = at != null ? at : ctx.currentTime;
    try {
      param.cancelScheduledValues(t);
      param.setTargetAtTime(value, t, tau);
    } catch (e) { param.value = value; }
  }
  /* linear ramp from the current value (for scene fades) */
  function rampTo(param, value, ctx, seconds) {
    const t = ctx.currentTime;
    const cur = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }

  /* -------------------------------------------------------
     Voice base: out → dry → bus,  out → doubler → bus
     ------------------------------------------------------- */
  class Voice {
    constructor(engine, id) {
      this.engine = engine;
      this.id = id;
      this.on = false;
      const ctx = engine.ctx;
      this.gate = ctx.createGain();   // on/off fade
      this.gate.gain.value = 0;
      this.vol = ctx.createGain();    // user volume
      this.vol.gain.value = 0.7;
      this.out = ctx.createGain();
      this.gate.connect(this.vol).connect(this.out);
      this.out.connect(engine.bus);

      // doubler: ~22 ms delay, slowly modulated (→ slight detune), panned right
      this.dblDelay = ctx.createDelay(0.1);
      this.dblDelay.delayTime.value = 0.022;
      this.dblLfo = ctx.createOscillator();
      this.dblLfo.frequency.value = 0.37 + Math.random() * 0.2;
      this.dblLfoAmt = ctx.createGain();
      this.dblLfoAmt.gain.value = 0.0028;
      this.dblLfo.connect(this.dblLfoAmt).connect(this.dblDelay.delayTime);
      this.dblLfo.start();
      this.dblGain = ctx.createGain();
      this.dblGain.gain.value = 0;
      this.dblPan = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
      if (this.dblPan.pan) this.dblPan.pan.value = 0.45;
      this.out.connect(this.dblDelay).connect(this.dblGain).connect(this.dblPan).connect(engine.bus);
    }
    setOn(on) {
      this.on = !!on;
      glide(this.gate.gain, this.on ? 1 : 0, this.engine.ctx, this.on ? 0.06 : 0.09);
    }
    setVolume(v) { glide(this.vol.gain, v, this.engine.ctx, 0.04); }
    setDouble(active) { glide(this.dblGain.gain, active ? 0.8 : 0, this.engine.ctx, 0.08); }
    step() {}
    chord() {}
  }

  /* -------- circle: soft synth (sine / triangle pad) -------- */
  class PadVoice extends Voice {
    constructor(engine) {
      super(engine, 'circle');
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 900;
      this.filter.Q.value = 2;
      this.shape = ctx.createGain();
      this.shape.gain.value = 0.32;
      this.filter.connect(this.shape).connect(this.gate);

      const mk = (type, detune, gain) => {
        const o = ctx.createOscillator();
        o.type = type; o.detune.value = detune;
        const g = ctx.createGain(); g.gain.value = gain;
        o.connect(g).connect(this.filter); o.start();
        return { o, g };
      };
      this.root = mk('sine', -4, 0.5);
      this.fifth = mk('triangle', 3, 0.22);
      this.third = mk('sine', 5, 0.16);
      this.bright = mk('sawtooth', 7, 0.0);
      this.sub = mk('sine', 0, 0.22);

      // slow filter drift so the pad breathes
      this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.09;
      this.lfoAmt = ctx.createGain(); this.lfoAmt.gain.value = 110;
      this.lfo.connect(this.lfoAmt).connect(this.filter.frequency); this.lfo.start();

      this.timbre = 0.5;
      this.chord(0, ctx.currentTime);
      this.setTimbre(0.5);
    }
    chord(i, t) {
      const r = ROOTS[i], ctx = this.engine.ctx;
      glide(this.root.o.frequency, r * 2, ctx, 0.12, t);
      glide(this.fifth.o.frequency, r * 3, ctx, 0.12, t);
      glide(this.third.o.frequency, semi(r * 4, THIRDS[i]), ctx, 0.12, t);
      glide(this.bright.o.frequency, r * 2, ctx, 0.12, t);
      glide(this.sub.o.frequency, r, ctx, 0.12, t);
    }
    /* t: 0 = dark/round … 1 = bright/edgy */
    setTimbre(t) {
      this.timbre = t = clamp(t, 0, 1);
      const ctx = this.engine.ctx;
      glide(this.filter.frequency, 260 * Math.pow(13, t), ctx, 0.05);
      glide(this.filter.Q, 0.7 + t * 5.5, ctx, 0.05);
      glide(this.root.g.gain, 0.55 - 0.25 * t, ctx, 0.05);
      glide(this.fifth.g.gain, 0.14 + 0.24 * t, ctx, 0.05);
      glide(this.third.g.gain, 0.1 + 0.14 * t, ctx, 0.05);
      glide(this.bright.g.gain, 0.16 * t * t, ctx, 0.05);
      glide(this.lfoAmt.gain, 60 + 260 * t, ctx, 0.2);
      if (this.engine.voices.oval) this.engine.voices.oval.follow(t);
    }
    setVolume(v) { glide(this.vol.gain, v * v, this.engine.ctx, 0.05); }
  }

  /* -------- oval: child of circle — slow shimmering arp -------- */
  class ArpVoice extends Voice {
    constructor(engine) {
      super(engine, 'oval');
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 2400;
      this.filter.Q.value = 1.2;
      this.filter.connect(this.gate);
      this.pattern = [0, 1, 2, 3, 2, 1, 3, 4];
      this.idx = 0;
    }
    follow(t) { glide(this.filter.frequency, 900 + 3800 * t, this.engine.ctx, 0.08); }
    setVolume(v) { glide(this.vol.gain, clamp(v, 0, 1) * 0.9, this.engine.ctx, 0.04); }
    step(s, t, chordIndex) {
      if (!this.on || s % 2) return;
      const ctx = this.engine.ctx;
      const r = ROOTS[chordIndex];
      const tones = [r * 4, semi(r * 4, THIRDS[chordIndex]), r * 6, r * 8, semi(r * 8, THIRDS[chordIndex])];
      const f = tones[this.pattern[this.idx++ % this.pattern.length]];
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.001;
      const g = ctx.createGain(); g.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.25;
      o.connect(g); o2.connect(g2).connect(g); g.connect(this.filter);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.16, t + 0.02);
      g.gain.setTargetAtTime(0, t + 0.03, 0.16);
      o.start(t); o2.start(t); o.stop(t + 1.1); o2.stop(t + 1.1);
      this.engine.visual(t, 'oval', 0, 0.6);
    }
  }

  /* -------- square: percussive synth with layer density -------- */
  class PercVoice extends Voice {
    constructor(engine) {
      super(engine, 'square');
      this.layers = 1;
      this.vol.gain.value = 0.85;
    }
    hits(s) {               // which steps play for the current layer count
      if (this.layers >= 3) return true;
      if (this.layers === 2) return s % 2 === 0;
      return s % 4 === 0;
    }
    step(s, t, chordIndex) {
      if (!this.on || !this.hits(s % 16)) return;
      const q = s % 16;
      const vel = q % 4 === 0 ? (q === 0 ? 1 : 0.85) : q % 2 === 0 ? 0.62 : 0.42;
      const layer = q % 4 === 0 ? 1 : q % 2 === 0 ? 2 : 3;
      this.hit(t, vel, ROOTS[chordIndex], layer);
      this.engine.visual(t, 'square', layer, vel);
    }
    hit(t, vel, root, layer) {
      const ctx = this.engine.ctx;
      const f = root * (layer === 3 ? 4 : 2);
      const o = ctx.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(f * 2.4, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.035);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
      lp.frequency.setValueAtTime(layer === 3 ? 5200 : 3800, t);
      lp.frequency.exponentialRampToValueAtTime(420, t + 0.13);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5 * vel, t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (layer === 3 ? 0.07 : 0.17));
      o.connect(lp).connect(g).connect(this.gate);
      o.start(t); o.stop(t + 0.25);

      // short noise click (body of the hit)
      const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
      n.playbackRate.value = 0.8 + Math.random() * 0.4;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      hp.frequency.value = layer === 3 ? 6500 : 2200;
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.22 * vel, t + 0.002);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
      n.connect(hp).connect(ng).connect(this.gate);
      n.start(t, Math.random() * 0.5); n.stop(t + 0.06);
    }
  }

  /* -------- rect: child of square — digital/glitch percussion -------- */
  class GlitchVoice extends Voice {
    constructor(engine) {
      super(engine, 'rect');
      const ctx = engine.ctx;
      this.layers = 1;
      this.crush = ctx.createWaveShaper();
      this.crush.curve = engine.crushCurve;
      this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass';
      this.bp.frequency.value = 2600; this.bp.Q.value = 1.4;
      this.crush.connect(this.bp).connect(this.gate);
      this.vol.gain.value = 0.75;
    }
    step(s, t, chordIndex) {
      if (!this.on) return;
      const q = s % 16;
      const sq = this.engine.voices.square;
      const squareHits = sq.on && sq.hits(q);
      const root = ROOTS[chordIndex];
      let play = false, ratchet = 1, jump = 1;

      if (this.layers === 1) {
        play = q % 4 === 2;                                   // off-beat 8ths
      } else if (this.layers === 2) {
        play = q % 4 === 2 || (q % 2 === 1 && Math.random() < 0.55);
        if (q % 8 === 6) ratchet = 2;
        if (squareHits && q % 4 !== 2) play = false;          // interlock with parent
      } else {
        play = Math.random() < 0.82;
        ratchet = Math.random() < 0.28 ? (Math.random() < 0.5 ? 3 : 2) : 1;
        jump = [1, 1, 1.5, 2, 0.5][Math.floor(Math.random() * 5)];
      }
      if (!play) return;
      for (let k = 0; k < ratchet; k++) {
        const tt = t + (k * STEP) / ratchet;
        this.blip(tt, root * 8 * jump * (k ? 1.5 : 1), k ? 0.55 : 0.9);
      }
      this.engine.visual(t, 'rect', this.layers === 1 ? 1 : ratchet > 1 ? 3 : 2, 0.8);
    }
    blip(t, f, vel) {
      const ctx = this.engine.ctx;
      const o = ctx.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(f, t);
      o.frequency.setValueAtTime(f * (Math.random() < 0.5 ? 0.75 : 1.25), t + 0.012);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3 * vel, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      o.connect(g).connect(this.crush);
      o.start(t); o.stop(t + 0.07);
      if (Math.random() < 0.5) {
        const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
        n.playbackRate.value = 0.25 + Math.random() * 0.2;   // grainy, "digital"
        const ng = ctx.createGain();
        ng.gain.setValueAtTime(0.0001, t);
        ng.gain.exponentialRampToValueAtTime(0.12 * vel, t + 0.001);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
        n.connect(ng).connect(this.crush);
        n.start(t, Math.random()); n.stop(t + 0.03);
      }
    }
  }

  /* -------- small circles: high FX loops (blip / beep / chirp / click) -------- */
  const FX_PATTERNS = {
    blip:  [1,0,0,1, 0,0,1,0, 0,1,0,0, 1,0,1,0],
    beep:  [0,0,1,0, 0,0,0,0, 0,0,1,0, 0,0,0,1],
    chirp: [1,0,0,0, 0,0,1,0, 0,0,0,1, 0,0,0,0],
    click: [1,1,0,1, 1,0,1,1, 1,1,0,1, 1,0,1,1]
  };
  class FxVoice extends Voice {
    constructor(engine, id, kind) {
      super(engine, id);
      this.kind = kind;
      this.pattern = FX_PATTERNS[kind] || FX_PATTERNS.blip;
      this.vol.gain.value = 0.55;
      this.n = 0;
    }
    step(s, t) {
      if (!this.on || !this.pattern[s % 16]) return;
      const ctx = this.engine.ctx;
      const k = this.kind;
      this.n++;
      if (k === 'click') {
        if (Math.random() < 0.18) return;
        const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.35, t + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.012);
        n.connect(hp).connect(g).connect(this.gate);
        n.start(t, Math.random()); n.stop(t + 0.02);
      } else {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        let dur = 0.06, peak = 0.18;
        if (k === 'blip') {
          o.type = 'sine';
          o.frequency.setValueAtTime(semi(A5, PENTA[(this.n * 3) % PENTA.length]), t);
          dur = 0.05; peak = 0.22;
        } else if (k === 'beep') {
          o.type = 'square';
          o.frequency.setValueAtTime(this.n % 2 ? semi(A5 * 2, 7) : A5 * 2, t);
          dur = 0.085; peak = 0.07;
        } else { // chirp
          o.type = 'sine';
          o.frequency.setValueAtTime(1800, t);
          o.frequency.exponentialRampToValueAtTime(5200 + (this.n % 3) * 600, t + 0.055);
          dur = 0.065; peak = 0.16;
        }
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(this.gate);
        o.start(t); o.stop(t + dur + 0.02);
      }
      this.engine.visual(t, this.id, 0, 0.8);
    }
  }

  /* -------- hybrid: ring-mod of two shape characters -------- */
  const TRAITS = {
    circle:  { wave: 'sine', mul: 2, rhythmic: false },
    oval:    { wave: 'triangle', mul: 4, rhythmic: false },
    square:  { wave: 'square', mul: 2, rhythmic: true },
    rect:    { wave: 'sawtooth', mul: 4, rhythmic: true },
    capsule: { wave: 'triangle', mul: 3, rhythmic: false },
    fx:      { wave: 'sine', mul: 8, rhythmic: true }
  };
  const RATIOS = [1.5, 2, 1.25, 2.5, 3, 1.333];
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  class Hybrid {
    constructor(engine, key, typeA, typeB) {
      this.engine = engine;
      this.key = key;
      const ctx = engine.ctx;
      const a = TRAITS[typeA] || TRAITS.fx, b = TRAITS[typeB] || TRAITS.fx;
      const h = hash(key);
      this.a = a; this.b = b;
      this.ratio = RATIOS[h % RATIOS.length];
      this.mul = Math.min(a.mul, b.mul);

      this.oscA = ctx.createOscillator(); this.oscA.type = a.wave;
      this.oscB = ctx.createOscillator(); this.oscB.type = b.wave;
      this.ring = ctx.createGain(); this.ring.gain.value = 0;
      this.oscA.connect(this.ring);
      this.oscB.connect(this.ring.gain);           // ring modulation
      this.dry = ctx.createGain(); this.dry.gain.value = 0.35;
      this.oscA.connect(this.dry);

      this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass';
      this.bp.frequency.value = 500 + (h % 1700); this.bp.Q.value = 2.2;
      this.ring.connect(this.bp); this.dry.connect(this.bp);

      // tremolo — rhythmic (synced 8ths) when a percussive shape is involved
      const rhythmic = a.rhythmic || b.rhythmic;
      this.trem = ctx.createGain(); this.trem.gain.value = rhythmic ? 0.5 : 0.82;
      this.lfo = ctx.createOscillator();
      this.lfo.type = rhythmic ? 'square' : 'sine';
      this.lfo.frequency.value = rhythmic ? (BPM / 60) * 2 : 0.22 + (h % 7) * 0.04;
      this.lfoAmt = ctx.createGain(); this.lfoAmt.gain.value = rhythmic ? 0.48 : 0.16;
      this.lfoSmooth = ctx.createBiquadFilter(); this.lfoSmooth.type = 'lowpass'; this.lfoSmooth.frequency.value = 40;
      this.lfo.connect(this.lfoSmooth).connect(this.lfoAmt).connect(this.trem.gain);

      this.level = ctx.createGain(); this.level.gain.value = 0;
      this.bp.connect(this.trem).connect(this.level).connect(engine.bus);

      this.target = 0;
      this.silentSince = 0;
      this.chord(engine.chordIndex, ctx.currentTime);
      const t = ctx.currentTime + 0.01;
      this.oscA.start(t); this.oscB.start(t); this.lfo.start(t);
    }
    chord(i, t) {
      const ctx = this.engine.ctx;
      const f = ROOTS[i] * this.mul;
      glide(this.oscA.frequency, f, ctx, 0.15, t);
      glide(this.oscB.frequency, f * this.ratio, ctx, 0.15, t);
    }
    setLevel(l) {
      if (Math.abs(l - this.target) < 0.004) return;
      this.target = l;
      // slow-ish time constant → soft fade in/out, never abrupt
      glide(this.level.gain, l * 0.15, this.engine.ctx, 0.18);
    }
    dispose() {
      const t = this.engine.ctx.currentTime + 0.05;
      try { this.oscA.stop(t); this.oscB.stop(t); this.lfo.stop(t); } catch (e) {}
      setTimeout(() => { try { this.level.disconnect(); } catch (e) {} }, 200);
    }
  }

  /* -------------------------------------------------------
     Engine
     ------------------------------------------------------- */
  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.voices = {};
      this.hybrids = new Map();
      this.running = false;
      this.scenePlaying = false;
      this.step = 0;
      this.nextTime = 0;
      this.chordIndex = 0;
      this.visualQueue = [];
      this.userVolume = 0.85;
      this._timer = null;
      this._suspendTimer = null;
      this._freq = null;
      this._time = null;
      this.levels = { rms: 0, level: 0, bands: new Float32Array(8) };
    }

    get ready() { return !!this.ctx; }

    /* must be called from a user gesture the first time */
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended' && this.scenePlaying) this.ctx.resume();
        return this.ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      this.bus = ctx.createGain();
      this.scene = ctx.createGain(); this.scene.gain.value = 0;     // screen fade
      this.master = ctx.createGain(); this.master.gain.value = this.userVolume;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -16; this.comp.knee.value = 14;
      this.comp.ratio.value = 3.5; this.comp.attack.value = 0.004; this.comp.release.value = 0.18;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.55;
      this.bus.connect(this.scene).connect(this.master).connect(this.comp).connect(this.analyser).connect(ctx.destination);
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);
      this._time = new Float32Array(this.analyser.fftSize);

      // shared buffers
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const steps = 7, curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) {
        const x = (i / 1023) * 2 - 1;
        curve[i] = Math.round(x * steps) / steps;
      }
      this.crushCurve = curve;

      const v = this.voices;
      v.circle = new PadVoice(this);
      v.oval = new ArpVoice(this);
      v.square = new PercVoice(this);
      v.rect = new GlitchVoice(this);
      v.fx1 = new FxVoice(this, 'fx1', 'blip');
      v.fx2 = new FxVoice(this, 'fx2', 'beep');
      v.fx3 = new FxVoice(this, 'fx3', 'chirp');

      if (this.onReady) this.onReady(this);
      return ctx;
    }

    addFxVoice(id, kind) {
      if (!this.ctx || this.voices[id]) return;
      this.voices[id] = new FxVoice(this, id, kind);
    }

    /* ------------- scene (screen-level) on/off ------------- */
    startScene() {
      const ctx = this.ensure();
      if (!ctx) return;
      clearTimeout(this._suspendTimer);
      if (ctx.state !== 'running') ctx.resume();
      this.scenePlaying = true;
      rampTo(this.scene.gain, 1, ctx, 0.3);
      this.startTransport();
    }
    stopScene(ms = 450) {
      this.scenePlaying = false;
      if (!this.ctx) return;
      rampTo(this.scene.gain, 0, this.ctx, ms / 1000);
      clearTimeout(this._suspendTimer);
      this._suspendTimer = setTimeout(() => {
        if (this.scenePlaying) return;
        this.stopTransport();
        this.visualQueue.length = 0;
        if (this.ctx.state === 'running') this.ctx.suspend();
      }, ms + 120);
    }
    setMasterVolume(v) {
      this.userVolume = clamp(v, 0, 1);
      if (this.ctx) glide(this.master.gain, this.userVolume, this.ctx, 0.05);
    }

    /* ------------- transport ------------- */
    startTransport() {
      if (this.running) return;
      this.running = true;
      this.nextTime = this.ctx.currentTime + 0.06;
      this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    }
    stopTransport() {
      this.running = false;
      clearInterval(this._timer);
    }
    _tick() {
      const ctx = this.ctx;
      if (!ctx || !this.running) return;
      // if the tab was throttled, don't fire a burst of stale steps
      if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
      while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
        this._schedule(this.step, this.nextTime);
        this.nextTime += STEP;
        this.step++;
      }
    }
    _schedule(s, t) {
      if (s % 32 === 0) {
        const ci = Math.floor(s / 32) % ROOTS.length;
        if (ci !== this.chordIndex || s === 0) {
          this.chordIndex = ci;
          for (const id in this.voices) this.voices[id].chord(ci, t);
          this.hybrids.forEach((h) => h.chord(ci, t));
        }
      }
      for (const id in this.voices) this.voices[id].step(s, t, this.chordIndex);
      if (s % 4 === 0) this.visual(t, 'beat', (s % 16) / 4, 1);
    }

    /* visual events scheduled at audio time, drained by the render loop */
    visual(time, id, layer, vel) {
      if (this.visualQueue.length > 256) this.visualQueue.shift();
      this.visualQueue.push({ time, id, layer, vel });
    }
    drainVisual(cb) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const q = this.visualQueue;
      while (q.length && q[0].time <= now) cb(q.shift());
    }

    /* ------------- voice API ------------- */
    setVoiceOn(id, on) { const v = this.voices[id]; if (v) v.setOn(on); }
    setVolume(id, val) { const v = this.voices[id]; if (v) v.setVolume(val); }
    setTimbre(val) { if (this.voices.circle) this.voices.circle.setTimbre(val); }
    setLayers(id, n) { const v = this.voices[id]; if (v) v.layers = n; }
    setDoubles(doublerOn, doubledMap) {
      for (const id in this.voices) this.voices[id].setDouble(doublerOn && !!doubledMap[id]);
    }

    /* ------------- hybrids ------------- */
    updateHybrid(key, typeA, typeB, level) {
      if (!this.ctx) return;
      let h = this.hybrids.get(key);
      if (!h) {
        if (level < 0.002) return;
        h = new Hybrid(this, key, typeA, typeB);
        this.hybrids.set(key, h);
      }
      h.setLevel(level);
      const now = this.ctx.currentTime;
      if (level < 0.002) {
        if (!h.silentSince) h.silentSince = now;
        else if (now - h.silentSince > 1.6) { h.dispose(); this.hybrids.delete(key); }
      } else h.silentSince = 0;
    }

    /* ------------- analysis (used by grid + visuals) ------------- */
    analyse() {
      const L = this.levels;
      if (!this.ctx || !this.analyser) {
        L.rms *= 0.9; L.level *= 0.9; for (let i = 0; i < 8; i++) L.bands[i] *= 0.9;
        return L;
      }
      const td = this._time;
      if (this.analyser.getFloatTimeDomainData) this.analyser.getFloatTimeDomainData(td);
      let sum = 0;
      for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
      const rms = Math.sqrt(sum / td.length);
      const target = clamp((rms - 0.004) * 5.5, 0, 1);
      L.rms = rms;
      L.level += (target - L.level) * (target > L.level ? 0.45 : 0.06);

      const f = this._freq;
      this.analyser.getByteFrequencyData(f);
      const n = f.length;
      for (let b = 0; b < 8; b++) {        // log-spaced bands
        const a = Math.floor(Math.pow(n, b / 8)), z = Math.max(a + 1, Math.floor(Math.pow(n, (b + 1) / 8)));
        let s = 0; for (let i = a; i < z; i++) s += f[i];
        const v = clamp(s / (z - a) / 200, 0, 1);
        L.bands[b] += (v - L.bands[b]) * (v > L.bands[b] ? 0.5 : 0.08);
      }
      return L;
    }
  }

  GP.AudioEngine = AudioEngine;
  GP.audio = new AudioEngine();
  GP.AUDIO_CONST = { BPM, STEP };
})();
