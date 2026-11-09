import { ErrorCode } from './constants.js';
import { isSnowflake } from './util.js';

// https://discord.com/developers/docs/topics/opcodes-and-status-codes#json
// Error body: { message, code } plus `errors` for form errors
// (https://discord.com/developers/docs/reference#error-messages).
export class DiscordError extends Error {
  constructor(status, code, message, errors) {
    super(message);
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
  toJSON() {
    const body = { message: this.message, code: this.code };
    if (this.errors) body.errors = this.errors;
    return body;
  }
}

// Messages are the ones the docs list next to each code.
const E = (status, code, message) => () => new DiscordError(status, code, message);
export const Errors = {
  // Generic HTTP errors use code 0 – https://discord.com/developers/docs/topics/opcodes-and-status-codes#http
  notFound: E(404, 0, '404: Not Found'),
  methodNotAllowed: E(405, 0, '405: Method Not Allowed'),
  unauthorized: E(401, 0, '401: Unauthorized'),
  unknownAccount: E(404, ErrorCode.UNKNOWN_ACCOUNT, 'Unknown Account'),
  unknownApplication: E(404, ErrorCode.UNKNOWN_APPLICATION, 'Unknown Application'),
  unknownChannel: E(404, ErrorCode.UNKNOWN_CHANNEL, 'Unknown Channel'),
  unknownGuild: E(404, ErrorCode.UNKNOWN_GUILD, 'Unknown Guild'),
  unknownInvite: E(404, ErrorCode.UNKNOWN_INVITE, 'Unknown Invite'),
  unknownMember: E(404, ErrorCode.UNKNOWN_MEMBER, 'Unknown Member'),
  unknownMessage: E(404, ErrorCode.UNKNOWN_MESSAGE, 'Unknown Message'),
  unknownOverwrite: E(404, ErrorCode.UNKNOWN_OVERWRITE, 'Unknown Overwrite'),
  unknownRole: E(404, ErrorCode.UNKNOWN_ROLE, 'Unknown Role'),
  unknownUser: E(404, ErrorCode.UNKNOWN_USER, 'Unknown User'),
  unknownWebhook: E(404, ErrorCode.UNKNOWN_WEBHOOK, 'Unknown Webhook'),
  unknownBan: E(404, ErrorCode.UNKNOWN_BAN, 'Unknown Ban'),
  unknownSku: E(404, ErrorCode.UNKNOWN_SKU, 'Unknown SKU'),
  unknownEntitlement: E(404, ErrorCode.UNKNOWN_ENTITLEMENT, 'Unknown Entitlement'),
  unknownInteraction: E(404, ErrorCode.UNKNOWN_INTERACTION, 'Unknown interaction'),
  unknownCommand: E(404, ErrorCode.UNKNOWN_APPLICATION_COMMAND, 'Unknown application command'),
  unknownAutoModRule: E(404, ErrorCode.UNKNOWN_AUTOMOD_RULE, 'Unknown Auto Moderation Rule'),
  unknownSubscription: E(404, ErrorCode.UNKNOWN_SUBSCRIPTION, 'Unknown Subscription'),
  botsCannotUse: E(403, ErrorCode.BOTS_CANNOT_USE_ENDPOINT, 'Bots cannot use this endpoint'),
  onlyBots: E(403, ErrorCode.ONLY_BOTS_CAN_USE_ENDPOINT, 'Only bots can use this endpoint'),
  notAuthorizedForApp: E(403, ErrorCode.NOT_AUTHORIZED_FOR_APPLICATION, 'You are not authorized to perform this action on this application'),
  maxRoles: E(400, ErrorCode.MAX_ROLES, 'Maximum number of guild roles reached (250)'),
  maxChannels: E(400, ErrorCode.MAX_CHANNELS, 'Maximum number of guild channels reached (500)'),
  alreadyAcknowledged: E(400, ErrorCode.INTERACTION_ALREADY_ACKNOWLEDGED, 'Interaction has already been acknowledged.'),
  missingAccess: E(403, ErrorCode.MISSING_ACCESS, 'Missing Access'),
  missingPermissions: E(403, ErrorCode.MISSING_PERMISSIONS, 'Missing Permissions'),
  cannotExecuteOnDM: E(403, ErrorCode.CANNOT_EXECUTE_ON_DM, 'Cannot execute action on a DM channel'),
  emptyMessage: E(400, ErrorCode.CANNOT_SEND_EMPTY_MESSAGE, 'Cannot send an empty message'),
  cannotSendToUser: E(403, ErrorCode.CANNOT_SEND_TO_USER, 'Cannot send messages to this user'),
  nonTextChannel: E(403, ErrorCode.CANNOT_SEND_IN_NON_TEXT, 'Cannot send messages in a non-text channel'),
  invalidAuthToken: E(401, ErrorCode.INVALID_AUTH_TOKEN, 'Invalid authentication token provided'),
  systemMessage: E(403, ErrorCode.CANNOT_EXECUTE_ON_SYSTEM_MESSAGE, 'Cannot execute action on a system message'),
  channelType: E(400, ErrorCode.CANNOT_EXECUTE_ON_CHANNEL_TYPE, 'Cannot execute action on this channel type'),
  invalidOAuthToken: E(401, ErrorCode.INVALID_OAUTH2_ACCESS_TOKEN, 'Invalid OAuth2 access token provided'),
  invalidWebhookToken: E(401, ErrorCode.INVALID_WEBHOOK_TOKEN, 'Invalid Webhook Token'),
  invalidRole: E(400, ErrorCode.INVALID_ROLE, 'Invalid Role'),
  tooOldToBulkDelete: E(400, ErrorCode.MESSAGE_TOO_OLD_TO_BULK_DELETE, 'A message provided was too old to bulk delete'),
  invalidApiVersion: E(400, ErrorCode.INVALID_API_VERSION, 'Invalid API version provided'),
  invalidJson: E(400, ErrorCode.INVALID_JSON, 'The request body contains invalid JSON.'),
  // ASSUMPTION: the docs give the code (500000) but not the HTTP status; we answer 400.
  failedToBan: E(400, ErrorCode.FAILED_TO_BAN_USERS, 'Failed to ban users'),
  cannotEditOthersMessage: E(403, 50005, 'Cannot edit a message authored by another user'),
  entityTooLarge: E(413, 40005, 'Request entity too large'),
  communityChannel: E(400, 50074, 'Cannot delete a channel required for Community guilds'),
  invalidFormBody: E(400, ErrorCode.INVALID_FORM_BODY, 'Invalid Form Body'),
};

// ---------------------------------------------------------------------------
// Form-body validation producing Discord's nested `errors` shape:
//   { field: { _errors: [{ code, message }] } }, arrays keyed by index.
// The error *codes* (BASE_TYPE_REQUIRED, ...) are the ones in the docs' examples
// (https://discord.com/developers/docs/reference#error-messages); the ones the docs
// don't show are ASSUMPTIONS modelled on the same naming.
// ---------------------------------------------------------------------------
export class FormErrors {
  constructor() { this.tree = {}; this.count = 0; }
  add(path, code, message) {
    let node = this.tree;
    for (const key of path) node = node[key] ??= {};
    (node._errors ??= []).push({ code, message });
    this.count++;
  }
  throwIfAny() {
    if (this.count) throw new DiscordError(400, ErrorCode.INVALID_FORM_BODY, 'Invalid Form Body', this.tree);
  }
}

export function formError(path, code, message) {
  const fe = new FormErrors();
  fe.add(Array.isArray(path) ? path : [path], code, message);
  return new DiscordError(400, ErrorCode.INVALID_FORM_BODY, 'Invalid Form Body', fe.tree);
}

/**
 * Validate `value` against a schema. Schema entries:
 *  { type: 'string'|'int'|'number'|'bool'|'snowflake'|'bitfield'|'iso8601'|'array'|'object'|'any',
 *    required, nullable, min, max, minLength, maxLength, choices, items, fields }
 */
export function validate(value, schema, fe = new FormErrors(), path = []) {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    fe.add(path, 'DICT_TYPE_CONVERT', 'Only dictionaries may be used in a DictType');
    return fe;
  }
  for (const [key, spec] of Object.entries(schema)) checkField(value[key], spec, fe, [...path, key]);
  return fe;
}

