import { jsonBody, op, stringPathParam } from '../helpers.js';
import { LIMITS, PAGE_DEFAULT, PAGE_MAX } from '../../services/module-records.js';
import { ZIP_LIMITS } from '../../services/zip-reader.js';

// Aus dem ZIP-Leser statt aus module-install.js: der zieht die Datenbank nach,
// und die Spec wird auch ohne sie gebaut (test:openapi-*).
const MAX_ZIP_MB = ZIP_LIMITS.maxCompressed / (1024 * 1024);

const SWITCH_NOTE = 'Exists only where the operator set `MODULES_ALLOW_WEB_INSTALL=true` (off by default): otherwise 403 `module_web_install_disabled`, before the body is read.';

const SESSION_NOTE = 'Only from a signed-in browser session: an API token (and therefore the MCP bridge) gets 403 `module_session_required`, and the operation is not offered as an MCP tool.';

const INSTALL_NOTE = `${SWITCH_NOTE} A module is same-origin JavaScript that runs with the session of every member who opens it; installing one is equivalent to copying its folder onto the server. Every install and every replace lands DISABLED: the install record in the module folder (\`install.approved: false\`) keeps it off, whatever the database says, until an admin enables it with PATCH /api/v1/modules/{id} from a browser session. A replace resets that approval even when it comes from the same repository. Only the module folder is copied, files other than web assets are skipped and listed in \`skipped\`, and nothing from the archive runs on the server. Limited to 10 install requests per 10 minutes per user; the 409 \`exists\` and 422 \`multiple\` answers that ask back do not count there, but every request counts against a second limit of 30 attempts per 10 minutes, because those answers come after the download and the unpack. Errors carry a stable \`reason\`. ${SESSION_NOTE}`;

// The MCP bridge (server/mcp/tools.js) leaves operations with this flag out of
// list_api_operations and refuses them in call_api_operation. The route would
// refuse a token anyway (module_session_required); hiding them keeps an assistant from
// planning around a step it can never take.
const MCP_EXCLUDE = 'x-mcp-exclude';

function sessionOnly(operation) {
  operation.responses[403] = {
    description: 'Not an admin, installing from Settings switched off on this server (`module_web_install_disabled`), or not a browser session (`module_session_required`)',
    content: errorContent(),
  };
  operation[MCP_EXCLUDE] = true;
  return operation;
}

function errorContent() {
  return { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallError' } } };
}

function installResponses(extra = {}) {
  return {
    201: {
      description: 'Module installed (or replaced). `data` is the module as listed by GET /api/v1/modules?admin=1.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallResponse' } } },
    },
    400: { description: 'Invalid archive or manifest. `reason` is one of `bad_url`, `not_zip`, `unsafe_path`, `symlink`, `encrypted`, `zip64`, `method`, `crc`, `duplicate`, `corrupt` (also for an incomplete upload), `bad_manifest`, `no_manifest`, `path_not_found`.', content: errorContent() },
    401: { $ref: '#/components/responses/Unauthorized' },
    403: { $ref: '#/components/responses/Forbidden' },
    409: { description: 'A module with this id is installed (`exists`, with `existing: { id, name, version, install }` and `incoming: { id, name, version }`; `existing.install` is always the install record, because only a recorded module reaches this answer; retry with overwrite, which leaves the module disabled until it is approved again), the folder `modules/<id>` carries no install record, so it was copied to the server by hand and is not replaced from here (`not_web_installed`, without `existing`, with or without overwrite; remove the folder on the server first, then install again), `modules/<id>` is a symbolic link or a file (`not_a_module`, cannot be replaced from here), or another install/delete is running (`busy`).', content: errorContent() },
    413: { description: `Archive larger than ${MAX_ZIP_MB} MB (\`too_large\`), too many entries (\`too_many_entries\`) or suspicious compression (\`bomb\`).`, content: errorContent() },
    422: { description: 'The archive holds several modules (`multiple`, with `candidates: [{ path, id, name, version }]`), or `path` names a folder that holds several; retry with `path` set to one candidate (`""` is the archive root).', content: errorContent() },
    429: { description: 'Install rate limit reached (`install_rate_limited`): 10 installs or 30 attempts in 10 minutes', content: errorContent() },
    503: { description: 'The modules folder on the server is not writable (`not_writable`).', content: errorContent() },
    500: { $ref: '#/components/responses/InternalServerError' },
    ...extra,
  };
}

