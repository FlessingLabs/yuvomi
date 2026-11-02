/**
 * Generic JSON webhook notification provider.
 *
 * Ohne Vorlage sendet der Kanal einen Yuvomi-geformten Body. Der passt fuer
 * Empfaenger, die beliebiges JSON annehmen (Home Assistant, n8n), aber nicht
 * fuer Dienste mit eigenem Pflichtschema: ein Discord-Webhook verlangt `content`
 * oder `embeds` und antwortet auf alles andere mit 400. Statt pro Dienst einen
 * Adapter zu bauen, formt eine Vorlage den Body - damit bleibt EIN generischer
 * Anbieter fuer Discord, Slack und alles Weitere zustaendig (#692, #660).
 */

import { guardedFetch } from './guarded-fetch.js';

export const WEBHOOK_TEMPLATE_PLACEHOLDERS = Object.freeze(['title', 'body', 'url', 'tag']);

/**
 * DAS GEHEIMNIS IM PFAD. Manche Dienste tragen ihren Schluessel nicht im Header,
 * sondern in der Adresse: Telegram (`/bot<token>/sendMessage`), Discord
 * (`/api/webhooks/<id>/<token>`). Stuende er im Klartext in `baseUrl`, laege er
 * in `config_json` und kaeme mit jeder Kanalliste zurueck. Stattdessen steht in
 * der Adresse der Platzhalter, und der Wert liegt write-only in `secrets.token`
 * - eingesetzt erst beim Senden. Dann geht der Token NICHT zusaetzlich als
 * Bearer-Header mit: er hat seinen Ort schon.
 */
export const WEBHOOK_URL_TOKEN = '{{token}}';
// Was in einem Pfadsegment stehen darf, ohne Abfrage, Fragment oder Host zu
// aendern. Der Schraegstrich ist erlaubt (Discord: "<id>/<token>"), ".." nicht.
const URL_TOKEN_PATTERN = /^[A-Za-z0-9:_\-/.]+$/;

export function urlTokenValid(token) {
  const value = String(token ?? '');
  return value.length > 0 && value.length <= 256 && URL_TOKEN_PATTERN.test(value) && !value.includes('..');
}

/** Die Zieladresse mit eingesetztem Token; wirft, wenn der Token fehlt oder nicht passt. */
export function resolveWebhookUrl(config = {}, secrets = {}) {
  const base = String(config?.baseUrl ?? '');
  if (!base.includes(WEBHOOK_URL_TOKEN)) return base;
  const token = String(secrets?.token ?? '');
  if (!urlTokenValid(token)) throw new Error('Webhook token is missing or invalid.');
  return base.replace(WEBHOOK_URL_TOKEN, token);
}

/**
 * Kuerzt einen Text auf `max` Zeichen (Telegram nimmt 4096, Discord 2000 -
 * eine Tagesvorschau kann laenger werden). Gekuerzt wird VOR dem Einsetzen,
 * am Zeilenende, mit einem Auslassungszeichen: ein abgelehnter Versand ist
 * schlechter als ein gekuerzter.
 */
export function clampText(text, max) {
  const value = String(text ?? '');
  if (!Number.isInteger(max) || max <= 0 || value.length <= max) return value;
  const cut = value.slice(0, max - 1);
  const nl = cut.lastIndexOf('\n');
  return `${nl > max / 2 ? cut.slice(0, nl) : cut}…`;
}

// ZWEI Muster, absichtlich verschieden weit: ersetzt wird nur, was wir fuellen
// koennen, geprueft wird ALLES, was wie ein Platzhalter aussieht. Mit einem
// gemeinsamen `\w+` war `{{task-title}}` fuer beide unsichtbar - die Pruefung
// meldete nichts und die Zustellung schickte den Token woertlich mit, obwohl
// beim Speichern zugesagt wird, Unbekanntes abzulehnen.
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;
const PLACEHOLDER_SHAPED_PATTERN = /\{\{([^{}]*)\}\}/g;

/**
 * Setzt die Platzhalter einer Vorlage JSON-sicher ein.
 *
 * Der Wert wird als JSON-String kodiert und OHNE die aeusseren Anfuehrungszeichen
 * eingesetzt, weil die in der Vorlage stehen: `{"content": "{{title}}"}`. Ein
 * Titel mit Anfuehrungszeichen, Backslash oder Zeilenumbruch zerrisse sonst das
 * JSON des Nutzers - und zwar erst bei der Zustellung, nicht beim Speichern.
 */
export function renderPayloadTemplate(template, payload = {}) {
  return String(template).replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!WEBHOOK_TEMPLATE_PLACEHOLDERS.includes(key)) return match;
    const value = payload?.[key];
    if (value === null || value === undefined) return '';
    return JSON.stringify(String(value)).slice(1, -1);
  });
}

/**
 * Platzhalter, die die Vorlage benutzt, aber niemand fuellen kann.
 *
 * Prueft gegen das WEITE Muster: ein Tippfehler mit Bindestrich, Punkt oder
 * Leerzeichen (`{{task-title}}`, `{{ title }}`) ist genau der Fall, den der
 * Nutzer gemeldet bekommen muss - er wuerde sonst unersetzt im Body landen.
 */
export function unknownTemplatePlaceholders(template) {
  const unknown = new Set();
  for (const [, key] of String(template).matchAll(PLACEHOLDER_SHAPED_PATTERN)) {
    if (!WEBHOOK_TEMPLATE_PLACEHOLDERS.includes(key)) unknown.add(key);
  }
  return [...unknown];
}

function httpError(status) {
  if (status === 401 || status === 403) return new Error('Webhook authentication failed.');
  if (status === 404) return new Error('Webhook endpoint was not found.');
  return new Error(`Webhook returned HTTP ${status}`);
}

export const webhookProvider = {
  id: 'webhook',

  async send({ channel, payload, fetchImpl = guardedFetch, signal } = {}) {
    const headers = { 'content-type': 'application/json' };
    const token = String(channel?.secrets?.token ?? '');
    const tokenInUrl = String(channel?.config?.baseUrl ?? '').includes(WEBHOOK_URL_TOKEN);
    if (token && !tokenInUrl) headers.authorization = `Bearer ${token}`;
    const url = resolveWebhookUrl(channel?.config, channel?.secrets);

    const max = Number(channel?.config?.maxLength) || 0;
    const fitted = max ? { ...payload, body: clampText(payload.body, Math.max(1, max - String(payload.title ?? '').length - 8)) } : payload;
    const template = String(channel?.config?.payloadTemplate ?? '').trim();
    const body = template
      ? renderPayloadTemplate(template, fitted)
      : JSON.stringify({
        event: 'notification',
        notification: payload,
        sentAt: new Date().toISOString(),
      });

    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal,
    });
    if (!response.ok) throw httpError(response.status);
    return { ok: true, status: response.status };
  },
};

export default webhookProvider;
