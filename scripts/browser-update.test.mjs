import { test } from "node:test"
import assert from "node:assert/strict"
import { developmentInstall, newerDiskVersion, newerVersion, reloadIdleExtension } from "../browser/update.mjs"

test("Chrome manifest versions compare components numerically and reject invalid input", () => {
  for (const [disk, loaded] of [["0.20.10", "0.20.2"], ["1", "0.20.1"], ["3.0.0.1", "3"], ["65535", "65534"]]) {
    assert.equal(newerVersion(disk, loaded), true)
    assert.equal(newerVersion(loaded, disk), false)
  }
  for (const version of ["1", "1.0", "1.0.0.0", "01.3", "2.0-beta", "65536", "1.0.0.0.1", "2\n", "", undefined]) {
    assert.equal(newerVersion(version, "1.0"), false)
  }
})

test("reload checks require a development install and the caller's own on-disk version", async () => {
  const api = { management: { getSelf: async () => ({ installType: "development" }) },
    runtime: { getManifest: () => ({ version: "1" }), getURL: () => 'data:application/json,{"version":"2"}' } }
  assert.equal(await developmentInstall(api), true)
  assert.equal(await developmentInstall({ management: { getSelf: async () => ({ installType: "normal" }) } }), false)
  assert.equal(await developmentInstall({}), false)
  assert.equal(await newerDiskVersion(api, ["3"]), null)
  assert.equal(await newerDiskVersion(api, ["3", "2"]), "2")
  api.runtime.getURL = () => "data:application/json,broken"
  assert.equal(await newerDiskVersion(api, ["3", "2"]), null)
})

test("auto-reload defers for unsent notes, drafts on other pages, retries or another panel", async () => {
  const storage = { "note:other:id": { revision: 2, sentRevision: 1 } }
  const panels = [{ documentId: "current" }]
  let reloads = 0
  const api = { storage: { local: { get: async () => ({ ...storage }), set: async values => Object.assign(storage, values) } },
    runtime: { getURL: file => file, getContexts: async () => panels, reload: () => { reloads++ } } }
  const reload = () => reloadIdleExtension(api, "0.20.2", "current")
  assert.equal(await reload(), false)
  storage["note:other:id"].sentRevision = 2
  storage["draft:other"] = { value: { comment: "Recover me", anchor: { selector: "#other" } } }
  assert.equal(await reload(), false)
  storage["draft:other"].value = null
  storage.outbox = { batchID: "pending" }
  assert.equal(await reload(), false)
  delete storage.outbox
  panels.push({ documentId: "another" })
  assert.equal(await reload(), false)
  panels.pop()
  assert.equal(storage.autoReloadVersion, undefined)
  assert.equal(await reload(), true)
  assert.equal(storage.autoReloadVersion, "0.20.2")
  assert.equal(await reload(), false, "a repeat handshake reporting the same newer version cannot reload again")
  assert.equal(reloads, 1)
})