// Modulspeicher (Migration 274, routes/module-records.js). Ein Satz fuer alle
// Operationen, damit Grenzen und Lebensdauer an jeder dasselbe sagen.
const RECORDS_NOTE = `Small household-shared JSON records owned by an installed, enabled third-party module that declares \`capabilities.permissions.module\`. Access follows the module's \`ext:<moduleId>\` permission (read for GET, write otherwise); scoped API tokens need \`ext:<moduleId>:read\` or \`:write\`; paired displays and Shared-expenses guests have no access. A disabled, errored or removed module answers 404 \`module_storage_unavailable\`, but its records are kept until an admin deletes them with DELETE /api/v1/modules/{moduleId}/records. The content is opaque to Yuvomi: one JSON object of at most ${LIMITS.recordBytes} bytes per record, at most ${LIMITS.records} records and ${LIMITS.totalBytes} bytes per module (413 \`record_too_large\` / \`module_storage_full\`). Not meant for secrets, files or models. Replace and delete take the revision the caller last read; a stale one answers 409 \`record_conflict\` and changes nothing. A record may belong to one person (\`subject_id\`, a household member): then only an admin, that person (read) and whoever an admin granted access for this module and this person (GET/PUT /api/v1/modules/{moduleId}/grants) can reach it; for anyone else it does not exist (404 \`record_not_found\`). A record without \`subject_id\` is household-wide.`;

function mcpExcluded(operation) {
  operation[MCP_EXCLUDE] = true;
  return operation;
}

function recordSchema() {
  return {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid', description: 'Server-generated record id' },
      subject_id: { type: ['integer', 'null'], description: 'The household member this record belongs to; null for household-wide. Fixed once created.' },
      revision: { type: 'integer', minimum: 1, description: 'Starts at 1 and grows by one with every replace' },
      data: { type: 'object', additionalProperties: true, description: 'The JSON object the module stored' },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'revision', 'data', 'created_at', 'updated_at'],
  };
}

function recordResponse(description) {
  return {
    description,
    content: { 'application/json': { schema: { type: 'object', properties: { data: recordSchema() }, required: ['data'] } } },
  };
}

function recordsCommonResponses(extra = {}) {
  return {
    401: { $ref: '#/components/responses/Unauthorized' },
    403: { description: 'No access to this module (`module_access_denied`), or the token scope does not cover `ext:<moduleId>`' },
    404: { description: 'The module is not installed, not enabled, has errors or declares no permission module (`module_storage_unavailable`), or the record does not exist (`record_not_found`)' },
    500: { $ref: '#/components/responses/InternalServerError' },
    ...extra,
  };
}

const RECORD_WRITE_BODY = {
  required: true,
  description: 'The record content',
  content: { 'application/json': { schema: {
    type: 'object',
    properties: {
      data: { type: 'object', additionalProperties: true },
      revision: { type: 'integer', minimum: 1, description: 'Replace only: the revision last read' },
      subject_id: { type: ['integer', 'null'], description: 'Create only: the household member the record belongs to. On replace it may be sent but must not change (400 `record_subject_immutable`).' },
    },
    required: ['data'],
  } } },
};

