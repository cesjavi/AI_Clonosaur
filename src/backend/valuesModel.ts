import * as llm from "./llm";
import { gatherModuleEvidence, insertTraitIfNew } from "./traitModel";

interface ValueFinding {
  trait: string;
  value: string;
  evidence?: unknown;
}

export async function generateValues(): Promise<number> {
  const evidence = await gatherModuleEvidence(["identidad"], "módulo Identidad");

  if (!evidence.trim()) {
    throw new Error("no hay suficiente entrevista, memorias o mensajes propios todavía para generar valores");
  }

  const prompt = `A partir del siguiente contexto sobre una persona, identificá hasta 8 valores que no negocia o que la definen. Para cada uno indicá: trait (nombre corto del valor, ej. 'honestidad'), value (una frase explicando cómo se manifiesta en ella), evidence (cita textual exacta del contexto que lo respalda). NO inventes valores sin respaldo textual claro. Respondé ÚNICAMENTE un array JSON de objetos con esas 3 claves.

Contexto:
${evidence}`;

  const response = await llm.chatCompletion(prompt);
  const findings = llm.parseJsonArray<ValueFinding>(response);

  const now = new Date().toISOString();
  let created = 0;

  for (const finding of findings) {
    if (!finding.trait?.trim() || !finding.value?.trim()) continue;
    const evidenceText = llm.valueToText(finding.evidence);
    if (await insertTraitIfNew("valores", finding.trait, finding.value, evidenceText, now)) {
      created += 1;
    }
  }

  return created;
}
