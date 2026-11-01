/**
 * Modul: Modulspeicher (module_records)
 * Zweck: Kleine, haushaltsweit geteilte JSON-Datensaetze fuer Drittanbieter-Module.
 *        Der Kern besitzt die Tabelle (Migration 274); Module erreichen sie nur
 *        ueber /api/v1/modules/:moduleId/records (routes/module-records.js).
 *
 * KEIN SPEICHER FUER GEHEIMNISSE, DATEIEN ODER MODELLE. Ein Datensatz ist ein
 * JSON-Objekt von hoechstens 16 KiB, ein Modul hat hoechstens 1.000 davon und
 * 4 MiB zusammen. Was darueber hinausgeht, gehoert in einen eigenen Dienst
 * (MODULES.md, "Modules With A Backend Service").
 *
 * DER INHALT IST FUER DEN KERN UNDURCHSICHTIG. Felder prueft das Modul selbst;
 * der Kern prueft nur Form (Objekt), Groesse und Revision.
 *
 * REVISIONEN STATT LETZTER GEWINNT. Ersetzen und Loeschen nennen die Revision,
 * die der Aufrufer zuletzt gesehen hat; passt sie nicht, antwortet der Dienst
 * 409 und aendert nichts. Pruefung und Schreiben laufen in EINER Transaktion,
 * und better-sqlite3 arbeitet synchron in einem Prozess - zwischen beiden kann
 * keine andere Anfrage schreiben. Dasselbe gilt fuer die Kontingente: zwei
 * gleichzeitige Anlagen koennen das Limit nicht gemeinsam ueberschreiten.
 *
 * ABSCHALTEN UND ENTFERNEN LOESCHEN NICHTS. Die Datensaetze bleiben, bis ein
 * Administrator sie ausdruecklich loescht (`purge`, nur aus einer
 * Browser-Sitzung) - ein Update, das ein Modul kurz entfernt, darf den
 * Haushalt nicht seine Daten kosten.
 */
import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({
  recordBytes: 16 * 1024,
  records: 1000,
  totalBytes: 4 * 1024 * 1024,
});

export const PAGE_DEFAULT = 100;
export const PAGE_MAX = 200;

/** Datensatz-Ids sind die UUIDs, die `create` vergibt. Alles andere ist kein Datensatz. */
export const RECORD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function storageError(status, reason, message = reason) {
  return Object.assign(new Error(message), { status, reason });
}

