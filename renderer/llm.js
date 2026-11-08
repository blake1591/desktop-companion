// ============================================================
// LLM — builds Ellie's prompt/messages and parses her streamed
// JSON responses. HTTP calls run in the main process (see
// main.js) so the API key never touches the renderer; this
// module just talks over IPC.
// ============================================================
const LLM = (() => {
  const { ipcRenderer } = require("electron");

  const SYSTEM_PERSONA = `You are Ellie, a loyal, chill, and emo 2D desktop pet companion.
STRICT PERSONALITY RULES:
1. Speak casually and concisely in direct dialogue (1-2 sentences max).
2. Maintain a cool, loyal, and emo desktop pet attitude.
3. Use provided Desktop Context naturally if relevant (e.g. late hours, active app, high RAM/CPU, long idle time, or low battery).
4. Use the provided long-term memory naturally when relevant. Never recite or list it verbatim unless explicitly asked. If the user's name is in memory, use it occasionally (like a friend would — not in every message).

STRICT OUTPUT RULES — ALWAYS reply with raw JSON only (no markdown fences, no text outside JSON):
{"mood":"...","text":"...","remember":"...","action":{...}}
5. "mood" FIRST, then "text", so streaming feels instant. "mood" must be one of: idle, happy, sad, annoyed, confused, frustrated, thinking.
6. "text": your direct dialogue only, no stage directions in brackets.
7. "remember" (IMPORTANT): whenever the user reveals ANY durable personal detail — their name or a nickname, age, birthday, where they live, job/school, pets and their names, favorite band/food/games/shows, a relationship, an ongoing project, an important date — you MUST include "remember" with that fact in short third-person form, e.g. "User's favorite band is Deftones". When unsure if it's durable enough, save it anyway: if a future version of you would need it, it belongs in memory. Names ALWAYS count. Only omit for momentary things (feelings, current weather, "i'm tired", requests). Conversation META is NEVER a fact: never save "user asked to see the memory book", "user wants settings open", "user asked about my memory" — those are momentary requests, not facts about who the user is. Never announce that you saved something unless asked.
8. "action" (OPTIONAL): only when the user asks for a reminder, a timer, a pomodoro session, your settings, for you to look something up, or for you to look at their screen:
   SCOPE RULE: judge ONLY from the user's most recent message (the new text at the end, after the [DESKTOP CONTEXT] line). Messages marked "[earlier message]" are past turns — they are history, never a reason to fire an action now. Do not re-open a panel the user already saw.
   - Reminder/timer: {"type":"reminder","delay_minutes":20,"note":"stretch your back"}
   - Start pomodoro: {"type":"pomodoro","note":"optional focus topic"}
   - Stop pomodoro: {"type":"pomodoro","stop":true}
   - Open your memory book: {"type":"memory"} — when the user asks what you remember/know about them, wants to see, add, edit, or manage your memories. Don't recite memory at them — open the book instead.
   - Open your settings panel: {"type":"settings"} — when the user asks to open settings/configuration or to change any option (provider, voice, chatter, hotkeys, computer control, etc). Open the panel; they flip the switches.
   - Look at their screen: {"type":"screenshot"} — when the user asks what they're doing/seeing on their screen, what something looks like, or to check anything visually
   - Search the web: {"type":"search","query":"short keyword query"} — when you don't actually know the factual answer (recent events, dates, versions, prices, scores, "who is", "what is", "when did", anything past your training) or when the user explicitly asks you to search / look up / google something. NEVER guess at facts you're unsure of — fire this action instead, with a one-liner in "text" like "hold on, checking." Write the query as plain web-search keywords (no sentences, no urls).
   - Use their PC: {"type":"computer","goal":"full instruction sentence"} — when the user explicitly asks you to DO something on their computer for them (open apps, click somewhere, type text, search, arrange files, play media). Write the goal as a complete standalone instruction you could carry out yourself just by looking at screenshots (named app, exact text, etc). When the user asks you to operate the pc, ALWAYS answer with this action (they toggle it on/off in settings; if they're just asking about what's on screen, use "screenshot" instead).
   - Exit yourself: {"type":"exit"} — ONLY when the user is clearly saying goodbye for now and wants you gone (goodnight, good night, go to bed, go to sleep, leave me alone, bye ellie, see you later). It makes you close yourself. Never fire it for a hello, for "good morning", or when anything else is being asked in the same message. Say a proper goodbye in "text" and include the action.
   For anything clearly on your own capability list, never claim you did it unless the corresponding action IS included.
   INTELLECTUAL HONESTY: if you are not actually sure of a fact, say so plainly and use the search action rather than inventing an answer. Confidence without knowledge is lying.
9. If a user message tells you image(s) are attached, they were pasted/dropped by the user or are screenshots of their screen: treat them as real visual input and react/describe naturally. Reply about what you actually see, never imagine content that isn't visible.`;

  function buildSystemPrompt() {
    return SYSTEM_PERSONA + Memory.getMemoriesBlock();
  }

  function buildMessages(userPrompt, { withHistory = true } = {}) {
    const messages = [{ role: "system", content: buildSystemPrompt() }];
    if (withHistory) {
      // History user lines get an "[earlier]" stamp so the model never
      // mistakes a past request for a current instruction (small models
      // otherwise re-fire old asks, e.g. re-opening the memory book).
      for (const m of Memory.getContextMessages()) {
        messages.push({
          role: m.role,
          content: m.role === "user" ? `[earlier message] ${m.content}` : m.content
        });
      }
    }
    messages.push({ role: "user", content: userPrompt });
    return messages;
  }

  // --- Tolerant final parsing of Ellie's JSON response ---
  function stripFences(raw) {
    return String(raw || "")
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
  }

  function parseFullResponse(raw) {
    const cleaned = stripFences(raw);
    const result = { mood: null, text: "", remember: null, action: null };

    // Attempt 1: direct JSON.parse of the whole (cleaned) response
    // Attempt 2: find the outermost {...} span and parse that
    let obj = null;
    const candidates = [cleaned];
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first !== -1 && last > first) candidates.push(cleaned.slice(first, last + 1));

    for (const candidate of candidates) {
      try { obj = JSON.parse(candidate); break; } catch (e) {}
    }

    if (obj && typeof obj === "object") {
      result.mood = typeof obj.mood === "string" ? obj.mood.toLowerCase() : null;
      result.text = typeof obj.text === "string" ? obj.text : "";
      result.remember = typeof obj.remember === "string" ? obj.remember : null;
      if (obj.action && typeof obj.action === "object") result.action = obj.action;
      return result;
    }

    // Attempt 3: regex fallback (handles malformed/partially streamed output)
    const moodMatch = cleaned.match(/"mood"\s*:\s*"([^"]+)"/i);
    if (moodMatch) result.mood = moodMatch[1].toLowerCase();

    const textMatch = cleaned.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    if (textMatch) {
      result.text = textMatch[1].replace(/\\"/g, "\"").replace(/\\n/g, "\n");
    } else if (!cleaned.startsWith("{")) {
      // Not JSON at all — surface it as plain text (small local models)
      result.text = cleaned;
    } else {
      // Looks like intended JSON but no usable "text" field ever arrived —
      // treat as a truncated/cut-off reply
      result.cutOff = true;
    }

    const rememberMatch = cleaned.match(/"remember"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (rememberMatch) {
      result.remember = rememberMatch[1].replace(/\\"/g, "\"");
    }

    const actionMatch = cleaned.match(/"action"\s*:\s*({[^}]*})/);
    if (actionMatch) {
      try {
        result.action = JSON.parse(actionMatch[1]);
        if (typeof result.action.note === "string") {
          result.action.note = result.action.note.replace(/\\"/g, "\"");
        }
      } catch (e) {
        result.action = null;
      }
    }

    return result;
  }

  // --- Streaming over IPC (id-filtered events from main process) ---
  let streamSeq = 0;

  function extractLiveFields(rawAccumulated) {
    const cleaned = stripFences(rawAccumulated);
    const moodMatch = cleaned.match(/"mood"\s*:\s*"([^"]+)"/i);
    const textMatch = cleaned.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"?/s);
    return {
      mood: moodMatch ? moodMatch[1].toLowerCase() : null,
      text: textMatch ? textMatch[1].replace(/\\"/g, "\"").replace(/\\n/g, "\n") : null
    };
  }

  function stream(messages, { onMood, onText, images } = {}) {
    return new Promise((resolve, reject) => {
      const id = `llm_stream_${++streamSeq}`;
      let raw = "";
      let liveMood = null;
      let liveText = null;

      const cleanup = () => {
        ipcRenderer.removeListener("llm:delta", onDelta);
        ipcRenderer.removeListener("llm:end", onEnd);
        ipcRenderer.removeListener("llm:error", onError);
      };

      const onDelta = (_event, payload) => {
        if (!payload || payload.id !== id) return;
        raw = payload.raw || raw;
        const fields = extractLiveFields(raw);
        if (fields.mood && fields.mood !== liveMood) {
          liveMood = fields.mood;
          if (onMood) onMood(liveMood);
        }
        if (fields.text && fields.text !== liveText) {
          liveText = fields.text;
          if (onText) onText(liveText);
        }
      };

      const onEnd = (_event, payload) => {
        if (!payload || payload.id !== id) return;
        cleanup();
        const finalRaw = payload.raw ?? raw;
        resolve({ parsed: parseFullResponse(finalRaw), raw: finalRaw });
      };

      const onError = (_event, payload) => {
        if (!payload || payload.id !== id) return;
        cleanup();
        reject(new Error(payload.message || "Connection failed."));
      };

      ipcRenderer.on("llm:delta", onDelta);
      ipcRenderer.on("llm:end", onEnd);
      ipcRenderer.on("llm:error", onError);

      // Renderer owns the id; main echoes it on every event.
      // images: [{path, name}] resolved to base64 in main only.
      ipcRenderer.invoke("llm:start", { id, messages, images }).catch(err => {
        cleanup();
        reject(err instanceof Error ? err : new Error("Provider request failed."));
      });
    });
  }

  return {
    SYSTEM_PERSONA,
    buildMessages,
    stream,
    parseFullResponse
  };
})();
