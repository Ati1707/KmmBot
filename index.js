// index.js
const { Client, GatewayIntentBits, Partials, Events, Collection, PermissionsBitField } = require('discord.js');
require('dotenv').config(); // Load environment variables from .env file

// --- Configuration ---
const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.GUILD_ID;
const unverifiedRoleId = process.env.UNVERIFIED_ROLE_ID;
const memberRoleId = process.env.MEMBER_ROLE_ID;
const verificationChannelId = process.env.VERIFICATION_CHANNEL_ID;
const logChannelId = process.env.LOG_CHANNEL_ID;

// Read comma-separated Patreon Role IDs, trim whitespace, filter empty strings, and remove duplicates
const patreonRoleIdsRaw = process.env.PATREON_ROLE_IDS || ''; // Use PATREON_ROLE_IDS or your key name from .env
const patreonRoleIds = [...new Set(patreonRoleIdsRaw.split(',') // Split by comma
                                   .map(id => id.trim())       // Remove leading/trailing whitespace
                                   .filter(id => id))];       // Remove any empty strings resulting from split

const VERIFY_COMMAND = '?verify';
const ROLE_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const PATREON_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
const MESSAGE_DELETE_DELAY = 3000; // Delay before deleting temporary bot messages (milliseconds)

// --- Input Validation ---
if (!token || !guildId || !unverifiedRoleId || !memberRoleId || !verificationChannelId || !logChannelId || patreonRoleIds.length === 0) {
    console.error('ERROR: Missing required environment variables in .env file (Token, GuildID, UnverifiedRoleID, MemberRoleID, VerificationChannelID, LogChannelID) OR PATREON_ROLE_IDS is empty/missing. Please check your configuration.');
    process.exit(1); // Exit if configuration is incomplete
}
if (patreonRoleIds.length > 0) {
    console.log(`Found ${patreonRoleIds.length} unique Patreon Role ID(s) to check: ${patreonRoleIds.join(', ')}`);
}

// --- Bot Client Initialization ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers, // Required for member join/update events and fetching members
        GatewayIntentBits.GuildMessages, // Required for reading messages
        GatewayIntentBits.MessageContent, // Required to read message content like "?verify"
    ],
    partials: [Partials.GuildMember, Partials.Message, Partials.Channel], // Necessary for some events on uncached items
});

// --- Helper Functions ---

/**
 * Logs a message to the designated log channel.
 * @param {string} message The message content to log.
 */
async function logEvent(message) {
    console.log(`[LOG] ${message}`); // Log to console as well
    try {
        const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
            const botMember = logChannel.guild.members.me;
             if (!botMember || !logChannel.permissionsFor(botMember).has(PermissionsBitField.Flags.SendMessages)) {
                console.error(`ERROR: Bot lacks Send Messages permission in log channel (${logChannelId}) or bot member data unavailable.`);
                return; // Don't try to send if no permission or member info missing
            }
            await logChannel.send(`[${new Date().toISOString()}] ${message}`);
        } else {
            console.error(`ERROR: Log channel (${logChannelId}) not found or is not a text channel.`);
        }
    } catch (error) {
        console.error(`ERROR: Failed to send log message: ${error}`);
    }
}

/**
 * Assigns the Unverified role to a member.
 * @param {import('discord.js').GuildMember} member The member to assign the role to.
 * @param {string} reason Optional reason for the log.
 */
