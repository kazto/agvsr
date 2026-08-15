import { describe, expect, it } from "bun:test";
import { isUsageLimitError } from "../src/daemon/daemon.ts";

describe("usage limit error classification", () => {
  it.each([
    "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
    "You have hit your 5-hour usage limit",
    "rate limit exceeded",
    "quota has been reached",
    "Too many requests",
  ])("classifies a non-retryable provider response: %s", (message) => {
    expect(isUsageLimitError(message)).toBe(true);
  });

  it("does not classify an ordinary worker failure", () => {
    expect(isUsageLimitError("test assertion failed with exit code 1")).toBe(false);
  });
});
