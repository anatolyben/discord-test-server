import {
  ALL_PERMISSIONS, Permissions as P, TIMED_OUT_ALLOWED, ChannelType, THREAD_TYPES,
} from './constants.js';
import { toBits } from './util.js';

// Permission computation, exactly as in
// https://discord.com/developers/docs/topics/permissions#permission-overwrites
// (compute_base_permissions / compute_overwrites pseudo-code), plus the documented
// implicit permissions and timed-out member rules.

// https://discord.com/developers/docs/topics/permissions – compute_base_permissions
export function computeBasePermissions(world, guildId, userId) {
  const guild = world.guild(guildId);
  if (!guild) return 0n;
  if (guild.owner_id === userId) return ALL_PERMISSIONS;
  const member = guild.members[userId];
  if (!member) return 0n;
  let perms = toBits(guild.roles[guildId].permissions); // @everyone
  for (const roleId of member.roles) {
    const role = guild.roles[roleId];
    if (role) perms |= toBits(role.permissions);
  }
  if (perms & P.ADMINISTRATOR) return ALL_PERMISSIONS;
  return applyTimeout(world, member, perms, guild.owner_id === userId);
}

// https://discord.com/developers/docs/topics/permissions – compute_overwrites
export function computeOverwrites(world, base, guildId, userId, channel) {
  if (base & P.ADMINISTRATOR) return ALL_PERMISSIONS;
  const guild = world.guild(guildId);
  const member = guild.members[userId];
  // Threads use their parent channel's overwrites.
  // https://discord.com/developers/docs/topics/threads#permissions
  const source = THREAD_TYPES.has(channel.type) ? world.channel(channel.parent_id) ?? channel : channel;
  const overwrites = source.permission_overwrites ?? [];
  let perms = base;

  const everyone = overwrites.find((o) => o.id === guildId);
  if (everyone) {
    perms &= ~toBits(everyone.deny);
    perms |= toBits(everyone.allow);
  }
  let allow = 0n;
  let deny = 0n;
  for (const roleId of member?.roles ?? []) {
    const o = overwrites.find((x) => x.id === roleId && x.type === 0);
    if (o) {
      allow |= toBits(o.allow);
      deny |= toBits(o.deny);
    }
  }
  perms &= ~deny;
  perms |= allow;
  const own = overwrites.find((o) => o.id === userId && o.type === 1);
  if (own) {
    perms &= ~toBits(own.deny);
    perms |= toBits(own.allow);
  }
  return perms;
}

// https://discord.com/developers/docs/topics/permissions#implicit-permissions
function applyImplicit(perms, channel) {
  if (!(perms & P.VIEW_CHANNEL)) return 0n;
  const voice = channel.type === ChannelType.GUILD_VOICE || channel.type === ChannelType.GUILD_STAGE_VOICE;
  if (voice && !(perms & P.CONNECT)) return perms & P.VIEW_CHANNEL;
  if (!(perms & P.SEND_MESSAGES) && !THREAD_TYPES.has(channel.type)) {
    perms &= ~(P.MENTION_EVERYONE | P.SEND_TTS_MESSAGES | P.ATTACH_FILES | P.EMBED_LINKS);
  }
  if (THREAD_TYPES.has(channel.type) && !(perms & P.SEND_MESSAGES_IN_THREADS)) {
    perms &= ~(P.MENTION_EVERYONE | P.SEND_TTS_MESSAGES | P.ATTACH_FILES | P.EMBED_LINKS);
  }
  return perms;
}

// https://discord.com/developers/docs/topics/permissions#permissions-for-timed-out-members
function applyTimeout(world, member, perms, isOwner) {
  if (isOwner || (perms & P.ADMINISTRATOR)) return perms;
  if (world.isTimedOut(member)) return perms & TIMED_OUT_ALLOWED;
  return perms;
}

/** Final permissions of `userId` in `guildId`, optionally inside `channelId`. */
export function computePermissions(world, guildId, userId, channelId) {
  const base = computeBasePermissions(world, guildId, userId);
  if (!channelId) return base;
  const channel = world.channel(channelId);
  if (!channel || channel.guild_id !== guildId) return 0n;
  if (base & P.ADMINISTRATOR) return ALL_PERMISSIONS;
  let perms = computeOverwrites(world, base, guildId, userId, channel);
  const member = world.member(guildId, userId);
  perms = applyTimeout(world, member, perms, world.guild(guildId).owner_id === userId);
  return applyImplicit(perms, channel);
}

export function has(perms, ...flags) {
  return flags.every((f) => (perms & f) === f);
}

/** Convert ['BAN_MEMBERS', …] | '123' | 123n into a bigint. */
export function parsePermissions(v) {
  if (Array.isArray(v)) {
    return v.reduce((acc, name) => {
      const bit = P[name];
      if (bit === undefined) throw new Error(`unknown permission ${name}`);
      return acc | bit;
    }, 0n);
  }
  return toBits(v);
}

export function permissionNames(bits) {
  bits = toBits(bits);
  return Object.entries(P).filter(([, b]) => (bits & b) === b).map(([n]) => n);
}