async function assignUnverifiedRole(member, reason = 'Role check') {
    if (!member || member.user.bot) return; // Ignore bots or invalid members

    try {
        const guild = member.guild;
        if (guild.id !== guildId) return; // Ensure it's the correct guild

        const botMember = guild.members.me;
        if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
             console.error(`ERROR: Bot lacks Manage Roles permission in guild ${guild.name}. Cannot assign Unverified role.`);
             await logEvent(`❌ Error assigning 'Unverified' role to ${member.user.tag}: Bot lacks Manage Roles permission.`);
             return;
        }

        const unverifiedRole = await guild.roles.fetch(unverifiedRoleId).catch(() => null);
        if (!unverifiedRole) {
            console.error(`ERROR: Unverified role (${unverifiedRoleId}) not found in guild ${guild.name}.`);
            await logEvent(`❌ Error assigning 'Unverified' role: Role ID ${unverifiedRoleId} not found.`);
            return;
        }

        // Check if role is manageable by the bot
        if (unverifiedRole.position >= botMember.roles.highest.position) {
            console.error(`ERROR: Unverified role (${unverifiedRole.name}) is higher than or equal to the bot's highest role. Cannot assign.`);
             await logEvent(`❌ Error assigning 'Unverified' role to ${member.user.tag}: Role '${unverifiedRole.name}' is too high for the bot to manage.`);
            return;
        }

        // Check if member already has the role to avoid redundant actions/logs
        if (!member.roles.cache.has(unverifiedRoleId)) {
            await member.roles.add(unverifiedRole);
            await logEvent(`✅ Assigned 'Unverified' role to ${member.user.tag} (${member.id}). Reason: ${reason}.`);
        }
    } catch (error) {
        console.error(`ERROR: Failed to assign Unverified role to ${member.user.tag}: ${error}`);
        await logEvent(`❌ Error assigning 'Unverified' role to ${member.user.tag} (${member.id}). Reason: ${reason}. Error: ${error.message}`);
    }
}

/**
 * Checks all members and assigns Unverified role if they have no other roles (besides @everyone).
 */
async function checkAndAssignUnverifiedRoles() {
    console.log('Running periodic role check...');
    try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            console.error(`ERROR: Could not find configured guild (${guildId}).`);
            return;
        }

        const botMember = guild.members.me;
        if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
             console.error(`ERROR: Bot lacks Manage Roles permission in guild ${guild.name} during periodic check.`);
             await logEvent(`❌ Error during periodic role check: Bot lacks Manage Roles permission.`);
             return;
        }

        const unverifiedRole = await guild.roles.fetch(unverifiedRoleId).catch(() => null);
        if (!unverifiedRole) {
            console.error(`ERROR: Unverified role (${unverifiedRoleId}) not found during check.`);
            await logEvent(`❌ Error during periodic role check: Unverified Role ID ${unverifiedRoleId} not found.`);
            return;
        }
         // Check if role is manageable
        if (unverifiedRole.position >= botMember.roles.highest.position) {
            console.error(`ERROR: Unverified role (${unverifiedRole.name}) is too high for the bot to manage during periodic check.`);
            await logEvent(`❌ Error during periodic role check: Role '${unverifiedRole.name}' is too high for the bot to manage.`);
            return;
        }

        // Fetch all members to ensure cache is up-to-date
        await guild.members.fetch();

        guild.members.cache.forEach(member => {
            if (member.user.bot) return; // Skip bots

            // A user always has the @everyone role. If they only have 1 role, it's @everyone.
            // We also check they don't *already* have the unverified role before assigning.
            if (member.roles.cache.size === 1 && !member.roles.cache.has(unverifiedRoleId)) {
                 assignUnverifiedRole(member, 'Periodic no-role check');
            }
        });
        console.log('Finished periodic role check.');

    } catch (error) {
        console.error(`ERROR during periodic role check: ${error}`);
        await logEvent(`❌ Error during periodic role check: ${error.message}`);
    }
}

/**
 * Checks members with ANY of the specified Patreon roles and grants Member role if needed.
 */
