import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function openState(path, key) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS grants (reviewer INTEGER PRIMARY KEY, grant TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS routes (
      number INTEGER NOT NULL, reviewer INTEGER NOT NULL, generation TEXT NOT NULL,
      due INTEGER, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (number, reviewer)
    );
  `)
  function seal(reviewer, grant) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(String(reviewer)))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(grant)), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
  }
  function unseal(reviewer, value) {
    const bytes = Buffer.from(value, 'base64url')
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
    cipher.setAAD(Buffer.from(String(reviewer)))
    cipher.setAuthTag(bytes.subarray(12, 28))
    return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString())
  }
  function atomic(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  const grant = db.prepare('SELECT grant FROM grants WHERE reviewer = ?')
  const removeGrant = db.prepare('DELETE FROM grants WHERE reviewer = ?')
  const removeRoutes = db.prepare('DELETE FROM routes WHERE reviewer = ?')
  return {
    close: () => db.close(),
    getGrant(reviewer) {
      const version = grant.get(reviewer)?.grant
      return version ? { ...unseal(reviewer, version), version } : null
    },
    enroll(reviewer, data) {
      db.prepare('INSERT OR REPLACE INTO grants VALUES (?, ?)').run(reviewer, seal(reviewer, data))
    },
    rotate(reviewer, old, data) {
      const result = data
        ? db.prepare('UPDATE grants SET grant = ? WHERE reviewer = ? AND grant = ?').run(seal(reviewer, data), reviewer, old)
        : db.prepare('DELETE FROM grants WHERE reviewer = ? AND grant = ?').run(reviewer, old)
      return result.changes === 1
    },
    revoke(reviewer) {
      atomic(() => { removeGrant.run(reviewer); removeRoutes.run(reviewer) })
    },
    receive(id, event, now = Date.now()) {
      return atomic(() => {
        if (!db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?)').run(id).changes) return false
        if (event.kind === 'revoke') {
          removeGrant.run(event.reviewer)
          removeRoutes.run(event.reviewer)
        } else if (event.kind === 'assign') {
          // Assignments before opt-in do not silently start reviewing after enrollment.
          if (!grant.get(event.reviewer)) return true
          db.prepare(`
            INSERT INTO routes VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (number, reviewer) DO UPDATE
            SET generation = excluded.generation, due = excluded.due, attempts = 0
          `).run(event.number, event.reviewer, randomUUID(), now)
        } else if (event.kind === 'remove') {
          db.prepare('DELETE FROM routes WHERE number = ? AND reviewer = ?').run(event.number, event.reviewer)
        } else if (event.kind === 'close') {
          db.prepare('DELETE FROM routes WHERE number = ?').run(event.number)
        } else if (event.kind === 'update') {
          db.prepare('UPDATE routes SET generation = ?, due = ?, attempts = 0 WHERE number = ?')
            .run(randomUUID(), now, event.number)
        }
        return true
      })
    },
    next(now = Date.now()) {
      return db.prepare('SELECT * FROM routes WHERE due <= ? ORDER BY due, number, reviewer LIMIT 1').get(now)
    },
    active(route) {
      return !!db.prepare('SELECT 1 FROM routes WHERE number = ? AND reviewer = ? AND generation = ?')
        .get(route.number, route.reviewer, route.generation)
    },
    finish(route, retryAt = null) {
      db.prepare('UPDATE routes SET due = ?, attempts = attempts + 1 WHERE number = ? AND reviewer = ? AND generation = ?')
        .run(retryAt, route.number, route.reviewer, route.generation)
    },
  }
}
