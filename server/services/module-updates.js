/**
 * Modul: Update-Pruefung fuer Drittmodule
 * Zweck: Einmal am Tag (und auf Knopfdruck) fuer jedes Modul, das aus Settings
 *        von GitHub installiert wurde, nachsehen, ob es eine neuere Fassung
 *        gibt - und sie auf Wunsch eines Admins einspielen.
 * Abhaengigkeiten: modules.js (Liste mit Installationsdatei), module-github.js
 *        (neueste Fassung, Download), module-install.js (Ersetzen), Migration 277
 *
 * NICHTS AKTUALISIERT SICH SELBST. Die Pruefung schreibt nur einen Befund
 * (module_update_state). Einspielen ist eine Handlung eines Admins aus einer
 * Browser-Sitzung, und das Ergebnis ist eine gewoehnliche Ersetzung: sie kommt
 * AUSGESCHALTET an und will erneut freigegeben werden - ein Branch ist kein
 * Beleg, dass derselbe Code kam (MODULES.md, "Every replacement arrives
 * disabled"). "Spaeter" blendet genau den gefundenen Stand aus; ein neuerer
 * meldet sich wieder.
 *
 * Von Hand kopierte Module (ohne Installationsdatei) und ZIP-Uploads haben
 * keine Quelle, die sich fragen liesse - sie kommen hier nicht vor.
 */
import * as dbModule from '../db.js';
import { createLogger } from '../logger.js';
import { listModules } from './modules.js';
import { createGithubInstaller, parseGithubUrl } from './module-github.js';
import { installFilesUnlocked, unpackArchive, withInstallLock, InstallError } from './module-install.js';
import { runExternalJob } from '../utils/restore-state.js';

const log = createLogger('ModuleUpdates');
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Kurz nach dem Start, nicht sofort: der Start soll nicht auf GitHub warten.
const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;

const getDb = (database) => database || dbModule.get();

/** Module mit Quelle GitHub, wie die Admin-Liste sie kennt. */
async function githubModules() {
  const modules = await listModules({ admin: true });
  return modules.filter((m) => m.install?.source === 'github' && m.install.url && m.install.ref);
}

function saveState(d, id, state) {
  d.prepare(`
    INSERT INTO module_update_state (module_id, checked_at, latest_ref, latest_commit, latest_version, error)
    VALUES (@id, @checkedAt, @ref, @commit, @version, @error)
    ON CONFLICT(module_id) DO UPDATE SET
      checked_at = excluded.checked_at,
      latest_ref = COALESCE(excluded.latest_ref, latest_ref),
      latest_commit = COALESCE(excluded.latest_commit, latest_commit),
      latest_version = COALESCE(excluded.latest_version, latest_version),
      error = excluded.error
  `).run({ id, checkedAt: state.checkedAt, ref: state.ref ?? null, commit: state.commit ?? null, version: state.version ?? null, error: state.error ?? null });
}

/**
 * Prueft alle Module aus GitHub. Ein Fehler bei einem Modul (Repository weg,
 * GitHub-Bremse) steht an diesem Modul und haelt die anderen nicht auf.
 */
export async function checkModuleUpdates({ database, installer = createGithubInstaller(), now = new Date() } = {}) {
  const d = getDb(database);
  const checkedAt = now.toISOString();
  const modules = await githubModules();
  for (const m of modules) {
    try {
      const { owner, repo } = parseGithubUrl(m.install.url);
      const found = await installer.latest({ owner, repo, ref: m.install.ref, path: m.install.path ?? null });
      saveState(d, m.id, { checkedAt, ...found, error: null });
    } catch (err) {
      log.warn(`Update check for ${m.id} failed:`, err?.message || err);
      saveState(d, m.id, { checkedAt, error: err instanceof InstallError ? err.message : 'The update check failed.' });
    }
  }
  // Was nicht mehr installiert ist, hat auch keinen Befund mehr.
  const ids = new Set(modules.map((m) => m.id));
  for (const row of d.prepare('SELECT module_id FROM module_update_state').all()) {
    if (!ids.has(row.module_id)) d.prepare('DELETE FROM module_update_state WHERE module_id = ?').run(row.module_id);
  }
  return listModuleUpdates({ database: d });
}

