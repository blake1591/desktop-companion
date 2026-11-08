const { app, BrowserWindow, ipcMain, powerMonitor, Tray, Menu, nativeImage, screen, Notification, desktopCapturer, globalShortcut } = require("electron");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { autoUpdater } = require("electron-updater");

app.disableHardwareAcceleration();
app.setAppUserModelId("com.ellie.desktop-companion");

let tray = null;
let mainWindow = null;
let watcherProcess = null;

// ============================================================
// Config store — settings in userData/ellie_config.json.
// Secrets (API keys) are encrypted with Windows DPAPI
// (CurrentUser scope) via PowerShell on disk and NEVER
// returned to the renderer; LLM HTTP calls run in main.
// NOTE: Electron 45's safeStorage is broken (round-trip fails),
// so we use DPAPI directly — same security model.
// ============================================================
function psExec(script, { stdin = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn("powershell", ["-NoProfile", "-Command", script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => {
      try { ps.kill(); } catch (e) {}
      reject(new Error("PowerShell timed out"));
    }, timeoutMs);
    ps.stdout.on("data", d => { out += d; });
    ps.stderr.on("data", d => { err += d; });
    ps.on("exit", code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `PowerShell exited with code ${code}`));
    });
    ps.on("error", e => { clearTimeout(timer); reject(e); });
    try {
      if (stdin !== null) ps.stdin.write(stdin, "utf8");
      ps.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

const DPAPI_ENC_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(" +
  "[System.Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()), $null, " +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";

const DPAPI_DEC_SCRIPT =
  "Add-Type -AssemblyName System.Security; " +
  "[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString(" +
  "[System.Security.Cryptography.ProtectedData]::Unprotect(" +
  "[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()), $null, " +
  "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))";

async function dpapiEncrypt(text) {
  const b64 = (await psExec(DPAPI_ENC_SCRIPT, { stdin: text })).trim();
  return "dpapi1:" + b64;
}

async function dpapiDecrypt(stored) {
  // "enc1:" = the broken Electron safeStorage format (unrecoverable) —
  // treated exactly like the newer "dpapi1:" prefix, always fails, and
  // getApiKey() clears stale entries so the user can re-enter the key.
  if (stored.startsWith("enc1:")) throw new Error("legacy-safeStorage-ciphertext");
  const b64 = stored.startsWith("dpapi1:") ? stored.slice(7) : stored;
  return await psExec(DPAPI_DEC_SCRIPT, { stdin: b64 });
}
const CONFIG_DEFAULTS = {
  provider: "openrouter",
  openRouterModel: "anthropic/claude-3.5-sonnet",
  visionModel: "",
  lmStudioEndpoint: "http://127.0.0.1:1234/v1/chat/completions",
  lmStudioModel: "mistralai/ministral-3-3b",
  idleChatter: "normal",
  voiceEnabled: false,
  pcControl: false,
  pcMaxSteps: 10,
  summonHotkey: "Control+Alt+E",
  accessories: [],
  sleepSchedule: { enabled: false, bedtime: "23:30", wakeTime: "07:30" }
};
const VALID_ACCESSORIES = ["headphones", "beanie", "sunglasses"];

function configPath() {
  return path.join(app.getPath("userData"), "ellie_config.json");
}

function readConfigFile() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {};
  } catch (e) {
    return {};
  }
}

function writeConfigFile(data) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("[Config Write Error]:", e.message);
  }
}

async function getApiKey() {
  const stored = (readConfigFile().secrets || {}).openRouterApiKey;
  if (!stored) return "";
  try {
    const key = await dpapiDecrypt(stored);
    return key.trim();
  } catch (e) {
    // Undecryptable ciphertext (e.g. legacy broken safeStorage data) —
    // clear it and require the user to re-enter the key.
    const data = readConfigFile();
    if (data.secrets) delete data.secrets.openRouterApiKey;
    writeConfigFile(data);
    return "";
  }
}

async function setApiKey(key) {
  const data = readConfigFile();
  data.secrets = data.secrets || {};
  const trimmed = String(key || "").trim();
  if (!trimmed) {
    delete data.secrets.openRouterApiKey;
  } else {
    data.secrets.openRouterApiKey = await dpapiEncrypt(trimmed);
  }
  writeConfigFile(data);
}

function loadPublicConfig() {
  const merged = { ...CONFIG_DEFAULTS, ...(readConfigFile().settings || {}) };
  if (!Array.isArray(merged.accessories)) merged.accessories = [];
  if (!VALID_ACCESSORIES.includes(merged.idleChatter) && !["quiet", "normal", "chatty"].includes(merged.idleChatter)) {
    merged.idleChatter = "normal";
  }
  merged.pcControl = !!merged.pcControl;
  merged.pcMaxSteps = Math.max(1, Math.min(50, Math.round(Number(merged.pcMaxSteps) || 10)));
  if (typeof merged.summonHotkey !== "string" || !merged.summonHotkey.trim()) merged.summonHotkey = "Control+Alt+E";
  merged.summonHotkey = merged.summonHotkey.trim().slice(0, 60);
  return merged;
}

function savePublicSettings(settings) {
  const data = readConfigFile();
  const clean = {};
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    if (settings && settings[k] !== undefined) clean[k] = settings[k];
  }
  if (typeof clean.provider !== "string") clean.provider = CONFIG_DEFAULTS.provider;
  if (!["quiet", "normal", "chatty"].includes(clean.idleChatter)) clean.idleChatter = "normal";
  clean.voiceEnabled = !!clean.voiceEnabled;
  clean.pcControl = !!clean.pcControl;
  clean.pcMaxSteps = Math.max(1, Math.min(50, Math.round(Number(clean.pcMaxSteps) || 10)));
  if (typeof clean.summonHotkey !== "string" || !clean.summonHotkey.trim()) clean.summonHotkey = "Control+Alt+E";
  clean.summonHotkey = clean.summonHotkey.trim().slice(0, 60);
  if (!Array.isArray(clean.accessories)) clean.accessories = [];
  clean.accessories = clean.accessories.filter(a => VALID_ACCESSORIES.includes(a));
  data.settings = { ...(data.settings || {}), ...clean };
  writeConfigFile(data);
  return loadPublicConfig();
}

function sanitizeForSave(str) {
  return typeof str === "string" ? str.slice(0, 400) : str;
}

ipcMain.handle("config:load", async () => {
  return { ...loadPublicConfig(), hasOpenRouterApiKey: !!(await getApiKey()) };
});

ipcMain.handle("config:save", async (event, { settings, apiKey } = {}) => {
  if (apiKey !== undefined && apiKey !== null) {
    const trimmed = String(apiKey).trim();
    if (!trimmed || /^(clear|none|remove)$/i.test(trimmed)) {
      await setApiKey("");
    } else {
      await setApiKey(trimmed);
    }
  }
  if (settings && typeof settings === "object") {
    ["openRouterModel", "visionModel", "lmStudioEndpoint", "lmStudioModel"].forEach(k => {
      if (typeof settings[k] === "string") settings[k] = sanitizeForSave(settings[k].trim());
    });
    savePublicSettings(settings);
    registerSummonHotkey(); // pick up any summon hotkey change
  }
  return { ...loadPublicConfig(), hasOpenRouterApiKey: !!(await getApiKey()) };
});