async function checkPatreonMembers() {
    console.log(`Running periodic Patreon role check for IDs: ${patreonRoleIds.join(', ')}...`);
     try {
        const guild = await client.guilds.fetch(guildId);
        if (!guild) {
            console.error(`ERROR: Could not find configured guild (${guildId}) for Patreon check.`);
            return;
        }

        const botMember = guild.members.me;
         // Check bot permissions for managing roles (Member/Unverified)
        if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
             console.error(`ERROR: Bot lacks Manage Roles permission in guild ${guild.name} during Patreon check.`);
             await logEvent(`❌ Error during Patreon check: Bot lacks Manage Roles permission.`);
             return;
        }

        const memberRole = await guild.roles.fetch(memberRoleId).catch(() => null);
        const unverifiedRole = await guild.roles.fetch(unverifiedRoleId).catch(() => null); // Fetch to potentially remove it

        // Fetch all specified Patreon roles, filtering out any that couldn't be fetched
        const patreonRoles = (await Promise.all(
            patreonRoleIds.map(id => guild.roles.fetch(id).catch(() => null))
        )).filter(role => role !== null); // Keep only successfully fetched roles

        if (!memberRole) {
             console.error('ERROR: Member role not found during Patreon check.');
             await logEvent(`❌ Error during Patreon check: Could not find Member Role (${memberRoleId}).`);
             return;
        }
         if (patreonRoles.length === 0) {
             console.error('ERROR: None of the specified Patreon roles were found during Patreon check.');
             await logEvent(`❌ Error during Patreon check: Could not find any of the specified Patreon Role IDs: ${patreonRoleIds.join(', ')}.`);
             return;
         }
         // Log which patreon roles were successfully found
         // Only log if the list of found roles has changed or on first run? For now, log every time.
         // Consider adding a check to avoid spamming logs if the roles are stable.
         console.log(`Found ${patreonRoles.length} Patreon roles to check: ${patreonRoles.map(r => `'${r.name}' (${r.id})`).join(', ')}.`);


        // Check if Member/Unverified roles are manageable by the bot
        let canManageRequiredRoles = true;
        if (memberRole.position >= botMember.roles.highest.position) {
            console.error(`ERROR: Member role (${memberRole.name}) is too high for the bot to manage.`);
            await logEvent(`❌ Error during Patreon check: Role '${memberRole.name}' is too high for the bot to manage.`);
            canManageRequiredRoles = false;
        }
         if (unverifiedRole && unverifiedRole.position >= botMember.roles.highest.position) {
             console.error(`ERROR: Unverified role (${unverifiedRole.name}) is too high for the bot to manage (for removal).`);
             await logEvent(`❌ Error during Patreon check: Role '${unverifiedRole.name}' is too high for the bot to manage (for removal).`);
             canManageRequiredRoles = false;
         }
         if (!canManageRequiredRoles) return; // Stop if roles aren't manageable


        // Fetch members to ensure cache is updated
        await guild.members.fetch();

        // Find members who HAVE **ANY** of the specified Patreon roles but DON'T HAVE the Member role
        const membersToUpdate = guild.members.cache.filter(member =>
            !member.user.bot &&
            !member.roles.cache.has(memberRole.id) && // Don't have Member role
            patreonRoles.some(pRole => member.roles.cache.has(pRole.id)) // Have AT LEAST ONE of the valid Patreon roles
        );

        if (membersToUpdate.size > 0) {
             const patreonRoleNames = patreonRoles.map(r => r.name).join(" / ");
             await logEvent(`ℹ️ Found ${membersToUpdate.size} members with a required Patreon role (${patreonRoleNames}) needing Member role.`);

             for (const member of membersToUpdate.values()) {
                  // Find which specific Patreon role(s) the user has (for logging)
                  const memberPatreonRoles = patreonRoles.filter(pRole => member.roles.cache.has(pRole.id));
                  const memberPatreonRoleNames = memberPatreonRoles.map(r => `'${r.name}'`).join(', ');

                 try {
                     // Add Member role
                     await member.roles.add(memberRole);
                     let logMsg = `✅ Automatically assigned 'Member' role to ${member.user.tag} (${member.id}) due to having Patreon role(s): ${memberPatreonRoleNames}.`;

                     // Remove Unverified role if they have it AND the role exists/is manageable
                     if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
                         await member.roles.remove(unverifiedRole);
                         logMsg += ` Removed 'Unverified' role.`;
                     }
                     await logEvent(logMsg);

                 } catch (error) {
                     console.error(`ERROR: Failed to update roles for Patreon member ${member.user.tag}: ${error}`);
                     await logEvent(`❌ Error updating roles for Patreon member ${member.user.tag} (${member.id}) (Patreon roles: ${memberPatreonRoleNames}): ${error.message}`);
                 }
             }
        } else {
            console.log('No members found needing update based on specified Patreon roles.');
        }
        console.log('Finished periodic Patreon role check.');

    } catch (error) {
        console.error(`ERROR during Patreon role check: ${error}`);
        await logEvent(`❌ Error during periodic Patreon check: ${error.message}`);
    }
}


