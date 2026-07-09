import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import questionsData from "./interview/questions.json";
import "./Interview.css";

interface Question {
  id: string;
  text: string;
}

interface Module {
  module: string;
  label: string;
  questions: Question[];
}

interface InterviewAnswer {
  module: string;
  question_id: string;
  question_text: string;
  answer: string;
  updated_at: string;
}

const MODULES = questionsData as Module[];

function answerKey(module: string, questionId: string) {
  return `${module}::${questionId}`;
}

export default function Interview() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [activeModule, setActiveModule] = useState(MODULES[0].module);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<InterviewAnswer[]>("get_interview_answers")
      .then((saved) => {
        const map: Record<string, string> = {};
        for (const a of saved) {
          map[answerKey(a.module, a.question_id)] = a.answer;
        }
        setAnswers(map);
      })
      .finally(() => setLoading(false));
  }, []);

  const progress = useMemo(() => {
    const total = MODULES.reduce((n, m) => n + m.questions.length, 0);
    const done = MODULES.reduce(
      (n, m) =>
        n +
        m.questions.filter((q) => (answers[answerKey(m.module, q.id)] ?? "").trim() !== "").length,
      0,
    );
    return { done, total };
  }, [answers]);

  async function saveAnswer(module: string, question: Question, value: string) {
    const key = answerKey(module, question.id);
    setSavingKey(key);
    try {
      await invoke("save_interview_answer", {
        module,
        questionId: question.id,
        questionText: question.text,
        answer: value,
      });
    } finally {
      setSavingKey((current) => (current === key ? null : current));
    }
  }

  const current = MODULES.find((m) => m.module === activeModule)!;

  if (loading) {
    return <p className="interview-loading">Cargando entrevista…</p>;
  }

  return (
    <div className="interview">
      <aside className="interview-nav">
        <p className="interview-progress">
          {progress.done} / {progress.total} respondidas
        </p>
        {MODULES.map((m) => {
          const answeredInModule = m.questions.filter(
            (q) => (answers[answerKey(m.module, q.id)] ?? "").trim() !== "",
          ).length;
          return (
            <button
              key={m.module}
              className={m.module === activeModule ? "interview-tab active" : "interview-tab"}
              onClick={() => setActiveModule(m.module)}
            >
              {m.label}
              <span className="interview-tab-count">
                {answeredInModule}/{m.questions.length}
              </span>
            </button>
          );
        })}
      </aside>

      <section className="interview-content">
        <h2>{current.label}</h2>
        {current.questions.map((q) => {
          const key = answerKey(current.module, q.id);
          return (
            <div key={q.id} className="interview-question">
              <label htmlFor={key}>{q.text}</label>
              <textarea
                id={key}
                rows={3}
                value={answers[key] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => ({ ...prev, [key]: e.currentTarget.value }))
                }
                onBlur={(e) => saveAnswer(current.module, q, e.currentTarget.value)}
              />
              {savingKey === key && <span className="interview-saving">Guardando…</span>}
            </div>
          );
        })}
      </section>
    </div>
  );
}
