// sql.mjs — read-only access to the isolated instance's lamprey.db (the event spine) through
// node:sqlite (Node ≥ 22.13, no native build). Never opens the owner's database: the caller passes
// the path under the instance's own userData. Degrades to { ok:false } when the module or the file
// is unavailable so a probe reports "no spine evidence" instead of crashing.

export async function openReadOnly(path) {
  let mod
  try {
    mod = await import('node:sqlite')
  } catch (err) {
    return { ok: false, error: `node:sqlite unavailable: ${err.message}` }
  }
  try {
    const db = new mod.DatabaseSync(path, { readOnly: true })
    return {
      ok: true,
      query: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => {
        try {
          db.close()
        } catch {
          /* already closed */
        }
      }
    }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
