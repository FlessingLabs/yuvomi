/**
 * Modul: Notification-Routen (Admin)
 * Zweck: Notification-Channels verwalten und Testbenachrichtigungen senden.
 * Abhaengigkeiten: express, notification-channels.js, notifications.js
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { isAdminRequest } from '../middleware/require-admin.js';
import { createNotificationChannelStore, NOTIFICATION_PROVIDERS } from '../services/notification-channels.js';
import { notificationService as defaultNotificationService } from '../services/notifications.js';
import {
  DIGEST_SECTIONS, PersonalNotificationError, getDigest, listAccess, saveDigest, setAccess,
} from '../services/notification-personal.js';
import { sendDigestNow } from '../services/notification-digest.js';

const log = createLogger('NotificationRoutes');

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Diese Routen verwalten nur Haushaltskanaele. Ein Kanal mit `scope = 'user'`
// hoert auch die privaten Erinnerungen seiner Person, und vor dem Admin verbirgt
// `private` sie gerade (DECISIONS 1, services/notifications.js). Deshalb kommt
// aus dem Body nur durch, was ein Haushaltskanal braucht: eine Allowlist, damit
// keine Schreibweise von Besitzer oder Reichweite den Store erreicht. Die
// Zustellung an persoenliche Kanaele bleibt davon unberuehrt.
function householdChannelInput(body) {
  const { provider, name, enabled, config, secrets, clearSecrets } = body || {};
  return { provider, name, enabled, config, secrets, clearSecrets };
}

export function buildRouter({
  database,
  channelStore,
  notificationService = defaultNotificationService,
} = {}) {
  const getDb = () => (database || db.get());
  const store = channelStore || createNotificationChannelStore({ db: getDb() });
  const router = express.Router();

  function requireAdmin(req, res, next) {
    if (!isAdminRequest(req)) {
      return res.status(403).json({ error: 'Admin access required.', code: 403 });
    }
    next();
  }

  router.use(requireAdmin);

  router.get('/providers', (req, res) => {
    try {
      void req;
      // `available` heisst „der Server kennt diesen Adapter", nicht „er kann
      // senden". Ein Provider, der eine Voraussetzung ausserhalb seines Kanals
      // hat - Mail braucht den app-weiten SMTP-Zugang -, sagt das ueber
      // `isAvailable()`. Wer keine hat, gilt unveraendert als bereit.
      const available = NOTIFICATION_PROVIDERS
        .filter((provider) => notificationService.providers?.[provider.id])
        .map((provider) => {
          const adapter = notificationService.providers[provider.id];
          if (typeof adapter.isAvailable !== 'function') return provider;
          let ready = false;
          try {
            ready = adapter.isAvailable() === true;
          } catch (err) {
            log.warn(`Provider ${provider.id} availability check failed:`, err.message);
          }
          return { ...provider, ready };
        });
      res.json({ data: available });
    } catch (err) {
      log.error('Error reading notification providers:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  // NUR HAUSHALTSKANAELE. Die persoenlichen gehoeren ihrer Person (wohin
  // gehen deren private Erinnerungen?) - seit Migration 276 legen Mitglieder
  // sie selbst an (routes/notifications-personal.js), und dort bleiben sie.
  router.get('/channels', (req, res) => {
    try {
      void req;
      res.json({ data: store.listChannels().filter((channel) => channel.scope !== 'user') });
    } catch (err) {
      log.error('Error reading notification channels:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/channels', (req, res) => {
    try {
      const channel = store.createChannel(householdChannelInput(req.body));
      res.status(201).json({ data: channel });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Invalid notification channel.', code: 400 });
    }
  });

  router.put('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const existing = store.getChannel(id);
      if (!existing) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      // Neue Daten fuer einen persoenlichen Kanal hiessen: ein Admin bestimmt, wohin
      // die privaten Erinnerungen dieser Person gehen. Loeschen bleibt moeglich.
      if (existing.scope !== 'household') {
        return res.status(409).json({ error: 'Only household notification channels can be changed here.', code: 409 });
      }
      const channel = store.updateChannel(id, householdChannelInput(req.body));
      res.json({ data: channel });
    } catch (err) {
      res.status(400).json({ error: err.message || 'Invalid notification channel.', code: 400 });
    }
  });

  router.delete('/channels/:id', (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const deleted = store.deleteChannel(id);
      if (!deleted) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      res.json({ data: { deleted: true } });
    } catch (err) {
      log.error('Error deleting notification channel:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/channels/:id/test', async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (!id) return res.status(400).json({ error: 'Invalid channel id.', code: 400 });
      const channel = store.getChannel(id, { includeSecrets: true });
      if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
      const payload = {
        title: 'Yuvomi',
        body: 'Yuvomi notification test',
        url: '/settings/personal/notifications',
        tag: `notification-channel-test-${id}`,
        priority: 'default',
      };
      const result = await notificationService.testChannel({ channel, payload });
      store.markChannelTestResult(id, { ok: true });
      res.json({ data: result });
    } catch (err) {
      log.error('Error testing notification channel:', err.message);
      const id = parseId(req.params.id);
      if (id) store.markChannelTestResult(id, { ok: false, error: err.message });
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  // ── Freigabe eigener Ziele je Mitglied (Migration 276) ───────────────────
  router.get('/access', (req, res) => {
    void req;
    res.json({ data: listAccess(getDb()) });
  });

  router.put('/access/:userId', (req, res) => {
    const userId = parseId(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'Invalid member id.', code: 400 });
    try {
      res.json({ data: { user_id: userId, allowed: setAccess(getDb(), userId, Boolean(req.body?.allowed)) } });
    } catch (err) {
      if (err instanceof PersonalNotificationError) return res.status(404).json({ error: err.message, code: 404, reason: err.reason });
      log.error('Error setting notification access:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  // ── Tagesvorschau des Haushalts: nur was jeder sieht, nur in Haushaltskanaele ─
  router.get('/digest', (req, res) => {
    void req;
    res.json({ data: { ...getDigest(getDb(), { scope: 'household' }), sectionsAvailable: DIGEST_SECTIONS } });
  });

  router.put('/digest', (req, res) => {
    try {
      res.json({ data: saveDigest(getDb(), { scope: 'household' }, req.body || {}) });
    } catch (err) {
      if (err instanceof PersonalNotificationError) return res.status(400).json({ error: err.message, code: 400, reason: err.reason });
      res.status(400).json({ error: err.message || 'Invalid input.', code: 400 });
    }
  });

  router.post('/digest/test', async (req, res) => {
    const id = parseId(req.body?.channelId);
    const channel = id ? store.getChannel(id, { includeSecrets: true }) : null;
    if (!channel || channel.scope === 'user') return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    try {
      const digest = await sendDigestNow(getDb(), {
        scope: 'household', digest: getDigest(getDb(), { scope: 'household' }), channel, providers: notificationService.providers,
      });
      res.json({ data: { title: digest.title, body: digest.body } });
    } catch (err) {
      res.status(502).json({ error: err.message || 'Test failed.', code: 502, reason: 'notification_test_failed' });
    }
  });

  return router;
}

export default buildRouter();
