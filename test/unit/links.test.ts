import { describe, expect, it } from "vitest"
import { ownFileKey } from "../../src/services/Analyzer.ts"
import { signFile } from "../../src/services/Links.ts"

describe("own file links", () => {
  const verify = (expiry: string, signature: string, key: string) => signFile("secret", Number(expiry), key) === signature
  const expiry = 4102444800

  it("reads owl's own render links from storage", () => {
    const url = `https://8080-x.proxy.net/f/${expiry}/${signFile("secret", expiry, "renders/r_abc.mp4")}/renders/r_abc.mp4`
    expect(ownFileKey(url, verify)).toBe("renders/r_abc.mp4")
  })

  it("ignores other links and bad signatures", () => {
    expect(ownFileKey("https://example.com/video.mp4", verify)).toBeUndefined()
    expect(ownFileKey(`https://x.net/f/${expiry}/wrongsignature/renders/r_abc.mp4`, verify)).toBeUndefined()
    const sneaky = `https://x.net/f/${expiry}/${signFile("secret", expiry, "renders/../db/x")}/renders/%2E%2E/db/x`
    expect(ownFileKey(sneaky, verify)).toBeUndefined()
  })
})
