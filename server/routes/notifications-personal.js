/**
 * Modul: Persoenliche Benachrichtigungs-Routen
 * Zweck: Die eigenen Ziele (Kanaele mit scope 'user') und die eigene
 *        Tagesvorschau der angemeldeten Person.
 * Abhaengigkeiten: express, notification-channels.js, notification-personal.js,
 *        notification-digest.js
 *
 * Haengt VOR dem Admin-Router unter /api/v1/notifications (server/index.js):
 * der traegt requireAdmin auf allem, und diese Routen gehoeren jedem Mitglied.
 *
 * NUR DIE EIGENEN. Besitzer und Reichweite kommen nie aus dem Body, sondern aus
 * der Sitzung: ein Kanal, den diese Routen anlegen, ist immer `scope = 'user'`
 * der angemeldeten Person, und ein fremder Kanal existiert hier nicht (404).
 * Anlegen, Aendern, Testen und die Vorschau brauchen die Freigabe eines Admins
 * (notification-personal.js); Loeschen und Lesen gehen immer - wer die
 * Freigabe verliert, soll seine Daten trotzdem sehen und entfernen koennen.
 */
import express from 'express';
import * as db from '../db.js';
import { createLogger } from '../logger.js';
import { createNotificationChannelStore } from '../services/notification-channels.js';
import { notificationService as defaultNotificationService } from '../services/notifications.js';
import {
  DIGEST_SECTIONS, PersonalNotificationError, getDigest, personalAllowed, saveDigest,
} from '../services/notification-personal.js';
import { sendDigestNow } from '../services/notification-digest.js';

const log = createLogger('PersonalNotifications');
// Genug fuer Telegram, Discord und ein, zwei Reserven - und eine Grenze gegen
// ein Skript, das in einer Schleife Kanaele anlegt.
export const MAX_PERSONAL_CHANNELS = 10;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function personalChannelInput(body, userId) {
  const { provider, name, enabled, config, secrets, clearSecrets } = body || {};
  return { provider, name, enabled, config, secrets, clearSecrets, scope: 'user', userId };
}

export function buildRouter({ database, channelStore, notificationService = defaultNotificationService } = {}) {
  const getDb = () => (database || db.get());
  const store = () => channelStore || createNotificationChannelStore({ db: getDb() });
  const router = express.Router();

  const me = (req) => req.authUserId ?? req.session?.userId;
  const notAllowed = (res) => res.status(403).json({
    error: 'An admin has not enabled personal notification targets for you.', code: 403, reason: 'notification_personal_not_allowed',
  });
  const own = (req, id) => {
    const channel = store().getChannel(id, { includeSecrets: true });
    return channel && channel.scope === 'user' && channel.userId === me(req) ? channel : null;
  };
  const fail = (res, err) => {
    if (err instanceof PersonalNotificationError) return res.status(400).json({ error: err.message, code: 400, reason: err.reason });
    return res.status(400).json({ error: err?.message || 'Invalid input.', code: 400 });
  };

  router.get('/', (req, res) => {
    try {
      const userId = me(req);
      res.json({
        data: {
          allowed: personalAllowed(getDb(), userId),
          channels: store().listUserChannels(userId),
          digest: getDigest(getDb(), { scope: 'user', userId }),
          sections: DIGEST_SECTIONS,
          maxChannels: MAX_PERSONAL_CHANNELS,
        },
      });
    } catch (err) {
      log.error('Error reading personal notifications:', err.message);
      res.status(500).json({ error: 'Internal error.', code: 500 });
    }
  });

  router.post('/channels', (req, res) => {
    const userId = me(req);
    if (!personalAllowed(getDb(), userId)) return notAllowed(res);
    try {
      if (store().listUserChannels(userId).length >= MAX_PERSONAL_CHANNELS) {
        return res.status(409).json({ error: 'Too many personal channels.', code: 409, reason: 'notification_personal_limit' });
      }
      const channel = store().createChannel(personalChannelInput(req.body, userId));
      res.status(201).json({ data: channel });
    } catch (err) {
      fail(res, err);
    }
  });

  router.put('/channels/:id', (req, res) => {
    const userId = me(req);
    const id = parseId(req.params.id);
    if (!id || !own(req, id)) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    if (!personalAllowed(getDb(), userId)) return notAllowed(res);
    try {
      res.json({ data: store().updateChannel(id, personalChannelInput(req.body, userId)) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.delete('/channels/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id || !own(req, id)) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    store().deleteChannel(id);
    res.json({ data: { deleted: true } });
  });

  router.post('/channels/:id/test', async (req, res) => {
    const id = parseId(req.params.id);
    const channel = id ? own(req, id) : null;
    if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    if (!personalAllowed(getDb(), me(req))) return notAllowed(res);
    try {
      const result = await notificationService.testChannel({
        channel,
        payload: { title: 'Yuvomi', body: 'Yuvomi notification test', url: '/settings/personal/messenger', tag: `notification-channel-test-${id}`, priority: 'default' },
      });
      store().markChannelTestResult(id, { ok: true });
      res.json({ data: result });
    } catch (err) {
      store().markChannelTestResult(id, { ok: false, error: err.message });
      res.status(502).json({ error: err.message || 'Test failed.', code: 502, reason: 'notification_test_failed' });
    }
  });

  router.put('/digest', (req, res) => {
    const userId = me(req);
    if (!personalAllowed(getDb(), userId)) return notAllowed(res);
    try {
      res.json({ data: saveDigest(getDb(), { scope: 'user', userId }, req.body || {}) });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/digest/test', async (req, res) => {
    const userId = me(req);
    if (!personalAllowed(getDb(), userId)) return notAllowed(res);
    const id = parseId(req.body?.channelId);
    const channel = id ? own(req, id) : null;
    if (!channel) return res.status(404).json({ error: 'Notification channel not found.', code: 404 });
    try {
      const digest = await sendDigestNow(getDb(), {
        scope: 'user', userId, digest: getDigest(getDb(), { scope: 'user', userId }), channel, providers: notificationService.providers,
      });
      res.json({ data: { title: digest.title, body: digest.body } });
    } catch (err) {
      res.status(502).json({ error: err.message || 'Test failed.', code: 502, reason: 'notification_test_failed' });
    }
  });

  return router;
}

export default buildRouter();
