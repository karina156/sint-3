/* =========================================================
   audio.js — Web Audio engine: "order and breath"
   The square family is metre (Euclidean rhythms, polymeter),
   the circle family is breath (just-intonation pad, a motif that develops).
   Shapes touching = friction, merging = consonance.

   · harmony: D Dorian field; the circle's height on the poster picks one
     of three progressions (bright / home / dark), chords change every 2 bars
   · position on the poster = the score: x → pan + rhythmic rotation,
     y → register + depth (reverb)
   · every voice enters and leaves on the next beat (quantized)
   · shared space: convolution reverb + tempo ping-pong delay,
     the square ducks the pad (sidechain), soft saturation on the master
   · energy builds while voices play together and opens the mix
   · when the last voice stops, the piece resolves on a tonic chord
   All gain moves are ramped → no clicks.
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  const BPM = 108;
  const STEP = 60 / BPM / 4;              // 16th note
  const LOOKAHEAD = 0.12;
  const TICK_MS = 25;

  /* ---------- harmony: D Dorian ---------- */
  const D2 = 73.416;
  const MODE = [0, 2, 3, 5, 7, 9, 10];
  const deg = (d) => { const o = Math.floor(d / 7), i = ((d % 7) + 7) % 7; return MODE[i] + 12 * o; };
  const hz = (semis) => D2 * Math.pow(2, semis / 12);
  const PROGS = [
    [3, 6, 2, 0],    // bright: G – C – F – Dm
    [0, 3, 0, 6],    // home:   Dm – G – Dm – C
    [0, 4, 2, 6]     // dark:   Dm – Am – F – C
  ];
  function chordOf(d) {
    const r = deg(d);
    return { d, rootS: r, root: hz(r), minor: deg(d + 2) - r === 3 };
  }

  /* ---------- rhythm: Euclidean patterns ---------- */
  function euclid(k, n, rot) {
    const p = [];
    for (let i = 0; i < n; i++) p.push((i * k) % n < k ? 1 : 0);
    const r = ((rot % n) + n) % n;
    return p.slice(r).concat(p.slice(0, r));
  }

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function glide(param, value, ctx, tau = 0.03, at) {
    const t = at != null ? Math.max(at, ctx.currentTime) : ctx.currentTime;
    try { param.cancelScheduledValues(t); param.setTargetAtTime(value, t, tau); } catch (e) { param.value = value; }
  }
  function rampTo(param, value, ctx, seconds) {
    const t = ctx.currentTime, cur = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(cur, t);
    param.linearRampToValueAtTime(value, t + seconds);
  }
  /* soft one-shot envelope helper */
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  const octOf = (y01) => (y01 < 0.34 ? 1 : y01 > 0.66 ? -1 : 0);

  /* -------------------------------------------------------
     Voice base:
       out → pan → bus            (dry)
             pan → reverb send / delay send
       out → doubler (mod delay, panned) → bus
     ------------------------------------------------------- */
  class Voice {
    constructor(engine, id, sends) {
      this.engine = engine;
      this.id = id;
      this.on = false;
      this.onAt = 0;
      this.offAt = 0;
      this.sends = sends;                     // { rev, del }
      this.place = { x01: 0.5, y01: 0.5, col: 0, row: 0 };
      const ctx = engine.ctx;
      this.gate = ctx.createGain(); this.gate.gain.value = 0;
      this.vol = ctx.createGain(); this.vol.gain.value = 0.7;
      this.out = ctx.createGain();
      this.pan = ctx.createStereoPanner();
      this.rev = ctx.createGain(); this.rev.gain.value = sends.rev;
      this.del = ctx.createGain(); this.del.gain.value = sends.del;
      this.gate.connect(this.vol).connect(this.out).connect(this.pan);
      this.pan.connect(engine.bus);
      this.pan.connect(this.rev).connect(engine.revIn);
      this.pan.connect(this.del).connect(engine.delIn);

      // doubler: ~22 ms, slowly modulated (≈ slight detune), panned away from the dry voice
      this.dblDelay = ctx.createDelay(0.1); this.dblDelay.delayTime.value = 0.022;
      this.dblLfo = ctx.createOscillator(); this.dblLfo.frequency.value = 0.37 + Math.random() * 0.2;
      this.dblLfoAmt = ctx.createGain(); this.dblLfoAmt.gain.value = 0.0028;
      this.dblLfo.connect(this.dblLfoAmt).connect(this.dblDelay.delayTime); this.dblLfo.start();
      this.dblGain = ctx.createGain(); this.dblGain.gain.value = 0;
      this.dblPan = ctx.createStereoPanner(); this.dblPan.pan.value = 0.45;
      this.out.connect(this.dblDelay).connect(this.dblGain).connect(this.dblPan).connect(engine.bus);
      this.dblPan.connect(engine.revIn);
    }
    /* quantized on/off: takes effect at `at` (next beat) */
    setOn(on, at) {
      on = !!on;
      if (on === this.on) return on ? this.onAt : this.offAt;
      this.on = on;
      if (on) this.onAt = at; else this.offAt = at;
      glide(this.gate.gain, on ? 1 : 0, this.engine.ctx, on ? 0.04 : 0.09, at);
      return at;
    }
    active(t) { return this.on ? t >= this.onAt - 1e-4 : t < this.offAt - 1e-4; }
    setVolume(v) { glide(this.vol.gain, v, this.engine.ctx, 0.04); }
    setDouble(a) { glide(this.dblGain.gain, a ? 0.75 : 0, this.engine.ctx, 0.08); }
    /* position on the poster */
    setPlacement(p) {
      this.place = p;
      const ctx = this.engine.ctx;
      glide(this.pan.pan, clamp((p.x01 * 2 - 1) * 0.75, -0.8, 0.8), ctx, 0.12);
      const depth = 0.7 + 0.6 * (1 - p.y01);               // higher on the poster = further away
      glide(this.rev.gain, this.sends.rev * depth, ctx, 0.2);
    }
    step() {}
    chord() {}
  }

  /* -------- circle: breath — just-intonation pad -------- */
  class PadVoice extends Voice {
    constructor(engine) {
      super(engine, 'circle', { rev: 0.55, del: 0.08 });
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
      this.filter.frequency.value = 900; this.filter.Q.value = 1.4;
      this.duckG = ctx.createGain();
      this.shape = ctx.createGain(); this.shape.gain.value = 0.3;
      this.filter.connect(this.duckG).connect(this.shape).connect(this.gate);
      const mk = (type, detune, gain) => {
        const o = ctx.createOscillator(); o.type = type; o.detune.value = detune;
        const g = ctx.createGain(); g.gain.value = gain;
        o.connect(g).connect(this.filter); o.start();
        return { o, g };
      };
      this.root = mk('sine', -3, 0.5);
      this.fifth = mk('triangle', 2, 0.2);
      this.third = mk('sine', 4, 0.15);
      this.ninth = mk('sine', -2, 0.05);
      this.bright = mk('sawtooth', 6, 0);
      this.sub = mk('sine', 0, 0.22);
      // slow breathing of the filter
      this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.08;
      this.lfoAmt = ctx.createGain(); this.lfoAmt.gain.value = 120;
      this.lfo.connect(this.lfoAmt).connect(this.filter.frequency); this.lfo.start();
      this.timbre = 0.5;
      this.chord(chordOf(0), ctx.currentTime);
      this.setTimbre(0.5);
    }
    /* just intonation over the (equal-tempered) chord root */
    chord(c, t) {
      const ctx = this.engine.ctx, r = c.root * 2, tau = 0.35;
      glide(this.root.o.frequency, r, ctx, tau, t);
      glide(this.fifth.o.frequency, r * 3 / 2, ctx, tau, t);
      glide(this.third.o.frequency, r * 2 * (c.minor ? 6 / 5 : 5 / 4), ctx, tau, t);
      glide(this.ninth.o.frequency, r * 9 / 4, ctx, tau, t);
      glide(this.bright.o.frequency, r, ctx, tau, t);
      glide(this.sub.o.frequency, r / 2, ctx, tau, t);
    }
    setTimbre(t) {
      this.timbre = t = clamp(t, 0, 1);
      const ctx = this.engine.ctx;
      glide(this.filter.frequency, 240 * Math.pow(14, t), ctx, 0.06);
      glide(this.filter.Q, 0.8 + t * 4.5, ctx, 0.06);
      glide(this.root.g.gain, 0.55 - 0.22 * t, ctx, 0.06);
      glide(this.fifth.g.gain, 0.13 + 0.2 * t, ctx, 0.06);
      glide(this.third.g.gain, 0.1 + 0.12 * t, ctx, 0.06);
      glide(this.bright.g.gain, 0.13 * t * t, ctx, 0.06);
      glide(this.lfoAmt.gain, 60 + 240 * t, ctx, 0.2);
      if (this.engine.voices.oval) this.engine.voices.oval.follow(t);
    }
    setEnergy(e) { glide(this.ninth.g.gain, 0.03 + 0.14 * e, this.engine.ctx, 1.5); }
    setVolume(v) { glide(this.vol.gain, v * v, this.engine.ctx, 0.05); }
    duck(t, amt) {
      const g = this.duckG.gain;
      g.setTargetAtTime(1 - amt, t, 0.004);
      g.setTargetAtTime(1, t + 0.035, 0.13);
    }
  }

  /* -------- oval: child of the circle — a motif that develops -------- */
  const MOTIF = [0, 2, 4, 1, 3, 5, 2, 6];
  class MotifVoice extends Voice {
    constructor(engine) {
      super(engine, 'oval', { rev: 0.45, del: 0.32 });
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
      this.filter.frequency.value = 2600; this.filter.Q.value = 0.9;
      this.duckG = ctx.createGain();
      this.filter.connect(this.duckG).connect(this.gate);
      this.len = 5;
      this.bar = 0;
    }
    follow(t) { glide(this.filter.frequency, 1000 + 3600 * t, this.engine.ctx, 0.08); }
    /* k01: arrow length normalised → phrase length + volume */
    setShape(k01) {
      this.len = 3 + Math.round(clamp(k01, 0, 1) * 5);
      glide(this.vol.gain, 0.25 + 0.7 * clamp(k01, 0, 1), this.engine.ctx, 0.05);
    }
    duck(t, amt) {
      const g = this.duckG.gain;
      g.setTargetAtTime(1 - amt * 0.5, t, 0.004);
      g.setTargetAtTime(1, t + 0.03, 0.12);
    }
    step(s, t, c) {
      if (s % 16 === 0) this.bar++;
      if (!this.active(t) || s % 2) return;
      const e8 = (s % 16) / 2;                   // eighth inside the bar
      if (e8 >= this.len) return;                // the rest of the bar breathes
      const form = Math.floor(this.bar / 4) % 4; // every 4 bars the motif develops
      let m = MOTIF[e8 % MOTIF.length];
      if (form === 1) m = m + 2;                                  // sequence up a third
      else if (form === 2) m = -m;                                // inversion
      else if (form === 3) m = MOTIF[(this.len - 1 - e8) % MOTIF.length]; // retrograde
      const reg = octOf(this.place.y01);
      const f = hz(deg(c.d + m) + 36 + reg * 12);
      const ctx = this.engine.ctx;
      const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
      const g = ctx.createGain(), g2 = ctx.createGain(); g2.gain.value = 0.18;
      o.connect(g); o2.connect(g2).connect(g); g.connect(this.filter);
      const accent = e8 === 0 ? 1 : 0.72;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.17 * accent, t + 0.018);
      g.gain.setTargetAtTime(0, t + 0.03, 0.2);
      o.start(t); o2.start(t); o.stop(t + 1.4); o2.stop(t + 1.4);
      this.engine.visual(t, 'oval', 0, accent);
    }
  }

  /* -------- square: metre — Euclidean percussion -------- */
  const SQ = {
    1: (r) => euclid(3, 8, r).concat(euclid(3, 8, r)),   // tresillo
    2: (r) => euclid(5, 8, r).concat(euclid(5, 8, r)),   // cinquillo
    3: (r) => euclid(11, 16, r)
  };
  class PercVoice extends Voice {
    constructor(engine) {
      super(engine, 'square', { rev: 0.1, del: 0.05 });
      this.layers = 1;
      this.vol.gain.value = 0.85;
    }
    pattern() { return SQ[this.layers](this.place.col * 3); }
    hitsAt(q) { return this.pattern()[q] === 1; }
    layerOf(q) {
      const rot = this.place.col * 3;
      if (SQ[1](rot)[q]) return 1;
      if (SQ[2](rot)[q]) return 2;
      return 3;
    }
    step(s, t, c) {
      if (!this.active(t)) return;
      const q = s % 16;
      if (!this.hitsAt(q)) return;
      const layer = this.layerOf(q);
      const vel = q === 0 ? 1 : layer === 1 ? 0.82 : layer === 2 ? 0.6 : 0.42;
      const reg = octOf(this.place.y01);
      this.hit(t, vel, c.root * Math.pow(2, reg), layer);
      this.engine.duck(t, vel);
      this.engine.visual(t, 'square', layer, vel);
    }
    hit(t, vel, root, layer) {
      const ctx = this.engine.ctx;
      const f = layer === 3 ? root * 4 : root * 2;
      // pitched body
      const o = ctx.createOscillator(); o.type = layer === 1 ? 'sine' : 'square';
      o.frequency.setValueAtTime(f * 2.6, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.04);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
      lp.frequency.setValueAtTime(layer === 3 ? 5200 : 3400, t);
      lp.frequency.exponentialRampToValueAtTime(380, t + 0.14);
      const g = ctx.createGain();
      env(g, t, (layer === 1 ? 0.75 : 0.42) * vel, 0.003, layer === 3 ? 0.07 : layer === 1 ? 0.24 : 0.15);
      o.connect(lp).connect(g).connect(this.gate);
      o.start(t); o.stop(t + 0.3);
      // click
      const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
      hp.frequency.value = layer === 3 ? 7000 : 2600;
      const ng = ctx.createGain();
      env(ng, t, 0.16 * vel, 0.002, 0.03);
      n.connect(hp).connect(ng).connect(this.gate);
      n.start(t, Math.random() * 0.5); n.stop(t + 0.05);
    }
  }

  /* -------- rect: child of the square — polymeter (5 / 7 / 9 against 16) -------- */
  const RC = { 1: [2, 5], 2: [3, 7], 3: [5, 9] };
  class GlitchVoice extends Voice {
    constructor(engine) {
      super(engine, 'rect', { rev: 0.16, del: 0.22 });
      const ctx = engine.ctx;
      this.layers = 1;
      this.k = 0;
      this.crush = ctx.createWaveShaper(); this.crush.curve = engine.crushCurve;
      this.bp = ctx.createBiquadFilter(); this.bp.type = 'bandpass';
      this.bp.frequency.value = 2600; this.bp.Q.value = 1.3;
      this.crush.connect(this.bp).connect(this.gate);
      this.vol.gain.value = 0.7;
    }
    step(s, t, c) {
      this.k++;
      if (!this.active(t)) return;
      const [k, n] = RC[this.layers];
      const pat = euclid(k, n, this.place.col);
      const i = this.k % n;
      if (!pat[i]) return;
      const reg = octOf(this.place.y01);
      const jumps = [1, 1.5, 1, 2, 1, 1.5, 0.75, 1, 2];
      const f = c.root * 8 * Math.pow(2, reg) * (this.layers === 3 ? jumps[i % jumps.length] : 1);
      const ratchet = this.layers === 3 && i === 0 ? 3 : this.layers >= 2 && i === n - 1 ? 2 : 1;
      for (let r = 0; r < ratchet; r++) this.blip(t + (r * STEP) / ratchet, f * (r ? 1.5 : 1), r ? 0.55 : 0.9);
      this.engine.visual(t, 'rect', ratchet > 1 ? 3 : this.layers === 1 ? 1 : 2, 0.8);
    }
    blip(t, f, vel) {
      const ctx = this.engine.ctx;
      const o = ctx.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(f, t);
      o.frequency.setValueAtTime(f * 0.75, t + 0.014);
      const g = ctx.createGain();
      env(g, t, 0.26 * vel, 0.002, 0.045);
      o.connect(g).connect(this.crush);
      o.start(t); o.stop(t + 0.08);
      const nz = ctx.createBufferSource(); nz.buffer = this.engine.noise;
      nz.playbackRate.value = 0.3;
      const ng = ctx.createGain();
      env(ng, t, 0.08 * vel, 0.001, 0.02);
      nz.connect(ng).connect(this.crush);
      nz.start(t, Math.random()); nz.stop(t + 0.03);
    }
  }

  /* -------- small circles: three cells that interlock (hocket) -------- */
  const CELLS = {
    blip:  { steps: [0, 6, 11], degs: [4, 7, 9] },
    beep:  { steps: [3, 8, 14], degs: [2, 5, 7] },
    chirp: { steps: [5, 10, 13], degs: [9, 7, 11] },
    click: { steps: [2, 7, 12, 15], degs: [0, 0, 0, 0] }
  };
  class FxVoice extends Voice {
    constructor(engine, id, kind) {
      super(engine, id, { rev: 0.38, del: 0.3 });
      this.kind = kind;
      this.cell = CELLS[kind] || CELLS.blip;
      this.vol.gain.value = 0.5;
    }
    step(s, t, c) {
      if (!this.active(t)) return;
      const q = ((s % 16) - this.place.col + 16) % 16;
      const idx = this.cell.steps.indexOf(q);
      if (idx < 0) return;
      const ctx = this.engine.ctx, k = this.kind;
      const reg = octOf(this.place.y01);
      const f = hz(deg(c.d + this.cell.degs[idx]) + 36 + reg * 12);
      if (k === 'click') {
        const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000;
        const g = ctx.createGain(); env(g, t, 0.3, 0.001, 0.012);
        n.connect(hp).connect(g).connect(this.gate);
        n.start(t, Math.random()); n.stop(t + 0.02);
      } else {
        const o = ctx.createOscillator(), g = ctx.createGain();
        if (k === 'blip') { o.type = 'sine'; o.frequency.setValueAtTime(f, t); env(g, t, 0.24, 0.003, 0.09); }
        else if (k === 'beep') {
          o.type = 'square'; o.frequency.setValueAtTime(f, t);
          const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f * 2; bp.Q.value = 2;
          env(g, t, 0.16, 0.004, 0.1); o.connect(bp).connect(g).connect(this.gate);
          o.start(t); o.stop(t + 0.14);
          this.engine.visual(t, this.id, 0, 0.8);
          return;
        } else {           // chirp: glides up into its note
          o.type = 'sine';
          o.frequency.setValueAtTime(f * 0.5, t);
          o.frequency.exponentialRampToValueAtTime(f, t + 0.05);
          env(g, t, 0.2, 0.004, 0.08);
        }
        o.connect(g).connect(this.gate);
        o.start(t); o.stop(t + 0.15);
      }
      this.engine.visual(t, this.id, 0, 0.8);
    }
  }

  /* -------- hybrid: friction on contact → consonance when merged -------- */
  const TRAITS = {
    circle: { wave: 'sine', mul: 2, rhythmic: false },
    oval: { wave: 'triangle', mul: 4, rhythmic: false },
    square: { wave: 'square', mul: 2, rhythmic: true },
    rect: { wave: 'sawtooth', mul: 4, rhythmic: true },
    capsule: { wave: 'triangle', mul: 3, rhythmic: false },
    fx: { wave: 'sine', mul: 8, rhythmic: true }
  };
  // ratio path from rub (16:15) to fifth (3:2), interpolated in log space
  const PATH = [16 / 15, 9 / 8, 4 / 3, 3 / 2];
  function ratioAt(l) {
    const x = clamp(l, 0, 1) * (PATH.length - 1), i = Math.min(PATH.length - 2, Math.floor(x)), f = x - i;
    return Math.exp(Math.log(PATH[i]) * (1 - f) + Math.log(PATH[i + 1]) * f);
  }
  class Hybrid {
    constructor(engine, key, typeA, typeB) {
      this.engine = engine;
      this.key = key;
      const ctx = engine.ctx;
      const a = TRAITS[typeA] || TRAITS.fx, b = TRAITS[typeB] || TRAITS.fx;
      this.mul = Math.min(a.mul, b.mul);
      this.lvl = 0;
      this.oscA = ctx.createOscillator(); this.oscA.type = a.wave;
      this.oscB = ctx.createOscillator(); this.oscB.type = b.wave;
      // ring path (friction) + sum path (interval)
      this.ring = ctx.createGain(); this.ring.gain.value = 0;
      this.oscA.connect(this.ring); this.oscB.connect(this.ring.gain);
      this.ringMix = ctx.createGain(); this.ringMix.gain.value = 1;
      this.sumMix = ctx.createGain(); this.sumMix.gain.value = 0.2;
      this.ring.connect(this.ringMix);
      this.oscA.connect(this.sumMix); this.oscB.connect(this.sumMix);
      this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 2200; this.lp.Q.value = 0.7;
      this.ringMix.connect(this.lp); this.sumMix.connect(this.lp);
      const rhythmic = a.rhythmic || b.rhythmic;
      this.trem = ctx.createGain(); this.trem.gain.value = rhythmic ? 0.55 : 0.85;
      this.lfo = ctx.createOscillator(); this.lfo.type = rhythmic ? 'square' : 'sine';
      this.lfo.frequency.value = rhythmic ? (BPM / 60) * 2 : 0.2;
      this.lfoSmooth = ctx.createBiquadFilter(); this.lfoSmooth.type = 'lowpass'; this.lfoSmooth.frequency.value = 35;
      this.lfoAmt = ctx.createGain(); this.lfoAmt.gain.value = rhythmic ? 0.42 : 0.12;
      this.lfo.connect(this.lfoSmooth).connect(this.lfoAmt).connect(this.trem.gain);
      this.level = ctx.createGain(); this.level.gain.value = 0;
      this.lp.connect(this.trem).connect(this.level);
      this.level.connect(engine.bus);
      this.send = ctx.createGain(); this.send.gain.value = 0.5;
      this.level.connect(this.send).connect(engine.revIn);
      this.target = 0;
      this.silentSince = 0;
      this.chord(engine.chord, ctx.currentTime);
      const t = ctx.currentTime + 0.01;
      this.oscA.start(t); this.oscB.start(t); this.lfo.start(t);
    }
    chord(c, t) {
      const ctx = this.engine.ctx, f = c.root * this.mul;
      this.f = f;
      glide(this.oscA.frequency, f, ctx, 0.2, t);
      glide(this.oscB.frequency, f * ratioAt(this.lvl), ctx, 0.2, t);
    }
    setLevel(l) {
      if (Math.abs(l - this.target) < 0.004) return;
      this.target = l;
      this.lvl = l;
      const ctx = this.engine.ctx;
      glide(this.level.gain, l * 0.075, ctx, 0.18);
      glide(this.oscB.frequency, this.f * ratioAt(l), ctx, 0.12);
      glide(this.ringMix.gain, 1 - 0.88 * l, ctx, 0.15);
      glide(this.sumMix.gain, 0.15 + 0.45 * l, ctx, 0.15);
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
      this.chord = chordOf(0);
      this.prog = 1;
      this.energy = 0;
      this.visualQueue = [];
      this.userVolume = 0.85;
      this._timer = null;
      this._suspendTimer = null;
      this.levels = { rms: 0, level: 0, bands: new Float32Array(8) };
    }
    get ready() { return !!this.ctx; }

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended' && this.scenePlaying) this.ctx.resume();
        return this.ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      /* master: bus + returns → mix → air → saturation → scene → master → comp → analyser */
      this.bus = ctx.createGain();
      this.mix = ctx.createGain();
      this.air = ctx.createBiquadFilter(); this.air.type = 'lowpass'; this.air.frequency.value = 5000; this.air.Q.value = 0.5;
      this.sat = ctx.createWaveShaper();
      const sc = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) { const x = (i / 2047) * 2 - 1; sc[i] = Math.tanh(1.4 * x) / Math.tanh(1.4); }
      this.sat.curve = sc; this.sat.oversample = '2x';
      this.scene = ctx.createGain(); this.scene.gain.value = 0;
      this.master = ctx.createGain(); this.master.gain.value = this.userVolume;
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -14; this.comp.knee.value = 18;
      this.comp.ratio.value = 2.5; this.comp.attack.value = 0.01; this.comp.release.value = 0.25;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024; this.analyser.smoothingTimeConstant = 0.55;
      this.bus.connect(this.mix);
      this.mix.connect(this.air).connect(this.sat).connect(this.scene).connect(this.master)
        .connect(this.comp).connect(this.analyser).connect(ctx.destination);

      /* reverb: generated stereo impulse, 3.4 s */
      this.revIn = ctx.createGain();
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this._impulse(3.4);
      this.revPre = ctx.createBiquadFilter(); this.revPre.type = 'highpass'; this.revPre.frequency.value = 180;
      this.revOut = ctx.createGain(); this.revOut.gain.value = 0.55;
      this.revIn.connect(this.revPre).connect(this.convolver).connect(this.revOut).connect(this.mix);

      /* ping-pong delay, dotted eighth */
      this.delIn = ctx.createGain();
      const dt = STEP * 3;
      this.dL = ctx.createDelay(2); this.dL.delayTime.value = dt;
      this.dR = ctx.createDelay(2); this.dR.delayTime.value = dt;
      this.fb = ctx.createGain(); this.fb.gain.value = 0.38;
      this.fbLp = ctx.createBiquadFilter(); this.fbLp.type = 'lowpass'; this.fbLp.frequency.value = 3200;
      const pL = ctx.createStereoPanner(), pR = ctx.createStereoPanner();
      pL.pan.value = -0.7; pR.pan.value = 0.7;
      this.delOut = ctx.createGain(); this.delOut.gain.value = 0.42;
      this.delIn.connect(this.dL);
      this.dL.connect(this.dR); this.dR.connect(this.fbLp).connect(this.fb).connect(this.dL);
      this.dL.connect(pL).connect(this.delOut); this.dR.connect(pR).connect(this.delOut);
      this.delOut.connect(this.mix);
      this.delOut.connect(this.revIn);

      this._time = new Float32Array(this.analyser.fftSize);
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);

      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const steps = 7, curve = new Float32Array(1024);
      for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.round(x * steps) / steps; }
      this.crushCurve = curve;

      const v = this.voices;
      v.circle = new PadVoice(this);
      v.oval = new MotifVoice(this);
      v.square = new PercVoice(this);
      v.rect = new GlitchVoice(this);
      v.fx1 = new FxVoice(this, 'fx1', 'blip');
      v.fx2 = new FxVoice(this, 'fx2', 'beep');
      v.fx3 = new FxVoice(this, 'fx3', 'chirp');
      this._applyEnergy();

      if (this.onReady) this.onReady(this);
      return ctx;
    }

    _impulse(seconds) {
      const ctx = this.ctx, sr = ctx.sampleRate, n = Math.floor(seconds * sr);
      const buf = ctx.createBuffer(2, n, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let lp = 0;
        for (let i = 0; i < n; i++) {
          const t = i / n;
          const k = 0.35 + 0.6 * t;                  // darker as it decays
          lp += (Math.random() * 2 - 1 - lp) * (1 - k);
          d[i] = lp * Math.pow(1 - t, 2.6) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
        }
      }
      return buf;
    }

    addFxVoice(id, kind) { if (this.ctx && !this.voices[id]) this.voices[id] = new FxVoice(this, id, kind); }

    /* ---------- scene ---------- */
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

    /* ---------- transport ---------- */
    startTransport() {
      if (this.running) return;
      this.running = true;
      this.nextTime = this.ctx.currentTime + 0.06;
      this.step = Math.ceil(this.step / 16) * 16;        // restart on a downbeat
      this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    }
    stopTransport() { this.running = false; clearInterval(this._timer); }
    /* time of the next beat that has not been scheduled yet */
    nextBeat() {
      if (!this.ctx) return 0;
      if (!this.running) return this.ctx.currentTime + 0.04;   // the transport's first downbeat lands just after
      let s = this.step;
      while (s % 4) s++;
      return this.nextTime + (s - this.step) * STEP;
    }
    _tick() {
      const ctx = this.ctx;
      if (!ctx || !this.running) return;
      if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
      while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
        this._schedule(this.step, this.nextTime);
        this.nextTime += STEP;
        this.step++;
      }
    }
    _schedule(s, t) {
      if (s % 32 === 0) {                                 // a new chord every 2 bars
        const p = PROGS[this.prog];
        const c = chordOf(p[Math.floor(s / 32) % p.length]);
        this.chord = c;
        for (const id in this.voices) this.voices[id].chord(c, t);
        this.hybrids.forEach((h) => h.chord(c, t));
      }
      if (s % 16 === 0) {                                 // energy: voices playing together build the piece
        let n = 0;
        for (const id in this.voices) if (this.voices[id].active(t)) n++;
        this.energy = clamp(this.energy + (n >= 2 ? 0.05 + 0.01 * (n - 2) : -0.08), 0, 1);
        this._applyEnergy(t);
      }
      for (const id in this.voices) this.voices[id].step(s, t, this.chord);
      if (s % 4 === 0) this.visual(t, 'beat', (s % 16) / 4, 1);
    }
    _applyEnergy(t) {
      const ctx = this.ctx, e = this.energy;
      glide(this.air.frequency, 4200 + 13000 * e * e, ctx, 1.2, t);
      glide(this.revOut.gain, 0.5 + 0.3 * e, ctx, 1.5, t);
      glide(this.fb.gain, 0.32 + 0.16 * e, ctx, 1.5, t);
      if (this.voices.circle) this.voices.circle.setEnergy(e);
    }
    duck(t, vel) {
      if (this.voices.circle) this.voices.circle.duck(t, 0.55 * vel);
      if (this.voices.oval) this.voices.oval.duck(t, 0.4 * vel);
    }

    /* the piece resolves: a tonic chord with a long tail into the reverb */
    resolve() {
      if (!this.ctx || !this.scenePlaying) return;
      const ctx = this.ctx, t = this.nextBeat() + STEP * 4;
      const out = ctx.createGain(); out.gain.value = 1;
      out.connect(this.bus); out.connect(this.revIn);
      const notes = [hz(12), hz(19), hz(24) * 9 / 8, hz(24) * 6 / 5, hz(31)];   // D3 A3 E4 F4 A4 (just)
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.35 + i * 0.06);
        g.gain.setTargetAtTime(0, t + 0.6, 1.6);
        o.connect(g).connect(out);
        o.start(t); o.stop(t + 9);
      });
      this.energy = 0;
      this._applyEnergy();
      this.visual(t, 'resolve', 0, 1);
    }

    visual(time, id, layer, vel) {
      if (this.visualQueue.length > 256) this.visualQueue.shift();
      this.visualQueue.push({ time, id, layer, vel });
    }
    drainVisual(cb) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime, q = this.visualQueue;
      while (q.length && q[0].time <= now) cb(q.shift());
    }

    /* ---------- voice API ---------- */
    setVoiceOn(id, on) { const v = this.voices[id]; return v ? v.setOn(on, this.nextBeat()) : 0; }
    setVolume(id, val) { const v = this.voices[id]; if (v) v.setVolume(val); }
    setTimbre(val) { if (this.voices.circle) this.voices.circle.setTimbre(val); }
    setOvalShape(k01) { if (this.voices.oval) this.voices.oval.setShape(k01); }
    setLayers(id, n) { const v = this.voices[id]; if (v) v.layers = clamp(n, 1, 3); }
    setDoubles(on, map) { for (const id in this.voices) this.voices[id].setDouble(on && !!map[id]); }
    setPlacement(id, p) { const v = this.voices[id]; if (v) v.setPlacement(p); }
    setProgression(i) { this.prog = clamp(i, 0, PROGS.length - 1); }

    /* ---------- hybrids ---------- */
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

    /* ---------- analysis ---------- */
    analyse() {
      const L = this.levels;
      if (!this.ctx || !this.analyser) {
        L.rms *= 0.9; L.level *= 0.9; for (let i = 0; i < 8; i++) L.bands[i] *= 0.9;
        return L;
      }
      const td = this._time;
      this.analyser.getFloatTimeDomainData(td);
      let sum = 0;
      for (let i = 0; i < td.length; i++) sum += td[i] * td[i];
      const rms = Math.sqrt(sum / td.length);
      const target = clamp((rms - 0.004) * 5.5, 0, 1);
      L.rms = rms;
      L.level += (target - L.level) * (target > L.level ? 0.45 : 0.06);
      const f = this._freq;
      this.analyser.getByteFrequencyData(f);
      const n = f.length;
      for (let b = 0; b < 8; b++) {
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
