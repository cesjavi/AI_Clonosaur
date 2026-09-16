import { dbQuery, dbRun } from "./db";

export interface ProfileTrait {
  id: string;
  category: string;
  trait_name: string;
  value: string;
  source: string;
  evidence: string | null;
  created_at: string;
  updated_at: string;
}

export async function listProfileTraits(): Promise<ProfileTrait[]> {
  const rows = await dbQuery(
    `SELECT id, category, trait AS trait_name, value, source, evidence, created_at, updated_at
     FROM profile_traits ORDER BY category, created_at`,
  );
  return rows as unknown as ProfileTrait[];
}

export async function createProfileTrait(category: string, traitName: string, value: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO profile_traits (id, category, trait, value, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?)`,
    [id, category, traitName, value, now, now],
  );
  return id;
}

export async function updateProfileTrait(
  id: string,
  category: string,
  traitName: string,
  value: string,
): Promise<void> {
  const now = new Date().toISOString();
  const changed = await dbRun(
    "UPDATE profile_traits SET category = ?, trait = ?, value = ?, updated_at = ? WHERE id = ?",
    [category, traitName, value, now, id],
  );
  if (changed === 0) {
    throw new Error(`no existe un rasgo de perfil con id ${id}`);
  }
}

export async function deleteProfileTrait(id: string): Promise<void> {
  await dbRun("DELETE FROM profile_traits WHERE id = ?", [id]);
}
