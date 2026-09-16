import { describe, expect, it } from "vitest";
import { parseWhatsappText, parseWhatsappTimestamp } from "./whatsapp";

describe("parseWhatsappTimestamp", () => {
  it("parses dd/mm/yyyy (the assumed default format)", () => {
    // March 4th 2024, day <= 12 so unambiguous either way.
    expect(parseWhatsappTimestamp("4/3/2024", "10:15")).toBe("2024-03-04T10:15:00.000Z");
  });

  it("stays with the dd/mm assumption when both fields could be either (silently ambiguous)", () => {
    // "13/05/2024" is valid as dd/mm (day 13, month 5) so no correction
    // kicks in — this is the inherently unrecoverable ambiguous case the
    // code's comment calls out, documented here rather than asserted as a bug.
    expect(parseWhatsappTimestamp("13/05/2024", "10:15")).toBe("2024-05-13T10:15:00.000Z");
  });

  it("swaps day/month when the second field can only be a month (> 12 as a day)", () => {
    // "03/25/2024" is invalid as dd/mm (no month 25) but unambiguous as
    // mm/dd (day 25, month 3) — the unambiguous case the fix recovers.
    expect(parseWhatsappTimestamp("03/25/2024", "10:15")).toBe("2024-03-25T10:15:00.000Z");
  });

  it("rejects a date where neither field can be a valid day or month", () => {
    expect(parseWhatsappTimestamp("32/13/2024", "10:15")).toBeNull();
  });

  it("handles a 2-digit year", () => {
    expect(parseWhatsappTimestamp("4/3/24", "10:15")).toBe("2024-03-04T10:15:00.000Z");
  });

  it("parses 12-hour time with AM/PM", () => {
    expect(parseWhatsappTimestamp("4/3/2024", "2:15 PM")).toBe("2024-03-04T14:15:00.000Z");
    expect(parseWhatsappTimestamp("4/3/2024", "12:00 AM")).toBe("2024-03-04T00:00:00.000Z");
  });

  it("returns null for malformed input", () => {
    expect(parseWhatsappTimestamp("not-a-date", "10:15")).toBeNull();
    expect(parseWhatsappTimestamp("4/3/2024", "not-a-time")).toBeNull();
  });
});

describe("parseWhatsappText", () => {
  it("parses an Android-style export", () => {
    const content = "4/3/24, 10:15 - Ana: Hola!\n4/3/24, 10:16 - Beto: Qué tal";
    const messages = parseWhatsappText(content);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ author: "Ana", text: "Hola!" });
    expect(messages[1]).toMatchObject({ author: "Beto", text: "Qué tal" });
  });

  it("parses an iOS-style export", () => {
    const content = "[4/3/24, 10:15:00 AM] Ana: Hola!";
    const messages = parseWhatsappText(content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ author: "Ana", text: "Hola!" });
  });

  it("appends multi-line message continuations to the last real message", () => {
    const content = "4/3/24, 10:15 - Ana: primera linea\nsegunda linea";
    const messages = parseWhatsappText(content);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("primera linea\nsegunda linea");
  });

  it("discards system messages with no author/text separator", () => {
    const content = "4/3/24, 10:15 - Ana creó el grupo\n4/3/24, 10:16 - Ana: Hola!";
    const messages = parseWhatsappText(content);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ author: "Ana", text: "Hola!" });
  });
});
