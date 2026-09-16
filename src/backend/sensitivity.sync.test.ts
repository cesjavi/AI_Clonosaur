import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SENSITIVE_KEYWORDS } from "./sensitivity";

/** sensitivity.ts is a hand-maintained port of sensitivity.rs (see that
 * file's own comment: "keep both lists in sync"). Nothing enforced that
 * before this test — a keyword added to one list and forgotten in the
 * other would silently let sensitive content leak into contexts the other
 * build correctly excludes it from (e.g. hybrid mode sending RAG context to
 * an external LLM provider). This test fails the build instead of letting
 * that drift happen unnoticed. */
function extractRustKeywords(): string[] {
  const rustPath = fileURLToPath(new URL("../../src-tauri/src/sensitivity.rs", import.meta.url));
  const source = readFileSync(rustPath, "utf-8");

  const arrayStart = source.indexOf("SENSITIVE_KEYWORDS: &[&str] = &[");
  if (arrayStart === -1) {
    throw new Error("no se encontró el array SENSITIVE_KEYWORDS en sensitivity.rs — ¿cambió el nombre/formato?");
  }
  const arrayEnd = source.indexOf("];", arrayStart);
  if (arrayEnd === -1) {
    throw new Error("no se encontró el cierre del array SENSITIVE_KEYWORDS en sensitivity.rs");
  }

  const arrayBody = source.slice(arrayStart, arrayEnd);
  const matches = [...arrayBody.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  return matches.map((m) => m[1]);
}

describe("sensitivity keyword lists stay in sync across languages", () => {
  it("sensitivity.ts and sensitivity.rs contain exactly the same keywords", () => {
    const rustKeywords = extractRustKeywords();
    const tsSet = new Set(SENSITIVE_KEYWORDS);
    const rustSet = new Set(rustKeywords);

    const onlyInTs = [...tsSet].filter((kw) => !rustSet.has(kw));
    const onlyInRust = [...rustSet].filter((kw) => !tsSet.has(kw));

    expect(
      onlyInTs,
      `keywords in sensitivity.ts but missing from sensitivity.rs: ${JSON.stringify(onlyInTs)}`,
    ).toEqual([]);
    expect(
      onlyInRust,
      `keywords in sensitivity.rs but missing from sensitivity.ts: ${JSON.stringify(onlyInRust)}`,
    ).toEqual([]);
  });
});
