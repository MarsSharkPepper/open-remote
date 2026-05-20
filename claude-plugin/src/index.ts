/**
 * Claude Code PTY Bridge — transparent remote control via OpenRemote.
 *
 * Architecture:
 *   - PTY: spawns Claude Code, handles local terminal passthrough + input injection
 *   - Hooks: Claude Code native hooks capture structured events (messages, tool calls)
 *   - HTTP: bridge runs a local server that hook scripts POST events to
 *   - WebSocket: forwards events to OpenRemote server
 *
 * Usage: node dist/index.js <path-to-real-claude> [...claude args]
 */

import os from "os"
import fs from "fs"
import path from "path"
import http from "http"
import { spawn, IPty } from "node-pty"
import { WebSocket } from "ws"
import pkg from "@xterm/headless";
import { loadCredentials } from "./credentials.js"


const { Terminal } = pkg;
// ── Constants ────────────────────────────────────────────────

const SERVER_URL = process.env.OPENREMOTE_SERVER || "wss://openremote.top/ws/plugin"
const RECONNECT_MS = 3000
const PING_INTERVAL_MS = 30000
const MAX_MESSAGE_CACHE = 200
const STREAM_CHUNK_SIZE = 2000
const STREAM_CHUNK_DELAY = 100

// ── Types ────────────────────────────────────────────────────

interface CachedMessage {
  id: string
  role: string
  content: string
  timestamp: number
}

interface ClaudeHistoryPart {
  type: string
  text?: string
  toolName?: string
  command?: string
  output?: string
  id?: string
  isError?: boolean
}

interface ClaudeHistoryMessage {
  id: string
  role: "user" | "assistant"
  parts: ClaudeHistoryPart[]
  createdAt: number
}

interface HistoryQAPair {
  user: ClaudeHistoryMessage
  assistants: ClaudeHistoryMessage[]
}

// ── Args ─────────────────────────────────────────────────────

const realClaudeBin = process.argv[2]
const userArgs = process.argv.slice(3)

if (!realClaudeBin) {
  console.error("[ClaudeRemote] Usage: node dist/index.js <path-to-claude> [args...]")
  process.exit(1)
}

// ── Pass-through for non-interactive subcommands ────────────

const NON_INTERACTIVE_SUBCOMMANDS = new Set([
  "sessions", "config", "mcp", "update", "doctor", "api",
  "init", "login", "logout", "plans",
])

const NON_INTERACTIVE_FLAGS = new Set([
  "--help", "-h", "--version", "-v",
  "--print", "-p", "--json",
])

function isNonInteractive(args: string[]): boolean {
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (NON_INTERACTIVE_FLAGS.has(arg)) return true
    } else {
      if (NON_INTERACTIVE_SUBCOMMANDS.has(arg)) return true
    }
  }
  return false
}

function buildEditDiff(filePath: string, oldStr: string, newStr: string): string {
  return filePath + "\n---\n" + oldStr + "\n+++\n" + newStr
}

if (isNonInteractive(userArgs)) {
  const { execFileSync } = await import("child_process")
  try {
    if (process.platform === "win32") {
      const cmd = process.env.ComSpec || "cmd.exe"
      execFileSync(cmd, ["/c", realClaudeBin, ...userArgs], {
        stdio: "inherit",
        env: process.env as Record<string, string>,
      })
    } else {
      execFileSync(realClaudeBin, userArgs, {
        stdio: "inherit",
        env: process.env as Record<string, string>,
      })
    }
    process.exit(0)
  } catch (e: any) {
    process.exit(e.status ?? 1)
  }
}

// ── Credentials ──────────────────────────────────────────────

const creds = loadCredentials()
if (!creds) {
  process.exit(1)
}
const TOKEN = creds.token

// ── State ────────────────────────────────────────────────────

let ptyProc: IPty | null = null
let ws: WebSocket | null = null
let registered = false
const messageCache: CachedMessage[] = []
let msgCounter = 0
let sessionId = generateSessionId()
let remoteClearTimestamp = 0  // set when /clear comes from remote new_session command; prevents double handleLocalClear
let sessionInitialized = false  // true after first SessionStart hook provides real session ID
let resizeTimeout: ReturnType<typeof setTimeout> | null = null
let streamMsgId = ""
let hookPort = 0
let chunkTimer: ReturnType<typeof setTimeout> | null = null
let pendingStopTimer: ReturnType<typeof setTimeout> | null = null
let slashFallbackTimer: ReturnType<typeof setTimeout> | null = null
let compactWatchTimer: ReturnType<typeof setInterval> | null = null
let compactTimeoutTimer: ReturnType<typeof setTimeout> | null = null
let isCompactFinalize = false  // when true, finalizeResponse skips sending text content
let accumulatedText = ""
let accumulatedNotifications = ""
let isResponding = false
let introSent = false  // whether "..." indicator has been sent
let lastUserPrompt = ""  // to skip echoed user input in PTY
let transcriptPath = ""  // path to Claude Code session transcript
let lastTranscriptPath = ""  // persisted transcript path for history loading
let ptyBuffer = ""
let ptySearchStart = 0  // position in ptyBuffer to start searching from
let stdinLineBuffer = ""  // accumulates typed chars to detect /clear etc
// Escape sequence state machine: 0=normal, 1=saw ESC, 2=saw ESC [ (CSI)
let escState = 0
// ── Pending permission state (per toolUseId) ──
interface PendingPermState {
  requestID: string
  toolName: string
  input: Record<string, any>
  toolUseId: string
  timer: ReturnType<typeof setTimeout> | null
  toolStartSent: boolean
  toolStartInfo: { toolName: string; label: string; detail: string } | null
  optionCount: number
  ptyStartPos: number
  xtermBaseLine: number
  ptyMatched: boolean
}
const pendingPerms = new Map<string, PendingPermState>()
const xtermHeadless = new Terminal({ cols: 120, rows: 30, scrollback: 5000, allowProposedApi: true })
let statusCaptureTimer: ReturnType<typeof setInterval> | null = null
let statusTimeoutTimer: ReturnType<typeof setTimeout> | null = null
let statusCaptureReqId = ""
let statusTabBufStart = 0
let statusTabCheckCount = 0
let statusCapturedTabs: { name: string; content: string }[] = []
let statusTabIndex = 0
let statusTuiOpen = false
let statusPrevOutput = ""
let statusStableCount = 0
let statusRawBuffer = ""  // raw PTY data (with ANSI) for status capture
// Config tab scroll state
let statusPhase: "capture" | "scroll_down" | "scroll_up" = "capture"
let statusDownSent = 0
let statusUpSent = 0
let statusDidScroll = false  // prevent re-entering scroll for same tab
let statusLastScrollPos = 0  // ptyBuffer position for recent "more below" detection
const STATUS_TAB_NAMES = ["Status", "Config", "Usage", "Stats"]
let streamPollTimer: ReturnType<typeof setTimeout> | null = null
let streamSentText = ""     // formatted text already sent via streaming deltas
let streamLastFileSize = 0  // transcript file size at last poll (skip re-read if unchanged)
let lastQuestionResult: { questionItems: any[]; questionAnswers: string[][] } | null = null
let pendingQuestions: Array<{ id: string; questions: Array<{ question?: string; options?: Array<{ label: string }>; multiSelect?: boolean }> }> = []
let pendingPlanId: string | null = null
let planPromptActive = false  // true when plan.asked was sent but not yet replied
let pendingPlanTimer: ReturnType<typeof setTimeout> | null = null
let planPtyStart = 0  // ptyBuffer position when ExitPlanMode fires

// Internal tools that should not be shown to the user
const HIDDEN_TOOLS = new Set([
  "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
  "EnterPlanMode", "ExitPlanMode",
])

// Human-readable labels for tool progress indicators
const TOOL_LABELS: Record<string, string> = {
  Read: "Reading file",
  Edit: "Editing file",
  MultiEdit: "Editing file",
  Write: "Writing file",
  Bash: "Running command",
  Glob: "Searching files",
  Grep: "Searching code",
  Agent: "Running agent",
  WebSearch: "Searching web",
  WebFetch: "Fetching URL",
  NotebookEdit: "Editing notebook",
}

// Transcript parsing cache for history loading
let cachedTranscriptPath = ""
let cachedQAPairs: HistoryQAPair[] = []
let cachedTranscriptMtime = 0

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*?\x07/g, "")
    .replace(/\x1b\][^\x1b]*?\x1b\\/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/\r/g, "")
}

/** Strip ANSI codes + bare CSI sequences (ESC stripped by PTY rendering) */
function cleanAnsiText(s: string): string {
  let text = stripAnsi(s).trim()
  // Bare CSI: [1m [22m [0m etc. (orphan escape sequences without ESC prefix)
  text = text.replace(/\[(\d+(?:;\d+)*)m/g, (_, codes) => {
    // Only strip if it looks like a real SGR code (0-107 range)
    const nums = codes.split(";").map((n: string) => Number(n))
    return nums.every((n: number) => n >= 0 && n <= 107) ? "" : _
  })
  return text
}

function getXtermBufferText(fromLine = 0): string {
  const buffer = xtermHeadless.buffer.active
  const lines: string[] = []
  for (let i = fromLine; i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (line) {
      const text = line.translateToString(true)
      if (text) lines.push(text)
    }
  }
  return lines.join("\n")
}

function sendStreamDelta(delta: string) {
  if (!streamMsgId || !delta) return
  accumulatedNotifications += delta

  send({
    type: "opencode_event",
    event: {
      type: "message.part.delta",
      properties: {
        messageID: streamMsgId,
        sessionID: sessionId,
        partId: `part_${streamMsgId}`,
        field: "text",
        delta,
      },
    },
  })
}

// ── PTY: Spawn Claude Code ───────────────────────────────────

/**
 * Resolve the real Claude Code binary.
 * The `claude` command might be a .cmd/.ps1 wrapper. We resolve it to:
 *   1. The platform-native binary (if installed)
 *   2. The cli-wrapper.cjs fallback (Node.js-based launcher)
 * Returns { cmd, args } or null if not resolvable.
 */
function resolveClaudeBinary(binPath: string): { cmd: string; args: string[] } | null {
  // Resolve symlinks — on macOS, npm creates symlinks like
  // /usr/local/bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/cli.js
  let resolved = binPath
  try { resolved = fs.realpathSync(binPath) } catch {}

  // If resolved path is a JS file, run it with node directly
  if (resolved.endsWith(".js") || resolved.endsWith(".cjs") || resolved.endsWith(".mjs")) {
    return { cmd: process.execPath, args: [resolved] }
  }

  // If binPath itself is a JS file (passed directly), also handle it
  if (binPath.endsWith(".js") || binPath.endsWith(".cjs") || binPath.endsWith(".mjs")) {
    return { cmd: process.execPath, args: [binPath] }
  }

  // Native binary — use directly
  if (process.platform !== "win32") {
    return { cmd: resolved, args: [] }
  }

  // On Windows, binPath might be .cmd/.ps1 — resolve to JS or native binary
  const npmPrefix = path.join(os.homedir(), "AppData", "Roaming", "npm")
  if (!binPath.startsWith(npmPrefix)) return null

  const pkgDir = path.join(npmPrefix, "node_modules", "@anthropic-ai", "claude-code")
  if (!fs.existsSync(pkgDir)) return null

  // Try cli.js first (older versions like 2.1.100)
  const cliJs = path.join(pkgDir, "cli.js")
  if (fs.existsSync(cliJs)) {
    return { cmd: process.execPath, args: [cliJs] }
  }

  // Try native binary
  const platforms: Record<string, { pkg: string; bin: string }> = {
    "win32-x64": { pkg: "@anthropic-ai/claude-code-win32-x64", bin: "claude.exe" },
    "win32-arm64": { pkg: "@anthropic-ai/claude-code-win32-arm64", bin: "claude.exe" },
  }
  const platformKey = `${process.platform}-${os.arch()}`
  const platformInfo = platforms[platformKey]
  if (platformInfo) {
    const nativeBin = path.join(npmPrefix, "node_modules", platformInfo.pkg, platformInfo.bin)
    if (fs.existsSync(nativeBin) && fs.statSync(nativeBin).size > 1000) {
      return { cmd: nativeBin, args: [] }
    }
  }

  // Last fallback: cli-wrapper.cjs
  const wrapper = path.join(pkgDir, "cli-wrapper.cjs")
  if (fs.existsSync(wrapper)) {
    return { cmd: process.execPath, args: [wrapper] }
  }

  return null
}

function startPty() {
  const cols = process.stdout.columns || 120
  const rows = process.stdout.rows || 40

  // Resolve the actual executable:
  // - If realClaudeBin points to a .cmd/.ps1 wrapper, resolve to the JS entry point
  // - On Windows, native exe is often a stub; use cli-wrapper.cjs instead
  let cmd: string
  let args: string[]

  const resolved = resolveClaudeBinary(realClaudeBin)
  if (resolved) {
    cmd = resolved.cmd
    args = [...resolved.args, ...userArgs]
  } else if (process.platform === "win32") {
    cmd = process.env.ComSpec || "cmd.exe"
    args = ["/c", realClaudeBin, ...userArgs]
  } else {
    cmd = realClaudeBin
    args = userArgs
  }

  const ptyEnv = { ...(process.env as Record<string, string>) }
  if (hookPort) ptyEnv.OPENREMOTE_HOOK_PORT = String(hookPort)

  ptyProc = spawn(cmd, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: process.cwd(),
    env: ptyEnv,
  })

  // ── Local terminal passthrough (user sees normal Claude Code) ──

  ptyProc.onData((data) => {
    process.stdout.write(data)
    xtermHeadless.write(data)
    ptyBuffer += stripAnsi(data)
    if (statusTuiOpen) statusRawBuffer += data
  })

  ptyProc.onExit(({ exitCode }) => {
    process.exit(exitCode)
  })

  // ── Local keyboard → PTY ──
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.on("data", (data: Buffer) => {
    const text = data.toString("utf-8")
    ptyProc?.write(text)

    // Detect terminal-side plan reply: user pressed Enter while plan approval prompt is active
    if (planPromptActive && (text.includes("\r") || text.includes("\n"))) {
      planPromptActive = false
      pendingPlanId = null
      send({
        type: "opencode_event",
        event: { type: "plan.replied", properties: { sessionID: sessionId }, activity: "busy" },
      })
    }

    // Detect terminal-side permission reply: user pressed y/n while permission prompt is active
    if (pendingPerms.size > 0) {
      if (text.includes("y") || text.includes("n")) {
        for (const [, entry] of pendingPerms) {
          if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
          send({
            type: "opencode_event",
            event: { type: "permission.replied", properties: { sessionID: sessionId }, activity: "busy" },
          })
        }
        pendingPerms.clear()
      }
    }

    // Buffer typed chars to detect slash commands like /clear
    // Must skip ANSI escape sequences using a state machine:
    //   ESC [ ... final   (CSI, e.g. \x1b[I focus-in, \x1b[A arrow-up)
    //   ESC X             (two-char sequence)
    for (const ch of text) {
      if (escState === 1) {
        // Just saw ESC — check if CSI introducer
        if (ch === "[") { escState = 2; continue }
        escState = 0  // two-char ESC sequence done
        continue
      }
      if (escState === 2) {
        // Inside CSI sequence — final byte is 0x40-0x7E
        if (ch.charCodeAt(0) >= 0x40 && ch.charCodeAt(0) <= 0x7e) escState = 0
        continue
      }
      if (ch === "\x1b") { escState = 1; continue }
      if (ch === "\r" || ch === "\n") {
        const line = stdinLineBuffer.trim()

        stdinLineBuffer = ""
        if (line === "/clear") {
          if (remoteClearTimestamp && Date.now() - remoteClearTimestamp < 3000) {
            // remote clear in progress, skip
          } else {
            handleLocalClear()
          }
        }
      } else if (ch === "\x7f" || ch === "\b") {
        // Backspace
        stdinLineBuffer = stdinLineBuffer.slice(0, -1)
      } else if (ch >= " ") {
        stdinLineBuffer += ch
      } else if (ch === "\x15") {
        // Ctrl+U: clear line
        stdinLineBuffer = ""
      }
    }

    // Record search start on Enter (before Claude starts responding)
    if (text.includes("\r") || text.includes("\n")) {
      ptySearchStart = ptyBuffer.length
    }
  })

  // ── Terminal resize sync ──
  process.stdout.on("resize", () => {
    if (resizeTimeout) clearTimeout(resizeTimeout)
    resizeTimeout = setTimeout(() => {
      const c = process.stdout.columns || 120
      const r = process.stdout.rows || 40
      ptyProc?.resize(c, r)
      xtermHeadless.resize(c, r)
    }, 100)
  })
}

