import { describe, expect, it } from "vitest";
import { anonymizeText } from "./hybrid";
import { parseJsonArray, stripThinkBlocks } from "./llm";

describe("anonymizeText", () => {
  it("replaces longest contact names first, case-insensitively, without corrupting substrings", () => {
    const out = anonymizeText("Mañana veo a ana maría y a Ana.", ["Ana", "Ana María"]);
    expect(out).toBe("Mañana veo a [contacto] y a [contacto].");
  });
});

describe("stripThinkBlocks & parseJsonArray", () => {
  it("removes closed and unclosed <think> blocks", () => {
    expect(stripThinkBlocks("<think>razonamiento</think>Respuesta")).toBe("Respuesta");
    expect(stripThinkBlocks("Hola<think>truncado")).toBe("Hola");
  });

  it("parses JSON arrays preceded by <think> blocks or [n] citations", () => {
    const raw = `<think>Analizando [0] y [1]</think>Según [0]: [{"layer":"preferencias","content":"Mate"}]`;
    expect(parseJsonArray<{ layer: string; content: string }>(raw)).toEqual([
      { layer: "preferencias", content: "Mate" },
    ]);
  });
});
