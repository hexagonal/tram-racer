'use strict';

(() => {
  const canvas = document.getElementById('game');
  let ctx = canvas.getContext('2d');
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

    // Cheerleaders turn up now and then along the footpaths. Spectators (three
    // for every cheerleader, a mix of men and women) are spread out along the
    // whole route instead of clumping around them. TV news crews cover the
    // start and the finish.
    const people = [];
    const vans = [];
    const cheers = [];
    for (let cx = 120 + rnd() * 80; cx < TRACK_LEN - 60; cx += 160 + rnd() * 180) cheers.push([cx, rnd() < 0.5 ? 0 : 1, pick(CHEER_LOOKS, rnd)]);
    cheers.push([TRACK_LEN + 6, 1, CHEER_LOOKS[0]], [TRACK_LEN + 14, 1, CHEER_LOOKS[1]]);
    for (const [cx, side, look] of cheers) people.push({ kind: 'cheer', x: cx, side, look, t: rnd() * 10, said: false });
    const fanCount = cheers.length * 3;
    const clearOf = (fx, side) => people.every((p) => p.side !== side || Math.abs(p.x - fx) > 2.6);
    const addFan = (fx, side, i) => {
      people.push({ kind: 'fan', x: fx, side, look: randomSpectator(rnd, i % 2 ? 'm' : 'f'), t: rnd() * 10, scale: 0.92 + rnd() * 0.14 });
    };
    // A small crowd at the start and the finish, the rest spread evenly
    // (with some jitter) along the course on alternating footpaths.
    let fi = 0;
    for (const [fx, side] of [[-12, 0], [-8, 1], [TRACK_LEN - 4, 0], [TRACK_LEN + 9, 0], [TRACK_LEN + 18, 1], [TRACK_LEN + 1, 1]]) addFan(fx, side, fi++);
    const spread = fanCount - fi;
    for (let k = 0; k < spread; k++) {
      const side = rnd() < 0.5 ? 0 : 1;
      let fx = 60 + (k + 0.5) * ((TRACK_LEN - 80) / spread) + (rnd() - 0.5) * 30;
      for (let tries = 0; tries < 8 && !clearOf(fx, side); tries++) fx += 3;
      addFan(fx, side, fi++);
    }
    const addCrew = (x, side, cameraFacesLeft, line, look) => {
      const camX = cameraFacesLeft ? x + 5 : x;
      const repX = cameraFacesLeft ? x : x + 5;
      people.push({ kind: 'camera', x: camX, side, look: CAMERA_LOOK, t: rnd() * 10, flip: cameraFacesLeft });
      people.push({ kind: 'reporter', x: repX, side, look, t: rnd() * 10, flip: !cameraFacesLeft, line, said: false });
    };
    addCrew(-27, 1, false, 'Live from Flinders St!', REPORTER_LOOKS[0]);
    vans.push({ x: 33, side: 0 });
    addCrew(41, 0, true, 'And they\'re off!', REPORTER_LOOKS[1]);
    addCrew(TRACK_LEN + 24, 1, true, 'What a finish!', REPORTER_LOOKS[1]);
    vans.push({ x: TRACK_LEN + 4, side: 0 });
    addCrew(TRACK_LEN + 12, 0, true, 'Unbelievable scenes!', REPORTER_LOOKS[0]);
    people.sort((a, b) => (a.kind === 'fan' ? 0 : 1) - (b.kind === 'fan' ? 0 : 1));

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

    return { slowZones, crossings, people, vans, far, mid, trees, stops };
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
  const PLAYER_LOOK = { gender: 'm', skin: '#ffe0c7', hair: '#2d6cdf', hairDark: '#1a3f8f', style: 'spiky', eye: '#1d5fd0', outfit: '#23395b', trim: '#f4c430', cap: '#1b2a44', legs: '#1b2a44', shoes: '#111' };
  const CPU_LOOK = { gender: 'f', skin: '#f7d2b6', hair: '#e2e6ee', hairDark: '#9aa2b4', style: 'pony', eye: '#2e9e5b', outfit: '#3f4a52', trim: '#78be20', cap: null, legs: '#2b3036', shoes: '#111' };
  const CHEER_LOOKS = [
    { gender: 'f', skin: '#ffe3cf', hair: '#ff6fa8', hairDark: '#c93f7a', style: 'twin', eye: '#c2306f', outfit: '#ffffff', trim: '#1f4fa3', skirt: '#1f4fa3', legs: '#ffe3cf', pom: '#f4c430', shoes: '#fff' },
    { gender: 'f', skin: '#f3c9a5', hair: '#f6c544', hairDark: '#c08d1c', style: 'twin', eye: '#7b45b8', outfit: '#ffffff', trim: '#c0392b', skirt: '#c0392b', legs: '#f3c9a5', pom: '#ffffff', shoes: '#fff' },
    { gender: 'f', skin: '#d9a07a', hair: '#3a2a2a', hairDark: '#1a1010', style: 'pony', eye: '#8a5a2a', outfit: '#ffffff', trim: '#16a085', skirt: '#16a085', legs: '#d9a07a', pom: '#f39c12', shoes: '#fff' },
  ];
  const REPORTER_LOOKS = [
    { gender: 'f', skin: '#ffe0c7', hair: '#6b3a1f', hairDark: '#3f2010', style: 'bob', eye: '#8a4a22', outfit: '#b5223a', trim: '#f3e6e6', legs: '#2a2a33', shoes: '#111', skirt: '#2a2a33' },
    { gender: 'm', skin: '#e8b996', hair: '#1c1c24', hairDark: '#08080c', style: 'short', eye: '#3a3a6a', outfit: '#2f3e5c', trim: '#dfe6ee', legs: '#2a2a33', shoes: '#111' },
  ];
  const CAMERA_LOOK = { gender: 'm', skin: '#f0c8a8', hair: '#5a4a3a', hairDark: '#2e241a', style: 'messy', eye: '#4a3a2a', outfit: '#4b5a3c', trim: '#2b3324', legs: '#3a3f46', shoes: '#222', cap: '#22262b' };
  const SKINS = ['#ffe3cf', '#f7d2b6', '#f0c8a8', '#e3b08c', '#c98d66', '#9a6646', '#ffd9c2'];
  const HAIRS = [['#2d2a32', '#100e14'], ['#7a4a2a', '#4a2a12'], ['#e8c34a', '#b0861c'], ['#c0392b', '#7a1f16'], ['#7d5fd3', '#4a3394'], ['#e2e6ee', '#9aa2b4'], ['#3fae8f', '#1f7058'], ['#f08bb4', '#b8507e'], ['#4a6fd0', '#24408f']];
  const OUTFITS = ['#e8590c', '#1971c2', '#2f9e44', '#f8f9fa', '#ae3ec9', '#f59f00', '#c92a2a', '#495057', '#0ca678', '#f783ac'];
  const EYES = ['#1d5fd0', '#2e9e5b', '#8a4a22', '#7b45b8', '#c2306f', '#d08a1d', '#3a7a9a'];
  const PROPS = ['flag', 'scarf', 'phone', 'sign', 'none', 'flag', 'scarf'];
  const OUTLINE = '#2b1d1d';

  function randomSpectator(rnd, gender) {
    const [hair, hairDark] = pick(HAIRS, rnd);
    const female = gender === 'f';
    return {
      gender, skin: pick(SKINS, rnd), hair, hairDark,
      style: pick(female ? ['long', 'pony', 'bob', 'bun', 'twin', 'long'] : ['short', 'spiky', 'messy', 'short'], rnd),
      eye: pick(EYES, rnd), outfit: pick(OUTFITS, rnd), trim: pick(OUTFITS, rnd),
      legs: pick(['#2b3a55', '#3a3a3a', '#5c4a3a', '#1f2a44', '#6b7b8c'], rnd),
      skirt: female && rnd() < 0.5 ? pick(['#1f2a44', '#c92a2a', '#495057', '#7048e8', '#e8590c'], rnd) : null,
      shoes: pick(['#111', '#f8f9fa', '#7a3f1d'], rnd), prop: pick(PROPS, rnd),
      flag: pick([['#1f5a36', '#f4c430'], ['#0b2a6b', '#ffffff'], ['#c92a2a', '#ffffff'], ['#78be20', '#ffffff']], rnd),
      sign: pick(['GO W!', 'GO G!', 'DING!', 'GO GO!', 'MELB ♥'], rnd),
    };
  }

  function outlineFill(color, width = 1.1) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // A tapered limb segment with an outline. Returns the end point.
  function limb(x1, y1, len, ang, width, color, endWidth = width) {
    const x2 = x1 + Math.sin(ang) * len;
    const y2 = y1 + Math.cos(ang) * len;
    const nx = Math.cos(ang);
    const ny = -Math.sin(ang);
    ctx.beginPath();
    ctx.moveTo(x1 + nx * width / 2, y1 + ny * width / 2);
    ctx.lineTo(x2 + nx * endWidth / 2, y2 + ny * endWidth / 2);
    ctx.arc(x2, y2, endWidth / 2, ang === 0 ? 0 : Math.atan2(ny, nx), Math.atan2(ny, nx) + Math.PI, true);
    ctx.lineTo(x1 - nx * width / 2, y1 - ny * width / 2);
    ctx.arc(x1, y1, width / 2, Math.atan2(-ny, -nx), Math.atan2(-ny, -nx) + Math.PI, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Cover the previous segment's end outline where the joint bends.
    ctx.beginPath();
    ctx.arc(x1, y1, width / 2 + 0.55, 0, Math.PI * 2);
    ctx.fill();
    // Outline the sides and the far end only, so elbows and knees don't
    // show up as rings.
    ctx.beginPath();
    ctx.moveTo(x1 + nx * width / 2, y1 + ny * width / 2);
    ctx.lineTo(x2 + nx * endWidth / 2, y2 + ny * endWidth / 2);
    ctx.arc(x2, y2, endWidth / 2, ang === 0 ? 0 : Math.atan2(ny, nx), Math.atan2(ny, nx) + Math.PI, true);
    ctx.lineTo(x1 - nx * width / 2, y1 - ny * width / 2);
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.stroke();
    return [x2, y2];
  }

  // Shoulder to hand: sleeve, forearm and a small hand. Returns the hand.
  function arm(look, sx0, ang, bend, len = 15) {
    const elbow = limb(sx0, -35, len * 0.5, ang, 4.6, look.outfit, 4);
    const handPt = limb(elbow[0], elbow[1], len * 0.5, ang + bend, 3.6, look.skin, 3.2);
    ctx.beginPath();
    ctx.arc(handPt[0], handPt[1], 2.4, 0, Math.PI * 2);
    outlineFill(look.skin, 0.9);
    if (look.pom) {
      ctx.beginPath();
      for (let i = 0; i < 9; i++) {
        const a2 = (i / 9) * Math.PI * 2;
        const r2 = i % 2 ? 4.5 : 6.2;
        ctx.lineTo(handPt[0] + Math.cos(a2) * r2, handPt[1] + Math.sin(a2) * r2);
      }
      ctx.closePath();
      outlineFill(look.pom, 0.9);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.beginPath();
      ctx.arc(handPt[0] - 1.5, handPt[1] - 1.8, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    return handPt;
  }

  // Anime-style character, facing right (or left with a.flip), feet at (x, y).
  function drawChar(x, y, look, a = {}) {
    const s = a.scale || 1;
    const phase = a.phase || 0;
    const moving = !!a.moving;
    const female = look.gender === 'f';
    ctx.save();
    ctx.translate(x, y - (a.jump || 0));
    ctx.scale(a.flip ? -s : s, s);

    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(0, 1 + (a.jump || 0) / s, 11, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    const sw = female ? 6.5 : 8;           // half shoulder width
    const armSwing = moving ? -Math.sin(phase) * 1.1 : 0.12;
    const wave = Math.sin(phase * 2) * 0.15;

    // Back arm first, so the body overlaps it
    let backHand = null;
    let frontHand = null;
    if (a.armsUp) {
      backHand = arm(look, -sw + 2, -(Math.PI - 1.15) - wave, -0.25, 17);
      frontHand = arm(look, sw - 2, Math.PI - 1.15 + wave, 0.25, 17);
      drawHeldProp(look, backHand, frontHand, phase, true);
    } else {
      arm(look, -sw + 2.5, -armSwing, moving ? 0.6 : 0.15);
    }

    // Legs: thighs and shins, with a knee bend when running
    const swing = moving ? Math.sin(phase) * 0.85 : 0;
    const trousers = female && (look.skirt || look.style === 'twin') ? look.legs : look.legs;
    for (const [hx, sw2, bend] of [[-2.2, swing, Math.max(0, Math.sin(phase))], [2.2, -swing, Math.max(0, -Math.sin(phase))]]) {
      const knee = limb(hx, -22, 11, sw2, 5.4, trousers, 4.4);
      const foot = limb(knee[0], knee[1], 10.5, sw2 - (moving ? bend * 1.0 : 0), 4.4, trousers, 3.6);
      ctx.beginPath();
      ctx.moveTo(foot[0] - 2.5, foot[1] - 1);
      ctx.quadraticCurveTo(foot[0] + 6.5, foot[1] - 2.5, foot[0] + 6, foot[1] + 1.5);
      ctx.lineTo(foot[0] - 2.5, foot[1] + 1.5);
      ctx.closePath();
      outlineFill(look.shoes || '#222', 0.9);
    }

    // Torso with shoulders and waist
    ctx.beginPath();
    ctx.moveTo(-sw, -33);
    ctx.quadraticCurveTo(-sw, -38, -sw + 4, -38);
    ctx.lineTo(sw - 4, -38);
    ctx.quadraticCurveTo(sw, -38, sw, -33);
    ctx.lineTo(female ? 5 : 6.5, -27);
    ctx.lineTo(female ? 6.5 : 6.5, -21);
    ctx.lineTo(female ? -6.5 : -6.5, -21);
    ctx.lineTo(female ? -5 : -6.5, -27);
    ctx.closePath();
    ctx.save();
    outlineFill(look.outfit);
    ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(-sw - 1, -38, 4.5, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(sw - 3.5, -37, 2.5, 10);
    ctx.fillStyle = look.trim;
    ctx.fillRect(-sw, -24.5, sw * 2, 2);
    // Collar
    ctx.fillStyle = look.outfit === '#ffffff' || look.outfit === '#f8f9fa' ? look.trim : '#ffffff';
    ctx.beginPath();
    ctx.moveTo(-2.5, -38);
    ctx.lineTo(1, -33.5);
    ctx.lineTo(4.5, -38);
    ctx.fill();
    ctx.restore();
    if (look.skirt) {
      const flick = Math.sin(phase * 2) * 1.2;
      ctx.beginPath();
      ctx.moveTo(-6.5, -22.5);
      ctx.lineTo(6.5, -22.5);
      ctx.lineTo(10 + flick, -13);
      ctx.lineTo(-10 + flick, -13);
      ctx.closePath();
      outlineFill(look.skirt);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      for (const px of [-4, 0, 4]) {
        ctx.moveTo(px, -22);
        ctx.lineTo(px * 1.5 + flick, -13.5);
      }
      ctx.stroke();
    }
    if (look.prop === 'scarf' && look.flag) {
      const [c1, c2] = look.flag;
      ctx.beginPath();
      ctx.ellipse(1, -38, 6.5, 2.6, 0, 0, Math.PI * 2);
      outlineFill(c1, 0.9);
      ctx.fillStyle = c2;
      ctx.fillRect(-2, -40, 2.5, 4);
      ctx.fillRect(3, -40, 2.5, 4);
      ctx.beginPath();
      ctx.rect(-6, -37, 3, 10);
      outlineFill(c1, 0.9);
      ctx.fillStyle = c2;
      ctx.fillRect(-6, -32, 3, 2);
    }

    // Neck
    ctx.beginPath();
    ctx.rect(-1.5, -42, 5, 5);
    outlineFill(look.skin, 0.9);
    ctx.fillStyle = 'rgba(120,60,50,0.25)';
    ctx.fillRect(-1, -42, 4, 2);

    drawBackHair(look, phase, moving);
    drawHead(look, a, female);

    // Front arm, always kept below the face
    if (!a.armsUp) {
      let ang = armSwing;
      let bend = moving ? 0.7 : 0.1;
      if (a.pose === 'mic') { ang = 1.6; bend = 0.9; }
      if (a.pose === 'camera') { ang = 1.9; bend = 0.4; }
      if (a.pose === 'phone') { ang = 1.6; bend = 0.6; }
      frontHand = arm(look, sw - 2.5, ang, bend);
      if (a.pose === 'mic') drawMic(frontHand);
      if (a.pose === 'camera') drawCamera(phase);
      if (a.pose === 'phone' || (look.prop === 'phone' && !moving && !a.pose)) drawPhone(frontHand);
    }
    ctx.restore();
  }

  function headPath() {
    ctx.beginPath();
    ctx.moveTo(-12, -56);
    ctx.arc(1, -56, 13, Math.PI, 0);
    ctx.quadraticCurveTo(14.6, -47.5, 9.5, -42.2);
    ctx.quadraticCurveTo(5.5, -39.6, 1, -41.6);
    ctx.quadraticCurveTo(-11.5, -46, -12, -56);
    ctx.closePath();
  }

  function drawHead(look, a, female) {
    headPath();
    ctx.save();
    outlineFill(look.skin);
    ctx.clip();
    // Soft shade on the far side and under the fringe
    ctx.fillStyle = 'rgba(200,110,90,0.16)';
    ctx.fillRect(-13, -70, 6, 30);
    ctx.fillStyle = 'rgba(200,110,90,0.18)';
    ctx.fillRect(-13, -58, 30, 3);
    ctx.restore();
    // Ear
    ctx.beginPath();
    ctx.ellipse(-7, -50, 2.4, 3.4, 0.1, 0, Math.PI * 2);
    outlineFill(look.skin, 0.9);
    ctx.strokeStyle = 'rgba(160,80,70,0.5)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(-7, -50, 1.2, -1, 1.6);
    ctx.stroke();

    // Eyes: the near one larger, the far one narrower (three-quarter view)
    const eh = female ? 7 : 5.6;
    drawEye(7.6, -50.5, female ? 3.7 : 3.4, eh, look, female, a.blink, 1);
    drawEye(-1.4, -50.5, female ? 3.0 : 2.7, eh * 0.95, look, female, a.blink, -1);

    // Brows
    ctx.strokeStyle = look.hairDark;
    ctx.lineCap = 'round';
    ctx.lineWidth = female ? 1 : 1.6;
    ctx.beginPath();
    ctx.moveTo(4.5, -57.6);
    ctx.quadraticCurveTo(7.5, -59, 11, -57.8);
    ctx.moveTo(-3.6, -57.6);
    ctx.quadraticCurveTo(-1.5, -58.6, 0.6, -57.8);
    ctx.stroke();

    // Nose and mouth
    ctx.strokeStyle = 'rgba(150,70,60,0.7)';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(12, -48.5);
    ctx.lineTo(12.8, -46.4);
    ctx.lineTo(11.6, -46.2);
    ctx.stroke();
    const open = a.shout || (a.talk && Math.sin((a.phase || 0) * 7) > 0);
    if (open) {
      ctx.beginPath();
      ctx.moveTo(5, -44);
      ctx.quadraticCurveTo(7.5, -44.6, 10, -44);
      ctx.quadraticCurveTo(7.5, -39.8, 5, -44);
      outlineFill('#9a2e3a', 0.8);
      ctx.fillStyle = '#ff8fa3';
      ctx.beginPath();
      ctx.ellipse(7.5, -41.9, 1.6, 0.8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = '#8a3a3a';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(5, -43.8);
      ctx.quadraticCurveTo(6.9, -42.6, 8.7, -43.9);
      ctx.stroke();
    }
    // Blush
    for (const [bx, br] of [[10.6, 2.6], [-2.4, 1.9]]) {
      const bg = ctx.createRadialGradient(bx, -46.6, 0, bx, -46.6, br);
      bg.addColorStop(0, female ? 'rgba(255,105,135,0.5)' : 'rgba(255,120,120,0.28)');
      bg.addColorStop(1, 'rgba(255,120,140,0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.ellipse(bx, -46.6, br, br * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    drawFrontHair(look);

    // Driver's or camera operator's cap
    if (look.cap) {
      ctx.beginPath();
      ctx.moveTo(-12, -60);
      ctx.quadraticCurveTo(-11, -72, 2, -72.5);
      ctx.quadraticCurveTo(14, -72, 14.5, -61);
      ctx.closePath();
      outlineFill(look.cap);
      ctx.beginPath();
      ctx.moveTo(8, -61.5);
      ctx.quadraticCurveTo(16, -62.5, 20, -59.5);
      ctx.lineTo(9, -59);
      ctx.closePath();
      outlineFill(look.cap);
      ctx.fillStyle = look.trim;
      ctx.fillRect(-12, -62, 26.5, 1.8);
      ctx.beginPath();
      ctx.arc(3, -66.5, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(1, -64, 9, -2.6, -1.7);
      ctx.stroke();
    }
  }

  function drawEye(ex, ey, w, h, look, female, blink, side) {
    if (blink) {
      ctx.strokeStyle = '#1a1010';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(ex - w, ey);
      ctx.quadraticCurveTo(ex, ey + 1.6, ex + w, ey);
      ctx.stroke();
      return;
    }
    // Sclera
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(ex - w - 0.4, ey - h * 0.3);
    ctx.quadraticCurveTo(ex, ey - h * 0.62, ex + w + 0.6, ey - h * 0.42);
    ctx.quadraticCurveTo(ex + w + 0.8, ey + h * 0.45, ex, ey + h * 0.5);
    ctx.quadraticCurveTo(ex - w - 0.6, ey + h * 0.42, ex - w - 0.4, ey - h * 0.3);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.clip();
    // Iris with a dark top fading to a bright bottom
    const ix = ex + 0.5;
    const g = ctx.createLinearGradient(0, ey - h / 2, 0, ey + h / 2);
    g.addColorStop(0, '#1c1428');
    g.addColorStop(0.3, look.eye);
    g.addColorStop(0.75, look.eye);
    g.addColorStop(1, '#f2f6ff');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(ix, ey + 0.4, w * 0.88, h * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0d0a10';
    ctx.beginPath();
    ctx.ellipse(ix + 0.2, ey + 0.4, w * 0.4, h * 0.27, 0, 0, Math.PI * 2);
    ctx.fill();
    // Shadow from the upper lid
    ctx.fillStyle = 'rgba(40,20,60,0.3)';
    ctx.fillRect(ex - w - 1, ey - h * 0.62, w * 2 + 2, h * 0.14);
    ctx.restore();
    // Highlights
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(ix + w * 0.35, ey - h * 0.18, w * 0.32, h * 0.13, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ix - w * 0.4, ey + h * 0.24, w * 0.15, 0, Math.PI * 2);
    ctx.fill();
    // Upper lash line, heavier on girls with a flick at the outer corner
    ctx.strokeStyle = '#1a1010';
    ctx.lineCap = 'round';
    ctx.lineWidth = female ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(ex - w - 0.6, ey - h * 0.28);
    ctx.quadraticCurveTo(ex, ey - h * 0.68, ex + w + 0.8, ey - h * 0.44);
    if (female) ctx.lineTo(ex + w + 2.2 * (side > 0 ? 1 : 0.6), ey - h * 0.6);
    ctx.stroke();
    // Lower lash
    ctx.lineWidth = 0.7;
    ctx.strokeStyle = 'rgba(40,20,20,0.6)';
    ctx.beginPath();
    ctx.moveTo(ex - w * 0.4, ey + h * 0.5);
    ctx.lineTo(ex + w * 0.6, ey + h * 0.46);
    ctx.stroke();
  }

  function drawBackHair(look, phase, moving) {
    const flow = moving ? Math.sin(phase * 2) * 3 : 0;
    ctx.beginPath();
    if (look.style === 'pony') {
      ctx.moveTo(-8, -64);
      ctx.quadraticCurveTo(-26, -58 + flow, -21, -36 + flow);
      ctx.quadraticCurveTo(-18, -44, -15, -40 + flow);
      ctx.quadraticCurveTo(-16, -52, -7, -56);
    } else if (look.style === 'twin') {
      for (const side of [-1, 1]) {
        const bob = Math.sin(phase * 2 + side) * 2.5;
        const cx = side * 15 - 1;
        ctx.moveTo(cx, -62);
        ctx.quadraticCurveTo(cx + side * 9, -52 + bob, cx + side * 3, -36 + bob);
        ctx.quadraticCurveTo(cx + side * 2, -46, cx - side * 3, -58);
        ctx.closePath();
      }
    } else if (look.style === 'long') {
      ctx.moveTo(-13, -60);
      ctx.quadraticCurveTo(-19, -44, -15 + flow, -28);
      ctx.lineTo(-10 + flow, -31);
      ctx.lineTo(-6 + flow, -27);
      ctx.lineTo(-2, -32);
      ctx.lineTo(4, -36);
      ctx.lineTo(12, -44);
      ctx.lineTo(13, -60);
    } else if (look.style === 'bob') {
      ctx.moveTo(-14, -60);
      ctx.quadraticCurveTo(-17, -46, -12, -40);
      ctx.lineTo(-6, -41.5);
      ctx.lineTo(-1, -40);
      ctx.lineTo(-4, -46);
      ctx.lineTo(-2, -60);
    } else if (look.style === 'bun') {
      ctx.arc(-8, -68, 6.5, 0, Math.PI * 2);
    } else {
      return;
    }
    ctx.closePath();
    outlineFill(look.hairDark);
  }

  function drawFrontHair(look) {
    const style = look.style;
    ctx.beginPath();
    if (style === 'spiky') {
      ctx.moveTo(-14, -48);
      const pts = [[-18, -60], [-12, -62], [-15, -72], [-6, -67], [-5, -78], [1, -69], [6, -79], [9, -68], [17, -74], [14, -63], [19, -59], [14, -56],
        [12, -51], [10, -57], [7, -51], [5, -58], [1, -52], [-2, -58], [-5, -52], [-8, -57], [-11, -50]];
      for (const [px, py] of pts) ctx.lineTo(px, look.cap ? Math.max(py, -63) : py);
    } else if (style === 'short' || style === 'messy') {
      ctx.moveTo(-13, -49);
      ctx.quadraticCurveTo(-16, -66, -2, -70.5);
      if (style === 'messy') {
        ctx.lineTo(1, -73);
        ctx.lineTo(4, -70.5);
        ctx.lineTo(9, -72);
        ctx.lineTo(10, -68);
      }
      ctx.quadraticCurveTo(15.5, -67, 15, -56);
      ctx.lineTo(13.5, -52);
      ctx.lineTo(11, -56.5);
      ctx.lineTo(8.5, -53);
      ctx.lineTo(6, -57.5);
      ctx.lineTo(2, -54.5);
      ctx.lineTo(-1, -58);
      ctx.lineTo(-5, -55);
      ctx.lineTo(-8, -58);
      ctx.lineTo(-10, -52);
    } else {
      // Longer fringe with pointed locks, framing the face
      ctx.moveTo(-14, -44);
      ctx.quadraticCurveTo(-17, -66, 0, -70.5);
      ctx.quadraticCurveTo(15, -70, 16, -56);
      ctx.quadraticCurveTo(16.5, -50, 14.5, -45);
      ctx.lineTo(13, -52);
      ctx.lineTo(11.5, -49.5);
      ctx.lineTo(10, -57);
      ctx.lineTo(7, -51.5);
      ctx.lineTo(4.5, -58);
      ctx.lineTo(1.5, -52.5);
      ctx.lineTo(-1, -58.5);
      ctx.lineTo(-4, -53);
      ctx.lineTo(-7, -58);
      ctx.lineTo(-9.5, -50);
      ctx.lineTo(-10.5, -44);
    }
    ctx.closePath();
    ctx.save();
    outlineFill(look.hair);
    ctx.clip();
    // Darker underside and strand lines
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(-20, -59, 40, 12);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (const sx2 of [-6, -1, 4, 9]) {
      ctx.moveTo(sx2 - 2, -69);
      ctx.quadraticCurveTo(sx2 + 1, -63, sx2, -56);
    }
    ctx.stroke();
    ctx.restore();
    // Glossy "angel ring" highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.6;
    for (const [a0, a1] of [[-2.55, -2.25], [-2.05, -1.6], [-1.4, -1.0]]) {
      ctx.beginPath();
      ctx.arc(1, -58, 10.5, a0, a1);
      ctx.stroke();
    }
    if (style === 'twin' || style === 'pony') {
      ctx.fillStyle = look.pom || look.trim || '#ff6b6b';
      for (const [bx, by] of style === 'twin' ? [[-11, -64], [13, -64]] : [[-10, -63]]) {
        ctx.beginPath();
        ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
        outlineFill(look.pom || look.trim || '#ff6b6b', 0.8);
      }
    }
  }

  function drawHeldProp(look, back, front, phase, up) {
    if (!up) return;
    if (look.prop === 'flag') {
      const [c1, c2] = look.flag;
      ctx.strokeStyle = '#5a4030';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(front[0], front[1] + 4);
      ctx.lineTo(front[0] + 2, front[1] - 22);
      ctx.stroke();
      const f = Math.sin(phase * 3) * 2;
      ctx.beginPath();
      ctx.moveTo(front[0] + 2, front[1] - 22);
      ctx.quadraticCurveTo(front[0] + 10, front[1] - 24 + f, front[0] + 18, front[1] - 21);
      ctx.lineTo(front[0] + 18, front[1] - 11);
      ctx.quadraticCurveTo(front[0] + 10, front[1] - 14 + f, front[0] + 2, front[1] - 12);
      ctx.closePath();
      outlineFill(c1);
      ctx.fillStyle = c2;
      ctx.fillRect(front[0] + 4, front[1] - 18 + f / 2, 12, 2.5);
    } else if (look.prop === 'sign') {
      ctx.strokeStyle = '#7a5a3a';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(back[0], back[1]);
      ctx.lineTo(back[0] + 2, -80);
      ctx.moveTo(front[0], front[1]);
      ctx.lineTo(front[0] - 2, -80);
      ctx.stroke();
      roundRect(back[0] - 6, -96, front[0] - back[0] + 12, 18, 2);
      outlineFill('#fffbe6');
      ctx.font = `900 9px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = look.trim === '#f8f9fa' ? '#c92a2a' : look.trim;
      ctx.fillText(look.sign, (back[0] + front[0]) / 2, -84);
    } else if (look.prop === 'phone') {
      drawPhone(front);
    }
  }

  function drawPhone(p) {
    roundRect(p[0] - 2, p[1] - 9, 6, 10, 1.5);
    outlineFill('#22262b');
    ctx.fillStyle = '#74c0fc';
    ctx.fillRect(p[0] - 1, p[1] - 8, 4, 7);
  }

  function drawMic(p) {
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(p[0], p[1] + 2);
    ctx.lineTo(p[0] + 4, p[1] - 5);
    ctx.stroke();
    ctx.fillStyle = '#d6336c';
    ctx.fillRect(p[0] + 0.5, p[1] - 4, 5, 4);
    ctx.beginPath();
    ctx.arc(p[0] + 5, p[1] - 7, 2.8, 0, Math.PI * 2);
    outlineFill('#555');
  }

  // Shoulder-mounted TV camera, held below the operator's face.
  function drawCamera(phase) {
    roundRect(-2, -42, 26, 12, 3);
    outlineFill('#3a3f46');
    ctx.fillStyle = '#d6336c';
    ctx.fillRect(2, -39, 10, 3);
    roundRect(22, -40.5, 9, 9, 2);
    outlineFill('#1b1d20');
    ctx.fillStyle = '#4dabf7';
    ctx.beginPath();
    ctx.arc(31, -36, 3, -Math.PI / 2, Math.PI / 2);
    ctx.fill();
    ctx.fillStyle = '#22262b';
    ctx.fillRect(4, -46, 12, 4);
    // Recording light
    if (Math.sin(phase * 3) > 0) {
      ctx.fillStyle = '#ff2d2d';
      ctx.beginPath();
      ctx.arc(19, -44, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
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
    for (const c of course.people) {
      c.t += dt;
      c.excited = racers.some((r) => Math.abs(r.x - c.x) < 30 || (r.phase !== 'drive' && Math.abs(r.runX - c.x) < 12));
      const near = Math.abs(player.x - c.x) < 18 && player.phase === 'drive';
      if (c.kind === 'cheer' && !c.said && near) {
        c.said = true;
        bubbles.push({ x: c.x, side: c.side, text: pick(['GO GO!', 'Faster!', 'Ganbatte!', 'You got this!', 'Ding ding!'], Math.random), t: 1.6, color: '#d63384' });
        sfx.cheer();
      } else if (c.kind === 'reporter' && !c.said && (near || (c.x < 0 && state === 'race'))) {
        c.said = true;
        bubbles.push({ x: c.x, side: c.side, text: c.line, t: 2.2, color: '#1864ab' });
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
      if (resultsDelay <= 0) { state = 'results'; resultsShownAt = performance.now(); }
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

  // Soft top light and bottom shade over a body that is already clipped.
  function shadeBody(x, top, w, h, strength = 1) {
    const g = ctx.createLinearGradient(0, top, 0, top + h);
    g.addColorStop(0, `rgba(255,255,255,${0.32 * strength})`);
    g.addColorStop(0.22, 'rgba(255,255,255,0)');
    g.addColorStop(0.75, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${0.28 * strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, top, w, h);
  }

  // Diagonal sky reflections across a pane of glass.
  function glint(x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    const off = ((x * 0.37) % 30 + 30) % 30;
    for (let gx = x - h - off; gx < x + w; gx += 30) {
      ctx.beginPath();
      ctx.moveTo(gx, y + h);
      ctx.lineTo(gx + h, y);
      ctx.lineTo(gx + h + 7, y);
      ctx.lineTo(gx + 7, y + h);
      ctx.fill();
    }
    ctx.restore();
  }

  // Fine speckle texture for asphalt and paving, built once.
  let grit = null;
  function gritPattern() {
    if (grit) return grit;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const rnd = mulberry32(7);
    for (let i = 0; i < 1400; i++) {
      const v = rnd() < 0.5 ? 0 : 255;
      g.fillStyle = `rgba(${v},${v},${v},${0.04 + rnd() * 0.07})`;
      g.fillRect(rnd() * 128, rnd() * 128, 1 + rnd() * 1.5, 1 + rnd() * 1.5);
    }
    grit = ctx.createPattern(c, 'repeat');
    return grit;
  }


  // ---- Scenery ------------------------------------------------------------
  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, BACK_PATH_TOP);
    g.addColorStop(0, '#5b9bd5');
    g.addColorStop(0.7, '#a9d1ee');
    g.addColorStop(1, '#e4eff5');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, BACK_PATH_TOP);
    const sun = ctx.createRadialGradient(820, 40, 4, 820, 40, 260);
    sun.addColorStop(0, 'rgba(255,250,220,0.95)');
    sun.addColorStop(0.08, 'rgba(255,240,190,0.6)');
    sun.addColorStop(1, 'rgba(255,240,190,0)');
    ctx.fillStyle = sun;
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
    // Rendered brick courses and a soft light falloff
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let yy = top + 10; yy < base; yy += 6) ctx.fillRect(x, yy, w, 1);
    const fg = ctx.createLinearGradient(x, 0, x + w, 0);
    fg.addColorStop(0, 'rgba(255,255,255,0.10)');
    fg.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = fg;
    ctx.fillRect(x, top, w, h);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x + w - 2, top, 2, h);
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

  // The street surface (footpaths, asphalt, texture) never changes, so it is
  // painted once into a wide strip and slid along with the camera.
  let streetLayer = null;
  function buildStreetLayer() {
    const c = document.createElement('canvas');
    const w = W + 128;
    c.width = w * DPR;
    c.height = H * DPR;
    const real = ctx;
    ctx = c.getContext('2d');
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const saveCam = camX;
    camX = 0;
    ctx.fillStyle = '#c9c4b8';
    ctx.fillRect(0, BACK_PATH_TOP, w, STREET_TOP - BACK_PATH_TOP);
    ctx.fillStyle = '#9e978a';
    ctx.fillRect(0, STREET_TOP - 4, w, 4);
    const g = ctx.createLinearGradient(0, STREET_TOP, 0, FRONT_PATH_TOP);
    g.addColorStop(0, '#5b5f66');
    g.addColorStop(1, '#474b52');
    ctx.fillStyle = g;
    ctx.fillRect(0, STREET_TOP, w, FRONT_PATH_TOP - STREET_TOP);
    const sh = ctx.createLinearGradient(0, BACK_PATH_TOP, 0, BACK_PATH_TOP + 14);
    sh.addColorStop(0, 'rgba(0,0,0,0.18)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sh;
    ctx.fillRect(0, BACK_PATH_TOP, w, 14);
    ctx.fillStyle = '#d3cec2';
    ctx.fillRect(0, FRONT_PATH_TOP, w, H - FRONT_PATH_TOP);
    ctx.fillStyle = '#a39c8f';
    ctx.fillRect(0, FRONT_PATH_TOP, w, 5);
    ctx.fillStyle = gritPattern();
    ctx.fillRect(0, BACK_PATH_TOP, w, STREET_TOP - 4 - BACK_PATH_TOP);
    ctx.fillRect(0, STREET_TOP, w, FRONT_PATH_TOP - STREET_TOP);
    ctx.fillRect(0, FRONT_PATH_TOP + 5, w, H - FRONT_PATH_TOP - 5);
    camX = saveCam;
    ctx = real;
    return c;
  }

  let vignetteLayer = null;
  function buildVignette() {
    const c = document.createElement('canvas');
    c.width = W * DPR;
    c.height = H * DPR;
    const g2 = c.getContext('2d');
    g2.setTransform(DPR, 0, 0, DPR, 0, 0);
    const vg = g2.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.05);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.28)');
    g2.fillStyle = vg;
    g2.fillRect(0, 0, W, H);
    return c;
  }

  function drawStreet() {
    if (!streetLayer) streetLayer = buildStreetLayer();
    const tex = (((camX * PX) % 128) + 128) % 128;
    ctx.drawImage(streetLayer, 0, BACK_PATH_TOP * DPR, (W + 128) * DPR, (H - BACK_PATH_TOP) * DPR, -tex, BACK_PATH_TOP, W + 128, H - BACK_PATH_TOP);
    // Yellow tram-lane lines
    ctx.fillStyle = '#e6c229';
    const off = ((camX * PX) % 60 + 60) % 60;
    for (let x = -off; x < W; x += 60) {
      ctx.fillRect(x, STREET_TOP + 16, 34, 3);
      ctx.fillRect(x, FRONT_PATH_TOP - 10, 34, 3);
    }
    ctx.fillRect(0, (RAIL_Y[0] + RAIL_Y[1]) / 2 - 22, W, 3);
    // Paving joints
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
    // Panel joints and rivets
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let px2 = x + 24; px2 < x + L - 10; px2 += 21) ctx.fillRect(px2, top + 29, 1, bot - top - 31);
    ctx.fillStyle = 'rgba(255,230,150,0.55)';
    for (let px2 = x + 8; px2 < x + L - 6; px2 += 7) ctx.fillRect(px2, top + 30.5, 1.2, 1.2);
    shadeBody(x, top, L, bot - top);
    ctx.restore();
    // Slatted lifeguard trays under both ends
    for (const lx of [x - 2, x + L - 16]) {
      ctx.fillStyle = '#222';
      ctx.fillRect(lx, bot - 1, 18, 4);
      ctx.fillStyle = '#555';
      for (let k = 0; k < 18; k += 4) ctx.fillRect(lx + k, bot - 1, 2, 4);
    }

    // Windows
    const doorX = x + L - r.door * PX;
    for (let i = 0; i < 10; i++) {
      const wx = x + 14 + i * ((L - 28) / 10);
      if (Math.abs(wx + 7 - doorX) < 22) continue;
      ctx.fillStyle = '#2d3c4a';
      ctx.fillRect(wx, top + 6, 14, 17);
      glint(wx, top + 6, 14, 17);
      ctx.fillStyle = '#efe4c2';
      ctx.fillRect(wx, top + 12, 14, 1.5);
      ctx.strokeStyle = '#8a7a55';
      ctx.lineWidth = 1;
      ctx.strokeRect(wx + 0.5, top + 6.5, 13, 16);
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
      glint(a, top + 8, w, 24);
      shadeBody(a, top, w, bot - top);
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

  function drawNewsVan(v) {
    const L = 6 * PX;
    const x = sx(v.x);
    if (x > W + 40 || x + L < -40) return;
    const base = BACK_FEET - 2;
    const top = base - 46;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(x + L / 2, base + 2, L / 2, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    // Satellite dish and mast
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 22, top);
    ctx.lineTo(x + 22, top - 14);
    ctx.stroke();
    ctx.fillStyle = '#e9ecef';
    ctx.beginPath();
    ctx.ellipse(x + 22, top - 18, 12, 6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#adb5bd';
    ctx.stroke();
    // Body
    ctx.beginPath();
    ctx.moveTo(x, top + 4);
    ctx.lineTo(x + L - 22, top + 4);
    ctx.quadraticCurveTo(x + L - 6, top + 8, x + L - 2, top + 24);
    ctx.lineTo(x + L, base - 8);
    ctx.lineTo(x, base - 8);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, top, 0, base);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(1, '#ced4da');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = '#868e96';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#d6336c';
    ctx.fillRect(x, top + 26, L - 1, 6);
    label('TN7 NEWS', x + 28, top + 22, 11, '#1864ab', 'center', '900');
    ctx.fillStyle = '#26323d';
    ctx.beginPath();
    ctx.moveTo(x + L - 22, top + 9);
    ctx.quadraticCurveTo(x + L - 8, top + 11, x + L - 5, top + 22);
    ctx.lineTo(x + L - 22, top + 22);
    ctx.fill();
    for (const wx of [x + 14, x + L - 16]) {
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath();
      ctx.arc(wx, base - 7, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#adb5bd';
      ctx.beginPath();
      ctx.arc(wx, base - 7, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawPerson(c) {
    const x = sx(c.x);
    if (x < -40 || x > W + 40) return;
    const feet = c.side === 0 ? BACK_FEET : FRONT_FEET;
    const blink = Math.sin(c.t * 1.3 + c.x) > 0.985;
    if (c.kind === 'cheer') {
      const hop = c.excited ? Math.abs(Math.sin(c.t * 7)) * 16 : Math.abs(Math.sin(c.t * 2)) * 2;
      drawChar(x, feet, c.look, { armsUp: c.excited, phase: c.t * 3.5, jump: hop, shout: c.excited, blink });
    } else if (c.kind === 'fan') {
      const prop = c.look.prop;
      const up = c.excited && prop !== 'phone';
      const hop = c.excited ? Math.abs(Math.sin(c.t * 5 + c.x)) * 6 : 0;
      drawChar(x, feet, c.look, { armsUp: up || prop === 'sign', phase: c.t * 3, jump: hop, shout: c.excited && prop !== 'phone', scale: c.scale, blink, pose: prop === 'phone' && c.excited ? 'phone' : null });
    } else if (c.kind === 'camera') {
      drawChar(x, feet, c.look, { flip: c.flip, pose: 'camera', phase: c.t * 3, blink });
    } else {
      drawChar(x, feet, c.look, { flip: c.flip, pose: 'mic', talk: true, phase: c.t * 3, blink });
    }
  }

  function drawCrowd(side) {
    for (const v of course.vans) if (v.side === side) drawNewsVan(v);
    for (const c of course.people) if (c.side === side) drawPerson(c);
    for (const b of bubbles) {
      if (b.side !== side) continue;
      const x = sx(b.x);
      const feet = side === 0 ? BACK_FEET : FRONT_FEET;
      const y = feet - 100 - (1.6 - b.t) * 10;
      ctx.globalAlpha = clamp(b.t * 3, 0, 1);
      ctx.font = `bold 14px ${FONT}`;
      const w = ctx.measureText(b.text).width + 18;
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 6;
      fillRR(x - w / 2, y - 18, w, 24, 10, '#ffffff');
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(x - 4, y + 5);
      ctx.lineTo(x + 6, y + 14);
      ctx.lineTo(x + 6, y + 5);
      ctx.fill();
      label(b.text, x, y - 1, 14, b.color);
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

  // Faint streaks over the street when the player is flying along.
  function drawSpeedLines() {
    const k = clamp((player.v - 14) / 10, 0, 1);
    if (k <= 0 || player.phase !== 'drive') return;
    ctx.strokeStyle = `rgba(255,255,255,${0.18 * k})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 14; i++) {
      const y = STREET_TOP + ((i * 37) % (FRONT_PATH_TOP - STREET_TOP));
      const x = W - ((camX * PX * 1.6 + i * 173) % (W + 200));
      ctx.moveTo(x, y);
      ctx.lineTo(x + 60 + 80 * k, y);
    }
    ctx.stroke();
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
    fillRR(12, 10, 286, 60, 12, 'rgba(15,20,30,0.72)');
    const pos = standingOf(player);
    outlined(pos === 1 ? '1st' : '2nd', 28, 52, 34, pos === 1 ? '#ffd43b' : '#dee2e6', '#000', 'left');
    label('TIME', 110, 30, 11, '#adb5bd', 'left');
    label(fmtTime(player.finished ? player.finishTime : raceTime), 110, 52, 20, '#ffffff', 'left');

    // Centre: progress
    const x0 = 330;
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
    const cx = 254;
    const cy = 60;
    ctx.strokeStyle = '#495057';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, 36, Math.PI, 0);
    ctx.stroke();
    ctx.strokeStyle = '#f03e3e';
    ctx.beginPath();
    ctx.arc(cx, cy, 36, Math.PI + Math.PI * 0.4, Math.PI + Math.PI * 0.4 + 0.07);
    ctx.stroke();
    const sp = player.phase === 'drive' ? kmh(player.v) : 0;
    const ang = Math.PI + Math.PI * clamp(sp / 100, 0, 1);
    ctx.strokeStyle = '#ffd43b';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * 32, cy + Math.sin(ang) * 32);
    ctx.stroke();
    label(String(sp), cx, cy - 8, 15, '#ffffff');
    label('km/h', cx, cy + 4, 8, '#adb5bd');

    // On-screen pedals: big on touch screens, small and faint with a keyboard
    // so they don't hide the crowd on the front footpath.
    const pw = player.phase === 'drive' ? 'POWER' : 'RUN';
    drawPedal('brake', 'BRAKE', '← / A', brakeHeld(), '#c92a2a');
    drawPedal('power', pw, '→ / D', powerHeld(), '#2b8a3e');
  }

  const TOUCH = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  const PEDALS = TOUCH
    ? { brake: [16, H - 78, 160, 66], power: [W - 176, H - 78, 160, 66] }
    : { brake: [12, H - 40, 96, 30], power: [W - 108, H - 40, 96, 30] };

  function drawPedal(name, text, keysText, on, color) {
    const [x, y, w, h] = PEDALS[name];
    ctx.globalAlpha = TOUCH || on ? 1 : 0.6;
    fillRR(x, y, w, h, h / 4, on ? color : 'rgba(15,20,30,0.55)');
    ctx.strokeStyle = on ? '#ffffff' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    roundRect(x, y, w, h, h / 4);
    ctx.stroke();
    if (TOUCH) {
      label(text, x + w / 2, y + 34, 22, '#ffffff', 'center', '900');
      label(name === 'brake' ? 'or hold left side' : 'or hold right side', x + w / 2, y + 54, 12, 'rgba(255,255,255,0.75)');
    } else {
      label(`${text}  ${keysText.split(' / ')[0]}`, x + w / 2, y + 20, 13, '#ffffff', 'center', '900');
    }
    ctx.globalAlpha = 1;
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
    drawCrowd(0);
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
    drawCrowd(1);
    drawRunner(player);
    drawParticles();
    drawSpeedLines();
    if (!vignetteLayer) vignetteLayer = buildVignette();
    ctx.drawImage(vignetteLayer, 0, 0, W, H);

    if (state === 'title') {
      drawPanel('TRAM RACER', [
        { t: 'Melbourne edition: your W class vs the CPU\'s G class', c: '#ffd43b' },
        { t: TOUCH ? 'Hold the right side to run to your tram, it boards by itself' : 'Hold → to run to your tram, it boards by itself' },
        { t: TOUCH ? 'On the tram: hold right side for power, left side to brake' : 'On the tram: hold → for power, ← to brake' },
        { t: 'Over 40 km/h on a curve and you derail' },
        { t: 'Red light at a crossing? Stop, or meet a car' },
        { t: '' },
        { t: TOUCH ? 'Tap to start' : 'Press Enter, Space or tap to start', c: Math.floor(clock * 2.5) % 2 ? '#69db7c' : '#2f9e44', size: 20, w: '900' },
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
        { t: TOUCH ? 'Tap to race again' : 'Press Enter, Space or tap to race again', c: Math.floor(clock * 2.5) % 2 ? '#69db7c' : '#2f9e44', size: 20, w: '900' },
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

  // Pointer input (built for iPhone and iPad): tapping or holding anywhere on
  // the right half of the screen works like →, the left half like ←. The
  // on-screen pedals sit in those halves too. Tap anywhere to start.
  const pointers = new Map();
  let resultsShownAt = 0;
  function sideOf(e) {
    return e.clientX < window.innerWidth / 2 ? 'brake' : 'power';
  }
  function syncTouch() {
    const held = [...pointers.values()];
    touch.power = held.includes('power');
    touch.brake = held.includes('brake');
  }
  const isUi = (e) => e.target && e.target.closest && e.target.closest('a, button');
  window.addEventListener('pointerdown', (e) => {
    if (isUi(e)) return;
    if (e.cancelable) e.preventDefault();
    initAudio();
    if (state === 'title' || (state === 'results' && performance.now() - resultsShownAt > 900)) {
      startCountdown();
      return;
    }
    if (state === 'results') return;
    pointers.set(e.pointerId, sideOf(e));
    syncTouch();
  }, { passive: false });
  // Sliding a finger across the middle switches pedals.
  window.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, sideOf(e));
    syncTouch();
  });
  for (const ev of ['pointerup', 'pointercancel']) {
    window.addEventListener(ev, (e) => {
      pointers.delete(e.pointerId);
      syncTouch();
    });
  }
  window.addEventListener('blur', () => {
    pointers.clear();
    syncTouch();
  });
  // Stop iOS Safari from scrolling, zooming, selecting or popping up the
  // magnifier while you hold the screen.
  for (const ev of ['touchstart', 'touchmove', 'gesturestart', 'dblclick']) {
    document.addEventListener(ev, (e) => { if (!isUi(e) && e.cancelable) e.preventDefault(); }, { passive: false });
  }
  // iOS only unlocks audio from touchend / click.
  document.addEventListener('touchend', () => initAudio(), { passive: true });
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
