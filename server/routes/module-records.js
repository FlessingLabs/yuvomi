/**
 * Modul: Modulspeicher - REST-Routen
 * Zweck: /api/v1/modules/:moduleId/records - Datensaetze eines installierten,
 *        eingeschalteten Drittanbieter-Moduls lesen und schreiben.
 * Abhaengigkeiten: services/module-records.js, services/modules.js, permissions.js
 *
 * WER HIER HINEINKOMMT, IST SCHON DURCH ALLE GATES IN server/index.js: Anmeldung,
 * Ausgaben-Gast, Token-Scopes (server/scopes.js ordnet diese Pfade `ext:<id>` zu),
 * Mitgliederrechte und CSRF. Die Route fragt trotzdem selbst nach
 * `mayReadModule`/`mayWriteModule`: der Pfad-Guard laesst einen Pfad ohne
 * bekannten Modul-Schluessel durch (eine Deny-Liste), und ein abgeschaltetes
 * Modul HAT keinen Schluessel mehr. Die zweite Frage kostet nichts und haengt
 * nicht davon ab, dass die erste richtig gestellt wurde.
 *
 * NUR EINGESCHALTETE MODULE MIT `capabilities.permissions.module`. Ohne
 * Rechte-Modul gaebe es kein `ext:<id>`, an dem ein Admin den Zugriff regeln
 * koennte. Ein abgeschaltetes, fehlerhaftes oder entferntes Modul bekommt 404
 * `module_storage_unavailable` - seine Daten bleiben trotzdem liegen.
 *
 * EIN DISPLAY BLEIBT DRAUSSEN. Ein Wandtablett zeigt Kernmodule; die Seite
 * eines Drittanbieter-Moduls laeuft dort nicht, und seine Daten braucht es nicht.
 *
 * ENDGUELTIG LOESCHEN (`DELETE .../records`, ohne Datensatz-Id) ist Sache eines
 * Administrators, nur aus einer Browser-Sitzung und mit `confirm: <moduleId>`
 * im Koerper. Es wirkt auch fuer abgeschaltete und entfernte Module - genau fuer
 * die ist es da.
 */
import express from 'express';
import * as db from '../db.js';
import { listModules } from '../services/modules.js';
import { MODULE_ID_RE } from '../services/module-capabilities.js';
import { mayReadModule, mayWriteModule } from '../permissions.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createRecordStore, PAGE_DEFAULT } from '../services/module-records.js';
import { RESERVED_MODULE_SEGMENTS } from '../scopes.js';

function sendError(res, err) {
  return res.status(err.status).json({ error: err.message, code: err.status, reason: err.reason });
}

export function createModuleRecordsRouter({ database = () => db.get(), modules = listModules } = {}) {
  const router = express.Router({ mergeParams: true });
  const store = () => createRecordStore(database());

  router.use((req, res, next) => {
    if (RESERVED_MODULE_SEGMENTS.has(req.params.moduleId)) return next('router');
    res.setHeader('Cache-Control', 'no-store');
    if (!MODULE_ID_RE.test(req.params.moduleId)) {
      return res.status(404).json({ error: 'Module storage unavailable.', code: 404, reason: 'module_storage_unavailable' });
    }
    return next();
  });

  // Endgueltig loeschen: vor dem Modul-Gate, weil es gerade fuer abgeschaltete
  // und entfernte Module gebraucht wird.
  router.delete('/', (req, res) => {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'module_access_denied' });
    }
    if (req.authMethod !== 'session') {
      return res.status(403).json({ error: 'Deleting module data is only possible from a signed-in browser session, not with an API token.', code: 403, reason: 'module_session_required' });
    }
    if (req.body?.confirm !== req.params.moduleId) {
      return res.status(400).json({ error: 'Send { "confirm": "<moduleId>" } to delete all records of this module.', code: 400, reason: 'module_purge_confirm_required' });
    }
    const deleted = store().purge(req.params.moduleId);
    return res.json({ data: { module_id: req.params.moduleId, deleted } });
  });

  router.use(async (req, res, next) => {
    try {
      const id = req.params.moduleId;
      const available = (await modules()).some((m) => m.id === id
        && m.enabled && m.status === 'enabled' && m.capabilities?.permissionModule);
      if (!available) {
        return res.status(404).json({ error: 'Module storage unavailable.', code: 404, reason: 'module_storage_unavailable' });
      }
      const key = `ext:${id}`;
      const read = ['GET', 'HEAD'].includes(req.method);
      const allowed = read ? mayReadModule(req, key) : mayWriteModule(req, key);
      if (!allowed || req.authMethod === 'display') {
        return res.status(403).json({ error: 'Module access denied.', code: 403, reason: 'module_access_denied' });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  });

  function action(fn) {
    return (req, res, next) => {
      try {
        return fn(req, res);
      } catch (err) {
        if (err?.status && err.reason) return sendError(res, err);
        return next(err);
      }
    };
  }

  router.get('/', action((req, res) => {
    const limit = req.query.limit === undefined ? PAGE_DEFAULT : Number(req.query.limit);
    const after = typeof req.query.after === 'string' ? req.query.after : '';
    res.json(store().list(req.params.moduleId, { after, limit }));
  }));

  router.post('/', action((req, res) => {
    res.status(201).json({ data: store().create(req.params.moduleId, req.body?.data) });
  }));

  router.get('/:recordId', action((req, res) => {
    res.json({ data: store().get(req.params.moduleId, req.params.recordId) });
  }));

  router.put('/:recordId', action((req, res) => {
    res.json({ data: store().replace(req.params.moduleId, req.params.recordId, req.body?.data, req.body?.revision) });
  }));

  // Die Revision darf auch in der Query stehen: nicht jeder Client schickt bei
  // DELETE einen Koerper mit.
  router.delete('/:recordId', action((req, res) => {
    const revision = req.body?.revision ?? req.query.revision;
    res.json({ data: store().remove(req.params.moduleId, req.params.recordId, revision) });
  }));

  return router;
}

export default createModuleRecordsRouter();
