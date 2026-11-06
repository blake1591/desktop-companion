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
  }

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
    wipeAll
  };
})();
