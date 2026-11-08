# Changelog

All notable changes to Ellie. Dates in YYYY-MM-DD.

## [1.2.1] — 2026-11-08

### Fixes
- The update notice used to stay completely silent in 1.1.0 even when a check found a new version. She now actually announces the update. This means for this version, you must update manually.
- Updater keeps a log file now, at %APPDATA%\desktop-companion\updater.log.
- She shows her version now: a line in the update panel ("currently running ellie x.y.z") and the tray tooltip includes it too.

## [1.2.0] — 2026-11-08

### Search
- Ellie can search the web now. "search the web for...", "look up..." or "google..." gives her a direct order, and when she just doesn't know something she looks it up instead of making it up, then answers with what she found on the pages. It's uses a plain DuckDuckGo fetch.

### Announcements
- Messages can go out between releases now. A small json file in the repo, fetched alongside her update checks, and then spoken once by her.

### Updates
- "Check for updates" now works from chat too, and a direct ask brings the panel back even if you'd dismissed it.

## [1.1.0] — 2026-11-07

### Updater
- Built-in updater: Checks GitHub Releases on launch (and every 6 hours after). When a new version is out she says so, shows the changelog in a small panel, and one button downloads it and restarts her into the new version
- A quit applies the update too, so even if you never open the panel she's on the current version

### Exit
- "goodnight", "go to bed", or "leave me alone" and she says bye and closes herself. Exact phrases are a deterministic command with no model in the middle, and natural phrasing works too through the model
- Mid-task she refuses politely instead: say "stop" first, then she'll go

### Fixes
- Summoning puts Ellie in the correct position unlike a bug preventing her to do so found in 1.0.0.
- You can now drag and drop images into her chat to attach them to your messages. This was an intended feature for 1.0.0, but it was bugged.

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
