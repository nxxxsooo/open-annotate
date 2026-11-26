import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { browserApp, CHROME_APP, openInBrowser, SAFARI_APP } from "./browser-target.mjs"
import { chromeProfiles, chromeSetup, extensionDirectory, extensionID, manifestExtensionID } from "./chrome-companion.mjs"

test("browser choice defaults to Chrome and accepts Safari explicitly", () => {
  assert.equal(browserApp(), CHROME_APP)
  assert.equal(browserApp({}), CHROME_APP)
  assert.equal(browserApp({ browser: "Chrome" }), CHROME_APP)
  assert.equal(browserApp({ browser: "Safari" }), SAFARI_APP)
})
test("unknown browser is rejected rather than opening the wrong app", () => {
  for (const browser of ["Firefox", "", "Google Chrome"]) assert.throws(() => browserApp({ browser }), /browser must be/)
})

async function chromeFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "oa-chrome-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = async (profile, basename, value) => {
    const folder = path.join(directory, profile)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, basename), typeof value === "string" ? value : JSON.stringify(value))
  }
  return { directory, file }
}
const settings = extension => ({ extensions: { settings: { [extensionID]: extension } } })

test("Chrome detection uses enabled settings and display names from each profile", async t => {
  const { directory, file } = await chromeFixture(t)
  const manifest = JSON.parse(await readFile(path.join(extensionDirectory, "manifest.json")))
  assert.equal(manifestExtensionID(manifest), extensionID)
  const unpacked = { location: 4, path: extensionDirectory }
  await file("Default", "Secure Preferences", settings(unpacked))
  await file("Default", "Preferences", { profile: { name: "Personal" } })
  await file("Profile 4", "Secure Preferences", "{corrupt")
  await file("Profile 4", "Preferences", { ...settings({ state: 1, ...unpacked }), profile: { name: "Work" } })
  await file("Profile 7", "Secure Preferences", settings({ ...unpacked, disable_reasons: [1] }))
  await file("Profile 7", "Preferences", settings(unpacked))
  await file("Profile 8", "Preferences", settings({ ...unpacked, state: 0 }))
  await file("Profile 9", "Preferences", "{incomplete")
  await file("Profile 10", "Preferences", { profile: { name: "Missing Annotate" } })
  await file("NativeMessagingHosts", "host.json", {})
  assert.deepEqual(await chromeProfiles(directory), [
    { id: "Default", name: "Personal", enabled: true, unpackedPath: extensionDirectory },
    { id: "Profile 4", name: "Work", enabled: true, unpackedPath: extensionDirectory },
    { id: "Profile 7", name: "Profile 7", enabled: false, unpackedPath: null },
    { id: "Profile 8", name: "Profile 8", enabled: false, unpackedPath: null },
    { id: "Profile 9", name: "Profile 9", enabled: false, unpackedPath: null },
    { id: "Profile 10", name: "Missing Annotate", enabled: false, unpackedPath: null },
  ])
  assert.equal(await chromeSetup({ directory, run: assert.fail }),
    "Annotate is enabled in these Chrome profiles: Personal, Work. Open the page in one of them and press Alt+Shift+A.")
})

test("missing or disabled Chrome install gets a guide with injectable clipboard and Finder", async t => {
  const { directory, file } = await chromeFixture(t)
  const calls = []
  const run = (command, args, options) => { calls.push([command, args, options.input]); return { status: 0 } }
  const guide = await chromeSetup({ directory, run })
  assert.deepEqual(calls, [["pbcopy", [], extensionDirectory], ["open", ["-R", extensionDirectory], undefined]])
  for (const step of [extensionDirectory, "copied to clipboard", "revealed in Finder", "chrome://extensions", "Developer mode",
    "Load unpacked", "⌘⇧G", "paste the path", "Allow access to file URLs", "Alt+Shift+A"]) assert.ok(guide.includes(step), step)
  await file("Default", "Secure Preferences", settings({ disable_reasons: 1 }))
  assert.match(await chromeSetup({ directory, run: () => ({ status: 1 }) }), /enter the path above/)
  await file("Default", "Secure Preferences", settings({ state: 1 }))
  assert.equal(await chromeSetup({ directory, run: assert.fail }), "")
})

test("Chrome review reports setup with or without a target, while Safari bypasses it", async () => {
  const urls = []
  const open = async url => urls.push(url)
  const setup = async () => "Chrome installation guide"
  const chromeGuide = process.platform === "darwin" ? await setup() : ""
  assert.equal(await openInBrowser("file:///fixture.html", {}, { open, setup }), chromeGuide)
  assert.equal(await openInBrowser(undefined, {}, { open, setup }), chromeGuide)
  assert.equal(await openInBrowser("https://example.test", { browser: "Safari" }, { open, setup: assert.fail }), "")
  assert.deepEqual(urls, ["file:///fixture.html", "https://example.test"])
})
