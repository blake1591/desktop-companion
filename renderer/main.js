// ============================================================
// Boot — loads config from the main process, then wires all
// renderer modules together and starts them.
// Script order in index.html:
//   config.js → state.js → memory.js → audio.js → orb.js →
//   llm.js → assistant.js → ui.js → main.js
// ============================================================
// Restore wardrobe from persisted settings
(async () => {
  await Config.ready();

  // Restore wardrobe from persisted settings
  if (Array.isArray(Config.get().accessories) && Config.get().accessories.length > 0) {
    Orb.setAccessories(Config.get().accessories);
  }

  Orb.setMood("idle", 6000);
  Orb.init();
  UI.init();
  Assistant.init();

  // Self-test hook: ELLIE_AUTOTEST=1 npm start sends a chat message
  // automatically after boot so the LLM pipeline can be verified
  // end-to-end from the terminal. ELLIE_AUTOTEST=vision additionally
  // exercises the screenshot + image attachment path.
  if (typeof location !== "undefined" && location.search.includes("autotest")) {
    const vision = location.search.includes("autotest=vision");
    const pc = location.search.includes("autotest=pc");
    const pcstop = location.search.includes("autotest=pcstop");
    const calc = location.search.includes("autotest=calc");
    const mem = location.search.includes("autotest=mem") && !location.search.includes("autotest=memact");
    const memact = location.search.includes("autotest=memact");
    setTimeout(() => {
      if (mem) {
        // Memory engine probes: add → pin → edit → appears (pinned) in the
        // prompt block → delete → gone. Then opens the panel via chat.
        setTimeout(() => {
          try {
            const probes = [];
            probes.push(["add", Memory.addMemory("e2e test memory")]);
            probes.push(["pin", Memory.pinMemory("e2e test memory")]);
            probes.push(["edit", Memory.editMemory("e2e test memory", "e2e test memory edited")]);
            const stored = Memory.getMemories();
            probes.push(["stored-pinned", !!stored.find(x => x.text === "e2e test memory edited" && x.pinned)]);
            const block = Memory.getMemoriesBlock();
            probes.push(["block-★", block.includes("e2e test memory edited ★") && block.includes("pinned")]);
            probes.push(["forget-that", Memory.removeMemory("e2e test memory edited")]);
            probes.push(["forget-fail-safe", !Memory.getMemories().some(x => x.text.includes("e2e test"))]);
            console.log("[autotest] memory probes: " + probes.map(p => `${p[0]}=${p[1] ? "ok" : "FAIL"}`).join(" "));
            const box = document.getElementById("input-box");
            box.value = "show memories";
            box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            console.log("[autotest] memory panel opened via chat");
            // Chat-command probes: deterministic remember → stored; forget → gone
            const type = (msg) => {
              const box = document.getElementById("input-box");
              box.value = msg;
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
            };
            setTimeout(() => {
              type("remember that e2e autotest fact");
              console.log("[autotest] remember dispatched");
              setTimeout(() => {
                console.log("[autotest] remember-stored=" + (Memory.getMemories().some(x => x.text.toLowerCase().includes("e2e autotest fact")) ? "ok" : "FAIL"));
                type("forget that e2e autotest fact");
                console.log("[autotest] forget dispatched");
                setTimeout(() => {
                  console.log("[autotest] forget-confirm=" + (!Memory.getMemories().some(x => x.text.toLowerCase().includes("e2e autotest fact")) ? "ok" : "FAIL"));
                  // Name flow: "call me X" stores + pins the canonical name
                  type("call me test blake");
                  setTimeout(() => {
                    const nm = Memory.getUserName();
                    console.log("[autotest] name-set=" + (nm === "Test Blake" ? "ok" : "FAIL:" + nm));
                    const nameMem = Memory.getMemories().find(x => x.text.startsWith("User's name is"));
                    console.log("[autotest] name-pinned=" + (nameMem && nameMem.pinned ? "ok" : "FAIL"));
                    // Renaming works and stays a single entry
                    type("my name is jane doe");
                    setTimeout(() => {
                      const count = Memory.getMemories().filter(x => x.text.startsWith("User's name is")).length;
                      const nm2 = Memory.getUserName();
                      console.log("[autotest] rename=" + (nm2 === "Jane Doe" && count === 1 ? "ok" : "FAIL:" + nm2 + "/" + count));
                      // clean up so her real name stays unset in dev
                      Memory.removeMemory("Jane Doe");
                    }, 2000);
                  }, 2000);
                }, 1200);
              }, 2500);
            }, 2500);
          } catch (e) {
            console.log("[autotest] memory probes FAILED: " + e.message);
          }
        }, 1000);
        return;
      }
      if (memact) {
        // LLM-action path: variant phrasing that skips the local command
        // shortcuts — the model itself must emit {"type":"memory"} to open
        // the panel. Panel visibility is logged by the report probe below.
        setTimeout(() => {
          const box = document.getElementById("input-box");
          box.value = "hey, let me see what you've got saved about me";
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          console.log("[autotest] memact: natural-phrasing memory ask dispatched");
          setTimeout(() => {
            const panel = document.getElementById("memory-modal");
            console.log("[autotest] memact: panel-open=" + (panel.style.display === "block" ? "ok" : "FAIL(" + panel.style.display + ")"));
          }, 12000);
        }, 1000);
        return;
      }
      const box = document.getElementById("input-box");
      box.value = calc
        ? "use the pc: open calculator"
        : pcstop
        ? "use the pc: open notepad and type hi"
        : pc
        ? "use the pc: move my mouse cursor to the exact middle of the screen, then you're done."
        : vision
        ? "what do you see on my screen? describe it briefly."
        : "Say hi in JSON please.";
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      console.log(`[autotest] chat message dispatched${calc ? " (calc: direct trigger)" : pcstop ? " (pcstop: notepad task)" : pc ? " (pc: cursor task)" : vision ? " (vision: screenshot ask)" : ""}`);
      if (pcstop) {
        // Abort-path test: type "stop" mid-task (delay configurable via the
        // autotest query, e.g. autotest=pcstop&delay=120000)
        const delay = Number((location.search.match(/[?&]delay=(\d+)/) || [])[1]) || 45000;
        setTimeout(() => {
          const box = document.getElementById("input-box");
          box.value = "stop";
          box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          console.log("[autotest] stop dispatched");
        }, delay);
      }
    }, 4000);
  }
})();
