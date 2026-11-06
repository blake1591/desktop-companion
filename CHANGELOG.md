# Changelog

All notable changes to Ellie. Dates in YYYY-MM-DD.

## [1.0.0] — 2026-11-05

First public release.

### Companion
- Glowing 2D orb with seven moods (idle / happy / sad / annoyed / confused / frustrated / thinking) and a UI that changes its color to match (speech bubble, chat input, and buttons)
- Passive states: drowses off after long idle, wanders, tucks herself under the taskbar and peeks periodically; right-click pops her out and pins, drag unpins, `Ctrl+Alt+E` summons from anywhere
- Wearable accessories: headphones, beanie, sunglasses; double-click to pet

### Chat
- Streaming AI chat via OpenRouter (default model `z-ai/glm-5.3-flash`), typewriter rendering with sound, optional TTS voice (WIP)
- LM Studio offline chat
- System context every turn: time, active app/window, idle, CPU/RAM, battery, now-playing track (with reactions when the song changes)
- Seasonal flavor lines keyed to the calendar
- Boot greeting composed fresh by the AI (time + seasonal context), premade greeting when no provider is connected, and summon text rotates through a pool

### Memory
- Long-term memory book: open / add / edit / forget / pin ★ from chat, and pinned entries survive autodeletion
- Saves facts on the fly, with guardrails against junk entries and a boot-time scrub
- Learns your name on first boot

### Vision
- Paste images into chat
- "look at my screen" full desktop screenshots on request
- ✂ snip-a-region: crosshair overlay, cropped region attaches to the chat input for captioning (`snip: <note>`) or bare sending

### Computer control (opt-in, off by default)
- `"use the pc: <goal>"` — the exact phrase is read without the chat model (no interpretation step); natural phrasing goes through the model. Task steps themselves run on the model, screenshot by screenshot
- Full-auto loop with live thought-bubble narration of every move/click/type/scroll
- Configurable step budget (1–50, default 10) — "continue" grants a fresh budget
- Multiple abort paths: `Ctrl+Alt+E`, Escape (while focused in her window), "stop" / "hands off"

### QoL
- Reminders & timers (list/cancel in chat), pomodoro start/stop/status
- Push-to-talk transcription with a bundled Whisper model
- Local-only storage: config and memories in `%APPDATA%\desktop-companion\`, API key stored client-side, no telemetry
