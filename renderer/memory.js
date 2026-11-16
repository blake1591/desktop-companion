// ============================================================
// Memory — conversation history (session-persistent) and
// long-term facts Ellie can save about the user.
// ============================================================
const Memory = (() => {
  const HISTORY_KEY = "ellie_history";
  const MEMORIES_KEY = "ellie_memories";

  const MAX_HISTORY = 60;   // turns kept in localStorage
  const MAX_CONTEXT = 12;   // recent turns sent to the LLM
  const MAX_MEMORIES = 25;

  let history = load(HISTORY_KEY) || [];   // [{ role: "user"|"assistant", text, at }]
  let memories = load(MEMORIES_KEY) || []; // [{ text, at, pinned? }]

  // Boot-time sanitizer: over-eager remembering used to store conversation
  // META as if it were a fact ("User asked to open the memory book") — and
  // rule 4 ("use memory naturally") then kept nudging her to open panels.
  // Drop unpinned meta entries once, at startup.
  (function scrubMetaMemories() {
    const META = /user (?:asked|ask|wants|wanted|requested|requests|opened?|told me to|likes? to) (?:me |us |to )?(?:open|show|see|view|check|use|display)(?:ing)? (?:the |her |my |your )?(?:memory|memories|settings|config|book|panel)/i;
    const before = memories.length;
    memories = memories.filter(m => m.pinned || !META.test(m.text));
    if (memories.length !== before) {
      persistMemories();
      console.log(`[memory] scrubbed ${before - memories.length} meta entr${before - memories.length === 1 ? "y" : "ies"} at boot`);
    }
  })();

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  function persistHistory() {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }

  function persistMemories() {
    localStorage.setItem(MEMORIES_KEY, JSON.stringify(memories));
  }

  function addUser(text) {
    history.push({ role: "user", text: String(text), at: Date.now() });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    persistHistory();
  }

  function addAssistant(text) {
    if (!text) return;
    history.push({ role: "assistant", text: String(text), at: Date.now() });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    persistHistory();
  }

  // Recent turns formatted for the LLM (oldest → newest)
  function getContextMessages() {
    return history
      .slice(-MAX_CONTEXT)
      .map(m => ({ role: m.role, content: m.text }));
  }

  // Match a memory by exact text, then prefix, then substring (used by
  // panel edits and "forget that ..." chat commands)
  function findMemory(text) {
    const lower = String(text).trim().toLowerCase();
    if (!lower) return null;
    return memories.find(m => m.text.toLowerCase() === lower) ||
           memories.find(m => m.text.toLowerCase().startsWith(lower)) ||
           memories.find(m => m.text.toLowerCase().includes(lower)) || null;
  }

  function setPinned(m, pinned) {
    if (pinned) m.pinned = true; else delete m.pinned;
    persistMemories();
  }

  function addMemory(text) {
    if (!text) return false;
    const normalized = String(text).trim();
    if (!normalized || normalized.length > 200) return false;

    // Cheap dedupe (case-insensitive match)
    const lower = normalized.toLowerCase();
    if (memories.some(m => m.text.toLowerCase() === lower)) return false;

    memories.push({ text: normalized, at: Date.now() });
    if (memories.length > MAX_MEMORIES) {
      // Cleanup can't take starred memories — drop the oldest unpinned
      // entry instead (oldest overall once everything is pinned)
      const idx = memories.findIndex(m => !m.pinned);
      if (idx === -1) memories.shift();
      else memories.splice(idx, 1);
    }
    persistMemories();
    return true;
  }

  // --- Canonical name handling ---
  const NAME_PREFIX = "User's name is";

  function getUserName() {
    const m = memories.find(x => x.text.toLowerCase().startsWith(NAME_PREFIX.toLowerCase()));
    return m ? m.text.slice(NAME_PREFIX.length).trim() : null;
  }

  // One canonical name memory (pinned — replaces any previous one)
  function setUserName(rawName) {
    const name = String(rawName || "").trim().replace(/\s+/g, " ");
    if (!name || name.length > 30) return false;
    const full = `${NAME_PREFIX} ${name}`;
    const existing = memories.find(m => m.text.toLowerCase().startsWith(NAME_PREFIX.toLowerCase()));
    if (existing) {
      existing.text = full;
      existing.pinned = true;
    } else {
      memories.push({ text: full, at: Date.now(), pinned: true });
      if (memories.length > MAX_MEMORIES) {
        const idx = memories.findIndex(m => !m.pinned);
        if (idx === -1) memories.shift();
        else memories.splice(idx, 1);
      }
    }
    persistMemories();
    return true;
  }

  function removeMemory(text) {
    const m = findMemory(text);
    if (!m) return false;
    memories.splice(memories.indexOf(m), 1);
    persistMemories();
    return true;
  }

  function editMemory(oldText, newText) {
    const m = findMemory(oldText);
    const normalized = String(newText || "").trim();
    if (!m || !normalized || normalized.length > 200) return false;
    // Dedupe against every *other* memory
    const lower = normalized.toLowerCase();
    if (memories.some(o => o !== m && o.text.toLowerCase() === lower)) return false;
    m.text = normalized;
    persistMemories();
    return true;
  }

  function pinMemory(text, pinned = true) {
    const m = findMemory(text);
    if (!m) return false;
    if (!!m.pinned !== !!pinned) setPinned(m, pinned);
    return true;
  }

  // Panel view: pinned first, every entry as a plain copy
  function getMemories() {
    return [...memories.filter(m => m.pinned), ...memories.filter(m => !m.pinned)]
      .map(m => ({ text: m.text, at: m.at, pinned: !!m.pinned }));
  }

  // Bullet list injected into the system prompt (pinned entries lead)
  function getMemoriesBlock() {
    if (memories.length === 0) return "";
    const ordered = [...memories.filter(m => m.pinned), ...memories.filter(m => !m.pinned)];
    const lines = ordered.map(m => `- ${m.text}${m.pinned ? " ★" : ""}`).join("\n");
    return `\n\n[LONG-TERM MEMORY about the user — ★ entries are pinned core facts that matter most; use naturally when relevant, never recite it verbatim]\n${lines}`;
  }

  function wipeHistory() {
    history = [];
    localStorage.removeItem(HISTORY_KEY);
  }

  function wipeMemories() {
    memories = [];
    localStorage.removeItem(MEMORIES_KEY);
  }

  function wipeAll() {
    wipeHistory();
    wipeMemories();
    wipeJournal();
  }

  // --- Journal: what the user said and what she did, day by day ---
  // Distinct from memories: memories are curated FACTS (name, favorites,
  // projects). The journal is the raw diary — every chat line and every
  // deterministic event (tasks, reminders, searches), grouped by the
  // user's LOCAL calendar day. It answers "how was my week".
  const JOURNAL_KEY = "ellie_journal";
  const MAX_JOURNAL = 500;                // entries kept (weeks of use)
  let journalLog = load(JOURNAL_KEY) || []; // [{ text, at, source }]

  function persistJournal() {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journalLog));
  }

  function journal(text, source = "chat") {
    let t = String(text || "").trim();
    if (!t) return false;
    if (t.length > 200) t = t.slice(0, 200);
    // An exact repeat of the freshest entry within a minute is a double
    // fire, not a second diary line — skip it. Anything older is real.
    const last = journalLog[journalLog.length - 1];
    if (last && last.text === t && Date.now() - last.at < 60000) return false;
    journalLog.push({ text: t, at: Date.now(), source });
    if (journalLog.length > MAX_JOURNAL) journalLog = journalLog.slice(-MAX_JOURNAL);
    persistJournal();
    return true;
  }

  // Calendar day in the user's own timezone — her diaries follow THEIR
  // midnight, not UTC's.
  function localDay(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  // Recent days, newest first: [{ day, entries: [{text, at, source}] }]
  function getJournalDays(nDays = 7) {
    const groups = {};
    for (const e of journalLog) {
      const day = localDay(e.at);
      (groups[day] = groups[day] || []).push(e);
    }
    return Object.keys(groups).sort().reverse().slice(0, nDays)
      .map(day => ({ day, entries: groups[day] }));
  }

  // Prompt block for "how was my day/week" — getMemoriesBlock's diary twin
  function getJournalBlock(nDays = 7) {
    const days = getJournalDays(nDays);
    if (!days.length) return "";
    return days.map(({ day, entries }) =>
      `${day}:\n` + entries.map(e => {
        const t = new Date(e.at);
        const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
        return `- ${hhmm} ${e.source === "event" ? "(she did) " : "(you said) "}${e.text}`;
      }).join("\n")
    ).join("\n");
  }

  function wipeJournal() {
    journalLog = [];
    localStorage.removeItem(JOURNAL_KEY);
  }

  // --- Day counter: "day N of ellie" ---
  const DAY_ONE_KEY = "ellie_day_one";
  let dayOne = load(DAY_ONE_KEY);
  if (!dayOne) {
    dayOne = Date.now();
    localStorage.setItem(DAY_ONE_KEY, JSON.stringify(dayOne));
  }

  // Whole days elapsed since she first ran, +1 — so the day she's
  // installed on is "day 1 of ellie", the next real day is day 2.
  function getDayCount() {
    const [y1, m1, d1] = localDay(dayOne).split("-").map(Number);
    const [y2, m2, d2] = localDay(Date.now()).split("-").map(Number);
    const diff = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
    return diff + 1;
  }

  function getDayOne() { return dayOne; }

  return {
    addUser,
    addAssistant,
    getContextMessages,
    getUserName,
    setUserName,
    addMemory,
    removeMemory,
    editMemory,
    pinMemory,
    getMemories,
    getMemoriesBlock,
    wipeHistory,
    wipeMemories,
    wipeJournal,
    wipeAll,
    journal,
    getJournalDays,
    getJournalBlock,
    getDayCount,
    getDayOne
  };
})();
