import { dbQuery, dbRun } from "./db";

/**
 * Manual verification harness for Phase W1's "done when": insert test data,
 * reload the page, confirm it's still there. Only runs when the page is
 * loaded with `?dbtest` in the URL — never touched by normal app usage.
 * Uses `INSERT OR IGNORE` so a second load proves persistence by NOT
 * generating a new timestamp, rather than just not erroring.
 */
export async function runDbTest() {
  const root = document.getElementById("root");
  if (!root) return;
  const log = (msg: string) => {
    root.textContent += `\n${msg}`;
  };
  root.textContent = "starting…";
  try {
    log("calling dbRun...");
    const runPromise = dbRun(
      "INSERT OR IGNORE INTO app_settings (key, value) VALUES ('dbtest_marker', ?)",
      [new Date().toISOString()],
    );
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("dbRun timed out after 8s")), 8000));
    await Promise.race([runPromise, timeout]);
    log("dbRun completed, calling dbQuery...");
    const rows = await dbQuery("SELECT value FROM app_settings WHERE key = 'dbtest_marker'");
    log(`dbtest ok: ${JSON.stringify(rows)}`);
  } catch (e) {
    log(`dbtest error: ${String(e)}`);
    if (e instanceof Error && e.stack) log(e.stack);
  }
}