// --- Event Handlers ---

// Bot Ready Event
client.once(Events.ClientReady, async c => {
    console.log(`🎉 Logged in as ${c.user.tag}! Bot ID: ${c.user.id}`);
    await logEvent(`🤖 Bot online and ready. Monitoring Guild ID: ${guildId}`);

    // --- Initial Checks & Start Periodic Tasks ---
    try {
        // Perform initial checks immediately on startup
        await checkAndAssignUnverifiedRoles();
        await checkPatreonMembers();

        // Start periodic checks
        setInterval(checkAndAssignUnverifiedRoles, ROLE_CHECK_INTERVAL);
        setInterval(checkPatreonMembers, PATREON_CHECK_INTERVAL);
        logEvent(`⏰ Started periodic tasks: Role Check (${ROLE_CHECK_INTERVAL / 60000} mins), Patreon Check (${PATREON_CHECK_INTERVAL / 3600000} hours).`);

    } catch (error) {
        console.error(`ERROR during initial checks or starting timers: ${error}`);
        await logEvent(`❌ FATAL: Error during startup tasks: ${error.message}`);
    }
});

// Member Join Event
client.on(Events.GuildMemberAdd, async member => {
    if (member.guild.id !== guildId) return; // Ignore joins in other guilds
    if (member.user.bot) return; // Ignore bots joining

    console.log(`Member joined: ${member.user.tag} (${member.id})`);

    // 1. Assign Unverified Role
    await assignUnverifiedRole(member, 'New member join');

    // 2. Send Welcome Message to Verification Channel
    try {
        const verificationChannel = await client.channels.fetch(verificationChannelId).catch(() => null);
        if (verificationChannel && verificationChannel.isTextBased()) {
            // Check bot permissions in the verification channel
             const botMember = verificationChannel.guild.members.me;
             if (!botMember || !verificationChannel.permissionsFor(botMember).has(PermissionsBitField.Flags.SendMessages)) {
                console.error(`ERROR: Bot lacks Send Messages permission in verification channel (${verificationChannelId}). Cannot send welcome.`);
                await logEvent(`❌ Failed to send welcome message to ${member.user.tag}: Bot lacks Send Messages permission in channel ${verificationChannel.name}.`);
             } else {
                 await verificationChannel.send(`Welcome ${member.user.toString()}! Please type \`${VERIFY_COMMAND}\` in this channel to get access to the server.`);
                 await logEvent(`✉️ Sent welcome message to ${member.user.tag} (${member.id}) in channel #${verificationChannel.name}.`);
             }
        } else {
            console.error(`ERROR: Verification channel (${verificationChannelId}) not found or is not text-based. Cannot send welcome message.`);
            await logEvent(`❌ Failed to send welcome message to ${member.user.tag}: Verification channel (${verificationChannelId}) not found or not text-based.`);
        }
    } catch (error) {
        console.error(`ERROR: Failed to send welcome message for ${member.user.tag}: ${error}`);
        await logEvent(`❌ Error sending welcome message for ${member.user.tag} (${member.id}): ${error.message}`);
    }
});

