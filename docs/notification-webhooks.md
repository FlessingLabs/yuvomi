# Notification webhooks

Yuvomi can deliver every due reminder to a generic HTTP webhook in addition to
Web Push, Gotify, ntfy, and email. Webhook channels use the same per-channel delivery
tracking, retry, and deduplication flow as the other notification providers.

## Configure a channel

Only administrators can manage household notification channels.

1. Open **Settings → Account → Notifications**.
2. Under **Household channels**, select **Add channel**.
3. Choose **Webhook** as the provider and enter a name.
4. Enter the complete HTTP or HTTPS endpoint URL.
5. Optionally enter a Bearer token. Yuvomi stores it as a write-only secret and
   sends it as `Authorization: Bearer <token>`.
6. Optionally enter a **payload template** if the receiver expects a body of its
   own shape. Leaving it empty sends the default body described below.
7. Save the channel, enable it, and use **Send test** to verify the endpoint.

The receiver must return a successful HTTP status (`2xx`). Failed deliveries
are retried by the notification scheduler with the same backoff and attempt
limit used for Gotify and ntfy. Secrets are never returned by the channel API
or written into delivery error messages.

The endpoint must resolve to a public address, the same SSRF protection every
other outbound integration has. A URL on a private or local network - a Home
Assistant or n8n instance in the LAN, a container in the same Docker network,
`localhost` - is refused when you save the channel, and the message names the
switch that allows it: set `NOTIFICATION_ALLOW_PRIVATE_NETWORK=true` in the
deployment environment (see the
[installation guide](installation.md#calendar-subscriptions--ics-feeds-optional)).
Delivery checks the address again for every connection, redirects included, so
a host name that resolves into a private network is refused at send time as
well.

## Request format

Yuvomi sends an HTTP `POST` with `Content-Type: application/json`:

```json
{
  "event": "notification",
  "notification": {
    "title": "Yuvomi",
    "body": "Take out the bins",
    "url": "/reminders",
    "tag": "reminder-42",
    "priority": "default"
  },
  "sentAt": "2026-08-06T20:30:00.000Z"
}
```

`sentAt` is generated for each delivery attempt. The notification `tag`
identifies the reminder and can be used by receivers for their own
deduplication. The `url` is relative to the Yuvomi application.

## Payload template

The default body works for receivers that accept arbitrary JSON, such as Home
Assistant or n8n. Services with a schema of their own reject it: a Discord
webhook requires `content` or `embeds` and answers anything else with
`400 Cannot send an empty message`.

Rather than shipping an adapter per service, the channel takes a template and
the same generic provider covers all of them. Enter the body the receiver
expects and use `{{title}}`, `{{body}}`, `{{url}}` and `{{tag}}` where the
reminder's values belong:

```json
{"content": "{{title}} - {{body}}"}
```

```json
{"text": "{{title}}: {{body}}", "unfurl_links": false}
```

Notes:

- Values are JSON-escaped before they are inserted, so a reminder title
  containing a quote, a backslash or a line break cannot break the surrounding
  JSON.
- A placeholder with no value (for example `{{url}}` on a reminder that carries
  none) becomes an empty string.
- The template is checked when you save it: it must produce valid JSON, may use
  only the four placeholders above, and is limited to 4096 characters. A
  template that would only fail at delivery time is rejected in the form. The
  check looks at anything shaped like a placeholder, so a typo such as
  `{{task-title}}` is caught rather than delivered as literal text.
- The endpoint URL is used exactly as entered, including a trailing slash.
- Leave the field empty to keep the default body. Existing webhook channels are
  unaffected.

## Telegram and Discord presets

Settings -> Messenger offers **Telegram** and **Discord** as presets of this
same webhook channel; there is still no provider per service. A preset fills
the address, the template and a length limit from a few fields:

| Preset | You enter | Address | Body | Limit |
|---|---|---|---|---|
| `telegram` | bot token, chat ID | `https://api.telegram.org/bot{{token}}/sendMessage` | `{"chat_id": "<chat ID>", "text": "{{title}}\n\n{{body}}"}` | 4000 |
| `discord` | the webhook URL | `https://discord.com/api/webhooks/{{token}}` | `{"content": "**{{title}}**\n{{body}}"}` | 1900 |

Over the API: `{"provider": "webhook", "config": {"preset": "telegram", "chatId": "123456789"}, "secrets": {"token": "<bot token>"}}`.
A pasted Discord URL is reduced to `<id>/<token>`; a Telegram token copied
with its `bot` prefix is understood.

### A token in the address

Some services carry their key in the URL rather than in a header. Write
`{{token}}` in the **path** of the address and put the value in the token
field: it is stored write-only like any other secret and only inserted when a
message is sent, so the key never appears in the channel list. With
`{{token}}` in the address, no `Authorization` header is sent. The token may
contain letters, digits and `: _ - / .` (no `..`); the placeholder may appear
once and not in the host.

### Length

`maxLength` (set by the presets, or 100 to 100000 on a custom channel) shortens
the body at a line end and appends an ellipsis, so a long daily preview is sent
shortened rather than refused.

## Personal targets and the daily preview

Members can have targets of their own (`scope = 'user'` channels) once an admin
allows it under Settings -> Messenger. Their reminders, private ones included,
also go there. Each member can also have a **daily preview** at a time of their
choice (events, tasks due, birthdays from a week ahead, waste collection,
shopping list), read with their own visibility; an admin can send a household
preview, read like the wall (only what everyone may see), to household
channels. See `server/services/notification-digest.js`.

## Security notes

- Use HTTPS whenever the endpoint is outside a trusted private network.
- Give the webhook a dedicated, revocable token with only the permissions it
  needs.
- Treat notification bodies as household data. The receiving service gets the
  reminder title and, for subscriptions, the name, amount, currency, and next
  renewal date.
- Rotate a token by entering a replacement in the channel form. Leaving the
  field empty preserves the stored token.

