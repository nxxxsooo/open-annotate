function versionParts(version) {
  if (typeof version !== "string") return null
  const parts = version.split("."), numbers = parts.map(Number)
  if (parts.length > 4 || !numbers.some(Boolean) || numbers.some((part, index) =>
    !Number.isInteger(part) || part < 0 || part > 65535 || String(part) !== parts[index])) return null
  return numbers
}

export function newerVersion(candidate, loaded) {
  const next = versionParts(candidate), current = versionParts(loaded)
  if (!next || !current) return false
  for (let index = 0; index < 4; index++) {
    const difference = (next[index] ?? 0) - (current[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}

export async function developmentInstall(api) {
  try { return (await api.management.getSelf()).installType === "development" } catch { return false }
}

export async function newerDiskVersion(api, reportedVersions) {
  const loaded = api.runtime.getManifest().version
  if (!Array.isArray(reportedVersions) || !reportedVersions.some(version => newerVersion(version, loaded))) return null
  // The host cannot identify the requesting profile. This uncached resource is
  // served from the caller's own extension directory, even before Chrome reloads it.
  try {
    const response = await fetch(api.runtime.getURL("manifest.json"), { cache: "no-store" })
    const { version } = await response.json()
    if (newerVersion(version, loaded) && reportedVersions.includes(version)) return version
  } catch { /* Ignore missing or half-written files during an update. */ }
  return null
}

export async function reloadIdleExtension(api, version, panelID) {
  const storage = await api.storage.local.get(null)
  const pendingFeedback = Object.entries(storage).some(([key, value]) => {
    if (key.startsWith("draft:")) return !!value?.value
    return key.startsWith("note:") && value && !value.deleted && value.sentRevision !== value.revision
  })
  if (storage.outbox || pendingFeedback) return false
  if (storage.autoReloadVersion && !newerVersion(version, storage.autoReloadVersion)) return false
  // The caller holds its composer idle; another panel could have edits that
  // haven't reached storage yet. Without a reliable context count, defer.
  const panels = await api.runtime.getContexts({ documentUrls: [api.runtime.getURL("panel.html")] })
  if (panels.length !== 1 || panels[0].documentId !== panelID) return false
  // Session storage is cleared by runtime.reload(); keep the attempted target
  // in local storage so a failed reload or worker restart cannot loop.
  await api.storage.local.set({ autoReloadVersion: version })
  api.runtime.reload()
  return true
}
