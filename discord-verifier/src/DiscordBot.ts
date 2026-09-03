import {
  type ApplicationCommandDataResolvable,
  type APIInteractionDataResolvedGuildMember,
  type APIInteractionGuildMember,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  Client,
  Events,
  InteractionContextType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
  type InteractionReplyOptions,
  type GuildMember,
  type MessageContextMenuCommandInteraction,
  type UserContextMenuCommandInteraction,
  type User,
} from 'discord.js';
import { DISCORD_VERIFICATION_CONFIG, type DiscordRole } from '../../core/src/DiscordVerification.ts';
import { logError, logInfo } from './Log.ts';
import type { Verifier } from './Verifier.ts';

const installTypes = [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall];
const contexts = [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel];

export const discordApplicationCommands = [
  {
    name: 'Verify Argon role',
    type: ApplicationCommandType.User,
    integrationTypes: installTypes,
    contexts,
  },
  {
    name: "Verify sender's Argon role",
    type: ApplicationCommandType.Message,
    integrationTypes: installTypes,
    contexts,
  },
  {
    name: 'verify-argon-role',
    description: "Show a Discord user's proven Argon roles",
    type: ApplicationCommandType.ChatInput,
    integrationTypes: installTypes,
    contexts,
    options: [
      {
        name: 'user',
        description: 'The Discord user to verify',
        type: ApplicationCommandOptionType.User,
        required: true,
      },
    ],
  },
  {
    name: 'connect-desktop-app',
    description: 'Create a private code to connect Argon Desktop',
    type: ApplicationCommandType.ChatInput,
    integrationTypes: installTypes,
    contexts,
  },
] satisfies ApplicationCommandDataResolvable[];

type VerificationInteraction =
  | ChatInputCommandInteraction
  | MessageContextMenuCommandInteraction
  | UserContextMenuCommandInteraction;

export class DiscordBot {
  private readonly client = new Client({ intents: [] });

  constructor(
    private readonly verifier: Verifier,
    private readonly config: {
      guildId: string;
      roleIds: Readonly<Record<DiscordRole, string>>;
      developerIds: ReadonlySet<string>;
    },
  ) {
    this.client.on(Events.InteractionCreate, interaction => {
      const fields = {
        interactionId: interaction.id,
        interactionType: interaction.type,
        command: interaction.isCommand() ? interaction.commandName : undefined,
        guildId: interaction.guildId ?? undefined,
        channelId: interaction.channelId ?? undefined,
        discordUserId: interaction.user.id,
      };
      logInfo('discord_interaction_received', fields);
      void this.handle(interaction)
        .then(() => logInfo('discord_interaction_completed', fields))
        .catch(async error => {
          logError('discord_interaction_failed', error, fields);
          try {
            await this.replyWithError(interaction);
          } catch (replyError) {
            logError('discord_interaction_error_response_failed', replyError, fields);
          }
        });
    });
  }

  public async start(token: string): Promise<void> {
    await this.client.login(token);
    if (!this.client.application) throw new Error('Discord application did not become ready.');
    await this.client.application.commands.set(discordApplicationCommands);
    logInfo('discord_bot_started', { applicationId: this.client.application.id });
  }

  public async close(): Promise<void> {
    await this.client.destroy();
  }

  public grantRoles = async (discordUserId: string, roles: DiscordRole[]): Promise<void> => {
    const guild = await this.client.guilds.fetch(this.config.guildId);
    const member = await guild.members.fetch(discordUserId);
    await member.roles.add(roles.map(role => this.config.roleIds[role]));
  };

