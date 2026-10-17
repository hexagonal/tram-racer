'use strict';

// Racing Trams: upbeat lofi synthesized live with the Web Audio API.
// Every race gets its own seed, key and tempo, so no two races sound the same.
// The game calls TramMusic.start(audioContext) when a race starts.
(() => {
  // A minor, rootless voicings around middle C as MIDI note numbers; the bass plays the roots below.
  const SECTIONS = {
    A: [
      { bass: 45, notes: [55, 59, 60, 64] }, // Am9
      { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
      { bass: 38, notes: [53, 57, 60, 64] }, // Dm9
      { bass: 40, notes: [56, 59, 62, 65] }, // E7b9
    ],
    B: [
      { bass: 36, notes: [52, 55, 59, 62] }, // Cmaj9
      { bass: 43, notes: [53, 57, 59, 64] }, // G13
      { bass: 41, notes: [57, 60, 64, 67] }, // Fmaj9
      { bass: 40, notes: [56, 59, 62, 67] }, // E7#9
    ],
  };
  const FORM = ['A', 'A', 'B', 'B']; // 16 bars, then round again

  // A driving kick: one, the "and" of two, three, and a push on the "and" of three.
  const KICK = [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0];
  const SNARE = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const HAT = [0.8, 0.35, 0.9, 0.4, 0.75, 0.35, 0.9, 0.45, 0.8, 0.35, 0.9, 0.4, 0.75, 0.35, 0.9, 0.5];

  // Keys stabs, bass lines and melody rhythms as [step, length or interval] in sixteenths.
  const KEYS = [
    [[0, 3], [3, 3], [8, 2], [10, 6]],
    [[0, 6], [6, 2], [10, 4], [14, 2]],
    [[0, 2], [3, 2], [6, 4], [12, 4]],
    [[0, 10], [11, 5]],
  ];
  const BASSLINES = [
    [[0, 0], [2, 0], [4, 12], [6, 0], [8, 0], [10, 0], [12, 12], [14, 7]],
    [[0, 0], [3, 0], [6, 12], [8, 0], [10, 7], [12, 0], [14, 12]],
    [[0, 0], [2, 0], [4, 0], [6, 12], [8, 0], [11, 0], [14, 7]],
  ];
  const PHRASES = [
    [[0, 2], [2, 2], [4, 4], [10, 2], [12, 4]],
    [[2, 1], [3, 1], [4, 2], [6, 4], [12, 2], [14, 2]],
    [[0, 3], [3, 3], [6, 2], [8, 8]],
    [[4, 2], [6, 2], [8, 2], [10, 6]],
    [[0, 1], [1, 1], [2, 2], [4, 2], [8, 4], [12, 4]],
    [],
  ];
  const CADENCES = [[[0, 12]], [[0, 2], [2, 2], [4, 12]], [[2, 2], [4, 4], [8, 8]], []];

  const SWING = 0.1;
  const BELL_GAP = 60;  // seconds; the tram bell never rings more often than this
  const LEVEL = 0.42;   // music sits under the game's sound effects

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let ac = null, out = null, buffers = null, current = null, muted = false, lastBell = -Infinity;

  // Built once per audio context and shared by every race's music.
  function setup(ctx) {
    ac = ctx;
    out = ac.createGain();
    out.gain.value = muted || document.hidden ? 0 : 1;
    out.connect(ac.destination);
    const white = (seconds) => {
      const len = Math.floor(ac.sampleRate * seconds), buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    };
    const len = Math.floor(ac.sampleRate * 2.4), room = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = room.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8);
    }
    const n = 2048, curve = new Float32Array(n), norm = Math.tanh(1.7);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(1.7 * ((i / (n - 1)) * 2 - 1)) / norm;
    buffers = { noise: white(3), rumble: white(2), room, curve };
  }

  // One race's music: its own seed, key, tempo, signal chain and scheduler.
  function session() {
    const seed = (Math.random() * 4294967296) >>> 0;
    const shift = [-3, -2, 0, 2, 3][seed % 5];          // key
    const bpm = 100 + ((seed >>> 8) % 13);              // 100 to 112
    const six = 60 / bpm / 4;
    const chordAt = (bar) => { const b = ((bar % 16) + 16) % 16; return SECTIONS[FORM[b >> 2]][b & 3]; };

    // Repeatable randomness keyed by bar and this race's seed, so a bar's choices hold together across voices.
    function rnd(a, b = 0) {
      let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(((b | 0) + 0x9e3779b9) ^ seed, 0x165667b1)) >>> 0;
      h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    }

    // ---- small node helpers ----
    const osc = (type, freq) => { const o = ac.createOscillator(); o.type = type; o.frequency.value = freq; return o; };
    const amp = (v = 0) => { const g = ac.createGain(); g.gain.value = v; return g; };
    const biquad = (type, freq, q = 0.7) => { const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; return f; };
    const lfo = (freq, depth, target) => { const o = osc('sine', freq), d = amp(depth); o.connect(d); d.connect(target); o.start(); sources.push(o); return d; };
    const send = (from, to, level) => { const s = amp(level); from.connect(s); s.connect(to); };
    const noise = (t, dur) => { const s = ac.createBufferSource(); s.buffer = buffers.noise; s.start(t, Math.random() * 1.5, dur); return s; };
    const sources = [];

    // ---- signal chain ----
    const master = amp(0);
    master.connect(out);
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20; comp.knee.value = 10; comp.ratio.value = 3.5; comp.attack.value = 0.005; comp.release.value = 0.15;
    comp.connect(master);
    const rumbleCut = biquad('highpass', 32); rumbleCut.connect(comp);
    const warm = biquad('lowpass', 5200, 0.8); warm.connect(rumbleCut);
    lfo(0.08, 500, warm.frequency);
    const tape = ac.createWaveShaper(); tape.curve = buffers.curve; tape.oversample = '2x'; tape.connect(warm);
    const mix = amp(0.6); mix.connect(tape);

    // wow and flutter, in cents
    const wobble = amp(1);
    lfo(0.5, 6, wobble);
    lfo(5.5, 1.5, wobble);

    const duckBus = amp(1); duckBus.connect(mix);
    const keys = amp(0.9), drift = ac.createStereoPanner();
    keys.connect(drift); drift.connect(duckBus);
    lfo(0.13, 0.3, drift.pan);
    const bass = amp(1); bass.connect(duckBus);
    const lead = amp(1); lead.connect(duckBus);
    const drums = amp(0.85), drumTone = biquad('lowpass', 10000, 0.5);
    drums.connect(drumTone); drumTone.connect(mix);
    const rails = amp(0.55); rails.connect(mix);
    const bellBus = amp(0.75); bellBus.connect(mix);

    // a small room and a tape echo on a dotted eighth
    const verb = amp(1), verbThin = biquad('highpass', 300), verbTone = biquad('lowpass', 4600), conv = ac.createConvolver(), verbOut = amp(0.45);
    conv.buffer = buffers.room;
    verb.connect(verbThin); verbThin.connect(verbTone); verbTone.connect(conv); conv.connect(verbOut); verbOut.connect(mix);
    const echoIn = amp(1), echo = ac.createDelay(2);
    echo.delayTime.value = six * 3;
    const echoTone = biquad('lowpass', 2600), echoThin = biquad('highpass', 280), echoBack = amp(0.32), echoOut = amp(0.45);
    echoIn.connect(echo); echo.connect(echoTone); echoTone.connect(echoThin);
    echoThin.connect(echoBack); echoBack.connect(echo);
    echoThin.connect(echoOut); echoOut.connect(mix);
    send(drift, verb, 0.22); send(drift, echoIn, 0.05);
    send(lead, verb, 0.35); send(lead, echoIn, 0.38);
    send(drums, verb, 0.05);
    send(bellBus, verb, 0.5); send(bellBus, echoIn, 0.2);

    // the motor's low rumble
    const rumbleSrc = ac.createBufferSource(), rumble = biquad('lowpass', 130, 0.9), rumbleLevel = amp(0.35);
    rumbleSrc.buffer = buffers.rumble; rumbleSrc.loop = true; rumbleSrc.start();
    sources.push(rumbleSrc);
    rumbleSrc.connect(rumble); rumble.connect(rumbleLevel); rumbleLevel.connect(rails);
    lfo(0.35, 0.12, rumbleLevel.gain);

    // Every pitched voice rides the same tape wobble, then lets go of it when it stops.
    function onTape(oscs, t, stopAt) {
      for (const o of oscs) { wobble.connect(o.detune); o.start(t); o.stop(stopAt); }
      oscs[0].onended = () => { for (const o of oscs) { try { wobble.disconnect(o.detune); } catch (e) { /* already gone */ } } };
    }

    // ---- voices ----
    // Electric piano: a 1:1 FM pair whose brightness fades fast, plus a short tine ping.
    function epNote(t, midi, dur, vel) {
      const f = mtof(midi), end = t + dur;
      const track = clamp(1 - (midi - 58) / 36, 0.45, 1);
      const car = osc('sine', f), mod = osc('sine', f), tine = osc('sine', f * 4.01);
      const index = amp(0), ping = amp(0), env = amp(0);
      index.gain.setValueAtTime(f * (0.9 + vel * 1.5) * track, t);
      index.gain.setTargetAtTime(f * 0.16, t, 0.18);
      mod.connect(index); index.connect(car.frequency);
      ping.gain.setValueAtTime(0.05 * vel * track, t);
      ping.gain.setTargetAtTime(0, t, 0.03);
      const peak = 0.14 * vel;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.004);
      env.gain.setTargetAtTime(peak * 0.3, t + 0.004, 0.5);
      env.gain.setTargetAtTime(0, end, 0.08);
      car.connect(env); tine.connect(ping); ping.connect(env);
      const pan = ac.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.22;
      env.connect(pan); pan.connect(keys);
      onTape([car, mod, tine], t, end + 0.8);
    }

    function playChord(chord, t, dur, vel, light) {
      const notes = light ? chord.notes.slice(1) : chord.notes;
      notes.forEach((m, i) => {
        const v = clamp(vel + (Math.random() - 0.5) * 0.12 + (i === notes.length - 1 ? 0.05 : 0), 0.2, 1);
        epNote(t + i * 0.008 + Math.random() * 0.004, m + shift, Math.max(0.1, dur - i * 0.008), v);
      });
    }

    // Lead: an octave-FM tone with a little bite and vibrato that arrives late.
    function leadNote(t, midi, dur, vel) {
      const f = mtof(midi), end = t + dur;
      const car = osc('sine', f), mod = osc('sine', f * 2), vib = osc('sine', 5.6);
      const index = amp(0), depth = amp(0), env = amp(0);
      index.gain.setValueAtTime(f * 1.1, t);
      index.gain.setTargetAtTime(f * 0.18, t, 0.12);
      mod.connect(index); index.connect(car.frequency);
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(12, t + 0.35);
      vib.connect(depth); depth.connect(car.detune); depth.connect(mod.detune);
      const peak = 0.1 * vel;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.015);
      env.gain.setTargetAtTime(peak * 0.6, t + 0.015, 0.3);
      env.gain.setTargetAtTime(0, end, 0.08);
      car.connect(env); env.connect(lead);
      vib.start(t); vib.stop(end + 0.8);
      onTape([car, mod], t, end + 0.8);
    }

    function bassNote(t, midi, dur, vel) {
      const f = mtof(midi + shift), end = t + dur;
      const sub = osc('sine', f), body = osc('triangle', f);
      const bodyLevel = amp(0.55), tone = biquad('lowpass', 520, 0.9), env = amp(0);
      const peak = 0.28 * vel;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(peak, t + 0.008);
      env.gain.setTargetAtTime(peak * 0.7, t + 0.008, 0.2);
      env.gain.setTargetAtTime(0, end, 0.03);
      sub.connect(env); body.connect(bodyLevel); bodyLevel.connect(tone); tone.connect(env); env.connect(bass);
      onTape([sub, body], t, end + 0.3);
    }

    function kick(t, vel) {
      const o = osc('sine', 140), env = amp(0);
      o.frequency.setValueAtTime(140, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.85 * vel, t + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
      o.connect(env); env.connect(drums);
      o.start(t); o.stop(t + 0.36);
      const click = noise(t, 0.02), clickTone = biquad('lowpass', 2000), clickEnv = amp(0);
      clickEnv.gain.setValueAtTime(0.12 * vel, t);
      clickEnv.gain.setTargetAtTime(0, t, 0.004);
      click.connect(clickTone); clickTone.connect(clickEnv); clickEnv.connect(drums);
      // keys and bass pump under each kick, which is most of the forward lean
      duckBus.gain.setTargetAtTime(0.55, t, 0.006);
      duckBus.gain.setTargetAtTime(1, t + 0.04, 0.09);
    }

    function snare(t, vel) {
      const n = noise(t, 0.22), band = biquad('bandpass', 1900, 0.7), cut = biquad('highpass', 700), env = amp(0);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.36 * vel, t + 0.003);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      n.connect(band); band.connect(cut); cut.connect(env); env.connect(drums);
      const o = osc('triangle', 210), body = amp(0);
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(160, t + 0.05);
      body.gain.setValueAtTime(0.0001, t);
      body.gain.exponentialRampToValueAtTime(0.2 * vel, t + 0.002);
      body.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      o.connect(body); body.connect(drums);
      o.start(t); o.stop(t + 0.12);
    }

    function hat(t, vel, open) {
      const len = open ? 0.22 : 0.04;
      const n = noise(t, len + 0.02), cut = biquad('highpass', 7400, 0.6), env = amp(0);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.11 * vel, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + len);
      n.connect(cut); cut.connect(env); env.connect(drums);
    }

    // Wheels over a rail joint: a dull clack with a thump under it.
    function clack(t, vel) {
      const n = noise(t, 0.06), band = biquad('bandpass', 1300, 2.2), env = amp(0);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.2 * vel, t + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      n.connect(band); band.connect(env); env.connect(rails);
      const o = osc('sine', 85), thump = amp(0);
      o.frequency.setValueAtTime(85, t);
      o.frequency.exponentialRampToValueAtTime(55, t + 0.06);
      thump.gain.setValueAtTime(0.0001, t);
      thump.gain.exponentialRampToValueAtTime(0.22 * vel, t + 0.003);
      thump.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(thump); thump.connect(rails);
      o.start(t); o.stop(t + 0.1);
    }

    // A tram passing the other way at the top of each round: filtered noise swept up and across.
    function passBy(t, dur) {
      const n = noise(t, dur), band = biquad('bandpass', 300, 1.4), pan = ac.createStereoPanner(), env = amp(0);
      band.frequency.setValueAtTime(300, t);
      band.frequency.exponentialRampToValueAtTime(4200, t + dur);
      pan.pan.setValueAtTime(-0.9, t);
      pan.pan.linearRampToValueAtTime(0.9, t + dur);
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.3, t + dur * 0.8);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      n.connect(band); band.connect(pan); pan.connect(env); env.connect(rails);
    }

    // The foot gong: a struck bell with inharmonic partials.
    function gong(t, vel) {
      const f = 1046.5, pan = ac.createStereoPanner();
      pan.pan.value = 0.3;
      pan.connect(bellBus);
      for (const [ratio, level, decay] of [[1, 1, 1.4], [2.02, 0.32, 0.8], [2.76, 0.5, 0.6], [4.07, 0.22, 0.35], [5.43, 0.15, 0.22]]) {
        const o = osc('sine', f * ratio), e = amp(0);
        e.gain.setValueAtTime(0.0001, t);
        e.gain.exponentialRampToValueAtTime(0.11 * level * vel, t + 0.002);
        e.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(e); e.connect(pan);
        o.start(t); o.stop(t + decay + 0.05);
      }
      const n = noise(t, 0.03), cut = biquad('highpass', 3200), e = amp(0);
      e.gain.setValueAtTime(0.09 * vel, t);
      e.gain.setTargetAtTime(0, t, 0.006);
      n.connect(cut); cut.connect(e); e.connect(pan);
    }

    // ---- arrangement ----
    const melodies = new Map();
    let leadPitch = 76;
    function poolFor(chord) {
      const set = new Set();
      for (const n of [chord.bass, ...chord.notes]) for (let m = n % 12; m <= 86; m += 12) if (m >= 69) set.add(m);
      return [...set].sort((a, b) => a - b);
    }
    const nearest = (pool, m) => pool.reduce((best, p, i) => (Math.abs(p - m) < Math.abs(pool[best] - m) ? i : best), 0);

    function melodyFor(bar) {
      let notes = melodies.get(bar);
      if (notes) return notes;
      const pool = poolFor(chordAt(bar));
      const book = (bar & 3) === 3 ? CADENCES : PHRASES;
      const phrase = book[Math.floor(rnd(bar, 100) * book.length)];
      notes = phrase.map(([st, dur], i) => {
        let move = [-2, -1, -1, 0, 1, 1, 2][Math.floor(rnd(bar, 101 + i) * 7)];
        if ((leadPitch > 81 && move > 0) || (leadPitch < 72 && move < 0)) move = -move;
        leadPitch = pool[clamp(nearest(pool, leadPitch) + move, 0, pool.length - 1)];
        return { st, dur, midi: leadPitch + shift, vel: 0.6 + rnd(bar, 120 + i) * 0.3 };
      });
      melodies.set(bar, notes);
      melodies.delete(bar - 8);
      return notes;
    }

    const onsetAt = (pattern, st) => pattern.find((p) => p[0] === st);

    function scheduleStep(s, t) {
      const bar = Math.floor(s / 16), st = s % 16;
      const tt = t + (st % 2 ? SWING * six : 0);
      const chord = chordAt(bar), next = chordAt(bar + 1);
      const inCycle = bar % 16, section = inCycle >> 2, cycle = Math.floor(bar / 16);

      // keys from the first bar
      const stab = onsetAt(KEYS[Math.floor(rnd(bar, 1) * KEYS.length)], st);
      if (stab) playChord(chord, tt, stab[1] * six * 0.9, st === 0 ? 0.72 : 0.55, st !== 0);

      // eighth-note bass from bar three, with a chromatic walk-in now and then
      if (bar >= 2) {
        const line = BASSLINES[Math.floor(rnd(bar, 30) * BASSLINES.length)], note = onsetAt(line, st);
        if (note) {
          const i = line.indexOf(note), gap = (i + 1 < line.length ? line[i + 1][0] : 16) - st;
          bassNote(tt, chord.bass + note[1], gap * six * 0.8, st === 0 ? 0.95 : 0.75);
        }
        if (st === 15 && next.bass !== chord.bass && rnd(bar, 31) < 0.4) {
          bassNote(tt, next.bass + (next.bass > chord.bass ? -1 : 1), 0.8 * six, 0.6);
        }
      }

      // kick and snare from bar five; every third time round, the first B section drops them
      const breakdown = cycle % 3 === 2 && section === 2;
      if (bar >= 4 && !breakdown) {
        const extraKick = (st === 14 && rnd(bar, 40) < 0.35) || (st === 3 && rnd(bar, 41) < 0.15);
        if (KICK[st] || extraKick) kick(tt, st === 0 ? 1 : 0.82);
        if (SNARE[st]) snare(tt, 0.9);
        else if (inCycle === 15 && st >= 12) snare(tt, 0.2 + (st - 12) * 0.12); // fill into the top
        else if ((st === 7 || st === 15) && rnd(bar * 16 + st, 43) < 0.3) snare(tt, 0.16); // ghost note
      }

      // straight sixteenth hats from bar three, with an open hat on some offbeats
      if (bar >= 2) {
        const k = bar * 16 + st, open = st % 4 === 2 && rnd(k, 50) < 0.18;
        hat(tt, HAT[st] * (0.85 + rnd(k, 52) * 0.3) * (bar < 4 ? 0.7 : 1), open);
      }

      // rail joints under it all, and a tram passing the other way into each new round
      if (st === 0 || st === 8) clack(tt, 0.8);
      if (st === 1 || st === 9) clack(tt, 0.55);
      if (inCycle === 15 && st === 8) passBy(tt, 8 * six);

      // melody on the repeat of each section
      if (bar >= 4 && (section === 1 || section === 3)) {
        for (const n of melodyFor(bar)) if (n.st === st) leadNote(tt, n.midi, n.dur * six * 0.9, n.vel);
      }

      // ding ding, never within a minute of the last bell (the game's boarding bell counts too)
      if (st === 12 && (bar & 3) === 3 && t - lastBell >= BELL_GAP && rnd(bar, 61) < 0.35) {
        lastBell = t;
        gong(t, 1);
        gong(t + 0.2, 0.85);
      }
    }

    let step = 0, nextTime = ac.currentTime + 0.1;
    function schedule() {
      if (ac.state !== 'running') return;
      const ahead = document.hidden ? 1.2 : 0.15; // hidden tabs get coarse timers, so plan further ahead
      if (nextTime < ac.currentTime - 0.25) nextTime = ac.currentTime + 0.05; // after a stall, rejoin instead of bursting
      while (nextTime < ac.currentTime + ahead) {
        scheduleStep(step, nextTime);
        nextTime += six;
        step++;
      }
    }
    master.gain.setTargetAtTime(LEVEL, ac.currentTime, 0.3);
    schedule();
    const timer = setInterval(schedule, 25);

    return {
      stop() {
        clearInterval(timer);
        master.gain.cancelScheduledValues(ac.currentTime);
        master.gain.setTargetAtTime(0, ac.currentTime, 0.15);
        setTimeout(() => {
          for (const s of sources) { try { s.stop(); } catch (e) { /* already stopped */ } }
          master.disconnect();
        }, 1500);
      },
    };
  }

  function applyMute() {
    if (out) out.gain.setTargetAtTime(muted || document.hidden ? 0 : 1, ac.currentTime, 0.08);
  }
  document.addEventListener('visibilitychange', applyMute);

  window.TramMusic = {
    // Start fresh music for a new race, fading out the last race's.
    start(ctx) {
      if (!ctx) return;
      if (ctx !== ac) setup(ctx);
      if (current) current.stop();
      current = session();
    },
    // The game rang its own bell; keep the music's bell a minute clear of it.
    bellRang() {
      if (ac) lastBell = ac.currentTime;
    },
    toggleMute() {
      muted = !muted;
      applyMute();
      return muted;
    },
    get muted() { return muted; },
  };
})();
