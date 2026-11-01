/**
 * Modul: Modulspeicher - Uebersicht fuer Administratoren
 * Zweck: GET /api/v1/modules/storage - welches Modul wie viel gespeichert hat,
 *        auch abgeschaltete und entfernte (deren Daten bleiben, bis ein Admin
 *        sie mit DELETE /api/v1/modules/:moduleId/records loescht).
 */
import express from 'express';
import * as db from '../db.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createRecordStore } from '../services/module-records.js';

export function createModuleStorageOverviewRouter({ database = () => db.get() } = {}) {
  const router = express.Router();
  router.get('/', (req, res) => {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403, reason: 'module_access_denied' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ data: createRecordStore(database()).usageByModule() });
  });
  return router;
}


export default createModuleStorageOverviewRouter();