// ── Hook HTTP Server ─────────────────────────────────────────
// Claude Code hooks POST structured events here.

function startHookServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end()
        return
      }

      let body = ""
      req.on("data", chunk => body += chunk)
      req.on("end", () => {
        try {
          const event = JSON.parse(body)
          handleHookEvent(event)
          res.writeHead(200, { "Content-Type": "application/json" })
          res.end('{"ok":true}')
        } catch (e) {
          res.writeHead(400).end()
        }
      })
    })

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      hookPort = typeof addr === "object" && addr ? addr.port : 0
      // Write port to file so hooks (forward.cjs) can read it reliably
      try {
        const portFile = path.join(os.homedir(), ".openremote", "hook_port")
        fs.mkdirSync(path.dirname(portFile), { recursive: true })
        fs.writeFileSync(portFile, String(hookPort))
      } catch {}
      resolve(hookPort)
    })

    server.on("error", (e: any) => {
      resolve(0)
    })
  })
}

// ── Handle Hook Events ───────────────────────────────────────

function handleHookEvent(data: Record<string, any>) {
  const eventName = data.hook_event_name || ""

  if (eventName === "PreToolUse") {
    handlePreToolUse(data)
  } else if (eventName === "UserPromptSubmit") {
    handleUserPrompt(data)
  } else if (eventName === "Stop") {
    handleStop(data)
  } else if (eventName === "PostToolUse") {
    handlePostToolUse(data)
  } else if (eventName === "SessionStart") {
    handleSessionStart(data)
  } else if (eventName === "SessionEnd") {
    handleSessionEnd(data)
  }
}

/**
 * Handle SessionStart hook — the authoritative source for session ID.
 * Fires on startup (source="resume"), after /clear (source="clear"), and after /resume.
 */
function handleSessionStart(data: Record<string, any>) {
  const newSessionId = data.session_id || ""
  const newTranscriptPath = data.transcript_path || ""
  const source = data.source || ""
  if (!newSessionId) {
    return
  }
  const oldSessionId = sessionId

  // If this is NOT the first SessionStart (e.g. /clear or /resume), clear state
  if (sessionInitialized) {
    messageCache.length = 0
    transcriptPath = ""
    lastTranscriptPath = ""
    cachedTranscriptPath = ""
    cachedQAPairs = []
    cachedTranscriptMtime = 0
    accumulatedText = ""
    accumulatedNotifications = ""
    ptyBuffer = ""
    ptySearchStart = 0
    for (const [, entry] of pendingPerms) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    pendingPerms.clear()
    if (pendingPlanTimer) { clearTimeout(pendingPlanTimer); pendingPlanTimer = null }
    pendingPlanId = null
    planPromptActive = false
    pendingQuestions.length = 0
    isResponding = false
    streamMsgId = ""
    streamSentText = ""
    stopTranscriptPolling()
  }

  // Set the real session ID and transcript path from hook data
  sessionId = newSessionId
  transcriptPath = newTranscriptPath
  lastTranscriptPath = newTranscriptPath
  sessionInitialized = true


  // Notify the server of the new session
  if (registered) {
    send({ type: "update_session", opencodeSessionId: sessionId })
    send({
      type: "opencode_event",
      event: {
        type: "session.created",
        properties: { sessionID: sessionId },
      },
    })
  }

  // If WS is open but not registered yet, register now
  if (!registered && ws && ws.readyState === 1) {
    doRegister()
  }
}

/**
 * Handle SessionEnd hook. Fires on /clear (reason="clear") and exit (reason="prompt_input_exit").
 * No critical action needed — SessionStart will follow for /clear, or process exits for exit.
 */
function handleSessionEnd(data: Record<string, any>) {
  const reason = data.reason || ""
}