// ============================================================
// Persistent reminders — stored in userData/reminders.json,
// re-armed on startup (missed ones fire shortly after launch).
// ============================================================
const reminderTimers = new Map();

function remindersPath() {
  return path.join(app.getPath("userData"), "reminders.json");
}

function loadReminders() {
  try {
    const data = JSON.parse(fs.readFileSync(remindersPath(), "utf8"));
    return Array.isArray(data.reminders) ? data.reminders : [];
  } catch (e) {
    return [];
  }
}

function saveReminders(items) {
  try {
    fs.mkdirSync(path.dirname(remindersPath()), { recursive: true });
    fs.writeFileSync(remindersPath(), JSON.stringify({ reminders: items }, null, 2), "utf8");
  } catch (e) {
    console.error("[Reminders Write Error]:", e.message);
  }
}

function removeReminder(id) {
  const items = loadReminders().filter(r => r.id !== id);
  saveReminders(items);
  if (reminderTimers.has(id)) {
    clearTimeout(reminderTimers.get(id));
    reminderTimers.delete(id);
  }
}

function fireReminder(rem, missed) {
  removeReminder(rem.id);
  const prefix = missed ? "(late) " : "";
  const note = prefix + (rem.note || (rem.kind === "timer" ? "timer finished." : "reminder."));
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: rem.kind === "timer" ? "ellie ⏱ timer" : "ellie ⏰ reminder",
        body: note.replace(/^\(late\) /, "")
      }).show();
    }
  } catch (e) {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("reminder-fired", { note, kind: rem.kind || "reminder" });
  }
}

function armReminder(rem) {
  if (reminderTimers.has(rem.id)) return;
  const ms = rem.at - Date.now();
  if (ms <= 0) {
    reminderTimers.set(rem.id, setTimeout(() => fireReminder(rem, true), 2500));
  } else {
    reminderTimers.set(rem.id, setTimeout(() => fireReminder(rem, false), ms));
  }
}

