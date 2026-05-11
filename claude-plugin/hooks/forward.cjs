// Hook forwarder — reads Claude Code hook data from stdin,
// POSTs it to the bridge's HTTP server.
// Used as the "command" in .claude/settings.json hooks.

// Read hook port from file first (always up-to-date after bridge restarts),
// then env var, then hardcoded default.
let PORT = 0
try {
  const portFile = require("path").join(require("os").homedir(), ".openremote", "hook_port")
  PORT = parseInt(require("fs").readFileSync(portFile, "utf8").trim(), 10)
} catch {}
if (!PORT) PORT = parseInt(process.env.OPENREMOTE_HOOK_PORT || "19831", 10)

let data = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => data += chunk)
process.stdin.on("end", () => {
  require("fs").appendFileSync(
    require("path").join(require("os").homedir(), ".openremote", "hook_debug.log"),
    `[${new Date().toISOString()}] ${data}\n`
  )
  const req = require("http").request({
    hostname: "127.0.0.1",
    port: PORT,
    path: "/hook",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: 2000,
  }, () => process.exit(0))
  req.on("error", () => process.exit(0))
  req.on("timeout", () => { req.destroy(); process.exit(0) })
  req.write(data)
  req.end()
})
