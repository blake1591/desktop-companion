// ============================================================
// Sfx — procedural Web Audio synth engine (mood blips, pets, chimes)
// ============================================================
const Sfx = (() => {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function init() {
    if (!AudioCtx) return;
    if (!audioCtx) audioCtx = new AudioCtx();
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  function ready() { return !!audioCtx; }

  function blip({ type = "sine", from = 400, to = null, duration = 0.05, volume = 0.05, curve = "exponential" }) {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    osc.type = type;
    osc.frequency.setValueAtTime(from, now);
    if (to !== null) {
      if (curve === "exponential") osc.frequency.exponentialRampToValueAtTime(to, now + duration);
      else osc.frequency.linearRampToValueAtTime(to, now + duration);
    }
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.start(now);
    osc.stop(now + duration);
  }

  function playMood(mood) {
    if (!audioCtx) return;
    switch (mood) {
      case "happy":
        blip({ type: "triangle", from: 450 + Math.random() * 200, to: 750 + Math.random() * 150, duration: 0.05, volume: 0.07 });
        break;
      case "sad":
        blip({ type: "sine", from: 200, to: 130, duration: 0.08, volume: 0.07, curve: "linear" });
        break;
      case "annoyed":
      case "frustrated":
        blip({ type: "sawtooth", from: 110 + Math.random() * 20, duration: 0.04, volume: 0.05 });
        break;
      case "confused":
        blip({ type: "sine", from: 320, to: 480, duration: 0.06, volume: 0.05 });
        break;
      default:
        blip({ type: "sine", from: 380 + Math.random() * 50, duration: 0.04, volume: 0.04 });
        break;
    }
  }

  function playPet() {
    // Quick rising double-blip when the user pets Ellie
    blip({ type: "triangle", from: 520, to: 780, duration: 0.06, volume: 0.06 });
    if (audioCtx) {
      setTimeout(() => blip({ type: "triangle", from: 700, to: 980, duration: 0.07, volume: 0.05 }), 90);
    }
  }

  function playChime() {
    // Reminder / timer two-tone ding
    blip({ type: "sine", from: 880, duration: 0.12, volume: 0.07 });
    if (audioCtx) {
      setTimeout(() => blip({ type: "sine", from: 1174, duration: 0.2, volume: 0.06 }), 140);
    }
  }

  function playSleep() {
    blip({ type: "sine", from: 300, to: 180, duration: 0.3, volume: 0.04, curve: "linear" });
  }

  function playWake() {
    blip({ type: "triangle", from: 300, to: 600, duration: 0.12, volume: 0.05 });
  }

  return { init, ready, playMood, playPet, playChime, playSleep, playWake };
})();
