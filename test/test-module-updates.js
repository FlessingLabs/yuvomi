/**
 * Modul: Update-Pruefung fuer Drittmodule (Migration 277)
 * Zweck: Die taegliche Pruefung findet neuere Fassungen von Modulen aus
 *        GitHub, "Spaeter" blendet genau diesen Stand aus, und Einspielen ist
 *        eine gewoehnliche Ersetzung: neuer Stand, AUSGESCHALTET.
 *
 * Geprueft wird:
 *   - latest(): Release-Installationen folgen dem neuesten Release, Branches
 *     ihrem neuesten Commit; die Version kommt aus module.json dieses Commits
 *   - Befund je Modul, Fehler stehen am Modul, nicht am Lauf
 *   - Spaeter gilt fuer einen Stand, ein neuerer meldet sich wieder
 *   - Einspielen ersetzt, schreibt Ref und Commit, laesst das Modul aus
 *   - von Hand kopierte Module kommen nicht vor; ohne neuen Stand kein Update
 *
 *        Kein Netz: GitHub ist ein Fake. Ausfuehren: npm run test:module-updates
 */
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { tempDir } from './tmp-dir.js';

const TMP_ROOT = tempDir('yuvomi-module-updates-');
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR;
process.env.MODULES_ALLOW_WEB_INSTALL = 'true';

import test from 'node:test';
import assert from 'node:assert/strict';

const dbmod = await import('../server/db.js');
const modulesSvc = await import('../server/services/modules.js');
const install = await import('../server/services/module-install.js');
const github = await import('../server/services/module-github.js');
const updates = await import('../server/services/module-updates.js');
const db = dbmod.get();

function makeZip(files, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(String(content), 'utf8');
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    const chunk = Buffer.concat([local, nameBuf, comp]);
    locals.push(chunk);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const c = Buffer.from(comment, 'latin1');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(c.length, 20);
  return Buffer.concat([...locals, cd, eocd, c]);
}

const moduleZip = (id, version, commit) => makeZip({
  'r-main/module/module.json': JSON.stringify({ id, name: `Mod ${id}`, version, entry: 'index.js' }),
  'r-main/module/index.js': `export default '${version}';\n`,
}, { comment: commit });

const SHA = (c) => c.repeat(40);

async function installFromGithub(id, version, commit, { ref = 'main' } = {}) {
  const { files } = install.unpackArchive(moduleZip(id, version, commit));
  return install.withInstallLock(() => install.installFilesUnlocked(files, {
    source: 'github', overwrite: true, path: 'module', userId: 1,
    meta: { url: 'https://github.com/o/r', ref, commit },
  }));
}

/** Ein GitHub-Fake, dessen neuester Stand sich setzen laesst. */
function fakeInstaller() {
  const state = { version: '1.1.0', commit: SHA('b'), ref: 'main', fail: null, fetched: [] };
  return {
    state,
    async latest() {
      if (state.fail) throw new install.InstallError('repo_not_found', state.fail);
      return { ref: state.ref, commit: state.commit, version: state.version, track: 'ref' };
    },
    async fetchArchive(url, { ref, path: p }) {
      state.fetched.push({ url, ref, path: p });
      return { buffer: moduleZip('upd-mod', state.version, state.commit), url, ref, path: p ?? null };
    },
  };
}

await installFromGithub('upd-mod', '1.0.0', SHA('a'));
// Ein von Hand kopierter Ordner: keine Installationsdatei, keine Quelle.
fs.mkdirSync(path.join(MODULES_DIR, 'hand-mod'), { recursive: true });
fs.writeFileSync(path.join(MODULES_DIR, 'hand-mod', 'module.json'), JSON.stringify({ id: 'hand-mod', name: 'Hand', version: '1.0.0', entry: 'index.js' }));
fs.writeFileSync(path.join(MODULES_DIR, 'hand-mod', 'index.js'), 'export default 1;\n');

const fake = fakeInstaller();

test('Pruefung: ein neuerer Commit ist ein Update, mit Version aus module.json', async () => {
  const list = await updates.checkModuleUpdates({ installer: fake });
  assert.deepEqual(list.map((u) => u.id), ['upd-mod'], 'von Hand kopierte Module haben keine Quelle');
  const [u] = list;
  assert.equal(u.installedVersion, '1.0.0');
  assert.equal(u.latestVersion, '1.1.0');
  assert.equal(u.available, true);
  assert.equal(u.snoozed, false);
});

test('Spaeter: dieser Stand schweigt, ein neuerer meldet sich wieder', async () => {
  assert.equal(updates.snoozeModuleUpdate('upd-mod'), true);
  let [u] = await updates.listModuleUpdates();
  assert.equal(u.available, false);
  assert.equal(u.snoozed, true);
  [u] = await updates.checkModuleUpdates({ installer: fake });
  assert.equal(u.available, false, 'derselbe Stand bleibt still, auch nach erneuter Pruefung');
  fake.state.commit = SHA('c');
  fake.state.version = '1.2.0';
  [u] = await updates.checkModuleUpdates({ installer: fake });
  assert.equal(u.available, true);
  assert.equal(u.latestVersion, '1.2.0');
});

