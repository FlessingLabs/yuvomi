/**
 * Modul: Modulspeicher - Freigaben pro Person (Migration 275)
 * Zweck: Wer darf die personenbezogenen Datensaetze einer Person in einem Modul
 *        lesen oder pflegen? Das entscheidet ein Admin, ausdruecklich und pro
 *        Person - nie eine Rolle (DECISIONS.md, Eintrag 1; wie
 *        routes/health/caregivers.js).
 *
 *   GET /api/v1/modules/:moduleId/grants             -> { data: { <subjectId>: [{ user_id, access }] } }
 *   PUT /api/v1/modules/:moduleId/grants/:subjectId  { grants: [{ user_id, access }] } ersetzt die Liste
 */
import express from 'express';
import * as db from '../db.js';
import { listModules } from '../services/modules.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { listGrants, setGrants } from '../services/module-people.js';
import { moduleIdGate, moduleAccessGate } from './module-records.js';

export function createModuleGrantsRouter({ database = () => db.get(), modules = listModules } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(moduleIdGate);
  router.use(moduleAccessGate({ modules }));
  router.use((req, res, next) => {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'module_access_denied' });
    }
    return next();
  });

  router.get('/', (req, res) => {
    res.json({ data: listGrants(database(), req.params.moduleId) });
  });

  router.put('/:subjectId', (req, res, next) => {
    try {
      const subjectId = /^[1-9][0-9]{0,15}$/.test(req.params.subjectId) ? Number(req.params.subjectId) : null;
      if (subjectId === null) {
        return res.status(400).json({ error: 'Invalid person.', code: 400, reason: 'module_person_invalid' });
      }
      const data = setGrants(database(), req.params.moduleId, subjectId, req.body?.grants);
      return res.json({ data });
    } catch (err) {
      if (err?.reason === 'module_person_invalid') {
        return res.status(400).json({ error: err.message, code: 400, reason: 'module_person_invalid' });
      }
      if (err?.reason === 'module_grants_invalid') {
        return res.status(400).json({ error: err.message, code: 400, reason: 'module_grants_invalid' });
      }
      return next(err);
    }
  });

  return router;
}

export default createModuleGrantsRouter();
