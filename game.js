'use strict';

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = 960;
  const H = 540;
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * DPR;
  canvas.height = H * DPR;

  // ---- Tuning -------------------------------------------------------------
  const PX = 14;                 // pixels per metre
  const TRACK_LEN = 1400;        // metres from the start line to the finish
  const START_X = 24;            // where both trams' noses start
  const RUN_DIST = 34;           // metres each driver runs to reach their door
  const RUN_SPEED = 7;           // m/s while holding power
  const RUN_ACCEL = 9;
  const BOARD_TIME = 0.7;
  const BRAKE = 9;
  const DRAG = 0.6;
  const SLOW_LIMIT = 11.2;       // 40 km/h
  const SLOW_TOLERANCE = 1.4;
  const SLOW_LEN = 60;
  const STUN_CRASH = 2;
  const STUN_DERAIL = 3;
  const CROSS_HALF = 3;          // half the width of a road crossing, metres
  const SIGNAL_WARN = 2.4;       // seconds of red light before a car reaches a track

  // Screen layout (pixels)
  const BACK_PATH_TOP = 286;
  const BACK_FEET = 306;
  const STREET_TOP = 314;
  const RAIL_Y = [382, 480];     // back track (CPU), front track (player)
  const FRONT_PATH_TOP = 490;
  const FRONT_FEET = 532;
  const WIRE_DROP = 92;          // overhead wire height above the rail
  const CAR_TOP = 296;
  const CAR_BOTTOM = 560;
  const CAR_SPEED = 105;         // px/s as a car drives across the street

  const TRAMS = {
    W: { name: 'W class', len: 15, accel: 4.2, max: 24, door: 7.5 },
    G: { name: 'G class', len: 24, accel: 3.4, max: 25, door: 12 },
  };

  const kmh = (v) => Math.round(v * 3.6);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';

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
  const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

  // ---- Sound --------------------------------------------------------------
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
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = actx.createBufferSource();
    const g = actx.createGain();
    g.gain.value = vol;
    src.buffer = buf;
    src.connect(g).connect(actx.destination);
    src.start();
  }

  const sfx = {
    beep(high) { tone(high ? 880 : 440, 0.2, 'triangle', 0.12); },
    step() { tone(140 + Math.random() * 40, 0.05, 'triangle', 0.05); },
    board() { tone(660, 0.1, 'triangle', 0.08); tone(990, 0.14, 'triangle', 0.08, 0.09); },
    ding() { for (const w of [0, 0.22]) { tone(1318, 0.6, 'sine', 0.12, w); tone(2637, 0.3, 'sine', 0.04, w); } },
    crash() { noise(0.6, 0.35); tone(160, 0.5, 'sawtooth', 0.08, 0, 50); },
    derail() { noise(1, 0.25); tone(900, 0.9, 'sawtooth', 0.04, 0, 120); },
    cheer() { tone(1046, 0.08, 'square', 0.03); tone(1318, 0.1, 'square', 0.03, 0.08); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.1, i * 0.13)); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, i * 0.2)); },
  };

  // ---- Course -------------------------------------------------------------
  const CAR_COLORS = ['#c0392b', '#ecf0f1', '#2c3e50', '#2980b9', '#f1c40f', '#7f8c8d', '#16a085'];
  const SHOP_COLORS = ['#e8d9b5', '#c97b53', '#9bb39b', '#d9a441', '#a8443a', '#e6c9a8', '#7d9cb5', '#b5654a'];
  const SHOP_NAMES = ['CAFE', 'BOOKS', 'PIES', 'DUMPLINGS', 'MILK BAR', 'GELATO', 'RECORDS', 'BAKERY', 'PHO', 'FISH & CHIPS', 'FLORIST', 'TATTS'];

  function makeCourse(seed) {
    const rnd = mulberry32(seed);
    const slowZones = [];
    const crossings = [];
    let x = 190;
    let last = null;
    while (x < TRACK_LEN - 120) {
      let type = rnd() < 0.5 ? 'slow' : 'cross';
      if (type === last && rnd() < 0.6) type = type === 'slow' ? 'cross' : 'slow';
      if (type === 'slow') {
        slowZones.push({ start: x, end: x + SLOW_LEN, limit: SLOW_LIMIT });
        x += SLOW_LEN;
      } else {
        crossings.push({ x, period: 6 + rnd() * 3, phase: rnd() * 9, color: pick(CAR_COLORS, rnd), hitCycle: -1 });
      }
      last = type;
      x += 140 + rnd() * 110;
    }

    // Cheerleaders turn up now and then along the footpaths.
    const cheer = [];
    for (let cx = 120 + rnd() * 80; cx < TRACK_LEN - 60; cx += 160 + rnd() * 180) {
      cheer.push({ x: cx, side: rnd() < 0.5 ? 0 : 1, look: pick(CHEER_LOOKS, rnd), t: rnd() * 10, said: false });
    }
    // ...and a squad at the finish.
    cheer.push({ x: TRACK_LEN + 6, side: 1, look: CHEER_LOOKS[0], t: 0, said: false });
    cheer.push({ x: TRACK_LEN + 10, side: 1, look: CHEER_LOOKS[1], t: 1, said: false });

    // Far skyline (parallax 0.12): towers, with Melbourne landmarks mixed in.
    const far = [];
    for (let fx = -20; fx < 260;) {
      const w = 5 + rnd() * 8;
      far.push({ type: 'tower', x: fx, w, h: 60 + rnd() * 120, tone: rnd(), crown: rnd() < 0.3 });
      fx += w + 0.5 + rnd() * 3;
    }
    far.push({ type: 'eureka', x: 30, w: 7, h: 250 });
    far.push({ type: 'spire', x: 70, w: 8, h: 230 });
    far.push({ type: 'rialto', x: 118, w: 12, h: 190 });
    far.push({ type: 'eureka', x: 175, w: 7, h: 250 });
    far.push({ type: 'spire', x: 222, w: 8, h: 230 });

    // Street frontage (parallax 0.45): Victorian shops and plane trees.
    const mid = [{ type: 'station', x: -14, w: 34 }];
    for (let mx = 22; mx < TRACK_LEN * 0.45 + 90;) {
      const w = 7 + Math.floor(rnd() * 5);
      mid.push({ type: 'shop', x: mx, w, h: 7 + rnd() * 3, color: pick(SHOP_COLORS, rnd), name: pick(SHOP_NAMES, rnd), lace: rnd() < 0.7, tall: rnd() < 0.35 });
      mx += w;
    }
    const trees = [];
    for (let tx = 26; tx < TRACK_LEN * 0.45 + 90; tx += 9 + rnd() * 8) trees.push({ x: tx, s: 0.8 + rnd() * 0.4 });

    const stops = [];
    for (let sx = 260; sx < TRACK_LEN - 100; sx += 330 + rnd() * 120) stops.push({ x: sx, n: 10 + Math.floor(rnd() * 120) });

    return { slowZones, crossings, cheer, far, mid, trees, stops };
  }

  // Where the car at a crossing is (y of its wheels, in pixels) at a time, or null.
  function carCycle(c, time) {
    const travel = (CAR_BOTTOM - CAR_TOP) / CAR_SPEED;
    const tt = time + c.phase;
    const cycle = Math.floor(tt / c.period);
    const s = tt - cycle * c.period;
    if (s > travel || cycle === c.hitCycle) return { y: null, cycle };
    return { y: CAR_TOP + s * CAR_SPEED, cycle };
  }

  const carOnTrack = (y, track) => y !== null && Math.abs(y - RAIL_Y[track]) < 16;

  function signalRed(c, track, time) {
    for (let s = 0; s <= SIGNAL_WARN; s += 0.1) if (carOnTrack(carCycle(c, time + s).y, track)) return true;
    return false;
  }

  // ---- Characters ---------------------------------------------------------
  const PLAYER_LOOK = { skin: '#ffe0c7', hair: '#2d6cdf', hairDark: '#1d4aa0', style: 'spiky', eye: '#1d4aa0', outfit: '#23395b', trim: '#f4c430', cap: '#1b2a44', legs: '#1b2a44' };
  const CPU_LOOK = { skin: '#f7d2b6', hair: '#e2e6ee', hairDark: '#a9b0bf', style: 'pony', eye: '#2e9e5b', outfit: '#3f4a52', trim: '#78be20', cap: null, legs: '#2b3036' };
  const CHEER_LOOKS = [
    { skin: '#ffe3cf', hair: '#ff6fa8', hairDark: '#d94a86', style: 'twin', eye: '#b0306a', outfit: '#ffffff', trim: '#1f4fa3', skirt: '#1f4fa3', legs: '#ffe3cf', pom: '#f4c430' },
    { skin: '#f3c9a5', hair: '#f6c544', hairDark: '#c99a22', style: 'twin', eye: '#6b3fa0', outfit: '#ffffff', trim: '#c0392b', skirt: '#c0392b', legs: '#f3c9a5', pom: '#ffffff' },
    { skin: '#d9a07a', hair: '#3a2a2a', hairDark: '#1e1414', style: 'pony', eye: '#5a3a1a', outfit: '#ffffff', trim: '#16a085', skirt: '#16a085', legs: '#d9a07a', pom: '#f39c12' },
  ];

  function limb(x1, y1, len, ang, width, color) {
    const x2 = x1 + Math.sin(ang) * len;
    const y2 = y1 + Math.cos(ang) * len;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    return [x2, y2];
  }

  // Anime-style character, facing right, feet at (x, y).
  function drawChar(x, y, look, a = {}) {
    const s = a.scale || 1;
    const phase = a.phase || 0;
    const moving = !!a.moving;
    ctx.save();
    ctx.translate(x, y - (a.jump || 0));
    ctx.scale(s, s);

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 1 + (a.jump || 0) / s, 11, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    const swing = moving ? Math.sin(phase) * 0.9 : 0;
    const hipY = -22;
    // Legs
    const legC = look.legs;
    const k1 = limb(-2, hipY, 11, swing, 5, legC);
    limb(k1[0], k1[1], 11, swing - (moving ? Math.max(0, Math.sin(phase)) * 0.9 : 0), 5, legC);
    const k2 = limb(2, hipY, 11, -swing, 5, legC);
    limb(k2[0], k2[1], 11, -swing - (moving ? Math.max(0, -Math.sin(phase)) * 0.9 : 0), 5, legC);
    // Shoes
    ctx.fillStyle = look.style === 'twin' ? '#ffffff' : '#222';

    // Back arm
    const armSwing = a.armsUp ? Math.PI - 0.4 + Math.sin(phase * 2) * 0.25 : (moving ? -Math.sin(phase) * 1.1 : 0.15);
    const backHand = limb(-2, -36, 13, -armSwing, 4, look.skin);
    if (look.pom) {
      ctx.fillStyle = look.pom;
      ctx.beginPath();
      ctx.arc(backHand[0], backHand[1], 5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body
    ctx.fillStyle = look.outfit;
    roundRect(-7, -40, 14, 19, 5);
    ctx.fill();
    ctx.fillStyle = look.trim;
    ctx.fillRect(-7, -27, 14, 2);
    if (look.skirt) {
      ctx.fillStyle = look.skirt;
      ctx.beginPath();
      ctx.moveTo(-7, -24);
      ctx.lineTo(7, -24);
      ctx.lineTo(10 + Math.sin(phase * 2) * 1.5, -15);
      ctx.lineTo(-10 + Math.sin(phase * 2) * 1.5, -15);
      ctx.closePath();
      ctx.fill();
    }

    // Long hair behind the head
    ctx.fillStyle = look.hairDark;
    if (look.style === 'pony') {
      const flow = moving ? Math.sin(phase * 2) * 3 : 0;
      ctx.beginPath();
      ctx.moveTo(-8, -58);
      ctx.quadraticCurveTo(-22, -52 + flow, -18, -36 + flow);
      ctx.quadraticCurveTo(-12, -46, -6, -50);
      ctx.fill();
    } else if (look.style === 'twin') {
      for (const side of [-1, 1]) {
        const bob = Math.sin(phase * 2 + side) * 3;
        ctx.beginPath();
        ctx.ellipse(side * 13 - 2, -48 + bob, 5, 11, side * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Head
    ctx.fillStyle = look.skin;
    ctx.beginPath();
    ctx.arc(1, -52, 12.5, 0, Math.PI * 2);
    ctx.fill();

    // Front hair
    ctx.fillStyle = look.hair;
    ctx.beginPath();
    if (look.style === 'spiky') {
      ctx.moveTo(-13, -50);
      const spikes = [[-16, -62], [-9, -61], [-8, -72], [-1, -64], [4, -74], [8, -64], [16, -68], [13, -56], [17, -52], [10, -55], [6, -50], [3, -56], [-2, -50], [-6, -55]];
      for (const [px, py] of spikes) ctx.lineTo(px, py);
      ctx.closePath();
    } else {
      ctx.moveTo(-12, -48);
      ctx.quadraticCurveTo(-12, -68, 2, -66);
      ctx.quadraticCurveTo(16, -66, 14, -50);
      ctx.lineTo(10, -56);
      ctx.lineTo(7, -50);
      ctx.lineTo(4, -57);
      ctx.lineTo(0, -51);
      ctx.lineTo(-4, -57);
      ctx.lineTo(-8, -50);
      ctx.closePath();
    }
    ctx.fill();
    if (look.style === 'twin') {
      ctx.fillStyle = look.pom || '#fff';
      ctx.beginPath();
      ctx.arc(-9, -60, 2.5, 0, Math.PI * 2);
      ctx.arc(11, -60, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Driver's cap
    if (look.cap) {
      ctx.fillStyle = look.cap;
      ctx.beginPath();
      ctx.ellipse(1, -63, 12, 5, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillRect(-11, -64, 24, 4);
      ctx.fillRect(6, -61, 11, 2.5);
      ctx.fillStyle = look.trim;
      ctx.fillRect(-1, -66, 4, 3);
    }

    // Big anime eyes (three-quarter view, looking right)
    for (const [ex, ew] of [[7, 3.4], [-1, 3]]) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(ex, -50, ew + 0.6, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = look.eye;
      ctx.beginPath();
      ctx.ellipse(ex + 0.6, -49.5, ew, 4.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.beginPath();
      ctx.ellipse(ex + 0.8, -49, ew * 0.5, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex + 1.6, -51.5, 1.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#2a1a1a';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ex - ew - 0.5, -55);
      ctx.lineTo(ex + ew + 0.8, -55.6);
      ctx.stroke();
    }
    // Blush and mouth
    ctx.fillStyle = 'rgba(255,120,140,0.45)';
    ctx.beginPath();
    ctx.ellipse(9, -44, 2.6, 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#7a3030';
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    if (a.shout) ctx.ellipse(6, -42, 2, 2, 0, 0, Math.PI * 2);
    else ctx.arc(6, -43, 2, 0.2, Math.PI - 0.2);
    ctx.stroke();

    // Front arm
    const frontHand = limb(3, -36, 13, armSwing, 4, look.skin);
    ctx.strokeStyle = look.outfit;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(3, -36);
    ctx.lineTo(3 + Math.sin(armSwing) * 5, -36 + Math.cos(armSwing) * 5);
    ctx.stroke();
    if (look.pom) {
      ctx.fillStyle = look.pom;
      ctx.beginPath();
      ctx.arc(frontHand[0], frontHand[1], 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- State --------------------------------------------------------------
  let course;
  let racers;
  let player;
  let cpu;
  let particles;
  let bubbles;
  let state = 'title';        // title | countdown | race | results
  let countdown = 0;
  let raceTime = 0;
  let resultsDelay = 0;
  let camX = -32;
  let message = null;
  let winner = null;
  let clock = 0;
  const keys = {};
  const touch = { power: false, brake: false };

  function makeRacer(opts) {
    const spec = TRAMS[opts.cls];
    return {
      ...spec,
      x: START_X,
      v: 0,
      stun: 0,
      stunKind: null,
      throttle: false,
      brake: false,
      runX: START_X - spec.door - RUN_DIST,
      runV: 0,
      runAnim: 0,
      phase: 'wait',            // wait | run | board | drive
      boardT: 0,
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
    player = makeRacer({ isPlayer: true, name: 'YOU', cls: 'W', track: 1, look: PLAYER_LOOK });
    cpu = makeRacer({ isPlayer: false, name: 'CPU', cls: 'G', track: 0, look: CPU_LOOK, runTarget: 6.2 + Math.random() * 0.9 });
    racers = [cpu, player];
    particles = [];
    bubbles = [];
    raceTime = 0;
    resultsDelay = 0;
    camX = -32;
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

  const powerHeld = () => !!(keys.ArrowRight || keys.KeyD || keys.ArrowUp || keys.KeyW || touch.power);
  const brakeHeld = () => !!(keys.ArrowLeft || keys.KeyA || keys.ArrowDown || keys.KeyS || touch.brake);

  function choose(r, key, p) {
    if (!r.choices.has(key)) r.choices.set(key, Math.random() < p);
    return r.choices.get(key);
  }

  function burst(x, y, colors, n, speed = 160) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.3 + Math.random());
      particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 0.4 + Math.random() * 0.6, color: colors[i % colors.length] });
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
        ? { text: 'CRASH!', sub: 'Stop when your light is red', t: 2 }
        : { text: 'DERAILED!', sub: 'Keep under 40 km/h on the curves', t: 2.4 };
    }
  }

  // ---- CPU ----------------------------------------------------------------
  function cpuDrive(r) {
    r.throttle = false;
    r.brake = false;
    if (r.stun > 0) return;
    if (r.finished) { r.brake = true; return; }

    const plan = BRAKE * 0.7;
    let target = r.max;
    for (const z of course.slowZones) {
      if (z.end < r.x - r.len) continue;
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
    const door = r.x - r.door;
    if (r.phase === 'run') {
      let want;
      if (r.isPlayer) {
        want = powerHeld() ? RUN_SPEED : 0;
      } else if (r.trip > 0) {
        r.trip -= dt;
        want = 0;
        r.runV = 0;
      } else {
        want = r.runTarget;
        if (Math.random() < dt * 0.2) r.trip = 0.6;   // the CPU is a bit clumsy
      }
      r.runV += clamp(want - r.runV, -RUN_ACCEL * 1.5 * dt, RUN_ACCEL * dt);
      const before = Math.floor(r.runAnim / 1.6);
      r.runX += r.runV * dt;
      r.runAnim += r.runV * dt;
      if (r.isPlayer && Math.floor(r.runAnim / 1.6) !== before) sfx.step();
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
        if (r.isPlayer) {
          sfx.ding();
          message = { text: 'DING DING!', sub: 'Hold → for power, ← to brake', t: 1.8 };
        }
      }
    }
  }

  function updateTram(r, dt) {
    if (r.phase !== 'drive') return;
    if (r.stun > 0) {
      r.stun -= dt;
      r.v = 0;
      if (Math.random() < dt * 30) burst(r.x * PX, RAIL_Y[r.track] - 4, ['#ffe066', '#ffffff', '#ffa94d'], 2, 120);
      return;
    }

    if (r.brake) {
      r.v -= BRAKE * dt;
    } else if (r.throttle) {
      // Strong pull away from a stop, easing off near top speed.
      const k = r.v / r.max;
      r.v += r.accel * (k < 0.6 ? 1 : Math.max(0.15, (1 - k) / 0.4)) * dt;
    } else {
      r.v -= DRAG * dt;
    }
    r.v = clamp(r.v, 0, r.max);
    r.x += r.v * dt;

    for (const c of course.crossings) {
      if (r.x < c.x - CROSS_HALF || r.x - r.len > c.x + CROSS_HALF) continue;
      const car = carCycle(c, raceTime);
      if (carOnTrack(car.y, r.track)) {
        c.hitCycle = car.cycle;
        burst(c.x * PX, RAIL_Y[r.track] - 20, [c.color, '#ffffff', '#ffe066'], 40, 220);
        stun(r, 'crash');
        return;
      }
    }
    for (const z of course.slowZones) {
      if (r.hits.has(z)) continue;
      if (r.x >= z.start && r.x - r.len <= z.end && r.v > z.limit + SLOW_TOLERANCE) {
        r.hits.add(z);
        burst(r.x * PX, RAIL_Y[r.track] - 4, ['#ffe066', '#ffa94d', '#ffffff'], 50, 200);
        stun(r, 'derail');
        return;
      }
    }
  }

  function updateCheer(dt) {
    for (const c of course.cheer) {
      c.t += dt;
      const near = racers.some((r) => Math.abs(r.x - c.x) < 30);
      c.excited = near;
      if (!c.said && Math.abs(player.x - c.x) < 18 && player.phase === 'drive') {
        c.said = true;
        bubbles.push({ x: c.x, side: c.side, text: pick(['GO GO!', 'Faster!', 'Ganbatte!', 'You got this!', 'Ding ding!'], Math.random), t: 1.6 });
        sfx.cheer();
      }
    }
    for (const b of bubbles) b.t -= dt;
    bubbles = bubbles.filter((b) => b.t > 0);
  }

  function update(dt) {
    clock += dt;
    for (const p of particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
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
          message = { text: 'RUN!', sub: 'Hold → to run to your tram', t: 1.6 };
        }
      }
      return;
    }
    if (state !== 'race' && state !== 'results') return;

    raceTime += dt;
    if (player.phase === 'drive' && !player.finished) {
      player.throttle = powerHeld();
      player.brake = brakeHeld();
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
        if (r.isPlayer) resultsDelay = 1.6;
      }
    }
    updateCheer(dt);

    const target = player.phase === 'drive' ? player.x - 24 : -32;
    camX += (Math.max(-32, target) - camX) * Math.min(1, dt * 4);

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

  // ---- Drawing helpers ----------------------------------------------------
  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function fillRR(x, y, w, h, r, color) {
    ctx.fillStyle = color;
    roundRect(x, y, w, h, r);
    ctx.fill();
  }

  function label(str, x, y, size, color, align = 'center', weight = 'bold') {
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  function outlined(str, x, y, size, color, stroke = '#1a1a2e', align = 'center') {
    ctx.font = `900 ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(3, size / 7);
    ctx.strokeStyle = stroke;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  const sx = (x) => (x - camX) * PX;

  // ---- Scenery ------------------------------------------------------------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, BACK_PATH_TOP);
    g.addColorStop(0, '#5b9bd5');
    g.addColorStop(0.7, '#a9d1ee');
    g.addColorStop(1, '#e4eff5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, BACK_PATH_TOP);
    // A few soft clouds drifting slowly
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (let i = 0; i < 6; i++) {
      const cx = ((i * 230 - camX * 1.2 - clock * 6) % 1380 + 1380) % 1380 - 200;
      const cy = 40 + (i * 37) % 70;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 50, 14, 0, 0, Math.PI * 2);
      ctx.ellipse(cx + 30, cy - 8, 32, 14, 0, 0, Math.PI * 2);
      ctx.ellipse(cx - 28, cy - 4, 26, 11, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawFar() {
    const base = BACK_PATH_TOP - 40;
    const pc = camX * 0.12;
    for (const f of course.far) {
      const x = (f.x - pc) * PX;
      const w = f.w * PX;
      if (x + w < -40 || x > W + 40) continue;
      if (f.type === 'tower') {
        const shade = 150 + Math.floor(f.tone * 50);
        ctx.fillStyle = `rgb(${shade - 40}, ${shade - 10}, ${shade + 20})`;
        ctx.fillRect(x, base - f.h, w, f.h);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        for (let yy = base - f.h + 6; yy < base; yy += 8) ctx.fillRect(x + 3, yy, w - 6, 2);
        if (f.crown) {
          ctx.fillStyle = `rgb(${shade - 60}, ${shade - 30}, ${shade})`;
          ctx.fillRect(x + w * 0.3, base - f.h - 14, w * 0.4, 14);
        }
      } else if (f.type === 'eureka') {
        ctx.fillStyle = '#56657a';
        ctx.fillRect(x, base - f.h, w, f.h);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        for (let yy = base - f.h + 30; yy < base; yy += 6) ctx.fillRect(x + 2, yy, w - 4, 1.5);
        ctx.fillStyle = '#d4a93c';
        ctx.fillRect(x, base - f.h, w, 30);
        ctx.fillStyle = '#c0392b';
        ctx.fillRect(x + w * 0.2, base - f.h + 40, w * 0.15, 60);
      } else if (f.type === 'spire') {
        // Arts Centre spire: a white lattice cone with a mast
        const cx = x + w / 2;
        ctx.fillStyle = '#9aa8b8';
        ctx.fillRect(x - 10, base - 40, w + 20, 40);
        ctx.strokeStyle = '#f2f4f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, base - 40);
        ctx.lineTo(cx, base - f.h);
        ctx.lineTo(x + w, base - 40);
        for (let i = 1; i < 10; i++) {
          const yy = base - 40 - (f.h - 40) * (i / 10);
          const hw = (w / 2) * (1 - i / 10);
          ctx.moveTo(cx - hw, yy);
          ctx.lineTo(cx + hw, yy - 8);
        }
        ctx.moveTo(cx, base - f.h);
        ctx.lineTo(cx, base - f.h - 40);
        ctx.stroke();
      } else if (f.type === 'rialto') {
        ctx.fillStyle = '#3d6e9e';
        ctx.fillRect(x, base - f.h, w * 0.55, f.h);
        ctx.fillStyle = '#4f86bd';
        ctx.fillRect(x + w * 0.5, base - f.h + 25, w * 0.5, f.h - 25);
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillRect(x + 4, base - f.h, 4, f.h);
      }
    }
    // Haze between the city and the street
    const g = ctx.createLinearGradient(0, base - 60, 0, base);
    g.addColorStop(0, 'rgba(228,239,245,0)');
    g.addColorStop(1, 'rgba(228,239,245,0.7)');
    ctx.fillStyle = g;
    ctx.fillRect(0, base - 60, W, 60);
  }

  function drawStation(x, w) {
    const base = BACK_PATH_TOP;
    const top = base - 150;
    ctx.fillStyle = '#e0a84a';
    ctx.fillRect(x, top + 40, w, 110);
    ctx.fillStyle = '#c98a2e';
    for (let i = 0; i < 9; i++) ctx.fillRect(x + 20 + i * (w - 40) / 8, top + 40, 8, 110);
    // Arched entrance
    const cx = x + w * 0.35;
    ctx.fillStyle = '#e6b45c';
    ctx.fillRect(cx - 70, top - 10, 140, 160);
    ctx.fillStyle = '#4a3a2a';
    ctx.beginPath();
    ctx.moveTo(cx - 45, base);
    ctx.lineTo(cx - 45, top + 60);
    ctx.arc(cx, top + 60, 45, Math.PI, 0);
    ctx.lineTo(cx + 45, base);
    ctx.fill();
    // Clocks above the entrance
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(cx - 60, base - 46, 120, 16);
    for (let i = 0; i < 6; i++) {
      ctx.fillStyle = '#f7f2e0';
      ctx.beginPath();
      ctx.arc(cx - 50 + i * 20, base - 38, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Green copper dome
    ctx.fillStyle = '#5fa38a';
    ctx.beginPath();
    ctx.ellipse(cx, top - 10, 62, 50, 0, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#e6b45c';
    ctx.fillRect(cx - 6, top - 74, 12, 16);
    // Clock tower
    const tx = x + w * 0.88;
    ctx.fillStyle = '#e6b45c';
    ctx.fillRect(tx - 18, top - 40, 36, 190);
    ctx.fillStyle = '#5fa38a';
    ctx.beginPath();
    ctx.moveTo(tx - 22, top - 40);
    ctx.lineTo(tx, top - 80);
    ctx.lineTo(tx + 22, top - 40);
    ctx.fill();
    ctx.fillStyle = '#f7f2e0';
    ctx.beginPath();
    ctx.arc(tx, top - 14, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(tx, top - 14);
    ctx.lineTo(tx, top - 22);
    ctx.moveTo(tx, top - 14);
    ctx.lineTo(tx + 6, top - 14);
    ctx.stroke();
    label('FLINDERS STREET', x + w * 0.35, top + 32, 14, '#5a3a1a');
  }

  function drawShop(s, x, w) {
    const base = BACK_PATH_TOP;
    const h = s.h * PX * (s.tall ? 1.25 : 1);
    const top = base - h;
    ctx.fillStyle = s.color;
    ctx.fillRect(x, top, w, h);
    // Parapet with a little pediment
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(x, top, w, 8);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - 24, top);
    ctx.lineTo(x + w / 2, top - 14);
    ctx.lineTo(x + w / 2 + 24, top);
    ctx.fill();
    // Upstairs sash windows
    ctx.fillStyle = '#f6f1e4';
    const n = Math.max(2, Math.floor(w / 40));
    for (let i = 0; i < n; i++) {
      const wx = x + (i + 0.5) * (w / n) - 9;
      ctx.fillRect(wx - 2, top + 16, 22, 34);
      ctx.fillStyle = '#3b4a5a';
      ctx.fillRect(wx, top + 18, 18, 30);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(wx + 2, top + 20, 5, 26);
      ctx.fillStyle = '#f6f1e4';
      ctx.fillRect(wx, top + 32, 18, 2);
    }
    // Verandah over the footpath
    const vy = base - 46;
    ctx.fillStyle = '#4d5b52';
    ctx.fillRect(x - 2, vy - 8, w + 4, 8);
    if (s.lace) {
      ctx.strokeStyle = '#f2efe6';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let lx = x; lx < x + w; lx += 10) {
        ctx.moveTo(lx, vy);
        ctx.quadraticCurveTo(lx + 5, vy + 8, lx + 10, vy);
      }
      ctx.stroke();
    }
    ctx.fillStyle = '#4d5b52';
    ctx.fillRect(x + 2, vy, 3, 46);
    // Shopfront
    ctx.fillStyle = '#2d3b45';
    ctx.fillRect(x + 10, vy + 10, w - 20, 36);
    ctx.fillStyle = 'rgba(255,230,170,0.35)';
    ctx.fillRect(x + 12, vy + 12, w - 36, 32);
    ctx.fillStyle = '#5a3a2a';
    ctx.fillRect(x + w - 24, vy + 12, 12, 34);
    // Sign
    ctx.fillStyle = '#1f2a33';
    ctx.fillRect(x + 8, top + h - 82, w - 16, 16);
    label(s.name, x + w / 2, top + h - 70, 11, '#f4e3b5');
  }

  function drawMid() {
    const pc = camX * 0.45;
    for (const m of course.mid) {
      const x = (m.x - pc) * PX;
      const w = m.w * PX;
      if (x + w < -60 || x > W + 60) continue;
      if (m.type === 'station') drawStation(x, w);
      else drawShop(m, x, w);
    }
  }

  function drawTrees() {
    const pc = camX * 0.45;
    for (const t of course.trees) {
      const x = (t.x - pc) * PX;
      if (x < -80 || x > W + 80) continue;
      const base = BACK_PATH_TOP + 4;
      ctx.fillStyle = '#6b5a45';
      ctx.fillRect(x - 3, base - 60 * t.s, 6, 60 * t.s);
      const cols = ['#4f7d3a', '#5f9445', '#6fa851'];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = cols[i];
        ctx.beginPath();
        ctx.arc(x - 14 + i * 14, base - 70 * t.s - (i % 2) * 12, 22 * t.s, 0, Math.PI * 2);
        ctx.arc(x - 6 + i * 6, base - 90 * t.s, 18 * t.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawStreet() {
    // Back footpath
    ctx.fillStyle = '#c9c4b8';
    ctx.fillRect(0, BACK_PATH_TOP, W, STREET_TOP - BACK_PATH_TOP);
    ctx.fillStyle = '#9e978a';
    ctx.fillRect(0, STREET_TOP - 4, W, 4);
    // Road
    const g = ctx.createLinearGradient(0, STREET_TOP, 0, FRONT_PATH_TOP);
    g.addColorStop(0, '#5b5f66');
    g.addColorStop(1, '#474b52');
    ctx.fillStyle = g;
    ctx.fillRect(0, STREET_TOP, W, FRONT_PATH_TOP - STREET_TOP);
    // Yellow tram-lane lines
    ctx.fillStyle = '#e6c229';
    const off = ((camX * PX) % 60 + 60) % 60;
    for (let x = -off; x < W; x += 60) {
      ctx.fillRect(x, STREET_TOP + 16, 34, 3);
      ctx.fillRect(x, FRONT_PATH_TOP - 10, 34, 3);
    }
    ctx.fillRect(0, (RAIL_Y[0] + RAIL_Y[1]) / 2 - 22, W, 3);
    // Front footpath
    ctx.fillStyle = '#d3cec2';
    ctx.fillRect(0, FRONT_PATH_TOP, W, H - FRONT_PATH_TOP);
    ctx.fillStyle = '#a39c8f';
    ctx.fillRect(0, FRONT_PATH_TOP, W, 5);
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    for (let x = -(((camX * PX) % 42) + 42) % 42; x < W; x += 42) {
      ctx.fillRect(x, FRONT_PATH_TOP + 5, 1.5, H - FRONT_PATH_TOP);
      ctx.fillRect(x, BACK_PATH_TOP, 1.5, STREET_TOP - BACK_PATH_TOP - 4);
    }
  }

  function viewRange(pad = 10) {
    return [camX - pad, camX + W / PX + pad];
  }

  function drawTrack(track) {
    const y = RAIL_Y[track];
    // Concrete track slab and the rail
    ctx.fillStyle = '#7b7d80';
    ctx.fillRect(0, y - 2, W, 10);
    ctx.fillStyle = '#9fa3a8';
    ctx.fillRect(0, y - 2, W, 2);
    ctx.fillStyle = '#5c5f63';
    ctx.fillRect(0, y + 6, W, 2);
    ctx.fillStyle = '#c9ced4';
    ctx.fillRect(0, y - 1, W, 1.5);
  }

  function drawWires() {
    const [l, r] = viewRange(5);
    // Span poles on both footpaths with span wires across the street
    for (let m = Math.ceil(l / 30) * 30; m < r; m += 30) {
      const x = sx(m);
      ctx.strokeStyle = 'rgba(30,30,30,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, BACK_FEET - 128);
      ctx.lineTo(x + 6, RAIL_Y[1] - WIRE_DROP);
      ctx.stroke();
      ctx.fillStyle = '#3b4148';
      ctx.fillRect(x - 3, BACK_FEET - 132, 6, 132);
    }
    ctx.strokeStyle = '#1e2124';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const y of RAIL_Y) {
      ctx.moveTo(0, y - WIRE_DROP);
      ctx.lineTo(W, y - WIRE_DROP);
    }
    ctx.stroke();
  }

  function drawFrontPoles() {
    const [l, r] = viewRange(5);
    for (let m = Math.ceil(l / 30) * 30 + 15; m < r; m += 30) {
      const x = sx(m);
      ctx.fillStyle = '#3b4148';
      ctx.fillRect(x - 4, RAIL_Y[1] - WIRE_DROP - 30, 8, FRONT_FEET - RAIL_Y[1] + WIRE_DROP + 30);
      ctx.fillStyle = '#2a2f35';
      ctx.fillRect(x - 6, FRONT_FEET - 6, 12, 6);
    }
  }

  function drawStops() {
    for (const s of course.stops) {
      const x = sx(s.x);
      if (x < -80 || x > W + 80) continue;
      // Yellow-and-green Melbourne tram stop flag
      ctx.fillStyle = '#555';
      ctx.fillRect(x, BACK_FEET - 70, 3, 70);
      ctx.fillStyle = '#f2c500';
      ctx.fillRect(x - 14, BACK_FEET - 92, 30, 26);
      ctx.fillStyle = '#0d7f3f';
      ctx.fillRect(x - 14, BACK_FEET - 72, 30, 6);
      label(String(s.n), x + 1, BACK_FEET - 76, 11, '#1a1a1a');
      ctx.fillStyle = 'rgba(80,110,130,0.5)';
      ctx.fillRect(x + 20, BACK_FEET - 50, 60, 46);
      ctx.fillStyle = '#3d4a55';
      ctx.fillRect(x + 18, BACK_FEET - 54, 64, 5);
    }
  }

  function drawZones() {
    const [l, r] = viewRange(40);
    for (const z of course.slowZones) {
      if (z.end < l || z.start - 40 > r) continue;
      // Curve: yellow chevrons along both tracks
      for (const y of RAIL_Y) {
        for (let m = z.start; m < z.end; m += 3) {
          const x = sx(m);
          ctx.fillStyle = '#f2c500';
          ctx.beginPath();
          ctx.moveTo(x, y + 10);
          ctx.lineTo(x + 12, y + 14);
          ctx.lineTo(x, y + 18);
          ctx.lineTo(x + 6, y + 14);
          ctx.fill();
        }
      }
      drawLimitSign(sx(z.start - 40), BACK_FEET, '40');
      drawCurveSign(sx(z.start - 40) + 34, BACK_FEET);
      drawLimitSign(sx(z.start), BACK_FEET, '40');
      drawEndSign(sx(z.end), BACK_FEET);
    }
    for (const c of course.crossings) {
      if (c.x + 6 < l || c.x - 6 > r) continue;
      const x0 = sx(c.x - CROSS_HALF);
      const w = CROSS_HALF * 2 * PX;
      ctx.fillStyle = '#5d6168';
      ctx.fillRect(x0, BACK_PATH_TOP, w, H - BACK_PATH_TOP);
      ctx.fillStyle = '#eeeeee';
      for (const [y0, y1] of [[STREET_TOP + 2, STREET_TOP + 24], [FRONT_PATH_TOP - 24, FRONT_PATH_TOP - 2]]) {
        for (let yy = y0; yy < y1; yy += 6) ctx.fillRect(x0 + 4, yy, w - 8, 3);
      }
    }
  }

  function drawLimitSign(x, base, text) {
    if (x < -30 || x > W + 30) return;
    ctx.fillStyle = '#666';
    ctx.fillRect(x - 1.5, base - 60, 3, 60);
    ctx.beginPath();
    ctx.arc(x, base - 64, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#d0021b';
    ctx.stroke();
    label(text, x, base - 59, 14, '#111');
  }

  function drawCurveSign(x, base) {
    if (x < -30 || x > W + 30) return;
    ctx.fillStyle = '#666';
    ctx.fillRect(x - 1.5, base - 56, 3, 56);
    ctx.save();
    ctx.translate(x, base - 66);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#f2c500';
    ctx.fillRect(-11, -11, 22, 22);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-9, -9, 18, 18);
    ctx.restore();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 4, base - 58);
    ctx.quadraticCurveTo(x - 4, base - 70, x + 5, base - 72);
    ctx.stroke();
  }

  function drawEndSign(x, base) {
    if (x < -30 || x > W + 30) return;
    ctx.fillStyle = '#666';
    ctx.fillRect(x - 1.5, base - 60, 3, 60);
    ctx.beginPath();
    ctx.arc(x, base - 64, 15, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#333';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 10, base - 54);
    ctx.lineTo(x + 10, base - 74);
    ctx.stroke();
  }

  function drawSignals(track) {
    const [l, r] = viewRange(10);
    for (const c of course.crossings) {
      if (c.x < l || c.x > r) continue;
      const red = signalRed(c, track, raceTime);
      const x = sx(c.x - CROSS_HALF) - 14;
      const base = track === 0 ? BACK_FEET : FRONT_FEET;
      ctx.fillStyle = '#2b2f33';
      ctx.fillRect(x - 2, base - 70, 4, 70);
      fillRR(x - 9, base - 104, 18, 36, 4, '#1b1d20');
      ctx.fillStyle = red ? '#ff2d2d' : '#4a1515';
      ctx.beginPath();
      ctx.arc(x, base - 94, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = red ? '#123a1c' : '#2bd96b';
      ctx.beginPath();
      ctx.arc(x, base - 78, 6, 0, Math.PI * 2);
      ctx.fill();
      if (red) {
        ctx.fillStyle = 'rgba(255,45,45,0.25)';
        ctx.beginPath();
        ctx.arc(x, base - 94, 13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Cars drive across the street towards the viewer, so they are seen head-on.
  function drawCar(c, minY, maxY) {
    const { y } = carCycle(c, raceTime);
    if (y === null || y < minY || y >= maxY) return;
    const x = sx(c.x);
    if (x < -60 || x > W + 60) return;
    const s = 0.75 + 0.5 * (y - CAR_TOP) / (CAR_BOTTOM - CAR_TOP);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1b1b1b';
    ctx.fillRect(-26, -10, 9, 10);
    ctx.fillRect(17, -10, 9, 10);
    fillRR(-28, -30, 56, 22, 6, c.color);
    ctx.fillStyle = c.color;
    ctx.beginPath();
    ctx.moveTo(-20, -30);
    ctx.lineTo(-15, -46);
    ctx.lineTo(15, -46);
    ctx.lineTo(20, -30);
    ctx.fill();
    ctx.fillStyle = '#2a3a4a';
    ctx.beginPath();
    ctx.moveTo(-17, -31);
    ctx.lineTo(-13, -43);
    ctx.lineTo(13, -43);
    ctx.lineTo(17, -31);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(-10, -42, 5, 10);
    ctx.fillStyle = '#fff6cc';
    ctx.beginPath();
    ctx.arc(-19, -20, 4, 0, Math.PI * 2);
    ctx.arc(19, -20, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#333';
    ctx.fillRect(-10, -22, 20, 6);
    ctx.fillStyle = '#ddd';
    ctx.fillRect(-8, -13, 16, 4);
    ctx.restore();
  }

  // ---- Trams --------------------------------------------------------------
  function tramJiggle(r) {
    if (r.stun <= 0) return 0;
    return r.stunKind === 'derail' ? Math.sin(raceTime * 50) * 2.5 : (Math.random() - 0.5) * 3;
  }

  function drawDriver(r, x, y, scale) {
    if (r.phase !== 'drive') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - 14, y - 40, 28, 40);
    ctx.clip();
    drawChar(x, y + 28, r.look, { scale });
    ctx.restore();
  }

  // Melbourne W class: green and cream, trolley pole, drop-centre doors.
  function drawWClass(r) {
    const L = r.len * PX;
    const x = sx(r.x - r.len);
    if (x > W + 120 || x + L < -120) return;
    const rail = RAIL_Y[r.track];
    const j = tramJiggle(r);
    const bot = rail - 10 + j;
    const top = bot - 46;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + L / 2, rail + 3, L / 2, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Trolley pole trailing back up to the wire
    const px = x + L * 0.62;
    const wireY = rail - WIRE_DROP;
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px, top - 7);
    ctx.lineTo(px - 74, wireY + 2);
    ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.beginPath();
    ctx.arc(px - 74, wireY + 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#333';
    ctx.fillRect(px - 6, top - 9, 12, 5);

    // Bogies
    for (const bx of [x + L * 0.2, x + L * 0.8]) {
      fillRR(bx - 24, rail - 15, 48, 12, 3, '#2b2b2b');
      for (const wx of [bx - 13, bx + 13]) {
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.arc(wx, rail - 6, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#777';
        ctx.beginPath();
        ctx.arc(wx, rail - 6, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Roof and clerestory
    fillRR(x + 6, top - 6, L - 12, 8, 4, '#6e6458');
    fillRR(x + 34, top - 11, L - 68, 6, 2, '#857a6c');
    // Destination boxes at both ends
    for (const dx of [x + 10, x + L - 46]) {
      fillRR(dx, top - 16, 36, 11, 2, '#111');
      label(dx > x + L / 2 ? 'ST KILDA' : 'CITY', dx + 18, top - 7, 8, '#ffffff');
    }

    // Body: cream window band over a green lower body with gold lining
    ctx.save();
    roundRect(x, top, L, bot - top, 9);
    ctx.clip();
    ctx.fillStyle = '#efe4c2';
    ctx.fillRect(x, top, L, bot - top);
    ctx.fillStyle = '#1f5a36';
    ctx.fillRect(x, top + 26, L, bot - top - 26);
    ctx.fillStyle = '#d6b043';
    ctx.fillRect(x, top + 26, L, 2);
    ctx.fillRect(x, bot - 6, L, 1.5);
    ctx.restore();

    // Windows
    const doorX = x + L - r.door * PX;
    for (let i = 0; i < 10; i++) {
      const wx = x + 14 + i * ((L - 28) / 10);
      if (Math.abs(wx + 7 - doorX) < 22) continue;
      ctx.fillStyle = '#2d3c4a';
      ctx.fillRect(wx, top + 6, 14, 17);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(wx + 2, top + 8, 4, 13);
      ctx.fillStyle = '#efe4c2';
      ctx.fillRect(wx, top + 12, 14, 1.5);
    }
    // Cab windows at each end
    ctx.fillStyle = '#2d3c4a';
    ctx.fillRect(x + 4, top + 6, 8, 18);
    ctx.fillRect(x + L - 12, top + 6, 8, 18);

    // Drop-centre doorway
    const open = r.phase === 'board' || (r.phase === 'run' && doorX - sx(r.runX) < 60);
    fillRR(doorX - 18, top + 4, 36, bot - top - 2, 2, '#3a2a1a');
    if (!open) {
      for (const d of [-17, 1]) {
        ctx.fillStyle = '#7a4e2a';
        ctx.fillRect(doorX + d, top + 5, 16, bot - top - 5);
        ctx.fillStyle = '#2d3c4a';
        ctx.fillRect(doorX + d + 3, top + 8, 10, 14);
      }
    }

    // Fleet number and headlight
    label('W2 512', x + L * 0.3, top + 40, 9, '#d6b043');
    ctx.fillStyle = '#fff4b8';
    ctx.beginPath();
    ctx.arc(x + L - 3, top + 33, 3.5, 0, Math.PI * 2);
    ctx.fill();
    drawDriver(r, x + L - 8, top + 24, 0.55);
  }

  // Melbourne G class: modern three-section low-floor tram in PTV colours.
  function drawGClass(r) {
    const L = r.len * PX;
    const x = sx(r.x - r.len);
    if (x > W + 120 || x + L < -120) return;
    const rail = RAIL_Y[r.track];
    const j = tramJiggle(r);
    const bot = rail - 5 + j;
    const top = bot - 50;

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + L / 2, rail + 3, L / 2, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Pantograph on the middle section
    const px = x + L * 0.5;
    const wireY = rail - WIRE_DROP;
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px - 14, top - 5);
    ctx.lineTo(px + 10, (top + wireY) / 2);
    ctx.lineTo(px - 4, wireY + 3);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.fillRect(px - 16, wireY + 1, 26, 3);
    ctx.fillRect(px - 20, top - 6, 20, 5);

    const secs = [0, 0.36, 0.64, 1];
    for (let i = 0; i < 3; i++) {
      const a = x + secs[i] * L + (i ? 3 : 0);
      const b = x + secs[i + 1] * L - (i < 2 ? 3 : 0);
      const w = b - a;
      // Roof pods
      fillRR(a + 10, top - 6, w - 20, 7, 3, '#b8bec4');
      ctx.save();
      if (i === 2) {
        // Sloped modern nose
        ctx.beginPath();
        ctx.moveTo(a, top);
        ctx.lineTo(b - 22, top);
        ctx.quadraticCurveTo(b - 2, top + 4, b, top + 26);
        ctx.lineTo(b, bot - 4);
        ctx.quadraticCurveTo(b, bot, b - 4, bot);
        ctx.lineTo(a, bot);
        ctx.closePath();
      } else {
        roundRect(a, top, w, bot - top, i === 0 ? 8 : 2);
      }
      ctx.clip();
      ctx.fillStyle = '#f3f5f5';
      ctx.fillRect(a, top, w, bot - top);
      // Dark glass band
      ctx.fillStyle = '#26323d';
      ctx.fillRect(a, top + 8, w, 24);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      for (let gx = a + 8; gx < b; gx += 30) ctx.fillRect(gx, top + 10, 10, 20);
      // PTV green swoosh and grey skirt
      ctx.fillStyle = '#78be20';
      ctx.fillRect(a, bot - 14, w, 5);
      ctx.fillStyle = '#3a4045';
      ctx.fillRect(a, bot - 9, w, 9);
      // Doors
      const dx = a + w / 2 - 15;
      ctx.fillStyle = '#26323d';
      ctx.fillRect(dx, top + 6, 30, bot - top - 15);
      ctx.strokeStyle = '#78be20';
      ctx.lineWidth = 2;
      ctx.strokeRect(dx, top + 6, 30, bot - top - 15);
      const doorOpen = i === 1 && (r.phase === 'board' || (r.phase === 'run' && sx(r.x - r.door) - sx(r.runX) < 60));
      if (!doorOpen) {
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(dx + 3, top + 9, 11, bot - top - 21);
        ctx.fillRect(dx + 16, top + 9, 11, bot - top - 21);
      } else {
        ctx.fillStyle = '#0f151a';
        ctx.fillRect(dx + 1, top + 7, 28, bot - top - 17);
      }
      if (i === 2) {
        // Wraparound windscreen
        ctx.fillStyle = '#1b252e';
        ctx.beginPath();
        ctx.moveTo(b - 30, top + 6);
        ctx.quadraticCurveTo(b - 6, top + 8, b - 2, top + 34);
        ctx.lineTo(b - 30, top + 34);
        ctx.fill();
      }
      ctx.restore();
      if (i < 2) fillRR(b, top + 4, 6, bot - top - 8, 2, '#1b1b1b');
    }
    // Bogie wheels peeking under the skirt
    for (const bx of [x + L * 0.12, x + L * 0.5, x + L * 0.88]) {
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.arc(bx - 10, rail - 4, 5, 0, Math.PI);
      ctx.arc(bx + 10, rail - 4, 5, 0, Math.PI);
      ctx.fill();
    }
    // LED destination and headlights
    fillRR(x + L - 74, top + 1, 44, 7, 1, '#111');
    label('86 BUNDOORA', x + L - 52, top + 7.5, 6.5, '#ffb000');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + L - 6, bot - 20, 4, 3);
    label('G 2105', x + L * 0.15, top + 44, 8, '#3a4045');
    drawDriver(r, x + L - 16, top + 30, 0.6);
  }

  function drawRunner(r) {
    if (r.phase === 'drive' || r.phase === 'wait' && state === 'title') {
      if (r.phase === 'drive') return;
    }
    const feet = r.track === 0 ? BACK_FEET : FRONT_FEET;
    let y = feet;
    let jump = 0;
    let x = sx(r.runX);
    if (r.phase === 'board') {
      const k = 1 - r.boardT / BOARD_TIME;
      y = feet + (RAIL_Y[r.track] - 12 - feet) * k;
      jump = Math.sin(k * Math.PI) * 28;
      ctx.globalAlpha = k > 0.85 ? (1 - k) / 0.15 : 1;
    }
    drawChar(x, y, r.look, { moving: r.runV > 0.4 && r.phase === 'run', phase: r.runAnim * 1.9, jump, scale: 1.05 });
    ctx.globalAlpha = 1;
    if (r.trip > 0) outlined('!?', x + 6, y - 82, 18, '#ffffff');
  }

  function drawCheerleaders(side) {
    for (const c of course.cheer) {
      if (c.side !== side) continue;
      const x = sx(c.x);
      if (x < -40 || x > W + 40) continue;
      const feet = side === 0 ? BACK_FEET : FRONT_FEET;
      const hop = c.excited ? Math.abs(Math.sin(c.t * 7)) * 16 : Math.abs(Math.sin(c.t * 2)) * 2;
      drawChar(x, feet, c.look, { armsUp: c.excited, phase: c.t * 3.5, jump: hop, shout: c.excited, scale: 1 });
    }
    for (const b of bubbles) {
      if (b.side !== side) continue;
      const x = sx(b.x);
      const feet = side === 0 ? BACK_FEET : FRONT_FEET;
      const y = feet - 100 - (1.6 - b.t) * 10;
      ctx.globalAlpha = Math.min(1, b.t * 3);
      ctx.font = `bold 14px ${FONT}`;
      const w = ctx.measureText(b.text).width + 18;
      fillRR(x - w / 2, y - 18, w, 24, 10, '#ffffff');
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 5);
      ctx.lineTo(x + 6, y + 14);
      ctx.lineTo(x + 6, y + 5);
      ctx.fill();
      label(b.text, x, y - 1, 14, '#d63384');
      ctx.globalAlpha = 1;
    }
  }

  function drawFinish() {
    const x = sx(TRACK_LEN);
    if (x < -40 || x > W + 140) return;
    const sq = 8;
    for (let y = STREET_TOP, row = 0; y < FRONT_PATH_TOP; y += sq, row++) {
      for (let c = 0; c < 3; c++) {
        ctx.fillStyle = (row + c) % 2 ? '#111' : '#fff';
        ctx.fillRect(x + c * sq, y, sq, sq);
      }
    }
    // Banner across the street on the span wire
    ctx.fillStyle = '#3b4148';
    ctx.fillRect(x - 4, BACK_FEET - 170, 6, 170);
    fillRR(x - 70, BACK_FEET - 176, 150, 30, 6, '#d0021b');
    label('FINISH', x + 5, BACK_FEET - 154, 18, '#ffffff', 'center', '900');
  }

  function drawParticles() {
    for (const p of particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - camX * PX - 2, p.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
  }

  // ---- HUD ----------------------------------------------------------------
  function standingOf(r) {
    if (winner) return winner === r ? 1 : 2;
    const other = r === player ? cpu : player;
    const mine = r.phase === 'drive' ? r.x : r.runX;
    const theirs = other.phase === 'drive' ? other.x : other.runX;
    return mine >= theirs ? 1 : 2;
  }

  function drawHUD() {
    // Left: position and time
    fillRR(12, 10, 196, 54, 12, 'rgba(15,20,30,0.72)');
    const pos = standingOf(player);
    outlined(pos === 1 ? '1st' : '2nd', 28, 52, 34, pos === 1 ? '#ffd43b' : '#dee2e6', '#000', 'left');
    label('TIME', 110, 30, 11, '#adb5bd', 'left');
    label(fmtTime(player.finished ? player.finishTime : raceTime), 110, 52, 20, '#ffffff', 'left');

    // Centre: progress
    const x0 = 250;
    const x1 = 690;
    fillRR(x0 - 14, 14, x1 - x0 + 28, 30, 12, 'rgba(15,20,30,0.72)');
    ctx.fillStyle = '#495057';
    ctx.fillRect(x0, 28, x1 - x0, 3);
    label('🏁', x1 + 2, 35, 14, '#fff');
    for (const r of [cpu, player]) {
      const k = clamp((r.phase === 'drive' ? r.x : START_X) / TRACK_LEN, 0, 1);
      const mx = x0 + (x1 - x0 - 10) * k;
      fillRR(mx - 12, 21, 24, 16, 4, r.cls === 'W' ? '#1f5a36' : '#f3f5f5');
      label(r.cls, mx, 33, 11, r.cls === 'W' ? '#efe4c2' : '#3a4045');
    }

    // Right: warnings
    let warn = null;
    if (player.phase === 'drive' && !player.finished) {
      for (const z of course.slowZones) {
        if (player.x <= z.end + player.len && z.start - player.x < 70) {
          warn = { t: z.start > player.x ? `CURVE IN ${Math.ceil(z.start - player.x)} m` : 'CURVE: MAX 40', bad: player.v > z.limit + SLOW_TOLERANCE };
          break;
        }
      }
      if (!warn) {
        for (const c of course.crossings) {
          const d = c.x - player.x;
          if (d > -CROSS_HALF && d < 65) {
            const red = signalRed(c, player.track, raceTime);
            warn = { t: red ? 'RED LIGHT: STOP!' : 'CROSSING AHEAD', bad: red };
            break;
          }
        }
      }
    }
    if (warn) {
      const blink = !warn.bad || Math.floor(clock * 6) % 2;
      fillRR(W - 238, 10, 226, 40, 12, warn.bad ? 'rgba(208,2,27,0.85)' : 'rgba(242,197,0,0.9)');
      if (blink) label(warn.t, W - 125, 37, 17, warn.bad ? '#ffffff' : '#1a1a1a', 'center', '900');
    }

    // Speedometer
    const cx = W / 2;
    const cy = H - 6;
    ctx.fillStyle = 'rgba(15,20,30,0.78)';
    ctx.beginPath();
    ctx.arc(cx, cy, 64, Math.PI, 0);
    ctx.fill();
    ctx.strokeStyle = '#495057';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(cx, cy, 52, Math.PI, 0);
    ctx.stroke();
    ctx.strokeStyle = '#f03e3e';
    ctx.beginPath();
    ctx.arc(cx, cy, 52, Math.PI + Math.PI * (40 / 100), Math.PI + Math.PI * (40 / 100) + 0.05);
    ctx.stroke();
    const sp = player.phase === 'drive' ? kmh(player.v) : 0;
    const ang = Math.PI + Math.PI * clamp(sp / 100, 0, 1);
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * 46, cy + Math.sin(ang) * 46);
    ctx.stroke();
    label(String(sp), cx, cy - 16, 20, '#ffffff');
    label('km/h', cx, cy - 4, 9, '#adb5bd');

    // On-screen pedals (work with mouse and touch too)
    drawPedal(16, H - 78, 'BRAKE', '← / A', brakeHeld(), '#c92a2a');
    drawPedal(W - 176, H - 78, player.phase === 'drive' ? 'POWER' : 'RUN', '→ / D', powerHeld(), '#2b8a3e');
  }

  const PEDALS = { brake: [16, H - 78, 160, 66], power: [W - 176, H - 78, 160, 66] };

  function drawPedal(x, y, text, keysText, on, color) {
    fillRR(x, y, 160, 66, 16, on ? color : 'rgba(15,20,30,0.55)');
    ctx.strokeStyle = on ? '#ffffff' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    roundRect(x, y, 160, 66, 16);
    ctx.stroke();
    label(text, x + 80, y + 34, 22, '#ffffff', 'center', '900');
    label(keysText, x + 80, y + 54, 12, 'rgba(255,255,255,0.7)');
  }

  function drawBigText(text, sub, alpha = 1) {
    ctx.globalAlpha = clamp(alpha, 0, 1);
    outlined(text, W / 2, 190, 64, '#ffffff');
    if (sub) {
      ctx.font = `bold 18px ${FONT}`;
      const w = ctx.measureText(sub).width + 28;
      fillRR(W / 2 - w / 2, 206, w, 32, 14, 'rgba(15,20,30,0.8)');
      label(sub, W / 2, 228, 18, '#ffd43b');
    }
    ctx.globalAlpha = 1;
  }

  function drawPanel(title, lines, titleColor) {
    const pw = 560;
    const ph = 96 + lines.length * 28;
    const x = (W - pw) / 2;
    const y = Math.round((H - ph) / 2) - 30;
    fillRR(x, y, pw, ph, 18, 'rgba(15,20,30,0.88)');
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    roundRect(x, y, pw, ph, 18);
    ctx.stroke();
    outlined(title, W / 2, y + 58, 44, titleColor, '#000');
    lines.forEach((l, i) => label(l.t, W / 2, y + 98 + i * 28, l.size || 17, l.c || '#e9ecef', 'center', l.w || 'bold'));
  }

  // ---- Frame --------------------------------------------------------------
  function render() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    drawSky();
    drawFar();
    drawMid();
    drawTrees();
    drawStreet();
    drawStops();
    drawZones();
    drawSignals(0);
    drawCheerleaders(0);
    drawRunner(cpu);
    for (const c of course.crossings) drawCar(c, 0, RAIL_Y[0] + 1);
    drawTrack(0);
    drawWires();
    drawGClass(cpu);
    for (const c of course.crossings) drawCar(c, RAIL_Y[0] + 1, RAIL_Y[1] + 1);
    drawTrack(1);
    drawWClass(player);
    for (const c of course.crossings) drawCar(c, RAIL_Y[1] + 1, 9999);
    drawFinish();
    drawFrontPoles();
    drawSignals(1);
    drawCheerleaders(1);
    drawRunner(player);
    drawParticles();

    if (state === 'title') {
      drawPanel('TRAM RACER', [
        { t: 'Melbourne edition: your W class vs the CPU\'s G class', c: '#ffd43b' },
        { t: 'Hold → to run to your tram, it boards by itself' },
        { t: 'On the tram: hold → for power, ← to brake' },
        { t: 'Over 40 km/h on a curve and you derail' },
        { t: 'Red light at a crossing? Stop, or meet a car' },
        { t: '' },
        { t: 'Press Enter, Space or tap to start', c: Math.floor(clock * 2.5) % 2 ? '#69db7c' : '#2f9e44', size: 20, w: '900' },
      ], '#ffffff');
      drawChar(W / 2 - 330, 360, PLAYER_LOOK, { scale: 2.4 });
      drawChar(W / 2 + 330, 360, CPU_LOOK, { scale: 2.4 });
      return;
    }

    drawHUD();
    if (state === 'countdown') drawBigText(String(Math.ceil(countdown)), 'Get ready to run!');
    else if (message) drawBigText(message.text, message.sub, message.t * 2);

    if (state === 'results') {
      const won = winner === player;
      drawPanel(won ? 'YOU WIN!' : 'CPU WINS', [
        { t: `You (W class)   ${fmtTime(player.finishTime)}`, c: '#b2f2bb' },
        { t: `CPU (G class)   ${cpu.finished ? fmtTime(cpu.finishTime) : 'still going...'}`, c: '#dee2e6' },
        { t: '' },
        { t: 'Press Enter, Space or tap to race again', c: Math.floor(clock * 2.5) % 2 ? '#69db7c' : '#2f9e44', size: 20, w: '900' },
      ], won ? '#ffd43b' : '#ff6b6b');
    }
  }

  // ---- Input --------------------------------------------------------------
  const GAME_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyA', 'KeyD', 'KeyW', 'KeyS', 'Enter']);

  window.addEventListener('keydown', (e) => {
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    keys[e.code] = true;
    initAudio();
    if (!e.repeat && (e.code === 'Enter' || e.code === 'Space') && (state === 'title' || state === 'results')) startCountdown();
  });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => {
    for (const k in keys) keys[k] = false;
    touch.power = touch.brake = false;
  });

  // Pointer input: on-screen pedals, or tap anywhere to start.
  const pointers = new Map();
  function toCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    return [(e.clientX - rect.left) * (W / rect.width), (e.clientY - rect.top) * (H / rect.height)];
  }
  function pedalAt(x, y) {
    for (const [name, [px, py, pw, ph]] of Object.entries(PEDALS)) {
      if (x >= px && x <= px + pw && y >= py && y <= py + ph) return name;
    }
    // Otherwise, the left half brakes and the right half powers.
    return x < W / 2 ? 'brake' : 'power';
  }
  function syncTouch() {
    const held = [...pointers.values()];
    touch.power = held.includes('power');
    touch.brake = held.includes('brake');
  }
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    initAudio();
    if (state === 'title' || state === 'results') {
      startCountdown();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toCanvas(e);
    pointers.set(e.pointerId, pedalAt(x, y));
    syncTouch();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    canvas.addEventListener(ev, (e) => {
      pointers.delete(e.pointerId);
      syncTouch();
    });
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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
    render,
    step(seconds, dt = 1 / 60) {
      for (let s = 0; s < seconds; s += dt) update(dt);
    },
  };
})();
