import fs from "fs"
import path from "path"
import os from "os"

const CREDENTIALS_FILE = path.join(os.homedir(), ".openremote", "credentials.json")

export interface Credentials {
  token: string
}

export function loadCredentials(): Credentials | null {
  const envToken = process.env.OPENREMOTE_TOKEN || ""
  if (envToken) {
    return { token: envToken }
  }

  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"))
      if (data.token) {
        return { token: data.token }
      }
      if (data.accountId) {
        return { token: data.accountId }
      }
    } catch {}
  }

  console.error("")
  console.error("[ClaudeRemote] No token found. Configure one of:")
  console.error("  Option A: Set env var OPENREMOTE_TOKEN")
  console.error("  Option B: Create ~/.openremote/credentials.json with { \"token\": \"ort_xxx\" }")
  console.error("  Get your token from the OpenRemote client (mini-program or WebUI).")
  console.error("")
  return null
}