function handlePreToolUse(data: Record<string, any>) {
  // Cancel pending finalization — new tool call means response continues.
  // Without this, finalizeResponse() can clear ptyBuffer while a permission
  // check timer is still waiting to detect the prompt in PTY output, causing
  // the check to miss it and incorrectly assume auto-allowed.
  if (pendingStopTimer) {
    clearTimeout(pendingStopTimer)
    pendingStopTimer = null
  }

  // Restart transcript polling if handleStop stopped it — the response
  // continues with a new tool call, so streaming must keep running.
  if (isResponding && !streamPollTimer) {
    streamPollTimer = setTimeout(pollTranscript, 200)
  }

  const toolName = data.tool_name || "Tool"

  // ExitPlanMode → detect plan approval prompt in PTY
  if (toolName === "ExitPlanMode") {
    planPtyStart = ptyBuffer.length
    const requestID = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
    pendingPlanId = requestID
    planPromptActive = false
    if (pendingPlanTimer) clearTimeout(pendingPlanTimer)
    let planCheckAttempt = 0
    function checkPlanPty() {
      pendingPlanTimer = null
      if (!pendingPlanId) return
      const recentPty = ptyBuffer.slice(Math.min(planPtyStart, ptyBuffer.length))
      // Claude Code shows "Claude Code needs your approval for the plan"
      // or "Do you want to proceed?" for plan approval
      if (/(?:proceed|your\s*approval|approve\s*(?:this\s*)?plan|needs\s*your)/i.test(recentPty)) {
        planPromptActive = true
        send({
          type: "opencode_event",
          event: {
            type: "plan.asked",
            activity: "question",
            properties: {
              requestID: pendingPlanId,
              sessionID: sessionId,
            },
          },
        })
      } else {
        planCheckAttempt++
        if (planCheckAttempt < 5) {
          pendingPlanTimer = setTimeout(checkPlanPty, 300)
        } else {
          pendingPlanId = null
        }
      }
    }
    pendingPlanTimer = setTimeout(checkPlanPty, 200)
    return
  }

  // EnterPlanMode shows "Enter plan mode?" prompt — allow remote approval
  if (HIDDEN_TOOLS.has(toolName) && toolName !== "EnterPlanMode") return

  const toolInput = data.tool_input || {}

  // AskUserQuestion → question.asked + auto-approve permission
  if (toolName === "AskUserQuestion" || toolName === "AskQuestion") {
    const questions = toolInput.questions || []
    if (questions.length > 0) {
      const requestID = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      // Store questions so we can map labels → index numbers when replying
      pendingQuestions.push({ id: requestID, questions })
      if (pendingQuestions.length > 10) pendingQuestions.shift()
      send({
        type: "opencode_event",
        event: {
          type: "question.asked",
          activity: "question",
          properties: {
            id: requestID,
            questions,
            sessionID: sessionId,
          },
        },
      })
    }
    return
  }

  // Store tool info for deferred tool.started — only sent when permission prompt is detected.
  const toolStartInfo = !HIDDEN_TOOLS.has(toolName)
    ? (() => {
        const label = TOOL_LABELS[toolName] || toolName
        const filePath = toolInput.file_path || toolInput.path || ""
        const command = toolInput.command || ""
        const pattern = toolInput.pattern || toolInput.query || ""
        const detail = filePath || command || pattern
        return {
          toolName,
          label,
          detail: detail ? (detail.length > 120 ? detail.slice(0, 120) + "..." : detail) : "",
        }
      })()
    : null

  // Create Map entry keyed by toolUseId, start periodic PTY check.
  // PostToolUse will cancel the timer for auto-approved tools;
  // if PTY match succeeds or timer expires, send permission.asked.
  const toolUseId = data.tool_use_id || `tu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
  const requestID = `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

  const state: PendingPermState = {
    requestID,
    toolName,
    input: toolInput,
    toolUseId,
    timer: null,
    toolStartSent: false,
    toolStartInfo,
    optionCount: 2,
    ptyStartPos: ptyBuffer.length,
    xtermBaseLine: xtermHeadless.buffer.active.length,
    ptyMatched: false,
  }

  pendingPerms.set(toolUseId, state)

  let checkAttempt = 0
  const MAX_CHECKS = 57 // 57 × 350ms ≈ 20s

  function checkPermPty() {
    const entry = pendingPerms.get(toolUseId)
    if (!entry || entry.ptyMatched) return
    entry.timer = null

    // Only search PTY content written AFTER PreToolUse fired.
    // Old buffer content may contain residual permission prompts from previous tools.
    const xtermText = getXtermBufferText(entry.xtermBaseLine)
    const recentPty = ptyBuffer.slice(entry.ptyStartPos)
    const searchText = xtermText + "\n" + recentPty


    if (/(?:allow|proceed|do\s*you\s*want|want\s*to\s*(?:allow|approve|proceed|run|execute)|use\s*skill|enter\s*plan\s*mode|tool\s*use|outside\s*of\s*sandbox|network\s*request)/i.test(searchText)) {
      entry.ptyMatched = true
      // Count "always" option variants
      let alwaysCount = 0
      if (/don[''\u2019`]?\s*t\s*ask\s*again/i.test(searchText) || /ask\s*again\s*for/i.test(searchText)) alwaysCount++
      if (/allow\s*(?:reading|writing)\s*from/i.test(searchText)) alwaysCount++
      if (/always\s*allow/i.test(searchText)) alwaysCount++
      if (/allow\s*all/i.test(searchText)) alwaysCount++
      if (alwaysCount === 0 && (/this\s*project/i.test(searchText) || /this\s*session/i.test(searchText) || /during\s*this/i.test(searchText))) alwaysCount = 1
      entry.optionCount = 2 + alwaysCount

      if (entry.toolStartInfo && !entry.toolStartSent) {
        entry.toolStartSent = true
        send({
          type: "opencode_event",
          event: {
            type: "tool.started",
            properties: { ...entry.toolStartInfo, sessionID: sessionId },
          },
        })
      }
      send({
        type: "opencode_event",
        event: {
          type: "permission.asked",
          activity: "permission",
          properties: {
            requestID: entry.requestID,
            toolName: entry.toolName,
            input: entry.input,
            sessionID: sessionId,
            hasProjectOption: entry.optionCount >= 3,
          },
        },
      })
    } else {
      checkAttempt++
      if (checkAttempt < MAX_CHECKS) {
        entry.timer = setTimeout(checkPermPty, 350)
      } else {
        // Timer expired — send permission.asked as fallback
        if (!pendingPerms.has(toolUseId)) return
        if (entry.toolStartInfo && !entry.toolStartSent) {
          entry.toolStartSent = true
          send({
            type: "opencode_event",
            event: {
              type: "tool.started",
              properties: { ...entry.toolStartInfo, sessionID: sessionId },
            },
          })
        }
        send({
          type: "opencode_event",
          event: {
            type: "permission.asked",
            activity: "permission",
            properties: {
              requestID: entry.requestID,
              toolName: entry.toolName,
              input: entry.input,
              sessionID: sessionId,
              hasProjectOption: true,
            },
          },
        })
        entry.ptyMatched = true
      }
    }
  }

  state.timer = setTimeout(checkPermPty, 200)
}

function handleUserPrompt(data: Record<string, any>) {
  log(`[UserPromptSubmit] all keys: ${Object.keys(data).join(", ")} | data: ${JSON.stringify(data).slice(0, 500)}`)
  const text = data.prompt || ""
  if (!text) return

  // Detect /clear command via hook
  if (text.trim() === "/clear") {
    if (remoteClearTimestamp && Date.now() - remoteClearTimestamp < 3000) {
      // remote clear in progress, skip
    } else {
      handleLocalClear()
    }
    return
  }

  // When /compact is initiated by remote execute_command, compactWatchTimer is already running.
  // Don't clear it — handleStop needs it to detect wasCompactActive and defer finalization.
  const isRemoteCompact = text.trim().toLowerCase() === "/compact" && !!compactWatchTimer

  // Cancel any pending chunks/stops from previous response
  if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null }
  if (pendingStopTimer) { clearTimeout(pendingStopTimer); pendingStopTimer = null }
  if (slashFallbackTimer) { clearTimeout(slashFallbackTimer); slashFallbackTimer = null }
  if (!isRemoteCompact) {
    if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
    if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }
  }
  accumulatedText = ""
  accumulatedNotifications = ""
  introSent = false
  lastUserPrompt = text
  isResponding = true
  startTranscriptPolling()
  // Fallback: set search start here if stdin handler didn't fire
  if (ptySearchStart === 0) ptySearchStart = ptyBuffer.length

  streamMsgId = nextMsgId()

  // Cache user message
  cacheMessage({ id: streamMsgId + "_u", role: "user", content: text, timestamp: Date.now() })

  send({
    type: "opencode_event",
    event: {
      type: "tui.prompt.append",
      properties: { text, sessionID: sessionId },
    },
  })
  send({
    type: "opencode_event",
    event: {
      type: "tui.command.execute",
      activity: "busy",
      properties: { command: "prompt.submit", sessionID: sessionId },
    },
  })

  // Slash commands like /compact, /undo, /redo may not trigger the Stop hook
  // because they are handled client-side without an AI response.
  // Set a fallback timer that finalizes the response if Stop never fires.
  // Skip for remote-initiated /compact — compactWatchTimer/compactTimeoutTimer handle that case.
  const trimmed = text.trim().toLowerCase()
  if (trimmed.startsWith("/") && ["/compact", "/undo", "/redo"].includes(trimmed) && !isRemoteCompact) {
    if (slashFallbackTimer) clearTimeout(slashFallbackTimer)
    slashFallbackTimer = setTimeout(() => {
      if (!isResponding) return
      slashFallbackTimer = null
      finalizeResponse()
    }, 15000)
  }
}

function handleStop(data: Record<string, any>) {
  // Don't stop transcript polling here — let it keep running so tool sections
  // and intermediate results are streamed to clients during multi-turn agent
  // responses. finalizeResponse() will stop it when the full response ends.
  // Cancel slash command fallback — Stop hook fired normally
  if (slashFallbackTimer) { clearTimeout(slashFallbackTimer); slashFallbackTimer = null }

  // Check if compact watch is active — if so, don't clear timers or finalize yet.
  // The compact watch timer will detect "Compacted" in PTY output and call finalizeResponse().
  const wasCompactActive = !!compactWatchTimer

  const text = data.last_assistant_message || ""

  // Capture transcript path for full message extraction
  if (data.transcript_path) {
    transcriptPath = data.transcript_path
    lastTranscriptPath = data.transcript_path
  }


  // Accumulate text from multi-turn agent responses
  if (text) {
    accumulatedText += (accumulatedText ? "\n\n" : "") + text
  }

  // Cancel previous pending completion
  if (pendingStopTimer) clearTimeout(pendingStopTimer)
  if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null }
  for (const [, entry] of pendingPerms) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pendingPerms.clear()

  if (wasCompactActive) {
    // Compact is in progress — accumulate text but defer finalization.
    // The compact watch timer will call finalizeResponse() when "Compacted" is detected.
    return
  }

  // Clear compact timers when NOT in compact mode (safety cleanup)
  if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
  if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }

  // Debounce: wait 500ms for more Stops before finalizing
  pendingStopTimer = setTimeout(() => {
    pendingStopTimer = null
    finalizeResponse()
  }, 500)
}

// ── Transcript Streaming (real-time deltas during response) ─────

function startTranscriptPolling() {
  if (streamPollTimer) clearTimeout(streamPollTimer)
  streamSentText = ""
  streamLastFileSize = 0
  // Always start polling — if transcriptPath is empty, pollTranscript will
  // discover it via discoverTranscriptPath() fallback. Skipping the timer
  // here means streaming never starts, causing the entire response to be
  // sent at once via finalizeResponse's chunked path (slow on mini-program).
  streamPollTimer = setTimeout(pollTranscript, 500)
}

function stopTranscriptPolling() {
  if (streamPollTimer) {
    clearTimeout(streamPollTimer)
    streamPollTimer = null
  }
}

/**
 * Extract formatted response text from the transcript for the current prompt.
 * Produces the same formatting as extractTranscriptText() but scoped to the
 * current response only (content after the last user prompt).
 */
function extractResponseText(): { text: string; hasPendingTools: boolean; isInterrupted: boolean; questionData?: { questionItems: any[]; questionAnswers: string[][] } } {
  if (!transcriptPath || !lastUserPrompt) return { text: "", hasPendingTools: false, isInterrupted: false }
  try {
    if (!fs.existsSync(transcriptPath)) return { text: "", hasPendingTools: false, isInterrupted: false }
    const content = fs.readFileSync(transcriptPath, "utf-8")
    const lines = content.split("\n")

    // Find the last user message matching our prompt
    let promptIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          let text = ""
          if (typeof contentArr === "string") text = contentArr
          else if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "text" && block.text) text += block.text
            }
          }
          if (text.trim() === lastUserPrompt.trim()) {
            promptIdx = i
            break
          }
        }
      } catch {}
    }
    if (promptIdx < 0) return { text: "", hasPendingTools: false, isInterrupted: false }

    // Build tool_use_id → tool_result mapping from lines after the prompt
    const toolResults = new Map<string, { text: string; isError: boolean }>()
    for (let i = promptIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "tool_result" && block.tool_use_id) {
                let output = ""
                if (typeof block.content === "string") output = block.content
                else if (Array.isArray(block.content)) {
                  output = block.content
                    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
                    .join("\n")
                }
                if (output.length > 100000) output = output.slice(0, 100000) + "..."
                toolResults.set(block.tool_use_id, { text: output.trim(), isError: !!block.is_error })
                if (block.is_error && pendingPerms.has(block.tool_use_id)) {
                  const entry = pendingPerms.get(block.tool_use_id)!
                  if (entry.timer) clearTimeout(entry.timer)
                  pendingPerms.delete(block.tool_use_id)
                }
              }
            }
          }
        }
      } catch {}
    }

    let hasPendingTools = false
    let isInterrupted = false
    let questionData: { questionItems: any[]; questionAnswers: string[][] } | undefined

    // Extract and format assistant content after the prompt
    const parts: string[] = []
    for (let i = promptIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== "assistant") continue
        const contentArr = msg.message?.content || msg.content
        if (!Array.isArray(contentArr)) continue
        for (const block of contentArr) {
          if (block.type === "text" && block.text?.trim()) {
            const raw = block.text.trim()
            let text = stripAnsi(raw)
            if (raw !== text) log(`[extractResponse] stripAnsi: "${raw.slice(0, 120)}" -> "${text.slice(0, 120)}"`)
            text = text.replace(/^\*\*(.+)\*\*\s*$/gm, "#### $1")
            parts.push(text)
          } else if (block.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
            if (block.name === "AskUserQuestion" || block.name === "AskQuestion") {
              if (!toolResults.has(block.id)) hasPendingTools = true
              const input = block.input || {}
              const qItems = input.questions || []
              const rawResult = toolResults.get(block.id)
              const rawOutput = rawResult?.text || ""
              const qAnswers: string[][] = qItems.map(() => [])
              const ansRegex = /"([^"]*)"="([^"]*)"/g
              let am
              let qi = -1
              let lastHeader = ""
              while ((am = ansRegex.exec(rawOutput)) !== null) {
                if (am[1] !== lastHeader) { qi++; lastHeader = am[1] }
                if (qi >= 0 && qi < qItems.length) {
                  for (const a of am[2].split(",").map((s: string) => s.trim()).filter(Boolean)) {
                    qAnswers[qi].push(a)
                  }
                }
              }
              questionData = { questionItems: qItems, questionAnswers: qAnswers }
              continue
            }
            const toolName = block.name || "Tool"
            const input = block.input || {}
            let inputStr: string
            if (toolName === "Edit" || toolName === "MultiEdit") {
              if (input.old_string && input.new_string) {
                inputStr = buildEditDiff(input.file_path || "", input.old_string, input.new_string)
              } else {
                inputStr = (input.file_path || "") + (input.old_string ? `\n---\n${input.old_string}` : "")
              }
            } else if (toolName === "Write") {
              inputStr = input.file_path || ""
              if (input.content) inputStr += `\n---\n${input.content}`
            } else {
              inputStr =
                input.command || input.file_path || input.pattern ||
                input.query || input.content || JSON.stringify(input)
            }
            inputStr = inputStr.replace(/```/g, "``'")
            const inputLimit = 100000
            if (inputStr.length > inputLimit) inputStr = inputStr.slice(0, inputLimit) + "..."
            const result = toolResults.get(block.id)
            let output = result?.text || ""
            const isError = result?.isError || false
            const hasResult = !!result
            if (!hasResult) {
              hasPendingTools = true
            }
            output = output.replace(/```/g, "``'")
            const errorTag = isError ? " !error" : ""
            let formatted = `**${toolName}** #${block.id}${errorTag}\n\`\`\`\n${inputStr}\n\`\`\``
            if (output) formatted += `\n\`\`\`\n${output}\n\`\`\``
            parts.push(formatted)
          }
        }
      } catch {}
    }

    // Detect if response was interrupted by user
    const interruptRe = /^\[Request interrupted by user/i
    for (let i = lines.length - 1; i > promptIdx; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "text" && interruptRe.test((block.text || "").trim())) {
                isInterrupted = true
              }
            }
          } else if (typeof contentArr === "string" && interruptRe.test(contentArr.trim())) {
            isInterrupted = true
          }
          break
        }
      } catch {}
    }

    return { text: parts.join("\n\n"), hasPendingTools, isInterrupted, questionData }
  } catch (e: any) {
    return { text: "", hasPendingTools: false, isInterrupted: false }
  }
}

/** Extract the last tool_use result from the transcript (e.g. AskUserQuestion answer) */
function extractLastToolResult(): string {
  if (!transcriptPath) return ""
  try {
    if (!fs.existsSync(transcriptPath)) return ""
    const content = fs.readFileSync(transcriptPath, "utf-8")
    const lines = content.trim().split("\n")
    // Find the last tool_result in the transcript
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "tool_result") {
                let output = ""
                if (typeof block.content === "string") output = block.content
                else if (Array.isArray(block.content)) {
                  output = block.content.map((c: any) =>
                    c.type === "text" ? c.text : JSON.stringify(c)
                  ).join("\n")
                }
                return output.trim()
              }
            }
          }
        }
      } catch {}
    }
    return ""
  } catch {
    return ""
  }
}

function pollTranscript() {
  if (!isResponding) {
    streamPollTimer = null
    return
  }

  // transcriptPath should be set by SessionStart; fallback to discovery
  if (!transcriptPath) {
    const tp = discoverTranscriptPath()
    if (tp) {
      transcriptPath = tp
    } else {
      streamPollTimer = setTimeout(pollTranscript, 300)
      return
    }
  }

  try {
    // Skip if file hasn't changed since last poll
    if (fs.existsSync(transcriptPath)) {
      const stat = fs.statSync(transcriptPath)
      if (stat.size === streamLastFileSize) {
        streamPollTimer = setTimeout(pollTranscript, 200)
        return
      }
      streamLastFileSize = stat.size
    } else {
      streamPollTimer = setTimeout(pollTranscript, 300)
      return
    }

    const responseResult = extractResponseText()
    const responseText = responseResult.text

    // Detect "[Request interrupted by user for tool use]" — Claude stopped after permission rejection
    let interrupted = false
    try {
      const rawContent = fs.readFileSync(transcriptPath, "utf-8")
      const rawLines = rawContent.split("\n")
      const lastUserLine = rawLines[rawLines.length - 1]?.trim() || rawLines[rawLines.length - 2]?.trim() || ""
      let lastUserText = ""
      try {
        const lastMsg = JSON.parse(lastUserLine)
        if (lastMsg.type === "user") {
          const c = lastMsg.message?.content || lastMsg.content
          if (Array.isArray(c)) lastUserText = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" | ")
          else if (typeof c === "string") lastUserText = c
        }
      } catch {}
      if (lastUserText) log(`Stream:poll last user msg="${lastUserText.slice(0, 150).replace(/\n/g, "\\n")}"`)
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 5); i--) {
        const line = rawLines[i].trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === "user") {
            const contentArr = msg.message?.content || msg.content
            if (Array.isArray(contentArr)) {
              for (const block of contentArr) {
                if (block.type === "text" && (
                  block.text?.includes("[Request interrupted by user for tool use]")
                  || block.text?.includes("[Request interrupted by user]")
                )) {
                  interrupted = true
                  break
                }
              }
            }
            break // only check the latest user message
          }
        } catch {}
        if (interrupted) break
      }
    } catch {}

    if (responseText && responseText.length > streamSentText.length) {
      if (responseText.startsWith(streamSentText)) {
        const delta = responseText.slice(streamSentText.length)
        if (delta) {
          streamSentText = responseText
          sendStreamDelta(delta)
        }
      } else {
        // Text changed in a non-append way — replace client text without resetting typewriter
        streamSentText = responseText
        send({
          type: "opencode_event",
          event: {
            type: "streaming.replace",
            properties: { field: "text", delta: responseText, sessionID: sessionId },
          },
        })
      }
    }

    // Detect API error messages (isApiErrorMessage: true, error: "unknown") in transcript
    let apiErrorText = ""
    try {
      const rawContent = fs.readFileSync(transcriptPath, "utf-8")
      const rawLines = rawContent.split("\n")
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 5); i--) {
        const line = rawLines[i].trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === "assistant" && msg.isApiErrorMessage) {
            const contentArr = msg.message?.content || msg.content
            if (Array.isArray(contentArr)) {
              for (const block of contentArr) {
                if (block.type === "text" && block.text) {
                  apiErrorText = block.text.trim()
                  break
                }
              }
            }
            break
          }
        } catch {}
        if (apiErrorText) break
      }
    } catch {}

    if (interrupted) {
      finalizeResponse()
      return
    }

    if (apiErrorText) {
      // Send the error text as streaming content so the client displays it
      if (apiErrorText.length > streamSentText.length) {
        streamSentText = apiErrorText
        send({
          type: "opencode_event",
          event: {
            type: "streaming.replace",
            properties: { field: "text", delta: apiErrorText, sessionID: sessionId, isError: true },
          },
        })
      }
      finalizeResponse()
      return
    }
  } catch (e: any) {
  }

  streamPollTimer = setTimeout(pollTranscript, 200)
}

