import { describe, expect, it } from "vitest";
import { isTrustedOrigin } from "../src/middleware/security.js";

describe("production request origin validation", () => {
  const publicOrigin = "https://datalens.example.com";

  it("accepts the exact configured HTTPS origin", () => {
    expect(isTrustedOrigin(publicOrigin, publicOrigin)).toBe(true);
  });

  it("rejects missing, opaque, malformed and non-canonical origins", () => {
    expect(isTrustedOrigin(undefined, publicOrigin)).toBe(false);
    expect(isTrustedOrigin("null", publicOrigin)).toBe(false);
    expect(isTrustedOrigin("not-a-url", publicOrigin)).toBe(false);
    expect(isTrustedOrigin(publicOrigin + "/path", publicOrigin)).toBe(false);
  });

  it("rejects different schemes, hosts, subdomains and ports", () => {
    expect(isTrustedOrigin("http://datalens.example.com", publicOrigin)).toBe(false);
    expect(isTrustedOrigin("https://evil.example.com", publicOrigin)).toBe(false);
    expect(isTrustedOrigin("https://sub.datalens.example.com", publicOrigin)).toBe(false);
    expect(isTrustedOrigin("https://datalens.example.com:8443", publicOrigin)).toBe(false);
  });
});
