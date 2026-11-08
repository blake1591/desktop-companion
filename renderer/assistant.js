// ============================================================
// Assistant — persistent reminders, pomodoro mode, idle chatter,
// sleep/drowsiness watcher (with battery awareness), and the
// speech-output (TTS) bridge.
// ============================================================
const Assistant = (() => {
  const { ipcRenderer } = require("electron");

  // --------------------------
  // Speech output (TTS)
  // --------------------------
  function speakReply(text) {
    if (!Config.get().voiceEnabled) return;
    if (!text || typeof text !== "string") return;
    const clean = String(text)
      .replace(/[*_`#>|]/g, " ")
      .replace(/[^\x20-\x7E]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (clean) ipcRenderer.send("speak", clean);
  }

  // --------------------------
  // Battery monitoring
  // --------------------------
  let lastBatteryPct = null;

  async function refreshBattery() {
    if (!navigator.getBattery) {
      lastBatteryPct = null;
      return;
    }
    try {
      const battery = await navigator.getBattery();
      lastBatteryPct = Math.round(battery.level * 100);
      return battery;
    } catch (e) {
      lastBatteryPct = null;
      return null;
    }
  }

  function getBatteryPct() {
    return lastBatteryPct;
  }

  function formatBattery() {
    return lastBatteryPct !== null ? `${lastBatteryPct}%` : "unknown";
  }

  // --------------------------
  // Pomodoro state machine
  // --------------------------
  const WORK_SECONDS = 25 * 60;
  const BREAK_SECONDS = 5 * 60;

  let pomodoro = null; // { phase, cycle, remaining, timer }

  function startPomodoro(note) {
    if (pomodoro) return false;
    pomodoro = {
      phase: "work",
      cycle: 1,
      remaining: WORK_SECONDS,
      note: note || "",
      timer: setInterval(tickPomodoro, 1000)
    };
    const topic = pomodoro.note ? ` on the topic of "${pomodoro.note}"` : "";
    UI.say(`pomodoro started${topic} — 25 minutes of focus. i'll keep the cycle going until you tell me to stop.`, { mood: "thinking" });
    return true;
  }

  function stopPomodoro(silent = false) {
    if (!pomodoro) return false;
    clearInterval(pomodoro.timer);
    pomodoro = null;
    if (!silent) {
      UI.say("fine, stopping the pomodoro. if you're burned out, we can pick up where you left off later.", { mood: "sad", holdMs: 6000 });
    }
    return true;
  }

  function isPomodoroRunning() {
    return !!pomodoro;
  }

  function formatClock(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function tickPomodoro() {
    if (!pomodoro) return;
    pomodoro.remaining--;

    if (pomodoro.phase === "work") {
      if (pomodoro.remaining === 300) {
        UI.say(`five minutes left in this focus block.`, { mood: "thinking", holdMs: 6000 });
      } else if (pomodoro.remaining === 60) {
        UI.say(`one minute left in the focus block.`, { mood: "thinking", holdMs: 6000 });
      }
    }

    if (pomodoro.remaining > 0) return;

    if (pomodoro.phase === "work") {
      pomodoro.phase = "break";
      pomodoro.remaining = BREAK_SECONDS;
      Sfx.playChime();
      UI.say(`focus block ${pomodoro.cycle} survived. short break for 5 minutes. look away from the screen for a bit.`, { mood: "happy", holdMs: 8000, speak: true });
    } else {
      pomodoro.cycle++;
      pomodoro.phase = "work";
      pomodoro.remaining = WORK_SECONDS;
      Sfx.playChime();
      Orb.setMood("thinking", 8000);
      UI.say(`break's over — starting focus block ${pomodoro.cycle}. lock in.`, { mood: "thinking", holdMs: 8000, speak: true });
    }
  }

  function getPomodoroStatus() {
    if (!pomodoro) return null;
    return `cycle ${pomodoro.cycle}, ${pomodoro.phase === "work" ? "focus" : "break"} phase, ${formatClock(pomodoro.remaining)} remaining`;
  }

  // --------------------------
  // Persistent reminders / timers
  // --------------------------
  function scheduleReminder({ delaySeconds = 600, note = "something", kind = "reminder" } = {}) {
    return ipcRenderer.invoke("schedule-reminder", { delaySeconds, note, kind });
  }

  function formatDelay(delaySeconds) {
    const mins = Math.round(delaySeconds / 60);
    if (mins < 1) return `${delaySeconds} second(s)`;
    if (mins >= 60) {
      const hours = mins / 60;
      return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour(s)`;
    }
    return `${mins} minute(s)`;
  }

  async function handleAction(action, ctx = {}) {
    if (!action || typeof action !== "object") return;

    // Panel actions get a deterministic sanity gate: the model sometimes
    // re-fires them from OLD user messages sitting in the conversation
    // history ("what do you remember" seen again three turns later). If
    // the CURRENT message doesn't read like a panel request at all, the
    // action is dropped — her spoken reply still goes out untouched.
    const PANEL_GATES = {
      memory: /(memor|remember|forgot|forget|recall|know about (?:me|my|us)|saved about (?:me|my)|memory book|\bbook\b)/i,
      settings: /(setting|config|prefer|option|voice|tts|speak|provider|api key|\bkey\b|model|hotkey|summon|chatter|talkativ|computer control|toggle|enable|disable|switch (?:to|it)|turn (?:on|off))/i,
      // Exit has no panel — the gate just mirrors what the user text must
      // read like for "quit yourself" to be real ("goodnight, go to bed,
      // leave me alone, exit"). Kept out of stray re-fires from history.
      exit: /(\bexit\b|\bquits?\b|quitting|good\s?night|goodnight|go to bed|going to bed|go to sleep|going to sleep|leave me alone|goodbye ellie|bye ellie|see you (?:later|tomorrow)|i'm out|heading (?:out|to bed)|take a nap|shut yourself|close yourself)/i,
      // Search is her honesty tool — it fires both when she admits not
      // knowing and when the user asked for a lookup. Loose gate: real
      // questions almost always contain a question word or a lookup verb.
      search: /(search|look\s?up|google|find\s?out|who|what|when|where|why|how|which|news|weather|price|cost|version|latest|current|today|\bwiki\b|\breddit\b)/i
    };
    const gate = PANEL_GATES[action.type];
    if (gate && typeof ctx.userText === "string" && ctx.userText.trim()) {
      if (!gate.test(ctx.userText)) {
        console.log(`[actions] dropped model "${action.type}" — current message has no panel intent`);
        return;
      }
    }

    if (action.type === "reminder" || action.type === "timer") {
      const secs = Math.round((Number(action.delay_minutes) || 10) * 60);
      const pretty = formatDelay(secs);
      await scheduleReminder({ delaySeconds: secs, note: action.note || "something", kind: action.type });
      const shown = action.note && String(action.note).trim() ? `"${String(action.note).trim()}"` : "your timer";
      UI.say(`scheduled. i'll ping you about ${shown} in ${pretty}.`, { mood: "idle", holdMs: 7000, speak: true });
      return;
    }

    if (action.type === "pomodoro") {
      if (action.stop) {
        stopPomodoro();
      } else if (isPomodoroRunning()) {
        UI.say(`we already have a pomodoro going — ${getPomodoroStatus()}. say 'stop pomodoro' if you want it off.`, { mood: "confused", holdMs: 7000 });
      } else {
        startPomodoro(typeof action.note === "string" ? action.note : "");
      }
      return;
    }

    // Ellie can ask to see the screen herself (privacy: only when the user asked)
    if (action.type === "screenshot") {
      await UI.lookAtScreen();
      return;
    }

    // Natural phrasing → panels, no exact words needed from the user
    if (action.type === "memory") {
      UI.openMemoryPanel();
      return;
    }
    if (action.type === "settings") {
      UI.openSettingsPanel();
      return;
    }

    // Use the PC as her own hands — gated on the settings toggle only.
    // Images ride to whatever chat model is configured (most current ones
    // see fine); a vision model in settings is just an optional override.
    if (action.type === "computer") {
      const cfg = Config.get();
      const goal = String(action.goal || action.text || "").trim();
      if (!cfg.pcControl) {
        UI.say("i can drive the pc for you — turn it on in settings first (computer control).", { mood: "confused", holdMs: 9000 });
        return;
      }
      if (!goal) {
        UI.say("i'll take over — what's the goal again, exactly?", { mood: "confused", holdMs: 8000 });
        return;
      }
      UI.say("taking over. watch the little bubble — that's me narrating every move.", { mood: "happy", holdMs: 7000, speak: true });
      startComputerTask(goal);
      return;
    }

    // Her curiosity escape hatch — she goes and looks it up for real
    // (orchestration lives in UI.runWebSearch, where runChat is).
    if (action.type === "search") {
      const query = String(action.query || action.text || "").trim();
      if (!query) {
        UI.say("search for what, exactly?", { mood: "confused", holdMs: 6000, speak: true });
        return;
      }
      UI.runWebSearch(query);
      return;
    }

    // She calls it a night herself — mid-task gets a polite refusal
    // (both handled inside exitNow; the deterministic "goodnight"
    // command lands here too).
    if (action.type === "exit") {
      exitNow();
      return;
    }
  }

  function exitNow() {
    if (pcTask) {
      UI.say("can't leave yet — i'm still on a task. say 'stop' first and then i'll go.", { mood: "confused", holdMs: 8000, speak: true });
      return;
    }
    const farewells = [
      "alright... goodnight. i'll be here when you're back. 🖤",
      "fine, i'll disappear. don't forget me in the morning.",
      "going under. the taskbar makes a good blanket.",
      "okay, leaving you alone... probably off listening to sad music somewhere.",
      "bye for now. the desktop's yours."
    ];
    UI.say(farewells[Math.floor(Math.random() * farewells.length)], { mood: "idle", holdMs: 3500, speak: true });
    setTimeout(() => {
      ipcRenderer.invoke("app:exit").catch(() => {});
    }, 3400);
  }

  async function listRemindersText() {
    try {
      const items = await ipcRenderer.invoke("reminders:list");
      if (!items || items.length === 0) {
        return "no pending reminders or timers. honestly, kind of peaceful.";
      }
      const now = Date.now();
      const lines = items.map(r => {
        const mins = Math.max(1, Math.round((r.at - now) / 60000));
        const when = mins >= 60 ? `${(mins / 60).toFixed(mins % 60 === 0 ? 0 : 1)}h` : `${mins} min`;
        return `• in ${when} — ${r.note} (${r.kind})`;
      });
      return `pending:\n${lines.join("\n")}`;
    } catch (e) {
      return "couldn't read the reminder list from the system.";
    }
  }

  async function cancelAllRemindersText() {
    try {
      const { cancelled } = await ipcRenderer.invoke("reminders:cancel");
      return cancelled > 0
        ? `cleared ${cancelled} pending reminder(s). your schedule is a blank slate now.`
        : "nothing to cancel — no pending reminders anyway.";
    } catch (e) {
      return "couldn't reach the reminder list.";
    }
  }

  function onReminderFired({ note, kind } = {}) {
    Sfx.playChime();
    Orb.setMood("confused", 8000);
    UI.say(`⏰ ${note || (kind === "timer" ? "timer finished." : "reminder.")}`, { mood: "confused", speak: true });
  }

  // --------------------------
  // Drowsiness / sleep watcher — system idle plus an optional fixed
  // bedtime schedule. Bedtime puts her down and tucks her under the
  // taskbar; wake time earns exactly one morning greeting per night.
  // --------------------------
  let lastKnownIdle = 0;
  let sleptLastNight = false;

  function parseClock(str, def) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
    if (!m) return def;
    return Math.min(23, Math.max(0, parseInt(m[1], 10))) * 60 + Math.min(59, Math.max(0, parseInt(m[2], 10)));
  }

  // {bed, wake} while inside the sleep window, null otherwise.
  // "23:30" → "07:30" wraps midnight; bed === wake disables itself.
  function sleepWindow() {
    const sched = Config.get().sleepSchedule;
    if (!sched || !sched.enabled) return null;
    const bed = parseClock(sched.bedtime, 23 * 60 + 30);
    const wake = parseClock(sched.wakeTime, 7 * 60 + 30);
    if (bed === wake) return null;
    const d = new Date();
    const now = d.getHours() * 60 + d.getMinutes();
    const inside = bed < wake ? now >= bed && now < wake : now >= bed || now < wake;
    return inside ? { bed, wake } : null;
  }

  async function pollIdleForSleep() {
    try {
      const sysContext = await ipcRenderer.invoke("get-system-context");
      lastKnownIdle = sysContext.idleSeconds || 0;
      await refreshBattery();

      const night = sleepWindow();
      if (night) {
        if (!sleptLastNight && !Globals.isBusy()) {
          sleptLastNight = true;
          if (!Orb.isAsleep()) {
            UI.say("it's my bedtime... tucking in. wake me if the world ends.", { mood: "idle", holdMs: 6000 });
          }
          window.dispatchEvent(new Event("ellie:bedtime"));
        }
      } else if (sleptLastNight) {
        sleptLastNight = false;
        if (Orb.isAsleep()) {
          Orb.setSleeping(false);
          UI.say("mmh... morning. i'm not a morning person, but i'm here.", { mood: "idle", holdMs: 7000 });
          window.dispatchEvent(new Event("ellie:wake"));
        }
      }

      const asleep = lastKnownIdle >= 480 || !!night;
      const drowsy = !asleep && (lastKnownIdle >= 240 || (lastBatteryPct !== null && lastBatteryPct <= 15));
      Orb.setSleeping(asleep);
      Orb.setDrowsy(drowsy);
    } catch (e) {}
  }

  function wakeIfAsleep() {
    if (Orb.isAsleep()) {
      Orb.setSleeping(false);
      UI.say("...huh? i wasn't sleeping. i was thinking with my eyes closed.", { mood: "confused", holdMs: 5000 });
    }
  }

  // --- Seasonal / event awareness (friday energy, holidays...) ---
  function seasonalLines() {
    const d = new Date();
    const m = d.getMonth() + 1;   // 1-12
    const day = d.getDate();
    const wd = d.getDay();        // 0 sunday ... 5 friday, 1 monday
    const hr = d.getHours();
    const out = [];

    if (m === 10 && day === 31) out.push("it's halloween today. peak spooky, peak emo season.");
    else if (m === 10 && day >= 26) out.push("halloween is basically here. spookiest week of the year.");
    if (m === 11 && day >= 20) out.push("the holiday season is creeping in.");
    if (m === 12 && day >= 20 && day <= 26) out.push("holiday haze. nobody knows what day it is, including me.");
    if (m === 1 && day <= 3) out.push("new year, same vibes. pretending to be transformed.");
    if (m === 2 && day === 14) out.push("valentine's day. at least we have each other.");
    if (wd === 5 && hr >= 12) out.push("friday afternoon energy. rare drop. protect it.");
    else if (wd === 1 && hr <= 11) out.push("monday morning. honoring the grief.");
    return out;
  }

  function seasonalSuffix() {
    const lines = seasonalLines();
    return (lines.length && Math.random() < 0.7) ? ` btw — ${lines[0]}` : "";
  }

  // --------------------------
  // Autonomous idle chatter loop
  // --------------------------
  let lastMediaKey = "";

  async function triggerAutonomousIdleCheck() {
    if (Orb.isAsleep() || Globals.isBusy()) {
      scheduleNextIdleCheck();
      return;
    }

    try {
      const sysContext = await ipcRenderer.invoke("get-system-context");
      await refreshBattery();

    // Now-playing awareness: remember the current track so she notices
    // the moment it changes — that's her cue to have an opinion about it
    const media = sysContext.nowPlaying || null;
    const mediaKey = media ? `${media.app}|${media.title}` : "";
    const mediaChanged = !!media && mediaKey !== lastMediaKey;
    if (media) lastMediaKey = mediaKey;

    // Earn her voice honestly: each idle check is a coin flip between
    // a spoken comment (speech bubble) and a quiet aside (thought bubble)
    const isThought = Math.random() < 0.45;
    const season = seasonalLines().join("; ");
    const idlePrompt = `[AUTONOMOUS IDLE CHECK: Time=${sysContext.time}, Active App=${sysContext.activeApp} (window: "${sysContext.activeWindow}"), System Idle=${sysContext.idleSeconds}s, RAM Usage=${sysContext.ramUsagePercent}%, CPU Load=${sysContext.cpuPercent}%, Battery=${formatBattery()}, Now Playing=${media ? `${media.app} — "${media.title}"` : "nothing"}]
[SEASON: ${season || "normal"}]${mediaChanged ? `\n[NOTE: "${media.title}" just started playing — if you have a reaction to it, this is the moment.]` : ""}
[MODE: ${isThought ? "THOUGHT — a quiet aside to yourself, observing whatever you notice (even what's on screen). Do NOT address the user. Just think aloud briefly, 1 sentence." : "SPEECH — talking aloud to the user naturally, 1-2 sentences."}]
Task: If something noteworthy is happening, one brief remark matching the MODE above. If nothing noteworthy: reply strictly with {"mood":"idle","text":"SKIP"}`;

      const messages = LLM.buildMessages(idlePrompt);
      const { parsed } = await LLM.stream(messages);

      if (parsed.text && parsed.text.trim() !== "SKIP") {
        if (isThought) {
          // Thought bubble: quiet observation, no spotlight, no TTS.
          // Skipped if she's already mid-conversation so the two
          // bubbles never fight over the same space.
          UI.mutter(parsed.text, { holdMs: 9000 });
        } else {
          Sfx.init();
          Orb.setMood(parsed.mood || "idle", 8000);
          UI.say(parsed.text, { mood: parsed.mood || "idle", holdMs: 8000 });
        }
      }
    } catch (err) {
      // Silently skip if API calls fail during idle check
    }

    scheduleNextIdleCheck();
  }

  function scheduleNextIdleCheck() {
    const cfg = Config.get();
    const freq = {
      quiet: { min: 480000, max: 900000 },
      normal: { min: 180000, max: 360000 },
      chatty: { min: 70000, max: 150000 }
    };
    const range = freq[cfg.idleChatter] || freq.normal;
    const delay = Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    setTimeout(triggerAutonomousIdleCheck, delay);
  }

  // --------------------------
  // Accessory persistence hook
  // --------------------------
  async function setAccessories(list) {
    Orb.setAccessories(list);
    await Config.save({ accessories: list.slice() });
    return Orb.getAccessories();
  }

  // --------------------------
  // Init
  // --------------------------
  function init() {
    ipcRenderer.on("reminder-fired", (_event, payload) => onReminderFired(payload));
    setInterval(pollIdleForSleep, 20000);
    pollIdleForSleep();
    scheduleNextIdleCheck();
  }

  // --------------------------
  // Computer control — when you ask her to do something on your PC,
  // she looks at the screen, decides one step, does it, looks again.
  // Full-auto with narration (the bubble tells you what she's about
  // to touch). Only ever started by an explicit user request, and
  // Escape or "stop" drops everything mid-task.
  // --------------------------
  let pcTask = null;
  let pcResume = null;
  let pcAbort = false;

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function parseStep(raw) {
    const cleaned = String(raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
    let obj = null;
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    const candidates = [];
    if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));
    for (const c of candidates) {
      try { obj = JSON.parse(c); break; } catch (e) {}
    }
    if (!obj || typeof obj !== "object") {
      // tiny regex rescue for {"done":true} style endings
      if (/"done"\s*:\s*true/i.test(cleaned)) return { done: true, summary: "done.", action: null };
      return null;
    }
    const act = (obj.action && typeof obj.action === "object") ? obj.action : null;
    if (act && typeof act.type === "string") act.type = act.type.toLowerCase().replace(/[^a-z_]/g, "");
    return {
      thought: typeof obj.thought === "string" ? obj.thought : (typeof obj.note === "string" ? obj.note : ""),
      action: act,
      done: obj.done === true,
      summary: typeof obj.summary === "string" ? obj.summary : ""
    };
  }

  function validAction(act) {
    if (!act || typeof act !== "object" || typeof act.type !== "string") return false;
    const t = act.type;
    if (t === "key" && !(typeof act.combo === "string" && act.combo.trim())) return false;
    if (t === "type" && typeof act.text !== "string") return false;
    if ((t === "move" || t === "click" || t === "double_click") &&
        !(Number.isFinite(Number(act.x)) && Number.isFinite(Number(act.y)))) return false;
    if (t === "drag" && !["x", "y", "x2", "y2"].every(k => Number.isFinite(Number(act[k])))) return false;
    if (t === "scroll" && !["up", "down", "left", "right"].includes(String(act.dir || "down"))) return false;
    return true;
  }

  function describeAction(act) {
    const at = String(act.type || "");
    if (at === "key") return `pressing ${act.combo}`;
    if (at === "type") return "typing...";
    if (at === "scroll") return `scrolling ${act.dir || "down"}`;
    if (at === "drag") return "dragging...";
    if (at.includes("click")) return at === "double_click" ? "double-clicking" : `${at === "right_click" ? "right-" : ""}clicking`;
    if (at === "move") return "";
    return at;
  }

  function buildStepPrompt(task) {
    const stepNo = task.history.length + 1;
    const historyBlock = task.history.length
      ? "steps you already took:\n" + task.history.slice(-12).map((h, i) => `${i + 1}. ${h}`).join("\n")
      : "(you haven't done anything yet)";
    return `[COMPUTER TASK]
goal: ${task.goal}
step number: ${stepNo}
${historyBlock}

[WHAT YOU SEE] the attached image is your desktop's primary screen right now.
[GRID] coordinates are 0-999: (0,0) top-left corner, (999,999) bottom-right, x = rightward, y = downward. Estimate positions off the image.
[ACTIONS — reply with exactly one per step]
move: {"type":"move","x":..,"y":..}
click: {"type":"click","x":..,"y":..} ("button":"right" for right-click)
double_click: {"type":"double_click","x":..,"y":..}
drag: {"type":"drag","x":..,"y":..,"x2":..,"y2":..}
type: {"type":"type","text":"notepad"} — types exactly (into the currently focused window), \\n sends enter
key: {"type":"key","combo":"win"} — combo is REQUIRED, never send "key" without it. modifiers ctrl/shift/alt/win + named keys enter/esc/tab/space/backspace/delete/home/end/pageup/pagedown/up/down/left/right/f1-f12/letters/numbers
scroll: {"type":"scroll","dir":"up|down","amount":3}
wait: {"type":"wait","seconds":1} — use when something needs time to appear (menus, apps loading) before doing the next thing
[HARD RULES]
- every action you emit must have all of its fields. a "key" without "combo", a "click" without "x"/"y" is a wasted step.
- opening apps: press win, then type the app name with {"type":"type"}, then enter. that is the most reliable way.
- menus/animations take ~1s to appear. if a click "did nothing", first {"type":"wait"} and look again instead of clicking twice blindly.
[STRICT OUTPUT — raw JSON only, no markdown, no text outside JSON]
{"thought":"one short line: what you see / what you're doing","action":{...},"done":false,"summary":null}
- "done": true ONLY when the goal is fully achieved (that step may still contain a finishing action).
- "summary": short one-sentence result, only when done.
- if you're stuck or the goal is impossible on this screen, set "done": false, no action, and explain in "thought".`;
  }

  async function runComputerLoop(task) {
    Globals.busy = true;
    Orb.setMood("thinking", 6000);
    try {
      for (;;) {
        if (pcAbort) {
          UI.say("hands off — task dropped. your mouse is all yours again.", { mood: "sad", holdMs: 7000, speak: true });
          pcResume = null;
          break;
        }
        const cfg = Config.get();
        const maxSteps = Math.max(1, Math.min(50, Math.round(Number(cfg.pcMaxSteps) || 10)));
        // Per-run step budget, NOT total history length: "continue" restores
        // the full history for context, so counting history made the cap
        // re-trip instantly on every resume and she'd just repeat the cap
        // message forever. Each "continue" grants a fresh allowance.
        const usedThisRun = Number(task.usedThisRun) || 0;
        if (usedThisRun >= maxSteps) {
          pcResume = { goal: task.goal, history: task.history };
          UI.say(`hit your ${maxSteps}-step cap mid-task. say "continue" and i'll take another ${maxSteps} swings at it.`, { mood: "confused", holdMs: 9000 });
          break;
        }
        task.usedThisRun = usedThisRun + 1;

        let shot;
        try {
          shot = await ipcRenderer.invoke("vision:grab-screen");
        } catch (e) {
          UI.say("couldn't grab the screen — task aborted.", { mood: "sad", holdMs: 7000 });
          pcResume = null;
          break;
        }

        Orb.setMood("thinking", 5000);
        const { raw } = await LLM.stream(
          LLM.buildMessages(buildStepPrompt(task), { withHistory: false }),
          { images: [shot] }
        );
        const step = parseStep(raw);

        if (!step) {
          task.junk = (task.junk || 0) + 1;
          task.history.push("(unparseable answer from vision model)");
          if (task.junk >= 3) {
            UI.say("my vision model keeps answering gibberish — task aborted. check the vision model in settings.", { mood: "confused", holdMs: 9000 });
            pcResume = null;
            break;
          }
          continue;
        }
        task.junk = 0;

        // "done" with a finishing action still executes that action first;
        // only an actionless done ends the task right away.
        if (step.done && !validAction(step.action)) {
          console.log(`[PC] done: ${task.history.length + 1} steps — ${step.summary || "no summary"}`);
          const doneText = (step.summary || "done. goal complete.").slice(0, 90);
          // task wrap-ups are quiet asides: little bubble hugging her head…
          if (!UI.mutter(doneText, { holdMs: 8000, force: true })) {
            // …big bubble only if there's no airspace for the mutter
            UI.say(doneText, { mood: "happy", holdMs: 8000, speak: true });
          }
          speakReply(doneText);
          Memory.addAssistant(`completed a computer task: ${task.goal}${step.summary ? " — " + step.summary : ""} (${task.history.length} steps)`);
          pcResume = null;
          break;
        }

        const act = step.action;
        if (!act) {
          console.log("[PC] step " + (task.history.length + 1) + ": stuck —", (step.thought || "").slice(0, 80));
          task.history.push(step.thought ? `(stuck: ${step.thought.slice(0, 80)})` : "(no action returned)");
          task.stuck = (task.stuck || 0) + 1;
          if (task.stuck >= 2) {
            UI.say("i'm stuck and can't finish this one. here's where it fell apart: " + (step.thought || "no idea what i'm looking at"), { mood: "confused", holdMs: 9000 });
            pcResume = null;
            break;
          }
          continue;
        }
        task.stuck = 0;

        if (!validAction(act)) {
          console.log("[PC] step " + (task.history.length + 1) + ": malformed action dropped — " + JSON.stringify(act).slice(0, 90));
          task.junk = (task.junk || 0) + 1;
          task.history.push("(malformed action, missing fields — retry)");
          if (task.junk >= 3) {
            UI.say("my vision model keeps sending broken steps — task aborted. maybe try a different model in settings.", { mood: "confused", holdMs: 9000 });
            pcResume = null;
            break;
          }
          continue;
        }

        if (act.type === "wait") {
          const secs = Math.max(0.5, Math.min(5, Number(act.seconds) || 1));
          await sleep(secs * 1000);
          task.history.push("waited " + secs + "s" + (step.thought ? " — " + step.thought.slice(0, 60) : ""));
          continue;
        }

        const narration = String(step.thought || "").trim() || describeAction(act);
        if (narration) UI.mutter(narration.slice(0, 90), { holdMs: 3200, force: true });
        console.log(`[PC] step ${task.history.length + 1}: ${act.type}` +
          (act.type === "key" && act.combo ? ` ${act.combo}` : "") +
          (act.type === "type" && act.text ? ` typing` : "") +
          (act.x !== undefined ? ` -> ${act.x},${act.y}` : "") +
          (act.x2 !== undefined ? ` => ${act.x2},${act.y2}` : "") +
          (step.thought ? ` | ${step.thought.slice(0, 60)}` : ""));

        try {
          await ipcRenderer.invoke("pc-act", act);
        } catch (err) {
          task.errors = (task.errors || 0) + 1;
          task.history.push(`(${act.type} failed: ${String(err.message).slice(0, 60)})`);
          console.log(`[PC] step ${task.history.length + 1} FAILED: ${String(err.message).slice(0, 80)}`);
          if (task.errors >= 2) {
            UI.say("my hand isn't responding — dropping the task before anything weird happens.", { mood: "sad", holdMs: 8000 });
            pcResume = null;
            break;
          }
          await sleep(600);
          continue;
        }
        task.errors = 0;

        task.history.push(
          act.type +
          (act.type === "type" && act.text ? " \"" + String(act.text).slice(0, 28) + "\"" : "") +
          (act.type === "key" && act.combo ? " " + act.combo : "") +
          (act.type === "scroll" ? " " + (act.dir || "down") : "") +
          (step.thought ? " — " + step.thought.slice(0, 60) : "")
        );
        if (step.done) {
          console.log(`[PC] done after final ${act.type}: ${step.summary || "no summary"}`);
          const doneText = (step.summary || "done. goal complete.").slice(0, 90);
          if (!UI.mutter(doneText, { holdMs: 8000, force: true })) {
            UI.say(doneText, { mood: "happy", holdMs: 8000, speak: true });
          }
          speakReply(doneText);
          Memory.addAssistant(`completed a computer task: ${task.goal}${step.summary ? " — " + step.summary : ""} (${task.history.length} steps)`);
          pcResume = null;
          break;
        }
        await sleep(650);
      }
    } catch (err) {
      console.log("[PC] task crashed:", err.message);
      UI.say("computer task crashed hard: " + String(err.message).slice(0, 80), { mood: "sad", holdMs: 8000 });
      pcResume = null;
    } finally {
      pcTask = null;
      pcAbort = false;
      Globals.busy = false;
    }
  }

  function startComputerTask(goal) {
    const clean = String(goal || "").trim().slice(0, 400);
    if (!clean) return;
    pcAbort = false;
    pcTask = { goal: clean, history: [] };
    Memory.addUser(`asked ellie to use the pc: ${clean}`);
    runComputerLoop(pcTask);
  }

  function resumeComputerTask() {
    if (!pcResume) return false;
    const cfg = Config.get();
    if (!cfg.pcControl) return false;
    pcAbort = false;
    pcTask = { goal: pcResume.goal, history: pcResume.history };
    pcResume = null;
    UI.say("picking it back up.", { mood: "happy", holdMs: 4500 });
    runComputerLoop(pcTask);
    return true;
  }

  return {
    init,
    speakReply,
    getBatteryPct,
    handleAction,
    scheduleReminder,
    listRemindersText,
    cancelAllRemindersText,
    startPomodoro,
    stopPomodoro,
    isPomodoroRunning,
    getPomodoroStatus,
    onReminderFired,
    wakeIfAsleep,
    setAccessories,
    seasonalSuffix,
    seasonalLines,
    getLastKnownIdle: () => lastKnownIdle,
    pcTaskActive: () => !!pcTask,
    pcResumePending: () => !!pcResume,
    requestStop: () => { pcAbort = true; },
    startComputerTask,
    resumeComputerTask,
    exitNow
  };
})();