ipcMain.handle("schedule-reminder", async (event, { delaySeconds, note, kind } = {}) => {
  const seconds = Math.max(5, Math.min(Math.round(delaySeconds || 600), 60 * 60 * 24));
  const rem = {
    id: `${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    at: Date.now() + seconds * 1000,
    note: typeof note === "string" ? note.slice(0, 200) : "reminder.",
    kind: kind === "timer" ? "timer" : "reminder"
  };
  const items = loadReminders();
  items.push(rem);
  saveReminders(items);
  armReminder(rem);
  return { id: rem.id, at: rem.at };
});

ipcMain.handle("reminders:list", async () => {
  return loadReminders().sort((a, b) => a.at - b.at);
});

ipcMain.handle("reminders:cancel", async () => {
  const items = loadReminders();
  for (const r of items) {
    if (reminderTimers.has(r.id)) {
      clearTimeout(reminderTimers.get(r.id));
      reminderTimers.delete(r.id);
    }
  }
  saveReminders([]);
  return { cancelled: items.length };
});

function rearmAllReminders() {
  for (const rem of loadReminders()) armReminder(rem);
}

// ============================================================
// CPU sampler — computed from os.cpus() deltas, no external calls.
// ============================================================
let cpuPercent = 0;
let prevCpus = os.cpus();

function startCpuSampler() {
  setInterval(() => {
    const now = os.cpus();
    let idle = 0, total = 0;
    for (let i = 0; i < now.length; i++) {
      const a = prevCpus[i], b = now[i];
      if (!a || !b) continue;
      idle += b.times.idle - a.times.idle;
      total += (b.times.user - a.times.user) + (b.times.nice - a.times.nice) +
               (b.times.sys - a.times.sys) + (b.times.idle - a.times.idle);
    }
    cpuPercent = total > 0 ? Math.round((1 - idle / total) * 100) : 0;
    prevCpus = now;
  }, 2000);
}

// ============================================================
// Window watcher v2 — reports "ProcessName<TAB>Title" so Ellie
// knows WHICH app is active, not just the window title.
// ============================================================
const APP_FRIENDLY = {
  code: "VS Code", devenv: "Visual Studio", spotify: "Spotify", msedge: "Edge",
  chrome: "Chrome", firefox: "Firefox", discord: "Discord", slack: "Slack",
  telegram: "Telegram", whatsapp: "WhatsApp", notepad: "Notepad", explorer: "File Explorer",
  winword: "Word", excel: "Excel", powerpnt: "PowerPoint", outlook: "Outlook",
  obsidian: "Obsidian", figma: "Figma", idea: "IntelliJ IDEA", pycharm: "PyCharm",
  powershell: "PowerShell", cmd: "Command Prompt", wt: "Windows Terminal",
  steam: "Steam", epicgameslauncher: "Epic Games", blender: "Blender", gimp: "GIMP",
  windows_terminal: "Windows Terminal"
};

function friendlyAppName(processName) {
  if (!processName) return "";
  const key = String(processName).toLowerCase().trim();
  if (APP_FRIENDLY[key]) return APP_FRIENDLY[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

let lastActiveApp = { name: "", title: "Desktop / Unknown" };
let lastMedia = { app: "", title: "" };

function startWindowWatcher() {
  const psScript = `
  if (-not ([System.Management.Automation.PSTypeName]'Win32Utils').Type) {
    Add-Type -TypeDefinition @"
    using System;
    using System.Text;
    using System.Runtime.InteropServices;
    public class Win32Utils {
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    }
"@ -ErrorAction SilentlyContinue
  }

  $cycle = 0

  while ($true) {
    try {
      $hwnd = [Win32Utils]::GetForegroundWindow()
      if ($hwnd -ne [IntPtr]::Zero) {
        $pidOut = 0
        [Win32Utils]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
        if ($pidOut -gt 0) {
          $p = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
          if ($p -and $p.ProcessName -notlike "*electron*") {
            $sb = New-Object System.Text.StringBuilder 512
            [Win32Utils]::GetWindowText($hwnd, $sb, 512) | Out-Null
            $title = $sb.ToString().Trim()

            if (-not $title -and $p.MainWindowTitle) {
              $title = $p.MainWindowTitle.Trim()
            }

            [Console]::Out.WriteLine($p.ProcessName + [char]9 + $title)
          }
        }
      }
    } catch {}

    # Media scan (cheap, every ~12s): known players announce the song in
    # their window title. Uses main-window titles only — no audio hooks.
    $cycle++
    if ($cycle % 20 -eq 0) {
      try {
        $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
          $_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 2 -and $_.ProcessName -notlike "*electron*"
        }
        foreach ($mp in $procs) {
          $t = $mp.MainWindowTitle.Trim()
          if ($mp.ProcessName -match '(?i)spotify|musicbee|foobar|winamp|vlc|tidal|itunes|aimp|groove|fildo' -or
              $t -match '(?i)youtube music|spotify(?! store)|soundcloud|deezer|pandora|- youtube$') {
            [Console]::Out.WriteLine("MEDIA" + [char]9 + $mp.ProcessName + [char]9 + $t)
          }
        }
      } catch {}
    }

    Start-Sleep -Milliseconds 600
  }
  `;

  const encodedScript = Buffer.from(psScript, "utf16le").toString("base64");
  watcherProcess = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedScript]);

  watcherProcess.stdout.on("data", (data) => {
    const lines = data.toString("utf8").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("MEDIA\t")) {
        const parts = line.split("\t");
        const title = parts.slice(2).join("\t").trim();
        if (title) lastMedia = { app: parts[1], title };
        continue;
      }
      const tabIndex = line.indexOf("\t");
      if (tabIndex >= 0) {
        lastActiveApp = {
          name: line.slice(0, tabIndex).trim(),
          title: line.slice(tabIndex + 1).trim() || "Desktop / Unknown"
        };
      } else {
        lastActiveApp = { name: "", title: line };
      }
    }
  });

  watcherProcess.stderr.on("data", (err) => {
    // PowerShell 5.1 serializes its error stream as CLIXML — the raw dump
    // is pure noise ("#< CLIXML<Objs...>"). Decode the inner <S S="Error">
    // records so real problems still show, and skip the wrapper.
    const text = err.toString();
    if (text.includes("CLIXML")) {
      const real = [...text.matchAll(/<S S="Error">([^<]*)<\/S>/g)]
        .map(m => m[1].replace(/_x000D__x000A_/g, " ").replace(/_x([0-9A-Fa-f]{4})_/g, ""))
        .filter(l => l.trim() && !/^&lt;$/.test(l));
      if (real.length) console.error("[Window Watcher Error]:", real.join(" | ").trim());
      return;
    }
    if (text.trim()) console.error("[Window Watcher Error]:", text.trim());
  });
}

// ============================================================
// LLM proxy — all provider HTTP calls run in the main process so
// the API key never crosses into the renderer. Streams deltas
// back to the renderer via IPC events keyed by stream id.
// ============================================================
let llmSeq = 0;

function sendLlm(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ============================================================
// PC control — Ellie's hands. A persistent PowerShell helper
// process runs SendInput for: move/click/drag/type/key/scroll.
// Coordinates arrive normalized 0-999 and map to 0-65535
// (SendInput's absolute space over the primary display).
// The helper starts on demand and dies with the app.
// ============================================================
let inputHelper = null;
let inputHelperSeq = 0;
const inputHelperPending = new Map();

const INPUT_HELPER_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
public class EllieHands {
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public const uint MOVE=0x0001, LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, WHEEL=0x0800, HWHEEL=0x1000, ABS=0x8000, KEYUP=0x0002, UNICODE=0x0004;
  public static INPUT Mouse(uint flags, int dx, int dy, uint data) {
    var i = new INPUT(); i.type = 0;
    i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  public static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT(); i.type = 1;
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    return i;
  }
  public static bool Send(INPUT[] list) { return SendInput((uint)list.Length, list, Marshal.SizeOf(typeof(INPUT))) == (uint)list.Length; }
}
"@

# 0-999 normalized grid -> SendInput absolute 0-65535
function ToAbs($n) {
  $v = [Math]::Round(([double]$n / 999.0) * 65535.0)
  if ($v -lt 0) { $v = 0 } elseif ($v -gt 65535) { $v = 65535 }
  return [int]$v
}

function NamedVk([string]$name) {
  switch ($name) {
    "enter" { 0x0D } "return" { 0x0D } "esc" { 0x1B } "escape" { 0x1B }
    "tab" { 0x09 } "space" { 0x20 } "backspace" { 0x08 }
    "delete" { 0x2E } "del" { 0x2E } "insert" { 0x2D }
    "home" { 0x24 } "end" { 0x23 } "pageup" { 0x21 } "pagedown" { 0x22 }
    "up" { 0x26 } "down" { 0x28 } "left" { 0x25 } "right" { 0x27 }
    "win" { 0x5B } "f1" { 0x70 } "f2" { 0x71 } "f3" { 0x72 } "f4" { 0x73 }
    "f5" { 0x74 } "f6" { 0x75 } "f7" { 0x76 } "f8" { 0x77 } "f9" { 0x78 }
    "f10" { 0x79 } "f11" { 0x7A } "f12" { 0x7B }
    default {
      if ($name.Length -eq 1) {
        $c = [char]::ToUpper($name[0])
        if ($c -ge [char]'0' -and $c -le [char]'9') { $c -band 0xFF } else { [byte]([int][char]$c) }
      } else { 0 }
    }
  }
}

function DoClick($x, $y, [string]$which, [bool]$dbl) {
  if ($x -ne $null -and $y -ne $null) {
    [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::MOVE -bor [EllieHands]::ABS, (ToAbs $x), (ToAbs $y), 0))) | Out-Null
    Start-Sleep -Milliseconds 60
  }
  if ($which -eq "right") {
    $a = [INPUT[]]@([EllieHands]::Mouse([EllieHands]::RIGHTDOWN, 0, 0, 0), [EllieHands]::Mouse([EllieHands]::RIGHTUP, 0, 0, 0))
  } else {
    $a = [INPUT[]]@([EllieHands]::Mouse([EllieHands]::LEFTDOWN, 0, 0, 0), [EllieHands]::Mouse([EllieHands]::LEFTUP, 0, 0, 0))
  }
  [EllieHands]::Send($a) | Out-Null
  if ($dbl) {
    Start-Sleep -Milliseconds 60
    [EllieHands]::Send($a) | Out-Null
  }
}

function DoDrag($x1, $y1, $x2, $y2) {
  [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::MOVE -bor [EllieHands]::ABS, (ToAbs $x1), (ToAbs $y1), 0))) | Out-Null
  Start-Sleep -Milliseconds 90
  [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::LEFTDOWN, 0, 0, 0))) | Out-Null
  Start-Sleep -Milliseconds 110
  $steps = 22
  for ($i = 1; $i -le $steps; $i++) {
    $mx = [Math]::Round((ToAbs $x1) + ((ToAbs $x2) - (ToAbs $x1)) * $i / $steps)
    $my = [Math]::Round((ToAbs $y1) + ((ToAbs $y2) - (ToAbs $y1)) * $i / $steps)
    [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::MOVE -bor [EllieHands]::ABS, $mx, $my, 0))) | Out-Null
    Start-Sleep -Milliseconds 9
  }
  Start-Sleep -Milliseconds 90
  [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::LEFTUP, 0, 0, 0))) | Out-Null
}

function DoType([string]$text) {
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq [char]13) { continue }
    if ($ch -eq [char]10) {
      $mods = [INPUT[]]@([EllieHands]::Key(0x0D, 0, 0), [EllieHands]::Key(0x0D, 0, [EllieHands]::KEYUP))
    } else {
      $mods = [INPUT[]]@([EllieHands]::Key(0, $ch, [EllieHands]::UNICODE), [EllieHands]::Key(0, $ch, [EllieHands]::UNICODE -bor [EllieHands]::KEYUP))
    }
    [EllieHands]::Send($mods) | Out-Null
    Start-Sleep -Milliseconds 6
  }
}

function DoKey([string]$combo) {
  $mods = @()
  $taps = @()
  foreach ($part in ($combo -split '\\+')) {
    $p = $part.Trim().ToLower()
    if ($p -eq "ctrl") { $mods += 0x11 } elseif ($p -eq "shift") { $mods += 0x10 }
    elseif ($p -eq "alt") { $mods += 0x12 } elseif ($p -eq "win") { $mods += 0x5B }
    elseif ($p) { $vk = NamedVk $p; if ($vk -gt 0) { $taps += [uint16]$vk } }
  }
  $press = [INPUT[]]@(); $release = [INPUT[]]@()
  for ($i = $taps.Count - 1; $i -ge 0; $i--) { $release += [EllieHands]::Key($taps[$i], 0, [EllieHands]::KEYUP) }
  foreach ($m in $mods) { $press = [INPUT[]]@([EllieHands]::Key([uint16]$m, 0, 0)) + $press; $release += [EllieHands]::Key([uint16]$m, 0, [EllieHands]::KEYUP) }
  foreach ($t in $taps) { $press += [EllieHands]::Key($t, 0, 0); }
  $all = $press + $release
  [EllieHands]::Send($all) | Out-Null
}

$in = [Console]::In
while ($true) {
  $line = $in.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  $id = "?"
  try {
    $cmd = $line | ConvertFrom-Json
    $id = $cmd.id
    $ok = $true
    switch ($cmd.act) {
      "move" { [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::MOVE -bor [EllieHands]::ABS, (ToAbs $cmd.x), (ToAbs $cmd.y), 0))) | Out-Null }
      "click" { DoClick $cmd.x $cmd.y ([string]$cmd.button) $false }
      "double_click" { DoClick $cmd.x $cmd.y ([string]$cmd.button) $true }
      "drag" { DoDrag $cmd.x $cmd.y $cmd.x2 $cmd.y2 }
      "type" { DoType ([string]$cmd.text) }
      "key" { DoKey ([string]$cmd.combo) }
      "scroll" {
        $amount = 3
        if ($cmd.amount) { $amount = [int]$cmd.amount }
        $delta = 120 * $amount
        if ($cmd.dir -eq "down" -or $cmd.dir -eq "right") { $delta = -$delta }
        $u = 0
        if ($delta -lt 0) { $u = [uint32]($delta + 4294967296) } else { $u = [uint32]$delta }
        if ($cmd.dir -eq "left" -or $cmd.dir -eq "right") {
          [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::HWHEEL, 0, 0, $u))) | Out-Null
        } else {
          [EllieHands]::Send([INPUT[]]@([EllieHands]::Mouse([EllieHands]::WHEEL, 0, 0, $u))) | Out-Null
        }
      }
      default { $ok = $false }
    }
    if ($ok) { [Console]::Out.WriteLine("OK $id") } else { [Console]::Out.WriteLine("ERR $id unknown-action") }
  } catch {
    [Console]::Out.WriteLine("ERR $id " + $_.Exception.Message.Replace(" ","_"))
  }
}
`;

function killInputHelper() {
  if (inputHelper) {
    try { inputHelper.kill(); } catch (e) {}
    inputHelper = null;
    inputHelperPending.forEach(p => p.reject(new Error("helper stopped")));
    inputHelperPending.clear();
  }
}

function startInputHelper() {
  if (inputHelper) return inputHelper;
  const encoded = Buffer.from(INPUT_HELPER_SCRIPT, "utf16le").toString("base64");
  inputHelper = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buf = "";
  inputHelper.stdout.on("data", (data) => {
    buf += data.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const m = line.match(/^(OK|ERR)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      const p = inputHelperPending.get(m[2]);
      if (p) {
        inputHelperPending.delete(m[2]);
        clearTimeout(p.timer);
        if (m[1] === "OK") p.resolve(); else p.reject(new Error("pc-action failed: " + m[3]));
      }
    }
  });
  inputHelper.stderr.on("data", (err) => console.log("[Hands Error]:", err.toString().slice(0, 200)));
  inputHelper.on("exit", () => {
    inputHelper = null;
    inputHelperPending.forEach(p => p.reject(new Error("hand helper exited")));
    inputHelperPending.clear();
  });
  return inputHelper;
}

ipcMain.handle("pc-act", async (event, action) => {
  if (!action || typeof action !== "object") throw new Error("bad action");
  const allowed = ["move", "click", "double_click", "drag", "type", "key", "scroll"];
  if (!allowed.includes(action.type)) throw new Error("action not allowed: " + action.type);
  if (action.type === "type" && typeof action.text !== "string") throw new Error("type needs text");
  if (action.type === "key" && typeof action.combo !== "string") throw new Error("key needs combo");
  const helper = startInputHelper();
  const id = "a" + (++inputHelperSeq);
  const req = { id, act: action.type };
  if (action.x !== undefined) req.x = action.x;
  if (action.y !== undefined) req.y = action.y;
  if (action.x2 !== undefined) req.x2 = action.x2;
  if (action.y2 !== undefined) req.y2 = action.y2;
  if (action.text !== undefined) req.text = String(action.text).slice(0, 4000);
  if (action.combo !== undefined) req.combo = String(action.combo).slice(0, 80);
  if (action.button !== undefined) req.button = String(action.button);
  if (action.dir !== undefined) req.dir = String(action.dir);
  if (action.amount !== undefined) req.amount = action.amount;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      inputHelperPending.delete(id);
      reject(new Error("pc-action timed out"));
    }, 8000);
    inputHelperPending.set(id, { resolve, reject, timer });
    try {
      helper.stdin.write(JSON.stringify(req) + "\n");
    } catch (e) {
      clearTimeout(timer);
      inputHelperPending.delete(id);
      reject(new Error("hand helper not responding"));
    }
  });
});

