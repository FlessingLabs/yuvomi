/**
 * Modul: Persoenliche Benachrichtigungen
 * Zweck: Wer eigene Ziele (Kanaele mit scope 'user') einrichten darf, und die
 *        Einstellungen der Tagesvorschau je Person und fuer den Haushalt.
 * Abhaengigkeiten: server/db.js (Migration 276), household-members.js
 *
 * FREIGABE STATT ABLEITUNG. Ein Admin gibt eigene Ziele je Mitglied frei
 * (notification_personal_access); Admins brauchen keine Zeile. Nichts wird aus
 * Rolle, family_role oder Alter geschlossen (DECISIONS.md 1). Faellt die
 * Freigabe weg, bleiben die Kanaele der Person stehen, werden aber
 * ausgeschaltet, und die Tagesvorschau ruht. Erneut freigegeben, schaltet die
 * Person ihre Kanaele selbst wieder ein.
 */
import { householdMemberSql, memberOrderSql } from './household-members.js';

export const DIGEST_SECTIONS = Object.freeze(['events', 'tasks', 'birthdays', 'waste', 'shopping']);
export const DIGEST_DEFAULT_SECTIONS = Object.freeze(['events', 'tasks', 'birthdays', 'waste']);
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class PersonalNotificationError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

/** Darf die Person eigene Ziele und eine eigene Tagesvorschau haben? */
export function personalAllowed(database, userId) {
  if (userId == null) return false;
  const row = database.prepare(`
    SELECT u.role, a.user_id AS granted
    FROM users u LEFT JOIN notification_personal_access a ON a.user_id = u.id
    WHERE u.id = ? AND ${householdMemberSql('u')}
  `).get(userId);
  if (!row) return false;
  return row.role === 'admin' || row.granted != null;
}

/** Alle Mitglieder mit ihrer Freigabe (fuer die Admin-Seite). */
export function listAccess(database) {
  return database.prepare(`
    SELECT u.id AS user_id, u.display_name, u.role,
      CASE WHEN u.role = 'admin' OR a.user_id IS NOT NULL THEN 1 ELSE 0 END AS allowed
    FROM users u LEFT JOIN notification_personal_access a ON a.user_id = u.id
    WHERE ${householdMemberSql('u')}
    ORDER BY ${memberOrderSql('u')}
  `).all().map((r) => ({ user_id: r.user_id, display_name: r.display_name, admin: r.role === 'admin', allowed: Boolean(r.allowed) }));
}

/** Freigabe setzen oder nehmen. Admins sind immer frei; fuer sie gibt es nichts zu setzen. */
export function setAccess(database, userId, allowed) {
  const user = database.prepare(`SELECT id, role FROM users u WHERE u.id = ? AND ${householdMemberSql('u')}`).get(userId);
  if (!user) throw new PersonalNotificationError('Member not found.', 'member_not_found');
  if (user.role === 'admin') return true;
  if (allowed) {
    database.prepare('INSERT OR IGNORE INTO notification_personal_access (user_id) VALUES (?)').run(userId);
    return true;
  }
  // FREIGABE ZURUECK HEISST: NICHTS GEHT MEHR RAUS. Die Kanaele bleiben stehen
  // (die Person sieht und loescht sie weiter), werden aber ausgeschaltet - der
  // Versand selbst fragt die Freigabe nicht, damit persoenliche Kanaele aus der
  // Zeit vor Migration 276 nach dem Update nicht still verstummen. Die
  // Tagesvorschau fragt sie bei jedem Lauf (notification-digest.js).
  // Erst die Kanaele aus, dann die Freigabe weg: bricht es dazwischen ab, ist
  // die Person noch freigegeben und kann sie wieder einschalten.
  database.prepare("UPDATE notification_channels SET enabled = 0 WHERE scope = 'user' AND user_id = ?").run(userId);
  database.prepare('DELETE FROM notification_personal_access WHERE user_id = ?').run(userId);
  return false;
}

