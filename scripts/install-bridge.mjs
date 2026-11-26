import { readFile, mkdir, writeFile, chmod, copyFile, access } from "node:fs/promises"
import { constants } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"
import { registryRoot } from "../bridge/receiver.mjs"
import { chromeDirectory, extensionDirectory, manifestExtensionID } from "./chrome-companion.mjs"
const root = fileURLToPath(new URL("../", import.meta.url))
const matches = async (file, contents) => {
  try { return await readFile(file, "utf8") === contents } catch (error) { if (error.code === "ENOENT") return false; throw error }
}
export async function resolveNode({ execPath = process.execPath, pathEnv = process.env.PATH, platform = process.platform } = {}) {
  if (/^node(?:\.exe)?$/.test(path.basename(execPath))) return execPath
  const executable = platform === "win32" ? "node.exe" : "node"
  const directories = (pathEnv || "").split(path.delimiter).filter(Boolean)
  if (platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin")
  for (const directory of new Set(directories)) {
    const candidate = path.join(directory, executable)
    try { await access(candidate, constants.X_OK); return candidate } catch { /* try the next installation */ }
  }
  throw new Error("Can't find Node.js 22+ for the browser native host; run npm run install:bridge with Node.js")
}
export async function installBridge({ profileDirectory = chromeDirectory(), installRoot = path.join(os.homedir(), ".local/share/opencode-annotate/native"), node, targetsDirectory = registryRoot() } = {}) {
  node ??= await resolveNode()
  const manifest = JSON.parse(await readFile(path.join(extensionDirectory, "manifest.json"), "utf8"))
  const extensionID = manifestExtensionID(manifest)
  if (!extensionID) throw new Error("The Annotate extension manifest is missing its key")
  await mkdir(installRoot, { recursive: true, mode: 0o700 })
  const launcher = path.join(installRoot, "host"), config = path.join(installRoot, "config.json")
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  const configText = JSON.stringify({ extensionID, targetsDirectory, profileDirectory })
  const launcherText = `#!/bin/sh\nexec ${quote(node)} ${quote(path.join(root, "bridge/native-host.mjs"))} ${quote(config)} "$@"\n`
  if (!await matches(config, configText)) await writeFile(config, configText, { mode: 0o600 })
  if (!await matches(launcher, launcherText)) await writeFile(launcher, launcherText, { mode: 0o700 })
  await chmod(launcher, 0o700)
  const directory = path.join(profileDirectory, "NativeMessagingHosts")
  await mkdir(directory, { recursive: true })
  const hostManifest = path.join(directory, "fun.mjshao.annotate.json")
  const manifestText = JSON.stringify({ name: "fun.mjshao.annotate", description: "Paired OpenCode annotation delivery", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extensionID}/`] }, null, 2)
  if (!await matches(hostManifest, manifestText)) {
    try { await copyFile(hostManifest, `${hostManifest}.backup-${Date.now()}`) } catch (error) { if (error.code !== "ENOENT") throw error }
    await writeFile(hostManifest, manifestText, { mode: 0o600 })
  }
  return { extensionID, extensionDirectory, hostManifest, launcher }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.platform !== "darwin") throw new Error("Local installer currently supports macOS only")
  console.log(JSON.stringify(await installBridge(), null, 2))
}