function decode(row) {
  if (!row) return null;
  return {
    id: row.id,
    subject_id: row.subject_id ?? null,
    revision: row.revision,
    data: JSON.parse(row.data),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Eine Revision aus Koerper oder Query: positive ganze Zahl, als Zahl oder Ziffernfolge. */
export function parseRevision(raw) {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function createRecordStore(database, limits = LIMITS) {
  const selectOne = database.prepare('SELECT * FROM module_records WHERE module_id = ? AND id = ?');
  const selectUsage = database.prepare(`
    SELECT COUNT(*) AS records, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes
    FROM module_records WHERE module_id = ?
  `);

  function encode(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw storageError(400, 'record_object_required', 'data must be a JSON object.');
    }
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > limits.recordBytes) {
      throw storageError(413, 'record_too_large', `A record may hold at most ${limits.recordBytes} bytes of JSON.`);
    }
    return json;
  }

  /** Kontingent pruefen, INNERHALB der schreibenden Transaktion. */
  function assertQuota(moduleId, json, previous = null) {
    const usage = selectUsage.get(moduleId);
    const freed = previous ? Buffer.byteLength(previous.data, 'utf8') : 0;
    if (!previous && usage.records >= limits.records) {
      throw storageError(413, 'module_storage_full', `A module may keep at most ${limits.records} records.`);
    }
    if (usage.bytes - freed + Buffer.byteLength(json, 'utf8') > limits.totalBytes) {
      throw storageError(413, 'module_storage_full', `A module may keep at most ${limits.totalBytes} bytes of records.`);
    }
  }

  function requireRow(moduleId, id) {
    const row = RECORD_ID_RE.test(String(id)) ? selectOne.get(moduleId, id) : null;
    if (!row) throw storageError(404, 'record_not_found', 'Record not found.');
    return row;
  }

  function requireRevision(row, revision) {
    if (revision === null) throw storageError(400, 'record_revision_required', 'revision must be the revision you last read.');
    if (row.revision !== revision) throw storageError(409, 'record_conflict', 'The record was changed since you read it.');
  }

  // `subjectId` (Migration 275): die Person, der der Datensatz gehoert, oder
  // null fuer haushaltsweit. Wer das darf, hat der Router vorher gefragt
  // (services/module-people.js); hier steht nur, dass es danach fest bleibt.
  const create = database.transaction((moduleId, data, subjectId) => {
    const json = encode(data);
    assertQuota(moduleId, json);
    const id = randomUUID();
    database.prepare('INSERT INTO module_records (module_id, id, data, subject_id) VALUES (?, ?, ?, ?)')
      .run(moduleId, id, json, subjectId ?? null);
    return decode(selectOne.get(moduleId, id));
  });

  const replace = database.transaction((moduleId, id, data, revision) => {
    const row = requireRow(moduleId, id);
    requireRevision(row, revision);
    const json = encode(data);
    assertQuota(moduleId, json, row);
    database.prepare(`
      UPDATE module_records
      SET data = ?, revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE module_id = ? AND id = ?
    `).run(json, moduleId, id);
    return decode(selectOne.get(moduleId, id));
  });

  const remove = database.transaction((moduleId, id, revision) => {
    const row = requireRow(moduleId, id);
    requireRevision(row, revision);
    database.prepare('DELETE FROM module_records WHERE module_id = ? AND id = ?').run(moduleId, id);
    return { id, deleted: true };
  });

  return {
    get(moduleId, id) {
      return decode(requireRow(moduleId, id));
    },

    /** Nur die Person eines Datensatzes, fuer die Rechtepruefung vor dem Zugriff. */
    subjectOf(moduleId, id) {
      return requireRow(moduleId, id).subject_id ?? null;
    },

    /**
     * Stabile Reihenfolge nach Id; `next` ist die Id, nach der die naechste
     * Seite beginnt. `readable`: null = alle Personen, sonst die Menge der
     * Personen, deren Datensaetze der Anfragende lesen darf (haushaltsweite
     * Datensaetze immer). `subject`: nur die Datensaetze dieser Person.
     */
    list(moduleId, { after = '', limit = PAGE_DEFAULT, readable = null, subject = undefined } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX
        || typeof after !== 'string' || (after !== '' && !RECORD_ID_RE.test(after))) {
        throw storageError(400, 'record_page_invalid', `limit must be 1 to ${PAGE_MAX}; after must be a record id.`);
      }
      const where = ['module_id = ?', 'id > ?'];
      const args = [moduleId, after];
      if (readable !== null) {
        const ids = [...readable];
        where.push(`(subject_id IS NULL${ids.length ? ` OR subject_id IN (${ids.map(() => '?').join(', ')})` : ''})`);
        args.push(...ids);
      }
      if (subject === null) where.push('subject_id IS NULL');
      else if (subject !== undefined) { where.push('subject_id = ?'); args.push(subject); }
      const rows = database.prepare(
        `SELECT * FROM module_records WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`
      ).all(...args, limit + 1);
      return {
        data: rows.slice(0, limit).map(decode),
        next: rows.length > limit ? rows[limit - 1].id : null,
      };
    },

    create: (moduleId, data, { subjectId = null } = {}) => create(moduleId, data, subjectId),
    replace: (moduleId, id, data, revision) => replace(moduleId, id, data, parseRevision(revision)),
    remove: (moduleId, id, revision) => remove(moduleId, id, parseRevision(revision)),

    usage(moduleId) {
      const u = selectUsage.get(moduleId);
      return { records: u.records, bytes: u.bytes, limits: { ...limits } };
    },

    /** Alle Module mit gespeicherten Daten, auch abgeschaltete und entfernte. */
    usageByModule() {
      return database.prepare(`
        SELECT module_id, COUNT(*) AS records, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes,
               MAX(updated_at) AS updated_at
        FROM module_records GROUP BY module_id ORDER BY module_id
      `).all();
    },

    /** Endgueltig loeschen - der einzige Weg, auf dem Moduldaten verschwinden. Freigaben gehen mit. */
    purge(moduleId) {
      return database.transaction(() => {
        database.prepare('DELETE FROM module_person_grants WHERE module_id = ?').run(moduleId);
        return database.prepare('DELETE FROM module_records WHERE module_id = ?').run(moduleId).changes;
      })();
    },
  };
}