// ============================================================
// Vision — user-initiated image context. Screenshots are taken
// only when the user asks (never silently); files land in the
// OS temp folder, are read by main just before the provider
// request, and are capped in count/size.
// ============================================================
const IMAGE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp"
};
const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function visionTempDir() {
  const dir = path.join(app.getPath("temp"), "ellie-vision");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle("vision:grab-screen", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 1600 } });
  if (!sources || !sources.length) throw new Error("no display to capture.");
  const img = sources[0].thumbnail;
  const file = path.join(visionTempDir(), `screen-${Date.now()}.jpg`);
  fs.writeFileSync(file, img.toJPEG(82));
  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`[Vision] screenshot captured (${kb} KB)`);
  return { path: file, name: "screenshot.jpg", kb };
});

ipcMain.handle("vision:save-image", async (event, data) => {
  // Pasted/dropped image data that has no on-disk path arrives as raw bytes
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buf || buf.length === 0) throw new Error("empty image data.");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("image too large (over 8 MB).");
  const file = path.join(visionTempDir(), `paste-${Date.now()}.png`);
  fs.writeFileSync(file, buf);
  return { path: file, name: "pasted-image.png", kb: Math.round(buf.length / 1024) };
});

async function injectImages(messages, images) {
  if (!Array.isArray(images) || images.length === 0) return messages;
  const parts = [{ type: "text", text: String(messages[messages.length - 1]?.content || "") }];
  let attached = 0, skipped = 0;
  for (const img of images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
    try {
      const file = String(img && img.path || "");
      const ext = path.extname(file).toLowerCase();
      if (!IMAGE_MIME[ext]) { skipped++; continue; }
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) { skipped++; continue; }
      const b64 = fs.readFileSync(file).toString("base64");
      parts.push({ type: "image_url", image_url: { url: `data:${IMAGE_MIME[ext]};base64,${b64}` } });
      attached++;
    } catch (e) {
      skipped++;
    }
  }
  if (attached === 0) return messages;
  console.log(`[Vision] attached ${attached} image(s) to request${skipped ? `, skipped ${skipped}` : ""}`);
  const withImages = [...messages];
  withImages[withImages.length - 1] = { ...withImages[withImages.length - 1], content: parts };
  return withImages;
}

