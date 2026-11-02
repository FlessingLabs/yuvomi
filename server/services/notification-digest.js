/**
 * Modul: Tagesvorschau
 * Zweck: Eine Nachricht am Abend (oder Morgen) mit dem, was an einem Tag ansteht:
 *        Termine, faellige Aufgaben, Geburtstage der naechsten sieben Tage,
 *        Muellabfuhr und die offene Einkaufsliste.
 * Abhaengigkeiten: notification-personal.js (Einstellungen), notification-channels.js
 *        (Ziele), die geteilten Leser von Kalender, Aufgaben, Geburtstagen und Muell.
 *
 * DIESELBEN LESER WIE DIE UEBERSICHT, DIESELBEN GRENZEN. Die persoenliche
 * Vorschau liest mit den Augen der Person (Sichtbarkeit `visibilityWhere`,
 * Modulrechte aus `resolvePermissions`, Haushaltsschalter aus
 * `modulesLeftOut`), die des Haushalts mit denen der Wand (`household`,
 * `householdVisibleWhere`): nur, was jeder sehen darf. Sie geht deshalb auch
 * nur an Haushaltskanaele, die persoenliche nur an die eigenen Kanaele der
 * Person (notification-personal.js, allowedDigestChannels).
 *
 * GEBURTSTAGE MIT EINER WOCHE VORLAUF: jeder Geburtstag der naechsten sieben
 * Tage steht in jeder Vorschau, bis er da ist - ohne eigene Erinnerungsregel.
 */
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';
import { getEventsOverlappingDays } from './calendar-event-reader.js';
import { hydrateBirthdayOccurrences } from './birthdays.js';
import { getOccurrences as getWasteOccurrences } from './waste-store.js';
import { birthdaysSwitchedOff, modulesLeftOut } from './household-modules.js';
import { visibilityWhere, householdVisibleWhere } from './visibility.js';
import { resolvePermissions } from '../permissions.js';
import { activeAccountSql } from './account-state.js';
import { householdTimeZone, localToUTC, shiftDateKey, utcToWall } from '../utils/timezone.js';
import { resolveHouseholdFormats, formatDateKey, translate } from '../utils/i18n.js';
import { createNotificationChannelStore } from './notification-channels.js';
import { personalAllowed } from './notification-personal.js';
import { defaultProviders } from './notifications.js';
import { guardedFetch } from './notification-providers/guarded-fetch.js';

const log = createLogger('Digest');

export const BIRTHDAY_LEAD_DAYS = 7;
// Wer den Server zur eingestellten Zeit nicht laufen hatte, bekommt die
// Vorschau noch bis zu zwei Stunden spaeter - danach waere sie eher verwirrend.
const SEND_WINDOW_MINUTES = 120;
const SHOPPING_ITEM_CAP = 15;
const PROVIDER_TIMEOUT_MS = 15_000;

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Wanduhrzeit "HH:MM" eines gespeicherten Zeitpunkts (Instant oder zonenlos). */
function wallTime(value, tz) {
  const v = String(value ?? '');
  if (/(Z|[+-]\d\d:?\d\d)$/.test(v)) return utcToWall(v, tz)?.time?.slice(0, 5) ?? null;
  return /T\d\d:\d\d/.test(v) ? v.slice(11, 16) : null;
}

/** Welche Module diese Vorschau lesen darf. */
function moduleGate(database, { scope, userId }) {
  const denied = new Set();
  if (scope === 'user') {
    const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
    const resolved = resolvePermissions(database, user);
    for (const [key, access] of Object.entries(resolved.modules ?? {})) if (access === 'none') denied.add(key);
  }
  const leftOut = modulesLeftOut(database, denied);
  return {
    allows: (key) => !leftOut.has(key),
    birthdays: !denied.has('calendar') && !birthdaysSwitchedOff(database),
  };
}

function eventsSection(database, { scope, userId, dateKey, tz, locale }) {
  const rows = getEventsOverlappingDays(database, {
    userId: scope === 'user' ? userId : null, fromKey: dateKey, days: 1, includeBirthdays: false, household: scope === 'household',
  });
  return rows.map((e) => {
    const start = e.all_day ? null : wallTime(e.start_datetime, tz);
    // Ein mehrtaegiger Termin, der vor diesem Tag begann, laeuft hier ganztags.
    const startsToday = String(e.start_datetime ?? '').slice(0, 10) === dateKey || (start && utcToWall(e.start_datetime, tz)?.date === dateKey);
    const when = e.all_day || !startsToday || !start ? translate(locale, 'messenger.digest.allDay') : start;
    return { sort: e.all_day || !startsToday ? '00:00' : start, line: `${when}  ${e.title}` };
  }).sort((a, b) => a.sort.localeCompare(b.sort)).map((x) => x.line);
}