// Message Create Event (for ?verify command)
client.on(Events.MessageCreate, async message => {
    // Basic checks: Not a bot, in the correct guild, in the correct channel, is the verify command
    if (message.author.bot || !message.guild || message.guild.id !== guildId || message.channel.id !== verificationChannelId || message.content.trim().toLowerCase() !== VERIFY_COMMAND) return;

    const member = message.member; // Get GuildMember object for the author
    if (!member) {
        // This case is rare in guild channels but good practice to check
        console.error(`ERROR: Could not find member object for message author ${message.author.tag} in verification channel.`);
        await logEvent(`❌ Verification Error for ${message.author.tag}: Could not resolve GuildMember object.`);
        // Attempt to delete the invalid command message anyway if possible
        message.delete().catch(e => console.warn(`Could not delete invalid verify command (no member): ${e.message}`));
        return;
    }

    console.log(`Verification attempt by ${member.user.tag} (${member.id}) in channel ${message.channel.name}`);

    try {
        const guild = member.guild;
        const botMember = guild.members.me; // The bot's member object in the guild

        // --- Permission Checks ---
        let canManageRoles = true;
        let canManageMessages = false; // Assume cannot delete initially
        let canReadHistory = false;   // Assume cannot read history initially

        // Check Manage Roles permission (essential for core function)
        if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
            console.error(`ERROR: Bot lacks Manage Roles permission. Cannot verify.`);
            await logEvent(`❌ Verification Error for ${member.user.tag}: Bot lacks Manage Roles permission.`);
            await message.reply("I don't have the permissions to manage roles. Please contact an admin.").catch(console.error);
            canManageRoles = false;
        }

        // Check Manage Messages permission (for cleanup)
        if (message.channel.permissionsFor(botMember).has(PermissionsBitField.Flags.ManageMessages)) {
            canManageMessages = true;
        } else {
            console.warn(`WARN: Bot lacks Manage Messages permission in verification channel. Messages will not be deleted.`);
            await logEvent(`⚠️ Verification Warning for ${member.user.tag}: Bot lacks Manage Messages permission in channel #${message.channel.name}. Messages will not be deleted.`);
        }

        // Check Read Message History permission (needed to find welcome message)
        if (message.channel.permissionsFor(botMember).has(PermissionsBitField.Flags.ReadMessageHistory)) {
             canReadHistory = true;
        } else {
             console.warn(`WARN: Bot lacks Read Message History permission in verification channel. Cannot search for welcome message.`);
             await logEvent(`⚠️ Verification Warning for ${member.user.tag}: Bot lacks Read Message History. Cannot find/delete welcome message.`);
        }

        // Stop if cannot manage roles (core function)
        if (!canManageRoles) {
             // Attempt to delete the trigger message if possible, even if roles can't be managed
             if(canManageMessages) message.delete().catch(e => console.warn(`Could not delete user command after role perm failure: ${e.message}`));
             return;
        }


        // --- Try to find the Bot's Welcome Message for this user ---
        let welcomeMessageToDelete = null;
        if (canReadHistory && canManageMessages) { // Need both to find and delete
            try {
                // Fetch recent messages, don't rely on cache for this dynamic search
                const recentMessages = await message.channel.messages.fetch({ limit: 50, cache: false });
                welcomeMessageToDelete = recentMessages.find(m =>
                    m.author.id === client.user.id && // Message is from this bot
                    m.content.includes(member.user.toString()) && // Mentions the user who typed ?verify
                    m.content.startsWith('Welcome') // Basic check it's the right type of message
                );
                if (welcomeMessageToDelete) {
                    console.log(`Found potential welcome message to delete for ${member.user.tag} (ID: ${welcomeMessageToDelete.id})`);
                }
            } catch (err) {
                console.warn(`WARN: Could not fetch recent messages to find welcome message: ${err.message}`);
                await logEvent(`⚠️ Warning searching for welcome message for ${member.user.tag}: ${err.message}`);
            }
        }


        // --- Fetch Roles & Check Hierarchy ---
        const unverifiedRole = await guild.roles.fetch(unverifiedRoleId).catch(() => null);
        const memberRole = await guild.roles.fetch(memberRoleId).catch(() => null);

        // Check if essential roles exist
        if (!unverifiedRole || !memberRole) {
            console.error('ERROR: Unverified or Member role not found during verification.');
            await logEvent(`❌ Verification Error for ${member.user.tag}: Could not find Unverified Role (${unverifiedRoleId}) or Member Role (${memberRoleId}).`);
            await message.reply("Something went wrong with the roles on the server. Please contact an admin.").catch(console.error);
            // Clean up the trigger message even on failure if possible
            if (canManageMessages) {
                message.delete().catch(e => console.warn(`Could not delete user command after role fetch failure: ${e.message}`));
            }
            return;
        }

        // Role Hierarchy checks - Ensure bot can manage both roles
        let rolesAreManageable = true;
         if (unverifiedRole.position >= botMember.roles.highest.position) {
             console.error(`ERROR: Unverified role (${unverifiedRole.name}) is too high for the bot to manage.`);
             await logEvent(`❌ Verification Error for ${member.user.tag}: Role '${unverifiedRole.name}' is too high to remove.`);
             rolesAreManageable = false;
         }
        if (memberRole.position >= botMember.roles.highest.position) {
             console.error(`ERROR: Member role (${memberRole.name}) is too high for the bot to manage.`);
             await logEvent(`❌ Verification Error for ${member.user.tag}: Role '${memberRole.name}' is too high to add.`);
             rolesAreManageable = false;
         }
        if (!rolesAreManageable) {
            await message.reply("I cannot manage the required roles due to hierarchy issues. Please contact an admin.").catch(console.error);
            // Clean up the trigger message even on failure if possible
             if (canManageMessages) {
                message.delete().catch(e => console.warn(`Could not delete user command after hierarchy failure: ${e.message}`));
            }
            return;
        }


        // --- Check if user actually needs verification (has Unverified role) ---
        if (!member.roles.cache.has(unverifiedRoleId)) {
            await logEvent(`ℹ️ ${member.user.tag} (${member.id}) used ${VERIFY_COMMAND} but does not have the 'Unverified' role. Cleaning up messages.`);
            const replyMsg = await message.reply("You don't seem to need verification or are already verified.").catch(console.error);

            // --- Cleanup messages for non-verified user ---
            if (canManageMessages) {
                 // Delete user's command immediately
                message.delete().catch(e => console.warn(`(No verify needed) Could not delete user command: ${e.message}`));
                 // Delete the welcome message if found immediately
                if (welcomeMessageToDelete) {
                    welcomeMessageToDelete.delete().catch(e => console.warn(`(No verify needed) Could not delete welcome message: ${e.message}`));
                    await logEvent(`🧹 Deleted welcome message for ${member.user.tag} (user didn't need verification).`);
                } else {
                    // Log if we couldn't find it (and had perms to look)
                    if (canReadHistory) await logEvent(`🧹 Note: Could not find welcome message for ${member.user.tag} to delete (user didn't need verification).`);
                }
                 // Delete the bot's reply after a delay
                if (replyMsg) {
                    setTimeout(() => replyMsg.delete().catch(e => console.warn(`(No verify needed) Could not delete bot reply: ${e.message}`)), MESSAGE_DELETE_DELAY);
                }
            }
            return; // Stop processing, user didn't need verification
        }

        // --- User Needs Verification: Perform Role Changes ---
        await member.roles.remove(unverifiedRole);
        await member.roles.add(memberRole);
        await logEvent(`✅ ${member.user.tag} (${member.id}) successfully verified using ${VERIFY_COMMAND}. Removed 'Unverified', added 'Member'.`);

        // --- Send Confirmation & Clean up messages ---
        const confirmationMessage = await message.reply("You have been successfully verified! Welcome! Cleaning up messages...").catch(console.error);

        // --- Delete User's Messages AND Welcome Message ---
        if (canManageMessages) {
            try {
                // Delete the welcome message first (individual delete, if found)
                if (welcomeMessageToDelete) {
                    await welcomeMessageToDelete.delete().catch(e => console.warn(`(Verify success) Could not delete welcome message: ${e.message}`));
                    await logEvent(`🧹 Deleted welcome message for ${member.user.tag} after successful verification.`);
                } else {
                     // Log if we couldn't find it (and had perms to look)
                    if (canReadHistory) await logEvent(`🧹 Note: Could not find welcome message for ${member.user.tag} to delete (verification success).`);
                }

                // Fetch and delete user's messages (bulk or single) - Includes the original ?verify command
                // Fetch fresh again to ensure we catch everything since the command was sent
                const messagesToDelete = await message.channel.messages.fetch({ limit: 100, cache: false });
                const userMessages = messagesToDelete.filter(m => m.author.id === member.id);

                if (userMessages.size > 0) {
                    if (userMessages.size === 1) { await userMessages.first().delete(); }
                    else { await message.channel.bulkDelete(userMessages, true); } // true = skip 14 day check client side
                    await logEvent(`🧹 Deleted ${userMessages.size} message(s) from ${member.user.tag} in #${message.channel.name} after verification.`);
                }

                // Delete confirmation message after delay
                if (confirmationMessage) {
                     setTimeout(() => confirmationMessage.delete().catch(e => console.warn(`(Verify success) Could not delete confirmation message: ${e.message}`)), MESSAGE_DELETE_DELAY);
                 }

            } catch (error) {
                console.error(`ERROR: Failed to delete messages for ${member.user.tag} after verification: ${error}`);
                 if (error.code === 50034) { // DiscordAPIError Code for messages older than 14 days
                     await logEvent(`⚠️ Could not bulk delete messages for ${member.user.tag}: Some messages were older than 14 days.`);
                 } else {
                    await logEvent(`❌ Error deleting messages for ${member.user.tag} in #${message.channel.name}: ${error.message}`);
                 }
                 // Update/delete confirmation message even if cleanup failed partially
                 if(confirmationMessage) {
                     // Avoid editing if the original send failed
                     confirmationMessage.edit("You have been successfully verified! Welcome! (Could not clear all old messages).").catch(console.error);
                     // Delete it slightly later to allow user to see the error notice
                     setTimeout(() => confirmationMessage.delete().catch(e => console.warn(`Could not delete confirmation message after cleanup error: ${e.message}`)), MESSAGE_DELETE_DELAY + 2000);
                 }
            }
        } else {
            // If cannot manage messages, still log it and maybe delete the confirmation message after delay
             await logEvent(`🧹 Could not delete messages for ${member.user.tag}: Bot lacks Manage Messages permission.`);
             if (confirmationMessage) {
                 setTimeout(() => confirmationMessage.delete().catch(e => console.warn(`Could not delete confirmation message (no delete perms): ${e.message}`)), MESSAGE_DELETE_DELAY);
             }
        }

    } catch (error) {
        // Catch any unexpected errors during the process
        console.error(`ERROR: Failed to process verification for ${member.user.tag}: ${error}`);
        await logEvent(`❌ Top-level error during verification for ${member.user.tag} (${member.id}): ${error.message}`);
        // Try to notify user of general error
        await message.reply("An unexpected error occurred while trying to verify you. Please contact an admin.").catch(console.error);
        // Attempt to delete the trigger message even on top-level failure if possible
         if (message.channel.permissionsFor(message.guild.members.me).has(PermissionsBitField.Flags.ManageMessages)) {
             message.delete().catch(e => console.warn(`Could not delete user command after top-level error: ${e.message}`));
        }
    }
});


// --- Login ---
client.login(token);

// --- Graceful Shutdown ---
process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down bot...');
    logEvent('🔌 Bot shutting down gracefully (SIGINT).');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down bot...');
    logEvent('🔌 Bot shutting down gracefully (SIGTERM).');
    client.destroy();
    process.exit(0);
});

console.log('Bot script loaded. Attempting to log in...');