async function runLLMStream(id, payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!messages || messages.length === 0) throw new Error("No messages provided.");

  const cfg = loadPublicConfig();
  const isOpenRouter = cfg.provider === "openrouter";
  let endpoint, headers = { "Content-Type": "application/json" }, model;

  if (isOpenRouter) {
    const key = await getApiKey();
    if (!key) {
      throw new Error("No OpenRouter API key stored — type \"open settings\" in the chat bar to add one.");
    }
    endpoint = "https://openrouter.ai/api/v1/chat/completions";
    headers["Authorization"] = `Bearer ${key}`;
    headers["HTTP-Referer"] = "http://localhost";
    headers["X-Title"] = "Ellie Desktop Companion";
    model = cfg.openRouterModel || CONFIG_DEFAULTS.openRouterModel;
  } else {
    endpoint = cfg.lmStudioEndpoint || CONFIG_DEFAULTS.lmStudioEndpoint;
    model = cfg.lmStudioModel || CONFIG_DEFAULTS.lmStudioModel;
  }

  // Vision: when images ride along, switch to the dedicated vision
  // model if the user configured one (base models can't see images).
  const images = Array.isArray(payload?.images) ? payload.images : [];
  if (images.length > 0 && cfg.visionModel && String(cfg.visionModel).trim()) {
    model = String(cfg.visionModel).trim();
  }
  console.log(`[LLM] ${id} -> ${cfg.provider}/${model}${images.length ? ` (${images.length} image(s))` : ""}`);

  // Watchdog: give up if the provider streams nothing for 120 s
  const controller = new AbortController();
  const hardTimer = setTimeout(() => controller.abort(), 120000);

  try {
    const t0 = Date.now();
    const finalMessages = await injectImages(messages, images);
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages: finalMessages, temperature: 0.5, stream: true }),
      signal: controller.signal
    });

    console.log(`[LLM] ${id} HTTP ${res.status} after ${Date.now() - t0} ms`);
    if (!res.ok) {
      let detail = "";
      try { detail = " – " + (await res.text()).slice(0, 180); } catch (e) {}
      if (images.length > 0 && /image|vision|modalit|multimodal/i.test(detail)) {
        throw new Error(`HTTP ${res.status}${detail} — this model probably can't see images. either pick an image-capable model or set a "vision model" in settings (any *-vl or *-vision one).`);
      }
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    let raw = "";
    let reasoningLen = 0;
    let finalView = "";
    let loggedFirstDelta = false;

    // Reasoning models (e.g. DeepSeek) may wrap output in think tags,
    // or stream reasoning tokens before the JSON - always present the
    // renderer with a view stripped of them.
    const THINK_OPEN = "<think>";
    const THINK_CLOSE = "</think>";
    function viewOf(accumulated) {
      const thinkOpen = accumulated.indexOf(THINK_OPEN);
      if (thinkOpen === -1) return accumulated;
      const closeIdx = accumulated.indexOf(THINK_CLOSE, thinkOpen);
      if (closeIdx === -1) return accumulated.slice(0, thinkOpen); // still reasoning
      return accumulated.slice(0, thinkOpen) + accumulated.slice(closeIdx + THINK_CLOSE.length);
    }

    const contentType = res.headers.get("content-type") || "";

    if (!res.body || !contentType.includes("event-stream")) {
      // Non-streaming response (some local servers without SSE)
      const json = await res.json().catch(() => null);
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        raw = content;
        finalView = viewOf(raw);
        sendLlm("llm:delta", { id, raw: finalView });
      }
    } else {
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      // Some providers (OpenRouter/Z.AI) don't close the response body
      // promptly after [DONE], so waiting for reader.read() done left the
      // stream hanging forever. Exit explicitly on [DONE] / finish_reason.
      let streamEnded = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (process.env.ELLIE_SSE_DEBUG) {
            try { fs.appendFileSync(process.env.ELLIE_SSE_DEBUG, id + " | " + trimmed.slice(0, 400) + "\n"); } catch (e) {}
          }
          if (!trimmed.startsWith("data: ")) continue;
          const data = trimmed.slice(6);
          if (data === "[DONE]") {
            console.log(`[LLM] ${id} received [DONE]`);
            streamEnded = true;
            break;
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta || {};
            const reasoningPiece = delta.reasoning ?? delta.reasoning_content ?? "";
            if (reasoningPiece) reasoningLen += reasoningPiece.length;
            const contentPiece = delta.content || "";
            if (contentPiece) raw += contentPiece;
            if (raw) {
              finalView = viewOf(raw);
              sendLlm("llm:delta", { id, raw: finalView });
              if (!loggedFirstDelta) {
                loggedFirstDelta = true;
                console.log(`[LLM] ${id} first delta forwarded (${raw.length} chars accumulated)`);
              }
            }
            if (json.choices?.[0]?.finish_reason) {
              console.log(`[LLM] ${id} finish_reason ${json.choices[0].finish_reason}`);
              streamEnded = true;
            }
          } catch (e) {
            // Partial chunk — wait for more
          }
        }
        if (streamEnded) break;
      }
    }

    if (!raw.trim()) {
      if (reasoningLen > 0) {
        throw new Error("The model only produced reasoning tokens and no final text. Try a non-reasoning variant, or check the exact model ID on openrouter.ai/models.");
      }
      sendLlm("llm:end", { id, raw: "" });
      return;
    }

    sendLlm("llm:end", { id, raw: finalView || viewOf(raw) });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Timed out after 120 s waiting for the provider — it may be stalled or overloaded.");
    }
    throw err;
  } finally {
    clearTimeout(hardTimer);
  }
}

ipcMain.handle("llm:start", async (event, payload) => {
  // The renderer owns the stream id and passes it in, so events it filters
  // by id actually match. Fall back to a generated id for robustness.
  const id = (typeof payload?.id === "string" && payload.id) ? payload.id : `llm_${++llmSeq}`;
  runLLMStream(id, payload).catch(err => {
    console.error(`[LLM] ${id} FAILED:`, err.message);
    sendLlm("llm:error", { id, message: (err && err.message) || "Unknown provider error." });
  });
  return id;
});

// helper so logs show the model actually in use (chat vs vision override)
ipcMain.handle("llm:log", (event, line) => {
  console.log("[LLM]", String(line).slice(0, 200));
});

// ============================================================
// Voice — offline Windows SAPI. Text-to-speech via System.Speech,
// one-shot dictation via SpeechRecognitionEngine.
// ============================================================
let isSpeaking = false;
const speakQueue = [];

function pumpSpeakQueue() {
  if (isSpeaking || speakQueue.length === 0) return;
  isSpeaking = true;
  const text = speakQueue.shift();

  const script =
    'Add-Type -AssemblyName System.Speech; ' +
    '$t = [Console]::In.ReadToEnd().Trim(); ' +
    'if ($t) { $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
    '$s.Rate = 2; $s.Volume = 90; $s.Speak($t) }';

  const ps = spawn("powershell", ["-NoProfile", "-Command", script], {
    stdio: ["pipe", "ignore", "ignore"]
  });

  let open = true;
  const finish = () => {
    if (!open) return;
    open = false;
    isSpeaking = false;
    pumpSpeakQueue();
  };
  ps.on("exit", finish);
  ps.on("error", finish);
  // Safety net so a stuck synthesizer can't wedge the queue forever
  setTimeout(finish, Math.min(40000, 3000 + text.length * 130));

  try {
    ps.stdin.write(text, "utf8");
    ps.stdin.end();
  } catch (e) {
    finish();
  }
}