export function checkField(v, spec, fe, path) {
  if (v === undefined) {
    if (spec.required) fe.add(path, 'BASE_TYPE_REQUIRED', 'This field is required');
    return;
  }
  if (v === null) {
    if (!spec.nullable) fe.add(path, 'BASE_TYPE_REQUIRED', 'This field is required');
    return;
  }
  switch (spec.type) {
    case 'string': {
      if (typeof v !== 'string') return fe.add(path, 'BASE_TYPE_STRING', 'Could not interpret value as string.');
      lengthCheck(v.length, spec, fe, path);
      break;
    }
    case 'int':
    case 'number': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || Number.isNaN(n) || (spec.type === 'int' && !Number.isInteger(n))) {
        return fe.add(path, 'NUMBER_TYPE_COERCE', `Value "${v}" is not ${spec.type === 'int' ? 'int' : 'a number'}.`);
      }
      if (spec.min !== undefined && n < spec.min) fe.add(path, 'NUMBER_TYPE_MIN', `${spec.type} value should be greater than or equal to ${spec.min}.`);
      if (spec.max !== undefined && n > spec.max) fe.add(path, 'NUMBER_TYPE_MAX', `${spec.type} value should be less than or equal to ${spec.max}.`);
      break;
    }
    case 'bool':
      if (typeof v !== 'boolean') fe.add(path, 'BASE_TYPE_BOOLEAN', 'Must be either true or false.');
      break;
    case 'snowflake':
      if (!isSnowflake(v)) fe.add(path, 'NUMBER_TYPE_COERCE', `Value "${v}" is not snowflake.`);
      break;
    case 'bitfield':
      if (!(typeof v === 'string' || typeof v === 'number') || !/^\d+$/.test(String(v))) {
        fe.add(path, 'NUMBER_TYPE_COERCE', `Value "${v}" is not int.`);
      }
      break;
    case 'iso8601':
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) fe.add(path, 'DATE_TYPE_PARSE', `Could not parse ${v}. Should be ISO8601.`);
      break;
    case 'array': {
      if (!Array.isArray(v)) return fe.add(path, 'BASE_TYPE_LIST', 'Must be a list.'); // ASSUMPTION: code name
      lengthCheck(v.length, spec, fe, path);
      if (spec.items) v.forEach((item, i) => checkField(item, spec.items, fe, [...path, String(i)]));
      break;
    }
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) return fe.add(path, 'DICT_TYPE_CONVERT', 'Only dictionaries may be used in a DictType');
      if (spec.fields) for (const [k, s] of Object.entries(spec.fields)) checkField(v[k], s, fe, [...path, k]);
      break;
    }
    case 'any':
      break;
    default:
      throw new Error(`unknown schema type ${spec.type}`);
  }
  if (spec.choices && !spec.choices.includes(v)) {
    fe.add(path, 'BASE_TYPE_CHOICES', `Value must be one of (${spec.choices.map((c) => JSON.stringify(c)).join(', ')}).`);
  }
}

function lengthCheck(len, spec, fe, path) {
  const { minLength: lo, maxLength: hi } = spec;
  if (lo !== undefined && hi !== undefined && (len < lo || len > hi)) {
    fe.add(path, 'BASE_TYPE_BAD_LENGTH', `Must be between ${lo} and ${hi} in length.`);
  } else if (hi !== undefined && len > hi) {
    fe.add(path, 'BASE_TYPE_MAX_LENGTH', `Must be ${hi} or fewer in length.`);
  } else if (lo !== undefined && len < lo) {
    fe.add(path, 'BASE_TYPE_MIN_LENGTH', `Must be ${lo} or more in length.`);
  }
}

export function assertValid(body, schema) {
  validate(body ?? {}, schema).throwIfAny();
}
