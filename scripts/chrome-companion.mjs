import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const chromeDirectory = () => path.join(os.homedir(), "Library/Application Support/Google/Chrome")
export const extensionDirectory = fileURLToPath(new URL("../browser", import.meta.url))
export const extensionID = "camdllkfdgkbgjpmlkoogfmjjemccpkb"

async function readJSON(file) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return null }
}

export function manifestExtensionID(manifest) {
  if (typeof manifest?.key !== "string") return null
  return createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
}

export async function chromeProfiles(directory = chromeDirectory(), id = extensionID) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const profiles = await Promise.all(entries.filter(entry => entry.isDirectory() && !["Guest Profile", "System Profile"].includes(entry.name)).map(async ({ name: idOnDisk }) => {
    const folder = path.join(directory, idOnDisk)
    const [secure, regular] = await Promise.all(["Secure Preferences", "Preferences"].map(file => readJSON(path.join(folder, file))))
    const settings = secure?.extensions?.settings?.[id] ?? regular?.extensions?.settings?.[id]
    if (!settings && !regular?.profile && !secure?.profile && !/^(Default|Profile \d+)$/.test(idOnDisk)) return null
    const reasons = settings?.disable_reasons
    // Newer Chrome omits the legacy state and stores disabled reasons as an array.
    const enabled = !!settings && typeof settings === "object" && !Array.isArray(settings) &&
      (settings.state === undefined || settings.state === 1) &&
      !(Array.isArray(reasons) ? reasons.length : reasons)
    const display = regular?.profile?.name ?? secure?.profile?.name
    const name = typeof display === "string" ? display.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : ""
    const unpackedPath = enabled && settings.location === 4 && typeof settings.path === "string" && path.isAbsolute(settings.path) ? settings.path : null
    return { id: idOnDisk, name: name || idOnDisk, enabled, unpackedPath }
  }))
  return profiles.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
}

export async function installedManifestVersions(directory, id) {
  const profiles = await chromeProfiles(directory, id)
  const paths = new Set(profiles.map(profile => profile.unpackedPath).filter(Boolean))
  const manifests = await Promise.all([...paths].map(folder => readJSON(path.join(folder, "manifest.json"))))
  return [...new Set(manifests.filter(manifest => manifestExtensionID(manifest) === id && typeof manifest.version === "string")
    .map(manifest => manifest.version))]
}

export async function chromeSetup({ directory, run = spawnSync } = {}) {
  const profiles = await chromeProfiles(directory)
  const installed = profiles.filter(profile => profile.enabled)
  if (installed.length === profiles.length && installed.length) return ""
  if (installed.length) return `Annotate is enabled in these Chrome profiles: ${installed.map(profile => profile.name).join(", ")}. Open the page in one of them and press Alt+Shift+A.`
  const copied = run("pbcopy", [], { input: extensionDirectory, timeout: 3000 }).status === 0
  const revealed = run("open", ["-R", extensionDirectory], { timeout: 3000 }).status === 0
  return [
    `Load the Annotate extension from ${extensionDirectory}${copied ? " (copied to clipboard)" : ""}${revealed ? " (revealed in Finder)" : ""}.`,
    `Open chrome://extensions. If Annotate is listed, turn it on. Otherwise enable Developer mode and choose Load unpacked. Press ⌘⇧G and ${copied ? "paste the path" : "enter the path above"}.`,
    'For local HTML, open Details and enable "Allow access to file URLs". Open the page and press Alt+Shift+A.',
  ].join("\n")
}