ipcMain.on("speak", (event, text) => {
  if (typeof text !== "string") return;
  const clean = text
    .replace(/[*_`#>|]/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (!clean) return;
  speakQueue.push(clean);
  if (speakQueue.length > 3) speakQueue.splice(0, speakQueue.length - 3); // drop stale
  pumpSpeakQueue();
});

// ============================================================
// Voice input — local whisper.cpp dictation (push-to-talk).
// On first use, the whisper binaries (~9 MB, nightly b5454) and
// the ggml-base.en model (~141 MB) are downloaded ONCE into
// userData/whisper; after that dictation runs fully offline.
// ============================================================
const WHISPER_DIR = path.join(app.getPath("userData"), "whisper");
const WHISPER_BIN = path.join(WHISPER_DIR, "bins", "Release", "whisper-cli.exe");
const WHISPER_MODEL = path.join(WHISPER_DIR, "ggml-base.en.bin");
const WHISPER_ZIP_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip";
const WHISPER_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

function sendMicProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mic-progress", payload);
}

async function downloadToFile(url, dest, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0, lastPct = -10;
  for await (const chunk of res.body) {
    got += chunk.length;
    out.write(chunk);
    if (total > 0) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 10) { lastPct = pct; sendMicProgress({ phase: "download", label, pct }); }
    }
  }
  await new Promise((ok, nok) => { out.on("error", nok); out.end(ok); });
}

let whisperInstallPromise = null;
function installWhisper() {
  if (whisperInstallPromise) return whisperInstallPromise;
  whisperInstallPromise = (async () => {
    fs.mkdirSync(WHISPER_DIR, { recursive: true });
    if (fs.existsSync(WHISPER_BIN) && !fs.existsSync(WHISPER_MODEL)) {
      // Binary already there (partial install) — skip the zip
    } else {
      const zip = path.join(WHISPER_DIR, "whisper-bin.zip");
      sendMicProgress({ phase: "download", label: "whisper binary", pct: 0 });
      await downloadToFile(WHISPER_ZIP_URL, zip, "whisper binary");
      sendMicProgress({ phase: "extract", label: "whisper binary", pct: 100 });
      await psExec(
        `Expand-Archive -Path '${zip}' -DestinationPath '${path.join(WHISPER_DIR, "bins")}' -Force`,
        { timeoutMs: 90000 }
      );
      fs.rmSync(zip, { force: true });
    }
    sendMicProgress({ phase: "download", label: "speech model", pct: 0 });
    await downloadToFile(WHISPER_MODEL_URL, WHISPER_MODEL + ".part", "speech model");
    fs.renameSync(WHISPER_MODEL + ".part", WHISPER_MODEL);
    console.log("[Whisper] install complete");
    sendMicProgress({ phase: "ready" });
  })().catch(err => {
    console.error("[Whisper] install failed:", err.message);
    sendMicProgress({ phase: "error", message: err.message });
    whisperInstallPromise = null;
    throw err;
  });
  return whisperInstallPromise;
}

function whisperReady() {
  return fs.existsSync(WHISPER_BIN) && fs.existsSync(WHISPER_MODEL);
}

ipcMain.handle("listen-preflight", async () => {
  if (whisperReady()) return { ready: true };
  // Kick the one-time download in the background; progress lands
  // in the renderer via mic-progress events.
  const started = whisperInstallPromise !== null;
  if (!started) {
    try {
      installWhisper().catch(() => {});
    } catch (e) {}
  }
  return { ready: false, downloading: whisperInstallPromise !== null };
});

ipcMain.handle("listen-whisper", async (event, audio) => {
  if (!whisperReady()) return { transcript: "", error: "whisper not ready" };
  try {
    // 16 kHz mono PCM16 WAV, encoded in the renderer
    const wavFile = path.join(WHISPER_DIR, "dictation.wav");
    fs.writeFileSync(wavFile, Buffer.from(audio));
    return await new Promise((resolve) => {
      let out = "", done = false, kill = null;
      const sp = spawn("powershell", [
        "-NoProfile", "-Command",
        `& '${WHISPER_BIN}' -nt -m '${WHISPER_MODEL}' -f '${wavFile}'`
      ], { stdio: ["ignore", "pipe", "ignore"] });
      const finish = (value) => {
        if (done) return;
        done = true;
        if (kill) clearTimeout(kill);
        try { sp.kill(); } catch (e) {}
        resolve(value);
      };
      kill = setTimeout(() => {
        console.error("[Whisper] transcription timed out");
        finish({ transcript: "", error: "timed out" });
      }, 90000);
      sp.stdout.on("data", d => { out += d.toString("utf8"); });
      sp.on("exit", () => {
        const lines = out.split("\n")
          .map(l => l.trim())
          .filter(l => l && !/^(whisper|system|load|main|-----|\[)/i.test(l));
        const transcript = lines.join(" ").trim();
        console.log(`[Whisper] transcript: ${transcript.slice(0, 120)}`);
        finish(transcript ? { transcript } : { transcript: "", error: "no speech detected" });
      });
      sp.on("error", err => finish({ transcript: "", error: err.message }));
    });
  } catch (e) {
    return { transcript: "", error: e.message };
  }
});

// ============================================================
// System context for the renderer
// ============================================================
ipcMain.handle("get-system-context", async () => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const ramUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const idleSecs = powerMonitor ? powerMonitor.getSystemIdleTime() : 0;

  const now = new Date();
  const timeStr = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dayStr = now.toLocaleDateString([], { weekday: "long" });

  const work = screen.getPrimaryDisplay().workArea;

  return {
    time: `${dayStr}, ${timeStr}`,
    idleSeconds: idleSecs,
    ramUsagePercent: ramUsage,
    cpuPercent: cpuPercent,
    activeApp: lastActiveApp.name ? friendlyAppName(lastActiveApp.name) : "Desktop",
    activeWindow: lastActiveApp.title,
    nowPlaying: lastMedia.title ? { app: friendlyAppName(lastMedia.app), title: lastMedia.title } : null,
    workArea: { x: work.x, y: work.y, width: work.width, height: work.height }
  };
});

// Absolute window placement — the renderer's idle "director" hands over her
// position. Dropping always-on-top lets the taskbar (a topmost window)
// naturally cover her when she tucks underneath it at the bottom edge.
// Both placement handlers echo the REAL position back to the renderer —
// its own "known" position was only updated by her self-moves, so after a
// manual drag she'd summon back to a stale spot like it's yesterday's news.
function echoWindowPos(win) {
  try {
    if (!mainWindow || mainWindow.isDestroyed() || win.isDestroyed()) return;
    const [posX, posY] = win.getPosition();
    mainWindow.webContents.send("window-pos", { x: posX, y: posY });
  } catch (e) {}
}

ipcMain.on("set-window-pos", (event, { x, y, onTop }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  try {
    if (typeof onTop === "boolean" && win.isAlwaysOnTop() !== onTop) win.setAlwaysOnTop(onTop);
    if (Number.isFinite(x) && Number.isFinite(y)) win.setPosition(Math.round(x), Math.round(y));
    echoWindowPos(win);
  } catch (e) {}
});

ipcMain.on("move-window", (event, { x, y }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    const [currentX, currentY] = win.getPosition();
    win.setPosition(currentX + x, currentY + y);
    echoWindowPos(win);
  }
});

ipcMain.on("set-ignore-mouse-events", (event, ignore, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    win.setIgnoreMouseEvents(ignore, options);
  }
});

// ============================================================
// Snip-a-region — crosshair overlay to grab a screen piece.
// She only sees the rectangle you drag, never the whole screen.
// ============================================================
let snipOverlay = null;
let snipImage = null; // full-screen dataURL captured before the overlay shows

const SNIP_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';"><style>
html,body{margin:0;padding:0;width:100vw;height:100vh;background:transparent;overflow:hidden;cursor:crosshair}
#shade{position:fixed;inset:0;background:rgba(8,8,14,0.35)}
#sel{position:fixed;border:1px solid #b892ff;display:none;box-shadow:0 0 0 100000px rgba(8,8,14,0.45)}
#dim{position:fixed;top:14px;left:50%;transform:translateX(-50%);color:#cfc6ea;font:12px 'Segoe UI',sans-serif;background:rgba(15,15,25,0.85);border:1px solid #3a3a55;border-radius:8px;padding:5px 12px}
</style></head><body>
<div id="shade"></div><div id="sel"></div><div id="dim">drag a region — esc to cancel</div>
<script>
const { ipcRenderer } = require("electron");
let start = null;
const sel = document.getElementById("sel");
document.addEventListener("mousedown", (e) => { start = { x: e.clientX, y: e.clientY }; e.preventDefault(); });
document.addEventListener("mousemove", (e) => {
  if (!start) return;
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
  const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
  sel.style.display = "block"; sel.style.left = x + "px"; sel.style.top = y + "px";
  sel.style.width = w + "px"; sel.style.height = h + "px";
  // the shade dies the moment there's a selection — the box-shadow does the dimming
  document.getElementById("shade").style.display = "none";
});
document.addEventListener("mouseup", (e) => {
  if (!start) return;
  const x = Math.min(start.x, e.clientX), y = Math.min(start.y, e.clientY);
  const w = Math.abs(e.clientX - start.x), h = Math.abs(e.clientY - start.y);
  start = null;
  if (w < 12 || h < 12) { ipcRenderer.send("snip:cancel"); return; }
  ipcRenderer.send("snip:rect", { x, y, w, h });
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ipcRenderer.send("snip:cancel"); });
ipcRenderer.on("snip:autotest-rect", () => { ipcRenderer.send("snip:rect", { x: 60, y: 60, w: 320, h: 200 }); });
</script></body></html>`;

ipcMain.handle("snip:start", async () => {
  try {
    const primary = screen.getPrimaryDisplay();
    const sf = primary.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: Math.floor(primary.size.width * sf), height: Math.floor(primary.size.height * sf) }
    });
    if (!sources || !sources.length) return { ok: false, error: "no display to capture" };
    const img = sources[0].thumbnail;
    if (img.isEmpty()) return { ok: false, error: "capture failed" };
    snipImage = img.toDataURL();

    if (snipOverlay) { try { snipOverlay.close(); } catch (e) {} snipOverlay = null; }
    const { x, y, width, height } = primary.bounds;
    snipOverlay = new BrowserWindow({
      x, y, width, height,
      frame: false, transparent: true, resizable: false,
      hasShadow: false, skipTaskbar: true,
      backgroundColor: "#00000000",
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    snipOverlay.setAlwaysOnTop(true, "screen-saver");
    snipOverlay.setIgnoreMouseEvents(false);
    snipOverlay.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(SNIP_HTML));
    snipOverlay.on("closed", () => { snipOverlay = null; });

    // autotest: nobody is going to drag a rectangle — fake one shortly after
    if (process.env.ELLIE_AUTOTEST === "snip") {
      setTimeout(() => {
        if (snipOverlay) {
          snipOverlay.webContents.send("snip:autotest-rect");
        }
      }, 1500);
    }
    return { ok: true };
  } catch (e) {
    snipImage = null;
    return { ok: false, error: e.message };
  }
});

function closeSnip() {
  if (snipOverlay) { try { snipOverlay.close(); } catch (e) {} snipOverlay = null; }
  snipImage = null;
}

ipcMain.on("snip:rect", (_e, rect) => {
  try {
    if (snipImage && rect && Number.isFinite(rect.x) && rect.w > 12 && rect.h > 12) {
      const primary = screen.getPrimaryDisplay();
      const sf = primary.scaleFactor || 1;
      const img = nativeImage.createFromDataURL(snipImage);
      const size = img.getSize();
      const cx = Math.max(0, Math.min(Math.round(rect.x * sf), size.width - 4));
      const cy = Math.max(0, Math.min(Math.round(rect.y * sf), size.height - 4));
      const cw = Math.max(4, Math.min(Math.round(rect.w * sf), size.width - cx));
      const ch = Math.max(4, Math.min(Math.round(rect.h * sf), size.height - cy));
      const cropped = img.crop({ x: cx, y: cy, width: cw, height: ch });
      if (!cropped.isEmpty()) {
        const file = path.join(visionTempDir(), `snip-${Date.now()}.jpg`);
        fs.writeFileSync(file, cropped.toJPEG(86));
        console.log(`[Vision] snip captured (${Math.round(fs.statSync(file).size / 1024)} KB, ${cw}x${ch})`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("snip:image", { path: file, name: "snip-region.jpg", kb: Math.round(fs.statSync(file).size / 1024) });
        }
      }
    }
  } catch (e) {
    console.error("[Snip] crop failed:", e.message);
  }
  closeSnip();
});

// ============================================================
// Exit tool — "goodnight" / "leave me alone" and she goes under
// her own power. Deterministic in the renderer, but the quit
// itself always happens here in main so nothing can half-die.
// Falls back to a hard exit if quit is swallowed.
// ============================================================
ipcMain.handle("app:exit", async () => {
  console.log("[Exit] renderer asked ellie to call it a night");
  app.isQuitting = true;
  app.quit();
  setTimeout(() => { try { app.exit(0); } catch (e) {} }, 2500);
});

// ============================================================
// Updater IPC — the renderer panel reads state, starts the
// download, and triggers the restart-and-apply. All guarded on
// `supported` so a dev run can never self-update.
// ============================================================
ipcMain.handle("updater:status", async () => ({ ...updateState }));

ipcMain.handle("updater:download", async () => {
  if (!updateState.supported || !updateState.available || updateState.downloaded) {
    return { ...updateState };
  }
  try {
    await autoUpdater.downloadUpdate();
  } catch (e) {
    updateState.error = e.message;
    broadcastUpdate();
  }
  return { ...updateState };
});

ipcMain.handle("updater:install", async () => {
  if (!updateState.supported || !updateState.downloaded) return { ...updateState };
  app.isQuitting = true;
  try {
    autoUpdater.quitAndInstall(false, false);
  } catch (e) {
    console.log("[updater] install failed:", e.message);
  }
  setTimeout(() => { try { app.exit(0); } catch (e) {} }, 2500);
  return { ...updateState };
});

ipcMain.on("snip:cancel", () => {
  const had = !!snipImage;
  closeSnip();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("snip:image", had ? { canceled: true } : { canceled: true });
  }
});

// ============================================================
// Auto-update (install once, ever)
// Only active when running as an installed/packaged app —
// `npm start` dev runs skip it entirely. The renderer gets a
// play-by-play ("ui:update") and drives the download/restart
// from its own panel; install-on-quit stays as the fallback.
// ============================================================
const updateState = {
  supported: false,     // never true in dev (`npm start`) — by design
  available: false,
  version: null,
  notes: "",
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null
};

function sanitizeNotes(raw) {
  // GitHub release bodies arrive as markdown text; if a release ever
  // lists notes as objects, flatten them into one string.
  if (Array.isArray(raw)) {
    return raw.map(n => (typeof n === "string" ? n : n.text || "")).join("\n");
  }
  return typeof raw === "string" ? raw : "";
}

function broadcastUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("ui:update", { ...updateState });
  } catch (e) {}
}

