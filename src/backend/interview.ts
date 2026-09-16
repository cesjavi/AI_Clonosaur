import { dbQuery, dbRun } from "./db";

export interface InterviewAnswer {
  module: string;
  question_id: string;
  question_text: string;
  answer: string;
  updated_at: string;
}

export async function getInterviewAnswers(): Promise<InterviewAnswer[]> {
  const rows = await dbQuery(
    "SELECT module, question_id, question_text, answer, updated_at FROM interview_answers",
  );
  return rows as unknown as InterviewAnswer[];
}

export async function saveInterviewAnswer(
  moduleName: string,
  questionId: string,
  questionText: string,
  answer: string,
): Promise<void> {
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO interview_answers (id, module, question_id, question_text, answer, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(module, question_id) DO UPDATE SET
        question_text = excluded.question_text,
        answer = excluded.answer,
        updated_at = excluded.updated_at`,
    [crypto.randomUUID(), moduleName, questionId, questionText, answer, now],
  );
}
