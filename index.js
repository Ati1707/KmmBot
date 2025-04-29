client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== guildId || newMember.user.bot) return;

    const guild = newMember.guild;
    const botMember = guild.members.me;

    // Check bot permissions
    if (!botMember?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        console.error(`Bot lacks Manage Roles permission in ${guild.name}`);
        await logEvent(`❌ Error handling role update for ${newMember.user.tag}: Bot lacks Manage Roles permission`);
        return;
    }

    const unverifiedRole = await guild.roles.fetch(unverifiedRoleId).catch(() => null);
    const memberRole = await guild.roles.fetch(memberRoleId).catch(() => null);

    if (!unverifiedRole || !memberRole) {
        console.error('Unverified or Member role not found');
        await logEvent(`❌ Error for ${newMember.user.tag}: Missing roles`);
        return;
    }

    // Check role hierarchy
    if (unverifiedRole.position >= botMember.roles.highest.position || 
        memberRole.position >= botMember.roles.highest.position) {
        console.error('Roles are too high to manage');
        await logEvent(`❌ Error for ${newMember.user.tag}: Roles too high`);
        return;
    }

    // If member has only @everyone role and no Unverified role, assign Unverified
    if (newMember.roles.cache.size === 1 && !newMember.roles.cache.has(unverifiedRoleId)) {
        await assignUnverifiedRole(newMember, 'Role update to no roles');
    }

    // If member has a Patreon role but no Member role, assign Member
    const hasPatreonRole = patreonRoleIds.some(roleId => newMember.roles.cache.has(roleId));
    if (hasPatreonRole && !newMember.roles.cache.has(memberRoleId)) {
        try {
            await newMember.roles.add(memberRole);
            await logEvent(`✅ Added 'Member' role to ${newMember.user.tag} due to Patreon role`);
            if (newMember.roles.cache.has(unverifiedRoleId)) {
                await newMember.roles.remove(unverifiedRole);
                await logEvent(`Removed 'Unverified' role from ${newMember.user.tag}`);
            }
        } catch (error) {
            console.error(`Failed to update roles for ${newMember.user.tag}: ${error}`);
            await logEvent(`❌ Error updating ${newMember.user.tag}: ${error.message}`);
        }
    }
});