function setupUpdater() {
  if (!app.isPackaged) {
    console.log("[updater] dev mode — auto-update disabled");
    return;
  }
  updateState.supported = true;
  autoUpdater.autoDownload = false;             // the renderer's panel owns the button
  autoUpdater.autoInstallOnAppQuit = true;      // ...and even if she never notices, a quit applies it

  autoUpdater.on("checking-for-update", () => console.log("[updater] checking…"));
  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    updateState.available = true;
    updateState.version = info.version;
    updateState.notes = sanitizeNotes(info.releaseNotes);
    broadcastUpdate();
  });
  autoUpdater.on("update-not-available", () => console.log("[updater] up to date"));
  autoUpdater.on("error", (err) => {
    console.log("[updater] error:", err.message);
    if (updateState.available) {
      updateState.error = err.message;
      broadcastUpdate();
    }
  });
  autoUpdater.on("download-progress", (p) => {
    const pct = Math.floor(p.percent);
    if (pct === updateState.progress) return;
    updateState.downloading = true;
    updateState.error = null;
    updateState.progress = pct;
    if (pct % 10 === 0) console.log("[updater] downloading:", pct + "%");
    broadcastUpdate();
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] downloaded", info.version, "— ready to restart");
    updateState.downloading = false;
    updateState.downloaded = true;
    updateState.progress = 100;
    broadcastUpdate();
    try {
      new Notification({
        title: "ellie 💫 update ready",
        body: `v${info.version} is downloaded — hit her panel to restart & update`,
        silent: true
      }).show();
    } catch (e) {}
  });

  const check = () => { autoUpdater.checkForUpdates().catch((e) => console.log("[updater] check failed:", e.message)); };
  setTimeout(check, 20000);                   // shortly after boot
  setInterval(check, 6 * 60 * 60 * 1000);     // then every 6 hours
}

