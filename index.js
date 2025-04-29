import nacl from 'tweetnacl'; // For signature verification
import { REST } from '@discordjs/rest'; // For REST API calls
import { Routes } from 'discord-api-types/v10'; // API route helpers

// Helper function to convert hex string to Uint8Array
function hexToUint8Array(hex) {
  return new Uint8Array(hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
}

export default {
  async fetch(request, env) {
    // Only accept POST requests (Discord sends POSTs)
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Parse the request body and headers
    const body = await request.json();
    const signature = request.headers.get('X-Signature-Ed25519');
    const timestamp = request.headers.get('X-Signature-Timestamp');

    // Verify the request signature using the Discord public key
    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(timestamp + JSON.stringify(body)),
      hexToUint8Array(signature),
      hexToUint8Array(env.DISCORD_PUBLIC_KEY)
    );

    if (!isValid) {
      return new Response('Invalid request signature', { status: 401 });
    }

    // Handle PING (type 1) - Discord requires this response
    if (body.type === 1) {
      return new Response(JSON.stringify({ type: 1 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle APPLICATION_COMMAND (type 2) - Slash commands
    if (body.type === 2) {
      const commandName = body.data.name;

      if (commandName === 'verify') {
        const userId = body.member.user.id; // User who invoked the command
        const guildId = env.GUILD_ID; // From your .env

        // Initialize REST client with bot token
        const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);

        try {
          // Fetch member’s current roles
          const member = await rest.get(Routes.guildMember(guildId, userId));
          const memberRoles = new Set(member.roles);

          // Check if user has the Unverified role
          if (!memberRoles.has(env.UNVERIFIED_ROLE_ID)) {
            return new Response(
              JSON.stringify({
                type: 4, // Channel message with source
                data: { content: 'You don’t need verification or are already verified.' },
              }),
              { headers: { 'Content-Type': 'application/json' } }
            );
          }

          // Remove Unverified role and add Member role
          await rest.put(Routes.guildMemberRole(guildId, userId, env.MEMBER_ROLE_ID));
          await rest.delete(Routes.guildMemberRole(guildId, userId, env.UNVERIFIED_ROLE_ID));

          // Log the event (optional: send to log channel via REST)
          await rest.post(Routes.channelMessages(env.LOG_CHANNEL_ID), {
            body: { content: `[${new Date().toISOString()}] ✅ <@${userId}> successfully verified.` },
          });

          return new Response(
            JSON.stringify({
              type: 4, // Channel message with source
              data: { content: 'You have been successfully verified! Welcome!' },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        } catch (error) {
          console.error('Error during verification:', error);
          return new Response(
            JSON.stringify({
              type: 4,
              data: { content: 'Failed to verify you. Please try again or contact an admin.' },
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    return new Response('Unknown interaction type', { status: 400 });
  },
};