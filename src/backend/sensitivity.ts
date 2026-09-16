/** Keyword heuristic (no LLM) to flag potentially sensitive messages on
 * import. Port of sensitivity.rs — keep both lists in sync. */
export const SENSITIVE_KEYWORDS = [
  // health / mental health
  "diagnóstico", "diagnostico", "enfermedad", "medicamento", "psiquiatra",
  "psicólogo", "psicologo", "terapia", "depresión", "depresion", "ansiedad",
  "suicidio", "suicida", "embarazo", "aborto", "cáncer", "cancer",
  // financial / credentials
  "contraseña", "contrasena", "cvv", "tarjeta de crédito", "tarjeta de credito",
  "cuenta bancaria", "cbu", "número de tarjeta", "numero de tarjeta", "sueldo", "deuda",
  // identity
  "dni", "pasaporte", "número de documento", "numero de documento",
  // intimate / legal
  "abuso", "violencia doméstica", "violencia domestica", "denuncia", "divorcio",
  "custodia", "íntimo", "intimo",
];

export function classify(text: string): string | null {
  const lower = text.toLowerCase();
  return SENSITIVE_KEYWORDS.some((kw) => lower.includes(kw)) ? "sensible" : null;
}