/**
 * Read the Claude Code transcript file and extract ALL content in order:
 * assistant text + tool calls with output, correctly interleaved.
 * The transcript is a JSONL file with one message object per line.
 */
function extractTranscriptText(): string {
  if (!transcriptPath) return ""
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8")
    const lines = content.trim().split("\n")
    const parts: string[] = []


    // Build a map of tool_use_id → tool_result for quick lookup
    const toolResults = new Map<string, string>()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "tool_result" && block.tool_use_id) {
                let output = ""
                if (typeof block.content === "string") output = block.content
                else if (Array.isArray(block.content)) {
                  output = block.content.map((c: any) =>
                    c.type === "text" ? c.text : JSON.stringify(c)
                  ).join("\n")
                }
                if (output.length > 100000) output = output.slice(0, 100000) + "..."
                toolResults.set(block.tool_use_id, output.trim())
              }
            }
          }
        }
      } catch {}
    }

    // Now iterate in order, extracting assistant content
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== "assistant") continue

        const contentArr = msg.message?.content || msg.content
        if (!Array.isArray(contentArr)) continue

        for (const block of contentArr) {
          if (block.type === "text" && block.text && block.text.trim()) {
            let text = block.text.trim()
            // Convert bold-only lines to h4 headers (task titles, section headers)
            text = text.replace(/^\*\*(.+)\*\*\s*$/gm, "#### $1")
            parts.push(text)
          } else if (block.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
            // Skip AskUserQuestion — rendered as structured tool part by parseTranscriptToMessages
            if (block.name === "AskUserQuestion" || block.name === "AskQuestion") continue
            // Format tool call
            const toolName = block.name || "Tool"
            const input = block.input || {}
            let inputStr: string
            if (toolName === "Edit" || toolName === "MultiEdit") {
              if (input.old_string && input.new_string) {
                inputStr = buildEditDiff(input.file_path || "", input.old_string, input.new_string)
              } else {
                inputStr = (input.file_path || "") + (input.old_string ? `\n---\n${input.old_string}` : "")
              }
            } else if (toolName === "Write") {
              inputStr = input.file_path || ""
              if (input.content) inputStr += `\n---\n${input.content}`
            } else {
              inputStr = input.command || input.file_path || input.pattern
                || input.query || input.content || JSON.stringify(input)
            }
            inputStr = inputStr.replace(/```/g, "``'")
            const inputLimit = 100000
            if (inputStr.length > inputLimit) inputStr = inputStr.slice(0, inputLimit) + "..."

            let output = toolResults.get(block.id) || ""
            // Escape triple backticks in output to avoid breaking the markdown parser
            output = output.replace(/```/g, "``'")
            // Put command in code block for horizontal scrolling (one-line scrollable)
            let delta = `**${toolName}**\n\`\`\`\n${inputStr}\n\`\`\``
            if (output) delta += `\n\`\`\`\n${output}\n\`\`\``
            parts.push(delta)
          }
        }
      } catch {}
    }

    const result = parts.join("\n\n")
    if (parts.length > 0) {
    }
    return result
  } catch (e: any) {
    return ""
  }
}

/**
 * Parse Claude Code JSONL transcript into structured Q&A pairs for history loading.
 * Caches result by transcript path.
 */
function parseTranscriptToMessages(filePath: string): HistoryQAPair[] {
  if (filePath === cachedTranscriptPath && cachedQAPairs.length > 0) {
    try {
      const stat = fs.statSync(filePath)
      if (stat.mtimeMs <= cachedTranscriptMtime) {
        return cachedQAPairs
      }
    } catch {}
  }

  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.trim().split("\n")

    // First pass: build tool_use_id → tool_result mapping
    const toolResults = new Map<string, { text: string; isError: boolean }>()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "user") {
          const contentArr = msg.message?.content || msg.content
          if (Array.isArray(contentArr)) {
            for (const block of contentArr) {
              if (block.type === "tool_result" && block.tool_use_id) {
                let output = ""
                if (typeof block.content === "string") output = block.content
                else if (Array.isArray(block.content)) {
                  output = block.content.map((c: any) =>
                    c.type === "text" ? c.text : JSON.stringify(c)
                  ).join("\n")
                }
                if (output.length > 100000) output = output.slice(0, 100000) + "..."
                toolResults.set(block.tool_use_id, { text: output.trim(), isError: !!block.is_error })
              }
            }
          }
        }
      } catch {}
    }

    // Extract user prompts and assistant responses
    const userMessages: Array<{ idx: number; msg: ClaudeHistoryMessage }> = []
    const assistantMessages: Array<{ idx: number; msg: ClaudeHistoryMessage }> = []
    let msgIdx = 0

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx]
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now()

        if (msg.type === "user") {
          // Only include user messages with text content (not tool_result-only)
          const contentArr = msg.message?.content || msg.content
          const extractCommandInfo = (rawText: string): { text: string; isCommand: boolean } | null => {
            let text = rawText.trim()
            if (!text) return null
            if (text.startsWith("This session is being continued from a previous conversation")) return null
            // Skip caveat messages injected by Claude Code for local commands
            if (text.includes("Caveat: The messages below were generated by the user while running local commands")) return null

            // Extract <local-command-stdout> content before stripping (contains command output like "Set model to xxx")
            const stdoutMatch = rawText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
            const commandStdout = stdoutMatch ? cleanAnsiText(stdoutMatch[1].trim()) : ""

            // Strip <local-command-caveat> blocks entirely (including content)
            text = text.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
            // Strip <local-command-stdout> blocks entirely
            text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
            // Strip remaining tags
            text = text.replace(/<\/?local-command-stdout>/g, "")
            text = text.replace(/<\/?local-command-caveat>/g, "")
            text = text.trim()
            if (!text) return commandStdout ? { text: commandStdout, isCommand: true } : null

            // Extract command name from <command-name> tag
            const cmdNameMatch = text.match(/<command-name>([^<]+)<\/command-name>/)
            if (cmdNameMatch) {
              const cmdText = cmdNameMatch[1].trim()
              text = cmdText.startsWith("/") ? cmdText : `/${cmdText}`
              text = cleanAnsiText(text).trim()
              // Use command stdout as display text when available (e.g., "Set model to xxx")
              return { text: commandStdout || text, isCommand: true }
            }

            // No <command-name> tag — check if this is a PTY-echoed slash command
            // PTY echo may split "/clear" into "//clea\r\nr" or similar artifacts
            const normalized = text.replace(/[\r\n]/g, "").replace(/\/+/g, "/").trim()
            if (/^\/[a-z]/.test(normalized) && !/\s/.test(normalized)) {
              // Looks like a slash command echoed by PTY
              text = cleanAnsiText(normalized).trim()
              return { text, isCommand: true }
            }

            // Check for command output
            const hasCommandStdout = rawText.includes("<local-command-stdout>")
            const isCommand = hasCommandStdout

            text = cleanAnsiText(text).trim()
            if (!text) return null
            return { text, isCommand }
          }

          if (typeof contentArr === "string") {
            const info = extractCommandInfo(contentArr)
            if (info) {
              // Slash command name → command-label (centered badge), output text → command-output
              const isCmdName = info.isCommand && /^\/\w+$/.test(info.text)
              const partType = isCmdName ? "command-label" : (info.isCommand ? "command-output" : "text")
              userMessages.push({
                idx: msgIdx++,
                msg: { id: msg.uuid || `u_${lineIdx}`, role: "user", parts: [{ type: partType, text: info.text }], createdAt: timestamp },
              })
            }
          } else if (Array.isArray(contentArr)) {
            const textParts = contentArr.filter((c: any) => c.type === "text" && c.text?.trim())
            if (textParts.length > 0) {
              let text = textParts.map((c: any) => c.text).join("\n")
              const info = extractCommandInfo(text)
              if (info) {
                const isCmdName = info.isCommand && /^\/\w+$/.test(info.text)
                const partType = isCmdName ? "command-label" : (info.isCommand ? "command-output" : "text")
                userMessages.push({
                  idx: msgIdx++,
                  msg: { id: msg.uuid || `u_${lineIdx}`, role: "user", parts: [{ type: partType, text: info.text }], createdAt: timestamp },
                })
              }
            }
          }
        } else if (msg.type === "system" && msg.subtype === "local_command") {
          // /cost, /model etc. command output
          const rawContent = msg.content || ""
          const stdoutMatch = rawContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
          if (stdoutMatch) {
            const outputText = cleanAnsiText(stdoutMatch[1].trim())
            if (outputText) {
              assistantMessages.push({
                idx: msgIdx++,
                msg: { id: `cmd_${lineIdx}`, role: "assistant", parts: [{ type: "command-output", text: outputText }], createdAt: timestamp },
              })
            }
          }
        } else if (msg.type === "assistant") {
          // Skip synthetic messages (e.g. "No response requested." after /clear)
          const model = msg.message?.model || ""
          if (model === "<synthetic>") continue
          const contentArr = msg.message?.content || msg.content
          if (!Array.isArray(contentArr)) continue

          const parts: ClaudeHistoryPart[] = []
          for (const block of contentArr) {
            if (block.type === "text" && block.text?.trim()) {
              const raw = block.text.trim()
              const cleaned = stripAnsi(raw)
              if (raw !== cleaned) log(`[parseTranscript] stripAnsi: "${raw.slice(0, 120)}" -> "${cleaned.slice(0, 120)}"`)
              parts.push({ type: "text", text: cleaned })
            } else if (block.type === "tool_use" && !HIDDEN_TOOLS.has(block.name)) {
              const toolName = block.name || "Tool"
              const input = block.input || {}

              // AskUserQuestion → structured tool part with questionItems + questionAnswers
              if (toolName === "AskUserQuestion" || toolName === "AskQuestion") {
                const qItems = input.questions || []
                const rawResult = toolResults.get(block.id)
                const rawOutput = rawResult?.text || ""
                // Parse answers from tool_result text: "User has answered... "Q"="A"..."
                const qAnswers: string[][] = qItems.map(() => [])
                const ansRegex = /"([^"]*)"="([^"]*)"/g
                let am
                let qi = -1
                let lastHeader = ""
                while ((am = ansRegex.exec(rawOutput)) !== null) {
                  if (am[1] !== lastHeader) { qi++; lastHeader = am[1] }
                  if (qi >= 0 && qi < qItems.length) {
                    for (const a of am[2].split(",").map(s => s.trim()).filter(Boolean)) {
                      qAnswers[qi].push(a)
                    }
                  }
                }
                const partId = `tq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
                parts.push({
                  type: "tool", id: partId, toolName,
                  questionItems: qItems, questionAnswers: qAnswers,
                } as any)
              } else {
                let command: string
                if (toolName === "Edit" || toolName === "MultiEdit") {
                  if (input.old_string && input.new_string) {
                    command = buildEditDiff(input.file_path || "", input.old_string, input.new_string)
                  } else {
                    command = (input.file_path || "") + (input.old_string ? `\n---\n${input.old_string}` : "")
                  }
                } else if (toolName === "Write") {
                  command = input.file_path || ""
                  if (input.content) command += `\n---\n${input.content}`
                } else {
                  command = input.command || input.file_path || input.pattern
                    || input.query || input.content || JSON.stringify(input)
                }
                const cmdLimit = (toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write") ? 5000 : 500
                if (command.length > cmdLimit) command = command.slice(0, cmdLimit) + "..."
                const result = toolResults.get(block.id)
                let output = result?.text || ""
                const isError = result?.isError || false
                command = stripAnsi(command).replace(/```/g, "``'")
                output = stripAnsi(output).replace(/```/g, "``'")
                if (output.length > 100000) output = output.slice(0, 100000) + "..."
                const partId = block.id || `td-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
                parts.push({ type: "tool-detail", id: partId, toolName, command, output, isError })
              }
            }
          }

          if (parts.length > 0) {
            assistantMessages.push({
              idx: msgIdx++,
              msg: { id: msg.uuid || `a_${lineIdx}`, role: "assistant", parts, createdAt: timestamp },
            })
          }
        }
      } catch {}
    }

    // Group into Q&A pairs: each user message + all assistant messages until next user
    const pairs: HistoryQAPair[] = []
    const allSorted = [...userMessages.map(u => ({ ...u, isUser: true })),
                       ...assistantMessages.map(a => ({ ...a, isUser: false }))]
      .sort((a, b) => a.idx - b.idx)

    let currentUser: ClaudeHistoryMessage | null = null
    let currentAssistants: ClaudeHistoryMessage[] = []

    for (const item of allSorted) {
      if (item.isUser) {
        if (currentUser) {
          pairs.push({ user: currentUser, assistants: currentAssistants })
        }
        currentUser = item.msg
        currentAssistants = []
      } else {
        if (currentUser) {
          currentAssistants.push(item.msg)
        }
      }
    }
    if (currentUser) {
      pairs.push({ user: currentUser, assistants: currentAssistants })
    }

    cachedTranscriptPath = filePath
    cachedQAPairs = pairs
    try { cachedTranscriptMtime = fs.statSync(filePath).mtimeMs } catch {}
    for (const p of pairs) {
      const partTypes = p.assistants.flatMap(a => a.parts.map(pp => `${pp.type}${(pp as any).questionItems ? '(Q)' : ''}`))
    }
    return pairs
  } catch (e: any) {
    return []
  }
}

/**
 * Get the last local_command output from the transcript that was appended
 * after the given file size. Returns the cleaned stdout text or null.
 */
