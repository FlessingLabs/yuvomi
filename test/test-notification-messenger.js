/**
 * Modul: Messenger-Ziele und Tagesvorschau (Migration 276)
 * Zweck: Telegram/Discord als Vorlagen des Webhooks, der Schluessel im Pfad,
 *        persoenliche Ziele mit Freigabe durch einen Admin, und die
 *        Tagesvorschau mit den Sichtgrenzen ihrer Leser - gegen den echten
 *        Server (server/index.js).
 *
 * Geprueft wird:
 *   - Vorlagen: Adresse und Body kommen aus wenigen Feldern, der Token steht
 *     write-only in den Geheimnissen und erst beim Senden in der Adresse
 *   - ohne Freigabe legt ein Mitglied nichts an; ein fremder Kanal existiert
 *     nicht (404); der Admin sieht persoenliche Kanaele nicht in seiner Liste
 *   - Freigabe zurueck schaltet die Kanaele aus, Loeschen geht weiter
 *   - die persoenliche Vorschau zeigt nur, was die Person sieht; die des
 *     Haushalts nur, was alle sehen, und geht nur an Haushaltskanaele
 *   - Geburtstage stehen ab sieben Tagen vorher in jeder Vorschau
 *   - faellig genau einmal am Tag, im Fenster nach der eingestellten Zeit
 *
 * Ausfuehren: npm run test:notification-messenger
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, cookieHeader } from './server-ready.js';

const { baseUrl: BASE } = await startTestServer({
  name: 'notification-messenger',
  env: { SESSION_SECRET: 'test-notification-messenger-secret-32chars' },
});
const db = await import('../server/db.js');
const { normalizeChannelInput } = await import('../server/services/notification-channels.js');
const { webhookProvider } = await import('../server/services/notification-providers/webhook.js');
const { buildDigest, digestDue, processDueDigests } = await import('../server/services/notification-digest.js');
const { shiftDateKey, todayKey } = await import('../server/utils/timezone.js');

await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: 'adminpass123' }),
});

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(res.status, 200, `login ${username}`);
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  const me = await (await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } })).json();
  return { cookie, csrfToken: me.csrfToken };
}

function as(session) {
  return async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };
    const res = await fetch(`${BASE}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

const admin = as(await login('admin', 'adminpass123'));
const ids = {};
for (const name of ['lea', 'max']) {
  const res = await admin('POST', '/auth/users', { username: name, display_name: name, password: `${name}-pass-123` });
  assert.ok(res.status === 200 || res.status === 201, `create ${name}: ${res.status}`);
  ids[name] = res.body?.user?.id ?? res.body?.data?.id;
}
const lea = as(await login('lea', 'lea-pass-123'));
const max = as(await login('max', 'max-pass-123'));

const TG_TOKEN = '123456789:AAEabcdefghijklmnopqrstuvwxyz012';
const TELEGRAM = { provider: 'webhook', name: 'Mein Telegram', enabled: true, config: { preset: 'telegram', chatId: '987654' }, secrets: { token: TG_TOKEN } };

test('Vorlage Telegram: Adresse und Body aus zwei Feldern, Token nur in den Geheimnissen', async () => {
  const n = normalizeChannelInput({ ...TELEGRAM, secrets: { token: `bot${TG_TOKEN}` } });
  assert.equal(n.config.baseUrl, 'https://api.telegram.org/bot{{token}}/sendMessage');
  assert.equal(n.secrets.token, TG_TOKEN, 'ein vorangestelltes "bot" aus der Adresse wird verstanden');
  assert.equal(JSON.parse(n.config.payloadTemplate.replace(/\{\{\w+\}\}/g, 'x')).chat_id, '987654');
  assert.throws(() => normalizeChannelInput({ ...TELEGRAM, config: { preset: 'telegram', chatId: 'abc' } }), /chat ID/);
  assert.throws(() => normalizeChannelInput({ ...TELEGRAM, secrets: { token: 'falsch' } }), /bot token/);

  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  await webhookProvider.send({ channel: { config: n.config, secrets: n.secrets }, payload: { title: 'T "x"', body: 'Zeile\nZwei' }, fetchImpl });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
  assert.equal(calls[0].init.headers.authorization, undefined, 'der Token hat seinen Ort in der Adresse, nicht zusaetzlich im Header');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '987654', text: 'T "x"\n\nZeile\nZwei' });
});

test('Vorlage Discord: die eingefuegte Webhook-Adresse wird zu "<id>/<token>", lange Texte werden gekuerzt', async () => {
  const n = normalizeChannelInput({
    provider: 'webhook', name: 'D', config: { preset: 'discord' },
    secrets: { token: 'https://discord.com/api/webhooks/123456789012345/abcdefghijklmnopqrstuvwxyz_-0123' },
  });
  assert.equal(n.secrets.token, '123456789012345/abcdefghijklmnopqrstuvwxyz_-0123');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 204 }; };
  await webhookProvider.send({ channel: { config: n.config, secrets: n.secrets }, payload: { title: 'T', body: 'a\n'.repeat(3000) }, fetchImpl });
  assert.equal(calls[0].url, 'https://discord.com/api/webhooks/123456789012345/abcdefghijklmnopqrstuvwxyz_-0123');
  const content = JSON.parse(calls[0].init.body).content;
  assert.ok(content.length <= 2000, `Discord nimmt 2000 Zeichen, gesendet ${content.length}`);
  assert.ok(content.endsWith('…'));
});

test('eigene Adresse mit {{token}}: nur im Pfad, und ohne Token wird nicht gespeichert', () => {
  assert.throws(() => normalizeChannelInput({ provider: 'webhook', name: 'x', config: { baseUrl: 'https://{{token}}.example.com/x' }, secrets: { token: 'abc' } }), /path/);
  assert.throws(() => normalizeChannelInput({ provider: 'webhook', name: 'x', config: { baseUrl: 'https://example.com/hook/{{token}}' } }), /token/);
  const ok = normalizeChannelInput({ provider: 'webhook', name: 'x', config: { baseUrl: 'https://example.com/hook/{{token}}' }, secrets: { token: 'abc-123' } });
  assert.equal(ok.config.baseUrl, 'https://example.com/hook/{{token}}');
  assert.throws(() => normalizeChannelInput({ provider: 'webhook', name: 'x', config: { baseUrl: 'https://example.com/hook/{{token}}' }, secrets: { token: 'a?b=c' } }), /token/);
});

test('ohne Freigabe legt ein Mitglied kein eigenes Ziel an', async () => {
  const before = await lea('GET', '/notifications/personal');
  assert.equal(before.status, 200);
  assert.equal(before.body.data.allowed, false);
  const refused = await lea('POST', '/notifications/personal/channels', TELEGRAM);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.reason, 'notification_personal_not_allowed');
  assert.equal((await lea('PUT', '/notifications/personal/digest', { enabled: true })).status, 403);
  // Die Freigabe setzt nur ein Admin.
  assert.equal((await lea('PUT', `/notifications/access/${ids.lea}`, { allowed: true })).status, 403);
});

test('mit Freigabe: eigene Ziele, Geheimnis bleibt drin, fremde Kanaele gibt es nicht', async () => {
  assert.equal((await admin('PUT', `/notifications/access/${ids.lea}`, { allowed: true })).status, 200);
  const access = await admin('GET', '/notifications/access');
  assert.equal(access.body.data.find((m) => m.user_id === ids.lea).allowed, true);
  assert.equal(access.body.data.find((m) => m.user_id === ids.max).allowed, false);

  const created = await lea('POST', '/notifications/personal/channels', { ...TELEGRAM, scope: 'household', userId: ids.max });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.scope, 'user', 'Reichweite und Besitzer kommen aus der Sitzung, nicht aus dem Body');
  assert.equal(created.body.data.userId, ids.lea);
  assert.equal(created.body.data.secrets, undefined);
  assert.equal(created.body.data.secretSet, true);
  assert.ok(!JSON.stringify(created.body).includes(TG_TOKEN));
  const id = created.body.data.id;

  assert.equal((await max('PUT', `/notifications/personal/channels/${id}`, { name: 'weg' })).status, 404);
  assert.equal((await max('DELETE', `/notifications/personal/channels/${id}`)).status, 404);
  assert.equal((await max('POST', `/notifications/personal/channels/${id}/test`)).status, 404);
  const adminList = await admin('GET', '/notifications/channels');
  assert.ok(!adminList.body.data.some((c) => c.id === id), 'persoenliche Kanaele stehen nicht in der Admin-Liste');

  // Vorschau nur an eigene Kanaele.
  const household = await admin('POST', '/notifications/channels', { provider: 'webhook', name: 'Familie', enabled: true, config: { preset: 'discord' }, secrets: { token: '123456789012345/abcdefghijklmnopqrstuvwxyz_-0123' } });
  assert.equal(household.status, 201);
  const foreign = await lea('PUT', '/notifications/personal/digest', { enabled: true, sendTime: '19:00', channelIds: [household.body.data.id] });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.reason, 'digest_channel_invalid');
  assert.equal((await lea('PUT', '/notifications/personal/digest', { enabled: true, sendTime: '25:00' })).body.reason, 'digest_time_invalid');
  const saved = await lea('PUT', '/notifications/personal/digest', { enabled: true, sendTime: '18:30', day: 'tomorrow', sections: ['events', 'birthdays'], channelIds: [id] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.channelIds, [id]);
  // Und die des Haushalts nur an Haushaltskanaele.
  assert.equal((await admin('PUT', '/notifications/digest', { enabled: true, channelIds: [id] })).body.reason, 'digest_channel_invalid');
  assert.equal((await admin('PUT', '/notifications/digest', { enabled: true, sendTime: '07:00', day: 'today', channelIds: [household.body.data.id] })).status, 200);

  // Freigabe zurueck: Kanaele aus, nichts Neues, Loeschen geht.
  assert.equal((await admin('PUT', `/notifications/access/${ids.lea}`, { allowed: false })).status, 200);
  const after = await lea('GET', '/notifications/personal');
  assert.equal(after.body.data.allowed, false);
  assert.equal(after.body.data.channels.find((c) => c.id === id).enabled, false);
  assert.equal((await lea('POST', '/notifications/personal/channels', TELEGRAM)).status, 403);
  assert.equal((await lea('DELETE', `/notifications/personal/channels/${id}`)).status, 200);
});

test('Vorschau: jede Person sieht nur ihre Termine, der Haushalt nur die fuer alle', () => {
  const d = db.get();
  const today = todayKey(d);
  const tomorrow = shiftDateKey(today, 1);
  const adminId = d.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const ev = d.prepare('INSERT INTO calendar_events (title, start_datetime, end_datetime, all_day, created_by, visibility) VALUES (?, ?, ?, 0, ?, ?)');
  ev.run('Elternabend', `${tomorrow}T19:30`, `${tomorrow}T21:00`, adminId, 'all');
  ev.run('Arzt privat', `${tomorrow}T08:15`, `${tomorrow}T09:00`, adminId, 'private');
  d.prepare("INSERT INTO tasks (title, created_by, visibility, due_date, status) VALUES ('Turnbeutel packen', ?, 'all', ?, 'open')").run(adminId, tomorrow);

  const forAdmin = buildDigest(d, { scope: 'user', userId: adminId, dateKey: tomorrow, today, sections: ['events', 'tasks'] });
  assert.match(forAdmin.body, /08:15 {2}Arzt privat/);
  assert.match(forAdmin.body, /19:30 {2}Elternabend/);
  assert.ok(forAdmin.body.indexOf('Arzt privat') < forAdmin.body.indexOf('Elternabend'), 'nach Uhrzeit sortiert');
  assert.match(forAdmin.body, /Turnbeutel packen/);

  const forLea = buildDigest(d, { scope: 'user', userId: ids.lea, dateKey: tomorrow, today, sections: ['events'] });
  assert.match(forLea.body, /Elternabend/);
  assert.doesNotMatch(forLea.body, /Arzt privat/);

  const forHousehold = buildDigest(d, { scope: 'household', dateKey: tomorrow, today, sections: ['events'] });
  assert.match(forHousehold.body, /Elternabend/);
  assert.doesNotMatch(forHousehold.body, /Arzt privat/, 'auch der Urheber sieht seinen privaten Termin nicht in der Familien-Vorschau');
});

test('Geburtstage: ab sieben Tagen vorher in jeder Vorschau, dann nicht mehr', () => {
  const d = db.get();
  const today = todayKey(d);
  const in5 = shiftDateKey(today, 5);
  const in9 = shiftDateKey(today, 9);
  const born = (key, years) => `${Number(key.slice(0, 4)) - years}${key.slice(4)}`;
  const adminId = d.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const add = d.prepare('INSERT INTO birthdays (name, birth_date, created_by) VALUES (?, ?, ?)');
  add.run('Oma Erna', born(in5, 80), adminId);
  add.run('Onkel Tom', born(in9, 50), adminId);
  add.run('Lea', born(today, 9), adminId);
  const digest = buildDigest(d, { scope: 'household', dateKey: today, today, sections: ['birthdays'] });
  assert.match(digest.body, /Oma Erna \(80\)/);
  assert.match(digest.body, /Lea \(9\)/);
  assert.doesNotMatch(digest.body, /Onkel Tom/, 'neun Tage sind noch zu frueh');
  assert.ok(digest.body.indexOf('Lea') < digest.body.indexOf('Oma Erna'), 'heute zuerst');
  const later = buildDigest(d, { scope: 'household', dateKey: shiftDateKey(today, 3), today, sections: ['birthdays'] });
  assert.match(later.body, /Onkel Tom/, 'aus Sicht von drei Tagen spaeter ist er in der Woche');
});

test('faellig: einmal am Tag, im Fenster nach der Uhrzeit', () => {
  const row = { enabled: 1, send_time: '19:00', last_sent_date: null };
  assert.equal(digestDue(row, { date: '2026-11-02', time: '18:59:00' }), false);
  assert.equal(digestDue(row, { date: '2026-11-02', time: '19:00:30' }), true);
  assert.equal(digestDue(row, { date: '2026-11-02', time: '20:59:00' }), true);
  assert.equal(digestDue(row, { date: '2026-11-02', time: '21:00:00' }), false, 'zwei Stunden spaeter ist es keine Vorschau mehr');
  assert.equal(digestDue({ ...row, last_sent_date: '2026-11-02' }, { date: '2026-11-02', time: '19:05:00' }), false);
  assert.equal(digestDue({ ...row, enabled: 0 }, { date: '2026-11-02', time: '19:05:00' }), false);
});

test('der Lauf schickt die Haushalts-Vorschau genau einmal an ihren Kanal', async () => {
  const d = db.get();
  const sent = [];
  const providers = { webhook: { send: async ({ channel, payload }) => { sent.push({ channel: channel.id, payload }); return { ok: true }; } } };
  const row = d.prepare("SELECT * FROM notification_digests WHERE scope = 'household'").get();
  // Uhrzeit des Laufs: 07:10 Haushaltszeit am naechsten Tag (send_time 07:00).
  const { localToUTC, householdTimeZone } = await import('../server/utils/timezone.js');
  const day = shiftDateKey(todayKey(d), 1);
  const now = new Date(localToUTC(`${day}T07:10:00`, householdTimeZone(d)));
  const first = await processDueDigests({ database: d, now, providers });
  const second = await processDueDigests({ database: d, now: new Date(now.getTime() + 60_000), providers });
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0);
  assert.deepEqual(sent.map((s) => s.channel), JSON.parse(row.channel_ids_json));
  assert.ok(sent[0].payload.title.length > 0);
});
