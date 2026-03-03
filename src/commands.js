/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-28m
*/

"use strict";

const { buildEmbed } = require("./embeds");
const { syncChannel } = require("./sync");
const { getChannel } = require("./storage");

const HELP_LINES = [
  "**setlocket** `<channelID>` — Set the watch channel",
  "**setnotify** `<channelID>` — Set the notification channel",
  "**setthreshold** `<number>` — Set the reaction goal",
  "**toplocket** — Show the leaderboard",
  "**locketreset** — Reset all reaction counts",
  "**locketstatus** — Show current settings",
  "**commands** — Show this list",
];

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** @param {string} id */
const isSnowflake = (id) => /^\d{17,20}$/.test(id);

/**
 * Validates a channel ID and fetches it.  Replies with an error and returns
 * null on failure so callers can just `if (!channel) return`.
 *
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client}  client
 * @param {string} channelId
 */
async function fetchValidChannel(message, client, channelId) {
  if (!isSnowflake(channelId)) {
    await message.reply(
      "❌ Invalid channel ID — must be a 17–20 digit snowflake.",
    );
    return null;
  }
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) {
    await message.reply("❌ Channel not found or the bot cannot access it.");
    return null;
  }
  return channel;
}

// ─────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────

/**
 * @param {import("discord.js").Message} message
 * @param {import("discord.js").Client}  client
 * @param {{ config, data, saveConfig, saveData, loadData, isAllowed }} ctx
 */
async function handleCommands(message, client, ctx) {
  if (message.author.bot) return;
  if (!ctx.isAllowed(message.author.id)) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0]?.toLowerCase();
  if (!cmd) return;

  switch (cmd) {
    case "commands":
      return cmdHelp(message);
    case "setlocket":
      return cmdSetLocket(message, client, args, ctx);
    case "setnotify":
      return cmdSetNotify(message, client, args, ctx);
    case "setthreshold":
      return cmdSetThreshold(message, args, ctx);
    case "toplocket":
      return cmdTopLocket(message, ctx);
    case "locketreset":
      return cmdReset(message, ctx);
    case "locketstatus":
      return cmdStatus(message, ctx);
    // Unknown commands are silently ignored.
  }
}

// ─────────────────────────────────────────────
// Command implementations
// ─────────────────────────────────────────────

async function cmdHelp(message) {
  await message.reply({
    embeds: [
      buildEmbed({ title: "📋 Commands", description: HELP_LINES.join("\n") }),
    ],
  });
}

async function cmdSetLocket(
  message,
  client,
  args,
  { config, data, saveConfig, saveData },
) {
  const channel = await fetchValidChannel(message, client, args[1]);
  if (!channel) return;

  config.watchChannelId = channel.id;
  saveConfig(config);
  await message.reply(
    `✅ Watch channel set to <#${channel.id}>. Starting sync…`,
  );

  // Run a full sync in the background so the command returns immediately.
  (async () => {
    try {
      await syncChannel(channel, data);
      await message
        .reply(`✅ Sync complete for <#${channel.id}>.`)
        .catch(() => null);
    } catch (err) {
      console.error("[setlocket:sync]", err);
    }
  })();
}

async function cmdSetNotify(message, client, args, { config, saveConfig }) {
  const channel = await fetchValidChannel(message, client, args[1]);
  if (!channel) return;

  config.notifyChannelId = channel.id;
  saveConfig(config);
  await message.reply(`✅ Notification channel set to <#${channel.id}>.`);
}

async function cmdSetThreshold(message, args, { config, saveConfig }) {
  const n = parseInt(args[1], 10);
  if (!Number.isInteger(n) || n < 1) {
    await message.reply(
      "❌ Usage: `setthreshold <number>` — must be a positive integer.",
    );
    return;
  }
  config.reactionThreshold = n;
  saveConfig(config);
  await message.reply(`✅ Goal set to **${n}** photos reacted.`);
}

async function cmdTopLocket(message, { config, loadData }) {
  const fresh = loadData();
  if (!config.watchChannelId) {
    await message.reply("❌ No watch channel set.");
    return;
  }

  const ch = getChannel(fresh, config.watchChannelId);
  const entries = Object.entries(ch.users)
    .map(([userId, u]) => ({ userId, count: u.pending.length }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  if (entries.length === 0) {
    await message.reply({
      embeds: [
        buildEmbed({
          title: "🏆 Leaderboard",
          description: "No reactions recorded yet.",
        }),
      ],
    });
    return;
  }

  const lines = entries.map(
    ({ userId, count }, i) =>
      `${i + 1}. <@${userId}> — **${count}** ${count === 1 ? "photo" : "photos"}`,
  );
  await message.reply({
    embeds: [
      buildEmbed({ title: "🏆 Leaderboard", description: lines.join("\n") }),
    ],
  });
}

async function cmdReset(message, { config, data, saveData }) {
  if (!config.watchChannelId) {
    await message.reply("❌ No watch channel set.");
    return;
  }

  const ch = getChannel(data, config.watchChannelId);
  // Clear pending counts; preserve rewarded so past cycles can't be re-earned.
  for (const user of Object.values(ch.users)) user.pending = [];
  saveData(data);
  await message.reply("✅ All current-cycle reaction counts have been reset.");
}

async function cmdStatus(message, { config }) {
  const watch = config.watchChannelId
    ? `<#${config.watchChannelId}>`
    : "*(not set)*";
  const notify = config.notifyChannelId
    ? `<#${config.notifyChannelId}>`
    : "*(not set)*";

  await message.reply({
    embeds: [
      buildEmbed({
        title: "⚙️ Bot Status",
        fields: [
          { name: "Watch channel", value: watch, inline: true },
          { name: "Notify channel", value: notify, inline: true },
          {
            name: "Goal",
            value: String(config.reactionThreshold),
            inline: true,
          },
        ],
      }),
    ],
  });
}

module.exports = { handleCommands };