function getLastCommandOutput(filePath: string | undefined, sinceSize = 0, _log = false): string | null {
  if (!filePath || !fs.existsSync(filePath)) {
    if (_log) log(`[getLastCommandOutput] no file: ${filePath || '(empty)'}`)
    return null
  }
  try {
    const stat = fs.statSync(filePath)
    if (_log) log(`[getLastCommandOutput] file=${filePath} size=${stat.size} sinceSize=${sinceSize}`)
    if (stat.size <= sinceSize) return null
    // Read raw bytes and decode — sinceSize is a byte offset from fs.statSync
    const buf = fs.readFileSync(filePath)
    // Find the last complete line boundary before sinceSize (byte offset)
    let startByte = Math.min(sinceSize, buf.length)
    while (startByte > 0 && buf[startByte - 1] !== 0x0A) startByte--
    const tailContent = buf.slice(startByte).toString("utf-8")
    const lines = tailContent.split("\n")
    if (_log) log(`[getLastCommandOutput] startByte=${startByte}, tailLines=${lines.length} scanning forward`)
    // Scan forward, keep last match
    let result: string | null = null
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const entry = JSON.parse(line)
        if (_log) log(`[getLastCommandOutput] line[${i}] type=${entry.type} subtype=${entry.subtype || '(none)'}`)
        if (entry.type === "system" && entry.subtype === "local_command" && entry.content) {
          const match = entry.content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
          if (match) {
            if (_log) log(`[getLastCommandOutput] FOUND match at line[${i}]`)
            result = cleanAnsiText(match[1].trim())
          }
        }
      } catch {}
    }
    if (_log) log(`[getLastCommandOutput] result=${result ? 'found' : 'no matching entry'}`)
    return result
  } catch (e: any) {
    if (_log) log(`[getLastCommandOutput] error: ${e.message}`)
  }
  return null
}

/**
 * Auto-discover transcript path from ~/.claude/sessions/{pid}.json
 * Falls back to scanning for the latest session matching cwd.
 */
function discoverTranscriptPath(): string {
  if (lastTranscriptPath && fs.existsSync(lastTranscriptPath)) {
    return lastTranscriptPath
  }

  const claudeDir = path.join(os.homedir(), ".claude")
  const sessionsDir = path.join(claudeDir, "sessions")
  const cwd = process.cwd()
  const cwdSlug = cwd.replace(/[^a-zA-Z0-9]/g, "-")
  const projectDir = path.join(claudeDir, "projects", cwdSlug)

  try {
    // Try direct lookup by child PID first
    if (ptyProc) {
      const pidFile = path.join(sessionsDir, `${ptyProc.pid}.json`)
      if (fs.existsSync(pidFile)) {
        const data = JSON.parse(fs.readFileSync(pidFile, "utf-8"))
        if (data.sessionId) {
          const tf = path.join(projectDir, `${data.sessionId}.jsonl`)
          if (fs.existsSync(tf)) {
            lastTranscriptPath = tf
            return tf
          }
        }
      }
    }

    // Fallback: scan all session files, pick the latest matching cwd
    const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith(".json"))
    const candidates: Array<{ mtime: number; sessionId: string }> = []
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), "utf-8"))
        if (data.cwd === cwd && data.sessionId) {
          const tf = path.join(projectDir, `${data.sessionId}.jsonl`)
          if (fs.existsSync(tf)) {
            const stat = fs.statSync(tf)
            candidates.push({ mtime: stat.mtimeMs, sessionId: data.sessionId })
          }
        }
      } catch {}
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    if (candidates.length > 0) {
      const tf = path.join(projectDir, `${candidates[0].sessionId}.jsonl`)
      lastTranscriptPath = tf
      return tf
    }
  } catch (e: any) {
  }

  return ""
}

/**
 * Extract the model name from the last assistant message in a transcript.
 * Reads the file from the end for efficiency.
 */
function extractCurrentModel(transcriptPath: string): string | null {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8")
    const lines = content.trim().split("\n")
    // Walk backwards to find the last assistant message with a model field
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === "assistant") {
          const model = msg.message?.model
          if (model) {
            return model
          }
        }
      } catch {}
    }
  } catch (e) {
  }
  return null
}

/**
 * List all Claude Code sessions for the current project directory.
 * Scans ~/.claude/projects/{cwdSlug}/*.jsonl and extracts metadata.
 */
function listClaudeSessions(): Array<{ id: string; title: string; createdAt: number; active: boolean }> {
  const cwdSlug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-")
  const projectDir = path.join(os.homedir(), ".claude", "projects", cwdSlug)

  let files: string[]
  try {
    files = fs.readdirSync(projectDir).filter(f => f.endsWith(".jsonl"))
  } catch {
    return []
  }

  const sessions: Array<{ id: string; title: string; createdAt: number; mtime: number; active: boolean }> = []

  for (const f of files) {
    const filePath = path.join(projectDir, f)
    const id = f.replace(/\.jsonl$/, "")
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch { continue }

    // Extract title from first non-meta user message (skip slash commands)
    let title = ""
    let createdAt = stat.mtimeMs
    try {
      const content = fs.readFileSync(filePath, "utf-8")
      const lines = content.split("\n")
      for (const line of lines) {
        if (!line.trim()) continue
        let entry: Record<string, any>
        try { entry = JSON.parse(line) } catch { continue }
        if (entry.type === "user" && !entry.isMeta) {
          const msg = entry.message
          let text = ""
          if (msg?.content) {
            if (typeof msg.content === "string") {
              text = msg.content
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text" && part.text) {
                  text = part.text
                  break
                }
              }
            }
          }
          // Skip slash commands like /clear, /compact, /resume etc.
          const trimmed = text.trim()
          if (trimmed.startsWith("<command-name>/") || trimmed.startsWith("/")) continue
          title = text
          if (entry.timestamp) {
            createdAt = new Date(entry.timestamp).getTime()
          }
          break
        }
      }
    } catch { /* use defaults */ }

    if (!title) title = id.slice(0, 12) + "..."
    // Truncate long titles and collapse whitespace
    title = title.replace(/\n/g, " ").trim().slice(0, 60)

    sessions.push({
      id,
      title,
      createdAt,
      mtime: stat.mtimeMs,
      active: id === sessionId,
    })
  }

  // Sort by modification time, newest first
  sessions.sort((a, b) => b.mtime - a.mtime)
  return sessions.map(({ id, title, createdAt, active }) => ({ id, title, createdAt, active }))
}

function getPaginatedHistory(page: number, limit: number, specificSessionId?: string) {
  let transcriptFile = ""
  // If a specific session ID is provided, locate its transcript directly
  if (specificSessionId) {
    const cwdSlug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-")
    const projectDir = path.join(os.homedir(), ".claude", "projects", cwdSlug)
    const tf = path.join(projectDir, `${specificSessionId}.jsonl`)
    if (fs.existsSync(tf)) {
      transcriptFile = tf
    }
  }
  // Fallback to lastTranscriptPath (set by SessionStart) or discovery
  if (!transcriptFile) {
    if (lastTranscriptPath && fs.existsSync(lastTranscriptPath)) {
      transcriptFile = lastTranscriptPath
    } else if (!specificSessionId) {
      transcriptFile = discoverTranscriptPath()
    }
  }
  if (!transcriptFile) {
    return { messages: [], page: 0, totalPages: 0, totalPairs: 0, hasMore: false }
  }

  const pairs = parseTranscriptToMessages(transcriptFile)
  const totalPairs = pairs.length
  const totalPages = Math.ceil(totalPairs / limit)

  // Page 1 = newest pairs (end of array)
  const endIdx = pairs.length - (page - 1) * limit
  const startIdx = Math.max(0, pairs.length - page * limit)

  if (endIdx <= 0) {
    return { messages: [], page, totalPages, totalPairs, hasMore: false }
  }

  const pagePairs = pairs.slice(startIdx, endIdx)
  const messages: ClaudeHistoryMessage[] = []
  for (const pair of pagePairs) {
    messages.push(pair.user)
    // Merge all assistant messages in this pair into a single bubble
    if (pair.assistants.length > 0) {
      const mergedParts: ClaudeHistoryPart[] = []
      let lastTs = 0
      for (const a of pair.assistants) {
        mergedParts.push(...a.parts)
        if (a.createdAt > lastTs) lastTs = a.createdAt
      }
      messages.push({
        id: pair.assistants[0].id,
        role: "assistant",
        parts: mergedParts,
        createdAt: lastTs,
      })
    }
  }

  for (const m of messages) {
    if (m.role === "assistant") {
      const firstText = m.parts.find(p => p.type === "text")
      if (firstText) {
        const preview = (firstText as any).text?.slice(0, 120).replace(/\n/g, "\\n") || ""
      }
    }
  }
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text" && /\x1b\[/.test((p as any).text || "")) {
      }
    }
  }
  return {
    messages,
    page,
    totalPages,
    totalPairs,
    hasMore: page < totalPages,
  }
}

function finalizeResponse() {
  stopTranscriptPolling()
  const msgId = streamMsgId || nextMsgId()

  // Compact finalize: skip all text content, just send complete + idle
  if (isCompactFinalize) {
    isCompactFinalize = false
    ptyBuffer = ""
    ptySearchStart = 0
    transcriptPath = ""
    accumulatedText = ""
    accumulatedNotifications = ""
    introSent = false
    isResponding = false
    streamSentText = ""
    // Clear any streamed content on client side
    send({
      type: "opencode_event",
      event: {
        type: "streaming.clear",
        properties: { sessionID: sessionId },
      },
    })
    sendComplete(msgId)
    return
  }

  // One final extraction to catch any remaining content
  const extractResult = extractResponseText()
  const finalResponseText = extractResult.text

  // Check if response was interrupted by user — force finalize regardless of pending tools
  let interrupted = false
  try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      const rawContent = fs.readFileSync(transcriptPath, "utf-8")
      const rawLines = rawContent.split("\n")
      for (let i = rawLines.length - 1; i >= Math.max(0, rawLines.length - 5); i--) {
        const line = rawLines[i].trim()
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === "user") {
            const contentArr = msg.message?.content || msg.content
            if (Array.isArray(contentArr)) {
              for (const block of contentArr) {
                if (block.type === "text" && (
                  block.text?.includes("[Request interrupted by user for tool use]")
                  || block.text?.includes("[Request interrupted by user]")
                )) {
                  interrupted = true
                  break
                }
              }
            }
            break
          }
        } catch {}
        if (interrupted) break
      }
    }
  } catch {}

  // If there are tool_use blocks without tool_result yet, keep polling (unless interrupted)
  if (extractResult.hasPendingTools && !interrupted) {
    // Restart polling if stopped
    startTranscriptPolling()
    // Re-schedule finalize
    if (pendingStopTimer) clearTimeout(pendingStopTimer)
    pendingStopTimer = setTimeout(() => {
      pendingStopTimer = null
      finalizeResponse()
    }, 500)
    return
  }

  // Get full text for caching
  const stopText = accumulatedText
  const fullText = stopText || finalResponseText

  const isInterrupted = extractResult.isInterrupted

  // Clear pending question if interrupted
  if (pendingQuestions.length > 0) {
    pendingQuestions.length = 0
    send({ type: "opencode_event", event: { type: "question.replied", properties: { sessionID: sessionId }, activity: "idle" } })
  }

  // Clear pending permissions if interrupted
  if (isInterrupted) {
    for (const [, entry] of pendingPerms) {
      if (entry.timer) clearTimeout(entry.timer)
      if (entry.ptyMatched) {
        send({ type: "opencode_event", event: { type: "permission.replied", properties: { sessionID: sessionId }, activity: "idle" } })
      }
    }
    pendingPerms.clear()
  }

  ptyBuffer = ""
  ptySearchStart = 0
  transcriptPath = ""
  // NOTE: don't clear lastTranscriptPath — needed for history loading
  accumulatedText = ""
  accumulatedNotifications = ""
  introSent = false
  isResponding = false

  // Send structured AskUserQuestion result before text chunks
  const qResult = lastQuestionResult || extractResult.questionData
  lastQuestionResult = null

  if (qResult) {
    send({
      type: "opencode_event",
      event: {
        type: "message.part.tool",
        properties: {
          messageID: msgId,
          sessionID: sessionId,
          partId: `tq-${Date.now()}`,
          questionItems: qResult.questionItems,
          questionAnswers: qResult.questionAnswers,
        },
      },
    })
  }

  if (streamSentText && finalResponseText.startsWith(streamSentText)) {
    // Content was streamed during response — send remaining delta + complete
    const remaining = finalResponseText.slice(streamSentText.length)
    if (remaining) {
      sendStreamDelta(remaining)
    }
    if (fullText) cacheMessage({ id: msgId, role: "assistant", content: fullText, timestamp: Date.now() })
    sendComplete(msgId, isInterrupted)
  } else if (streamSentText) {
    // Streaming happened but text doesn't match — clear client buffer and re-send
    send({
      type: "opencode_event",
      event: {
        type: "streaming.clear",
        properties: { sessionID: sessionId },
      },
    })
    if (fullText) {
      cacheMessage({ id: msgId, role: "assistant", content: fullText, timestamp: Date.now() })
      const chunks: string[] = []
      for (let i = 0; i < fullText.length; i += STREAM_CHUNK_SIZE) {
        chunks.push(fullText.slice(i, i + STREAM_CHUNK_SIZE))
      }
      let sent = 0
      function sendNextChunk() {
        if (sent >= chunks.length) {
          sendComplete(msgId, isInterrupted)
          chunkTimer = null
          return
        }
        sendRawDelta(chunks[sent])
        sent++
        chunkTimer = setTimeout(sendNextChunk, STREAM_CHUNK_DELAY)
      }
      sendNextChunk()
    } else {
      sendComplete(msgId, isInterrupted)
    }
  } else if (fullText) {
    // No streaming happened — send all content as chunks (original behavior)
    cacheMessage({ id: msgId, role: "assistant", content: fullText, timestamp: Date.now() })
    const chunks: string[] = []
    for (let i = 0; i < fullText.length; i += STREAM_CHUNK_SIZE) {
      chunks.push(fullText.slice(i, i + STREAM_CHUNK_SIZE))
    }
    let sent = 0
    function sendNextChunk() {
      if (sent >= chunks.length) {
        sendComplete(msgId, isInterrupted)
        chunkTimer = null
        return
      }
      sendRawDelta(chunks[sent])
      sent++
      chunkTimer = setTimeout(sendNextChunk, STREAM_CHUNK_DELAY)
    }
    sendNextChunk()
  } else {
    sendComplete(msgId, isInterrupted)
  }

  streamSentText = ""
}