function parseList(json) {
  try {
    const value = JSON.parse(json || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function rowToDigest(row, scope) {
  if (!row) {
    return { scope, enabled: false, sendTime: '19:00', day: 'tomorrow', sections: [...DIGEST_DEFAULT_SECTIONS], channelIds: [], lastSentDate: null };
  }
  return {
    scope,
    enabled: Boolean(row.enabled),
    sendTime: row.send_time,
    day: row.day,
    sections: parseList(row.sections_json).filter((s) => DIGEST_SECTIONS.includes(s)),
    channelIds: parseList(row.channel_ids_json).filter((id) => Number.isInteger(id)),
    lastSentDate: row.last_sent_date,
  };
}

export function getDigest(database, { scope, userId = null }) {
  const row = scope === 'household'
    ? database.prepare("SELECT * FROM notification_digests WHERE scope = 'household'").get()
    : database.prepare("SELECT * FROM notification_digests WHERE scope = 'user' AND user_id = ?").get(userId);
  return rowToDigest(row, scope);
}

/**
 * Die Kanaele, an die eine Vorschau gehen darf: eine persoenliche nur an die
 * eigenen Kanaele der Person, die des Haushalts nur an Haushaltskanaele. Eine
 * Vorschau mit den privaten Terminen einer Person in einen Kanal, den andere
 * lesen, gibt es so nicht.
 */
export function allowedDigestChannels(database, { scope, userId = null }) {
  return scope === 'household'
    ? database.prepare("SELECT id FROM notification_channels WHERE scope = 'household'").all().map((r) => r.id)
    : database.prepare("SELECT id FROM notification_channels WHERE scope = 'user' AND user_id = ?").all(userId).map((r) => r.id);
}

export function normalizeDigestInput(database, { scope, userId = null }, input = {}, existing = getDigest(database, { scope, userId })) {
  const enabled = input.enabled === undefined ? existing.enabled : Boolean(input.enabled);
  const sendTime = input.sendTime === undefined ? existing.sendTime : String(input.sendTime).trim();
  if (!TIME_PATTERN.test(sendTime)) throw new PersonalNotificationError('The time must be HH:MM.', 'digest_time_invalid');
  const day = input.day === undefined ? existing.day : String(input.day);
  if (!['today', 'tomorrow'].includes(day)) throw new PersonalNotificationError('The day must be today or tomorrow.', 'digest_day_invalid');
  const sections = input.sections === undefined ? existing.sections
    : [...new Set((Array.isArray(input.sections) ? input.sections : []).map(String))];
  if (sections.some((s) => !DIGEST_SECTIONS.includes(s))) throw new PersonalNotificationError('Unknown section.', 'digest_section_invalid');
  if (enabled && !sections.length) throw new PersonalNotificationError('Choose at least one section.', 'digest_sections_empty');
  const channelIds = input.channelIds === undefined ? existing.channelIds
    : [...new Set((Array.isArray(input.channelIds) ? input.channelIds : []).map(Number))];
  const allowed = new Set(allowedDigestChannels(database, { scope, userId }));
  if (channelIds.some((id) => !allowed.has(id))) throw new PersonalNotificationError('Unknown channel.', 'digest_channel_invalid');
  return { enabled, sendTime, day, sections, channelIds };
}

export function saveDigest(database, { scope, userId = null }, input = {}) {
  const value = normalizeDigestInput(database, { scope, userId }, input);
  const now = new Date().toISOString();
  const params = [value.enabled ? 1 : 0, value.sendTime, value.day, JSON.stringify(value.sections), JSON.stringify(value.channelIds), now];
  const existing = scope === 'household'
    ? database.prepare("SELECT id FROM notification_digests WHERE scope = 'household'").get()
    : database.prepare("SELECT id FROM notification_digests WHERE scope = 'user' AND user_id = ?").get(userId);
  if (existing) {
    database.prepare(`UPDATE notification_digests SET enabled = ?, send_time = ?, day = ?, sections_json = ?, channel_ids_json = ?, updated_at = ?
      WHERE id = ?`).run(...params, existing.id);
  } else {
    database.prepare(`INSERT INTO notification_digests (enabled, send_time, day, sections_json, channel_ids_json, updated_at, scope, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...params, scope, scope === 'household' ? null : userId);
  }
  return getDigest(database, { scope, userId });
}

/** Kanal geloescht: aus jeder Vorschau-Auswahl nehmen, damit keine tote Id stehen bleibt. */
export function forgetDigestChannel(database, channelId) {
  for (const row of database.prepare('SELECT id, channel_ids_json FROM notification_digests').all()) {
    const ids = parseList(row.channel_ids_json);
    if (ids.includes(channelId)) {
      database.prepare('UPDATE notification_digests SET channel_ids_json = ? WHERE id = ?')
        .run(JSON.stringify(ids.filter((id) => id !== channelId)), row.id);
    }
  }
}
