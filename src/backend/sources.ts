import { dbQuery, dbRun } from "./db";

export interface SourceSummary {
  id: string;
  kind: string;
  file_name: string | null;
  imported_at: string;
  message_count: number;
}

export async function listSources(): Promise<SourceSummary[]> {
  const rows = await dbQuery(
    `SELECT s.id, s.kind, s.file_name, s.imported_at, COUNT(m.id) AS message_count
     FROM sources s LEFT JOIN messages m ON m.source_id = s.id
     GROUP BY s.id ORDER BY s.imported_at DESC`,
  );
  return rows as unknown as SourceSummary[];
}

export interface PersonSummary {
  id: string;
  name: string;
  is_user: boolean;
  relationship: string | null;
  excluded: boolean;
  message_count: number;
}

interface PersonRow {
  id: string;
  name: string;
  is_user: number;
  relationship: string | null;
  excluded: number;
  message_count: number;
}

export async function listPeople(): Promise<PersonSummary[]> {
  const rows = await dbQuery(
    `SELECT p.id, p.name, p.is_user, p.relationship, p.excluded, COUNT(m.id) AS message_count
     FROM people p LEFT JOIN messages m ON m.person_id = p.id
     GROUP BY p.id ORDER BY p.name`,
  );
  return (rows as unknown as PersonRow[]).map((r) => ({
    ...r,
    is_user: Boolean(r.is_user),
    excluded: Boolean(r.excluded),
  }));
}

export async function setPersonExcluded(personId: string, excluded: boolean): Promise<void> {
  await dbRun("UPDATE people SET excluded = ? WHERE id = ?", [excluded ? 1 : 0, personId]);
}

export async function setPersonRelationship(personId: string, relationship: string | null): Promise<void> {
  await dbRun("UPDATE people SET relationship = ? WHERE id = ?", [relationship, personId]);
}

export async function setUserPerson(personId: string): Promise<number> {
  await dbRun("UPDATE people SET is_user = 1 WHERE id = ?", [personId]);
  return dbRun("UPDATE messages SET is_user = 1 WHERE person_id = ?", [personId]);
}
