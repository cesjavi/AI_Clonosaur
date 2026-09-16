import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("./db", () => ({
  dbQuery: (...args: unknown[]) => queryMock(...args),
  dbRun: vi.fn(),
}));

import { createDuplicateChecker, fingerprintFileName, normalizeTimestamp, parseCsv } from "./importCommon";

describe("fingerprintFileName", () => {
  it("strips a browser-style '(1)' duplicate-download suffix", () => {
    expect(fingerprintFileName("export (1).csv")).toBe("export.csv");
  });

  it("strips the suffix with no space before it", () => {
    expect(fingerprintFileName("messages(2).csv")).toBe("messages.csv");
  });

  it("leaves a file name with no suffix untouched (besides lowercasing)", () => {
    expect(fingerprintFileName("Messages.CSV")).toBe("messages.csv");
  });

  it("does not strip non-numeric parenthetical suffixes", () => {
    expect(fingerprintFileName("export (final).csv")).toBe("export (final).csv");
  });

  it("handles a file with no extension", () => {
    expect(fingerprintFileName("archive (3)")).toBe("archive");
  });
});

describe("normalizeTimestamp", () => {
  it("passes through a valid RFC3339 timestamp", () => {
    expect(normalizeTimestamp("2024-03-04T10:15:00Z")).toBe("2024-03-04T10:15:00.000Z");
  });

  it("parses the old Discord export format (MM/DD/YYYY HH:MM AM/PM)", () => {
    expect(normalizeTimestamp("3/4/2024 2:15 PM")).toBe("2024-03-04T14:15:00.000Z");
  });

  it("parses the Reddit export format (YYYY-MM-DD HH:MM:SS UTC)", () => {
    expect(normalizeTimestamp("2024-03-04 10:15:00 UTC")).toBe("2024-03-04T10:15:00.000Z");
  });

  it("parses a plain 'YYYY-MM-DD HH:MM:SS' timestamp", () => {
    expect(normalizeTimestamp("2024-03-04 10:15:00")).toBe("2024-03-04T10:15:00.000Z");
  });

  it("falls back to the current time for unrecognized input instead of throwing", () => {
    const result = normalizeTimestamp("not a date");
    expect(() => new Date(result).toISOString()).not.toThrow();
  });
});

describe("parseCsv", () => {
  it("parses a simple comma-separated row", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    expect(parseCsv('name,note\n"Doe, Jane","hello"')).toEqual([
      ["name", "note"],
      ["Doe, Jane", "hello"],
    ]);
  });

  it("handles an escaped quote inside a quoted field", () => {
    expect(parseCsv('field\n"she said ""hi"""')).toEqual([["field"], ['she said "hi"']]);
  });

  it("normalizes CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("createDuplicateChecker", () => {
  it("flags a (personId, timestamp, text) tuple already in the conversation as a duplicate", async () => {
    queryMock.mockResolvedValueOnce([{ person_id: "p1", timestamp: "t1", text: "hola" }]);
    const isDuplicate = await createDuplicateChecker("conv-1");
    expect(isDuplicate("p1", "t1", "hola")).toBe(true);
    expect(isDuplicate("p1", "t1", "chau")).toBe(false);
  });

  it("catches duplicates within the same import batch, not just pre-existing rows", async () => {
    queryMock.mockResolvedValueOnce([]);
    const isDuplicate = await createDuplicateChecker("conv-2");
    expect(isDuplicate("p1", "t1", "hola")).toBe(false);
    // Same key seen a second time in this batch should now be flagged.
    expect(isDuplicate("p1", "t1", "hola")).toBe(true);
  });

  it("treats a null person_id distinctly from a real one", async () => {
    queryMock.mockResolvedValueOnce([{ person_id: null, timestamp: "t1", text: "hola" }]);
    const isDuplicate = await createDuplicateChecker("conv-3");
    expect(isDuplicate(null, "t1", "hola")).toBe(true);
    expect(isDuplicate("p1", "t1", "hola")).toBe(false);
  });
});