/** Send a raw text delta without accumulating into notifications */
function sendRawDelta(delta: string) {
  if (!streamMsgId || !delta) return

  send({
    type: "opencode_event",
    event: {
      type: "message.part.delta",
      properties: {
        messageID: streamMsgId,
        sessionID: sessionId,
        partId: `part_${streamMsgId}`,
        field: "text",
        delta,
      },
    },
  })
}

function sendComplete(msgId: string, aborted = false) {
  send({
    type: "opencode_event",
    event: {
      type: "message.complete",
      properties: { messageID: msgId, sessionID: sessionId, ...(aborted ? { aborted: true } : {}) },
    },
  })
  send({
    type: "opencode_event",
    event: {
      type: "session.idle",
      activity: "idle",
      properties: { sessionID: sessionId },
    },
  })
  send({ type: "update_session", opencodeSessionId: sessionId })
  streamMsgId = ""
}

function handlePostToolUse(data: Record<string, any>) {
  const toolName = data.tool_name || "Tool"

  // Clear pending plan approval on PostToolUse for ExitPlanMode
  if (toolName === "ExitPlanMode") {
    if (pendingPlanTimer) { clearTimeout(pendingPlanTimer); pendingPlanTimer = null }
    if (planPromptActive) {
      send({
        type: "opencode_event",
        event: { type: "plan.replied", properties: { sessionID: sessionId }, activity: "busy" },
      })
    }
    pendingPlanId = null
    planPromptActive = false
  }

  // Clear pending permission state on PostToolUse — matched by toolUseId.
  const postToolUseId = data.tool_use_id || ""
  let entry: PendingPermState | undefined
  if (postToolUseId) {
    entry = pendingPerms.get(postToolUseId)
  } else {
    // Fallback: Claude Code is serial, first entry is the current tool
    const firstKey = pendingPerms.keys().next().value
    if (firstKey) entry = pendingPerms.get(firstKey)
  }
  if (entry) {
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
    if (entry.ptyMatched) {
      // permission.asked was already sent — send permission.replied to dismiss
      send({
        type: "opencode_event",
        event: { type: "permission.replied", properties: { sessionID: sessionId }, activity: "busy" },
      })
    } else {
    }
    pendingPerms.delete(entry.toolUseId)
  }

  // Clear pending question if AskUserQuestion was answered from terminal
  if ((toolName === "AskUserQuestion" || toolName === "AskQuestion") && pendingQuestions.length > 0) {
    pendingQuestions.shift()
    send({
      type: "opencode_event",
      event: { type: "question.replied", properties: { sessionID: sessionId }, activity: "busy" },
    })
  }

  if (!isResponding || !streamMsgId) return

  // Skip internal tools (TaskCreate, TaskUpdate, etc.)
  if (HIDDEN_TOOLS.has(toolName)) return

  // Notify clients that this tool has finished (only if tool.started was sent)
  if (entry?.toolStartSent) {
    send({
      type: "opencode_event",
      event: {
        type: "tool.ended",
        properties: { toolName, sessionID: sessionId },
      },
    })
  }

  // Don't stream tool calls — they'll be sent at finalize time from transcript
  // Just send a minimal "working" indicator on the first visible tool call
  if (!introSent) {
    introSent = true
  }

}

// ── WebSocket: Connect to OpenRemote server ──────────────────

function connectWs() {
  if (ws && ws.readyState <= 1) return

  try {
    ws = new WebSocket(SERVER_URL)
  } catch {
    setTimeout(connectWs, RECONNECT_MS)
    return
  }

  ws.on("open", () => {
    if (sessionInitialized) {
      doRegister()
    } else {
      // Register will be triggered by handleSessionStart when it fires.
      // Fallback timeout in case SessionStart never arrives.
      if (!discoveryTimer) {
        discoveryTimer = setTimeout(() => {
          discoveryTimer = null
          doRegister()
        }, 5000)
      }
    }
  })

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString())
      handleMessage(msg)
    } catch (e) {
    }
  })

  ws.on("close", () => {
    ws = null
    registered = false
    setTimeout(connectWs, RECONNECT_MS)
  })

  ws.on("error", () => {})
}

// ── Send helpers ─────────────────────────────────────────────

function send(msg: Record<string, unknown>) {
  if (ws && ws.readyState === 1) {
    const json = JSON.stringify(msg)
    ws.send(json)
    const t = msg.type as string
    if (t === "opencode_event") {
      const evt = msg.event as Record<string, any> | undefined
    } else if (t === "api_response") {
    } else if (t === "register" || t === "update_session") {
    } else if (t === "plugin_pong") {
      // skip
    } else {
    }
  } else {
  }
}

function nextMsgId(): string {
  msgCounter++
  return `msg_${msgCounter}`
}

function cacheMessage(m: CachedMessage) {
  messageCache.push(m)
  if (messageCache.length > MAX_MESSAGE_CACHE) {
    messageCache.splice(0, messageCache.length - MAX_MESSAGE_CACHE)
  }
}

// ── Handle messages from server ──────────────────────────────

function handleMessage(msg: Record<string, any>) {
  if (msg.type === "register_result") {
    if (msg.success) {
      registered = true
      send({ type: "update_session", opencodeSessionId: sessionId })
      send({
        type: "opencode_event",
        event: {
          type: "session.created",
          properties: {
            sessionID: sessionId,
            info: { id: sessionId, role: "assistant", parts: [] },
          },
        },
      })
    } else {
    }
    return
  }

  if (msg.type === "api_request") {
    handleApiRequest(msg)
    return
  }

}

/**
 * Fallback timer for registration if SessionStart never arrives.
 */
let discoveryTimer: ReturnType<typeof setTimeout> | null = null

function doRegister() {
  if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null }
  discoveryTimer = null
  if (!ws || ws.readyState !== 1) {
    return
  }
  send({
    type: "register",
    token: TOKEN,
    defaultDirectory: process.cwd(),
    machineId: getMachineId(),
    pluginType: "claude",
  })
}

async function ptySubmitPrompt(text: string): Promise<{ ok: boolean } | { error: string }> {
  if (!ptyProc) return { error: "PTY not running" }
  // Write text first, then \r after a short delay.
  // Writing text + \r atomically can cause Claude Code's Ink TUI to
  // interpret \r as a newline in the input field instead of submit.
  ptyProc.write(text)
  await new Promise<void>(r => setTimeout(r, 80))
  ptyProc.write("\r")
  return { ok: true }
}

