import { ChannelType, SkuType } from './constants.js';

/**
 * The demo world: two applications, two guilds, an owner, a moderator, members, channels,
 * a quarantine role and a SKU. Returns every id and token a test needs.
 */
export function seedDemoWorld(control, { botPermissions = ['ADMINISTRATOR'] } = {}) {
  const c = control;
  const owner = c.createUser({ username: 'olivia_owner', global_name: 'Olivia' });
  const moderator = c.createUser({ username: 'max_mod', global_name: 'Max' });
  const alice = c.createUser({ username: 'alice', global_name: 'Alice' });
  const bob = c.createUser({ username: 'bob', global_name: 'Bob' });
  const spammer = c.createUser({ username: 'sp4mmer', global_name: 'Totally Legit' });

  const modbot = c.createApplication({
    name: 'ModBot', ownerId: owner.id, redirectUris: ['http://localhost:3000/auth/callback'],
    privilegedIntents: { guildMembers: true, messageContent: true },
  });
  const otherApp = c.createApplication({ name: 'OtherBot', ownerId: owner.id, redirectUris: ['http://localhost:4000/callback'] });

  const guilds = [];
  for (const name of ['Demo Server', 'Second Server']) {
    const g = c.createGuild({ name, ownerId: owner.id });
    const moderatorRole = c.createRole({ guildId: g.id, name: 'Moderator', permissions: ['KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_MESSAGES', 'VIEW_AUDIT_LOG'], hoist: true });
    const memberRole = c.createRole({ guildId: g.id, name: 'Member', permissions: [] });
    const quarantine = c.createRole({ guildId: g.id, name: 'Quarantine', permissions: [], position: 1 });
    const category = c.createChannel({ guildId: g.id, name: 'Community', type: ChannelType.GUILD_CATEGORY });
    const rules = c.createChannel({ guildId: g.id, name: 'rules', type: ChannelType.GUILD_TEXT, parentId: category.id });
    const modLog = c.createChannel({
      guildId: g.id, name: 'mod-log', type: ChannelType.GUILD_TEXT,
      permissionOverwrites: [{ id: g.id, type: 0, deny: ['VIEW_CHANNEL'] }, { id: moderatorRole.id, type: 0, allow: ['VIEW_CHANNEL'] }],
    });
    const quarantineChannel = c.createChannel({
      guildId: g.id, name: 'quarantine', type: ChannelType.GUILD_TEXT,
      permissionOverwrites: [{ id: g.id, type: 0, deny: ['VIEW_CHANNEL'] }, { id: quarantine.id, type: 0, allow: ['VIEW_CHANNEL', 'SEND_MESSAGES'] }],
    });
    const voice = c.createChannel({ guildId: g.id, name: 'Voice', type: ChannelType.GUILD_VOICE, parentId: category.id });
    c.addMember({ guildId: g.id, userId: moderator.id, roles: [moderatorRole.id, memberRole.id] });
    c.addMember({ guildId: g.id, userId: alice.id, roles: [memberRole.id] });
    c.addMember({ guildId: g.id, userId: bob.id, roles: [memberRole.id] });
    c.addMember({ guildId: g.id, userId: spammer.id, roles: [] });
    // The bot sits above Moderator so it can act on everyone but the owner.
    c.installBot({ applicationId: modbot.id, guildId: g.id, permissions: botPermissions, installerId: owner.id });
    c.setBotRolePosition({ applicationId: modbot.id, guildId: g.id, position: 100 });
    const invite = c.createInvite({ guildId: g.id, inviterId: owner.id, code: guilds.length === 0 ? 'demo' : undefined });
    guilds.push({
      id: g.id, name, systemChannelId: g.system_channel_id, rulesChannelId: rules.id, modLogChannelId: modLog.id,
      quarantineChannelId: quarantineChannel.id, voiceChannelId: voice.id, categoryId: category.id,
      roles: { everyone: g.id, moderator: moderatorRole.id, member: memberRole.id, quarantine: quarantine.id },
      inviteCode: invite.code,
    });
  }
  // OtherBot only lives in the second guild – isolation is easy to observe.
  c.installBot({ applicationId: otherApp.id, guildId: guilds[1].id, permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES'], installerId: owner.id });

  const sku = c.createSku({ applicationId: modbot.id, name: 'ModBot Premium', type: SkuType.SUBSCRIPTION });
  c.registerCommand({ applicationId: modbot.id, command: { name: 'warn', description: 'Warn a member', options: [{ name: 'user', description: 'Who', type: 6, required: true }, { name: 'reason', description: 'Why', type: 3 }], integration_types: [0, 1], contexts: [0, 1, 2] } });
  c.registerCommand({ applicationId: modbot.id, command: { name: 'appeal', description: 'Appeal a ban', integration_types: [0, 1], contexts: [0, 1, 2] } });
  c.setOAuthUser({ userId: owner.id, guildId: guilds[0].id });

  return {
    users: { owner, moderator, alice, bob, spammer },
    applications: { modbot, otherApp },
    guilds,
    sku,
  };
}