function tasksSection(database, { scope, userId, dateKey }) {
  const visible = scope === 'household' ? householdVisibleWhere('t') : visibilityWhere('t', 'task_assignments', 'task_id', '@me');
  return database.prepare(`
    SELECT t.title, t.due_time FROM tasks t
    WHERE t.status != 'done' AND t.archived_at IS NULL AND t.parent_task_id IS NULL
      AND t.due_date = @day AND ${visible}
    ORDER BY t.due_time IS NULL, t.due_time, t.title COLLATE NOCASE
    LIMIT 30
  `).all({ day: dateKey, me: userId }).map((t) => (t.due_time ? `${String(t.due_time).slice(0, 5)}  ${t.title}` : `• ${t.title}`));
}

function birthdaysSection(database, { dateKey, tz, locale, dateFormat }) {
  const from = new Date(localToUTC(`${dateKey}T12:00:00`, tz));
  const rows = database.prepare('SELECT * FROM birthdays ORDER BY name COLLATE NOCASE').all();
  return rows.flatMap((row) => hydrateBirthdayOccurrences(database, row, from))
    .filter((b) => Number.isInteger(b.days_until) && b.days_until >= 0 && b.days_until <= BIRTHDAY_LEAD_DAYS)
    .sort((a, b) => a.days_until - b.days_until || a.name.localeCompare(b.name))
    .map((b) => {
      const when = b.days_until === 0 ? translate(locale, 'messenger.digest.birthdayToday') : formatDateKey(b.next_date, dateFormat);
      const what = b.kind === 'name_day' ? ` (${translate(locale, 'messenger.digest.nameDay')})`
        : b.next_age ? ` (${b.next_age})` : '';
      return `${when}  ${b.name}${what}`;
    });
}

function wasteSection(database, { dateKey }) {
  return getWasteOccurrences(database, { from: dateKey, to: dateKey })
    .filter((o) => o.date_key === dateKey)
    .map((o) => `• ${o.type_name}`);
}

function shoppingSection(database) {
  const rows = database.prepare(`
    SELECT l.name AS list, i.name AS item FROM shopping_items i JOIN shopping_lists l ON l.id = i.list_id
    WHERE i.is_checked = 0 ORDER BY l.id, i.sort_order, i.id
  `).all();
  const byList = new Map();
  for (const r of rows) {
    if (!byList.has(r.list)) byList.set(r.list, []);
    byList.get(r.list).push(r.item);
  }
  return [...byList].map(([list, items]) => {
    const shown = items.slice(0, SHOPPING_ITEM_CAP).join(', ');
    return `${list}: ${shown}${items.length > SHOPPING_ITEM_CAP ? ` +${items.length - SHOPPING_ITEM_CAP}` : ''}`;
  });
}

// Die Ueberschrift als festes Literal je Abschnitt (`titleKey`), nicht
// zusammengesetzt: so findet der Schluessel-Guard (test-i18n-ko-particles.js,
// DYNAMIC_KEY_SITES) jeden Text, den diese Datei braucht.
const SECTION_BUILDERS = {
  events: { module: 'calendar', titleKey: 'messenger.digest.section.events', build: eventsSection },
  tasks: { module: 'tasks', titleKey: 'messenger.digest.section.tasks', build: tasksSection },
  birthdays: { module: 'birthdays', titleKey: 'messenger.digest.section.birthdays', build: birthdaysSection },
  waste: { module: 'waste', titleKey: 'messenger.digest.section.waste', build: wasteSection },
  shopping: { module: 'shopping', titleKey: 'messenger.digest.section.shopping', build: shoppingSection },
};

/**
 * Die Vorschau als { title, body }. `dateKey` ist der Tag, um den es geht
 * (heute oder morgen in der Haushaltszone).
 */
export function buildDigest(database, { scope, userId = null, dateKey, sections, today }) {
  const tz = householdTimeZone(database);
  const { locale, dateFormat } = resolveHouseholdFormats(database);
  const gate = moduleGate(database, { scope, userId });
  const ctx = { scope, userId, dateKey, tz, locale, dateFormat };
  const parts = [];
  for (const key of sections) {
    const def = SECTION_BUILDERS[key];
    if (!def) continue;
    if (key === 'birthdays' ? !gate.birthdays : !gate.allows(def.module)) continue;
    let lines = [];
    try {
      lines = def.build(database, ctx);
    } catch (err) {
      log.error(`Digest section ${key} failed:`, err?.message || err);
      continue;
    }
    if (lines.length) parts.push(`${translate(locale, def.titleKey)}\n${lines.join('\n')}`);
  }
  const date = formatDateKey(dateKey, dateFormat);
  const title = translate(locale, dateKey === today ? 'messenger.digest.titleToday' : 'messenger.digest.titleTomorrow', { date });
  return { title, body: parts.length ? parts.join('\n\n') : translate(locale, 'messenger.digest.nothing'), empty: !parts.length };
}

