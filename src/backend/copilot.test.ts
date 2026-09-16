import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const runMock = vi.fn();
vi.mock("./db", () => ({
  dbQuery: (...args: unknown[]) => queryMock(...args),
  dbRun: (...args: unknown[]) => runMock(...args),
}));

const buildRagMessagesMock = vi.fn();
vi.mock("./chat", () => ({
  buildRagMessages: (...args: unknown[]) => buildRagMessagesMock(...args),
}));

const chatCompletionMessagesMock = vi.fn();
vi.mock("./llm", () => ({
  chatCompletionMessages: (...args: unknown[]) => chatCompletionMessagesMock(...args),
}));

import { generateDraft, listDrafts, updateDraftStatus } from "./copilot";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("generateDraft", () => {
  it("refuses to generate a draft for an excluded contact, without calling the model", async () => {
    queryMock.mockResolvedValueOnce([{ excluded: 1 }]);

    await expect(generateDraft("person-1", "escribile algo")).rejects.toThrow(/excluido/);
    expect(buildRagMessagesMock).not.toHaveBeenCalled();
    expect(chatCompletionMessagesMock).not.toHaveBeenCalled();
  });

  it("generates and stores a draft for a non-excluded contact", async () => {
    queryMock
      .mockResolvedValueOnce([{ excluded: 0 }]) // isExcluded check
      .mockResolvedValueOnce([{ name: "Ana" }]); // contact name lookup
    buildRagMessagesMock.mockResolvedValueOnce([[{ role: "user", content: "escribile algo" }], {}]);
    chatCompletionMessagesMock.mockResolvedValueOnce("Hola Ana, ¿cómo estás?");
    runMock.mockResolvedValueOnce(1);

    const draft = await generateDraft("person-1", "escribile algo");

    expect(draft.content).toBe("Hola Ana, ¿cómo estás?");
    expect(draft.contact_name).toBe("Ana");
    expect(draft.status).toBe("pending");
    expect(runMock).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO drafts"), expect.any(Array));
  });

  it("generates a draft with no contact (general instruction, no recipient)", async () => {
    buildRagMessagesMock.mockResolvedValueOnce([[{ role: "user", content: "escribí algo" }], {}]);
    chatCompletionMessagesMock.mockResolvedValueOnce("Contenido genérico");
    runMock.mockResolvedValueOnce(1);

    const draft = await generateDraft(null, "escribí algo");

    expect(draft.contact_name).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("listDrafts", () => {
  it("maps rows to the Draft shape", async () => {
    queryMock.mockResolvedValueOnce([
      { id: "d1", contact_name: "Ana", content: "hola", status: "pending", created_at: "2026-01-01T00:00:00.000Z" },
    ]);

    const drafts = await listDrafts();

    expect(drafts).toEqual([
      { id: "d1", contact_name: "Ana", content: "hola", status: "pending", created_at: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("updateDraftStatus", () => {
  it("updates status and content together when content is provided", async () => {
    runMock.mockResolvedValueOnce(1);
    await updateDraftStatus("d1", "edited", "texto nuevo");
    expect(runMock).toHaveBeenCalledWith(expect.stringContaining("content = ?"), ["edited", "texto nuevo", expect.any(String), "d1"]);
  });

  it("updates only status when content is null", async () => {
    runMock.mockResolvedValueOnce(1);
    await updateDraftStatus("d1", "approved", null);
    expect(runMock).toHaveBeenCalledWith(expect.not.stringContaining("content = ?"), ["approved", expect.any(String), "d1"]);
  });
});