async function handleApiRequest(msg: Record<string, any>) {
  const { reqId, method, path, body } = msg

  try {
    let result: any

    // ── Send message: inject text into PTY ──
    if (method === "POST" && path?.match(/^\/session\/[^/]+\/prompt_async$/)) {
      const text = body?.parts?.[0]?.text || body?.text || ""
      if (text && ptyProc) {
        ptySearchStart = ptyBuffer.length
        result = await ptySubmitPrompt(text)
      } else {
        result = { error: "No text or PTY not running" }
      }
    }

    // ── TUI submit prompt (no session id) ──
    else if (method === "POST" && path === "/tui/submit-prompt") {
      const text = body?.parts?.[0]?.text || body?.text || ""
      if (text && ptyProc) {
        result = await ptySubmitPrompt(text)
      } else {
        result = { error: "No text or PTY not running" }
      }
    }

    // ── Abort: Ctrl+C ──
    else if (method === "POST" && path?.match(/^\/session\/[^/]+\/abort$/)) {
      if (ptyProc) {
        ptyProc.write("\x03")
        if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null }
        if (pendingStopTimer) { clearTimeout(pendingStopTimer); pendingStopTimer = null }
        if (slashFallbackTimer) { clearTimeout(slashFallbackTimer); slashFallbackTimer = null }
        if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
        if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }
        if (pendingPlanTimer) { clearTimeout(pendingPlanTimer); pendingPlanTimer = null }
        if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
        if (statusTimeoutTimer) { clearTimeout(statusTimeoutTimer); statusTimeoutTimer = null }
        accumulatedText = ""
        accumulatedNotifications = ""
        ptyBuffer = ""
        ptySearchStart = 0
        // Capture pending state before clearing
        const hadPermission = pendingPerms.size > 0
        const hadQuestion = pendingQuestions.length > 0
        const hadPlan = planPromptActive
        // Clear pending permission state
        for (const [, entry] of pendingPerms) {
          if (entry.timer) clearTimeout(entry.timer)
        }
        pendingPerms.clear()
        // Clear pending question state
        pendingQuestions.length = 0
        // Clear pending plan state
        pendingPlanId = null
        planPromptActive = false
        lastQuestionResult = null
        isResponding = false
        // Notify clients to dismiss any active dialogs
        if (hadPermission) {
          send({ type: "opencode_event", event: { type: "permission.replied", properties: { sessionID: sessionId }, activity: "busy" } })
        }
        if (hadQuestion) {
          send({ type: "opencode_event", event: { type: "question.replied", properties: { sessionID: sessionId }, activity: "busy" } })
        }
        if (hadPlan) {
          send({ type: "opencode_event", event: { type: "plan.replied", properties: { sessionID: sessionId }, activity: "busy" } })
        }
        send({ type: "opencode_event", event: { type: "session.idle", properties: { sessionID: sessionId }, activity: "idle" } })
        result = { ok: true }
      } else {
        result = { error: "PTY not running" }
      }
    }

    // ── Get messages: return cached or paginated history ──
    else if (method === "GET" && path?.match(/^\/session\/[^/]+\/message$/)) {
      // Extract session ID from URL path: /session/{sessionId}/message
      const pathSid = path.replace(/^\/session\//, "").replace(/\/message$/, "")
      if (body?.page != null && body?.limit != null) {
        // Paginated history from transcript — use the specific session ID
        result = getPaginatedHistory(Number(body.page) || 1, Number(body.limit) || 7, pathSid)
      } else {
        // Legacy: return full in-memory cache
        result = messageCache.map((m) => ({
          id: m.id,
          role: m.role,
          parts: [{ type: "text", text: m.content }],
          createdAt: m.timestamp,
        }))
      }
    }

    // ── List sessions: return all sessions for current project ──
    else if (method === "GET" && path === "/session") {
      result = listClaudeSessions()
    }

    // ── Create session: just acknowledge ──
    else if (method === "POST" && path === "/session") {
      sessionId = generateSessionId()
      result = { id: sessionId }
    }

    // ── Delete session: Ctrl+C + reset ──
    else if (method === "DELETE" && path?.match(/^\/session\/[^/]+$/)) {
      if (ptyProc) ptyProc.write("\x03")
      result = { ok: true }
    }

    // ── Execute command ──
    else if (method === "EXECUTE_COMMAND") {
      result = handleExecuteCommand(body, reqId)
      if (result === "__DEFERRED__") return  // response sent asynchronously
    }

    // ── List files ──
    else if (method === "LIST_FILES" || method === "READ_FILE" || method === "BROWSE_DIR") {
      result = { error: "Not supported in Claude Code bridge" }
    }

    // ── Plan reply: navigate Claude Code's plan approval selection ──
    // Claude Code shows: 1. Yes, auto-accept edits / 2. Yes, manually approve edits / 3. Tell Claude what to change
    // We navigate with arrow keys (\x1b[B = down) and confirm with Enter (\r)
    else if (method === "POST" && path?.match(/^\/plan\/[^/]+\/reply$/)) {
      const choice = body?.choice || "auto"
      if (ptyProc) {
        if (choice === "manual") {
          // Option 2: down arrow once + Enter (delayed)
          setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, 0)
          setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, 200)
        } else if (choice === "feedback") {
          // Option 3: down arrow twice + Enter (delayed), then type feedback
          setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, 0)
          setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, 100)
          setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, 300)
          const feedback = body?.feedback || ""
          if (feedback) {
            setTimeout(() => {
              ptyProc?.write(feedback + "\r")
            }, 800)
          }
        } else {
          // Default: auto (option 1) — just press Enter
          ptyProc.write("\r")
        }
      }
      pendingPlanId = null
      planPromptActive = false
      send({
        type: "opencode_event",
        event: {
          type: "plan.replied",
          properties: { sessionID: sessionId },
          activity: "busy",
        },
      })
      result = { ok: true }
    }

    // ── Permission reply: navigate Claude Code's selection UI ──
    // Claude Code shows a selectable list: Yes / [Yes, always] / No
    // We navigate with arrow keys (\x1b[B = down) and confirm with Enter (\r)
    // Delay between navigation and Enter — same fix as ptySubmitPrompt:
    // Ink TUI can't process \r correctly when sent atomically with escape sequences.
    else if (method === "POST" && path?.match(/^\/permission\/[^/]+\/reply$/)) {
      const reply = body?.reply
      // Find Map entry by requestID from URL path
      const requestIDFromPath = path.match(/^\/permission\/([^/]+)\/reply$/)?.[1] || ""
      let permEntry: PendingPermState | undefined
      for (const [, entry] of pendingPerms) {
        if (entry.requestID === requestIDFromPath) {
          permEntry = entry
          break
        }
      }
      // Fallback: take first entry (serial execution)
      if (!permEntry && pendingPerms.size > 0) {
        permEntry = pendingPerms.values().next().value
      }
      if (ptyProc) {
        if (reply === "always" || reply === "project") {
          ptyProc.write("\x1b[B")
          await new Promise<void>(r => setTimeout(r, 80))
          ptyProc.write("\r")
        } else if (reply === "reject" || reply === "no") {
          const optCount = permEntry?.optionCount || 2
          const navDown = "\x1b[B".repeat(optCount - 1)
          ptyProc.write(navDown)
          await new Promise<void>(r => setTimeout(r, 80))
          ptyProc.write("\r")
        } else {
          ptyProc.write("\r")
        }
      }
      if (permEntry) pendingPerms.delete(permEntry.toolUseId)
      send({
        type: "opencode_event",
        event: {
          type: "permission.replied",
          properties: { sessionID: sessionId },
          activity: "busy",
        },
      })
      result = { ok: true }
    }

    // ── Question reply: approve permission + inject answer into PTY ──
    else if (method === "POST" && path?.match(/^\/question\/[^/]+\/(reply|reject)$/)) {
      const isReject = !!body?.isReject || path?.endsWith("/reject")
      const qData = pendingQuestions.shift()
      const questions = qData?.questions || []

      if (isReject) {
        // Reject: navigate to "Chat about this" (options.length + 1) and select it
        const recentPty = ptyBuffer.slice(Math.max(0, ptyBuffer.length - 600))
        const hasPermDialog = /(?:Do you want|Allow.*to|to proceed|use skill|plan mode|tool use|outside of sandbox|network request)/i.test(recentPty)
        if (hasPermDialog) {
          setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, 0)
        }
        const chatIdx = (questions[0]?.options?.length || 0) + 1
        for (let di = 0; di < chatIdx; di++) {
          setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, 1200 + di * 50)
        }
        setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, 1200 + chatIdx * 50 + 500)
        send({ type: "opencode_event", event: { type: "question.rejected", properties: { sessionID: sessionId }, activity: "busy" } })
      } else {
        const answers: Array<{ isCustom: boolean; custom: string; select: number[] }> = body?.answers || []
        log(`[question] reply: answers=${JSON.stringify(answers)} questions=${questions.length}`)
        if (answers.length > 0 && ptyProc) {
          const recentPty = ptyBuffer.slice(Math.max(0, ptyBuffer.length - 600))
          const hasPermDialog = /Do you want|Allow.*to|to proceed/i.test(recentPty)
          let cursor = hasPermDialog ? 1000 : 0

          if (hasPermDialog) {
            setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, 500)
          }

          const totalQ = Math.min(answers.length, questions.length)
          for (let qi = 0; qi < totalQ; qi++) {
            const ans = answers[qi]
            const q = questions[qi]
            const baseDelay = cursor + 1500
            const isMultiSelect = q?.multiSelect === true

            if (ans.isCustom && ans.select.length === 0) {
              // Pure custom answer (no preset options selected)
              const downCount = q?.options?.length || 0
              const text = ans.custom
              log(`[question] qi=${qi} custom-only: downCount=${downCount} text="${text}" baseDelay=${baseDelay} multi=${isMultiSelect}`)
              for (let di = 0; di < downCount; di++) {
                setTimeout(() => {
                  if (!ptyProc) return
                  ptyProc.write("\x1b[B")
                }, baseDelay + di * 50)
              }
              setTimeout(() => {
                if (!ptyProc) return
                log(`[question] qi=${qi} custom-write="${text}"`)
                ptyProc.write(text)
                if (isMultiSelect) setTimeout(() => { if (ptyProc) ptyProc.write(" ") }, 200)
              }, baseDelay + downCount * 50 + 1500)
              if (isMultiSelect) {
                // Multi-select custom: ↓ + Enter to submit, extra Enter for single-question confirm
                setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, baseDelay + downCount * 50 + 2000)
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, baseDelay + downCount * 50 + 2500)
                if (totalQ === 1) {
                  setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, baseDelay + downCount * 50 + 3000)
                  cursor = baseDelay + downCount * 50 + 4000
                } else {
                  cursor = baseDelay + downCount * 50 + 3500
                }
              } else {
                // Single-select custom: just Enter
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, baseDelay + downCount * 50 + 2000)
                cursor = baseDelay + downCount * 50 + 3000
              }
            } else if (isMultiSelect) {
              // Multi-select: process preset options first
              const sorted = [...ans.select].sort((a, b) => a - b)
              log(`[question] qi=${qi} multiSelect: indices=${JSON.stringify(sorted)} hasCustom=${ans.isCustom}`)
              let currentPos = 0
              sorted.forEach((optIdx, si) => {
                const steps = optIdx - currentPos
                currentPos = optIdx
                for (let s = 0; s < steps; s++) {
                  setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, baseDelay + si * 800 + s * 50)
                }
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, baseDelay + si * 800 + steps * 50 + 200)
              })
              const afterSelectDelay = baseDelay + sorted.length * 800 + 500
              if (ans.isCustom && ans.custom) {
                // Multi-select + custom: navigate to custom input, type text, ↓ + Enter
                const optCount = q?.options?.length || 0
                const stepsToInput = optCount - currentPos
                for (let s = 0; s < stepsToInput; s++) {
                  setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, afterSelectDelay + s * 50)
                }
                setTimeout(() => {
                  if (!ptyProc) return
                  log(`[question] qi=${qi} multi-custom-write="${ans.custom}"`)
                  ptyProc.write(ans.custom)
                  setTimeout(() => { if (ptyProc) ptyProc.write(" ") }, 200)
                }, afterSelectDelay + stepsToInput * 50 + 1000)
                setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, afterSelectDelay + stepsToInput * 50 + 2000)
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, afterSelectDelay + stepsToInput * 50 + 2500)
                if (totalQ === 1) {
                  // Single question: extra Enter to confirm submit page
                  setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, afterSelectDelay + stepsToInput * 50 + 3000)
                  cursor = afterSelectDelay + stepsToInput * 50 + 4000
                } else {
                  cursor = afterSelectDelay + stepsToInput * 50 + 3500
                }
              } else if (totalQ > 1) {
                // No custom, multi-question: right arrow to advance
                setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[C") }, afterSelectDelay)
                cursor = afterSelectDelay + 1000
              } else {
                // No custom, single question: Tab + Enter
                setTimeout(() => { if (ptyProc) ptyProc.write("\t") }, afterSelectDelay)
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, afterSelectDelay + 500)
                cursor = afterSelectDelay + 1500
              }
            } else {
              // Single-select: ↓×optIdx + Enter
              const optIdx = ans.select[0] ?? -1
              if (optIdx >= 0) {
                log(`[question] qi=${qi} select: optIdx=${optIdx}`)
                for (let di = 0; di < optIdx; di++) {
                  setTimeout(() => { if (ptyProc) ptyProc.write("\x1b[B") }, baseDelay + di * 50)
                }
                const selectEndTime = optIdx * 50 + 200
                setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, baseDelay + selectEndTime)
                cursor = baseDelay + selectEndTime + 1000
              }
            }
          }
          // Multiple questions: always submit form after all questions answered
          if (totalQ > 1) {
            setTimeout(() => { if (ptyProc) ptyProc.write("\r") }, cursor + 500)
          }
        }
        send({ type: "opencode_event", event: { type: "question.replied", properties: { sessionID: sessionId }, activity: "busy" } })
        if (questions.length > 0 && answers.length > 0) {
          lastQuestionResult = { questionItems: questions, questionAnswers: answers.map(a => a.isCustom ? [a.custom] : a.select.map(String)) }
        }
      }
      result = { ok: true }
    }

    // ── Providers / Agents: return empty ──
    else if (method === "GET" && (path === "/config/providers" || path === "/agent")) {
      result = []
    }

    else {
      result = { error: `Unsupported: ${method} ${path}` }
    }

    send({ type: "api_response", reqId, status: 200, body: result })
  } catch (e: any) {
    send({ type: "api_response", reqId, status: 500, body: { error: e?.message || String(e) } })
  }
}

/**
 * Called when the user types /clear directly in the terminal.
 * Clears local state only — SessionStart hook will provide the new session ID.
 */
function handleLocalClear() {
  messageCache.length = 0
  transcriptPath = ""
  lastTranscriptPath = ""
  cachedTranscriptPath = ""
  cachedQAPairs = []
  cachedTranscriptMtime = 0
  accumulatedText = ""
  accumulatedNotifications = ""
  ptyBuffer = ""
  ptySearchStart = 0
  for (const [, entry] of pendingPerms) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  pendingPerms.clear()
  if (pendingPlanTimer) { clearTimeout(pendingPlanTimer); pendingPlanTimer = null }
  pendingPlanId = null
  planPromptActive = false
  pendingQuestions.length = 0
  isResponding = false
  streamMsgId = ""
  streamSentText = ""
  stopTranscriptPolling()
  sessionInitialized = false
}

/** Reconstruct terminal screen from raw PTY output.
 *  TUI uses cursor positioning (\x1b[row;colH) to draw on different lines.
 *  Convert these into actual newlines so content is properly separated. */