async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Die Ziele einer Vorschau: ausgewaehlt, eingeschaltet und (persoenlich) noch freigegeben. */
function digestTargets(store, row) {
  const chosen = new Set(JSON.parse(row.channel_ids_json || '[]'));
  const candidates = row.scope === 'household'
    ? store.listEnabledChannelsForUser(-1).filter((c) => c.scope === 'household')
    : store.listEnabledChannelsForUser(row.user_id).filter((c) => c.scope === 'user' && c.userId === row.user_id);
  return chosen.size ? candidates.filter((c) => chosen.has(c.id)) : candidates;
}

/** Ist diese Vorschau jetzt dran? (Uhrzeit erreicht, im Fenster, heute noch nicht gesendet) */
export function digestDue(row, wall) {
  if (!row.enabled || row.last_sent_date === wall.date) return false;
  const diff = minutesOf(wall.time) - minutesOf(row.send_time);
  return diff >= 0 && diff < SEND_WINDOW_MINUTES;
}

/**
 * Sendet jede faellige Vorschau. Laeuft im Minutentakt mit den Erinnerungen
 * (push-scheduler.js). Der Tag wird VOR dem Senden als erledigt markiert:
 * lieber eine verlorene Vorschau als zwei, wenn der Server mittendrin stoppt.
 */
export async function processDueDigests({
  database, now = new Date(), providers = defaultProviders, fetchImpl = guardedFetch, channelStore,
} = {}) {
  const d = database || dbModule.get();
  const tz = householdTimeZone(d);
  const wall = utcToWall(now.toISOString(), tz);
  if (!wall) return { sent: 0 };
  const store = channelStore || createNotificationChannelStore({ db: d });
  const rows = d.prepare(`
    SELECT g.* FROM notification_digests g
    LEFT JOIN users u ON u.id = g.user_id
    WHERE g.enabled = 1 AND (g.scope = 'household' OR ${activeAccountSql('u')})
  `).all();
  let sent = 0;
  for (const row of rows) {
    if (!digestDue(row, wall)) continue;
    if (row.scope === 'user' && !personalAllowed(d, row.user_id)) continue;
    d.prepare('UPDATE notification_digests SET last_sent_date = ? WHERE id = ?').run(wall.date, row.id);
    const targets = digestTargets(store, row);
    if (!targets.length) continue;
    const dateKey = row.day === 'today' ? wall.date : shiftDateKey(wall.date, 1);
    let digest;
    try {
      digest = buildDigest(d, {
        scope: row.scope, userId: row.user_id, dateKey, today: wall.date,
        sections: JSON.parse(row.sections_json || '[]'),
      });
    } catch (err) {
      log.error(`Digest ${row.id} could not be built:`, err?.message || err);
      continue;
    }
    const payload = { title: digest.title, body: digest.body, url: '/', tag: `digest-${row.id}-${dateKey}`, priority: 'default' };
    for (const channel of targets) {
      const provider = providers[channel.provider];
      if (!provider) continue;
      try {
        await withTimeout((signal) => provider.send({ channel, payload, fetchImpl, signal }));
        sent += 1;
      } catch (err) {
        log.warn(`Digest ${row.id} to channel ${channel.id} failed:`, err?.message || err);
      }
    }
  }
  return { sent };
}

/** Die Vorschau sofort an EIN Ziel schicken (Knopf "Jetzt testen"). */
export async function sendDigestNow(database, { scope, userId = null, digest: settings, channel, providers = defaultProviders, fetchImpl = guardedFetch, now = new Date() }) {
  const tz = householdTimeZone(database);
  const wall = utcToWall(now.toISOString(), tz);
  const dateKey = settings.day === 'today' ? wall.date : shiftDateKey(wall.date, 1);
  const digest = buildDigest(database, { scope, userId, dateKey, today: wall.date, sections: settings.sections });
  const provider = providers[channel.provider];
  if (!provider) throw new Error('Unknown notification provider.');
  await withTimeout((signal) => provider.send({
    channel, payload: { title: digest.title, body: digest.body, url: '/', tag: `digest-test-${Date.now()}`, priority: 'default' }, fetchImpl, signal,
  }));
  return digest;
}
