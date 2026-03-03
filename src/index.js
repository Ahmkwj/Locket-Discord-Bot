"use strict";

require("dotenv").config();

/**
 * index.js — entry point
 *
 * Gateway intents required:
 *   Guilds | GuildMessages | MessageContent | GuildMessageReactions
 *
 * Developer Portal — enable both:
 *   ✅  Message Content Intent
 *   ✅  Server Members Intent
 *
 * Invite integer: 395137336384
 *
 * Admin trigger: type  setlocket  in any channel the bot can see.
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");

const {
  loadConfig,
  saveConfig,
  loadData,
  saveData,
  isAllowed,
} = require("./storage");
const {
  checkDuplicatePhoto,
  registerPhotoSignatures,
  handleDuplicatePhoto,
} = require("./duplicates");
const { onReactionAdd } = require("./reactions");
const { syncChannel } = require("./sync");
const {
  handleSettingsCommand,
  handleSettingsInteraction,
} = require("./settings");

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error("[boot] FATAL — could not load config:", err.message);
  process.exit(1);
}

// data is loaded once and mutated in-place throughout the process lifetime.
// Every module that writes data calls saveData(data) after mutating.
const data = loadData();
console.log("[boot] config and data loaded");

// ─────────────────────────────────────────────
// Discord client
// ─────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// ─────────────────────────────────────────────
// Ready
// ─────────────────────────────────────────────

client.once("ready", async () => {
  console.log(`[boot] logged in as ${client.user.tag}`);

  if (config.watchChannelId) {
    const ch = await client.channels
      .fetch(config.watchChannelId)
      .catch(() => null);
    if (ch) {
      console.log(`[boot] starting startup sync for #${ch.name}`);
      // Fire-and-forget — errors are caught inside syncChannel
      syncChannel(ch, data, config).catch((err) =>
        console.error("[sync]", err),
      );
    } else {
      console.warn(
        `[boot] could not fetch watch channel ${config.watchChannelId}`,
      );
    }
  } else {
    console.log(
      "[boot] no watch channel configured — type setlocket to set one up",
    );
  }

  console.log("[boot] ready");
});

// ─────────────────────────────────────────────
// Reactions
// ─────────────────────────────────────────────

client.on("messageReactionAdd", async (reaction, user) => {
  try {
    await onReactionAdd(reaction, user, client, config, data, saveData);
  } catch (err) {
    console.error("[event:reactionAdd]", err);
  }
});

// ─────────────────────────────────────────────
// Messages
// ─────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    const isWatchChannel =
      config.watchChannelId && message.channel.id === config.watchChannelId;

    // ── Duplicate photo guard ──────────────────────────────────────────────
    if (isWatchChannel && message.attachments.size > 0) {
      if (checkDuplicatePhoto(message, config, data, saveData)) {
        await handleDuplicatePhoto(message, client, config);
        return; // Don't process this message further
      }
      registerPhotoSignatures(message, config, data, saveData);
    }

    // ── Admin commands ─────────────────────────────────────────────────────
    if (!isAllowed(config, message.author.id)) return;

    const cmd = message.content.trim().toLowerCase();
    if (cmd === "setlocket") {
      await handleSettingsCommand(message, config);
    }
  } catch (err) {
    console.error("[event:messageCreate]", err);
  }
});

// ─────────────────────────────────────────────
// Interactions  (buttons + modals from the settings panel)
// ─────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton() || interaction.isModalSubmit()) {
      await handleSettingsInteraction(
        interaction,
        client,
        config,
        data,
        saveConfig,
        saveData,
      );
    }
  } catch (err) {
    console.error("[event:interaction]", err);
    // Reply with an error if we haven't already
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: "❌ حدث خطأ غير متوقع، يرجى المحاولة مرة أخرى.",
          ephemeral: false,
        })
        .catch(() => null);
    }
  }
});

// ─────────────────────────────────────────────
// Process safety net
// ─────────────────────────────────────────────

process.on("unhandledRejection", (err) =>
  console.error("[unhandledRejection]", err),
);
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  setTimeout(() => process.exit(1), 500);
});

// ─────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────

client.login(config.token).catch((err) => {
  console.error("[boot] FATAL — login failed:", err.message);
  process.exit(1);
});
