// Open the reviewed page in the browser hosting its companion. Safari is copy-only;
// Chrome retains native messaging delivery.
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { chromeSetup } from "./chrome-companion.mjs"

const execute = promisify(execFile)
export const SAFARI_APP = "Safari"
export const CHROME_APP = "Google Chrome"
export function browserApp(options = {}) {
  const browser = options.browser
  if (browser === undefined || browser === "Chrome") return CHROME_APP
  if (browser === "Safari") return SAFARI_APP
  throw new Error('browser must be "Chrome" or "Safari".')
}
export async function openInBrowser(url, options = {}, { open, setup = chromeSetup } = {}) {
  const app = browserApp(options)
  if (url) {
    if (open) await open(url)
    else {
      if (process.platform !== "darwin") throw new Error("Browser review currently requires macOS")
      await execute("open", ["-a", app, url])
    }
  }
  return app === CHROME_APP && process.platform === "darwin" ? setup() : ""
}