function reconstructTerminalScreen(raw: string): string {
  let s = raw
  // Cursor position: \x1b[row;colH → newline (preserves line breaks)
  s = s.replace(/\x1b\[\d+(?:;\d+)?H/g, "\n")
  // Cursor down: \x1b[nB → n newlines
  s = s.replace(/\x1b\[(\d+)B/g, (_: string, n: string) => "\n".repeat(parseInt(n)))
  // Clear screen / erase
  s = s.replace(/\x1b\[2J/g, "")
  s = s.replace(/\x1b\[\d*J/g, "")
  s = s.replace(/\x1b\[\d*K/g, "")
  // Cursor show/hide
  s = s.replace(/\x1b\[\?25[hl]/g, "")
  // Carriage return → newline
  s = s.replace(/\r\n?/g, "\n")
  // Now strip remaining ANSI (colors, bold, etc.)
  s = stripAnsi(s)
  // Collapse excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n")
  return s
}

/** Split concatenated terminal output into separate lines.
 *  TUI uses cursor positioning to render on different lines,
 *  but ptyBuffer strips ANSI causing all content to merge.
 *  We reconstruct line breaks by detecting value/name boundaries. */
function splitTerminalOutput(text: string): string {
  return text
    // Split after boolean values before next setting name
    .replace(/(true|false|none)([A-Z][a-z])/g, "$1\n$2")
    // Split after numbers+units before next label (e.g. "71.3mTotal" → "71.3m\nTotal")
    .replace(/(\d+[mhds%]?)([A-Z][a-z]{2,})/g, "$1\n$2")
    // Split after common words before capitalized labels (e.g. "daysFavorite" → "days\nFavorite")
    .replace(/(days?|time|plan|streak)([A-Z][a-z]{2,})/g, "$1\n$2")
    // Split after chart day labels before stat labels (e.g. "FriFavorite" → "Fri\nFavorite")
    .replace(/(Mon|Tue|Wed|Thu|Fri|Sat|Sun)([A-Z][a-z]{2,})/g, "$1\n$2")
    // Split after closing box-drawing before text
    .replace(/([╯╮])([A-Za-z⌕])/g, "$1\n$2")
    // Add space after colons
    .replace(/:(?=\S)/g, ": ")
    // Collapse multiple spaces
    .replace(/  +/g, " ")
}

/** Clean raw PTY output for status display */
function cleanPtyOutput(raw: string): string[] {
  const tabNames = ["Status", "Config", "Usage", "Stats"]
  const tabNamePat = tabNames.join("|")
  const split = splitTerminalOutput(raw)
  return split
    .split("\n")
    .map(l => l.trim())
    .filter(l => {
      if (!l) return false
      // Remove TUI tab navigation line
      if (new RegExp(`^(${tabNamePat})\\s+(${tabNamePat}|Loading)`).test(l)) return false
      // Remove prompt with echoed command
      if (/^[❯›>]\s*\/\w/.test(l)) return false
      // Remove footer
      if (/Esc\s*t?o\s*cancel/i.test(l)) return false
      // Remove box-drawing search box
      if (/^╭.*╮.*│.*╰.*╯/.test(l) && /Search/.test(l)) return false
      // Remove pure separator lines
      if (/^[─━\-═]+$/.test(l)) return false
      // Remove chart lines (contain month abbreviations + bar characters like █░▓▒)
      if (/May.*Jun.*Jul.*Aug/.test(l) && /[█░▓▒]/.test(l)) return false
      // Remove chart header (Overview Models with months but no bars)
      if (/^Overview Models/.test(l) && /May.*Jun/.test(l)) return false
      // Remove decorative single characters (✢, ✳, ✻, ·)
      if (/^[✢✳✻·✶✹]$/.test(l)) return false
      // Remove TUI footer hints (↓ stats, ←/→, ↓ to return, ctrl+s, more below, etc.)
      if (/↓|←\/→|Esc to close|more below|to switch|to return|ctrl\+s/.test(l)) return false
      return true
    })
}

function captureNextStatusTab() {
  if (!ptyProc) return

  // Phase: scroll down until "more below" disappears (max 30)
  if (statusPhase === "scroll_down") {
    // Only check RECENT output (since last down arrow) for "more below".
    // Checking the entire buffer would always find old "more below" text.
    const recentBuf = ptyBuffer.slice(statusLastScrollPos)
    // First iteration (statusDownSent === 0) always sends a down arrow unconditionally,
    // since we entered scroll_down because we already saw "more below" in capture phase.
    const hasMore = statusDownSent === 0 || /more below/i.test(recentBuf)
    if (hasMore && statusDownSent < 30) {
      statusLastScrollPos = ptyBuffer.length
      ptyProc.write("\x1b[B")  // down arrow
      statusDownSent++
      return
    }
    // Done scrolling down — capture ALL content from the tab start (deduplicated)
    const fullBuf = ptyBuffer.slice(statusTabBufStart)
    const allLines = cleanPtyOutput(fullBuf)
    const uniqueLines = [...new Set(allLines)]
    const tabName = STATUS_TAB_NAMES[statusTabIndex] || `Tab${statusTabIndex + 1}`
    statusCapturedTabs.push({ name: tabName, content: uniqueLines.join("\n") || "无内容" })
    for (let i = 0; i < uniqueLines.length; i++) {
    }
    // Now scroll back up to restore position for tab navigation
    statusPhase = "scroll_up"
    statusUpSent = 0
    return
  }

  // Phase: scroll back up so right-arrow can switch tabs
  if (statusPhase === "scroll_up") {
    if (statusUpSent < statusDownSent) {
      ptyProc.write("\x1b[A")  // up arrow
      statusUpSent++
      return
    }
    // Back at top — content already captured during scroll_down, go to next tab
    statusPhase = "capture"
    statusTabIndex++
    statusTabBufStart = ptyBuffer.length
    statusTabCheckCount = 0
    statusStableCount = 0
    statusPrevOutput = ""
    statusDidScroll = false
    if (statusTabIndex < STATUS_TAB_NAMES.length) {
      ptyProc.write("\x1b[C")
    } else {
      if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
      if (statusTimeoutTimer) { clearTimeout(statusTimeoutTimer); statusTimeoutTimer = null }
      ptyProc.write("\x1b")
      statusTuiOpen = false
      sendStatusTabsResponse()
    }
    return
  }

  // Phase: normal capture
  statusTabCheckCount++
  const newOutput = ptyBuffer.slice(statusTabBufStart)
  if (newOutput.length < 10) return
  if (newOutput === statusPrevOutput) {
    statusStableCount++
  } else {
    statusPrevOutput = newOutput
    statusStableCount = 0
  }
  // Config tab (index 1) needs more checks — "more below" indicator may appear late
  const minStable = statusTabIndex === 1 ? 3 : 2
  const maxChecks = statusTabIndex === 1 ? 12 : 8
  if (statusStableCount < minStable && statusTabCheckCount < maxChecks) return

  // Check if Config tab needs scrolling (retry across multiple checks until captured)
  if (statusPhase === "capture" && statusTabIndex === 1 && !statusDidScroll) {
    // Match "6 more below", "↓ 6 more below", or just "more below"
    const moreMatch = newOutput.match(/(\d+)\s*more below/i) || newOutput.match(/more below/i)
    if (moreMatch) {
      const count = moreMatch[1] || "?"
      statusPhase = "scroll_down"
      statusDownSent = 0
      statusLastScrollPos = ptyBuffer.length
      statusDidScroll = true
      return
    }
    // If no "more below" found yet and haven't exhausted checks, keep trying
    if (statusTabCheckCount < maxChecks) return
  }
  // Capture
  const lines = cleanPtyOutput(newOutput)
  const content = lines.join("\n")
  const tabName = STATUS_TAB_NAMES[statusTabIndex] || `Tab${statusTabIndex + 1}`
  statusCapturedTabs.push({ name: tabName, content: content || "无内容" })
  for (let i = 0; i < lines.length; i++) {
  }
  statusTabIndex++
  statusTabBufStart = ptyBuffer.length
  statusTabCheckCount = 0
  statusStableCount = 0
  statusPrevOutput = ""
  statusDidScroll = false
  if (statusTabIndex < STATUS_TAB_NAMES.length) {
    ptyProc.write("\x1b[C")
  } else {
    if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
    if (statusTimeoutTimer) { clearTimeout(statusTimeoutTimer); statusTimeoutTimer = null }
    ptyProc.write("\x1b")
    statusTuiOpen = false
    sendStatusTabsResponse()
  }
}

function sendStatusTabsResponse() {
  const body = statusCapturedTabs.length > 0
    ? { tabs: statusCapturedTabs }
    : { text: "无状态信息" }
  send({ type: "api_response", reqId: statusCaptureReqId, status: 200, body })
  statusCapturedTabs = []
  statusTabIndex = 0
}

function handleExecuteCommand(body: Record<string, any> | undefined, reqId: string = ""): any {
  const cmd = body?.command as string
  if (!cmd) return { error: "Missing command" }

  switch (cmd) {
    case "new_session":
      if (ptyProc) {
        remoteClearTimestamp = Date.now()
        ptyProc.write("/clear\r")
      }
      // handleLocalClear will be called by stdin/hook detection,
      // then SessionStart will provide the new session ID.
      return { id: sessionId, pendingInit: true }

    case "get_current_session": {
      const cwdSlug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-")
      const projectDir = path.join(os.homedir(), ".claude", "projects", cwdSlug)
      const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`)
      const hasTranscript = fs.existsSync(transcriptFile)

      const firstPermEntry = pendingPerms.values().next().value
      const pendingPermission = firstPermEntry ? {
        requestID: firstPermEntry.requestID, toolName: firstPermEntry.toolName,
        input: firstPermEntry.input, hasProjectOption: firstPermEntry.optionCount >= 3,
      } : null
      const pendingPlan = planPromptActive && pendingPlanId ? { requestID: pendingPlanId } : null
      const pendingQuestion = pendingQuestions.length > 0
        ? { id: pendingQuestions[0].id, questions: pendingQuestions[0].questions } : null

      const liveData: Record<string, any> = {
        sessionID: sessionId,
        hasTranscript,
        isResponding,
        pendingPermission,
        pendingPlan,
        pendingQuestion,
      }

      if (hasTranscript) {
        const currentModel = extractCurrentModel(transcriptFile)
        if (currentModel) liveData.currentModel = currentModel
      }
      if (isResponding) {
        const responseText = streamSentText || accumulatedText || extractResponseText().text || ""
        if (lastUserPrompt) liveData.liveUserPrompt = lastUserPrompt
        if (responseText) liveData.liveResponseText = responseText
      }
      if (!sessionInitialized) {
        liveData.pendingInit = true
      }
      return liveData
    }

    case "compact": {
      ptyProc?.write("/compact\r")
      const msgId = streamMsgId || nextMsgId()
      streamMsgId = msgId

      // Resolve transcript path
      const tp = lastTranscriptPath || transcriptPath

      // Record PTY buffer length at compact start to avoid matching old "Compacted" text
      const compactStartBufLen = ptyBuffer.length

      // Record current transcript file state before compact
      let preCompactMtime = 0
      if (tp) {
        try {
          const stat = fs.statSync(tp)
          preCompactMtime = stat.mtimeMs
        } catch (e) {
        }
      } else {
      }

      if (compactWatchTimer) clearInterval(compactWatchTimer)
      if (compactTimeoutTimer) clearTimeout(compactTimeoutTimer)

      const compactStart = Date.now()
      let lastActivityTime = compactStart

      compactWatchTimer = setInterval(() => {
        // Check NEW PTY output (after compact started) for "Compacted"
        const newOutput = ptyBuffer.slice(compactStartBufLen)
        const hasCompacted = newOutput.includes("Compacted") || newOutput.includes("compacted")

        // Check transcript file mtime change
        let fileChanged = false
        let currentMtime = 0
        const watchPath = lastTranscriptPath || transcriptPath
        if (watchPath && preCompactMtime > 0) {
          try {
            const stat = fs.statSync(watchPath)
            currentMtime = stat.mtimeMs
            if (stat.mtimeMs > preCompactMtime + 500) {
              fileChanged = true
            }
          } catch {}
        }

        const elapsed = ((Date.now() - compactStart) / 1000).toFixed(1)

        if (hasCompacted) {
          if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
          if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }
          isCompactFinalize = true
          finalizeResponse()
        } else if (fileChanged) {
          if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
          if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }
          isCompactFinalize = true
          finalizeResponse()
        } else {
        }
      }, 3000)

      return { ok: true }
    }

    case "cost": {
      if (!ptyProc) return { error: "PTY not running" }
      const tf = lastTranscriptPath || discoverTranscriptPath()
      let costFileSize = 0
      if (tf && fs.existsSync(tf)) {
        try { costFileSize = fs.statSync(tf).size } catch {}
      }
      // Log last line before submitting
      if (tf && fs.existsSync(tf)) {
        try {
          const raw = fs.readFileSync(tf, "utf-8")
          const allLines = raw.trim().split("\n")
          const lastLine = allLines[allLines.length - 1]
          log(`[cost] BEFORE submit: tf=${tf}, sinceSize=${costFileSize}, totalLines=${allLines.length}, lastLine=${lastLine.slice(0, 200)}`)
        } catch {}
      }
      ptyProc.write("/cost\r")
      const costReqId = reqId
      let costCheckCount = 0
      const costTimer = setInterval(() => {
        costCheckCount++
        const text = getLastCommandOutput(tf, costFileSize, true)
        if (costCheckCount <= 3 || text) {
          log(`[cost] poll #${costCheckCount}: ${text ? 'FOUND' : 'not yet'}`)
        }
        if (text) {
          clearInterval(costTimer)
          log(`[cost] result: ${text.split("\n")[0]}`)
          send({ type: "api_response", reqId: costReqId, status: 200, body: { text } })
        } else if (costCheckCount > 30) {
          clearInterval(costTimer)
          send({ type: "api_response", reqId: costReqId, status: 500, body: { error: "Cost query timed out" } })
        }
      }, 500)
      return "__DEFERRED__"
    }

    case "status": {
      if (!ptyProc) return { error: "PTY not running" }
      statusCaptureReqId = reqId
      statusCapturedTabs = []
      statusTabIndex = 0
      statusTabBufStart = ptyBuffer.length
      statusTabCheckCount = 0
      statusStableCount = 0
      statusPrevOutput = ""
      statusPhase = "capture"
      statusDownSent = 0
      statusUpSent = 0
      statusDidScroll = false
      statusLastScrollPos = 0
      statusTuiOpen = true
      if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
      if (statusTimeoutTimer) { clearTimeout(statusTimeoutTimer); statusTimeoutTimer = null }
      ptyProc.write("/status\r")
      // Wait for first tab to render
      statusCaptureTimer = setInterval(() => {
        captureNextStatusTab()
      }, 500)
      // Safety timeout
      statusTimeoutTimer = setTimeout(() => {
        if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
        statusTimeoutTimer = null
        if (statusTuiOpen && ptyProc) ptyProc.write("\x1b")
        statusTuiOpen = false
        sendStatusTabsResponse()
      }, 15000)
      return "__DEFERRED__"
    }

    case "status_navigate_tab": {
      if (!ptyProc) return { error: "PTY not running" }
      const target = body?.args?.tabIndex ?? 0
      // Navigate to target tab by sending right arrow keys
      ptyProc.write("\x1b[C".repeat(target))
      // Capture the new page
      const navBufStart = ptyBuffer.length
      let navCheckCount = 0
      const navReqId = reqId
      const navTimer = setInterval(() => {
        navCheckCount++
        const navOutput = ptyBuffer.slice(navBufStart)
        if (navOutput.length > 10 || navCheckCount > 5) {
          clearInterval(navTimer)
          const lines = cleanPtyOutput(navOutput)
          send({ type: "api_response", reqId: navReqId, status: 200, body: { text: lines.join("\n") || "无内容" } })
        }
      }, 600)
      return "__DEFERRED__"
    }

    case "dismiss_status": {
      // Stop any ongoing capture
      if (statusCaptureTimer) { clearInterval(statusCaptureTimer); statusCaptureTimer = null }
      if (statusTimeoutTimer) { clearTimeout(statusTimeoutTimer); statusTimeoutTimer = null }
      if (statusTuiOpen && ptyProc) {
        ptyProc.write("\x1b")
        statusTuiOpen = false
      }
      return { ok: true }
    }

    case "compact_status": {
      const watchPath = lastTranscriptPath || transcriptPath
      if (watchPath) {
        try {
          const stat = fs.statSync(watchPath)
          const age = Date.now() - stat.mtimeMs
          return { running: age < 30000, mtime: stat.mtimeMs, age }
        } catch {
          return { running: false, error: "cannot stat transcript" }
        }
      }
      return { running: false }
    }

    case "abort":
      ptyProc?.write("\x03")
      if (compactWatchTimer) { clearInterval(compactWatchTimer); compactWatchTimer = null }
      if (compactTimeoutTimer) { clearTimeout(compactTimeoutTimer); compactTimeoutTimer = null }
      return { ok: true }

    case "get_sessions":
      return listClaudeSessions()

    case "switch_session": {
      const targetId = (body?.args?.targetSessionId || body?.args?.sessionId || "") as string
      if (!targetId || !ptyProc) return { error: "Missing targetSessionId or PTY not running" }
      // Reset in-memory state
      messageCache.length = 0
      accumulatedText = ""
      accumulatedNotifications = ""
      ptyBuffer = ""
      ptySearchStart = 0
      isResponding = false
      lastUserPrompt = ""
      transcriptPath = ""
      cachedTranscriptPath = ""
      cachedQAPairs = []
      cachedTranscriptMtime = 0
      streamSentText = ""
      sessionInitialized = false
      // Optimistically set session ID — SessionStart will fire after /resume
      sessionId = targetId
      const cwdSlug = process.cwd().replace(/[^a-zA-Z0-9]/g, "-")
      lastTranscriptPath = path.join(os.homedir(), ".claude", "projects", cwdSlug, `${targetId}.jsonl`)
      ptyProc.write(`/resume ${targetId}\r`)
      return { id: targetId }
    }

    default: {
      // Support commands with args (e.g. /compact <instructions>, /plan <description>)
      const argKeys = ['instructions', 'path', 'description', 'question', 'name', 'title', 'pr'] as const
      const argParts: string[] = []
      for (const k of argKeys) {
        const v = (body?.args?.[k] as string)?.trim()
        if (v) argParts.push(v)
      }
      const argStr = argParts.length > 0 ? ` ${argParts.join(' ')}` : ''
      if (ptyProc) {
        ptyProc.write(`/${cmd}${argStr}\r`)
      }
      return { ok: true }
    }
  }
}

// ── Utilities ────────────────────────────────────────────────

const LOG_FILE = path.join(os.homedir(), ".openremote", "bridge.log")

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  fs.appendFileSync(LOG_FILE, line)
}

function generateSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function getMachineId(): string {
  return os.hostname()
}

// ── Startup ──────────────────────────────────────────────────


async function main() {
  await startHookServer()
  startPty()
  connectWs()
}

main()

// Heartbeat
setInterval(() => send({ type: "plugin_pong" }), PING_INTERVAL_MS)

// Cleanup on exit
process.on("exit", () => {
  ptyProc?.kill()
  ws?.close()
})