test('ein Fehler steht am Modul und loescht den letzten Befund nicht', async () => {
  fake.state.fail = 'The GitHub repository was not found (or is private).';
  const [u] = await updates.checkModuleUpdates({ installer: fake });
  assert.match(u.error, /not found/);
  assert.equal(u.latestVersion, '1.2.0', 'der letzte bekannte Stand bleibt');
  fake.state.fail = null;
  await updates.checkModuleUpdates({ installer: fake });
});

test('Einspielen: neuer Stand aus derselben Quelle, AUSGESCHALTET', async () => {
  const result = await updates.applyModuleUpdate('upd-mod', { userId: 1, installer: fake });
  assert.equal(result.replaced, true);
  assert.deepEqual(fake.state.fetched.at(-1), { url: 'https://github.com/o/r', ref: 'main', path: 'module' });
  const listed = (await modulesSvc.listModules({ admin: true })).find((m) => m.id === 'upd-mod');
  assert.equal(listed.version, '1.2.0');
  assert.equal(listed.install.commit, SHA('c'));
  assert.equal(listed.install.approved, false, 'jede Ersetzung kommt ausgeschaltet an');
  assert.equal(listed.enabled, false);
  const [u] = await updates.listModuleUpdates();
  assert.equal(u.available, false);
  await assert.rejects(() => updates.applyModuleUpdate('upd-mod', { userId: 1, installer: fake }), (err) => err.reason === 'up_to_date');
  await assert.rejects(() => updates.applyModuleUpdate('hand-mod', { userId: 1, installer: fake }), (err) => err.reason === 'not_found');
});

test('geloeschtes Modul: der Befund geht mit', async () => {
  await installFromGithub('gone-mod', '1.0.0', SHA('d'));
  const gone = { ...fakeInstaller(), latest: async () => ({ ref: 'main', commit: SHA('e'), version: '2.0.0', track: 'ref' }) };
  await updates.checkModuleUpdates({ installer: gone });
  assert.ok(db.prepare("SELECT 1 FROM module_update_state WHERE module_id = 'gone-mod'").get());
  await install.deleteModule('gone-mod', { userId: 1 });
  await updates.checkModuleUpdates({ installer: fake });
  assert.equal(db.prepare("SELECT 1 FROM module_update_state WHERE module_id = 'gone-mod'").get(), undefined);
});

// ── latest() gegen einen GitHub-Fake ────────────────────────────────────────
function fakeResponse(status, { json, body } = {}) {
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : (body ?? Buffer.alloc(0));
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, body: Readable.from([payload]) };
}
function fakeTransport(routes) {
  const calls = [];
  return {
    calls,
    request: async (url) => {
      calls.push(url);
      const make = routes[url];
      return make ? make() : fakeResponse(404, { json: { message: 'Not Found' } });
    },
  };
}
const API = 'https://api.github.com/repos/o/r';

test('latest(): aus einem Release installiert - es zaehlt das neueste Release', async () => {
  const t = fakeTransport({
    [`${API}/releases/tags/v1.0.0`]: () => fakeResponse(200, { json: { tag_name: 'v1.0.0' } }),
    [`${API}/releases/latest`]: () => fakeResponse(200, { json: { tag_name: 'v1.3.0' } }),
    [`${API}/commits/v1.3.0`]: () => fakeResponse(200, { body: Buffer.from(SHA('f')) }),
    [`${API}/contents/module/module.json?ref=${SHA('f')}`]: () => fakeResponse(200, { body: Buffer.from('{"id":"x","version":"1.3.0"}') }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  assert.deepEqual(await gh.latest({ owner: 'o', repo: 'r', ref: 'v1.0.0', path: 'module' }),
    { ref: 'v1.3.0', commit: SHA('f'), version: '1.3.0', track: 'release' });
});

test('latest(): aus einem Branch installiert - es zaehlt sein neuester Commit', async () => {
  const t = fakeTransport({
    [`${API}/commits/main`]: () => fakeResponse(200, { body: Buffer.from(`${SHA('1')}\n`) }),
    [`${API}/contents/module.json?ref=${SHA('1')}`]: () => fakeResponse(200, { body: Buffer.from('kaputt') }),
  });
  const gh = github.createGithubInstaller({ request: t.request });
  assert.deepEqual(await gh.latest({ owner: 'o', repo: 'r', ref: 'main' }),
    { ref: 'main', commit: SHA('1'), version: null, track: 'ref' }, 'eine unlesbare module.json kostet nur die Versionsnummer');
  assert.ok(t.calls.includes(`${API}/releases/tags/main`), 'erst gefragt, ob main ein Release ist');
});

test('latest(): ein verschwundener Branch ist ein Fehler, kein "aktuell"', async () => {
  const gh = github.createGithubInstaller({ request: fakeTransport({}).request });
  await assert.rejects(() => gh.latest({ owner: 'o', repo: 'r', ref: 'weg' }), (err) => err.reason === 'ref_not_found');
});