  private async handle(interaction: Interaction): Promise<void> {
    if (interaction.isUserContextMenuCommand() && interaction.commandName === 'Verify Argon role') {
      await this.replyWithVerification(
        interaction,
        interaction.targetUser,
        getJoinedTimestamp(interaction.targetMember),
      );
    } else if (interaction.isMessageContextMenuCommand() && interaction.commandName === "Verify sender's Argon role") {
      const message = interaction.targetMessage;
      if (message.webhookId || message.applicationId || message.author.bot) {
        await this.replyPrivately(
          interaction,
          'This message was sent by an application or webhook, not a directly verifiable person.',
        );
      } else {
        await this.replyWithVerification(interaction, message.author, message.member?.joinedTimestamp);
      }
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'verify-argon-role') {
      const user = interaction.options.getUser('user', true);
      await this.replyWithVerification(interaction, user, getJoinedTimestamp(interaction.options.getMember('user')));
    } else if (interaction.isChatInputCommand() && interaction.commandName === 'connect-desktop-app') {
      if (this.config.developerIds.has(interaction.user.id)) {
        await this.grantRoles(interaction.user.id, ['coreDeveloper']).catch(error => {
          logError('discord_core_developer_role_grant_failed', error, { discordUserId: interaction.user.id });
        });
      }
      const issued = this.verifier.issueCode(interaction.user.id, Date.now());
      await this.replyPrivately(
        interaction,
        `**Connect Argon Desktop**
1. Open Argon Desktop and choose **Connect to Discord** from the account menu.
2. Paste this private, one-time code and select **Connect Discord**:

\`${issued.code}\`

It expires <t:${Math.floor(issued.expiresAt / 1_000)}:R>. Connecting Discord does not create a transaction or move funds. Do not share this code.`,
      );
    }
  }

  private async replyWithVerification(
    interaction: VerificationInteraction,
    user: User,
    joinedTimestamp?: number | null,
  ): Promise<void> {
    await interaction.reply({
      content: formatVerification(this.verifyDiscordUser(user, joinedTimestamp)),
      allowedMentions: { parse: [] },
    });
  }

  private async replyPrivately(interaction: VerificationInteraction, content: string): Promise<void> {
    await interaction.reply({
      content,
      allowedMentions: { parse: [] },
      ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}),
    });
  }

  private verifyDiscordUser(user: User, joinedTimestamp?: number | null): IDiscordRoleVerification {
    const { id: discordUserId, createdTimestamp } = user;
    const roles: DiscordRole[] = [...(this.verifier.getVerification(discordUserId)?.roles ?? [])];
    if (this.config.developerIds.has(discordUserId)) roles.push('coreDeveloper');
    return { discordUserId, roles, createdTimestamp, joinedTimestamp };
  }

  private async replyWithError(interaction: Interaction): Promise<void> {
    if (!interaction.isRepliable()) return;
    const content = 'Argon role verification is temporarily unavailable.';
    if (interaction.deferred) {
      await interaction.editReply({ content, allowedMentions: { parse: [] } });
      return;
    }
    const response: InteractionReplyOptions = {
      content,
      allowedMentions: { parse: [] },
      ...(interaction.inGuild() ? { flags: MessageFlags.Ephemeral } : {}),
    };
    if (interaction.replied) await interaction.followUp(response);
    else await interaction.reply(response);
  }
}

interface IDiscordRoleVerification {
  discordUserId: string;
  roles: DiscordRole[];
  createdTimestamp: number;
  joinedTimestamp?: number | null;
}

export function formatVerification(verification: IDiscordRoleVerification): string {
  const lines = [`Discord user: <@${verification.discordUserId}>`];
  const highestRole = verification.roles.at(-1);
  if (highestRole) {
    lines.push(`✅ ${DISCORD_VERIFICATION_CONFIG.roleNames[highestRole]}`);
  } else {
    const createdTimestamp = Math.floor(verification.createdTimestamp / 1_000);
    lines.push(
      'ℹ️ No proven Argon roles',
      'This account has not proven one of the supported Argon roles. This does not prove the account is malicious.',
      `Discord account created: <t:${createdTimestamp}:D> (<t:${createdTimestamp}:R>)`,
    );
    if (verification.joinedTimestamp) {
      const joinedTimestamp = Math.floor(verification.joinedTimestamp / 1_000);
      lines.push(`Joined Argon server: <t:${joinedTimestamp}:D> (<t:${joinedTimestamp}:R>)`);
    }
  }
  return lines.join('\n');
}

function getJoinedTimestamp(
  member: GuildMember | APIInteractionGuildMember | APIInteractionDataResolvedGuildMember | null,
): number | null | undefined {
  if (!member) return;
  if ('joinedTimestamp' in member) return member.joinedTimestamp;
  return member.joined_at ? Date.parse(member.joined_at) : undefined;
}
