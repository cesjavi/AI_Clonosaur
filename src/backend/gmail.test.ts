import { describe, expect, it } from "vitest";
import { parseFromHeader, parseGmailDate, splitMboxMessages } from "./gmail";

describe("parseFromHeader", () => {
  it("extracts the display name from 'Name <email>' form", () => {
    expect(parseFromHeader("Jane Doe <jane@example.com>")).toBe("Jane Doe");
  });

  it("strips surrounding quotes from the display name", () => {
    expect(parseFromHeader('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
  });

  it("falls back to the email when there's no display name", () => {
    expect(parseFromHeader("<jane@example.com>")).toBe("jane@example.com");
  });

  it("returns the raw value when there's no angle-bracket address", () => {
    expect(parseFromHeader("jane@example.com")).toBe("jane@example.com");
  });
});

describe("parseGmailDate", () => {
  it("parses an RFC822-style date header", () => {
    const result = parseGmailDate("Wed, 10 Oct 2018 20:19:24 +0000");
    expect(result).toBe("2018-10-10T20:19:24.000Z");
  });

  it("strips a trailing timezone-name comment before parsing", () => {
    const result = parseGmailDate("Wed, 10 Oct 2018 20:19:24 +0000 (UTC)");
    expect(result).toBe("2018-10-10T20:19:24.000Z");
  });

  it("returns undefined for an unparseable date", () => {
    expect(parseGmailDate("not a date")).toBeUndefined();
  });
});

describe("splitMboxMessages", () => {
  it("splits on lines starting with 'From ' at the start of a message", () => {
    const content = "From a@b Mon Jan 1\nHeader: x\n\nbody one\nFrom c@d Tue Jan 2\nHeader: y\n\nbody two\n";
    const blocks = splitMboxMessages(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("body one");
    expect(blocks[1]).toContain("body two");
  });

  it("does not split on an escaped '>From ' inside a message body", () => {
    const content = "From a@b Mon Jan 1\nHeader: x\n\n>From this is quoted, not a boundary\nmore body\n";
    const blocks = splitMboxMessages(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(">From this is quoted");
  });

  it("returns an empty array for empty content", () => {
    expect(splitMboxMessages("")).toEqual([]);
  });
});
