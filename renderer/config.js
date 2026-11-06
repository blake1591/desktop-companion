// ============================================================
// Config — settings live in the main process (userData file,
// API key encrypted with safeStorage and never sent here).
// All access is async over IPC; Config.ready() must be awaited
// before the first get().
// ============================================================
const Config = (() => {
  const { ipcRenderer } = require("electron");

  const FALLBACK = {
    provider: "openrouter",
    openRouterModel: "anthropic/claude-3.5-sonnet",
    visionModel: "",
    lmStudioEndpoint: "http://127.0.0.1:1234/v1/chat/completions",
    lmStudioModel: "mistralai/ministral-3-3b",
    idleChatter: "normal",
    voiceEnabled: false,
    accessories: [],
    sleepSchedule: { enabled: false, bedtime: "23:30", wakeTime: "07:30" }
  };

  let current = { ...FALLBACK };
  let readyPromise = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = ipcRenderer
        .invoke("config:load")
        .then(loaded => {
          current = { ...FALLBACK, ...loaded };
          return current;
        })
        .catch(() => current);
    }
    return readyPromise;
  }

  async function save(settings, apiKey) {
    try {
      current = { ...FALLBACK, ...(await ipcRenderer.invoke("config:save", { settings, apiKey })) };
    } catch (e) {
      // Keep running even if the save failed
      current = { ...current, ...settings };
    }
    return current;
  }

  return {
    FALLBACK,
    ready,
    get: () => current,
    save
  };
})();
