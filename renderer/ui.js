// ============================================================
// UI — speech bubble + typewriter, chat input & commands,
// settings panel, mic/voice wiring, mouse handling.
// ============================================================
const UI = (() => {
  const { ipcRenderer, webUtils } = require("electron");

  const speech = document.getElementById("speech-bubble");
  const inputContainer = document.getElementById("input-container");
  const input = document.getElementById("input-box");
  const settingsModal = document.getElementById("settings-modal");
  const micBtn = document.getElementById("mic-btn");
  const snipBtn = document.getElementById("snip-btn");
  const imgChip = document.getElementById("img-chip");
  const imgChipImg = document.getElementById("img-chip-img");
  const imgChipLabel = document.getElementById("img-chip-label");
  const imgChipX = document.getElementById("img-chip-x");
  const thoughtBubbleEl = document.getElementById("thought-bubble");
  let mutterTimer = null;
  let speechHoldUntil = 0; // until when the speech bubble "owns" the airspace
  let speechRetireTimer = null;

  const cfgProvider = document.getElementById("cfg-provider");
  const cfgOrKey = document.getElementById("cfg-or-key");
  const cfgOrModel = document.getElementById("cfg-or-model");
  const cfgVisionModel = document.getElementById("cfg-vision-model");
  const cfgLmsEndpoint = document.getElementById("cfg-lms-endpoint");
  const cfgLmsModel = document.getElementById("cfg-lms-model");
  const cfgChatter = document.getElementById("cfg-chatter");
  const cfgVoice = document.getElementById("cfg-voice");
  const cfgPc = document.getElementById("cfg-pc");
  const cfgPcSteps = document.getElementById("cfg-pc-steps");
  const cfgSleepSchedule = document.getElementById("cfg-sleep-schedule");
  const cfgBedtime = document.getElementById("cfg-bedtime");
  const cfgWakeTime = document.getElementById("cfg-wake-time");
  const cfgSummon = document.getElementById("cfg-summon-hotkey");
  const wipeBtn = document.getElementById("wipe-btn");
  const memBtn = document.getElementById("mem-btn");
  const memoryModal = document.getElementById("memory-modal");
  const memoryList = document.getElementById("memory-list");
  const memAddInput = document.getElementById("mem-add-input");
  const memAddBtn = document.getElementById("mem-add-btn");
  const memCloseBtn = document.getElementById("mem-close-btn");
  const secOr = document.getElementById("section-openrouter");
  const secLms = document.getElementById("section-lmstudio");
  const saveBtn = document.getElementById("save-btn");
  const cancelBtn = document.getElementById("cancel-btn");

  // --- Typewriter Buffer System ---
  let displayedText = "";
  let targetText = "";
  let typewriterInterval = null;
  let charSoundCounter = 0;

  function parseMarkdown(text) {
    if (!text) return "";
    let html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/\n/g, "<br>");

    return html;
  }

  function startTypewriter(soundPerChar = true) {
    if (typewriterInterval) return;
    Sfx.init();

    typewriterInterval = setInterval(() => {
      if (displayedText.length < targetText.length) {
        const nextChar = targetText[displayedText.length];
        displayedText += nextChar;
        speech.innerHTML = parseMarkdown(displayedText);

        if (soundPerChar && nextChar.trim() !== "") {
          charSoundCounter = (charSoundCounter + 1) % 3;
          if (charSoundCounter === 0) Sfx.playMood(Orb.getMood());
        }
      } else if (!Globals.isBusy()) {
        clearInterval(typewriterInterval);
        typewriterInterval = null;
      }
    }, 30);
  }

  function resetTypewriter() {
    if (typewriterInterval) clearInterval(typewriterInterval);
    typewriterInterval = null;
    displayedText = "";
    targetText = "";
  }

  // --- "thinking..." heartbeat so stalls are visible ---
  let thinkTicker = null;

  function startThinkingTicker() {
    stopThinkingTicker();
    const t0 = Date.now();
    thinkTicker = setInterval(() => {
      if (displayedText.length > 0 || targetText.length > 0) { stopThinkingTicker(); return; } // text is flowing now
      const secs = Math.floor((Date.now() - t0) / 1000);
      // Keep it calm — plain "thinking..." first, counter only after 6 s
      if (secs < 6) {
        speech.innerHTML = "thinking...";
        return;
      }
      const dots = ".".repeat(1 + (Math.floor(secs / 2) % 3));
      speech.innerHTML = `thinking${dots} (${secs}s)`;
    }, 500);
  }

  function stopThinkingTicker() {
    if (thinkTicker) { clearInterval(thinkTicker); thinkTicker = null; }
  }

  // The speech bubble owns the airspace only until its hold expires —
  // after that it must yield so the director can tuck her (canAutoHide
  // requires the bubble gone) and so old lines don't linger forever.
  // If she's still typing when the hold runs out, the retire waits for
  // the words to land first.
  function armSpeechRetire(ms) {
    if (speechRetireTimer) clearTimeout(speechRetireTimer);
    speechRetireTimer = setTimeout(() => {
      speechRetireTimer = null;
      if (typewriterInterval !== null) { armSpeechRetire(1200); return; }
      speech.style.display = "none";
      speechHoldUntil = 0;
    }, Math.max(0, ms));
  }

  // Show a finished line of dialogue (with optional mood hold + TTS)
  function say(text, { mood = null, holdMs = 6000, speak = false } = {}) {
    stopThinkingTicker();
    resetTypewriter();
    // Speech bubble wins the airspace — drop any live mutter
    speechHoldUntil = Date.now() + holdMs + 1500;
    armSpeechRetire(holdMs + 1500);
    if (mutterTimer) { clearTimeout(mutterTimer); mutterTimer = null; }
    if (thoughtBubbleEl) thoughtBubbleEl.classList.remove("show");
    if (mood) Orb.setMood(mood, holdMs);
    Sfx.init();
    displayedText = "";
    targetText = text;
    speech.style.display = "block";
    Globals.busy = false;
    startTypewriter(true);
    if (speak) Assistant.speakReply(text);
  }

  // Pool of summon asides (hotkey summon) — random pick, never the same
  // line twice in a row.
  const SUMMON_LINES = [
    "sup? what do you need?",
    "oh. you called me up.",
    "the void paged. i answered.",
    "summoned. dramatic. i respect it.",
    "i was right here the whole time, you know.",
    "yes? what do you need?",
    "back among the living. what's up?",
    "you missed me. it's ok to admit it.",
    "peekaboo. what do you need?",
    "hm? oh — hi."
  ];
  let lastSummonIdx = -1;
  function pickSummonLine() {
    let i = Math.floor(Math.random() * SUMMON_LINES.length);
    if (i === lastSummonIdx) i = (i + 1) % SUMMON_LINES.length;
    lastSummonIdx = i;
    return SUMMON_LINES[i];
  }

  // First-time greeting — the chat model composes a fresh opener when a
  // provider is connected; the hardcoded lines below are only the fallback
  // for when there's no AI yet.
  function greet() {
    const name = Memory.getUserName();
    const season = Assistant.seasonalSuffix ? Assistant.seasonalSuffix() : "";
    const fallback = name
      ? `hey ${name}... welcome back. i still remember you, you know that, right?${season}`
      : (Memory.getMemoriesBlock() !== ""
        ? `hey... welcome back. i still remember you, you know that, right?${season}`
        : `hey... i am ellie.${season}`);

    // One-time only (ever): she notices the book has no name in it and asks
    if (!localStorage.getItem("ellie_name_asked")) {
      localStorage.setItem("ellie_name_asked", "1");
      setTimeout(() => {
        if (!Memory.getUserName()) {
          awaitingName = true;
          say("btw... there's no name in my memory book. what should i call you? just type it.", { mood: "idle", holdMs: 14000 });
        }
      }, 7200);
    }

    aiGreet(fallback);
  }

  // Boot greeting via the chat model, streamed into the bubble like a real
  // reply (mood + typewriter). Anything goes wrong — no provider, offline,
  // empty answer, 15s stall — and she falls back to the stock line.
  async function aiGreet(fallbackText) {
    // autotest runs must stay deterministic: canned greeting only
    if (window.location && window.location.search.includes("autotest")) {
      say(fallbackText, { mood: "idle", holdMs: 8000 });
      return;
    }
    let live = false;      // first streamed token landed
    let expired = false;   // boot-time stop-loss tripped
    try {
      speech.innerHTML = "thinking...";
      speech.style.display = "block";
      startThinkingTicker();

      const seasonList = Assistant.seasonalLines ? Assistant.seasonalLines() : [];
      const hr = new Date().getHours();
      const dayPart = (hr >= 4 && hr < 12) ? "morning" : (hr < 17) ? "afternoon" : (hr < 23) ? "late night" : "middle of the night";
      const greetingPrompt = `[GREETING TASK] this is your very first appearance today — the moment ellie boots up and greets her person. compose THAT line.
- one short sentence, lowercase, casual emo gremlin energy: warm but never sappy.
- it must feel FRESH, like something you'd actually blurt — not a stock catchphrase you repeat every day. never open with "hey... welcome back".
- never mention system stats (RAM/CPU/battery), never say anything technical about booting ("systems online" etc is banned).
- you may nod to the time of day (it's ${dayPart})${seasonList.length ? ` or the season ("${seasonList.join("; ")}" — at most once, folded in naturally)` : ""}. if you know the user's name, use it.
- reply with {"mood":"...","text":"..."} only — no "action", nothing remembered.`;

      const result = await Promise.race([
        LLM.stream(LLM.buildMessages(greetingPrompt, { withHistory: false }), {
          onMood: (m) => {
            if (!live) { live = true; stopThinkingTicker(); }
            Orb.setMood(m, 8000);
          },
          onText: (newText) => {
            if (!live) { live = true; stopThinkingTicker(); }
            targetText = newText;
            speech.style.display = "block";
            startTypewriter(true);
          }
        }),
        new Promise(res => setTimeout(() => { expired = true; res(null); }, 15000))
      ]);

      if (expired) {
        // stall: whatever streamed stays up; blank → canned line
        stopThinkingTicker();
        if (!live) say(fallbackText, { mood: "idle", holdMs: 8000 });
        else {
          speechHoldUntil = Date.now() + 9500;
          armSpeechRetire(9500);
        }
        return;
      }

      const parsed = result && result.parsed;
      const text = parsed && parsed.text && parsed.text.trim() ? parsed.text.trim() : null;
      if (!text) throw new Error("greeting came back empty");

      // re-render cleanly in case streaming didn't finish the line
      resetTypewriter();
      targetText = text;
      startTypewriter(true);
      speechHoldUntil = Date.now() + 9500;
      armSpeechRetire(9500);
      if (parsed.mood) Orb.setMood(parsed.mood, 8000);
      // logged so the next boot's model knows what she said last time
      Memory.addAssistant(`(boot greeting) ${text}`);
      console.log("[ui] ai greeting ok");
      Assistant.speakReply(text);
    } catch (e) {
      console.log("[ui] ai greeting failed — using canned line:", e.message || e);
      stopThinkingTicker();
      say(fallbackText, { mood: "idle", holdMs: 8000 });
    }
  }

  // --- Settings UI Handlers ---
  function syncModalFromConfig() {
    const cfg = Config.get();
    cfgProvider.value = cfg.provider;
    cfgOrKey.value = "";
    cfgOrKey.placeholder = cfg.hasOpenRouterApiKey ? "•••••• (key stored — leave blank to keep)" : "sk-or-v1-...";
    cfgOrModel.value = cfg.openRouterModel || "";
    cfgVisionModel.value = cfg.visionModel || "";
    cfgLmsEndpoint.value = cfg.lmStudioEndpoint || "";
    cfgLmsModel.value = cfg.lmStudioModel || "";
    cfgChatter.value = cfg.idleChatter || "normal";
    cfgVoice.value = cfg.voiceEnabled ? "on" : "off";
    cfgPc.value = cfg.pcControl ? "on" : "off";
    cfgPcSteps.value = Math.max(1, Math.min(50, Math.round(Number(cfg.pcMaxSteps) || 10)));
    cfgSummon.value = cfg.summonHotkey || "Control+Alt+E";
    const sched = cfg.sleepSchedule || {};
    cfgSleepSchedule.value = sched.enabled ? "on" : "off";
    cfgBedtime.value = sched.bedtime || "23:30";
    cfgWakeTime.value = sched.wakeTime || "07:30";
    toggleProviderSections();
  }

  function toggleProviderSections() {
    if (cfgProvider.value === "openrouter") {
      secOr.style.display = "block";
      secLms.style.display = "none";
    } else {
      secOr.style.display = "none";
      secLms.style.display = "block";
    }
  }

  cfgProvider.addEventListener("change", toggleProviderSections);

  function openSettingsPanel() {
    syncModalFromConfig();
    memoryModal.style.display = "none"; // never two panels stacked
    settingsModal.style.display = "block";
    settingsModal.scrollTop = 0;
    Orb.setMood("idle");
    say("opening settings...", { mood: "idle", holdMs: 3000 });
  }

  cancelBtn.addEventListener("click", () => {
    settingsModal.style.display = "none";
  });

  saveBtn.addEventListener("click", async () => {
    const settings = {
      provider: cfgProvider.value,
      openRouterModel: cfgOrModel.value.trim(),
      visionModel: cfgVisionModel.value.trim(),
      lmStudioEndpoint: cfgLmsEndpoint.value.trim(),
      lmStudioModel: cfgLmsModel.value.trim(),
      idleChatter: cfgChatter.value,
      voiceEnabled: cfgVoice.value === "on",
      pcControl: cfgPc.value === "on",
      pcMaxSteps: Math.max(1, Math.min(50, Math.round(Number(cfgPcSteps.value) || 10))),
      summonHotkey: cfgSummon.value.trim() || "Control+Alt+E",
      sleepSchedule: {
        enabled: cfgSleepSchedule.value === "on",
        bedtime: cfgBedtime.value || "23:30",
        wakeTime: cfgWakeTime.value || "07:30"
      }
    };

    const keyField = cfgOrKey.value.trim();
    let apiKey;
    if (keyField) apiKey = keyField; // "clear" is handled by the main process

    saveBtn.disabled = true;
    await Config.save(settings, apiKey);
    saveBtn.disabled = false;
    settingsModal.style.display = "none";
    say("settings saved!", { mood: "happy", holdMs: 4000 });
  });

  wipeBtn.addEventListener("click", () => {
    Memory.wipeAll();
    settingsModal.style.display = "none";
    Orb.setMood("sad", 4000);
    say("memory wiped. everything before has been erased. who... who was i talking to?", { mood: "sad", holdMs: 7000 });
  });

  // --- Memories panel: star, edit, delete everything she keeps about you ---
  function renderMemoryList() {
    memoryList.innerHTML = "";
    const items = Memory.getMemories(); // pinned first
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "mem-empty";
      empty.textContent = "nothing yet... type \"remember that i'm a night owl\" or add one below.";
      memoryList.appendChild(empty);
      return;
    }
    for (const m of items) {
      const row = document.createElement("div");
      row.className = "mem-row" + (m.pinned ? " is-pinned" : "");

      const star = document.createElement("button");
      star.className = "mem-star" + (m.pinned ? " pinned" : "");
      star.title = m.pinned ? "Unpin (she'll stop treating this as core)" : "Pin — a core fact she never forgets";
      star.textContent = m.pinned ? "★" : "☆";
      star.addEventListener("click", () => {
        Memory.pinMemory(m.text, !m.pinned);
        renderMemoryList();
      });

      const text = document.createElement("span");
      text.className = "mem-text";
      text.textContent = m.text;
      text.title = "Click to edit";
      text.addEventListener("click", () => {
        // Swap the text for an inline editor, save on Enter/blur
        const edit = document.createElement("input");
        edit.type = "text";
        edit.className = "mem-edit";
        edit.maxLength = 200;
        edit.value = m.text;
        text.replaceWith(edit);
        edit.focus();
        edit.setSelectionRange(edit.value.length, edit.value.length);
        const commit = () => {
          if (edit.value.trim() && edit.value.trim() !== m.text) {
            Memory.editMemory(m.text, edit.value);
          }
          renderMemoryList();
        };
        edit.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); edit.blur(); }
          if (ev.key === "Escape") { edit.value = m.text; edit.blur(); }
          ev.stopPropagation(); // ESC here edits, never aborts a task
        });
        edit.addEventListener("blur", commit);
      });

      const del = document.createElement("button");
      del.className = "mem-del";
      del.title = "Forget this";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        Memory.removeMemory(m.text);
        Orb.setMood("confused", 2500);
        renderMemoryList();
      });

      row.appendChild(star);
      row.appendChild(text);
      row.appendChild(del);
      memoryList.appendChild(row);
    }
  }

  function openMemoryPanel() {
    settingsModal.style.display = "none"; // never two panels stacked
    renderMemoryList();
    memAddInput.value = "";
    memoryModal.style.display = "block";
    memoryModal.scrollTop = 0;
    Orb.setMood("idle");
    say("flipping through my memory book...", { mood: "idle", holdMs: 3000 });
  }

  function addFromPanel() {
    const value = memAddInput.value.trim();
    if (!value) return;
    if (Memory.addMemory(value)) {
      memAddInput.value = "";
      Orb.setMood("happy", 2500);
    } else {
      memAddInput.value = "";
      // Already remembered or over 200 chars — say so in the placeholder
      memAddInput.placeholder = "already remembered (or too long)?";
      setTimeout(() => { memAddInput.placeholder = "remember something new..."; }, 2200);
    }
    renderMemoryList();
  }

  memAddBtn.addEventListener("click", addFromPanel);
  memAddInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addFromPanel(); }
  });
  memCloseBtn.addEventListener("click", () => {
    memoryModal.style.display = "none";
  });
  memBtn.addEventListener("click", openMemoryPanel);

  // --- Local chat command handlers (skips the LLM) ---
  const ACCESSORY_NAMES = ["headphones", "beanie", "sunglasses"];

  // --- Remembering her people: durable personal details get saved even
  // when the model talks instead of emitting "remember" ---
  const NAME_BLOCKLIST = new Set([
    "hi", "hey", "hello", "sup", "yo", "hiya", "no", "yes", "ok", "okay", "yeah",
    "nah", "what", "whats", "who", "me", "you", "idk", "hmm", "nothing", "nvm",
    "bye", "thanks", "ty", "wait", "done", "cool", "nice", "lol", "lmao", "stop",
    "continue", "nevermind", "settings", "forget", "remember", "everything",
    "please", "thanks again", "good", "great", "sure"
  ]);

  let awaitingName = false; // first-boot "what should i call you?" prompt is pending

  function cleanFactValue(raw, maxWords = 8) {
    let value = String(raw || "").trim().replace(/[.,!?;]+$/, "").replace(/\s+/g, " ");
    if (!value || value.split(" ").length > maxWords) return null;
    return value;
  }

  // Silent captures: store the fact, let the message keep flowing to the
  // LLM so she still answers naturally. Phrasing mirrors the persona rule
  // ("User's favorite band is ...") so model-saved versions dedupe.
  function captureFacts(lower) {
    const facts = [];
    let m = lower.match(/my (?:favou?rite) ([a-z][a-z ]{0,20}?) is (.+)/);
    if (m) { const v = cleanFactValue(m[2]); if (v) facts.push([`User's favorite ${m[1].trim()} is ${v}`, false]); }
    m = lower.match(/my birthday (?:is |on )?(.+)/);
    if (m) { const v = cleanFactValue(m[1]); if (v) facts.push([`User's birthday is ${v}`, true]); }
    m = lower.match(/\bi(?:'m| am|)\s+(\d{1,2}) years? old\b/);
    if (m) facts.push([`User's age is ${m[1]}`, true]);
    m = lower.match(/\bi (?:work|study) (?:at|as|in) (.+)/);
    if (m) { const v = cleanFactValue(m[1]); if (v) facts.push([`User works as ${v}`, false]); }
    m = lower.match(/my (girlfriend|boyfriend|partner|wife|husband|sister|brother|best friend)(?:'s name)? is (?:called )?(.+)/);
    if (m) { const v = cleanFactValue(m[2]); if (v) facts.push([`User's ${m[1]} is ${v}`, false]); }
    for (const [text, pinned] of facts) {
      if (Memory.addMemory(text) && pinned) Memory.pinMemory(text, true);
    }
    return facts.length;
  }

  // Names: explicit patterns any time; bare "blake"-style replies only
  // while the first-boot prompt is pending. Consumes the message.
  function tryCaptureName(text, lower) {
    let name = null;
    let m = lower.match(/^(?:ok(?:ay)?\s+)?(?:my name(?:'s| is)|name(?:'s| is)|you can call me|call me|i go by)\s+(.+)$/);
    if (m) name = m[1];
    if (!name && awaitingName) {
      m = lower.match(/^(?:i(?:'m| am|)\s|im\s|it's\s|its\s)(.+)$/);
      if (m) name = m[1];
    }
    if (!name && awaitingName) {
      // bare name reply: 1–2 plain words, none from the blocklist
      const words = lower.replace(/[.,!\?]+$/, "").split(/\s+/).filter(w => /^[a-z]+$/.test(w));
      if (words.length >= 1 && words.length <= 2 &&
          words.length === lower.replace(/[.,!\?]+$/, "").split(/\s+/).length &&
          !NAME_BLOCKLIST.has(words[0]) &&
          !(words.length === 2 && NAME_BLOCKLIST.has(words[1]))) {
        name = words.join(" ");
      }
    }
    if (!name) return false;
    name = name.trim().replace(/\s+my name is.*$/i, "").replace(/[.,!?]+$/, "").replace(/\s+/g, " ");
    if (name.length < 2 || name.length > 30 || !/^[a-zA-Z' -]+$/.test(name)) return false;
    if (name.split(" ").some(w => NAME_BLOCKLIST.has(w))) return false;
    const pretty = name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
    const wasKnown = !!Memory.getUserName();
    Memory.setUserName(pretty);
    if (awaitingName) {
      awaitingName = false;
      say(`nice to meet you, ${pretty}. that just went on page one of my memory book.`, { mood: "happy", holdMs: 6000, speak: true });
    } else if (wasKnown) {
      say(`okay — ${pretty} from now on. book updated.`, { mood: "happy", holdMs: 5000 });
    } else {
      say(`got it — ${pretty}. you're in the book now.`, { mood: "happy", holdMs: 5000 });
    }
    return true;
  }

  async function handleLocalCommand(text, _opts = {}) {
    const lower = text.toLowerCase().trim();

    captureFacts(lower);
    if (tryCaptureName(text, lower)) {
      awaitingName = false;
      return true;
    }

    // Snip-a-region: ✂ button or "snip: ..." — she looks at ONLY the part you drag
    const snipMatch = lower.match(/^snip(?:\s+a\s+region|\s+the\s+screen|\s+screen|\s+this)?\s*(?::|\s)\s*(.*)$/);
    if (snipMatch && !Assistant.pcTaskActive()) {
      snipAndLook(snipMatch[1].trim());
      return true;
    }

    // Her hands on the PC: stop / continue
    if (Assistant.pcTaskActive() && /^(stop|stop it|stop the task|nevermind|never mind|abort|cancel task|hands off)$/.test(lower)) {
      Assistant.requestStop();
      say("stopping... your mouse is coming back to you.", { mood: "idle", holdMs: 5000 });
      return true;
    }
    if (Assistant.pcResumePending() && /^(continue|keep going|go on|keep on|resume|carry on)$/.test(lower)) {
      return Assistant.resumeComputerTask();
    }

    // "use the pc: <goal>" — deterministic desktop takeover, no LLM in the
    // middle. The chat model can still start tasks from natural phrasing
    // via its "computer" action; this is the always-works path.
    const pcMatch = lower.match(/^use the pc\b[,: ]*(.*)$/) || lower.match(/^use your (?:mouse|hands|lil hands)\b[,: ]*(.*)$/);
    if (pcMatch) {
      if (!Config.get().pcControl) {
        say("turn on computer control in settings first — then i'll be your hands.", { mood: "confused", holdMs: 8000 });
        return true;
      }
      const goal = (pcMatch[1] || "").trim();
      if (!goal) {
        say("use the pc to do... what, exactly?", { mood: "confused", holdMs: 7000 });
        return true;
      }
      say("on it. watch the little bubble — that's me narrating every move.", { mood: "happy", holdMs: 7000, speak: true });
      Assistant.startComputerTask(goal);
      return true;
    }

    // Exit tool: "goodnight" / "go to bed" / "leave me alone" — exact
    // phrases, deterministic, no model in the middle. She says bye and
    // closes herself (Assistant.exitNow shouts if she's mid-task).
    if (/^(good\s?night|night ellie|go to bed|going to bed|go to sleep|going to sleep|leave me alone|goodbye ellie|bye ellie|see you (?:later|tomorrow),? ellie|ellie[,\s]+(?:goodnight|good night|bye|goodbye)|exit\b|quit\b)/.test(lower)) {
      Assistant.exitNow();
      return true;
    }

    if (lower === "settings" || lower === "open settings" || lower.includes("open settings") || lower.includes("show settings")) {
      openSettingsPanel();
      return true;
    }

    // Memory book: show / browse / manage
    if (/^(show|open)\s+(my\s+|your\s+|the\s+)?(memories|memory book)$|^what do you (remember|know about me)$|^list (memories|my memories)$/.test(lower)) {
      openMemoryPanel();
      return true;
    }

    // "forget that <x>" / "forget about <x>" — deterministic single-memory
    // delete. ("forget everything" above wipes; "forget the reminder/timer"
    // stays with the reminder handlers below.)
    if (/^forget\b/.test(lower)) {
      const target = lower.replace(/^forget\b/, "").trim().replace(/^(that|about)\s+/, "").trim();
      if (target && !/(reminder|timer)/.test(target)) {
        const ok = Memory.removeMemory(target);
        if (ok) {
          Orb.setMood("confused", 3000);
          say(`gone. like it was never in my head.`, { mood: "confused", holdMs: 6000 });
        } else {
          say(`huh... i don't think i ever remembered that anyway.`, { mood: "confused", holdMs: 6000 });
        }
        return true;
      }
    }

    if (lower.includes("forget everything") || lower.includes("clear memory") || lower.includes("wipe your memory")) {
      Memory.wipeAll();
      Orb.setMood("sad", 4000);
      say("memory wiped. everything before has been erased. who... who was i talking to?", { mood: "sad", holdMs: 7000 });
      return true;
    }

    // "remember that <x>" — straight into the memory book, no model detour.
    // Contrasts with the LLM path that stores clean memories when it feels
    // like it; this one never flakes.
    const remMatch = text.trim().match(/^\s*(?:remember|keep in mind|note that)\b[:\s,]*(?:that\s+)?(.+)$/i);
    if (remMatch && remMatch[1] && remMatch[1].trim().length > 1) {
      const fact = remMatch[1].trim();
      if (Memory.addMemory(fact)) {
        Orb.setMood("happy", 3000);
        say(`locked in: "${fact}". that's in the book forever.`, { mood: "happy", holdMs: 6000 });
      } else {
        say("already remembered that one.", { mood: "idle", holdMs: 5000 });
      }
      return true;
    }

    // Voice on/off
    if (/^voice on$|^talk to me$|^(enable|turn on) (voice|speech|tts)/.test(lower)) {
      await Config.save({ voiceEnabled: true });
      say("fine, speaking out loud now. hope your headphones are on.", { mood: "idle", holdMs: 6000, speak: true });
      return true;
    }
    if (/^voice off$|^be quiet$|^shush$|^(disable|turn off) (voice|speech|tts)|^stop talking$/.test(lower)) {
      await Config.save({ voiceEnabled: false });
      say("okay, back to silent mode. walls have ears, and apparently moods.", { mood: "idle", holdMs: 6000 });
      return true;
    }

    // Wardrobe
    if (lower.includes("what are you wearing")) {
      const list = Orb.getAccessories();
      Orb.setMood("confused", 4000);
      say(list.length ? `currently rocking: ${list.join(", ")}. fashion is a mood.` : "nothing, just my glass body. minimalist emo.", { mood: "confused", holdMs: 6000 });
      return true;
    }
    for (const acc of ACCESSORY_NAMES) {
      if ((lower.includes("take off") || lower.includes("remove") || lower.includes("stop wearing")) && lower.includes(acc)) {
        const next = Orb.getAccessories().filter(a => a !== acc);
        await Assistant.setAccessories(next);
        Orb.setMood("confused", 4000);
        say(`${acc} off. free at last.`, { mood: "confused", holdMs: 5000 });
        return true;
      }
      if (lower.includes("wear") && lower.includes(acc) && !lower.includes("take off")) {
        const next = Array.from(new Set([...Orb.getAccessories(), acc]));
        await Assistant.setAccessories(next);
        Orb.setMood("happy", 4000);
        say(`look at me in my ${acc}. peak style.`, { mood: "happy", holdMs: 5000 });
        return true;
      }
    }
    if (lower.includes("no accessories") || lower.includes("wear nothing") || lower.includes("take everything off")) {
      await Assistant.setAccessories([]);
      Orb.setMood("confused", 4000);
      say("stripped of all accessories. bare glass.", { mood: "confused", holdMs: 5000 });
      return true;
    }

    // Pomodoro
    if (lower.includes("pomodoro")) {
      if (lower.includes("stop") || lower.includes("cancel") || lower.includes("end") || lower.includes("off")) {
        Assistant.stopPomodoro();
        return true;
      }
      if (lower.includes("status") || lower.includes("how") || lower.includes("left") || lower.includes("time")) {
        Assistant.isPomodoroRunning()
          ? say(`current pomodoro: ${Assistant.getPomodoroStatus()}.`, { mood: "idle", holdMs: 6000 })
          : say("no pomodoro running. say 'start pomodoro' to lock in.", { mood: "idle", holdMs: 6000 });
        return true;
      }
      if (Assistant.isPomodoroRunning()) {
        say("we already have a pomodoro going — " + Assistant.getPomodoroStatus() + ". say 'stop pomodoro' to end it.", { mood: "confused", holdMs: 7000 });
      } else {
        Assistant.startPomodoro("");
      }
      return true;
    }

    // Reminders: list & cancel
    if (/(reminder|timer)/.test(lower) && /(list|show|what|how many|any)/.test(lower)) {
      say(await Assistant.listRemindersText(), { mood: "idle", holdMs: 10000 });
      return true;
    }
    if (/(reminder|timer)/.test(lower) && /(cancel|delete|clear|forget)/.test(lower)) {
      say(await Assistant.cancelAllRemindersText(), { mood: "idle", holdMs: 6000 });
      return true;
    }

    // Not a local command — any pending name prompt quietly expires
    awaitingName = false;
    return false;
  }

  // Waits until the typewriter has fully displayed the current text
  // (six-second grace + up to 10s of polling), then runs the callback.
  function whenReplyDisplayed(cb) {
    let attempts = 0;
    const poll = () => {
      if (typewriterInterval === null || attempts > 40) cb();
      else { attempts++; setTimeout(poll, 250); }
    };
    setTimeout(poll, 600);
  }

  // --- User Chat Handler ---
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const text = input.value.trim();
    // empty text is fine when images are riding along — she just reacts to them
    if (text === "" && pendingImages.length === 0) return;
    input.value = "";
    inputContainer.style.display = "none";
    settingsModal.style.display = "none";
    await runChat(text);
  });

  // --- Pending image attachments (vision) ---
  const MAX_PENDING_IMAGES = 3;
  let pendingImages = [];

  function fileUrl(p) {
    return "file:///" + String(p).replace(/\\/g, "/").replace(/^\//, "");
  }

  function addPendingImage(info) {
    if (!info || !info.path) return;
    if (pendingImages.length >= MAX_PENDING_IMAGES) pendingImages.shift();
    pendingImages.push({ path: info.path, name: info.name || info.path.split(/[\\/]/).pop() });
    renderPendingImages();
  }

  function addPendingImageFromPath(p) {
    const ext = (p.split(".").pop() || "").toLowerCase();
    if (!["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(ext)) return;
    addPendingImage({ path: p, name: p.split(/[\\/]/).pop() });
  }

  function clearPendingImages() {
    pendingImages = [];
    imgChip.classList.remove("active");
  }

  function renderPendingImages() {
    if (!pendingImages.length) { imgChip.classList.remove("active"); return; }
    imgChip.classList.add("active");
    imgChipImg.src = fileUrl(pendingImages[pendingImages.length - 1].path);
    imgChipLabel.textContent = pendingImages.length === 1
      ? pendingImages[0].name
      : `${pendingImages.length} attached (latest: ${pendingImages[pendingImages.length - 1].name})`;
  }

  imgChipX.addEventListener("click", clearPendingImages);

  // ✂ snips a region of the screen — the crop attaches to the chat so
  // you can caption it (or send it bare)
  snipBtn.addEventListener("click", () => {
    snipAndLook("");
  });

  // Paste screenshots directly into the chat (Win+Shift+S or copied media)
  input.addEventListener("paste", (e) => {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    const imgs = files.filter(f => (f.type || "").startsWith("image/") || f.path && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.path));
    if (!imgs.length) return;
    e.preventDefault();
    (async () => {
      for (const f of imgs.slice(0, MAX_PENDING_IMAGES)) {
        try {
          if (f.path) {
            // File copied from disk — path travels with it
            addPendingImageFromPath(f.path);
          } else {
            // Raw bitmap data (Win+Shift+S style clipboard screenshot)
            const buf = new Uint8Array(await f.arrayBuffer());
            const info = await ipcRenderer.invoke("vision:save-image", buf);
            addPendingImage(info);
          }
        } catch (err) {
          say("couldn't grab that image. try ✂ or paste it.", { mood: "confused", holdMs: 4000 });
        }
      }
      input.focus();
    })();
  });

  // Drag & drop image files onto Ellie. Electron 45 removed File.path —
  // webUtils.getPathForFile is the replacement for files that exist on
  // disk. Files with no disk path (dragged out of a browser window or
  // clipboard-share) still carry raw bytes, so those get saved like a
  // paste. This is the path that never worked in 1.0.0 — it works now.
  window.addEventListener("dragover", (e) => { e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    let taken = 0;
    for (const f of files) {
      if (taken >= MAX_PENDING_IMAGES) break;
      let p = "";
      try { p = webUtils.getPathForFile(f) || f.path || ""; } catch (err) { p = f.path || ""; }
      if (p && /\.(png|jpe?g|webp|gif|bmp)$/i.test(p)) {
        addPendingImageFromPath(p);
        taken += 1;
      } else if ((f.type || "").startsWith("image/")) {
        // No disk path — image bytes only (browser drag, shared clipboard)
        f.arrayBuffer().then(buf =>
          ipcRenderer.invoke("vision:save-image", new Uint8Array(buf))
        ).then(info => { addPendingImage(info); })
          .catch(err => { say("couldn't grab that image. try ✂ or paste it.", { mood: "confused", holdMs: 4000 }); });
        taken += 1;
      }
    }
    if (files.length && !taken) {
      say("dropped something, but it's not an image — i only take pictures.", { mood: "confused", holdMs: 5000 });
    }
    inputContainer.style.display = "flex";
    input.focus();
  });

  // Natural-language trigger: she grabs the screen herself
  function wantsScreenshot(lower) {
    if (!/\b(screenshot|screen|desktop|monitor)\b/.test(lower)) return false;
    return /\bscreenshot\b|\b(look|looking|see|check|watch|describe|read|show|notice|peep|glance|analyze|explain|what)\b/.test(lower);
  }

  async function runChat(text, opts = {}) {
    // Attachments made since the last message ride along
    let images = opts.images ? [...opts.images] : [...pendingImages];
    clearPendingImages();

    // "look at my screen" style asks: grab the screenshot on the spot
    if (images.length === 0 && !opts.noAutoShot && wantsScreenshot(text.toLowerCase())) {
      try {
        images = [await ipcRenderer.invoke("vision:grab-screen")];
      } catch (e) {}
    }

    if (await handleLocalCommand(text, { hasImages: images.length > 0 })) return;

    // Consumed now — the chip empties and images go with the message
    clearPendingImages();

    Assistant.wakeIfAsleep();
    Sfx.init();
    Globals.busy = true;
    resetTypewriter();
    Orb.setMood("thinking");
    speech.innerHTML = "thinking...";
    speech.style.display = "block";
    startThinkingTicker();

    try {
      const sysContext = await ipcRenderer.invoke("get-system-context");
      const imageNote = images.length
        ? `\n[IMAGE${images.length > 1 ? "S" : ""} ATTACHED: ${images.map(i => i.name).join(", ")} — they are attached to this message and visible to you]`
        : "";
      const media = sysContext.nowPlaying || null;
      const msgBody = text || (images.length ? "(no words — just look at what i sent and react to it)" : "");
      const promptWithContext = `[DESKTOP CONTEXT: Time=${sysContext.time}, Active App=${sysContext.activeApp} (window: "${sysContext.activeWindow}"), User Idle=${sysContext.idleSeconds}s, RAM=${sysContext.ramUsagePercent}%, CPU=${sysContext.cpuPercent}%, Battery=${Assistant.getBatteryPct() !== null ? Assistant.getBatteryPct() + "%" : "unknown"}, Now Playing=${media ? `${media.app} — "${media.title}"` : "nothing"}]\n\nUser message: ${msgBody}${imageNote}`;

      Memory.addUser(text + (images.length ? ` (+${images.length} image${images.length > 1 ? "s" : ""})` : ""));
      const messages = LLM.buildMessages(promptWithContext);

      let firstTextLogged = false;
      const { parsed } = await LLM.stream(messages, {
        images,
        onMood: (mood) => Orb.setMood(mood),
        onText: (newText) => {
          // Live-render: start typing the moment real dialogue streams in
          stopThinkingTicker();
          targetText = newText;
          startTypewriter(true);
          if (!firstTextLogged && newText) {
            firstTextLogged = true;
            console.log(`[ui] text streaming started (${newText.length} chars so far)`);
          }
        }
      });

      stopThinkingTicker();
      Globals.busy = false;

      if (parsed.text && parsed.text.trim()) {
        console.log(`[ui] reply ok (${parsed.text.length} chars)`);
        // If the bubble was overwritten mid-stream (reminder, idle poke),
        // re-render Ellie's actual reply
        if (displayedText !== parsed.text.slice(0, displayedText.length)) {
          resetTypewriter();
        }
        targetText = parsed.text;
        startTypewriter(true);
        speechHoldUntil = Date.now() + 9500;
        armSpeechRetire(9500);
        if (parsed.mood) Orb.setMood(parsed.mood, 8000);
        Memory.addAssistant(parsed.text);
        // Speak the reply aloud when voice is enabled
        Assistant.speakReply(parsed.text);
      } else if (parsed.cutOff) {
        console.log("[ui] reply cut off mid-stream");
        Orb.setMood("confused", 6000);
        speech.innerHTML = "reply got cut off mid-stream — provider hiccup. try again?";
        armSpeechRetire(6000);
      } else {
        console.log("[ui] reply missing entirely");
        Orb.setMood("confused", 6000);
        speech.innerHTML = "...she said nothing. try again?";
        armSpeechRetire(6000);
      }

      if (parsed.remember) {
        // Names get the canonical pinned store (single "User's name is X")
        const nm = String(parsed.remember).trim().match(/^(?:user'?s|your) (?:name|nickname) is ([a-zA-Z' -]{2,30})\.?$/i);
        if (nm && !Memory.getUserName()) Memory.setUserName(nm[1].trim());
        else Memory.addMemory(parsed.remember);
      }

      if (parsed.action) {
        // Let Ellie's own dialogue finish typing before the action's
        // confirmation takes over the bubble
        whenReplyDisplayed(() => Assistant.handleAction(parsed.action, { userText: text }));
      }
    } catch (err) {
      console.error("LLM Provider Error:", err);
      stopThinkingTicker();
      Globals.busy = false;
      Orb.setMood("annoyed", 6000);
      speech.innerHTML = `something's off: ${err.message || "connection failed."}`;
      armSpeechRetire(8000);
    }
  }

  // Screenshot action coming back from the LLM ("{"type":"screenshot"}")
  async function lookAtScreen() {
    if (Globals.isBusy()) return;
    try {
      const info = await ipcRenderer.invoke("vision:grab-screen");
      await runChat(
        "[automatic message] the user just asked you to look at their screen — a screenshot of their desktop is attached. react to it / describe what you see.",
        { images: [info] }
      );
    } catch (e) {
      say("screen peek failed. unsettling.", { mood: "confused", holdMs: 4000 });
    }
  }

  // --- Mic (local whisper dictation, push-to-talk) ---
  // Click 🎤 to start, click again (or 15s auto-stop) to transcribe.
  let recording = null;
  const MAX_RECORD_MS = 15000;

  function encodeWav(samples, sampleRate) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, 1, true);   // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++, off += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Uint8Array(buf);
  }

  async function startRecording() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    } catch (e) {
      say("mic access denied. un-park it in windows settings, then try again.", { mood: "confused", holdMs: 6000 });
      return;
    }
    const ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    // Muted gain keeps the script processor alive without echo playback
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    proc.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    recording = { stream, ctx, chunks, startedAt: Date.now() };
    micBtn.textContent = "⏺";
    micBtn.classList.add("recording");
    say("listening... (click me again to stop)", { mood: "thinking", holdMs: MAX_RECORD_MS + 1000 });
    recording.timer = setTimeout(() => stopRecording(), MAX_RECORD_MS);
  }

  async function stopRecording() {
    if (!recording) return;
    const rec = recording;
    recording = null;
    clearTimeout(rec.timer);
    micBtn.textContent = "🎤\uFE0E";
    micBtn.classList.remove("recording");
    try { rec.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { rec.ctx.close(); } catch (e) {}

    speech.innerHTML = "transcribing...";
    const pcm = new Float32Array(rec.chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of rec.chunks) { pcm.set(c, off); off += c.length; }
    if (pcm.length < rec.ctx.sampleRate * 0.4) {
      say("that was basically silence, bro.", { mood: "confused", holdMs: 4000 });
      return;
    }
    const wav = encodeWav(pcm, rec.ctx.sampleRate);
    const res = await ipcRenderer.invoke("listen-whisper", wav.buffer).catch(e => ({ error: e.message }));
    if (!res || res.error) {
      say(`${res && res.error === "no speech detected" ? "didn't catch any words. speak up a little." : "ear glitch: " + (res && res.error)}`, { mood: "confused", holdMs: 5000 });
      return;
    }
    inputContainer.style.display = "flex";
    input.value = res.transcript;
    input.focus();
    Orb.setMood("thinking", 3000);
  }

  micBtn.addEventListener("click", async () => {
    if (micBtn.disabled) return;
    if (recording) {
      stopRecording();
      return;
    }
    micBtn.disabled = true;
    try {
      const pre = await ipcRenderer.invoke("listen-preflight");
      if (pre.ready) {
        micBtn.disabled = false;
        await startRecording();
      } else if (pre.downloading) {
        micBtn.textContent = "⬇";
        say("first run: downloading my ears, ~150MB, one time only. this will take a minute or two.", { mood: "thinking", holdMs: 30000 });
        // mic-progress events flip the button back on when ready
      }
    } catch (e) {
      micBtn.disabled = false;
    }
  });

  ipcRenderer.on("mic-progress", (_e, p) => {
    if (!p) return;
    if (p.phase === "download" && p.pct !== undefined && p.pct % 10 === 0) {
      const last = speech.innerHTML;
      if (last.includes("downloading my ears") || last.includes("%")) {
        speech.innerHTML = `downloading ${p.label} ${p.pct}%...`;
      }
    } else if (p.phase === "ready") {
      micBtn.textContent = "🎤\uFE0E";
      micBtn.disabled = false;
      say("ears online. hit 🎤 and talk, click again to stop.", { mood: "happy", holdMs: 7000 });
    } else if (p.phase === "error") {
      micBtn.textContent = "🎤\uFE0E";
      micBtn.disabled = false;
      say(`ear download failed: ${p.message || "unknown"}`, { mood: "sad", holdMs: 6000 });
    }
  });

  // --- Window drag from canvas + mouse handling ---
  let isMouseDown = false;
  let startX = 0, startY = 0;

  let isIgnoringMouse = false;

  function isOverAnything(rects, x, y) {
    for (const r of rects) {
      if (r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  }

  window.addEventListener("mousemove", (e) => {
    // Eye tracking (skip while dragging so the eyes calm down)
    if (!isMouseDown) Orb.updateCursor(e.clientX, e.clientY);

    // Window drag
    if (isMouseDown) {
      const dx = e.screenX - startX;
      const dy = e.screenY - startY;
      startX = e.screenX;
      startY = e.screenY;
      ipcRenderer.send("move-window", { x: dx, y: dy });
      return; // dragging = always interactive
    }

    // Hit-testing for mouse pass-through (bubble, input, mic, settings, orb)
    const hitRects = [];
    if (speech.style.display !== "none") hitRects.push(speech.getBoundingClientRect());
    if (inputContainer.style.display !== "none") hitRects.push(inputContainer.getBoundingClientRect());
    if (imgChip.classList.contains("active")) hitRects.push(imgChip.getBoundingClientRect());
    if (settingsModal.style.display !== "none") hitRects.push(settingsModal.getBoundingClientRect());
    if (memoryModal.style.display !== "none") hitRects.push(memoryModal.getBoundingClientRect());

    let isOverInteractive = isOverAnything(hitRects, e.clientX, e.clientY);

    const canvasRect = Orb.canvas.getBoundingClientRect();
    const relX = e.clientX - canvasRect.left;
    const relY = e.clientY - canvasRect.top;
    const dist = Math.hypot(relX - 90, relY - Orb.getBounceY());
    if (dist <= 65) isOverInteractive = true;

    if (isOverInteractive && isIgnoringMouse) {
      isIgnoringMouse = false;
      ipcRenderer.send("set-ignore-mouse-events", false);
    } else if (!isOverInteractive && !isIgnoringMouse) {
      isIgnoringMouse = true;
      ipcRenderer.send("set-ignore-mouse-events", true, { forward: true });
    }
  });

  Orb.canvas.addEventListener("mousedown", (e) => {
    if (e.button === 0) {
      isMouseDown = true;
      startX = e.screenX;
      startY = e.screenY;
      // grabbing her = the clearest "not hidden anymore" signal; dragging
      // also un-pins her so the director can tuck her again when idle
      if (Director.isHidden()) Director.popOut(false, false);
      Director.unpin();
    }
  });

  window.addEventListener("mouseup", () => { isMouseDown = false; });

  // --- Right Click to Toggle Chat Bar ---
  // While she's tucked under the taskbar, right-click pops her out and
  // pins her there — she stays until you drag her somewhere.
  window.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    Director.unpin();
    if (Director.isHidden()) {
      Director.popOut(true, true);
      return;
    }
    const isVisible = inputContainer.style.display === "flex";
    inputContainer.style.display = isVisible ? "none" : "flex";
    if (!isVisible) input.focus();
    else settingsModal.style.display = "none";
  });

  // --- Summon hotkey (registered in main, global) pops the chat bar ---
  // Ctrl+Alt+E does double duty: while she's mid pc-task, the same combo
  // slams the brakes instead — one key to summon, one key to stop her hands.
  ipcRenderer.on("ui:summon", () => {
    if (Assistant.pcTaskActive()) {
      Assistant.requestStop();
      say("stopping... your mouse is coming back to you.", { mood: "idle", holdMs: 5000, speak: true });
      return;
    }
    // summoning always brings her fully out of any hidey-hole
    Director.popOut(false, false);
    inputContainer.style.display = "flex";
    input.focus();
    // a tiny greeting when she's free — skipped silently mid-conversation
    mutter(pickSummonLine(), { holdMs: 2600 });
  });

  // --- Speech bubble + chat input/buttons accent color follow the mood palette ---
  setInterval(() => {
    const halo = Orb.toHaloStr(0.6);
    speech.style.borderColor = halo;
    speech.style.boxShadow = `0 4px 18px ${Orb.toHaloStr(0.25)}`;
    // Chat input + buttons tint with the same mood fade (recording mic keeps its red)
    input.style.borderColor = Orb.toHaloStr(0.55);
    if (!micBtn.classList.contains("recording")) {
      micBtn.style.borderColor = Orb.toHaloStr(0.55);
      micBtn.style.color = Orb.toEyeStr(0.9);
    }
    snipBtn.style.borderColor = Orb.toHaloStr(0.55);
    snipBtn.style.color = Orb.toEyeStr(0.9);
    imgChip.style.borderColor = Orb.toHaloStr(0.5);
  }, 250);

  // --- Update panel: new version notices straight from her releases ---
  // Main broadcasts "ui:update"; the panel walks through available →
  // downloading → downloaded, and the button does the rest. "Later"
  // just tucks the panel away until her next look at GitHub.
  const updateModal = document.getElementById("update-modal");
  const updateNotes = document.getElementById("update-notes");
  const updateStatus = document.getElementById("update-status");
  const updateBtn = document.getElementById("update-btn");
  const updateLaterBtn = document.getElementById("update-later-btn");
  let updateData = null;
  let updateDismissed = false;

  function applyUpdateState(u) {
    if (!updateModal || !u || !u.supported) return;
    const first = !updateData;
    updateData = u;
    if (updateDismissed && (u.downloaded || u.error)) updateDismissed = false; // these come with news

    if (!u.available) {
      hideUpdatePanel();
      return;
    }
    if (updateDismissed && !u.downloaded && !u.error) return;

    let line = "";
    if (u.error) line = "update download hiccupped: " + u.error;
    else if (u.downloaded) line = "downloaded. one restart and she's new.";
    else if (u.downloading) line = "downloading... " + (u.progress || 0) + "%";
    else line = "";
    updateStatus.textContent = line;

    updateBtn.textContent =
      u.downloaded ? "Restart & Update" :
      u.downloading ? "Downloading..." : "Download & Install";
    updateBtn.disabled = !!u.downloading;

    if (first || u.downloaded) {
      showUpdatePanel(u);
      if (first && !u.downloading) {
        say(`heads up — ellie ${u.version} is out. changelog's in the panel. 🖤`, { mood: "thinking", holdMs: 9000 });
      }
    }
  }

  function showUpdatePanel(u) {
    const short = String(u.notes || "").trim().replace(/\r/g, "");
    const body = short
      ? short.split("\n").filter(l => l.trim() && !/^#/.test(l)).slice(0, 8).join("\n")
      : "(no notes, just trust her)";
    updateNotes.textContent = "ellie " + u.version + " is out:\n" + body;
    updateModal.style.display = "block";
    memoryModal.style.display = "none";
    settingsModal.style.display = "none";
  }

  function hideUpdatePanel() {
    updateModal.style.display = "none";
  }

  updateBtn.addEventListener("click", async () => {
    if (!updateData) return;
    if (updateData.downloaded) {
      await ipcRenderer.invoke("updater:install");
      return;
    }
    if (!updateData.downloading) {
      updateBtn.disabled = true;
      await ipcRenderer.invoke("updater:download");
    }
  });

  updateLaterBtn.addEventListener("click", () => {
    updateDismissed = true;
    hideUpdatePanel();
  });

  ipcRenderer.on("ui:update", (_e, u) => applyUpdateState(u));
  ipcRenderer.invoke("updater:status").then(u => applyUpdateState(u)).catch(() => {});

  // --- Thought bubble: quiet asides to herself ---
  function mutter(text, { holdMs = 9000, force = false } = {}) {
    if (!thoughtBubbleEl) return false;
    // During computer tasks she narrates while "busy" — force bypasses
    // that check only; live conversations still own the airspace.
    const speechStale = speech.style.display !== "none" && Date.now() > speechHoldUntil;
    if (!force && (Globals.isBusy() || typewriterInterval !== null)) {
      console.log("[ui] mutter skipped: she is talking");
      return false;
    }
    if (Date.now() < speechHoldUntil && !speechStale) {
      console.log("[ui] mutter skipped: no room (speech hold)");
      return false;
    }
    thoughtBubbleEl.textContent = text;
    thoughtBubbleEl.classList.add("show");
    if (mutterTimer) clearTimeout(mutterTimer);

    // Adaptive placement: hug her head — right above the orb, whether or
    // not a speech bubble is present (the speech bubble only sets the
    // ceiling the mutter must stay below).
    const height = thoughtBubbleEl.offsetHeight;
    const canvasTop = Orb.canvas.getBoundingClientRect().top;
    let maxTop = Math.round(canvasTop - height - 10);
    let minTop = speech.style.display !== "none" ? Math.round(speech.getBoundingClientRect().bottom + 8) : 4;
    // If the speech bubble is stale (hold expired) and hogs the room,
    // it yields: retire it so the mutter can hug her head.
    if (minTop > maxTop && speechStale) {
      speech.style.display = "none";
      speechHoldUntil = 0;
      minTop = 4;
    }
    if (minTop > maxTop) {
      console.log("[ui] mutter skipped: no room (" + height + "px needed, " + (canvasTop - minTop) + "px free)");
      thoughtBubbleEl.classList.remove("show");
      return false;
    }
    const top = Math.max(minTop, maxTop - Math.round(Math.random() * 10)); // hug her head, tiny jitter
    thoughtBubbleEl.style.top = Math.round(top) + "px";

    mutterTimer = setTimeout(() => {
      thoughtBubbleEl.classList.remove("show");
      mutterTimer = null;
    }, holdMs);
    return true;
  }

  // Lets other modules check "is she currently saying something out loud?"
  function speechActive() {
    return Globals.isBusy() || typewriterInterval !== null || Date.now() < speechHoldUntil;
  }

  // ============================================================
  // Homing director — she lives on your screen like a creature:
  //   • semi-idle: hops to a new spot now and then (never while busy)
  //   • idle longer: tucks under the taskbar bottom-right, top half
  //     peeking out (z-order drops so the taskbar covers her body)
  //   • peeks up periodically while hidden, sleeps on if she was
  //   • any interaction pops her back; right-click pops her AND pins
  //     her there (no auto-tucking until you drag her somewhere)
  // ============================================================
  const Director = (() => {
    const FAST = location.search.includes("autotest=idle"); // shrinks timers for e2e probes
    const T = FAST
      ? { wanderAfter: 6, hideAfter: 12, wanderEvery: 10, peekFirst: 7, peekMin: 7, peekMax: 10, peekHold: 2500, climbOutAfter: 20 }
      : { wanderAfter: 90, hideAfter: 180, wanderEvery: 150, peekFirst: 20, peekMin: 26, peekMax: 56, peekHold: 3000, climbOutAfter: 900 };
    const WIN_W = 320, WIN_H = 380;
    // Window layout truth (from index.html): #app packs everything at the
    // bottom with 20px padding and centers it — so the 180px canvas sits at
    // the bottom of the window, horizontally centered. Orb drawing (orb.js):
    // body radius ~57 centered at canvas (90, 88+bob), floor shadow at y=162.
    const CANVAS_LEFT = (WIN_W - 180) / 2;  // 70
    const CANVAS_TOP = WIN_H - 20 - 180;    // 180
    const ORB_CX = CANVAS_LEFT + 90;        // 160 — orb center X inside the window
    const ORB_CY = CANVAS_TOP + 88;         // 268 — orb center Y inside the window
    const ORB_R = 57;                       // orb body radius
    const FEET_Y = CANVAS_TOP + 162;        // 342 — floor-shadow line inside the window
    const TUCK_DEPTH = 26;                  // orb center sits this far above the taskbar top → half under, eyes visible
    const PEEK_RISE = 34;                   // how far she rises on a peek

    let wa = { x: 0, y: 0, width: 1920, height: 1020 };
    let known = null;        // last commanded position (avoids screenX lag)
    let hidden = false, pinned = false;
    let hiddenX = 0, hiddenY = 0, hiddenAt = 0;
    let nextWander = 0, peekTimer = null;

    // Main echoes the REAL window position after every placement — manual
    // drags included (the drag path sends raw deltas and she'd otherwise
    // never learn where she actually is; summon would fly her back to a
    // stale spot from before the drag).
    ipcRenderer.on("window-pos", (_e, p) => {
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        known = { x: Math.round(p.x), y: Math.round(p.y) };
      }
    });

    function clampX(x) {
      // keep the orb body (center ORB_CX px in from the window's left edge)
      // fully on screen horizontally
      const cMin = wa.x + ORB_R + 4, cMax = wa.x + wa.width - ORB_R - 4;
      return Math.max(cMin - ORB_CX, Math.min(x, cMax - ORB_CX));
    }
    function clampY(y) {
      // keep the orb body fully on screen vertically
      const cMin = wa.y + ORB_R + 6, cMax = wa.y + wa.height - ORB_R - 6;
      return Math.max(cMin - ORB_CY, Math.min(y, cMax - ORB_CY));
    }
    function place(x, y, onTop) {
      known = { x: Math.round(x), y: Math.round(y) };
      ipcRenderer.send("set-window-pos", { x: known.x, y: known.y, onTop: !!onTop });
      console.log(`[director] place ${known.x},${known.y} onTop=${!!onTop}`);
    }
    function glideTo(x2, y2, onTop, ms, done) {
      if (!known) known = { x: Math.round(window.screenX), y: Math.round(window.screenY) };
      const from = { ...known };
      const steps = Math.max(3, Math.round(ms / 30));
      let i = 0;
      const iv = setInterval(() => {
        i++;
        const t = Math.min(1, i / steps);
        const e = 1 - (1 - t) * (1 - t); // ease-out
        place(from.x + (x2 - from.x) * e, from.y + (y2 - from.y) * e, onTop);
        if (t >= 1) { clearInterval(iv); if (done) setTimeout(done, 80); }
      }, 30);
    }

    // Perch: standing fully on top of the taskbar edge (floor shadow ~14px above it)
    function perchY() { return wa.y + wa.height - FEET_Y - 14; }
    // Chat-bar placement: while she's tucked low (window bottom under the
    // taskbar) the bar floats at the top of the window so it sits above
    // her peeking head instead of drowning under the taskbar.
    function setInputLayout(tucked) {
      inputContainer.classList.toggle("tucked", !!tucked);
    }
    function popOut(pin, showInput) {
      if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
      const wasHidden = hidden;
      hidden = false;
      if (pin) pinned = true;
      if (known) glideTo(clampX(known.x), perchY(), true, 500);
      if (showInput) {
        inputContainer.style.display = "flex";
        setInputLayout(wasHidden); // tucked chat bar only when popping from under the taskbar
        input.focus();
        mutter("hm? i wasn't hiding. i was being decorative down there.", { holdMs: 3600 });
      } else {
        setInputLayout(false);
        if (wasHidden) {
          mutter("peek-a-boo. i'm still here.", { holdMs: 3000 });
        }
      }
      console.log(`[director] popped out (pin=${!!pin})`);
    }
    function unpin() { pinned = false; }

    function hideNow() {
      // She slides down so the taskbar covers her lower half — the orb
      // center ends up TUCK_DEPTH px above the taskbar's top edge, which
      // leaves her eyes and upper face visible (even while napping).
      hiddenX = wa.x + wa.width - ORB_CX - 90; // orb center ~90px in from the screen's right edge
      hiddenY = wa.y + wa.height - ORB_CY - TUCK_DEPTH;
      hidden = true;
      hiddenAt = Date.now();
      setInputLayout(false);
      glideTo(hiddenX, hiddenY, false, 1100, () => { schedulePeek(T.peekFirst * 1000); });
      console.log(`[director] tucking under the taskbar at ${hiddenX},${hiddenY} (half-under, eyes visible)`);
    }

    function schedulePeek(delay) {
      if (!hidden) return;
      if (peekTimer) clearTimeout(peekTimer);
      peekTimer = setTimeout(() => {
        if (!hidden) return;
        // napping — she stays put with her eyes closed and peeks later
        if (Orb.isAsleep()) { schedulePeek(T.peekMin * 1000); return; }
        glideTo(hiddenX, hiddenY - PEEK_RISE, false, 420, () => {
          setTimeout(() => {
            if (!hidden) return;
            glideTo(hiddenX, hiddenY, false, 420, () => {
              schedulePeek(T.peekMin * 1000 + Math.random() * (T.peekMax - T.peekMin) * 1000);
            });
          }, T.peekHold + Math.random() * 1800);
        });
        console.log("[director] peek");
      }, delay);
    }

    function canAutoHide() {
      return !pinned && !Globals.isBusy() &&
        inputContainer.style.display !== "flex" &&
        settingsModal.style.display !== "block" &&
        memoryModal.style.display !== "block" &&
        speech.style.display !== "block";
    }

    async function poll() {
      try {
        const sys = await ipcRenderer.invoke("get-system-context");
        if (!known) known = { x: Math.round(window.screenX), y: Math.round(window.screenY) };
        if (sys.workArea) wa = sys.workArea;
        const idle = sys.idleSeconds || 0;

        if (Globals.isBusy()) {
          if (hidden) popOut(false, false);
          return;
        }

        if (hidden) {
          // napping — she stays tucked until the sleep watcher wakes her
          if (Orb.isAsleep()) return;
          // you're back — she climbs out on her own
          if (idle < T.wanderAfter * 0.5) popOut(false, false);
          // or she gets restless on her own — even a good hiding spot
          // gets boring after a while
          else if (hiddenAt && Date.now() - hiddenAt >= T.climbOutAfter * 1000) {
            console.log("[director] climbed out on her own (bored of hiding)");
            popOut(false, false);
          }
          return;
        }

        if (!canAutoHide()) return;

        if (idle >= T.hideAfter) {
          hideNow();
        } else if (idle >= T.wanderAfter && Date.now() >= nextWander) {
          nextWander = Date.now() + T.wanderEvery * 1000 + Math.random() * 60000;
          const y = clampY(wa.y + 40 + Math.random() * (wa.height - 260));
          const x = clampX(wa.x + 40 + Math.random() * (wa.width - WIN_W - 60));
          glideTo(x, y, true, 750);
          console.log("[director] wander");
        }
      } catch (e) {}
    }

    setInterval(poll, FAST ? 1500 : 4000);
    if (FAST) {
      // e2e sanity log: director is alive and idle counting
      console.log("[autotest] director: fast-idle mode, timers shrunk");
    }

    return {
      popOut,
      unpin,
      isHidden: () => hidden
    };
  })();

  // --- Wake hooks: any personal interaction pops her back out ---
  window.addEventListener("ellie:poked", () => Director.popOut(false, false));

  // --- Bedtime / morning, driven by the sleep watcher in Assistant ---
  // Bedtime overrides everything (even a pin) except a live pc task.
  window.addEventListener("ellie:bedtime", () => {
    if (Globals.isBusy()) return;
    pinned = false;
    if (!hidden) hideNow();
    console.log("[director] bedtime — tucking in for the night");
  });
  window.addEventListener("ellie:wake", () => {
    if (hidden) popOut(false, false);
  });

  // --- Snip-a-region (✂ / "snip: ...") — she sees ONLY what you drag ---
  // The crop lands in the attachment chip, NOT auto-sent: you type a note
  // (or nothing) and send it yourself.
  let snipWaiting = false;
  async function snipAndLook(note) {
    if (snipWaiting) return;
    snipWaiting = true;
    let res;
    try {
      res = await ipcRenderer.invoke("snip:start");
    } catch (e) {
      res = { ok: false, error: e.message };
    }
    if (!res || !res.ok) {
      snipWaiting = false;
      say(`snip failed — ${res && res.error ? res.error : "unknown universe glitch"}`, { mood: "confused", holdMs: 5000 });
      return;
    }
    ipcRenderer.once("snip:image", (_e, info) => {
      snipWaiting = false;
      if (!info || info.canceled) {
        say("snip canceled. wasn't looking anyway.", { mood: "idle", holdMs: 4000 });
        return;
      }
      addPendingImage(info);
      if (note) input.value = note; // "snip: <text>" pre-fills your caption
      inputContainer.style.display = "flex";
      input.focus();
      mutter("snipped. add words if you want, then send it.", { holdMs: 4000 });
    });
  }

  // --- Init ---
  function init() {
    greet();
    // ESC = pull the plug on any running computer task
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && Assistant.pcTaskActive()) {
        Assistant.requestStop();
        say("escape! hands off, task dropped.", { mood: "sad", holdMs: 5000 });
      }
    });
  }

  return { init, say, mutter, speechActive, runChat, lookAtScreen, openSettingsPanel, openMemoryPanel };
})();
