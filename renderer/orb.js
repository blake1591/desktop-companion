// ============================================================
// Orb — canvas rendering engine: procedural orb art, mood
// palettes, eye tracking, blinking, sleep mode, particles.
// ============================================================
const Orb = (() => {
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");

  let animTime = 0;
  let currentBounceY = 88;
  let currentMood = "idle";
  let isSleeping = false;
  let isDrowsy = false;
  let wiggleT = 0;
  let accessories = [];
  const VALID_ACCESSORIES = ["headphones", "beanie", "sunglasses"];

  const VALID_MOODS = ["idle", "happy", "sad", "annoyed", "confused", "frustrated", "thinking"];

  // --- Dynamic Eye Pupil Tracking & Recenter Engine ---
  let targetEyeOffsetX = 0;
  let targetEyeOffsetY = 0;
  let eyeOffsetX = 0;
  let eyeOffsetY = 0;
  let lastMouseMoveTime = Date.now();

  // --- Idle glance wandering ---
  let wanderUntil = 0;
  let wanderX = 0;
  let wanderY = 0;

  // --- Procedural Blink Timing Engine ---
  function getRandomBlinkInterval() {
    return Math.floor(Math.random() * 4000) + 4000;
  }
  let isBlinking = false;
  let blinkStartTime = 0;
  let blinkFactor = 1;
  let nextBlinkTime = Date.now() + getRandomBlinkInterval();

  // --- Mood hold / decay ---
  let moodHoldHandle = null;

  // --- Emotion blending: the face cross-fades instead of snapping ---
  let prevMood = "idle";
  let faceBlend = 1; // 1 = fully showing currentMood

  function setMood(mood, holdMs) {
    // Unknown / improvised moods from GLM get mapped to the nearest palette mood
    // (e.g. "cheerful"/"content"/"excited" -> happy; "angry" -> annoyed/frustrated)
    const alias = {
      cheerful: "happy", content: "happy", excited: "happy", joyful: "happy",
      furious: "frustrated", enraged: "annoyed", irritated: "annoyed",
      bored: "idle", tired: "idle", sleepy: "idle", drowsy: "idle",
      playful: "happy", chill: "idle", calm: "idle", relaxed: "idle"
    };
    if (mood && alias[mood.toLowerCase()]) mood = alias[mood.toLowerCase()];
    // Unknown moods fall back to idle
    if (!mood || !VALID_MOODS.includes(mood)) mood = "idle";
    if (mood !== currentMood) {
      prevMood = currentMood;
      faceBlend = 0; // start the cross-fade from the previous face
    }
    currentMood = mood;
    if (moodHoldHandle) { clearTimeout(moodHoldHandle); moodHoldHandle = null; }
    if (holdMs) {
      moodHoldHandle = setTimeout(() => {
        if (isSleeping) return; // decay resumes after wake
        setMood("idle");
        moodHoldHandle = null;
      }, holdMs);
    }
  }

  function getMood() { return currentMood; }

  // ==========================
  // Sleep mode (away from desk)
  // ==========================
  function setSleeping(sleeping) {
    if (sleeping === isSleeping) return;
    isSleeping = sleeping;
    if (sleeping) {
      currentMood = "idle";
      if (moodHoldHandle) { clearTimeout(moodHoldHandle); moodHoldHandle = null; }
      Sfx.playSleep();
    } else {
      Sfx.playWake();
      wiggle(1.1); // wake-up stretch wobble
      // Little greet blink
      isBlinking = true;
      blinkStartTime = Date.now() - 30;
    }
  }

  function isAsleep() { return isSleeping; }

  function setDrowsy(drowsy) {
    isDrowsy = !!drowsy && !isSleeping;
  }

  function getDrowsy() { return isDrowsy; }

  // Squash & stretch wobble (petting, waking, reminders)
  function wiggle(strength = 1) {
    if (wiggleT < strength) wiggleT = strength;
  }

  function setAccessories(list) {
    accessories = (Array.isArray(list) ? list : []).filter(a => VALID_ACCESSORIES.includes(a));
  }

  function getAccessories() {
    return accessories.slice();
  }

  // ==========================
  // Particles (hearts / Zzz)
  // ==========================
  const particles = [];

  function spawnHearts(count = 6) {
    for (let i = 0; i < count; i++) {
      particles.push({
        kind: "heart",
        x: 90 + (Math.random() * 50 - 25),
        y: currentBounceY + 12,
        vx: (Math.random() - 0.5) * 0.8,
        vy: -(0.8 + Math.random() * 0.7),
        size: 11 + Math.random() * 7,
        life: 0,
        maxLife: 1.4 + Math.random() * 0.6
      });
    }
  }

  function spawnZzz() {
    particles.push({
      kind: "zzz",
      x: 90 + 30 + Math.random() * 6,
      y: currentBounceY - 34,
      vx: 0.12 + Math.random() * 0.1,
      vy: -0.22,
      size: 10 + Math.random() * 6,
      life: 0,
      maxLife: 2.6
    });
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += dt;
      if (p.life >= p.maxLife) { particles.splice(i, 1); continue; }
      p.x += p.vx + (p.kind === "heart" ? Math.sin(p.life * 5) * 0.3 : 0);
      p.y += p.vy;
      if (p.kind === "heart") p.vy += 0.012; // gentle gravity so they arc
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const alpha = p.life < p.maxLife * 0.75 ? 1 : 1 - ((p.life - p.maxLife * 0.75) / (p.maxLife * 0.25));
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.font = `${p.size}px "Segoe UI Emoji", "Segoe UI"`;
      ctx.fillText(p.kind === "heart" ? "❤️" : "💤", p.x, p.y);
    }
    ctx.globalAlpha = 1;
  }

  // ==========================================
  // DYNAMIC MOOD GRADIENT PALETTES & LERP
  // ==========================================
  const MOOD_PALETTES = {
    idle: {
      orb0: { r: 97, g: 113, b: 232 },
      orb35: { r: 59, g: 72, b: 173 },
      orb75: { r: 35, g: 39, b: 115 },
      orb100: { r: 23, g: 24, b: 77 },
      halo: { r: 155, g: 101, b: 255 },
      eye: { r: 162, g: 181, b: 255 }
    },
    happy: {
      orb0: { r: 0, g: 242, b: 254 },
      orb35: { r: 0, g: 180, b: 216 },
      orb75: { r: 0, g: 119, b: 182 },
      orb100: { r: 3, g: 4, b: 94 },
      halo: { r: 72, g: 202, b: 228 },
      eye: { r: 144, g: 224, b: 239 }
    },
    sad: {
      orb0: { r: 64, g: 156, b: 255 },
      orb35: { r: 30, g: 90, b: 180 },
      orb75: { r: 15, g: 45, b: 110 },
      orb100: { r: 8, g: 20, b: 60 },
      halo: { r: 60, g: 130, b: 240 },
      eye: { r: 150, g: 200, b: 255 }
    },
    annoyed: {
      orb0: { r: 255, g: 70, b: 70 },
      orb35: { r: 200, g: 30, b: 30 },
      orb75: { r: 120, g: 10, b: 10 },
      orb100: { r: 50, g: 0, b: 0 },
      halo: { r: 255, g: 50, b: 50 },
      eye: { r: 255, g: 140, b: 140 }
    },
    confused: {
      orb0: { r: 255, g: 170, b: 40 },
      orb35: { r: 220, g: 120, b: 20 },
      orb75: { r: 140, g: 60, b: 10 },
      orb100: { r: 60, g: 20, b: 0 },
      halo: { r: 255, g: 150, b: 30 },
      eye: { r: 255, g: 200, b: 120 }
    },
    frustrated: {
      orb0: { r: 255, g: 110, b: 20 },
      orb35: { r: 210, g: 60, b: 10 },
      orb75: { r: 130, g: 30, b: 5 },
      orb100: { r: 50, g: 10, b: 0 },
      halo: { r: 255, g: 90, b: 20 },
      eye: { r: 255, g: 170, b: 100 }
    },
    thinking: {
      orb0: { r: 210, g: 80, b: 255 },
      orb35: { r: 150, g: 40, b: 210 },
      orb75: { r: 90, g: 20, b: 140 },
      orb100: { r: 40, g: 5, b: 70 },
      halo: { r: 200, g: 70, b: 255 },
      eye: { r: 230, g: 160, b: 255 }
    }
  };

  // Pre-computed dimmed "night" palette for sleep mode
  const SLEEP_PALETTE = (() => {
    const base = MOOD_PALETTES.idle;
    const dim = (c, f) => ({ r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f) });
    return {
      orb0: dim(base.orb0, 0.35),
      orb35: dim(base.orb35, 0.35),
      orb75: dim(base.orb75, 0.35),
      orb100: dim(base.orb100, 0.35),
      halo: dim(base.halo, 0.4),
      eye: dim(base.eye, 0.5)
    };
  })();

  let curPalette = JSON.parse(JSON.stringify(MOOD_PALETTES.idle));

  function lerp(start, end, amt) {
    return start + (end - start) * amt;
  }

  function updateMoodColors() {
    const target = isSleeping ? SLEEP_PALETTE : (MOOD_PALETTES[currentMood] || MOOD_PALETTES.idle);
    const speed = 0.06;

    for (let key in target) {
      curPalette[key].r = lerp(curPalette[key].r, target[key].r, speed);
      curPalette[key].g = lerp(curPalette[key].g, target[key].g, speed);
      curPalette[key].b = lerp(curPalette[key].b, target[key].b, speed);
    }
  }

  function toRgbStr(c, alpha = 1) {
    const r = Math.round(c.r), g = Math.round(c.g), b = Math.round(c.b);
    return alpha === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  }

  // --- Cursor Tracking ---
  function updateEyeTrackingTarget(clientX, clientY) {
    const canvasRect = canvas.getBoundingClientRect();
    const relX = clientX - canvasRect.left;
    const relY = clientY - canvasRect.top;

    const dx = relX - 90;
    const dy = relY - currentBounceY;
    const mouseDist = Math.hypot(dx, dy);
    const maxOffset = 5.2;

    if (mouseDist > 0 && mouseDist < 280) {
      const scale = Math.min(mouseDist / 180, 1) * maxOffset;
      targetEyeOffsetX = (dx / mouseDist) * scale;
      targetEyeOffsetY = (dy / mouseDist) * scale;
      lastMouseMoveTime = Date.now();
    } else {
      targetEyeOffsetX = 0;
      targetEyeOffsetY = 0;
      lastMouseMoveTime = Date.now();
    }
  }

  function updateCursor(clientX, clientY) {
    updateEyeTrackingTarget(clientX, clientY);
  }

  function resetEyePosition() {
    targetEyeOffsetX = 0;
    targetEyeOffsetY = 0;
  }

  window.addEventListener("mouseleave", resetEyePosition);
  window.addEventListener("blur", resetEyePosition);

  // --- Idle glance wandering scheduler ---
  function scheduleWander() {
    setTimeout(() => {
      const now = Date.now();
      if (!isSleeping && currentMood === "idle" && now - lastMouseMoveTime > 2500) {
        wanderX = Math.random() * 8 - 4;
        wanderY = Math.random() * 4 - 2;
        wanderUntil = now + 1200 + Math.random() * 900;
      }
      scheduleWander();
    }, 3000 + Math.random() * 5000);
  }
  scheduleWander();

  // --- Petting (double-click) ---
  canvas.addEventListener("dblclick", () => {
    if (isSleeping) return;
    Sfx.init();
    Sfx.playPet();
    wiggle(0.8);
    setMood("happy", 4000);
    spawnHearts();
  });

  // ==========================================
  // Drawing helpers
  // ==========================================
  function drawVisorPill(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawEye(x, y, w, h, mood, eyeColor, blinkVal) {
    const bf = (typeof blinkVal === "number") ? blinkVal : blinkFactor;
    ctx.save();
    const colorStr = toRgbStr(eyeColor);

    const socketX = x;
    const socketY = y;

    const pupilX = socketX + eyeOffsetX;
    const pupilY = socketY + eyeOffsetY;

    const effectiveH = Math.max(1, h * bf);
    const moveDist = Math.hypot(eyeOffsetX, eyeOffsetY);

    if (isSleeping) {
      // Peacefully closed drowsy arcs
      ctx.strokeStyle = colorStr;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(socketX, socketY - 2, w / 2.4, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (bf < 0.15 && mood !== "happy") {
      ctx.strokeStyle = colorStr;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(socketX - w / 1.8, socketY);
      ctx.lineTo(socketX + w / 1.8, socketY);
      ctx.stroke();
      ctx.restore();
      return;
    }

    if (mood === "happy") {
      ctx.strokeStyle = colorStr;
      ctx.lineWidth = 4.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(socketX, socketY + 2, (w / 1.1) * bf, Math.PI, 0);
      ctx.stroke();
    } else if (mood === "annoyed" || mood === "frustrated") {
      ctx.fillStyle = colorStr;
      ctx.beginPath();
      ctx.ellipse(socketX, socketY + 2, w / 1.8, effectiveH / 3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#101124";
      ctx.beginPath();
      ctx.rect(socketX - w, socketY - h, w * 2, h);
      ctx.fill();
    } else if (mood === "confused") {
      const eyeH = x < 90 ? effectiveH / 1.8 : effectiveH / 3;
      ctx.fillStyle = colorStr;
      ctx.beginPath();
      ctx.ellipse(socketX, socketY + 1, w / 2, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (mood === "sad") {
      ctx.fillStyle = colorStr;
      ctx.beginPath();
      ctx.ellipse(socketX, socketY + 3, w / 1.8, effectiveH / 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      if (bf > 0.5) {
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(pupilX + 2, pupilY + 1, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // --- 1. Base Crisp Eye Socket ---
      ctx.fillStyle = colorStr;
      ctx.beginPath();
      ctx.ellipse(socketX, socketY, w / 2, effectiveH / 2, 0, 0, Math.PI * 2);
      ctx.fill();

      // --- 2. Clip Everything inside Socket Boundary ---
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(socketX, socketY, w / 2, effectiveH / 2, 0, 0, Math.PI * 2);
      ctx.clip();

      // --- 3. Darker Pupil Core for High Contrast ---
      ctx.fillStyle = "rgba(10, 12, 28, 0.45)";
      ctx.beginPath();
      ctx.ellipse(pupilX, pupilY, w / 2.8, effectiveH / 2.8, 0, 0, Math.PI * 2);
      ctx.fill();

      // --- 4. Single Clean Dynamic Specular Highlight ---
      if (bf > 0.35) {
        const glareX = pupilX + (eyeOffsetX * 0.25) + 2.0;
        const glareY = pupilY + (eyeOffsetY * 0.25) - 3.0;
        const glareRadius = (1.8 + Math.min(moveDist / 2.5, 1.2)) * bf;

        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(glareX, glareY, glareRadius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.beginPath();
        ctx.ellipse(pupilX - 1.5, pupilY + 3.0, 2.5, 1.2, -0.2, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore(); // Release eye clipping mask
    }
    ctx.restore();
  }

  // --- Zzz spawner for sleep mode ---
  let lastZzzSpawn = 0;

  // --- Wardrobe: accessories drawn over the orb ---
  function drawAccessories(cx, cy) {
    // Beanie — knit cap sitting on top of the orb
    if (accessories.includes("beanie")) {
      ctx.fillStyle = "#3d2f73";
      ctx.beginPath();
      ctx.ellipse(cx, cy - 30, 40, 24, 0, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = "#5446a8";
      drawVisorPill(cx - 40, cy - 33, 80, 13, 6);
      ctx.fill();
      ctx.fillStyle = "#cfc7ff";
      ctx.beginPath();
      ctx.arc(cx, cy - 51, 6.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Headphones — band over the top + glowing ear pads
    if (accessories.includes("headphones")) {
      ctx.strokeStyle = "#16162c";
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(cx, cy - 4, 47, Math.PI * 1.08, Math.PI * 1.92);
      ctx.stroke();
      for (const side of [-1, 1]) {
        ctx.fillStyle = "#16162c";
        ctx.beginPath();
        ctx.ellipse(cx + side * 46, cy - 4, 8, 12, side * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = toRgbStr(curPalette.halo, 0.7);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cx + side * 46, cy - 4, 8, 12, side * 0.18, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Sunglasses — dark shades over the eyes
    if (accessories.includes("sunglasses")) {
      ctx.fillStyle = "#0a0a14";
      drawVisorPill(cx - 27, cy - 11, 54, 15, 7);
      ctx.fill();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.16)";
      ctx.lineWidth = 1.5;
      drawVisorPill(cx - 27, cy - 11, 54, 15, 7);
      ctx.stroke();
      ctx.fillStyle = "#0a0a14";
      ctx.fillRect(cx - 2, cy - 9, 4, 4);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + 6, cy - 6);
      ctx.lineTo(cx + 14, cy + 1);
      ctx.stroke();
    }
  }

  // Expressive mouth shapes, one branch per mood (used by the cross-fade)
  function drawMouth(cx, cy, mood, offsetX, offsetY) {
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    if (isSleeping) {
      // Tiny content closed mouth during sleep mode
      ctx.moveTo(cx - 3 + offsetX, cy + 12 + offsetY);
      ctx.lineTo(cx + 3 + offsetX, cy + 12 + offsetY);
    } else if (mood === "sad") {
      ctx.arc(cx + offsetX, cy + 14 + offsetY, 7, Math.PI + 0.3, -0.3);
    } else if (mood === "annoyed" || mood === "frustrated") {
      ctx.moveTo(cx - 6 + offsetX, cy + 11 + offsetY);
      ctx.lineTo(cx + 6 + offsetX, cy + 11 + offsetY);
    } else if (mood === "confused") {
      ctx.moveTo(cx - 6 + offsetX, cy + 11 + offsetY);
      ctx.quadraticCurveTo(cx - 2 + offsetX, cy + 7 + offsetY, cx + offsetX, cy + 11 + offsetY);
      ctx.quadraticCurveTo(cx + 2 + offsetX, cy + 15 + offsetY, cx + 6 + offsetX, cy + 11 + offsetY);
    } else {
      // idle / thinking / happy default soft smile
      ctx.arc(cx + offsetX, cy + 8 + offsetY, 8, 0.2, Math.PI - 0.2);
    }
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    const nowFrame = Date.now();
    const dt = Math.min((nowFrame - (render.lastFrame || nowFrame)) / 1000, 0.05);
    render.lastFrame = nowFrame;

    animTime += 0.03;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Global Screen Cursor Check (only when active movement occurred recently)
    let electronScreen = null;
    try { electronScreen = require("electron").screen; } catch (e) {}

    if (wanderUntil > nowFrame) {
      targetEyeOffsetX = wanderX;
      targetEyeOffsetY = wanderY;
    } else if (electronScreen && nowFrame - lastMouseMoveTime < 1800) {
      const globalPoint = electronScreen.getCursorScreenPoint();
      const canvasRect = canvas.getBoundingClientRect();
      const orbScreenX = window.screenX + canvasRect.left;
      const orbScreenY = window.screenY + canvasRect.top;
      updateEyeTrackingTarget(globalPoint.x - orbScreenX, globalPoint.y - orbScreenY);
    } else if (nowFrame - lastMouseMoveTime >= 1800) {
      targetEyeOffsetX = 0;
      targetEyeOffsetY = 0;
    }

    // Smooth eye offset lerp back to exact center (0,0)
    eyeOffsetX = lerp(eyeOffsetX, targetEyeOffsetX, 0.12);
    eyeOffsetY = lerp(eyeOffsetY, targetEyeOffsetY, 0.12);

    // Procedural Blink Machine (skip blinking while asleep — eyes stay closed)
    if (!isSleeping) {
      if (nowFrame > nextBlinkTime && !isBlinking) {
        isBlinking = true;
        blinkStartTime = nowFrame;
      }

      if (isBlinking) {
        const elapsed = nowFrame - blinkStartTime;
        const blinkDuration = 180;
        if (elapsed < blinkDuration / 2) {
          blinkFactor = 1 - (elapsed / (blinkDuration / 2));
        } else if (elapsed < blinkDuration) {
          blinkFactor = (elapsed - (blinkDuration / 2)) / (blinkDuration / 2);
        } else {
          blinkFactor = 1;
          isBlinking = false;
          nextBlinkTime = nowFrame + getRandomBlinkInterval();
        }
      } else {
        blinkFactor = 1;
      }
    } else {
      blinkFactor = 0; // eyes fully closed
    }

    // Emotion blending: advance the face cross-fade (~280ms at 60fps)
    if (faceBlend < 1) faceBlend = Math.min(1, faceBlend + 0.055);

    updateMoodColors();

    // Sleep Zzz spawner
    if (isSleeping && nowFrame - lastZzzSpawn > 900) {
      lastZzzSpawn = nowFrame;
      spawnZzz();
    }

    updateParticles(dt);
    drawParticles();
    if (wiggleT > 0) wiggleT = Math.max(0, wiggleT - dt * 1.3);

    // Slow, shallow breathing when asleep; heavy sway when drowsy
    const bounceSpeed = isSleeping ? 0.7 : (isDrowsy ? 1.1 : 2);
    const bounceAmp = isSleeping ? 1.5 : (isDrowsy ? 2.5 : 4);
    const bounce = Math.sin(animTime * bounceSpeed) * bounceAmp;
    currentBounceY = 88 + bounce;
    const cx = 90, cy = currentBounceY;

    // 1. Floor Drop Shadow
    const shadowScale = 1 - (bounce / 25);
    ctx.fillStyle = "rgba(12, 10, 28, 0.45)";
    ctx.beginPath();
    ctx.ellipse(cx, 162, 38 * shadowScale, 7 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fill();

    // Squash & stretch wobble wrapper (petting / waking)
    let wobbling = false;
    if (wiggleT > 0) {
      const wob = Math.sin(animTime * 16) * 0.09 * wiggleT;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1 + wob, 1 - wob);
      ctx.translate(-cx, -cy);
      wobbling = true;
    }

    // 2. Outer Halo Glow Aura
    ctx.save();
    const haloGlow = ctx.createRadialGradient(cx, cy, 48, cx, cy, 68);
    haloGlow.addColorStop(0, toRgbStr(curPalette.halo, 0.35));
    haloGlow.addColorStop(0.7, toRgbStr(curPalette.halo, 0.12));
    haloGlow.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = haloGlow;
    ctx.beginPath();
    ctx.arc(cx, cy, 68, 0, Math.PI * 2);
    ctx.fill();

    // Outer ring highlight line
    ctx.strokeStyle = toRgbStr(curPalette.halo, 0.5);
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 57, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 3. Main Glass Orb Body
    const orbGrad = ctx.createRadialGradient(cx - 16, cy - 18, 6, cx, cy, 55);
    orbGrad.addColorStop(0, toRgbStr(curPalette.orb0));
    orbGrad.addColorStop(0.35, toRgbStr(curPalette.orb35));
    orbGrad.addColorStop(0.75, toRgbStr(curPalette.orb75));
    orbGrad.addColorStop(1, toRgbStr(curPalette.orb100));

    ctx.fillStyle = orbGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 54, 0, Math.PI * 2);
    ctx.fill();

    // Inner glass rim highlight
    ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 53, 0, Math.PI * 2);
    ctx.stroke();

    // 4. Visor Pill Screen
    const vw = 82, vh = 42, vx = cx - vw / 2, vy = cy - vh / 2 + 1;
    ctx.fillStyle = "#101124";
    ctx.strokeStyle = toRgbStr(curPalette.halo, 0.3);
    ctx.lineWidth = 1.8;
    drawVisorPill(vx, vy, vw, vh, 17);
    ctx.fill();
    ctx.stroke();

    // 5. Pink Cheek Blush Spots
    ctx.fillStyle = isSleeping ? "rgba(225, 85, 120, 0.4)" : "rgba(225, 85, 120, 0.8)";
    ctx.beginPath();
    ctx.ellipse(cx - 24 + eyeOffsetX * 0.25, cy + 10 + eyeOffsetY * 0.25, 8, 4.5, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 24 + eyeOffsetX * 0.25, cy + 10 + eyeOffsetY * 0.25, 8, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // 6. Glowing Eyes with Dynamic Glare System
    // Drowsiness clamps the lids to a sleepy half-closed floor
    const effBlink = isSleeping ? 0 : (isDrowsy ? Math.min(blinkFactor, 0.42) : blinkFactor);
    const eyeLX = cx - 17, eyeRX = cx + 17, eyeY = cy - 3;
    if (faceBlend < 1 && prevMood !== currentMood) {
      // Cross-fade between the outgoing and incoming facial expressions
      ctx.globalAlpha = 1 - faceBlend;
      drawEye(eyeLX, eyeY, 14, 18, prevMood, curPalette.eye, effBlink);
      drawEye(eyeRX, eyeY, 14, 18, prevMood, curPalette.eye, effBlink);
      ctx.globalAlpha = faceBlend;
      drawEye(eyeLX, eyeY, 14, 18, currentMood, curPalette.eye, effBlink);
      drawEye(eyeRX, eyeY, 14, 18, currentMood, curPalette.eye, effBlink);
      ctx.globalAlpha = 1;
    } else {
      drawEye(eyeLX, eyeY, 14, 18, currentMood, curPalette.eye, effBlink);
      drawEye(eyeRX, eyeY, 14, 18, currentMood, curPalette.eye, effBlink);
    }

    // 7. Mouth — cross-faded the same way as the eyes
    const mouthOffsetX = eyeOffsetX * 0.25;
    const mouthOffsetY = eyeOffsetY * 0.25;
    if (faceBlend < 1 && prevMood !== currentMood) {
      ctx.save();
      ctx.globalAlpha = 1 - faceBlend;
      drawMouth(cx, cy, prevMood, mouthOffsetX, mouthOffsetY);
      ctx.globalAlpha = faceBlend;
      drawMouth(cx, cy, currentMood, mouthOffsetX, mouthOffsetY);
      ctx.restore();
    } else {
      drawMouth(cx, cy, currentMood, mouthOffsetX, mouthOffsetY);
    }

    // 8. Top-Left Glass Specular Gloss Shine (Anchored Shell Reflection)
    ctx.save();
    ctx.translate(cx - 16, cy - 28);
    ctx.rotate(-0.45);
    const glossGrad = ctx.createLinearGradient(0, 0, 0, 14);
    glossGrad.addColorStop(0, "rgba(255, 255, 255, 0.75)");
    glossGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glossGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 9. Accessories (drawn last so they sit on top of everything)
    drawAccessories(cx, cy);

    // Close the wobble squash & stretch transform
    if (wobbling) ctx.restore();

    requestAnimationFrame(render);
  }

  // Speech-bubble accent color is read by the UI
  function getHaloColor() { return curPalette.halo; }
  function toHaloStr(alpha) { return toRgbStr(curPalette.halo, alpha); }
  function toEyeStr(alpha) { return toRgbStr(curPalette.eye, alpha); }

  function init() {
    render();
  }

  return {
    init,
    setMood,
    getMood,
    setSleeping,
    setDrowsy,
    isAsleep,
    wiggle,
    spawnHearts,
    toEyeStr,
    updateCursor,
    setAccessories,
    getAccessories,
    getBounceY: () => currentBounceY,
    getHaloColor,
    toHaloStr,
    canvas
  };
})();