/**
 * Je Modul aus GitHub: installierter und gefundener Stand. `available` heisst:
 * ein anderer Commit als der installierte, und nicht auf "Spaeter" gesetzt.
 */
export async function listModuleUpdates({ database } = {}) {
  const d = getDb(database);
  const rows = new Map(d.prepare('SELECT * FROM module_update_state').all().map((r) => [r.module_id, r]));
  return (await githubModules()).map((m) => {
    const r = rows.get(m.id);
    const newer = Boolean(r?.latest_commit) && r.latest_commit !== m.install.commit
      // Ohne bekannten installierten Commit (alte Installationsdatei) zaehlt die Version.
      && (m.install.commit || (r.latest_version && r.latest_version !== m.version));
    return {
      id: m.id,
      name: m.name,
      installedVersion: m.version || null,
      installedRef: m.install.ref,
      installedCommit: m.install.commit ?? null,
      latestVersion: r?.latest_version ?? null,
      latestRef: r?.latest_ref ?? null,
      latestCommit: r?.latest_commit ?? null,
      checkedAt: r?.checked_at ?? null,
      error: r?.error ?? null,
      snoozed: Boolean(newer && r.snoozed_commit === r.latest_commit),
      available: Boolean(newer && r.snoozed_commit !== r.latest_commit),
    };
  });
}

/** "Spaeter": diesen gefundenen Stand nicht mehr melden. */
export function snoozeModuleUpdate(id, { database } = {}) {
  const d = getDb(database);
  const result = d.prepare('UPDATE module_update_state SET snoozed_commit = latest_commit WHERE module_id = ? AND latest_commit IS NOT NULL').run(id);
  return result.changes > 0;
}

/**
 * Spielt den gefundenen Stand ein - dieselbe Ersetzung wie "Eigenes Modul
 * hinzufuegen" mit Ueberschreiben, aus derselben Quelle und demselben Ordner,
 * nur mit dem neuen Ref. Das Modul kommt ausgeschaltet an.
 */
export async function applyModuleUpdate(id, { userId, database, installer = createGithubInstaller() } = {}) {
  const d = getDb(database);
  const updates = await listModuleUpdates({ database: d });
  const target = updates.find((u) => u.id === id);
  if (!target) throw new InstallError('not_found', 'This module was not installed from GitHub, so there is nothing to update.');
  if (!target.latestCommit || target.latestCommit === target.installedCommit) {
    throw new InstallError('up_to_date', 'This module is already up to date.');
  }
  const module = (await githubModules()).find((m) => m.id === id);
  return withInstallLock(async () => {
    const gh = await installer.fetchArchive(module.install.url, { ref: target.latestRef, path: module.install.path ?? undefined });
    const { files, comment } = unpackArchive(gh.buffer);
    const commit = /^[0-9a-f]{40}$/i.test(comment.trim()) ? comment.trim().toLowerCase() : null;
    const result = await installFilesUnlocked(files, {
      source: 'github',
      overwrite: true,
      path: gh.path ?? undefined,
      userId,
      meta: { url: gh.url, ref: gh.ref, commit },
    });
    // Ein anderes Modul unter derselben Adresse waere kein Update, sondern ein Tausch.
    if (result?.module?.id && result.module.id !== id) log.warn(`Update of ${id} installed ${result.module.id}`);
    d.prepare('UPDATE module_update_state SET snoozed_commit = NULL WHERE module_id = ?').run(id);
    return result;
  });
}

let timer = null;

/** Taeglich pruefen, das erste Mal kurz nach dem Start. */
export function startModuleUpdateScheduler() {
  // Als Job: waehrend einer Wiederherstellung beginnt keine Pruefung, eine
  // laufende wird abgewartet (#1532) - sie schreibt module_update_state.
  const run = () => runExternalJob(() => checkModuleUpdates())
    .catch((err) => log.error('Module update check failed:', err?.message || err));
  setTimeout(run, FIRST_CHECK_DELAY_MS).unref();
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref();
  log.info('Module update check active (daily).');
}
