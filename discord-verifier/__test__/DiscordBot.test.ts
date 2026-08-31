import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiscordBot, discordApplicationCommands, formatVerification } from '../src/DiscordBot.ts';
import { Verifier } from '../src/Verifier.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Discord bot', () => {
  it('publishes only connection and public verification commands for server and user installs', () => {
    expect(discordApplicationCommands).toEqual([
      { name: 'Verify Argon role', type: 2, integrationTypes: [0, 1], contexts: [0, 1, 2] },
      { name: "Verify sender's Argon role", type: 3, integrationTypes: [0, 1], contexts: [0, 1, 2] },
      {
        name: 'verify-argon-role',
        description: "Show a Discord user's proven Argon roles",
        type: 1,
        integrationTypes: [0, 1],
        contexts: [0, 1, 2],
        options: [
          {
            name: 'user',
            description: 'The Discord user to verify',
            type: 6,
            required: true,
          },
        ],
      },
      {
        name: 'connect-desktop-app',
        description: 'Create a private code to connect Argon Desktop',
        type: 1,
        integrationTypes: [0, 1],
        contexts: [0, 1, 2],
      },
    ]);
  });

  it('reports only the highest earned role for the mentioned Discord account', () => {
    const result = formatVerification({
      discordUserId: DISCORD_USER_ID,
      roles: ['treasuryUser', 'treasuryCertified', 'operationallyCertified', 'coreDeveloper'],
      createdTimestamp: 1_704_067_200_000,
    });

    expect(result).toContain('✅ Core Developer');
    expect(result).not.toContain('Treasury User');
    expect(result).not.toContain('Treasury Certified');
    expect(result).not.toContain('Operationally Certified');
    expect(result).not.toContain('Operational account');
    expect(result).not.toContain('Finalized block');
    expect(result).toContain(`Discord user: <@${DISCORD_USER_ID}>`);
    expect(result).not.toContain('(ID:');
  });

  it('keeps an unknown account result neutral', () => {
    const result = formatVerification({
      discordUserId: DISCORD_USER_ID,
      roles: [],
      createdTimestamp: 1_704_067_200_000,
      joinedTimestamp: 1_735_689_600_000,
    });

    expect(result).toContain('No proven Argon roles');
    expect(result).toContain('does not prove the account is malicious');
    expect(result).toContain('Discord account created: <t:1704067200:D> (<t:1704067200:R>)');
    expect(result).toContain('Joined Argon server: <t:1735689600:D> (<t:1735689600:R>)');
  });

  it('includes the selected account profile dates in an unknown role check', async () => {
    const verifier = new Verifier(':memory:', APPLICATION_ID, 300_000, 'ws://unused');
    const bot = new DiscordBot(verifier, {
      guildId: GUILD_ID,
      roleIds: {} as never,
      developerIds: new Set(),
    });
    const reply = vi.fn();
    const interaction = {
      commandName: 'Verify Argon role',
      targetUser: { id: DISCORD_USER_ID, createdTimestamp: 1_704_067_200_000 },
      targetMember: { joinedTimestamp: 1_735_689_600_000 },
      isUserContextMenuCommand: () => true,
      isMessageContextMenuCommand: () => false,
      isChatInputCommand: () => false,
      reply,
    };

    await (bot as any).handle(interaction);

    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Discord account created: <t:1704067200:D> (<t:1704067200:R>)'),
      }),
    );
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Joined Argon server: <t:1735689600:D> (<t:1735689600:R>)'),
      }),
    );
    await bot.close();
    await verifier.close();
  });

  it('replaces a deferred interaction response with a terminal error', async () => {
    const verifier = new Verifier(':memory:', APPLICATION_ID, 300_000, 'ws://unused');
    const bot = new DiscordBot(verifier, {
      guildId: GUILD_ID,
      roleIds: {} as never,
      developerIds: new Set(),
    });
    const interaction = {
      deferred: true,
      replied: false,
      isRepliable: () => true,
      inGuild: () => true,
      editReply: vi.fn(),
      followUp: vi.fn(),
      reply: vi.fn(),
    };

    await (bot as any).replyWithError(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Argon role verification is temporarily unavailable.' }),
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
    await bot.close();
    await verifier.close();
  });
});

const APPLICATION_ID = '123456789012345678';
const DISCORD_USER_ID = '456789012345678901';
const GUILD_ID = '678901234567890123';
