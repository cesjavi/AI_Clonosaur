import * as llm from "./llm";
import { gatherModuleEvidence, insertTraitIfNew } from "./traitModel";

interface DecisionFinding {
  trait: string;
  value: string;
  evidence?: unknown;
}

export async function generateDecisions(): Promise<number> {
  const evidence = await gatherModuleEvidence(
    ["estilo_mental", "memoria_autobiografica"],
    "Estilo mental / Memoria autobiográfica",
  );

  if (!evidence.trim()) {
    throw new Error(
      "no hay suficiente entrevista, memorias o mensajes propios todavía para generar patrones de decisión",
    );
  }

  const prompt = `A partir del siguiente contexto sobre una persona, identificá hasta 8 patrones de toma de decisiones (cómo decide, qué la hace cambiar de opinión, cómo reacciona bajo presión). Para cada uno indicá: trait (nombre corto del patrón, ej. 'decide rápido bajo presión'), value (una frase explicando cómo se manifiesta), evidence (cita textual exacta del contexto que lo respalda). NO inventes patrones sin respaldo textual claro. Respondé ÚNICAMENTE un array JSON de objetos con esas 3 claves.

Contexto:
${evidence}`;

  const response = await llm.chatCompletion(prompt);
  const findings = llm.parseJsonArray<DecisionFinding>(response);

  const now = new Date().toISOString();
  let created = 0;

  for (const finding of findings) {
    if (!finding.trait?.trim() || !finding.value?.trim()) continue;
    const evidenceText = llm.valueToText(finding.evidence);
    if (await insertTraitIfNew("toma_decisiones", finding.trait, finding.value, evidenceText, now)) {
      created += 1;
    }
  }

  return created;
}
