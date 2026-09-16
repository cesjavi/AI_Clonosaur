import { describe, expect, it } from "vitest";
import { parseTwitterArchive, parseTwitterTimestamp } from "./twitter";

describe("parseTwitterArchive", () => {
  it("parses the window.YTD.tweet.part0 = [...] wrapper", () => {
    const content = `window.YTD.tweet.part0 = [{"tweet":{"created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"hola"}}]`;
    expect(parseTwitterArchive(content)).toEqual([{ created_at: "Wed Oct 10 20:19:24 +0000 2018", full_text: "hola" }]);
  });

  it("skips entries with a missing or malformed 'tweet' key instead of throwing", () => {
    const content = JSON.stringify([
      { tweet: { created_at: "Wed Oct 10 20:19:24 +0000 2018", full_text: "ok" } },
      { notATweet: true },
      {},
    ]);
    expect(parseTwitterArchive(content)).toEqual([
      { created_at: "Wed Oct 10 20:19:24 +0000 2018", full_text: "ok" },
    ]);
  });

  it("throws a friendly error when no array is found at all", () => {
    expect(() => parseTwitterArchive("not a tweet export")).toThrow(/no se encontró el array/);
  });

  it("throws a friendly error for invalid JSON", () => {
    expect(() => parseTwitterArchive("window.YTD.tweet.part0 = [{broken")).toThrow(/JSON de tweets inválido/);
  });
});

describe("parseTwitterTimestamp", () => {
  it("parses the Twitter archive date format", () => {
    expect(parseTwitterTimestamp("Wed Oct 10 20:19:24 +0000 2018")).toBe("2018-10-10T20:19:24.000Z");
  });

  it("applies a non-zero UTC offset", () => {
    // 17:19:24 -03:00 == 20:19:24 UTC
    expect(parseTwitterTimestamp("Wed Oct 10 17:19:24 -0300 2018")).toBe("2018-10-10T20:19:24.000Z");
  });

  it("returns null for an unrecognized format", () => {
    expect(parseTwitterTimestamp("2018-10-10")).toBeNull();
  });
});
