/// Keyword heuristic (no LLM) to flag potentially sensitive messages on
/// import. This isn't semantic analysis: it's a cheap safety net
/// that runs over each message at ingestion time
/// (`import_common::insert_message_if_new`), not as a separate step.
const SENSITIVE_KEYWORDS: &[&str] = &[
    // health / mental health
    "diagnóstico",
    "diagnostico",
    "enfermedad",
    "medicamento",
    "psiquiatra",
    "psicólogo",
    "psicologo",
    "terapia",
    "depresión",
    "depresion",
    "ansiedad",
    "suicidio",
    "suicida",
    "embarazo",
    "aborto",
    "cáncer",
    "cancer",
    // financial / credentials
    "contraseña",
    "contrasena",
    "cvv",
    "tarjeta de crédito",
    "tarjeta de credito",
    "cuenta bancaria",
    "cbu",
    "número de tarjeta",
    "numero de tarjeta",
    "sueldo",
    "deuda",
    // identity
    "dni",
    "pasaporte",
    "número de documento",
    "numero de documento",
    // intimate / legal
    "abuso",
    "violencia doméstica",
    "violencia domestica",
    "denuncia",
    "divorcio",
    "custodia",
    "íntimo",
    "intimo",
];

/// Returns `Some("sensible")` if the text contains any keyword, or
/// `None` otherwise (message not flagged).
pub fn classify(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if SENSITIVE_KEYWORDS.iter().any(|kw| lower.contains(kw)) {
        Some("sensible".to_string())
    } else {
        None
    }
}
