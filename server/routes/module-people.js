/**
 * Modul: Modulspeicher - Personen (Migration 275)
 * Zweck: GET /api/v1/modules/:moduleId/people - die Haushaltsmitglieder, deren
 *        personenbezogene Datensaetze der Anfragende in diesem Modul lesen darf,
 *        mit Anzeigename, Farbe und Recht (`read` | `write`). Ein Modul braucht
 *        so keine eigene Personenverwaltung; Name und Id kommen aus Yuvomi.
 *        Die Regel steht in services/module-people.js.
 */
import express from 'express';
import * as db from '../db.js';
import { listModules } from '../services/modules.js';
import { listPeople } from '../services/module-people.js';
import { moduleIdGate, moduleAccessGate } from './module-records.js';

export function createModulePeopleRouter({ database = () => db.get(), modules = listModules } = {}) {
  const router = express.Router({ mergeParams: true });
  router.use(moduleIdGate);
  router.use(moduleAccessGate({ modules }));
  router.get('/', (req, res) => {
    res.json({ data: listPeople(database(), req, req.params.moduleId) });
  });
  return router;
}

export default createModulePeopleRouter();
