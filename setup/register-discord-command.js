/* Run ONCE after the Discord bot exists (SETUP step 6):
     DISCORD_BOT_TOKEN=xxx DISCORD_APP_ID=yyy node register-discord-command.js
   Registers the /spidey slash command so Siddhu can talk two-way on Discord. */
const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;
if (!token || !appId) { console.error("Set DISCORD_BOT_TOKEN and DISCORD_APP_ID env vars first."); process.exit(1); }

const body = {
  name: "spidey",
  description: "Talk to Spidey (Siddhu only)",
  options: [{ name: "ask", description: "What do you want to ask Spidey?", type: 3, required: true }]
};

fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bot " + token },
  body: JSON.stringify(body)
}).then(async r => {
  console.log(r.status, await r.text());
  console.log(r.ok ? "Done — /spidey is registered. It can take up to an hour to appear in Discord." : "Failed — check token/app id.");
}).catch(e => console.error(e));
