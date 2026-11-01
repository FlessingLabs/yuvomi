/**
 * Modul: Modulspeicher - Personen und Freigaben (Migration 275)
 * Zweck: DIE EINE Regel, wer die personenbezogenen Datensaetze eines Moduls
 *        lesen oder schreiben darf (DECISIONS.md, Eintrag 2). Jeder Weg zu
 *        einem Datensatz mit subject_id fragt hier - Liste, Einzelabruf,
 *        Anlegen, Ersetzen, Loeschen, Personenliste.
 *
 * DIE REGEL, innerhalb des Modulrechts `ext:<id>` (das prueft der Router davor):
 *   - Administrator:in: lesen und schreiben, fuer jede Person.
 *   - Die Person selbst: lesen. Schreiben nur mit Admin-Recht.
 *   - Wem ein Admin fuer GENAU dieses Modul und GENAU diese Person eine
 *     Freigabe gegeben hat (module_person_grants): lesen bzw. schreiben.
 *   - Alle anderen: nichts - der Datensatz existiert fuer sie nicht (404).
 *
 * KEINE ABLEITUNG AUS family_role, Alter oder Namen. Dieselbe Entscheidung wie
 * bei health_care_grants (Migration 130, DECISIONS.md Eintrag 1): wer Daten
 * einer anderen Person sieht, entscheidet ein Admin pro Person; ohne Eintrag
 * aendert sich nichts.
 */
import { isAdminRequest } from '../middleware/require-admin.js';
import { householdMemberSql, activeAccountSql } from './household-members.js';

export const ACCESS_NONE = 'none';
export const ACCESS_READ = 'read';
export const ACCESS_WRITE = 'write';

function viewerOf(req) {
  const id = Number(req?.authUserId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Recht des Anfragenden an den Datensaetzen von `subjectId` in diesem Modul. */
export function personAccess(database, req, moduleId, subjectId) {
  if (isAdminRequest(req)) return ACCESS_WRITE;
  const viewer = viewerOf(req);
  if (viewer === null) return ACCESS_NONE;
  const grant = database.prepare(
    'SELECT access FROM module_person_grants WHERE module_id = ? AND subject_id = ? AND grantee_id = ?'
  ).get(moduleId, subjectId, viewer)?.access;
  if (grant === ACCESS_WRITE) return ACCESS_WRITE;
  if (grant === ACCESS_READ || viewer === subjectId) return ACCESS_READ;
  return ACCESS_NONE;
}

/**
 * Welche Personen darf der Anfragende in diesem Modul lesen? `null` heisst
 * alle (Admin); sonst die Menge der Ids - die eigene plus jede Freigabe.
 */
export function readableSubjects(database, req, moduleId) {
  if (isAdminRequest(req)) return null;
  const viewer = viewerOf(req);
  const ids = new Set(viewer === null ? [] : [viewer]);
  if (viewer !== null) {
    for (const row of database.prepare(
      'SELECT subject_id FROM module_person_grants WHERE module_id = ? AND grantee_id = ?'
    ).all(moduleId, viewer)) ids.add(row.subject_id);
  }
  return ids;
}

/** Ist `userId` ein aktives Haushaltsmitglied (keine Gaeste, kein Personal, kein Display)? */
export function isActiveMember(database, userId) {
  if (!Number.isSafeInteger(userId) || userId < 1) return false;
  return Boolean(database.prepare(
    `SELECT 1 FROM users u WHERE u.id = ? AND ${householdMemberSql('u')} AND ${activeAccountSql('u')}`
  ).get(userId));
}

/**
 * Die Personen, die der Anfragende in diesem Modul sieht, mit seinem Recht.
 * Nur aktive Haushaltsmitglieder; Anzeigename und Farbe aus Yuvomi.
 */
export function listPeople(database, req, moduleId) {
  const members = database.prepare(`
    SELECT u.id, u.display_name, u.avatar_color, u.family_role
    FROM users u
    WHERE ${householdMemberSql('u')} AND ${activeAccountSql('u')}
    ORDER BY u.display_name COLLATE NOCASE, u.id
  `).all();
  const out = [];
  for (const m of members) {
    const access = personAccess(database, req, moduleId, m.id);
    if (access === ACCESS_NONE) continue;
    out.push({
      user_id: m.id,
      display_name: m.display_name,
      avatar_color: m.avatar_color,
      family_role: m.family_role,
      access,
      self: m.id === viewerOf(req),
    });
  }
  return out;
}

/** Alle Freigaben eines Moduls: `{ <subjectId>: [{ user_id, access }] }`. Nur fuer Admins. */
export function listGrants(database, moduleId) {
  const out = {};
  for (const row of database.prepare(
    'SELECT subject_id, grantee_id, access FROM module_person_grants WHERE module_id = ? ORDER BY subject_id, grantee_id'
  ).all(moduleId)) {
    (out[row.subject_id] ||= []).push({ user_id: row.grantee_id, access: row.access });
  }
  return out;
}

export class GrantError extends Error {
  constructor(message, reason) {
    super(message);
    this.status = 400;
    this.reason = reason;
  }
}

/**
 * Die Freigaben fuer eine Person ersetzen. Eine leere Liste nimmt alle zurueck.
 * Nur aktive Haushaltsmitglieder, nie die Person selbst, jede Person einmal.
 */
export function setGrants(database, moduleId, subjectId, grants) {
  if (!isActiveMember(database, subjectId)) throw new GrantError('The person is not an active household member.', 'module_person_invalid');
  if (!Array.isArray(grants)) throw new GrantError('grants must be a list of { user_id, access }.', 'module_grants_invalid');
  const seen = new Set();
  const rows = [];
  for (const g of grants) {
    const userId = Number(g?.user_id);
    if (!Number.isSafeInteger(userId) || !isActiveMember(database, userId)) {
      throw new GrantError('Every grantee must be an active household member.', 'module_grants_invalid');
    }
    if (userId === subjectId) throw new GrantError('A person cannot be granted access to their own records.', 'module_grants_invalid');
    if (g.access !== ACCESS_READ && g.access !== ACCESS_WRITE) throw new GrantError('access must be read or write.', 'module_grants_invalid');
    if (seen.has(userId)) throw new GrantError('Each grantee may appear once.', 'module_grants_invalid');
    seen.add(userId);
    rows.push([userId, g.access]);
  }
  database.transaction(() => {
    database.prepare('DELETE FROM module_person_grants WHERE module_id = ? AND subject_id = ?').run(moduleId, subjectId);
    const insert = database.prepare(
      'INSERT INTO module_person_grants (module_id, subject_id, grantee_id, access) VALUES (?, ?, ?, ?)'
    );
    for (const [userId, access] of rows) insert.run(moduleId, subjectId, userId, access);
  })();
  return listGrants(database, moduleId)[subjectId] ?? [];
}