// ============================================================
// Tray
// ============================================================
const TRAY_ICON_DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACLSURBVDhPY2AYBYMFmP8z/Afi//8ZGBgY/uM2gGHIAGTABiAGfEAGjBqADBg1ADmAYfSAYAMYH/83/m/EKoX3/wz/A4D4P4pOpEaAnj4YmFiAMUo/A0O8O3YDiA3Xg/8ZGOzA/B9mABwA1/3/Gf4jmwG3gQ0YNSByAAYGhn8M/xkY/qOoGfX3DAyDEQEAW/dL2mAtFj8AAAAASUVORK5CYII=";

function createTray() {
  // Ellie's orb, preferably. Falls back to the old blob if the asset is missing.
  let icon = nativeImage.createFromPath(path.join(__dirname, "build", "tray.png")).resize({ width: 16, height: 16 });
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(TRAY_ICON_DATA);
  tray = new Tray(icon);
  tray.setToolTip("Ellie Desktop Companion");

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show / Hide Ellie",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: "Reset Position",
      click: () => {
        if (!mainWindow) return;
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;
        mainWindow.setPosition(width - 340, height - 400);
        mainWindow.show();
      }
    },
    { type: "separator" },
    {
      label: "Check for Updates",
      click: () => {
        if (!app.isPackaged) return;
        autoUpdater.checkForUpdates().catch((e) => console.log("[updater] manual check failed:", e.message));
      }
    },
    {
      label: "Restart Ellie",
      click: () => {
        app.relaunch();
        app.exit(0);
      }
    },
    {
      label: "Quit Ellie",
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ============================================================
// Summon hotkey — press it anywhere and Ellie pops her chat bar
// up, ready for a quick note. Electron's globalShortcut keeps
// working over other apps; exclusive-fullscreen games may eat it.
// ============================================================
let registeredSummonHotkey = null;

function summonFromHotkey() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
  mainWindow.webContents.send("ui:summon");
}

function registerSummonHotkey() {
  const cfg = loadPublicConfig();
  const wanted = (typeof cfg.summonHotkey === "string" && cfg.summonHotkey.trim())
    ? cfg.summonHotkey.trim()
    : "Control+Alt+E";
  if (registeredSummonHotkey === wanted) return true;
  if (registeredSummonHotkey) {
    try { globalShortcut.unregister(registeredSummonHotkey); } catch (e) {}
    registeredSummonHotkey = null;
  }
  try {
    if (globalShortcut.register(wanted, summonFromHotkey)) {
      registeredSummonHotkey = wanted;
      console.log(`[Hotkey] summon bound to ${wanted}`);
      return true;
    }
  } catch (e) {}
  try {
    if (globalShortcut.register("Control+Alt+E", summonFromHotkey)) {
      registeredSummonHotkey = "Control+Alt+E";
      console.log(`[Hotkey] "${wanted}" failed — fell back to Control+Alt+E`);
      return true;
    }
  } catch (e) {}
  console.log("[Hotkey] could not bind a summon hotkey (probably claimed by another app)");
  return false;
}

function createWindow() {
  // ellie's orb for the taskbar (frameless transparent windows rely on this)
  let winIcon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png"));
  mainWindow = new BrowserWindow({
    width: 320,
    height: 380,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    hasShadow: false,
    backgroundColor: "#00000000",
    icon: winIcon.isEmpty() ? undefined : winIcon,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const loadOptions = process.env.ELLIE_AUTOTEST
    ? { search: "autotest=" + process.env.ELLIE_AUTOTEST }
    : undefined;
  mainWindow.loadFile("index.html", loadOptions);
  registerSummonHotkey();

  // transparent frameless windows are notorious for ignoring the constructor's
  // icon — set it again after creation so the taskbar button gets it
  if (!winIcon.isEmpty()) {
    mainWindow.setIcon(winIcon);
    mainWindow.once("ready-to-show", () => {
      try { mainWindow.setIcon(winIcon); } catch (e) {}
    });
  }

  // Mirror renderer console output into the main terminal (debugging aid).
  // New event-object API (Electron deprecated the (event, level, msg) args).
  mainWindow.webContents.on("console-message", (event) => {
    try {
      console.log("[renderer]", String(event.message || "").slice(0, 300));
    } catch (err) {}
  });

  createTray();
}

app.whenReady().then(() => {
  // claim our identity so Windows taskbar/pins/notifications behave
  app.setAppUserModelId("com.ellie.desktopcompanion");
  createWindow();
  startWindowWatcher();
  startCpuSampler();
  rearmAllReminders();
  setupUpdater();
});

app.on("before-quit", () => {
  if (watcherProcess) { try { watcherProcess.kill(); } catch (e) {} }
  killInputHelper();
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
