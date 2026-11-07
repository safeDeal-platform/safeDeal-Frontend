import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { FRONTEND } from './scope.mjs'

export function openState(path, key, frontendRepoId) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS grants (reviewer INTEGER PRIMARY KEY, grant TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS repository_routes (
      repoId INTEGER NOT NULL, repository TEXT NOT NULL,
      number INTEGER NOT NULL, reviewer INTEGER NOT NULL, generation TEXT NOT NULL,
      due INTEGER, attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (repoId, number, reviewer)
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
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routes'").get()) {
    try {
      if (!Number.isSafeInteger(frontendRepoId) || frontendRepoId < 1) throw new Error('Frontend repository ID is required to migrate review state')
      atomic(() => {
        db.prepare('INSERT INTO repository_routes SELECT ?, ?, number, reviewer, generation, due, attempts FROM routes')
          .run(frontendRepoId, FRONTEND)
        db.exec('DROP TABLE routes')
      })
    } catch (err) {
      db.close()
      throw err
    }
  }
  const grant = db.prepare('SELECT grant FROM grants WHERE reviewer = ?')
  const removeGrant = db.prepare('DELETE FROM grants WHERE reviewer = ?')
  const removeRoutes = db.prepare('DELETE FROM repository_routes WHERE reviewer = ?')
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
            INSERT INTO repository_routes VALUES (?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT (repoId, number, reviewer) DO UPDATE
            SET repository = excluded.repository, generation = excluded.generation, due = excluded.due, attempts = 0
          `).run(event.repoId, event.repository, event.number, event.reviewer, randomUUID(), now)
        } else if (event.kind === 'remove') {
          db.prepare('DELETE FROM repository_routes WHERE repoId = ? AND number = ? AND reviewer = ?')
            .run(event.repoId, event.number, event.reviewer)
        } else if (event.kind === 'close') {
          db.prepare('DELETE FROM repository_routes WHERE repoId = ? AND number = ?').run(event.repoId, event.number)
        } else if (event.kind === 'update') {
          db.prepare('UPDATE repository_routes SET repository = ?, generation = ?, due = ?, attempts = 0 WHERE repoId = ? AND number = ?')
            .run(event.repository, randomUUID(), now, event.repoId, event.number)
        }
        return true
      })
    },
    next(now = Date.now()) {
      return db.prepare('SELECT * FROM repository_routes WHERE due <= ? ORDER BY due, repoId, number, reviewer LIMIT 1').get(now)
    },
    active(route) {
      return !!db.prepare('SELECT 1 FROM repository_routes WHERE repoId = ? AND number = ? AND reviewer = ? AND generation = ?')
        .get(route.repoId, route.number, route.reviewer, route.generation)
    },
    finish(route, retryAt = null) {
      db.prepare('UPDATE repository_routes SET due = ?, attempts = attempts + 1 WHERE repoId = ? AND number = ? AND reviewer = ? AND generation = ?')
        .run(retryAt, route.repoId, route.number, route.reviewer, route.generation)
    },
  }
}
