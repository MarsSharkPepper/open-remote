/**
 * ANSI parser — extracts structured messages from Claude Code's terminal output.
 *
 * Claude Code uses Ink (React for CLI) which renders a rich TUI. We don't try
 * to fully parse it. Instead we:
 *   1. Strip ANSI escape sequences to get plain text
 *   2. Buffer lines and detect message-like patterns
 *   3. Emit opencode_event-compatible events for the chat UI
 */

// Matches ANSI escape sequences: CSI sequences, OSC, etc.
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?\x07|\x1b\[.*?(?:\x1b|$)/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

export interface ParsedEvent {
  type: string
  text: string
  role: "user" | "assistant"
}

/**
 * LineBuffer — accumulates stripped lines and detects Claude Code message boundaries.
 *
 * Heuristics:
 *   - Lines starting with ">" are user prompts (Claude Code shows `>` prefix)
 *   - Lines starting with "⏺" or "●" or containing tool patterns are assistant content
 *   - Empty lines mark paragraph breaks within a message
 *   - We emit a message when we detect a role change or a long pause
 */
export class AnsiParser {
  private buffer: string[] = []
  private currentRole: "user" | "assistant" | null = null
  private currentText: string[] = []

  /** Feed raw PTY output, returns parsed events */
  feed(raw: string): ParsedEvent[] {
    const events: ParsedEvent[] = []
    const stripped = stripAnsi(raw)
    const lines = stripped.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines but keep them as paragraph breaks
      if (!trimmed) {
        if (this.currentText.length > 0) {
          this.currentText.push("")
        }
        continue
      }

      // Detect user prompt — Claude Code shows "> text" for user input
      if (trimmed.startsWith("> ") || trimmed.startsWith(">")) {
        // Flush any pending assistant message
        if (this.currentRole === "assistant" && this.currentText.length > 0) {
          events.push(this.flushMessage())
        }

        this.currentRole = "user"
        const text = trimmed.startsWith("> ") ? trimmed.slice(2) : trimmed.slice(1)
        this.currentText = [text]
        events.push(this.flushMessage())
        continue
      }

      // Detect tool calls — patterns like "⏺", "●", "▸", or [Tool: name]
      const isToolCall = /^[⏺●▸◆]/.test(trimmed) ||
        /^\[[\w-]+\]/.test(trimmed) ||
        /^(Reading|Editing|Writing|Searching|Running|Executing|Creating|Browsing)/.test(trimmed)

      // If we see assistant content, accumulate
      if (this.currentRole !== "assistant") {
        // Flush any pending user message
        if (this.currentRole === "user" && this.currentText.length > 0) {
          events.push(this.flushMessage())
        }
        this.currentRole = "assistant"
      }

      if (isToolCall) {
        // Tool calls get their own event
        if (this.currentText.length > 0) {
          events.push(this.flushMessage())
        }
        this.currentRole = "assistant"
        this.currentText = [trimmed]
        events.push(this.flushMessage())
      } else {
        this.currentText.push(trimmed)
      }
    }

    return events
  }

  /** Flush and return the current accumulated message */
  private flushMessage(): ParsedEvent {
    const text = this.currentText.join("\n").trim()
    const role = this.currentRole || "assistant"
    const event: ParsedEvent = { type: "message", text, role }
    this.currentText = []
    this.currentRole = null
    return event
  }

  /** Flush any remaining buffered content */
  flush(): ParsedEvent | null {
    if (this.currentText.length === 0) return null
    return this.flushMessage()
  }
}
