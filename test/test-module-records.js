/**
 * Modul: Modulspeicher (module_records, Migration 274)
 * Zweck: Speicher, Routen und alle Gates davor - gegen den ECHTEN Server
 *        (server/index.js), nicht gegen eine nachgebaute Middleware: Anmeldung,
 *        Ausgaben-Gast, Token-Scopes, Mitgliederrechte, CSRF und Display laufen
 *        hier in derselben Reihenfolge wie im Betrieb.
 *
 * Geprueft wird:
 *   - Isolation je Modul, Revisionen (409 statt Ueberschreiben), Seiten
 *   - Limits je Datensatz und je Modul, auch atomar beim Ersetzen
 *   - nur installierte, eingeschaltete Module mit Rechte-Modul
 *   - none/read/write je Mitglied, Token-Scopes, CSRF, Gast, Display
 *   - Abschalten und Entfernen loeschen nichts; endgueltig loescht nur ein
 *     Admin aus einer Browser-Sitzung mit Bestaetigung
 *   - feste Pfade (`/modules/assets/...`) bleiben unberuehrt
 *   - Sicherung und Wiederherstellung
 *
 * Ausfuehren: npm run test:module-records
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { startTestServer, cookieHeader } from './server-ready.js';
import { tempDir } from './tmp-dir.js';

const MODULES_DIR = tempDir('yuvomi-module-records-');

function writeModule(id, { permissions = true } = {}) {
  const dir = path.join(MODULES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = { manifestVersion: 1, id, name: id, version: '1.0.0', entry: 'index.js' };
  if (permissions) manifest.capabilities = { permissions: { module: { label: id } } };
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export function render() {}\n');
}
writeModule('alpha-mod');
writeModule('beta-mod');
writeModule('plain-mod', { permissions: false });
// Ein Modul, das `records` heisst: seine Dateien liegen unter
// /modules/assets/records/... - das darf nie im Speicher landen.
writeModule('records');

const { baseUrl: BASE } = await startTestServer({
  name: 'module-records',
  env: { SESSION_SECRET: 'test-module-records-secret-min-32-chars', MODULES_DIR },
});
const db = await import('../server/db.js');
const { createRecordStore, parseRevision } = await import('../server/services/module-records.js');
const { moduleForPath } = await import('../server/scopes.js');
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');

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

function as(session, { csrf = true } = {}) {
  return async (method, p, body) => {
    const headers = { 'Content-Type': 'application/json', Cookie: session.cookie };
    if (csrf) headers['X-CSRF-Token'] = session.csrfToken;
    const res = await fetch(`${BASE}/api/v1${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function withToken(token) {
  return async (method, p, body) => {
    const res = await fetch(`${BASE}/api/v1${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

function issueToken(name, scopes) {
  const token = `yuvomi_test_records_${name}_${crypto.randomBytes(6).toString('hex')}`;
  db.get().prepare(`
    INSERT INTO api_tokens (name, token_hash, token_prefix, created_by, scopes) VALUES (?, ?, 'yuvomi_test', 1, ?)
  `).run(name, crypto.createHash('sha256').update(token).digest('hex'), scopes === null ? null : JSON.stringify(scopes));
  return withToken(token);
}

const adminSession = await login('admin', 'adminpass123');
const admin = as(adminSession);
// Der Katalog der Erweiterungen (ext:<id>) entsteht beim Lesen der Modulliste.
assert.equal((await admin('GET', '/modules')).status, 200);

async function addMember(username, modules) {
  const created = await admin('POST', '/auth/users', { username, display_name: username, password: `${username}pass123` });
  assert.equal(created.status, 201, `member ${username}`);
  if (modules) {
    const set = await admin('PUT', `/permissions/user/${created.body.user.id}`, { modules });
    assert.equal(set.status, 200, `permissions ${username}: ${JSON.stringify(set.body)}`);
  }
  return { id: created.body.user.id, call: as(await login(username, `${username}pass123`)) };
}

const writer = await addMember('writer');
const reader = await addMember('reader', { 'ext:alpha-mod': 'read' });
const blocked = await addMember('blocked', { 'ext:alpha-mod': 'none' });
const guest = await addMember('guest');
// Fuer die personenbezogenen Datensaetze (Migration 275).
const kid = await addMember('kid');
const parent = await addMember('parent');
const watcher = await addMember('watcher');
const stranger = await addMember('stranger');
db.get().prepare('INSERT INTO split_expense_guest_users (user_id) VALUES (?)').run(guest.id);

const R = '/modules/alpha-mod/records';

// --------------------------------------------------------------------------
// Speicher
// --------------------------------------------------------------------------

test('store: isolation per module, revisions, pages', () => {
  const store = createRecordStore(db.get());
  const a = store.create('unit-a', { name: 'Milch' });
  store.create('unit-b', { name: 'Brot' });
  assert.equal(a.revision, 1);
  assert.match(a.id, /^[0-9a-f-]{36}$/);
  assert.throws(() => store.get('unit-b', a.id), { status: 404, reason: 'record_not_found' });
  assert.throws(() => store.get('unit-a', 'not-a-uuid'), { status: 404 });

  const b = store.replace('unit-a', a.id, { name: 'Vollmilch' }, 1);
  assert.equal(b.revision, 2);
  assert.throws(() => store.replace('unit-a', a.id, { name: 'alt' }, 1), { status: 409, reason: 'record_conflict' });
  assert.throws(() => store.remove('unit-a', a.id, 1), { status: 409 });
  assert.throws(() => store.replace('unit-a', a.id, { name: 'x' }, undefined), { status: 400, reason: 'record_revision_required' });
  assert.equal(store.get('unit-a', a.id).data.name, 'Vollmilch', 'nothing written by refused calls');

  for (let i = 0; i < 4; i++) store.create('unit-a', { i });
  const p1 = store.list('unit-a', { limit: 2 });
  const p2 = store.list('unit-a', { limit: 2, after: p1.next });
  const p3 = store.list('unit-a', { limit: 2, after: p2.next });
  const ids = [...p1.data, ...p2.data, ...p3.data].map((r) => r.id);
  assert.equal(new Set(ids).size, 5);
  assert.equal(p3.next, null);
  assert.throws(() => store.list('unit-a', { limit: 0 }), { reason: 'record_page_invalid' });
  assert.throws(() => store.list('unit-a', { limit: 201 }), { reason: 'record_page_invalid' });
  assert.throws(() => store.list('unit-a', { after: "x' OR 1=1" }), { reason: 'record_page_invalid' });
});

test('store: only JSON objects; limits count UTF-8 bytes', () => {
  const store = createRecordStore(db.get());
  for (const bad of [[], null, 'text', 5, undefined]) {
    assert.throws(() => store.create('unit-shape', bad), { status: 400, reason: 'record_object_required' });
  }
  // 9000 x "ä" sind 18000 Bytes, auch wenn es nur 9000 Zeichen sind.
  assert.throws(() => store.create('unit-shape', { t: 'ä'.repeat(9000) }), { status: 413, reason: 'record_too_large' });
  assert.ok(store.create('unit-shape', { t: 'a'.repeat(16000) }));
});

test('store: quotas hold for create and replace, and refused writes change nothing', () => {
  const small = createRecordStore(db.get(), { recordBytes: 100, records: 2, totalBytes: 40 });
  const a = small.create('unit-quota', { x: 'abc' });
  small.create('unit-quota', {});
  assert.throws(() => small.create('unit-quota', {}), { status: 413, reason: 'module_storage_full' });
  assert.throws(() => small.replace('unit-quota', a.id, { x: 'x'.repeat(40) }, 1), { reason: 'module_storage_full' });
  assert.equal(small.get('unit-quota', a.id).revision, 1);
  small.remove('unit-quota', a.id, 1);
  assert.ok(small.create('unit-quota', {}));
});

test('store: revision parsing accepts only positive whole numbers', () => {
  assert.equal(parseRevision(3), 3);
  assert.equal(parseRevision('3'), 3);
  for (const bad of [0, -1, 1.5, '03', ' 3', '3e0', '0x3', null, undefined, true, [3], {}]) {
    assert.equal(parseRevision(bad), null, String(bad));
  }
});

// --------------------------------------------------------------------------
// HTTP durch alle Gates
// --------------------------------------------------------------------------

test('scope mapping: records belong to ext:<id>; fixed paths do not', () => {
  assert.equal(moduleForPath('/modules/alpha-mod/records'), 'ext:alpha-mod');
  assert.equal(moduleForPath('/MODULES/alpha-mod/RECORDS/x'), 'ext:alpha-mod');
  assert.equal(moduleForPath('/modules/%61lpha-mod/records'), 'ext:alpha-mod');
  assert.equal(moduleForPath('/modules/%zz/records'), null);
  assert.equal(moduleForPath('/modules/unknown-mod/records'), null);
  assert.notEqual(moduleForPath('/modules/assets/records/index.js'), 'ext:records');
});

test('CRUD with revisions; DELETE takes the revision from body or query', async () => {
  assert.equal((await fetch(`${BASE}/api/v1${R}`)).status, 401);

  const made = await admin('POST', R, { data: { name: 'Milch', default_quantity: 2 } });
  assert.equal(made.status, 201);
  const rec = made.body.data;
  assert.equal(rec.revision, 1);

  const listed = await admin('GET', R);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.data.some((r) => r.id === rec.id));
  assert.equal(listed.body.next, null);

  assert.equal((await admin('PUT', `${R}/${rec.id}`, { data: { name: 'x' } })).body.reason, 'record_revision_required');
  const put = await admin('PUT', `${R}/${rec.id}`, { data: { name: 'Vollmilch' }, revision: 1 });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.revision, 2);

  assert.equal((await admin('DELETE', `${R}/${rec.id}?revision=1`)).status, 409);
  assert.equal((await admin('DELETE', `${R}/${rec.id}?revision=2`)).status, 200);
  assert.equal((await admin('GET', `${R}/${rec.id}`)).status, 404);

  const other = await admin('POST', R, { data: { name: 'Brot' } });
  assert.equal((await admin('DELETE', `${R}/${other.body.data.id}`, { revision: 1 })).status, 200);
});

test('two people, one record: the second stale write is refused, not merged', async () => {
  const rec = (await admin('POST', R, { data: { name: 'Eier', default_quantity: 6 } })).body.data;
  // Beide haben Revision 1 gelesen.
  const first = await writer.call('PUT', `${R}/${rec.id}`, { data: { name: 'Eier', default_quantity: 10 }, revision: 1 });
  const second = await admin('PUT', `${R}/${rec.id}`, { data: { name: 'Eier', default_quantity: 12 }, revision: 1 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.reason, 'record_conflict');
  assert.equal((await admin('GET', `${R}/${rec.id}`)).body.data.data.default_quantity, 10);

  // Gleichzeitig abgeschickt: genau einer gewinnt.
  const results = await Promise.all([11, 12, 13, 14].map((n) => writer.call('PUT', `${R}/${rec.id}`, { data: { n }, revision: 2 })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
});

test('member rights: none, read and write', async () => {
  assert.equal((await blocked.call('GET', R)).status, 403);
  assert.equal((await reader.call('GET', R)).status, 200);
  const refused = await reader.call('POST', R, { data: { name: 'x' } });
  assert.equal(refused.status, 403);
  assert.equal((await writer.call('POST', R, { data: { name: 'vom Mitglied' } })).status, 201);
});

test('CSRF is required for session writes', async () => {
  const noCsrf = as(adminSession, { csrf: false });
  assert.equal((await noCsrf('POST', R, { data: {} })).status, 403);
});

test('API tokens: scopes are checked for these dynamic paths', async () => {
  const readTok = issueToken('read', ['ext:alpha-mod:read']);
  const writeTok = issueToken('write', ['ext:alpha-mod:write']);
  const otherTok = issueToken('other', ['shopping:write', 'ext:beta-mod:write']);
  const fullTok = issueToken('full', null);

  assert.equal((await readTok('GET', R)).status, 200);
  assert.equal((await readTok('POST', R, { data: {} })).status, 403);
  assert.equal((await writeTok('POST', R, { data: { via: 'token' } })).status, 201, 'tokens need no CSRF');
  assert.equal((await otherTok('GET', R)).status, 403, 'a scope for another module opens nothing here');
  assert.equal((await otherTok('GET', '/modules/beta-mod/records')).status, 200);
  assert.equal((await fullTok('GET', R)).status, 200, 'an unscoped token follows its user');
  assert.equal((await readTok('GET', '/modules/storage')).status, 403);
});

test('Shared-expenses guests and paired displays get nothing', async () => {
  const g = await guest.call('GET', R);
  assert.equal(g.status, 403);
  assert.equal(g.body.reason, 'split_guest_scope');

  const created = await admin('POST', '/displays', { display_name: 'Kueche' });
  const code = await admin('POST', `/displays/${created.body.data.id}/pairing-code`, {});
  const paired = await fetch(`${BASE}/api/v1/displays/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.body.data.code }),
  });
  const token = decodeURIComponent(String(paired.headers.get('set-cookie')).match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1]);
  const res = await fetch(`${BASE}/api/v1${R}`, { headers: { Cookie: `${DISPLAY_COOKIE}=${token}` } });
  assert.equal(res.status, 403);
});

test('only installed, enabled modules with a permission module have storage', async () => {
  const plain = await admin('GET', '/modules/plain-mod/records');
  assert.equal(plain.status, 404);
  assert.equal(plain.body.reason, 'module_storage_unavailable');
  assert.equal((await admin('GET', '/modules/not-installed/records')).status, 404);
  assert.equal((await admin('GET', '/modules/Bad_Id!/records')).status, 404);
});

test('fixed module paths are not swallowed by the storage route', async () => {
  const res = await fetch(`${BASE}/api/v1/modules/assets/records/index.js`, { headers: { Cookie: adminSession.cookie } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /export function render/);
});

test('too large over HTTP: 413 with a reason', async () => {
  const res = await admin('POST', R, { data: { t: 'x'.repeat(17 * 1024) } });
  assert.equal(res.status, 413);
  assert.equal(res.body.reason, 'record_too_large');
});

test('switching a module off hides its storage but keeps the records', async () => {
  const before = (await admin('GET', R)).body.data.length;
  assert.ok(before > 0);
  const tok = issueToken('off', ['ext:alpha-mod:read']);

  assert.equal((await admin('PATCH', '/modules/alpha-mod', { enabled: false })).status, 200);
  const off = await admin('GET', R);
  assert.equal(off.status, 404);
  assert.equal(off.body.reason, 'module_storage_unavailable');
  assert.equal((await tok('GET', R)).status, 403, 'the scope key is gone while the module is off');
  assert.equal((await admin('POST', R, { data: {} })).status, 404);

  assert.equal((await admin('PATCH', '/modules/alpha-mod', { enabled: true })).status, 200);
  assert.equal((await admin('GET', R)).body.data.length, before);
});

test('removing a module keeps its records; only an explicit admin purge deletes them', async () => {
  const made = await admin('POST', '/modules/beta-mod/records', { data: { keep: true } });
  assert.equal(made.status, 201);
  fs.rmSync(path.join(MODULES_DIR, 'beta-mod'), { recursive: true, force: true });

  assert.equal((await admin('GET', '/modules/beta-mod/records')).status, 404);
  const overview = await admin('GET', '/modules/storage');
  assert.equal(overview.status, 200);
  assert.ok(overview.body.data.some((m) => m.module_id === 'beta-mod' && m.records >= 1));
  assert.equal((await writer.call('GET', '/modules/storage')).status, 403);

  // Wer darf nicht: Mitglied, Token (auch ungescoptes eines Admins), ohne Bestaetigung.
  assert.equal((await writer.call('DELETE', '/modules/beta-mod/records', { confirm: 'beta-mod' })).status, 403);
  const adminToken = issueToken('purge', null);
  const byToken = await adminToken('DELETE', '/modules/beta-mod/records', { confirm: 'beta-mod' });
  assert.equal(byToken.status, 403);
  assert.equal(byToken.body.reason, 'module_session_required');
  const unconfirmed = await admin('DELETE', '/modules/beta-mod/records', {});
  assert.equal(unconfirmed.status, 400);
  assert.equal(unconfirmed.body.reason, 'module_purge_confirm_required');
  assert.equal((await admin('DELETE', '/modules/beta-mod/records', { confirm: 'alpha-mod' })).status, 400);

  const purged = await admin('DELETE', '/modules/beta-mod/records', { confirm: 'beta-mod' });
  assert.equal(purged.status, 200);
  assert.ok(purged.body.data.deleted >= 1);
  assert.ok(!(await admin('GET', '/modules/storage')).body.data.some((m) => m.module_id === 'beta-mod'));
  assert.ok((await admin('GET', R)).body.data.length > 0, 'other modules untouched');
});

// --------------------------------------------------------------------------
// Personenbezogene Datensaetze (Migration 275)
// --------------------------------------------------------------------------

const P = '/modules/alpha-mod';

test('grants: only admins set them, only for active members, never for oneself', async () => {
  assert.equal((await parent.call('PUT', `${P}/grants/${kid.id}`, { grants: [{ user_id: parent.id, access: 'write' }] })).status, 403);
  assert.equal((await admin('PUT', `${P}/grants/${kid.id}`, { grants: [{ user_id: kid.id, access: 'read' }] })).body.reason, 'module_grants_invalid');
  assert.equal((await admin('PUT', `${P}/grants/${kid.id}`, { grants: [{ user_id: parent.id, access: 'admin' }] })).body.reason, 'module_grants_invalid');
  assert.equal((await admin('PUT', `${P}/grants/${guest.id}`, { grants: [] })).body.reason, 'module_person_invalid', 'a Shared-expenses guest is no household member');
  assert.equal((await admin('PUT', `${P}/grants/999999`, { grants: [] })).body.reason, 'module_person_invalid');
  const set = await admin('PUT', `${P}/grants/${kid.id}`, { grants: [{ user_id: parent.id, access: 'write' }, { user_id: watcher.id, access: 'read' }] });
  assert.equal(set.status, 200);
  assert.deepEqual(set.body.data, [{ user_id: parent.id, access: 'write' }, { user_id: watcher.id, access: 'read' }]);
  assert.deepEqual((await admin('GET', `${P}/grants`)).body.data[kid.id], set.body.data);
  assert.equal((await parent.call('GET', `${P}/grants`)).status, 403);
});

test('person records: who may create, read, change', async () => {
  const byParent = await parent.call('POST', `${P}/records`, { subject_id: kid.id, data: { kind: 'plan', label: 'Schuljahr' } });
  assert.equal(byParent.status, 201);
  assert.equal(byParent.body.data.subject_id, kid.id);
  const rec = byParent.body.data;

  assert.equal((await watcher.call('POST', `${P}/records`, { subject_id: kid.id, data: {} })).body.reason, 'module_person_access_denied');
  assert.equal((await kid.call('POST', `${P}/records`, { subject_id: kid.id, data: {} })).status, 403, 'a child reads its own plan but does not change it');
  assert.equal((await stranger.call('POST', `${P}/records`, { subject_id: kid.id, data: {} })).status, 403);
  assert.equal((await parent.call('POST', `${P}/records`, { subject_id: guest.id, data: {} })).body.reason, 'record_subject_invalid');

  for (const who of [kid, watcher, parent]) assert.equal((await who.call('GET', `${P}/records/${rec.id}`)).status, 200);
  const hidden = await stranger.call('GET', `${P}/records/${rec.id}`);
  assert.equal(hidden.status, 404, 'for others the record does not exist');
  assert.equal(hidden.body.reason, 'record_not_found');

  assert.equal((await watcher.call('PUT', `${P}/records/${rec.id}`, { data: { x: 1 }, revision: 1 })).status, 403);
  assert.equal((await kid.call('DELETE', `${P}/records/${rec.id}?revision=1`)).status, 403);
  assert.equal((await stranger.call('PUT', `${P}/records/${rec.id}`, { data: {}, revision: 1 })).status, 404);
  const moved = await parent.call('PUT', `${P}/records/${rec.id}`, { subject_id: watcher.id, data: {}, revision: 1 });
  assert.equal(moved.body.reason, 'record_subject_immutable', 'a plan never moves to another person');
  const ok = await parent.call('PUT', `${P}/records/${rec.id}`, { data: { kind: 'plan', label: 'Schuljahr 2026/27' }, revision: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.subject_id, kid.id);
});

test('person records: lists show only what the viewer may read', async () => {
  const own = await stranger.call('GET', `${P}/records`);
  assert.ok(own.body.data.every((r) => r.subject_id === null), 'stranger sees household records only');
  const kidList = await kid.call('GET', `${P}/records?subject_id=${kid.id}`);
  assert.ok(kidList.body.data.length >= 1 && kidList.body.data.every((r) => r.subject_id === kid.id));
  assert.equal((await stranger.call('GET', `${P}/records?subject_id=${kid.id}`)).body.data.length, 0);
  assert.ok((await admin('GET', `${P}/records?subject_id=${kid.id}`)).body.data.length >= 1);
  assert.ok((await admin('GET', `${P}/records?subject_id=none`)).body.data.every((r) => r.subject_id === null));
  assert.equal((await admin('GET', `${P}/records?subject_id=abc`)).status, 400);
});

test('people: each viewer sees the persons they may read, with their right', async () => {
  const byParent = (await parent.call('GET', `${P}/people`)).body.data;
  assert.deepEqual(byParent.map((p) => [p.user_id, p.access]).sort(), [[kid.id, 'write'], [parent.id, 'read']].sort());
  assert.equal(byParent.find((p) => p.user_id === kid.id).display_name, 'kid');
  assert.deepEqual((await kid.call('GET', `${P}/people`)).body.data.map((p) => [p.user_id, p.access, p.self]), [[kid.id, 'read', true]]);
  assert.ok((await admin('GET', `${P}/people`)).body.data.every((p) => p.access === 'write'));
  assert.ok(!(await admin('GET', `${P}/people`)).body.data.some((p) => p.user_id === guest.id), 'guests are not people of the household');
  assert.equal((await blocked.call('GET', `${P}/people`)).status, 403, 'ext:<id> none still closes everything');
});

test('person paths are scoped to ext:<id> for tokens', async () => {
  assert.equal(moduleForPath('/modules/alpha-mod/people'), 'ext:alpha-mod');
  assert.equal(moduleForPath('/modules/alpha-mod/grants/3'), 'ext:alpha-mod');
  const other = issueToken('people-other', ['shopping:read']);
  assert.equal((await other('GET', `${P}/people`)).status, 403);
});

test('removing a child keeps its plans; removing a parent ends their grants', async () => {
  const before = (await admin('GET', `${P}/records?subject_id=${kid.id}`)).body.data.length;
  const removedKid = await admin('DELETE', `/auth/users/${kid.id}`);
  assert.equal(removedKid.status, 200);
  assert.equal(removedKid.body.outcome, 'deactivated', 'records are a trace: the account is deactivated, not deleted');
  assert.equal((await admin('GET', `${P}/records?subject_id=${kid.id}`)).body.data.length, before);
  assert.ok(!(await admin('GET', `${P}/people`)).body.data.some((p) => p.user_id === kid.id), 'a former member is no longer offered');
  assert.equal((await admin('POST', `${P}/records`, { subject_id: kid.id, data: {} })).body.reason, 'record_subject_invalid');

  const removedParent = await admin('DELETE', `/auth/users/${parent.id}`);
  assert.equal(removedParent.status, 200);
  const grants = (await admin('GET', `${P}/grants`)).body.data[kid.id] ?? [];
  assert.ok(!grants.some((g) => g.user_id === parent.id), 'a former member grants nothing');
});

test('backup and restore carry records, revisions, persons and grants', async () => {
  const store = createRecordStore(db.get());
  const row = store.create('backup-mod', { name: 'Gesichert' });
  const personal = store.create('backup-mod', { name: 'Plan' }, { subjectId: writer.id });
  db.get().prepare("INSERT INTO module_person_grants (module_id, subject_id, grantee_id, access) VALUES ('backup-mod', ?, 1, 'read')").run(writer.id);
  const file = path.join(MODULES_DIR, 'backup.db');
  await db.backupToFile(file);
  db.get().prepare("DELETE FROM module_person_grants WHERE module_id = 'backup-mod'").run();
  store.replace('backup-mod', row.id, { name: 'Danach geaendert' }, 1);
  store.create('backup-mod', { name: 'Danach angelegt' });
  await db.restoreFromFile(file);
  const after = createRecordStore(db.get());
  assert.deepEqual(after.get('backup-mod', row.id), row);
  assert.deepEqual(after.get('backup-mod', personal.id), personal, 'the person of a record survives a restore');
  assert.equal(after.list('backup-mod').data.length, 2);
  const grant = db.get().prepare("SELECT access FROM module_person_grants WHERE module_id = 'backup-mod' AND subject_id = ?").get(writer.id);
  assert.equal(grant?.access, 'read', 'grants are part of the backup');
});

test('the rest of the API is unaffected', async () => {
  assert.equal((await admin('GET', '/modules')).status, 200);
  assert.equal((await admin('GET', '/shopping')).status, 200);
  assert.equal((await admin('GET', '/tasks')).status, 200);
});

