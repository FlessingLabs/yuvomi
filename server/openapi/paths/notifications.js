import { op, jsonBody, idParam } from '../helpers.js';

export function notificationsPaths() {
  return {
    '/api/v1/notifications/providers': {
      get: op({
        summary: 'List supported notification channel providers',
        tag: 'Notifications',
        admin: true,
      }),
    },
    '/api/v1/notifications/channels': {
      get: op({
        summary: 'List household notification channels',
        tag: 'Notifications',
        admin: true,
        responses: {
          200: {
            description: 'Notification channels with secrets omitted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelListResponse' } } },
          },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          201: {
            description: 'Notification channel created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationChannelResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/notifications/channels/{id}': {
      put: op({
        summary: 'Update a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        responses: {
          200: { description: 'Successful response' },
          401: { $ref: '#/components/responses/Unauthorized' },
          409: { description: 'Not a household channel; it stays unchanged and can only be deleted here' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Delete a household notification channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },
    '/api/v1/notifications/channels/{id}/test': {
      post: op({
        summary: 'Send a test notification through a channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [idParam()],
      }),
    },

    // --- Messenger targets and daily preview (migration 276) ---
    '/api/v1/notifications/access': {
      get: op({
        summary: 'List members and whether they may set up personal notification targets',
        tag: 'Notifications',
        admin: true,
        description: 'Admins always may and carry `allowed: true`; for everyone else an admin grants it per member. Nothing is derived from role or family role.',
      }),
    },
    '/api/v1/notifications/access/{userId}': {
      put: op({
        summary: 'Allow or revoke personal notification targets for a member',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        params: [{ name: 'userId', in: 'path', required: true, schema: { type: 'integer' } }],
        description: 'Body `{ "allowed": true|false }`. Revoking switches the member\'s personal channels off (they stay listed for the member, who can still delete them) and pauses their daily preview. An admin has nothing to set. 404 `member_not_found` for an id that is not a household member.',
        responses: {
          200: { description: 'The member and the resulting state' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Not a household member (`member_not_found`)' },
        },
      }),
    },
    '/api/v1/notifications/digest': {
      get: op({
        summary: 'Read the household daily preview settings',
        tag: 'Notifications',
        admin: true,
      }),
      put: op({
        summary: 'Change the household daily preview',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        description: 'Fields: `enabled`, `sendTime` (HH:MM in the household time zone), `day` (`today` or `tomorrow`), `sections` (`events`, `tasks`, `birthdays`, `waste`, `shopping`), `channelIds` (household channels only; empty means all enabled household channels). The household preview shows only what every member may see. Errors carry `reason`: `digest_time_invalid`, `digest_day_invalid`, `digest_section_invalid`, `digest_sections_empty`, `digest_channel_invalid`.',
        responses: {
          200: { description: 'The saved settings' },
          400: { description: 'Invalid settings; `reason` names the field' },
          403: { $ref: '#/components/responses/Forbidden' },
        },
      }),
    },
    '/api/v1/notifications/digest/test': {
      post: op({
        summary: 'Send the household daily preview now to one household channel',
        tag: 'Notifications',
        admin: true,
        stateChanging: true,
        description: 'Body `{ "channelId": n }`. Builds the preview from the saved settings. 502 `notification_test_failed` when the channel did not accept it.',
        responses: {
          200: { description: 'Title and body that were sent' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Not a household channel' },
          502: { description: 'The channel did not accept the message (`notification_test_failed`)' },
        },
      }),
    },
    '/api/v1/notifications/personal': {
      get: op({
        summary: 'Read my personal notification targets and daily preview',
        tag: 'Notifications',
        description: 'Answers for the signed-in member: `allowed` (an admin granted personal targets, or the member is an admin), the member\'s own channels without secrets, the daily preview settings and the available sections.',
      }),
    },
    '/api/v1/notifications/personal/channels': {
      post: op({
        summary: 'Create a personal notification target',
        tag: 'Notifications',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        description: 'Same body as a household channel; scope and owner always come from the session. Telegram and Discord are presets of the webhook provider: `{ "provider": "webhook", "config": { "preset": "telegram", "chatId": "123" }, "secrets": { "token": "<bot token>" } }` or `{ "provider": "webhook", "config": { "preset": "discord" }, "secrets": { "token": "<webhook URL>" } }`. 403 `notification_personal_not_allowed` without an admin\'s grant; 409 `notification_personal_limit` beyond ten channels.',
        responses: {
          201: { description: 'Channel created, secrets omitted' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { description: 'No grant for personal targets (`notification_personal_not_allowed`)' },
          409: { description: 'Too many personal channels (`notification_personal_limit`)' },
        },
      }),
    },
    '/api/v1/notifications/personal/channels/{id}': {
      put: op({
        summary: 'Change one of my notification targets',
        tag: 'Notifications',
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/NotificationChannelInput'),
        description: 'Another member\'s channel does not exist here (404). 403 `notification_personal_not_allowed` without a grant.',
        responses: {
          200: { description: 'Channel updated, secrets omitted' },
          400: { $ref: '#/components/responses/BadRequest' },
          403: { description: 'No grant for personal targets (`notification_personal_not_allowed`)' },
          404: { description: 'Not one of my channels' },
        },
      }),
      delete: op({
        summary: 'Delete one of my notification targets',
        tag: 'Notifications',
        stateChanging: true,
        params: [idParam()],
        description: 'Works without a grant, so a member whose grant was revoked can still remove their data.',
      }),
    },
    '/api/v1/notifications/personal/channels/{id}/test': {
      post: op({
        summary: 'Send a test message to one of my notification targets',
        tag: 'Notifications',
        stateChanging: true,
        params: [idParam()],
        responses: {
          200: { description: 'Sent' },
          403: { description: 'No grant for personal targets (`notification_personal_not_allowed`)' },
          404: { description: 'Not one of my channels' },
          502: { description: 'The channel did not accept the message (`notification_test_failed`)' },
        },
      }),
    },
    '/api/v1/notifications/personal/digest': {
      put: op({
        summary: 'Change my daily preview',
        tag: 'Notifications',
        stateChanging: true,
        description: 'Same fields as the household preview; `channelIds` may only name the member\'s own channels. The preview reads with the member\'s own visibility and module permissions. Errors carry `reason` (`digest_time_invalid`, `digest_day_invalid`, `digest_section_invalid`, `digest_sections_empty`, `digest_channel_invalid`); 403 `notification_personal_not_allowed` without a grant.',
        responses: {
          200: { description: 'The saved settings' },
          400: { description: 'Invalid settings; `reason` names the field' },
          403: { description: 'No grant for personal targets (`notification_personal_not_allowed`)' },
        },
      }),
    },
    '/api/v1/notifications/personal/digest/test': {
      post: op({
        summary: 'Send my daily preview now to one of my targets',
        tag: 'Notifications',
        stateChanging: true,
        description: 'Body `{ "channelId": n }`; builds the preview from the saved settings.',
        responses: {
          200: { description: 'Title and body that were sent' },
          403: { description: 'No grant for personal targets (`notification_personal_not_allowed`)' },
          404: { description: 'Not one of my channels' },
          502: { description: 'The channel did not accept the message (`notification_test_failed`)' },
        },
      }),
    },

    // --- Health module ---
  };
}
