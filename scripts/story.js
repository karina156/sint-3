/* =========================================================
   story.js — «все формы происходят от двух»
   The author's piece, scene by scene — told only by forms and sound, no words on screen
   (the names below are the author's notes, not captions):
     prologue  — only the two are on the poster
     he        — the square wakes: «он одинок»       (E♭ Lydian, 123)
     she       — the circle wakes: «она потеряна»     (B whole-tone, 133)
     search    — one of them is moved: «поиск той»    (G harmonic minor, 85; one clock)
     meet      — they touch: «где ты» / «я тут, привет» (B whole-tone, 85, call and answer)
     light     — they merge, the first child is born: «свет ваш» (D major, 95);
                 every new meeting of forms gives birth to the next one
     finale    — the children leave, the two return: «снова двое»
   Roles: HE = square, SHE = circle (swap the two constants to swap them).
   ========================================================= */
(function () {
  'use strict';
  const GP = (window.GP = window.GP || {});

  const HE = 'square', SHE = 'circle';
  const CHILDREN = ['oval', 'rect', 'fx1', 'fx2', 'fx3', 'capsule'];   // in order of birth
  const TOUCH = 0.22;            // overlap of the two that counts as a touch
  const MERGE = 0.40;            // …and as a union
  const CHILD_MERGE = 0.35;      // union of any two forms in the light
  const BIRTH_GAP = 5;           // seconds between births
  const FAMILY_TIME = 9;         // seconds with the whole family before the finale

  class Story {
    constructor(pg) {
      this.pg = pg;
      this.ui = pg.ui;
      this.t = 0;
      this.CHILDREN = CHILDREN;
      this.reset(true);
    }
    get audio() { return this.pg.audio; }
    body(id) { return this.ui.byId[id]; }
    pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

    /* ---------- scenes ---------- */
    reset(first) {
      this.scene = 'prologue';
      this.since = this.t;
      this.born = [];
      this.used = new Set();
      this.lastBirth = -1e9;
      this.finaleAt = 0;
      this.growing = new Map();
      for (const id of CHILDREN) this.hide(id, true);
      if (!first) {
        const st = this.pg.state;
        for (const id of Object.keys(st.voices)) { st.voices[id].on = false; st.voices[id].doubled = false; }
        st.doubler.on = false;
        this.body(HE).el.classList.remove('is-final');
        this.body(SHE).el.classList.remove('is-final');
        for (const id of [HE, SHE]) this.body(id).touched = false;
        if (this.audio.ready) this.audio.resetStory();
        this.pg.syncAudio();
      }
     
    }
    go(scene) {
      if (this.scene === scene) return;
      this.scene = scene;
      this.since = this.t;
      const a = this.audio;
      if (scene === 'search') a.unite('search');
      else if (scene === 'meet') { a.setWorld('meet'); a.setDialog(true); }
      else if (scene === 'light') { a.setDialog(false); a.setWorld('light'); }
      else if (scene === 'finale') { a.setDialog(false); a.setWorld('final'); }
      this.pg.refresh();
    }

    /* ---------- events from the playground ---------- */
    /* after the finale, touching one of the two starts the story again */
    beforeTap(b) {
      if (this.scene === 'end' && (b.id === HE || b.id === SHE)) this.restart(false);
    }
    afterTap(b) {
      const v = this.pg.state.voices;
      if (this.scene !== 'prologue' && this.scene !== 'he' && this.scene !== 'she') return;
      if (b.id === HE && v[HE].on) this.scene = 'he';
      else if (b.id === SHE && v[SHE].on) this.scene = 'she';
    }
    onVisual() {}
    restart(home = true) {
      this.reset(false);
      if (home) this.pg.ix.returnHome();
      this.pg.refresh();
    }

    /* ---------- each frame ---------- */
    update(dt, pairs) {
      this.t += dt;
      const st = this.pg.state, v = st.voices;
      const both = v[HE].on && v[SHE].on;
      const pp = pairs.get(this.pairKey(HE, SHE));
      const r = pp ? pp.ratio : 0;
      const he = this.body(HE), she = this.body(SHE);
      const moving = he.mode === 'drag' || she.mode === 'drag';
      const inScene = this.t - this.since;

      if ((this.scene === 'he' || this.scene === 'she') && both && moving && st.scene.playing) this.go('search');
      else if (this.scene === 'search' && r > TOUCH && inScene > 2) this.go('meet');
      else if (this.scene === 'meet' && r > MERGE && inScene > 4) {
        this.used.add(this.pairKey(HE, SHE));
        this.go('light');
        this.birth(HE, SHE);
      } else if (this.scene === 'light') {
        if (this.born.length < CHILDREN.length && this.t - this.lastBirth > BIRTH_GAP) {
          for (const [key, p] of pairs) {
            if (p.ratio < CHILD_MERGE || this.used.has(key)) continue;
            const A = this.body(p.a), B = this.body(p.b);
            if (!A || !B || A.unborn || B.unborn) continue;
            if (!(A.mode === 'drag' || B.mode === 'drag')) continue;   // a union needs a hand
            this.used.add(key);
            this.birth(p.a, p.b);
            break;
          }
        }
        if (this.born.length === CHILDREN.length && !this.finaleAt) this.finaleAt = this.t + FAMILY_TIME;
        if (this.finaleAt && this.t >= this.finaleAt) this.finale();
      }

      // children grow with a little overshoot
      for (const [id, g] of this.growing) {
        const b = this.body(id);
        g.v += ((g.target - b.grow) * 140 - g.v * 13) * dt;
        b.grow = Math.max(0, b.grow + g.v * dt);
        if (Math.abs(g.target - b.grow) < 0.002 && Math.abs(g.v) < 0.01) {
          b.grow = g.target;
          this.growing.delete(id);
          if (g.target === 0) this.hide(id, false);
        }
      }
    }

    /* ---------- birth ---------- */
    birth(a, b) {
      const id = CHILDREN[this.born.length];
      if (!id) return;
      this.born.push(id);
      this.lastBirth = this.t;
      const ui = this.ui, child = this.body(id), A = this.body(a), B = this.body(b);
      const L = ui.layout, home = L.bodies[id].home;
      const cx = (A.px.x + B.px.x) / 2, cy = (A.px.y + B.px.y) / 2;
      child.off[L.name] = [cx / ui.kx - home[0], cy / ui.ky - home[1]];
      child.vel = [0, 0];
      child.mode = 'rest';
      child.grow = 0.01;
      child.unborn = false;
      child.touched = false;
      child.el.classList.remove('is-unborn');
      child.el.style.zIndex = ++this.pg.zTop;
      this.pg.world.setEnabled(id, true);
      this.growing.set(id, { target: 1, v: 0 });
      // the child is born where its parents met, then finds its own place on the poster
      setTimeout(() => {
        child.anchor = [0, 0];
        child.springK = 55; child.springC = 10;
        child.mode = 'spring';
      }, 1100);
      const st = this.pg.state;
      if (id === 'capsule') st.doubler.on = true;
      else st.voices[id].on = true;
      if (this.audio.ready) this.audio.birth();
      const before = this.pg.voiceSnapshot();
      before[id] = false;
      this.pg.syncAudio();
      this.pg.markPending(before);
      this.ui.announce(`a new form is born: ${id}`);
      this.pg.refresh();
    }
    hide(id, instant) {
      const b = this.body(id);
      b.unborn = true;
      b.el.classList.add('is-unborn');
      if (instant) b.grow = 0;
      b.off[this.ui.layout.name] = [0, 0];
      b.vel = [0, 0];
      b.mode = 'rest';
      this.pg.world.setEnabled(id, false);
    }

    /* ---------- finale: the children leave, the two return ---------- */
    finale() {
      if (this.scene === 'finale' || this.scene === 'end') return;
      this.finaleAt = 0;
      this.go('finale');
      const st = this.pg.state;
      const leaving = this.born.slice().reverse();
      leaving.forEach((id, i) => {
        setTimeout(() => {
          if (id === 'capsule') st.doubler.on = false;
          else st.voices[id].on = false;
          this.growing.set(id, { target: 0, v: 0 });
          this.pg.syncAudio();
          this.pg.refresh();
        }, 700 * i);
      });
      // the two go back to where the poster began
      for (const id of [HE, SHE]) {
        const b = this.body(id);
        if (b.mode === 'drag') continue;
        b.anchor = [0, 0]; b.springK = 40; b.springC = 9; b.mode = 'spring';
      }
      setTimeout(() => {
        st.voices[HE].on = false;
        st.voices[SHE].on = false;
        this.pg.syncAudio();
        this.audio.resolve();
        this.scene = 'end';
        this.body(HE).el.classList.add('is-final');
        this.body(SHE).el.classList.add('is-final');
        this.born = [];
        this.pg.refresh();
      }, 700 * leaving.length + 3200);
    }
  }

  GP.Story = Story;
  GP.STORY_ROLES = { HE, SHE };
})();
