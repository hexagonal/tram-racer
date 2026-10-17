'use strict';

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width;   // 320
  const H = canvas.height;  // 180

  // ---- Palette (PICO-8 style) ---------------------------------------------
  const C = {
    black: '#000000', navy: '#1d2b53', plum: '#7e2553', green: '#008751',
    brown: '#ab5236', dgrey: '#5f574f', lgrey: '#c2c3c7', white: '#fff1e8',
    red: '#ff004d', orange: '#ffa300', yellow: '#ffec27', lime: '#00e436',
    blue: '#29adff', lav: '#83769c', pink: '#ff77a8', peach: '#ffccaa',
  };

  // ---- Tuning -------------------------------------------------------------
  const PX = 3;                  // pixels per metre
  const TRACK_LEN = 1200;        // metres from the start to the finish line
  const TRAM_LEN = 16;           // metres
  const DOOR_OFFSET = 8;         // metres from the tram's nose to its door
  const RUN_START = -28;         // where the drivers start running from
  const RUN_MAX = 9;             // m/s
  const RUN_BOOST = 1.3;         // m/s per alternating key press
  const RUN_DECAY = 2.5;         // m/s^2
  const BOARD_TIME = 0.6;
  const ACCEL = 3.0;
  const BRAKE = 8;
  const DRAG = 0.5;
  const SLOW_LIMIT = 11.2;       // 40 km/h
  const SLOW_TOLERANCE = 1.4;
  const SLOW_LEN = 60;
  const STUN_CRASH = 2;
  const STUN_DERAIL = 3;
  const CROSS_HALF = 2.5;        // half the width of a road crossing, metres
  const CAR_SPEED = 42;          // px/s as a car drives across the tracks
  const CAR_TOP = 58;
  const CAR_BOTTOM = 172;
  const SIGNAL_WARN = 2.2;       // seconds of warning before a car reaches a track

  // Screen layout
  const HUD_H = 11;
  const SKY_BOTTOM = 70;
  const BACK_WALK = 82;          // feet of the CPU driver
  const RAIL_Y = [114, 150];     // back track (CPU), front track (player)
  const FRONT_WALK = 162;        // feet of the player
  const BAR_Y = 169;

  const kmh = (v) => Math.round(v * 3.6);

  // ---- 3x5 pixel font -----------------------------------------------------
  const FONT = {
    A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110',
    E: '111100110100111', F: '111100110100100', G: '011100101101011', H: '101101111101101',
    I: '111010010010111', J: '001001001101010', K: '101101110101101', L: '100100100100111',
    M: '101111111101101', N: '110101101101101', O: '010101101101010', P: '110101110100100',
    Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
    U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101',
    Y: '101101010010010', Z: '111001010100111',
    0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001011001111',
    4: '101101111001001', 5: '111100111001111', 6: '011100111101111', 7: '111001010010010',
    8: '111101111101111', 9: '111101111001110',
    ':': '000010000010000', '.': '000000000000010', '!': '010010010000010', '/': '001001010100100',
    '-': '000000111000000', "'": '010010000000000', '?': '110001010000010', '<': '001010100010001',
    '>': '100010001010100', '+': '000010111010000', ',': '000000000010100',
  };

  function textWidth(str, scale = 1) {
    return str.length * 4 * scale - scale;
  }

  function text(str, x, y, color, opts = {}) {
    const scale = opts.scale || 1;
    str = String(str).toUpperCase();
    let x0 = Math.round(x);
    if (opts.align === 'center') x0 -= Math.floor(textWidth(str, scale) / 2);
    else if (opts.align === 'right') x0 -= textWidth(str, scale);
    if (opts.shadow) text(str, x0 + scale, y + scale, opts.shadow, { scale });
    ctx.fillStyle = color;
    for (let i = 0; i < str.length; i++) {
      const g = FONT[str[i]];
      if (!g) continue;
      for (let b = 0; b < 15; b++) {
        if (g[b] === '1') ctx.fillRect(x0 + i * 4 * scale + (b % 3) * scale, Math.round(y) + Math.floor(b / 3) * scale, scale, scale);
      }
    }
  }

  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  // ---- Random -------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Chiptune sound -----------------------------------------------------
  let actx = null;
  function initAudio() {
    if (!actx) {
      try {
        actx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        actx = null;
      }
    }
    if (actx && actx.state === 'suspended') actx.resume();
  }

  function tone(freq, dur, type, vol, when = 0, slide = 0) {
    if (!actx) return;
    const t0 = actx.currentTime + when;
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function noise(dur, vol) {
    if (!actx) return;
    const len = Math.floor(actx.sampleRate * dur);
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const data = buf.getChannelData(0);
    let v = 0;
    for (let i = 0; i < len; i++) {
      if (i % 40 === 0) v = Math.random() * 2 - 1;   // crunchy, low-rate noise
      data[i] = v * (1 - i / len);
    }
    const src = actx.createBufferSource();
    const g = actx.createGain();
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(g).connect(actx.destination);
    src.start();
  }

  const sfx = {
    beep(high) { tone(high ? 880 : 440, 0.18, 'square', 0.07); },
    step() { tone(180 + Math.random() * 40, 0.04, 'square', 0.04); },
    board() { tone(523, 0.08, 'square', 0.06); tone(784, 0.12, 'square', 0.06, 0.08); },
    ding() { tone(1318, 0.35, 'triangle', 0.12); tone(1318, 0.35, 'triangle', 0.12, 0.15); },
    crash() { noise(0.5, 0.3); tone(200, 0.4, 'square', 0.08, 0, 50); },
    derail() { noise(0.9, 0.22); tone(600, 0.8, 'sawtooth', 0.05, 0, 80); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'square', 0.07, i * 0.12)); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.25, 'square', 0.07, i * 0.18)); },
  };

  // ---- Course -------------------------------------------------------------
  const CAR_COLORS = [C.red, C.white, C.lime, C.pink, C.orange, C.lav];

  function makeCourse(seed) {
    const rnd = mulberry32(seed);
    const slowZones = [];
    const crossings = [];
    let x = 170;
    let lastType = null;
    while (x < TRACK_LEN - 110) {
      let type = rnd() < 0.5 ? 'slow' : 'cross';
      if (type === lastType && rnd() < 0.6) type = type === 'slow' ? 'cross' : 'slow';
      if (type === 'slow') {
        slowZones.push({ start: x, end: x + SLOW_LEN, limit: SLOW_LIMIT });
        x += SLOW_LEN;
      } else {
        crossings.push({
          x,
          period: 6 + rnd() * 3,
          phase: rnd() * 9,
          color: CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)],
          hitCycle: -1,
        });
      }
      lastType = type;
      x += 130 + rnd() * 110;
    }

    const skyline = [];
    let bx = -80;
    while (bx < TRACK_LEN * 0.5 + 200) {
      const w = 8 + Math.floor(rnd() * 14);
      skyline.push({ x: bx, w, h: 16 + Math.floor(rnd() * 34), color: [C.navy, C.lav, C.dgrey, C.plum][Math.floor(rnd() * 4)], seed: Math.floor(rnd() * 1000) });
      bx += w + 1 + Math.floor(rnd() * 3);
    }

    return { slowZones, crossings, skyline };
  }

  // Where the car at a crossing is (top-left y in pixels) at a time, or null.
  function carCycle(c, time) {
    const travel = (CAR_BOTTOM - CAR_TOP) / CAR_SPEED;
    const tt = time + c.phase;
    const cycle = Math.floor(tt / c.period);
    const s = tt - cycle * c.period;
    if (s > travel || cycle === c.hitCycle) return { y: null, cycle };
    return { y: CAR_TOP + s * CAR_SPEED, cycle };
  }

  const CAR_H = 7;
  function carOnTrack(y, track) {
    return y !== null && Math.abs(y + CAR_H - RAIL_Y[track]) < 6;
  }

  function signalRed(c, track, time) {
    for (let s = 0; s <= SIGNAL_WARN; s += 0.1) {
      if (carOnTrack(carCycle(c, time + s).y, track)) return true;
    }
    return false;
  }

  // ---- State --------------------------------------------------------------
  let course;
  let racers;
  let player;
  let cpu;
  let particles;
  let state = 'title';        // title | countdown | race | results
  let countdown = 0;
  let raceTime = 0;
  let resultsDelay = 0;
  let camX = RUN_START - 10;
  let message = null;
  let winner = null;
  const keys = {};

  function makeRacer(opts) {
    return {
      x: TRAM_LEN,            // the tram's nose
      v: 0,
      stun: 0,
      stunKind: null,
      throttle: false,
      brake: false,
      runX: RUN_START,
      runV: 0,
      runAnim: 0,
      phase: 'wait',          // wait | run | board | drive
      boardT: 0,
      lastKey: null,
      trip: 0,
      finished: false,
      finishTime: 0,
      hits: new Set(),
      choices: new Map(),
      ...opts,
    };
  }

  function newRace() {
    course = makeCourse((Math.random() * 1e9) | 0);
    player = makeRacer({ isPlayer: true, name: 'YOU', track: 1, color: C.orange, trim: C.yellow, shirt: C.red, maxSpeed: 25 });
    cpu = makeRacer({ isPlayer: false, name: 'CPU', track: 0, color: C.blue, trim: C.white, shirt: C.green, maxSpeed: 24.2, runTarget: 6.6 + Math.random() * 0.8 });
    racers = [cpu, player];
    particles = [];
    raceTime = 0;
    resultsDelay = 0;
    camX = RUN_START - 10;
    message = null;
    winner = null;
  }

  function startCountdown() {
    initAudio();
    newRace();
    state = 'countdown';
    countdown = 2.999;
    sfx.beep(false);
  }

  function choose(r, key, p) {
    if (!r.choices.has(key)) r.choices.set(key, Math.random() < p);
    return r.choices.get(key);
  }

  function burst(x, y, colors, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 20 + Math.random() * 70;
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 20, life: 0.3 + Math.random() * 0.6, color: colors[i % colors.length] });
    }
  }

  function stun(r, kind) {
    r.stun = kind === 'crash' ? STUN_CRASH : STUN_DERAIL;
    r.stunKind = kind;
    r.v = 0;
    if (kind === 'crash') sfx.crash();
    else sfx.derail();
    if (r.isPlayer) {
      message = kind === 'crash'
        ? { text: 'CRASH!', sub: 'WAIT FOR THE GREEN LIGHT', t: 2 }
        : { text: 'DERAILED!', sub: 'MAX 40 KM/H IN SLOW ZONES', t: 2.4 };
    }
  }

  // ---- CPU ----------------------------------------------------------------
  function cpuDrive(r) {
    r.throttle = false;
    r.brake = false;
    if (r.stun > 0) return;
    if (r.finished) { r.brake = true; return; }

    const plan = BRAKE * 0.7;
    let target = r.maxSpeed;

    for (const z of course.slowZones) {
      if (z.end < r.x - TRAM_LEN) continue;
      const reckless = choose(r, z, 0.15);
      const lim = z.limit - 0.8 + (reckless ? 3.5 : 0);
      const d = z.start - r.x;
      target = Math.min(target, d <= 0 ? lim : Math.sqrt(lim * lim + 2 * plan * d));
    }

    for (const c of course.crossings) {
      const d = c.x - CROSS_HALF - r.x;
      if (d < -0.5 || d > 70) continue;
      if (choose(r, c, 0.12)) continue;   // sometimes the CPU just goes for it
      if (signalRed(c, r.track, raceTime)) target = Math.min(target, Math.sqrt(Math.max(0, 2 * plan * (d - 1))));
      break;
    }

    if (r.v < target - 0.3) r.throttle = true;
    else if (r.v > target + 0.4) r.brake = true;
  }

  // ---- Update -------------------------------------------------------------
  function updateRunner(r, dt) {
    const door = r.x - DOOR_OFFSET;
    if (r.phase === 'run') {
      if (r.isPlayer) {
        r.runV = Math.max(0, r.runV - RUN_DECAY * dt);
      } else if (r.trip > 0) {
        r.trip -= dt;
        r.runV = 0;
      } else {
        r.runV = Math.min(r.runTarget, r.runV + 5 * dt);
        if (Math.random() < dt * 0.25) r.trip = 0.7;   // the CPU is a bit clumsy
      }
      const before = Math.floor(r.runAnim / 1.5);
      r.runX += r.runV * dt;
      r.runAnim += r.runV * dt;
      if (r.isPlayer && Math.floor(r.runAnim / 1.5) !== before) sfx.step();
      if (r.runX >= door) {
        r.runX = door;
        r.phase = 'board';
        r.boardT = BOARD_TIME;
        if (r.isPlayer) sfx.board();
      }
    } else if (r.phase === 'board') {
      r.boardT -= dt;
      if (r.boardT <= 0) {
        r.phase = 'drive';
        if (r.isPlayer) message = { text: 'DRIVE!', sub: 'RIGHT: POWER   LEFT: BRAKE', t: 1.6 };
      }
    }
  }

  function updateTram(r, dt) {
    if (r.phase !== 'drive') return;
    if (r.stun > 0) {
      r.stun -= dt;
      r.v = 0;
      if (Math.random() < dt * 25) burst(r.x * PX, RAIL_Y[r.track] - 4, [C.yellow, C.orange, C.white], 1);
      return;
    }

    if (r.brake) r.v -= BRAKE * dt;
    else if (r.throttle) r.v += ACCEL * Math.max(0.15, 1 - r.v / r.maxSpeed) * dt;
    else r.v -= DRAG * dt;
    r.v = Math.max(0, Math.min(r.maxSpeed, r.v));
    r.x += r.v * dt;

    for (const c of course.crossings) {
      if (r.x < c.x - CROSS_HALF || r.x - TRAM_LEN > c.x + CROSS_HALF) continue;
      const car = carCycle(c, raceTime);
      if (carOnTrack(car.y, r.track)) {
        c.hitCycle = car.cycle;
        burst(c.x * PX, RAIL_Y[r.track] - 6, [c.color, C.white, C.yellow], 24);
        stun(r, 'crash');
        return;
      }
    }

    for (const z of course.slowZones) {
      if (r.hits.has(z)) continue;
      if (r.x >= z.start && r.x - TRAM_LEN <= z.end && r.v > z.limit + SLOW_TOLERANCE) {
        r.hits.add(z);
        burst(r.x * PX, RAIL_Y[r.track] - 2, [C.yellow, C.orange, C.white], 30);
        stun(r, 'derail');
        return;
      }
    }
  }

  function update(dt) {
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
    if (message) {
      message.t -= dt;
      if (message.t <= 0) message = null;
    }

    if (state === 'countdown') {
      const before = Math.ceil(countdown);
      countdown -= dt;
      const after = Math.ceil(countdown);
      if (after !== before) {
        if (after > 0) {
          sfx.beep(false);
        } else {
          sfx.beep(true);
          state = 'race';
          player.phase = 'run';
          cpu.phase = 'run';
          message = { text: 'RUN!', sub: 'TAP LEFT, RIGHT, LEFT, RIGHT...', t: 1.6 };
        }
      }
      return;
    }
    if (state !== 'race' && state !== 'results') return;

    raceTime += dt;

    if (player.phase === 'drive' && !player.finished) {
      player.throttle = !!(keys.ArrowRight || keys.KeyD);
      player.brake = !!(keys.ArrowLeft || keys.KeyA);
    } else {
      player.throttle = false;
      player.brake = player.finished;
    }
    if (cpu.phase === 'drive') cpuDrive(cpu);

    for (const r of racers) {
      updateRunner(r, dt);
      updateTram(r, dt);
      if (!r.finished && r.x >= TRACK_LEN) {
        r.finished = true;
        r.finishTime = raceTime;
        if (!winner) {
          winner = r;
          if (r.isPlayer) sfx.win();
          else sfx.lose();
        }
        if (r.isPlayer) resultsDelay = 1.5;
      }
    }

    const camTarget = player.phase === 'drive' ? player.x - 36 : RUN_START - 10;
    camX += (Math.max(RUN_START - 10, camTarget) - camX) * Math.min(1, dt * 4);

    if (state === 'race' && player.finished) {
      resultsDelay -= dt;
      if (resultsDelay <= 0) state = 'results';
    }
  }

  function fmtTime(s) {
    const m = Math.floor(s / 60);
    const rest = (s - m * 60).toFixed(1).padStart(4, '0');
    return `${m}:${rest}`;
  }

  // ---- Drawing ------------------------------------------------------------
  const sx = (x) => Math.round((x - camX) * PX);

  function drawBackground() {
    // Sky bands, dithered 8-bit style
    rect(0, HUD_H, W, SKY_BOTTOM - HUD_H, C.blue);
    rect(0, 40, W, SKY_BOTTOM - 40, C.lgrey);
    ctx.fillStyle = C.lgrey;
    for (let y = 32; y < 40; y += 2) {
      for (let x = (y / 2) % 2; x < W; x += 2) ctx.fillRect(x, y, 1, 1);
    }

    // Skyline with lit windows (parallax)
    const pcam = camX * 0.5;
    for (const b of course.skyline) {
      const x = Math.round((b.x - pcam) * PX);
      const w = b.w * PX;
      if (x + w < 0 || x > W) continue;
      const top = SKY_BOTTOM - b.h;
      rect(x, top, w, b.h, b.color);
      for (let wy = top + 3; wy < SKY_BOTTOM - 4; wy += 5) {
        for (let wx = x + 2; wx < x + w - 3; wx += 4) {
          if ((wx * 7 + wy * 13 + b.seed) % 5 === 0) rect(wx, wy, 2, 2, C.yellow);
        }
      }
    }

    // Back pavement, street, front pavement
    rect(0, SKY_BOTTOM, W, BACK_WALK + 2 - SKY_BOTTOM, C.lgrey);
    rect(0, SKY_BOTTOM, W, 1, C.white);
    rect(0, BACK_WALK + 2, W, FRONT_WALK - 6 - BACK_WALK - 2, C.dgrey);
    rect(0, FRONT_WALK - 6, W, BAR_Y - FRONT_WALK + 6, C.lgrey);
    rect(0, FRONT_WALK - 6, W, 1, C.white);
    // Paving lines
    ctx.fillStyle = C.lav;
    const off = Math.round(camX * PX) % 12;
    for (let x = -off; x < W; x += 12) {
      ctx.fillRect(x, SKY_BOTTOM + 1, 1, BACK_WALK + 1 - SKY_BOTTOM);
      ctx.fillRect(x, FRONT_WALK - 5, 1, BAR_Y - FRONT_WALK + 5);
    }
  }

  function drawTrack(track) {
    const y = RAIL_Y[track];
    const viewL = camX - 2;
    const viewR = camX + W / PX + 2;

    // Ballast and sleepers
    rect(0, y + 1, W, 3, C.brown);
    ctx.fillStyle = C.black;
    for (let m = Math.ceil(viewL / 2) * 2; m < viewR; m += 2) ctx.fillRect(sx(m), y + 1, 2, 2);
    rect(0, y, W, 1, C.lgrey);

    // Overhead wire and poles
    const wireY = y - 32;
    rect(0, wireY, W, 1, C.black);
    for (let m = Math.ceil(viewL / 25) * 25; m < viewR; m += 25) {
      rect(sx(m), wireY - 4, 1, y - wireY + 4, C.dgrey);
      rect(sx(m) - 1, wireY - 4, 6, 1, C.dgrey);
    }
  }

  function drawZones() {
    const viewL = camX - 30;
    const viewR = camX + W / PX + 30;
    for (const z of course.slowZones) {
      if (z.end < viewL || z.start - 40 > viewR) continue;
      // Yellow-black hazard strips along both tracks
      for (const y of RAIL_Y) {
        for (let m = z.start; m < z.end; m += 2) rect(sx(m), y + 4, PX * 2, 2, Math.floor(m / 2) % 2 ? C.yellow : C.black);
      }
      drawSign(sx(z.start - 40), BACK_WALK, '40');
      drawSign(sx(z.start), BACK_WALK, '40');
      drawSign(sx(z.end), BACK_WALK, 'END');
    }
    for (const c of course.crossings) {
      if (c.x + 4 < viewL || c.x - 4 > viewR) continue;
      const x0 = sx(c.x - CROSS_HALF);
      const w = Math.round(CROSS_HALF * 2 * PX);
      rect(x0, SKY_BOTTOM, w, FRONT_WALK + 8 - SKY_BOTTOM, C.dgrey);
      // Zebra marks
      for (let y = SKY_BOTTOM + 2; y < FRONT_WALK + 6; y += 6) rect(x0 + 2, y, w - 4, 2, C.white);
      for (const y of RAIL_Y) rect(x0, y, w, 1, C.lgrey);
    }
  }

  function drawSignals() {
    const viewL = camX - 10;
    const viewR = camX + W / PX + 10;
    for (const c of course.crossings) {
      if (c.x < viewL || c.x > viewR) continue;
      for (let track = 0; track < 2; track++) {
        const red = signalRed(c, track, raceTime);
        const x = sx(c.x - CROSS_HALF) - 5;
        const base = track === 0 ? BACK_WALK : FRONT_WALK;
        rect(x + 1, base - 14, 1, 14, C.black);
        rect(x - 1, base - 20, 5, 8, C.black);
        rect(x, base - 19, 3, 3, red ? C.red : C.plum);
        rect(x, base - 15, 3, 2, red ? C.navy : C.lime);
      }
    }
  }

  function drawCars() {
    for (const c of course.crossings) {
      const { y } = carCycle(c, raceTime);
      if (y === null) continue;
      const x = sx(c.x) - 5;
      if (x < -12 || x > W) continue;
      // Front view of a car driving across the street
      rect(x, y, 10, CAR_H, c.color);
      rect(x + 1, y - 3, 8, 3, c.color);
      rect(x + 2, y - 2, 6, 2, C.navy);
      rect(x + 1, y + 2, 2, 2, C.yellow);
      rect(x + 7, y + 2, 2, 2, C.yellow);
      rect(x, y + CAR_H, 2, 1, C.black);
      rect(x + 8, y + CAR_H, 2, 1, C.black);
    }
  }

  function drawSign(x, base, label) {
    if (x < -12 || x > W + 12) return;
    rect(x, base - 12, 1, 12, C.dgrey);
    const w = label.length * 4 + 3;
    rect(x - Math.floor(w / 2), base - 20, w, 9, C.red);
    rect(x - Math.floor(w / 2) + 1, base - 19, w - 2, 7, C.white);
    text(label, x, base - 18, C.black, { align: 'center' });
  }

  function drawTram(r) {
    const len = TRAM_LEN * PX;
    const rail = RAIL_Y[r.track];
    let x = sx(r.x - TRAM_LEN);
    if (x > W || x + len < 0) return;
    let jiggle = 0;
    if (r.stun > 0) jiggle = r.stunKind === 'derail' ? Math.round(Math.sin(raceTime * 50) * 1.5) : (Math.random() < 0.5 ? 1 : 0);
    const top = rail - 25 + jiggle;

    // Pantograph up to the wire
    const px = x + Math.floor(len / 2);
    rect(px - 3, rail - 32, 7, 1, C.dgrey);
    rect(px, rail - 31, 1, 6 + jiggle, C.black);
    rect(px - 2, rail - 29, 1, 2, C.black);
    rect(px + 2, rail - 29, 1, 2, C.black);

    // Body
    rect(x + 1, top, len - 2, 1, C.lgrey);
    rect(x, top + 1, len, 20, r.color);
    rect(x, top + 15, len, 2, r.trim);
    // Nose
    rect(x + len - 2, top + 1, 2, 20, C.navy);
    rect(x + len - 1, top + 17, 1, 2, C.yellow);
    // Windows
    for (let wx = x + 3; wx < x + len - 6; wx += 6) rect(wx, top + 4, 4, 6, C.navy);
    rect(x + len - 5, top + 4, 3, 7, C.navy);
    // Door (where the driver jumps in)
    const dx = sx(r.x - DOOR_OFFSET) - 3;
    const open = r.phase === 'board' || (r.phase === 'run' && r.x - DOOR_OFFSET - r.runX < 5);
    rect(dx, top + 3, 7, 16, C.black);
    if (!open) {
      rect(dx + 1, top + 4, 2, 14, C.lgrey);
      rect(dx + 4, top + 4, 2, 14, C.lgrey);
      rect(dx + 1, top + 5, 2, 5, C.navy);
      rect(dx + 4, top + 5, 2, 5, C.navy);
    }
    // Number
    text(r.isPlayer ? '1' : '2', x + 4, top + 11, C.white);
    // Driver in the cab
    if (r.phase === 'drive') {
      rect(x + len - 8, top + 6, 3, 3, C.peach);
      rect(x + len - 8, top + 9, 3, 2, r.shirt);
    }
    // Bogies
    for (const bx of [x + 6, x + len - 14]) {
      rect(bx, rail - 4, 8, 3, C.black);
      rect(bx + 1, rail - 2, 2, 2, C.dgrey);
      rect(bx + 5, rail - 2, 2, 2, C.dgrey);
    }
    if (r.stun > 0 && Math.floor(raceTime * 8) % 2) text('!', x + len + 2, top - 6, C.yellow);
  }

  function drawRunner(r) {
    if (r.phase === 'drive') return;
    const base = r.track === 0 ? BACK_WALK : FRONT_WALK;
    let y = base;
    let x = sx(r.runX) - 2;
    if (r.phase === 'board') {
      const k = 1 - r.boardT / BOARD_TIME;
      y = Math.round(base + (RAIL_Y[r.track] - 2 - base) * k) - Math.round(Math.sin(k * Math.PI) * 6);
    }
    const frame = r.runV > 0.5 && r.phase === 'run' ? Math.floor(r.runAnim / 1.5) % 2 : 2;
    // Legs
    if (frame === 0) {
      rect(x, y - 3, 1, 3, C.navy);
      rect(x + 3, y - 3, 1, 2, C.navy);
      rect(x + 4, y - 1, 1, 1, C.navy);
    } else if (frame === 1) {
      rect(x + 1, y - 3, 1, 3, C.navy);
      rect(x + 3, y - 3, 1, 3, C.navy);
    } else {
      rect(x + 1, y - 3, 1, 3, C.navy);
      rect(x + 3, y - 3, 1, 3, C.navy);
    }
    // Body, arms, head, cap
    rect(x, y - 7, 5, 4, r.shirt);
    rect(frame === 0 ? x - 1 : x + 5, y - 6, 1, 2, C.peach);
    rect(x + 1, y - 10, 3, 3, C.peach);
    rect(x + 3, y - 9, 1, 1, C.black);
    rect(x, y - 11, 4, 1, C.navy);
    rect(x + 1, y - 12, 3, 1, C.navy);
    if (r.trip > 0) text('?', x + 1, y - 18, C.white);
  }

  function drawFinish() {
    const x = sx(TRACK_LEN);
    if (x < -8 || x > W + 8) return;
    for (let y = SKY_BOTTOM; y < FRONT_WALK + 6; y += 2) {
      for (let c = 0; c < 3; c++) rect(x + c * 2, y, 2, 2, ((y / 2) + c) % 2 ? C.black : C.white);
    }
    rect(x + 2, SKY_BOTTOM - 16, 1, 16, C.dgrey);
    text('FINISH', x + 3, SKY_BOTTOM - 22, C.white, { align: 'center', shadow: C.black });
  }

  function drawParticles() {
    for (const p of particles) rect(p.x - camX * PX, p.y, 1, 1, p.color);
  }

  function drawHUD() {
    rect(0, 0, W, HUD_H, C.black);
    const lead = player.x === cpu.x ? 0 : player.x > cpu.x ? 1 : 2;
    const pos = player.finished && winner === player ? '1ST' : player.finished ? '2ND'
      : cpu.finished ? '2ND' : lead === 2 ? '2ND' : '1ST';
    text(pos, 3, 3, pos === '1ST' ? C.yellow : C.lgrey);
    text(`${kmh(player.v)} KM/H`, 28, 3, C.white);
    text(fmtTime(player.finished ? player.finishTime : raceTime), 80, 3, C.white);
    text(`${Math.max(0, Math.round(TRACK_LEN - player.x))}M TO GO`, 122, 3, C.lgrey);

    // Upcoming danger
    let warn = null;
    for (const z of course.slowZones) {
      if (player.x <= z.end + TRAM_LEN && z.start - player.x < 70) {
        warn = { t: z.start > player.x ? 'SLOW ZONE' : 'MAX 40', bad: player.v > z.limit + SLOW_TOLERANCE };
        break;
      }
    }
    if (!warn) {
      for (const c of course.crossings) {
        const d = c.x - player.x;
        if (d > -CROSS_HALF && d < 60) {
          const red = signalRed(c, player.track, raceTime);
          warn = { t: red ? 'RED LIGHT' : 'CROSSING', bad: red };
          break;
        }
      }
    }
    if (warn && player.phase === 'drive' && !player.finished) {
      const blink = !warn.bad || Math.floor(raceTime * 6) % 2;
      if (blink) text(warn.t, W - 3, 3, warn.bad ? C.red : C.orange, { align: 'right' });
    }

    // Progress bar
    rect(0, BAR_Y, W, H - BAR_Y, C.black);
    const x0 = 8;
    const x1 = W - 16;
    rect(x0, BAR_Y + 5, x1 - x0, 1, C.dgrey);
    for (let i = 0; i < 4; i++) rect(x1 + 2 + (i % 2) * 2, BAR_Y + 3 + Math.floor(i / 2) * 2, 2, 2, i % 3 ? C.black : C.white);
    rect(x1 + 2, BAR_Y + 3, 4, 4, C.white);
    rect(x1 + 2, BAR_Y + 3, 2, 2, C.black);
    rect(x1 + 4, BAR_Y + 5, 2, 2, C.black);
    for (const r of [cpu, player]) {
      const k = Math.max(0, Math.min(1, r.x / TRACK_LEN));
      const mx = Math.round(x0 + (x1 - x0 - 4) * k);
      rect(mx, BAR_Y + (r.isPlayer ? 4 : 2), 4, 4, r.color);
    }
    text('YOU', 3, BAR_Y + 4, C.orange);
  }

  function drawBigText(str, sub, alpha = 1) {
    if (alpha < 0.5 && Math.floor(performance.now() / 80) % 2) return;
    text(str, W / 2, 72, C.white, { scale: 3, align: 'center', shadow: C.black });
    if (sub) {
      const w = textWidth(sub) + 6;
      rect(W / 2 - w / 2, 95, w, 9, C.black);
      text(sub, W / 2, 97, C.yellow, { align: 'center' });
    }
  }

  function drawPanel(title, lines, titleColor = C.yellow) {
    const ph = 40 + lines.length * 9;
    const pw = 220;
    const x = (W - pw) / 2;
    const y = Math.round((H - ph) / 2) - 4;
    rect(x - 2, y - 2, pw + 4, ph + 4, C.white);
    rect(x, y, pw, ph, C.navy);
    text(title, W / 2, y + 7, titleColor, { scale: 3, align: 'center', shadow: C.black });
    lines.forEach((l, i) => text(l.t, W / 2, y + 30 + i * 9, l.c || C.white, { align: 'center' }));
  }

  function render() {
    drawBackground();
    drawZones();
    drawSignals();
    drawRunner(cpu);
    drawTrack(0);
    drawTram(cpu);
    drawCars();
    drawTrack(1);
    drawTram(player);
    drawFinish();
    drawRunner(player);
    drawParticles();
    drawHUD();

    if (state === 'title') {
      drawPanel('TRAM RACER', [
        { t: 'BEAT THE CPU TO THE END OF THE LINE' },
        { t: 'RUN: TAP LEFT, RIGHT, LEFT, RIGHT' },
        { t: 'ON THE TRAM: RIGHT POWER, LEFT BRAKE' },
        { t: 'OVER 40 IN A SLOW ZONE: YOU DERAIL' },
        { t: 'STOP AT RED LIGHTS OR HIT A CAR' },
        { t: '' },
        { t: 'PRESS ENTER OR CLICK', c: Math.floor(performance.now() / 400) % 2 ? C.lime : C.green },
      ]);
      return;
    }
    if (state === 'countdown') {
      drawBigText(String(Math.ceil(countdown)), 'GET READY');
    } else if (message) {
      drawBigText(message.text, message.sub, Math.min(1, message.t * 2));
    }
    if (state === 'results') {
      const won = winner === player;
      drawPanel(won ? 'YOU WIN!' : 'CPU WINS', [
        { t: `YOU  ${fmtTime(player.finishTime)}`, c: C.orange },
        { t: `CPU  ${cpu.finished ? fmtTime(cpu.finishTime) : 'STILL GOING'}`, c: C.blue },
        { t: '' },
        { t: 'PRESS ENTER OR CLICK', c: Math.floor(performance.now() / 400) % 2 ? C.lime : C.green },
      ], won ? C.yellow : C.red);
    }
  }

  // ---- Input --------------------------------------------------------------
  const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'Enter']);

  function runPress(dir) {
    if (state !== 'race' || player.phase !== 'run') return;
    if (dir !== player.lastKey) player.runV = Math.min(RUN_MAX, player.runV + RUN_BOOST);
    player.lastKey = dir;
  }

  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys[e.code] = true;
    if ((e.code === 'Enter' || e.code === 'Space') && (state === 'title' || state === 'results')) {
      startCountdown();
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') runPress('L');
    if (e.code === 'ArrowRight' || e.code === 'KeyD') runPress('R');
  });

  window.addEventListener('keyup', (e) => {
    keys[e.code] = false;
  });

  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
  });

  canvas.addEventListener('click', () => {
    if (state === 'title' || state === 'results') startCountdown();
  });

  // ---- Main loop ----------------------------------------------------------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  newRace();
  requestAnimationFrame(frame);

  // Hooks for automated testing.
  window.tramRacer = {
    get state() { return state; },
    get player() { return player; },
    get cpu() { return cpu; },
    get course() { return course; },
    get raceTime() { return raceTime; },
    signalRed: (c, track) => signalRed(c, track, raceTime),
    start: startCountdown,
    step(seconds, dt = 1 / 60) {
      for (let s = 0; s < seconds; s += dt) update(dt);
    },
  };
})();
