// Hook forwarder — reads Claude Code hook data from stdin,
// POSTs it to the bridge's HTTP server.
// Used as the "command" in .claude/settings.json hooks.

// Read hook port: env var first (per-process, correct for multi-instance),
// then file fallback (single-instance compat). No hardcoded default — if no
// bridge is running we exit immediately with zero impact on normal Claude usage.
let PORT = parseInt(process.env.OPENREMOTE_HOOK_PORT || "0", 10)
if (!PORT) {
  try {
    const portFile = require("path").join(require("os").homedir(), ".openremote", "hook_port")
    PORT = parseInt(require("fs").readFileSync(portFile, "utf8").trim(), 10)
  } catch {}
}
if (!PORT) process.exit(0)

let data = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => data += chunk)
process.stdin.on("end", () => {
  const req = require("http").request({
    hostname: "127.0.0.1",
    port: PORT,
    path: "/hook",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    timeout: 1000,
  }, () => process.exit(0))
  req.on("error", () => process.exit(0))
  req.on("timeout", () => { req.destroy(); process.exit(0) })
  req.write(data)
  req.end()
})
