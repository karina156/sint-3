/* =========================================================
   audio.js — Web Audio engine for the story
   «все формы происходят от двух»

   Two worlds play at first, each on its own clock:
     he  (square) — E♭ Lydian, 123 BPM — «он одинок»
     she (circle) — B whole-tone, 133 BPM — «она потеряна»
   When they start to look for each other the worlds unite on one clock
   and travel through the scenes:
     search — G harmonic minor, 85 — «поиск той»
     meet   — B whole-tone, 85, a call and an answer — «где ты» / «я тут, привет»
     light  — D major, 95 — «свет ваш»: children are born
     final  — D major, a last cadence — «снова двое»
   (worlds = the author's saved choices in the harmony lab)

   Shared for all scenes: Euclidean rhythms, a motif that develops, interlocking
   cells, just intonation where the interval is pure, reverb + ping-pong delay,
   sidechain from the square, soft saturation, quantized entries, hybrids
   that glide from friction (16:15) to a fifth (3:2).
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  const LOOKAHEAD = 0.12;
  const TICK_MS = 25;
  const C2 = 65.406;

  /* ---------- scales and worlds ---------- */
  const SCALES = {
    ionian: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
    phrygian: [0, 1, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11],
    mixolydian: [0, 2, 4, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    locrian: [0, 1, 3, 5, 6, 8, 10],
    harmonic: [0, 2, 3, 5, 7, 8, 11],
    whole: [0, 2, 4, 6, 8, 10]
  };
  const WORLDS = {
    he:     { name: 'he',     mode: 'lydian',   tonic: 3,  bpm: 123, prog: [0, 3] },
    she:    { name: 'she',    mode: 'whole',    tonic: 11, bpm: 133, prog: [0, 5, 3, 4] },
    search: { name: 'search', mode: 'harmonic', tonic: 7,  bpm: 85,  prog: [0, 5, 3, 4] },
    meet:   { name: 'meet',   mode: 'whole',    tonic: 11, bpm: 85,  prog: [0, 3] },
    light:  { name: 'light',  mode: 'ionian',   tonic: 2,  bpm: 95,  prog: [0, 3, 0, 6] },
    final:  { name: 'final',  mode: 'ionian',   tonic: 2,  bpm: 95,  prog: [0] }
  };
  /* just intonation where the interval is pure, equal temperament otherwise
     (the whole-tone scale has no pure fifth and must keep its colour) */
  const JI = { 0: 1, 3: 6 / 5, 4: 5 / 4, 5: 4 / 3, 7: 3 / 2, 8: 8 / 5, 9: 5 / 3, 12: 2, 14: 9 / 4, 15: 12 / 5, 16: 5 / 2 };
  const ratio = (semi) => JI[semi] || Math.pow(2, semi / 12);

  function chordOf(world, d) {
    const s = SCALES[world.mode], n = s.length;
    const deg = (x) => { const o = Math.floor(x / n), i = ((x % n) + n) % n; return s[i] + 12 * o; };
    const hz = (semi) => C2 * Math.pow(2, (world.tonic + semi) / 12);
    const r = deg(d);
    return {
      d, world: world.name,
      root: hz(r),
      third: deg(d + 2) - r, fifth: deg(d + 4) - r, ninth: deg(d + 1) + 12 - r,
      note: (off, oct) => hz(deg(d + off) + 12 * oct)
    };
  }

  /* ---------- rhythm ---------- */
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
  function env(g, t, peak, attack, decay) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }
  const octOf = (y01) => (y01 < 0.34 ? 1 : y01 > 0.66 ? -1 : 0);

  /* -------------------------------------------------------
     Clock: one world's transport (tempo glides, the world changes on a bar line)
     ------------------------------------------------------- */
  class Clock {
    constructor(id, world) {
      this.id = id;
      this.world = world;
      this.pending = null;
      this.bpm = world.bpm;
      this.bpmTarget = world.bpm;
      this.step = 0;
      this.nextTime = 0;
      this.progStart = 0;
      this.chord = chordOf(world, world.prog[0]);
    }
    get stepDur() { return 60 / this.bpm / 4; }
    setWorld(w) { this.pending = w; this.bpmTarget = w.bpm; }
  }

  /* -------------------------------------------------------
     Voice base
     ------------------------------------------------------- */
  class Voice {
    constructor(engine, id, sends, clockId) {
      this.engine = engine;
      this.id = id;
      this.clockId = clockId;
      this.on = false;
      this.onAt = 0;
      this.offAt = 0;
      this.sends = sends;
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
      this.dblDelay = ctx.createDelay(0.1); this.dblDelay.delayTime.value = 0.022;
      this.dblLfo = ctx.createOscillator(); this.dblLfo.frequency.value = 0.37 + Math.random() * 0.2;
      this.dblLfoAmt = ctx.createGain(); this.dblLfoAmt.gain.value = 0.0028;
      this.dblLfo.connect(this.dblLfoAmt).connect(this.dblDelay.delayTime); this.dblLfo.start();
      this.dblGain = ctx.createGain(); this.dblGain.gain.value = 0;
      this.dblPan = ctx.createStereoPanner(); this.dblPan.pan.value = 0.45;
      this.out.connect(this.dblDelay).connect(this.dblGain).connect(this.dblPan).connect(engine.bus);
      this.dblPan.connect(engine.revIn);
    }
    setOn(on, at) {
      on = !!on;
      if (on === this.on) return on ? this.onAt : this.offAt;
      this.on = on;
      if (on) this.onAt = at; else this.offAt = at;
      glide(this.gate.gain, on ? 1 : 0, this.engine.ctx, on ? 0.08 : 0.18, at);
      return at;
    }
    active(t) { return this.on ? t >= this.onAt - 1e-4 : t < this.offAt - 1e-4; }
    setVolume(v) { glide(this.vol.gain, v, this.engine.ctx, 0.04); }
    setDouble(a) { glide(this.dblGain.gain, a ? 0.75 : 0, this.engine.ctx, 0.08); }
    setPlacement(p) {
      this.place = p;
      const ctx = this.engine.ctx;
      glide(this.pan.pan, clamp((p.x01 * 2 - 1) * 0.75, -0.8, 0.8), ctx, 0.12);
      glide(this.rev.gain, this.sends.rev * (0.7 + 0.6 * (1 - p.y01)), ctx, 0.2);
    }
    step() {}
    chord() {}
  }

  /* -------- circle: she — the pad -------- */
  class PadVoice extends Voice {
    constructor(engine) {
      super(engine, 'circle', { rev: 0.55, del: 0.08 }, 'she');
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
      this.filter.frequency.value = 800; this.filter.Q.value = 0.7;
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
      this.bright = mk('triangle', 7, 0);
      this.sub = mk('sine', 0, 0.22);
      this.lfo = ctx.createOscillator(); this.lfo.frequency.value = 0.08;
      this.lfoAmt = ctx.createGain(); this.lfoAmt.gain.value = 120;
      this.lfo.connect(this.lfoAmt).connect(this.filter.frequency); this.lfo.start();
      // her voice: a soft choir — a buzz through two vowel formants ("oo" → "ah" with the arrow)
      this.voiceSrc = ctx.createOscillator(); this.voiceSrc.type = 'sawtooth';
      this.voiceSrc2 = ctx.createOscillator(); this.voiceSrc2.type = 'sawtooth'; this.voiceSrc2.detune.value = 9;
      const vib = ctx.createOscillator(); vib.frequency.value = 4.6;
      this.vibAmt = ctx.createGain(); this.vibAmt.gain.value = 5;
      vib.connect(this.vibAmt); this.vibAmt.connect(this.voiceSrc.detune); this.vibAmt.connect(this.voiceSrc2.detune); vib.start();
      this.voiceMix = ctx.createGain(); this.voiceMix.gain.value = 0.5;
      this.voiceSrc.connect(this.voiceMix); this.voiceSrc2.connect(this.voiceMix);
      const fm = (q, g) => {
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q;
        const gg = ctx.createGain(); gg.gain.value = g;
        this.voiceMix.connect(f).connect(gg).connect(this.choir);
        return f;
      };
      this.choir = ctx.createGain(); this.choir.gain.value = 0;
      this.F1 = fm(7, 1.0); this.F2 = fm(9, 0.55); this.F3 = fm(11, 0.18);
      const choirLp = ctx.createBiquadFilter(); choirLp.type = 'lowpass'; choirLp.frequency.value = 3000;
      this.choir.connect(choirLp).connect(this.duckG);
      this.voiceSrc.start(); this.voiceSrc2.start();
      // breath: airy noise in the same vowel, swelling slowly
      this.breath = ctx.createBufferSource(); this.breath.buffer = engine.noise; this.breath.loop = true;
      this.breathF = ctx.createBiquadFilter(); this.breathF.type = 'bandpass'; this.breathF.Q.value = 1.6;
      this.breathG = ctx.createGain(); this.breathG.gain.value = 0.012;
      const bl = ctx.createOscillator(); bl.frequency.value = 0.13;
      const bla = ctx.createGain(); bla.gain.value = 0.008;
      bl.connect(bla).connect(this.breathG.gain); bl.start();
      this.breath.connect(this.breathF).connect(this.breathG).connect(this.duckG); this.breath.start();
      this.timbre = 0.5;
      this.chord(engine.clocks.she.chord, ctx.currentTime);
      this.setTimbre(0.5);
    }
    chord(c, t) {
      const ctx = this.engine.ctx, r = c.root * 2, tau = 0.35;
      glide(this.root.o.frequency, r, ctx, tau, t);
      glide(this.fifth.o.frequency, r * ratio(c.fifth), ctx, tau, t);
      glide(this.third.o.frequency, r * 2 * ratio(c.third), ctx, tau, t);
      glide(this.ninth.o.frequency, r * ratio(c.ninth), ctx, tau, t);
      glide(this.bright.o.frequency, r, ctx, tau, t);
      glide(this.sub.o.frequency, r / 2, ctx, tau, t);
      glide(this.voiceSrc.frequency, r * ratio(c.fifth), ctx, tau, t);
      glide(this.voiceSrc2.frequency, r * 2 * ratio(c.third), ctx, tau, t);
    }
    setTimbre(t) {
      this.timbre = t = clamp(t, 0, 1);
      const ctx = this.engine.ctx;
      glide(this.filter.frequency, 320 * Math.pow(7, t), ctx, 0.06);
      glide(this.filter.Q, 0.6 + t * 1.2, ctx, 0.06);
      glide(this.root.g.gain, 0.55 - 0.22 * t, ctx, 0.06);
      glide(this.fifth.g.gain, 0.13 + 0.2 * t, ctx, 0.06);
      glide(this.third.g.gain, 0.1 + 0.12 * t, ctx, 0.06);
      glide(this.bright.g.gain, 0.09 * t * t, ctx, 0.06);
      glide(this.lfoAmt.gain, 40 + 120 * t, ctx, 0.2);
      // vowel: oo (300/870/2240) → oh (500/900/2400) → ah (730/1090/2440)
      const mix = (a, b) => a + (b - a) * t;
      glide(this.F1.frequency, mix(300, 730), ctx, 0.12);
      glide(this.F2.frequency, mix(870, 1090), ctx, 0.12);
      glide(this.F3.frequency, mix(2240, 2440), ctx, 0.12);
      glide(this.breathF.frequency, mix(900, 1500), ctx, 0.12);
      glide(this.choir.gain, 0.08 + 0.07 * t, ctx, 0.1);
      if (this.engine.voices.oval) this.engine.voices.oval.follow(t);
    }
    setEnergy(e) { glide(this.ninth.g.gain, 0.03 + 0.14 * e, this.engine.ctx, 1.5); }
    setVolume(v) { glide(this.vol.gain, v * v, this.engine.ctx, 0.05); }
    duck(t, amt) {
      const g = this.duckG.gain;
      g.setTargetAtTime(1 - amt * 0.45, t, 0.012);
      g.setTargetAtTime(1, t + 0.04, 0.18);
    }
  }

  /* -------- oval: a child — the motif -------- */
  const MOTIF = [0, 2, 4, 1, 3, 5, 2, 6];
  class MotifVoice extends Voice {
    constructor(engine) {
      super(engine, 'oval', { rev: 0.45, del: 0.32 }, 'she');
      const ctx = engine.ctx;
      this.filter = ctx.createBiquadFilter(); this.filter.type = 'lowpass';
      this.filter.frequency.value = 2600; this.filter.Q.value = 0.9;
      this.duckG = ctx.createGain();
      this.filter.connect(this.duckG).connect(this.gate);
      this.len = 5;
      this.bar = 0;
    }
    follow(t) { glide(this.filter.frequency, 900 + 2100 * t, this.engine.ctx, 0.08); }
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
      const e8 = (s % 16) / 2;
      if (e8 >= this.len) return;
      const form = Math.floor(this.bar / 4) % 4;
      let m = MOTIF[e8 % MOTIF.length];
      if (form === 1) m = m + 2;
      else if (form === 2) m = -m;
      else if (form === 3) m = MOTIF[(this.len - 1 - e8) % MOTIF.length];
      const f = c.note(m, 3 + octOf(this.place.y01));
      const ctx = this.engine.ctx;
      // a bell: FM with an inharmonic modulator whose shimmer fades into a pure tone
      const accent = e8 === 0 ? 1 : 0.72;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const mod = ctx.createOscillator(); mod.type = 'sine'; mod.frequency.value = f * 3.5;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(f * 1.6 * accent, t);
      mg.gain.setTargetAtTime(f * 0.08, t + 0.01, 0.18);
      mod.connect(mg).connect(o.frequency);
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.005;
      const g = ctx.createGain(), g2 = ctx.createGain(); g2.gain.value = 0.12;
      o.connect(g); o2.connect(g2).connect(g); g.connect(this.filter);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.17 * accent, t + 0.006);
      g.gain.setTargetAtTime(0, t + 0.02, 0.45);
      o.start(t); o2.start(t); mod.start(t); o.stop(t + 2.6); o2.stop(t + 2.6); mod.stop(t + 2.6);
      this.engine.visual(t, 'oval', 0, accent);
    }
  }

  /* -------- square: he — Euclidean pulse -------- */
  const SQ = {
    1: (r) => euclid(3, 8, r).concat(euclid(3, 8, r)),
    2: (r) => euclid(5, 8, r).concat(euclid(5, 8, r)),
    3: (r) => euclid(11, 16, r)
  };
  class PercVoice extends Voice {
    constructor(engine) {
      super(engine, 'square', { rev: 0.2, del: 0.06 }, 'he');
      this.layers = 1;
      this.vol.gain.value = 0.85;
    }
    pattern() { return SQ[this.layers](this.place.col * 3); }
    layerOf(q) {
      const rot = this.place.col * 3;
      if (SQ[1](rot)[q]) return 1;
      if (SQ[2](rot)[q]) return 2;
      return 3;
    }
    step(s, t, c) {
      if (!this.active(t)) return;
      const q = s % 16;
      if (!this.pattern()[q]) return;
      const layer = this.layerOf(q);
      const vel = q === 0 ? 1 : layer === 1 ? 0.82 : layer === 2 ? 0.6 : 0.42;
      this.hit(t, vel, c.root * Math.pow(2, octOf(this.place.y01)), layer);
      this.engine.duck(t, vel);
      this.engine.visual(t, 'square', layer, vel);
    }
    hit(t, vel, root, layer) {
      const ctx = this.engine.ctx;
      const f = layer === 3 ? root * 4 : root * 2;
      // his voice: a wooden bar. Layer 1 is the low log drum (a thump with a dropping pitch),
      // layers 2–3 are marimba bars (fundamental + the bar's 3.93 and 9.2 partials) and a mallet knock
      const g = ctx.createGain(); g.connect(this.gate);
      if (layer === 1) {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f * 1.5, t);
        o.frequency.exponentialRampToValueAtTime(f * 0.98, t + 0.07);
        env(g, t, 0.58 * vel, 0.004, 0.36);
        o.connect(g); o.start(t); o.stop(t + 0.55);
        const p = ctx.createOscillator(); p.type = 'sine'; p.frequency.value = f * 2.76;
        const pg = ctx.createGain(); env(pg, t, 0.12 * vel, 0.003, 0.08);
        p.connect(pg).connect(this.gate); p.start(t); p.stop(t + 0.2);
      } else {
        const ff = layer === 3 ? f : f * 1.5;
        [[1, 0.36, layer === 3 ? 0.2 : 0.3], [3.93, 0.09, 0.07], [9.2, 0.03, 0.025]].forEach(([m, a, d]) => {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = ff * m;
          const pg = ctx.createGain(); env(pg, t, a * vel, 0.003, d);
          o.connect(pg).connect(g); o.start(t); o.stop(t + d * 5 + 0.05);
        });
        g.gain.value = 1;
      }
      // mallet: a short, woody knock (band-limited noise, low-mid, not a hiss)
      const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = layer === 1 ? 700 : 1300; bp.Q.value = 2.5;
      const ng = ctx.createGain(); env(ng, t, 0.07 * vel, 0.001, 0.016);
      n.connect(bp).connect(ng).connect(this.gate);
      n.start(t, Math.random() * 0.5); n.stop(t + 0.04);
    }
  }

  /* -------- rect: a child — polymeter -------- */
  const RC = { 1: [2, 5], 2: [3, 7], 3: [5, 9] };
  class GlitchVoice extends Voice {
    constructor(engine) {
      super(engine, 'rect', { rev: 0.32, del: 0.26 }, 'he');
      const ctx = engine.ctx;
      this.layers = 1;
      this.k = 0;
      this.crush = ctx.createGain();   // was a bitcrusher; now a clean input
      this.bp = ctx.createBiquadFilter(); this.bp.type = 'lowpass';
      this.bp.frequency.value = 3600; this.bp.Q.value = 0.5;
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
      const jumps = [1, 1.5, 1, 2, 1, 1.5, 0.75, 1, 2];
      const f = c.root * 4 * Math.pow(2, octOf(this.place.y01)) * (this.layers === 3 ? jumps[i % jumps.length] : 1);
      const ratchet = this.layers === 3 && i === 0 ? 3 : this.layers >= 2 && i === n - 1 ? 2 : 1;
      const step = this.engine.clockOf(this).stepDur;
      for (let r = 0; r < ratchet; r++) this.blip(t + (r * step) / ratchet, f * (r ? 2 : 1), r ? 0.55 : 0.9);
      this.engine.visual(t, 'rect', ratchet > 1 ? 3 : this.layers === 1 ? 1 : 2, 0.8);
    }
    blip(t, f, vel) {
      const ctx = this.engine.ctx;
      // a plucked string (koto-like): two slightly detuned saws, the filter closes after the pluck
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 2.2;
      lp.frequency.setValueAtTime(Math.min(9000, f * 7), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(200, f * 1.1), t + 0.16);
      const g = ctx.createGain();
      env(g, t, 0.13 * vel, 0.002, 0.2);
      for (const dt of [-7, 6]) {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = dt;
        o.frequency.setValueAtTime(f * 1.012, t);
        o.frequency.exponentialRampToValueAtTime(f, t + 0.03);           // the string settles after the pluck
        o.connect(lp); o.start(t); o.stop(t + 0.42);
      }
      lp.connect(g).connect(this.crush);
    }
  }

  /* -------- small circles: children — interlocking cells -------- */
  const CELLS = {
    blip:  { steps: [0, 6, 11], degs: [4, 7, 9] },
    beep:  { steps: [3, 8, 14], degs: [2, 5, 7] },
    chirp: { steps: [5, 10, 13], degs: [9, 7, 11] },
    click: { steps: [2, 7, 12, 15], degs: [0, 0, 0, 0] }
  };
  class FxVoice extends Voice {
    constructor(engine, id, kind) {
      super(engine, id, { rev: 0.38, del: 0.3 }, 'he');
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
      const f = c.note(this.cell.degs[idx], 3 + octOf(this.place.y01));
      const out = ctx.createGain(); out.connect(this.gate);
      if (k === 'click') {                                   // a soft wooden tick
        const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 6;
        env(out, t, 0.16, 0.001, 0.02);
        n.connect(bp).connect(out); n.start(t, Math.random()); n.stop(t + 0.05);
      } else if (k === 'blip') {                             // a water drop: a fast upward bend
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f * 0.55, t);
        o.frequency.exponentialRampToValueAtTime(f * 1.5, t + 0.045);
        env(out, t, 0.24, 0.003, 0.07);
        o.connect(out); o.start(t); o.stop(t + 0.2);
      } else if (k === 'beep') {                             // an ocarina: round tone, breath and vibrato
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const vib = ctx.createOscillator(); vib.frequency.value = 5.5;
        const va = ctx.createGain(); va.gain.setValueAtTime(0, t); va.gain.linearRampToValueAtTime(f * 0.012, t + 0.12);
        vib.connect(va).connect(o.frequency);
        const h = ctx.createOscillator(); h.type = 'sine'; h.frequency.value = f * 2;
        const hg = ctx.createGain(); hg.gain.value = 0.12; h.connect(hg).connect(out);
        const n = ctx.createBufferSource(); n.buffer = this.engine.noise;
        const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = f * 2; nb.Q.value = 3;
        const ng = ctx.createGain(); ng.gain.value = 0.25; n.connect(nb).connect(ng).connect(out);
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(0.2, t + 0.04);
        out.gain.setTargetAtTime(0, t + 0.16, 0.08);
        o.connect(out);
        [o, vib, h].forEach((x) => { x.start(t); x.stop(t + 0.6); });
        n.start(t, Math.random()); n.stop(t + 0.6);
      } else {                                               // a bird: two quick rising chirps
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(f * 1.6, t);
        o.frequency.exponentialRampToValueAtTime(f * 3, t + 0.04);
        o.frequency.setValueAtTime(f * 1.9, t + 0.06);
        o.frequency.exponentialRampToValueAtTime(f * 3.4, t + 0.1);
        out.gain.setValueAtTime(0, t);
        out.gain.linearRampToValueAtTime(0.1, t + 0.008);
        out.gain.linearRampToValueAtTime(0.01, t + 0.045);
        out.gain.linearRampToValueAtTime(0.09, t + 0.065);
        out.gain.setTargetAtTime(0, t + 0.09, 0.02);
        o.connect(out); o.start(t); o.stop(t + 0.25);
      }
      this.engine.visual(t, this.id, 0, 0.8);
    }
  }

  /* -------- hybrid: friction on contact → consonance when merged -------- */
  const TRAITS = {
    circle: { wave: 'sine', mul: 2, rhythmic: false },
    oval: { wave: 'triangle', mul: 4, rhythmic: false },
    square: { wave: 'triangle', mul: 2, rhythmic: true },
    rect: { wave: 'triangle', mul: 4, rhythmic: true },
    capsule: { wave: 'triangle', mul: 3, rhythmic: false },
    fx: { wave: 'sine', mul: 8, rhythmic: true }
  };
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
      this.ring = ctx.createGain(); this.ring.gain.value = 0;
      this.oscA.connect(this.ring); this.oscB.connect(this.ring.gain);
      this.ringMix = ctx.createGain(); this.ringMix.gain.value = 1;
      this.sumMix = ctx.createGain(); this.sumMix.gain.value = 0.2;
      this.ring.connect(this.ringMix);
      this.oscA.connect(this.sumMix); this.oscB.connect(this.sumMix);
      this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 1500; this.lp.Q.value = 0.5;
      this.ringMix.connect(this.lp); this.sumMix.connect(this.lp);
      const rhythmic = a.rhythmic || b.rhythmic;
      this.trem = ctx.createGain(); this.trem.gain.value = rhythmic ? 0.55 : 0.85;
      this.lfo = ctx.createOscillator(); this.lfo.type = 'sine';
      this.lfo.frequency.value = rhythmic ? (engine.clocks.he.bpm / 60) * 2 : 0.2;
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
      glide(this.ringMix.gain, 0.45 * (1 - l), ctx, 0.15);
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
      this.united = false;
      this.dialog = false;
      this.energy = 0;
      this.visualQueue = [];
      this.userVolume = 0.85;
      this._timer = null;
      this._suspendTimer = null;
      this.clocks = { he: new Clock('he', WORLDS.he), she: new Clock('she', WORLDS.she) };
      this.levels = { rms: 0, level: 0, bands: new Float32Array(8) };
    }
    get ready() { return !!this.ctx; }
    get chord() { return this.clocks.he.chord; }
    clockOf(v) { return this.united ? this.clocks.he : this.clocks[v.clockId]; }

    ensure() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended' && this.scenePlaying) this.ctx.resume();
        return this.ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));

      this.bus = ctx.createGain();
      this.mix = ctx.createGain();
      this.air = ctx.createBiquadFilter(); this.air.type = 'lowpass'; this.air.frequency.value = 4200; this.air.Q.value = 0.4;
      this.sat = ctx.createWaveShaper();
      const sc = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) { const x = (i / 2047) * 2 - 1; sc[i] = Math.tanh(1.05 * x) / Math.tanh(1.05); }
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

      this.revIn = ctx.createGain();
      this.convolver = ctx.createConvolver();
      this.convolver.buffer = this._impulse(3.4);
      this.revPre = ctx.createBiquadFilter(); this.revPre.type = 'highpass'; this.revPre.frequency.value = 180;
      this.revOut = ctx.createGain(); this.revOut.gain.value = 0.68;
      this.revIn.connect(this.revPre).connect(this.convolver).connect(this.revOut).connect(this.mix);

      this.delIn = ctx.createGain();
      this.dL = ctx.createDelay(3); this.dR = ctx.createDelay(3);
      this.fb = ctx.createGain(); this.fb.gain.value = 0.38;
      this.fbLp = ctx.createBiquadFilter(); this.fbLp.type = 'lowpass'; this.fbLp.frequency.value = 2400;
      const pL = ctx.createStereoPanner(), pR = ctx.createStereoPanner();
      pL.pan.value = -0.7; pR.pan.value = 0.7;
      this.delOut = ctx.createGain(); this.delOut.gain.value = 0.42;
      this.delIn.connect(this.dL);
      this.dL.connect(this.dR); this.dR.connect(this.fbLp).connect(this.fb).connect(this.dL);
      this.dL.connect(pL).connect(this.delOut); this.dR.connect(pR).connect(this.delOut);
      this.delOut.connect(this.mix);
      this.delOut.connect(this.revIn);
      this._delayTime();

      // the dialogue of the meeting: his call and her answer
      this.dialogOut = ctx.createGain(); this.dialogOut.gain.value = 0.9;
      this.dialogOut.connect(this.bus);
      const ds = ctx.createGain(); ds.gain.value = 0.5; this.dialogOut.connect(ds).connect(this.revIn);

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
          const k = 0.35 + 0.6 * t;
          lp += (Math.random() * 2 - 1 - lp) * (1 - k);
          d[i] = lp * Math.pow(1 - t, 2.6) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
        }
      }
      return buf;
    }
    _delayTime() {
      if (!this.ctx) return;
      const dt = this.clocks.he.stepDur * 3;            // dotted eighth of the leading clock
      glide(this.dL.delayTime, dt, this.ctx, 0.5);
      glide(this.dR.delayTime, dt, this.ctx, 0.5);
    }

    /* ---------- scene (screen-level) ---------- */
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
      const t0 = this.ctx.currentTime + 0.06;
      for (const c of Object.values(this.clocks)) {
        c.nextTime = t0;
        c.step = Math.ceil(c.step / 16) * 16;
      }
      this._timer = setInterval(() => this._tick(), TICK_MS);
      this._tick();
    }
    stopTransport() { this.running = false; clearInterval(this._timer); }
    activeClocks() { return this.united ? [this.clocks.he] : [this.clocks.he, this.clocks.she]; }
    nextBeat(v) {
      if (!this.ctx) return 0;
      if (!this.running) return this.ctx.currentTime + 0.04;
      const c = v ? this.clockOf(v) : this.clocks.he;
      let s = c.step;
      while (s % 4) s++;
      return c.nextTime + (s - c.step) * c.stepDur;
    }
    nextBar() {
      const c = this.clocks.he;
      if (!this.running) return this.ctx.currentTime + 0.04;
      let s = c.step;
      while (s % 16) s++;
      return c.nextTime + (s - c.step) * c.stepDur;
    }
    _tick() {
      const ctx = this.ctx;
      if (!ctx || !this.running) return;
      for (const c of this.activeClocks()) {
        if (c.nextTime < ctx.currentTime - 0.2) c.nextTime = ctx.currentTime + 0.02;
        while (c.nextTime < ctx.currentTime + LOOKAHEAD) {
          this._schedule(c, c.step, c.nextTime);
          c.bpm += (c.bpmTarget - c.bpm) * 0.06;      // tempo glides over about two bars
          c.nextTime += c.stepDur;
          c.step++;
        }
      }
    }
    voicesOn(clock) {
      const out = [];
      for (const id in this.voices) { const v = this.voices[id]; if (this.clockOf(v) === clock) out.push(v); }
      return out;
    }
    _schedule(c, s, t) {
      if (s % 16 === 0 && c.pending) {                  // a new world starts on a bar line
        c.world = c.pending; c.pending = null; c.progStart = s;
        if (c.id === 'he') this._delayTime();
        if (c.id === 'he') this.visual(t, 'world', 0, 1, c.world.name);
      }
      if ((s - c.progStart) % 32 === 0) {
        const p = c.world.prog;
        const chord = chordOf(c.world, p[Math.floor((s - c.progStart) / 32) % p.length]);
        c.chord = chord;
        for (const v of this.voicesOn(c)) v.chord(chord, t);
        if (c.id === 'he') this.hybrids.forEach((h) => h.chord(chord, t));
      }
      const vs = this.voicesOn(c);
      if (c.id === 'he' && s % 16 === 0) {
        let n = 0;
        for (const id in this.voices) if (this.voices[id].active(t)) n++;
        this.energy = clamp(this.energy + (n >= 2 ? 0.05 + 0.01 * (n - 2) : -0.08), 0, 1);
        this._applyEnergy(t);
      }
      for (const v of vs) v.step(s, t, c.chord);
      if (c.id === 'he' && this.dialog) this._dialog(s, t, c);
      if (c.id === 'he' && s % 4 === 0) this.visual(t, 'beat', (s % 16) / 4, 1);
    }
    /* «где ты» rises and stays open, «я тут, привет» falls home */
    _dialog(s, t, c) {
      const q = s % 16, bar = Math.floor(s / 16);
      if (q === 0) this.visual(t, 'dialog', bar % 2, 1);
      if (q % 2 || q > 6) return;
      const i = q / 2;
      const call = bar % 2 === 0;
      const degs = call ? [0, 2, 4, 6] : [4, 3, 1, 0];
      const f = c.chord.note(degs[i], 3);
      const ctx = this.ctx;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(f, t);
      if (!call) {                                       // her answer sings with a slow vibrato
        const vib = ctx.createOscillator(), va = ctx.createGain();
        vib.frequency.value = 5; va.gain.value = f * 0.006;
        vib.connect(va).connect(o.frequency); vib.start(t); vib.stop(t + 0.9);
      }
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(call ? 0.13 : 0.15, t + 0.05);
      g.gain.setTargetAtTime(0, t + 0.14, i === 3 ? 0.45 : 0.22);
      o.connect(g).connect(this.dialogOut);
      o.start(t); o.stop(t + 1.6);
    }
    _applyEnergy(t) {
      const ctx = this.ctx, e = this.energy;
      glide(this.air.frequency, 4200 + 4500 * e * e, ctx, 1.2, t);
      glide(this.revOut.gain, 0.62 + 0.2 * e, ctx, 1.5, t);
      glide(this.fb.gain, 0.32 + 0.16 * e, ctx, 1.5, t);
      if (this.voices.circle) this.voices.circle.setEnergy(e);
    }
    duck(t, vel) {
      if (this.voices.circle) this.voices.circle.duck(t, 0.35 * vel);
      if (this.voices.oval) this.voices.oval.duck(t, 0.25 * vel);
    }

    /* ---------- the story ---------- */
    /* a world for one clock, or — once united — for the shared clock */
    setWorld(name, clockId = 'he') {
      const w = WORLDS[name];
      if (!w) return;
      if (this.united || clockId === 'he') this.clocks.he.setWorld(w);
      else this.clocks.she.setWorld(w);
    }
    /* the two worlds become one: everything follows his clock from the next bar */
    unite(name) {
      if (this.united) { this.setWorld(name); return; }
      const he = this.clocks.he, she = this.clocks.she;
      he.setWorld(WORLDS[name]);
      this.united = true;
      she.pending = null;
      if (this.ctx) for (const id in this.voices) this.voices[id].chord(he.chord, this.ctx.currentTime);
    }
    setDialog(on) { this.dialog = !!on; }
    worldName() { return this.clocks.he.pending ? this.clocks.he.pending.name : this.clocks.he.world.name; }

    /* a birth: two tones rub, find the fifth, and the child answers with three notes */
    /* a birth is a machine re-assembly:
       1 a data stream — stepped, lightly crushed pulses scanning across the stereo field, accelerating;
       2 a servo — a metallic FM tone that climbs in quantized steps while its flutter speeds up and locks;
       3 a buffer stutter right before the lock;
       4 lock — a digital click, the chord as one block and a two-tone "confirm" */
    birth() {
      if (!this.ctx || !this.scenePlaying) return 0;
      const ctx = this.ctx, t = this.nextBeat(), c = this.chord;
      const LOCK = 1.15, L = t + LOCK;
      const out = ctx.createGain(); out.gain.value = 0.42;
      out.connect(this.bus);
      const rs = ctx.createGain(); rs.gain.value = 0.3; out.connect(rs).connect(this.revIn);
      const crush = ctx.createWaveShaper(); crush.curve = this.crushCurve;
      const crushLp = ctx.createBiquadFilter(); crushLp.type = 'lowpass'; crushLp.frequency.value = 4200; crushLp.Q.value = 0.6;
      crush.connect(crushLp).connect(out);
      const tones = [0, 2, 4, 7].map((d) => c.note(d, 4));

      // 1 · data stream: square pulses, sample-and-hold pitches snapping to chord tones, ping-pong
      let tt = t, i = 0;
      while (tt < t + 0.78) {
        const k = (tt - t) / 0.78;
        const f = tones[(i * 3 + (Math.random() * 2 | 0)) % tones.length] * (Math.random() < 0.3 ? 2 : 1);
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
        const g = ctx.createGain(), pan = ctx.createStereoPanner();
        pan.pan.value = (i % 2 ? 1 : -1) * (0.85 - 0.6 * k);
        env(g, tt, 0.05 + 0.04 * k, 0.001, 0.022);
        o.connect(g).connect(pan).connect(crush);
        o.start(tt); o.stop(tt + 0.08);
        tt += 0.075 - 0.045 * k;                                   // the stream speeds up
        i++;
      }

      // 2 · servo: FM carrier on the root climbing in steps to the octave; flutter speeds up, then stops
      const f0 = c.note(0, 3);
      const car = ctx.createOscillator(); car.type = 'sine';
      const mod = ctx.createOscillator(); mod.type = 'sine';
      const idx = ctx.createGain();
      const steps = [0, 2, 4, 5, 7, 9, 11, 12];
      steps.forEach((st, j) => {
        const at = t + 0.25 + j * ((LOCK - 0.35) / steps.length);
        const fr = f0 * Math.pow(2, st / 12);
        car.frequency.setValueAtTime(fr, at);
        mod.frequency.setValueAtTime(fr * 1.41, at);             // an inharmonic, metallic ratio
      });
      car.frequency.setValueAtTime(f0, t); mod.frequency.setValueAtTime(f0 * 1.41, t);
      idx.gain.setValueAtTime(f0 * 0.4, t);
      idx.gain.linearRampToValueAtTime(f0 * 2.2, L - 0.1);
      idx.gain.linearRampToValueAtTime(0, L);
      mod.connect(idx).connect(car.frequency);
      const flutter = ctx.createOscillator(); flutter.type = 'square';
      flutter.frequency.setValueAtTime(6, t);
      flutter.frequency.exponentialRampToValueAtTime(48, L - 0.12);
      const fa = ctx.createGain(); fa.gain.value = 0.5;
      const sg = ctx.createGain(); sg.gain.value = 0.5;
      flutter.connect(fa).connect(sg.gain);
      const sv = ctx.createGain();
      sv.gain.setValueAtTime(0, t + 0.2);
      sv.gain.linearRampToValueAtTime(0.07, t + 0.5);
      sv.gain.setValueAtTime(0.07, L - 0.2);
      sv.gain.linearRampToValueAtTime(0, L - 0.12);
      const svLp = ctx.createBiquadFilter(); svLp.type = 'lowpass'; svLp.frequency.value = 3200;
      car.connect(sg).connect(svLp).connect(sv).connect(out);
      [car, mod, flutter].forEach((o) => { o.start(t); o.stop(L + 0.05); });

      // 3 · buffer stutter: the last piece of the stream repeats faster and faster
      [0, 0.045, 0.078, 0.1].forEach((d, j) => {
        const at = L - 0.12 + d;
        const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = tones[3] * 2;
        const g = ctx.createGain(); env(g, at, 0.05 + j * 0.012, 0.001, 0.012);
        o.connect(g).connect(crush); o.start(at); o.stop(at + 0.04);
      });

      // 4 · lock: a one-sample digital click, the chord as a block, then a two-tone confirm
      const imp = ctx.createBuffer(1, 64, ctx.sampleRate); imp.getChannelData(0)[0] = 1; imp.getChannelData(0)[1] = -0.6;
      const ck = ctx.createBufferSource(); ck.buffer = imp;
      const ckg = ctx.createGain(); ckg.gain.value = 0.5;
      const ckf = ctx.createBiquadFilter(); ckf.type = 'bandpass'; ckf.frequency.value = 3000; ckf.Q.value = 2;
      ck.connect(ckf).connect(ckg).connect(out); ck.start(L);
      const block = ctx.createBiquadFilter(); block.type = 'lowpass'; block.Q.value = 1.5;
      block.frequency.setValueAtTime(5000, L);
      block.frequency.exponentialRampToValueAtTime(900, L + 0.6);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0, L);
      bg.gain.linearRampToValueAtTime(0.07, L + 0.004);
      bg.gain.setTargetAtTime(0, L + 0.05, 0.4);
      block.connect(bg).connect(out);
      tones.slice(0, 3).forEach((f, j) => {
        const o = ctx.createOscillator(); o.type = j ? 'triangle' : 'square'; o.frequency.value = f;
        o.connect(block); o.start(L); o.stop(L + 2.5);
      });
      [[tones[2] * 2, 0.16], [tones[0] * 4, 0.27]].forEach(([f, d]) => {
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.setValueAtTime(0, L + d);
        g.gain.linearRampToValueAtTime(0.045, L + d + 0.004);
        g.gain.setValueAtTime(0.045, L + d + 0.07);
        g.gain.linearRampToValueAtTime(0, L + d + 0.085);
        o.connect(g).connect(out); o.start(L + d); o.stop(L + d + 0.12);
      });
      this.visual(L, 'birth', 0, 1);
      return L;
    }

    /* the closing chord in D major (just), long tail into the reverb */
    resolve() {
      if (!this.ctx || !this.scenePlaying) return;
      const ctx = this.ctx, t = this.nextBar();
      const out = ctx.createGain(); out.gain.value = 1;
      out.connect(this.bus); out.connect(this.revIn);
      const D = 73.416;
      const notes = [D * 2, D * 3, D * 4 * 9 / 8, D * 4 * 5 / 4, D * 6];   // D3 A3 E4 F♯4 A4
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.07, t + 0.35 + i * 0.06);
        g.gain.setTargetAtTime(0, t + 0.6, 1.8);
        o.connect(g).connect(out);
        o.start(t); o.stop(t + 10);
      });
      this.energy = 0;
      this._applyEnergy();
      this.visual(t, 'resolve', 0, 1);
    }
    /* back to the beginning: two separate worlds again */
    resetStory() {
      this.united = false;
      this.dialog = false;
      const he = this.clocks.he, she = this.clocks.she;
      he.setWorld(WORLDS.he); she.setWorld(WORLDS.she);
      if (this.running) she.nextTime = Math.max(she.nextTime, this.ctx.currentTime + 0.05);
    }

    visual(time, id, layer, vel, data) {
      if (this.visualQueue.length > 256) this.visualQueue.shift();
      this.visualQueue.push({ time, id, layer, vel, data });
      this.visualQueue.sort((a, b) => a.time - b.time);
    }
    drainVisual(cb) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime, q = this.visualQueue;
      while (q.length && q[0].time <= now) cb(q.shift());
    }

    /* ---------- voice API ---------- */
    setVoiceOn(id, on) { const v = this.voices[id]; return v ? v.setOn(on, this.nextBeat(v)) : 0; }
    setVolume(id, val) { const v = this.voices[id]; if (v) v.setVolume(val); }
    setTimbre(val) { if (this.voices.circle) this.voices.circle.setTimbre(val); }
    setOvalShape(k01) { if (this.voices.oval) this.voices.oval.setShape(k01); }
    setLayers(id, n) { const v = this.voices[id]; if (v) v.layers = clamp(n, 1, 3); }
    setDoubles(on, map) { for (const id in this.voices) this.voices[id].setDouble(on && !!map[id]); }
    setPlacement(id, p) { const v = this.voices[id]; if (v) v.setPlacement(p); }

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
  GP.WORLDS = WORLDS;
})();