function recordsPaths() {
  const moduleParam = stringPathParam('moduleId', 'Module ID');
  const recordParam = stringPathParam('recordId', 'Record ID (UUID)');
  return {
    '/api/v1/modules/storage': {
      get: op({
        summary: 'Module storage usage per module',
        tag: 'Modules',
        admin: true,
        description: 'Every module that has records, with record count, bytes and the last change - including disabled and removed modules, whose records are kept until an admin deletes them. Other callers get 403 `module_access_denied`.',
        responses: {
          200: {
            description: 'Usage per module',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: {
              module_id: { type: 'string' }, records: { type: 'integer' }, bytes: { type: 'integer' }, updated_at: { type: 'string', format: 'date-time' },
            }, required: ['module_id', 'records', 'bytes', 'updated_at'] } } }, required: ['data'] } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Not an admin (`module_access_denied`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/{moduleId}/records': {
      get: op({
        summary: 'List module records',
        tag: 'Modules',
        description: `${RECORDS_NOTE} Records come in stable id order, ${PAGE_DEFAULT} per page by default (\`limit\` 1-${PAGE_MAX}); pass \`next\` from the answer as \`after\` for the next page. \`next\` is null on the last page. An invalid page answers 400 \`record_page_invalid\`.`,
        params: [
          moduleParam,
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: PAGE_MAX } },
          { name: 'after', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
          { name: 'subject_id', in: 'query', required: false, description: 'Only the records of this person, or `none` for household-wide records. Records of persons the caller may not read are never listed.', schema: { type: 'string' } },
        ],
        responses: recordsCommonResponses({
          200: {
            description: 'One page of records',
            content: { 'application/json': { schema: { type: 'object', properties: {
              data: { type: 'array', items: recordSchema() },
              next: { type: ['string', 'null'] },
            }, required: ['data', 'next'] } } },
          },
          400: { description: 'Invalid `limit` or `after` (`record_page_invalid`)' },
        }),
      }),
      post: op({
        summary: 'Create a module record',
        tag: 'Modules',
        stateChanging: true,
        description: `${RECORDS_NOTE} The server assigns the id and revision 1. With \`subject_id\` the caller needs write access to that person: 400 \`record_subject_invalid\` when it is not an active household member, 403 \`module_person_access_denied\` without access.`,
        params: [moduleParam],
        requestBody: RECORD_WRITE_BODY,
        responses: recordsCommonResponses({
          201: recordResponse('Created record'),
          400: { description: '`data` is not a JSON object (`record_object_required`)' },
          413: { description: 'Record too large (`record_too_large`) or the module has no room left (`module_storage_full`)' },
        }),
      }),
      delete: mcpExcluded(op({
        summary: 'Delete all records of a module',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: 'The one way module data is removed for good. Admin only (others get 403 `module_access_denied`), from a signed-in browser session (an API token gets 403 `module_session_required`), and the body must name the module: `{ "confirm": "<moduleId>" }`, otherwise 400 `module_purge_confirm_required`. Works for disabled and removed modules too. Disabling, updating or deleting a module never removes its records.',
        params: [moduleParam],
        requestBody: jsonBody(null, '`{ "confirm": "<moduleId>" }`'),
        responses: {
          200: {
            description: 'Number of deleted records',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: {
              module_id: { type: 'string' }, deleted: { type: 'integer' },
            }, required: ['module_id', 'deleted'] } }, required: ['data'] } } },
          },
          400: { description: 'Missing or wrong confirmation (`module_purge_confirm_required`)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Not an admin (`module_access_denied`) or not a browser session (`module_session_required`)' },
          404: { description: 'Invalid module id (`module_storage_unavailable`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      })),
    },
    '/api/v1/modules/{moduleId}/people': {
      get: op({
        summary: 'Persons whose module records the caller may read',
        tag: 'Modules',
        description: 'Active household members (no staff, guests or displays) whose person records in this module the caller may read, with `access` (`read` or `write`) and `self`. An admin gets every member with `write`; a member gets themselves (`read`) and every person an admin granted them access to. Same module gate as the records: 404 `module_storage_unavailable`, 403 `module_access_denied`.',
        params: [moduleParam],
        responses: {
          200: {
            description: 'Persons',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: {
              user_id: { type: 'integer' }, display_name: { type: 'string' }, avatar_color: { type: ['string', 'null'] },
              family_role: { type: 'string' }, access: { type: 'string', enum: ['read', 'write'] }, self: { type: 'boolean' },
            }, required: ['user_id', 'display_name', 'access', 'self'] } } }, required: ['data'] } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'No access to this module (`module_access_denied`)' },
          404: { description: 'Module storage unavailable (`module_storage_unavailable`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/{moduleId}/grants': {
      get: op({
        summary: 'Per-person grants of a module',
        tag: 'Modules',
        admin: true,
        description: 'Who may read or maintain the person records of whom in this module: `{ <subjectId>: [{ user_id, access }] }`. Admin only (403 `module_access_denied`). Grants are set per module and per person by an admin; nothing is derived from family roles. Same module gate as the records (404 `module_storage_unavailable`).',
        params: [moduleParam],
        responses: {
          200: { description: 'Grants per person', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', additionalProperties: true } }, required: ['data'] } } } },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Not an admin (`module_access_denied`)' },
          404: { description: 'Module storage unavailable (`module_storage_unavailable`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/{moduleId}/grants/{subjectId}': {
      put: op({
        summary: 'Replace the grants for one person',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: 'Replaces who may read (`read`) or maintain (`write`) the records of this person in this module. An empty list removes every grant. Every grantee must be an active household member other than the person (400 `module_grants_invalid`); the person must be an active household member (400 `module_person_invalid`). Admin only (403 `module_access_denied`). Same module gate as the records (404 `module_storage_unavailable`). Grants end when the grantee is removed from the household.',
        params: [moduleParam, stringPathParam('subjectId', 'User id of the person')],
        requestBody: { required: true, description: 'The new grants', content: { 'application/json': { schema: { type: 'object', properties: { grants: { type: 'array', items: { type: 'object', properties: {
          user_id: { type: 'integer' }, access: { type: 'string', enum: ['read', 'write'] },
        }, required: ['user_id', 'access'] } } }, required: ['grants'] } } } },
        responses: {
          200: { description: 'The grants now in place for this person', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['data'] } } } },
          400: { description: 'Invalid person (`module_person_invalid`) or grants (`module_grants_invalid`)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Not an admin (`module_access_denied`)' },
          404: { description: 'Module storage unavailable (`module_storage_unavailable`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/{moduleId}/records/{recordId}': {
      get: op({
        summary: 'Get a module record',
        tag: 'Modules',
        description: RECORDS_NOTE,
        params: [moduleParam, recordParam],
        responses: recordsCommonResponses({ 200: recordResponse('The record') }),
      }),
      put: op({
        summary: 'Replace a module record',
        tag: 'Modules',
        stateChanging: true,
        description: `${RECORDS_NOTE} \`revision\` is required (400 \`record_revision_required\`); the answer carries the new revision. A record of a person the caller may only read answers 403 \`module_person_access_denied\`; the person cannot change (400 \`record_subject_immutable\`).`,
        params: [moduleParam, recordParam],
        requestBody: RECORD_WRITE_BODY,
        responses: recordsCommonResponses({
          200: recordResponse('Replaced record'),
          400: { description: '`data` is not a JSON object (`record_object_required`) or `revision` is missing (`record_revision_required`)' },
          409: { description: 'The record was changed since that revision (`record_conflict`); nothing was written' },
          413: { description: 'Record too large (`record_too_large`) or the module has no room left (`module_storage_full`)' },
        }),
      }),
      delete: op({
        summary: 'Delete a module record',
        tag: 'Modules',
        stateChanging: true,
        description: `${RECORDS_NOTE} The revision goes in the body (\`{ "revision": 3 }\`) or in the query (\`?revision=3\`); it is required (400 \`record_revision_required\`). A record of a person the caller may only read answers 403 \`module_person_access_denied\`.`,
        params: [moduleParam, recordParam, { name: 'revision', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } }],
        responses: recordsCommonResponses({
          200: {
            description: 'Deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: {
              id: { type: 'string' }, deleted: { type: 'boolean', const: true },
            }, required: ['id', 'deleted'] } }, required: ['data'] } } },
          },
          400: { description: '`revision` is missing (`record_revision_required`)' },
          409: { description: 'The record was changed since that revision (`record_conflict`); nothing was deleted' },
        }),
      }),
    },
  };
}

export function modulesPaths() {
  return {
    ...recordsPaths(),
    '/api/v1/modules': {
      get: op({
        summary: 'List installed extension modules',
        tag: 'Modules',
        description: 'Returns discovered third-party modules from the modules directory, including normalized capabilities (widgets, permissions, API prefix) when declared in module.json. Pass `admin=1` as an admin to include disabled and errored modules and the `install` metadata (source, URL, commit, whether it was approved, who installed it); other listings leave `install` out.',
        responses: {
          200: {
            description: 'Extension modules',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModulesListResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/updates': {
      get: op({
        summary: 'Update check results for modules installed from GitHub',
        tag: 'Modules',
        admin: true,
        description: 'Once a day (and on demand) the server asks GitHub for the newest version of every module installed from Settings out of a GitHub repository: the newest release when it was installed from a release, otherwise the newest commit of its branch. Each entry carries the installed and the found version and commit, `available` (a newer commit that was not put off with `snooze`), `snoozed` and the last `error`. Hand-copied modules and ZIP uploads have no source and do not appear. Nothing is updated by itself.',
      }),
    },
    '/api/v1/modules/updates/check': {
      post: op({
        summary: 'Check for module updates now',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: 'Runs the check at once and answers with the same list as GET /api/v1/modules/updates. Counts against the install attempt limit (30 per 10 minutes); an error with one repository stays at that module. 429 `install_rate_limited` when the limit is reached.',
        responses: {
          200: { description: 'The update check results' },
          429: { description: 'Too many attempts (`install_rate_limited`)', content: errorContent() },
        },
      }),
    },
    '/api/v1/modules/updates/{id}/snooze': {
      post: op({
        summary: 'Put off a found module update',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        params: [stringPathParam('id', 'Module id')],
        description: 'Hides exactly the found version; a newer one is reported again.',
      }),
    },
    '/api/v1/modules/updates/{id}/apply': {
      post: op({
        summary: 'Install the found update of a module',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        params: [stringPathParam('id', 'Module id')],
        description: `Replaces the module with the found version from the same repository and folder, like Add custom module with overwrite. ${INSTALL_NOTE} 404 \`not_found\` for a module not installed from GitHub; 409 \`up_to_date\` when the found version is already installed.`,
        responses: {
          201: { description: 'Replaced; the module is disabled until an admin enables it again' },
          403: { description: 'Web install is switched off (`module_web_install_disabled`) or the request is not from a browser session (`module_session_required`)', content: errorContent() },
          404: { description: 'Not installed from GitHub (`not_found`), or the repository or ref is gone (`repo_not_found`, `ref_not_found`)', content: errorContent() },
          409: { description: 'Already up to date (`up_to_date`), or another install is running (`busy`)', content: errorContent() },
          429: { description: 'Too many attempts (`install_rate_limited`) or GitHub rate limit (`rate_limited`)', content: errorContent() },
          502: { description: 'GitHub failed (`github_failed`)', content: errorContent() },
        },
      }),
    },
    '/api/v1/modules/install/info': {
      get: op({
        summary: 'Module install capabilities',
        tag: 'Modules',
        admin: true,
        description: 'Whether installing from Settings is switched on by the operator (`webInstall`, `MODULES_ALLOW_WEB_INSTALL`), whether the modules folder on the server is writable (it is not on read-only mounts), whether it survives an update (`persistent`: false in a container without a volume on the modules folder, null when unknown) and the archive size limit. When `webInstall` or `writable` is false the install routes refuse (403 or 503) and modules can only be copied in by hand. The Settings page treats `persistent: false` the same way and shows the manual way, although the routes themselves still answer there.',
        responses: {
          200: {
            description: 'Install capabilities',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ModuleInstallInfoResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/modules/install/zip': {
      post: sessionOnly(op({
        summary: 'Install an extension module from a ZIP archive',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: `${INSTALL_NOTE} The request body is the raw ZIP file, up to ${MAX_ZIP_MB} MB.`,
        params: [
          { name: 'overwrite', in: 'query', required: false, description: 'Set to `1` to replace an installed module with the same id (after a 409 `exists`). Only a module that carries an install record is replaced; a folder copied to the server by hand answers 409 `not_web_installed` with or without this flag.', schema: { type: 'string', enum: ['0', '1'] } },
          { name: 'path', in: 'query', required: false, description: 'Folder inside the archive that holds module.json, relative to the single top folder if there is one (after a 422 `multiple`). Present but empty (`path=`) selects the archive root.', schema: { type: 'string', maxLength: 500 } },
        ],
        requestBody: {
          required: true,
          description: 'ZIP archive containing a module folder with module.json.',
          content: {
            'application/zip': { schema: { type: 'string', format: 'binary' } },
            'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            'application/x-zip-compressed': { schema: { type: 'string', format: 'binary' } },
          },
        },
        responses: installResponses({
          415: { description: 'Unsupported Content-Encoding (`unsupported_encoding`)', content: errorContent() },
        }),
      })),
    },
    '/api/v1/modules/install/github': {
      post: sessionOnly(op({
        summary: 'Install an extension module from a GitHub repository',
        tag: 'Modules',
        admin: true,
        stateChanging: true,
        description: `${INSTALL_NOTE} Accepted URLs: \`https://github.com/<owner>/<repo>\` (also without \`https://\`), \`.../tree/<ref>[/<path>]\`, \`.../releases/tag/<tag>\`, \`.../releases/latest\` and bare \`<owner>/<repo>\`. If the URL names no tag or branch, the latest release is used, or the default branch when there is no release. A tree URL that points at a folder holding several modules answers 422 \`multiple\`. The archive is downloaded only from api.github.com, github.com and codeload.github.com.`,
        requestBody: jsonBody('#/components/schemas/ModuleInstallGithubRequest'),
        responses: installResponses({
          404: { description: 'Repository (`repo_not_found`) or ref (`ref_not_found`) not found', content: errorContent() },
          429: { description: 'Install rate limit reached (`install_rate_limited`: 10 installs or 30 attempts in 10 minutes), or GitHub is limiting requests from this server, by its hourly or its secondary rate limit (`rate_limited`, with `resetAt` when GitHub names a time)', content: errorContent() },
          502: { description: 'GitHub could not be reached or answered unexpectedly (`github_failed`), including a redirect to a non-GitHub host', content: errorContent() },
        }),
      })),
    },
    '/api/v1/modules/{id}': {
      patch: op({
        summary: 'Enable or disable an extension module',
        tag: 'Modules',
        admin: true,
        description: 'Enabling (`enabled: true`) is the admin\'s approval of installed code and is only possible from a signed-in browser session: an API token, and therefore the MCP bridge, gets 403 `module_session_required`. For a module installed from Settings it also writes `approved: true` into the install record in the module folder, so the approval survives a restored or fresh database. That write runs under the install lock: while an install or delete is running (a GitHub download can take up to 30 s) enabling answers 409 `busy`, and when the module folder is not writable for the server it answers 503 `not_writable`. Error bodies carry `reason` where one is known. Disabling (`enabled: false`) works with a token as well; it sets the household switch and then writes `approved: false` back into the install record (best effort: a read-only folder does not stop it, and while an install or delete holds the lock the record is left as it is, since disabling never waits), so `approved` always means that an admin has this version switched on. The operation stays available to MCP for that direction.',
        params: [stringPathParam('id', 'Module ID')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/ModuleEnableRequest'),
        responses: {
          200: {
            description: 'Updated module',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/ExtensionModule' } }, required: ['data'] } } },
          },
          400: { description: 'Invalid request, or the module has errors and cannot be enabled' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { description: 'Not an admin, or `enabled: true` without a browser session (`module_session_required`)', content: errorContent() },
          404: { description: 'Module not found' },
          409: { description: 'With `enabled: true`: another install or delete is running (`busy`); try again in a moment', content: errorContent() },
          503: { description: 'With `enabled: true`: the module folder on the server is not writable, so the approval cannot be recorded (`not_writable`)', content: errorContent() },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: sessionOnly(op({
        summary: 'Delete an installed extension module',
        tag: 'Modules',
        admin: true,
        description: `${SWITCH_NOTE} Removes the folder modules/<id> from the server, but only one that carries an install record (\`.yuvomi-install.json\`), that is, one the web interface installed: a hand-copied folder answers 409 \`not_web_installed\` and is removed on the server instead. Permission rows (\`ext:<id>\`) and dashboard widget settings are kept: they are ignored while the module is missing and apply again if the same id is reinstalled. A symbolic link or non-folder is refused. ${SESSION_NOTE}`,
        params: [stringPathParam('id', 'Module ID')],
        stateChanging: true,
        responses: {
          200: {
            description: 'Module deleted',
            content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'object', properties: { id: { type: 'string' }, deleted: { type: 'boolean', const: true } }, required: ['id', 'deleted'] } }, required: ['data'] } } },
          },
          400: { description: 'Invalid id (`bad_id`) or not a regular folder (`not_a_module`)', content: errorContent() },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'Module not found (`not_found`)', content: errorContent() },
          409: { description: 'The folder has no install record, so it was not installed from Settings (`not_web_installed`), or another install/delete is running (`busy`)', content: errorContent() },
          503: { description: 'The modules folder on the server is not writable (`not_writable`)', content: errorContent() },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      })),
    },
    '/api/v1/modules/assets/{id}/{assetPath}': {
      get: op({
        summary: 'Get protected extension module asset',
        tag: 'Modules',
        params: [
          stringPathParam('id', 'Module ID'),
          stringPathParam('assetPath', 'Asset path within the module'),
        ],
        description: 'Files whose path has a segment starting with `.` (for example `.yuvomi-install.json`) are never served and answer 404.',
        responses: {
          200: { description: 'Module asset (JavaScript or CSS)' },
          401: { $ref: '#/components/responses/Unauthorized' },
          404: { description: 'Module or asset not found' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  };
}
