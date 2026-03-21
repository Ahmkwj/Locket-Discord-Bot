"use strict";

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} = require("discord.js");

const { buildEmbed } = require("./embeds");
const { syncChannel } = require("./sync");
const { getChannel, isOwner, isAllowed } = require("./storage");

const B = {
  WATCH: "s_watch",
  NOTIFY: "s_notify",
  THRESHOLD: "s_goal",
  RESET: "s_reset",
  DASHBOARD: "s_dash",
  TOP_PHOTO: "s_topphoto",
  MOD_ADD: "s_modadd",
  MOD_REMOVE: "s_modrem",
  MOD_LIST: "s_modlist",
};

// These IDs are owned by the awaitMessageComponent collector inside B.TOP_PHOTO.
// They must NOT be handled by the normal switch or the error handler will
// double-reply and crash the collector.
const COLLECTOR_IDS = new Set(["confirm_top", "cancel_top"]);

const M = {
  WATCH: "m_watch",
  NOTIFY: "m_notify",
  THRESHOLD: "m_goal",
  MOD_ADD: "m_modadd",
  MOD_REMOVE: "m_modrem",
};

const F = "f_val";
const SNOWFLAKE_RE = /^\d{17,20}$/;

// ─────────────────────────────────────────────
// Embeds
// ─────────────────────────────────────────────

function buildSettingsEmbed(cfg) {
  const ch = (id) => (id ? `<#${id}>` : "Not set");
  const mods = cfg.modIds.length
    ? cfg.modIds.map((id) => `<@${id}>`).join(", ")
    : "None";

  return buildEmbed({
    title: "Locket Control Panel",
    description: "Use the buttons below to update bot settings.",
    fields: [
      { name: "Watch Channel", value: ch(cfg.watchChannelId), inline: true },
      { name: "Notify Channel", value: ch(cfg.notifyChannelId), inline: true },
      { name: "Goal", value: `${cfg.reactionThreshold} points`, inline: true },
      { name: "Mods", value: mods, inline: false },
    ],
    footer: `Owner: ${cfg.ownerId} | Type setlocket to reopen this panel`,
  });
}

function buildDashboardEmbed(cfg, data) {
  if (!cfg.watchChannelId) {
    return buildEmbed({
      title: "Leaderboard",
      description: "Watch channel is not set.",
    });
  }

  const ch = getChannel(data, cfg.watchChannelId);
  const medals = ["🥇", "🥈", "🥉"];
  const entries = Object.entries(ch.users)
    .map(([uid, u]) => ({ uid, points: u.points, cycles: u.cycles }))
    .filter((e) => e.points > 0 || e.cycles > 0)
    .sort((a, b) => b.points - a.points || b.cycles - a.cycles)
    .slice(0, 20);

  if (entries.length === 0) {
    return buildEmbed({ title: "Leaderboard", description: "No scores yet." });
  }

  const lines = entries.map(({ uid, points, cycles }, i) => {
    const rank = medals[i] ?? `${i + 1}.`;
    const cyclesText = cycles > 0 ? ` | Cycles: ${cycles}` : "";
    return `${rank} <@${uid}> — **${points}** pts${cyclesText}`;
  });

  return buildEmbed({
    title: "Leaderboard",
    description: lines.join("\n"),
    fields: [
      {
        name: "Current Goal",
        value: `${cfg.reactionThreshold} points`,
        inline: true,
      },
    ],
    footer: "Updates on each reaction",
  });
}

// ─────────────────────────────────────────────
// Button rows
// ─────────────────────────────────────────────

function buildRows(cfg, ownerViewing) {
  const row1 = new ActionRowBuilder().addComponents(
    btn(B.WATCH, "Set Watch Channel", ButtonStyle.Primary),
    btn(B.NOTIFY, "Set Notify Channel", ButtonStyle.Primary),
    btn(B.THRESHOLD, "Set Goal", ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    btn(B.RESET, "Reset Scores", ButtonStyle.Danger),
    btn(B.DASHBOARD, "View Leaderboard", ButtonStyle.Secondary),
    btn(B.TOP_PHOTO, "🏆 Top Photo", ButtonStyle.Success),
  );

  const rows = [row1, row2];

  if (ownerViewing) {
    rows.push(
      new ActionRowBuilder().addComponents(
        btn(B.MOD_ADD, "Add Mod", ButtonStyle.Secondary),
        btn(B.MOD_REMOVE, "Remove Mod", ButtonStyle.Secondary),
        btn(B.MOD_LIST, "List Mods", ButtonStyle.Secondary),
      ),
    );
  }

  return rows;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const btn = (id, label, style) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

function modal(customId, title, label, placeholder, minLen = 1, maxLen = 20) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(F)
          .setLabel(label)
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder(placeholder)
          .setMinLength(minLen)
          .setMaxLength(maxLen),
      ),
    );
}

async function resolveChannel(interaction, client, rawId) {
  if (!SNOWFLAKE_RE.test(rawId)) {
    await interaction.reply({
      content: "Invalid channel ID.",
      ephemeral: false,
    });
    return null;
  }
  const ch = await client.channels.fetch(rawId).catch(() => null);
  if (!ch) {
    await interaction.reply({
      content: "Channel not found or inaccessible.",
      ephemeral: false,
    });
    return null;
  }
  return ch;
}

async function refreshPanel(interaction, cfg, ownerViewing) {
  await interaction.message
    ?.edit({
      embeds: [buildSettingsEmbed(cfg)],
      components: buildRows(cfg, ownerViewing),
    })
    .catch(() => null);
}

// ─────────────────────────────────────────────
// Top-photo finder
// Tries candidates in order until one has a reachable image URL.
// Returns null if nothing found.
// ─────────────────────────────────────────────

async function findTopPhoto(candidates, watchCh) {
  for (const [msgId, meta] of candidates) {
    let msg;
    try {
      msg = await watchCh.messages.fetch(msgId);
    } catch {
      continue; // message was deleted — try next
    }

    // Prefer live attachment URL (never expires) → embed image → stored URL
    const url =
      msg.attachments.first()?.url ??
      msg.embeds.find((e) => e.image?.url)?.image?.url ??
      msg.embeds.find((e) => e.thumbnail?.url)?.thumbnail?.url ??
      (meta.imageUrl || null);

    if (!url) continue;

    // Total emoji reactions (sum of all reaction counts on this message)
    const totalReactions = msg.reactions.cache.reduce(
      (sum, r) => sum + r.count,
      0,
    );

    return { msgId, meta, msg, url, totalReactions };
  }
  return null;
}

// ─────────────────────────────────────────────
// Command entry point (setlocket text trigger)
// ─────────────────────────────────────────────

async function handleSettingsCommand(message, cfg) {
  if (!isAllowed(cfg, message.author.id)) return;
  const owner = isOwner(cfg, message.author.id);

  await message.reply({
    embeds: [buildSettingsEmbed(cfg)],
    components: buildRows(cfg, owner),
  });
}

// ─────────────────────────────────────────────
// Interaction handler (buttons + modals)
// ─────────────────────────────────────────────

async function handleSettingsInteraction(
  interaction,
  client,
  cfg,
  data,
  saveConfig,
  saveData,
) {
  // ── Collector-owned buttons — do NOT touch them here. The awaitMessageComponent
  //    collector inside B.TOP_PHOTO will call i.update() within milliseconds.
  //    If we reply here first, that update would throw "already replied".
  if (interaction.isButton() && COLLECTOR_IDS.has(interaction.customId)) return;

  if (!isAllowed(cfg, interaction.user.id)) {
    await interaction.reply({
      content: "You are not allowed to use this panel.",
      ephemeral: false,
    });
    return;
  }

  const owner = isOwner(cfg, interaction.user.id);

  // ── Buttons ────────────────────────────────────────────────────────────────

  if (interaction.isButton()) {
    switch (interaction.customId) {
      case B.WATCH:
        return interaction.showModal(
          modal(
            M.WATCH,
            "Set Watch Channel",
            "Channel ID",
            "123456789012345678",
            17,
            20,
          ),
        );

      case B.NOTIFY:
        return interaction.showModal(
          modal(
            M.NOTIFY,
            "Set Notify Channel",
            "Channel ID",
            "123456789012345678",
            17,
            20,
          ),
        );

      case B.THRESHOLD:
        return interaction.showModal(
          modal(
            M.THRESHOLD,
            "Set Goal",
            `Goal points (current: ${cfg.reactionThreshold})`,
            "100",
            1,
            6,
          ),
        );

      case B.RESET: {
        if (!cfg.watchChannelId) {
          return interaction.reply({
            content: "Watch channel is not set.",
            ephemeral: false,
          });
        }
        const ch = getChannel(data, cfg.watchChannelId);
        for (const u of Object.values(ch.users)) {
          u.pending = [];
          u.points = 0;
        }
        saveData(data);
        await interaction.reply({
          content: "All scores have been reset.",
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);
      }

      case B.DASHBOARD:
        return interaction.reply({
          embeds: [buildDashboardEmbed(cfg, data)],
          ephemeral: false,
        });

      // ── Top Photo ────────────────────────────────────────────────────────────
      case B.TOP_PHOTO: {
        if (!cfg.watchChannelId) {
          return interaction.reply({
            content: "❌ لم يتم تحديد قناة المشاهدة.",
            ephemeral: false,
          });
        }
        if (!cfg.notifyChannelId) {
          return interaction.reply({
            content: "❌ لم يتم تحديد قناة الإشعارات (مطلوبة للمعاينة).",
            ephemeral: false,
          });
        }

        await interaction.deferReply({ ephemeral: false });

        try {
          const ch = getChannel(data, cfg.watchChannelId);
          const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

          // Sort by unique reactors descending, last 7 days only
          const candidates = Object.entries(ch.messages)
            .filter(
              ([, m]) => m.postedAt >= sevenDaysAgo && m.reactorIds.length > 0,
            )
            .sort(([, a], [, b]) => b.reactorIds.length - a.reactorIds.length);

          if (candidates.length === 0) {
            return interaction.editReply({
              content: "❌ لا توجد صور تفاعل عليها أحد خلال آخر 7 أيام.",
            });
          }

          const [watchCh, notifyCh] = await Promise.all([
            client.channels.fetch(cfg.watchChannelId).catch(() => null),
            client.channels.fetch(cfg.notifyChannelId).catch(() => null),
          ]);

          if (!watchCh)
            return interaction.editReply({
              content: "❌ تعذّر الوصول إلى قناة المشاهدة.",
            });
          if (!notifyCh)
            return interaction.editReply({
              content: "❌ تعذّر الوصول إلى قناة الإشعارات.",
            });

          // Walk candidates until we find one with a live, fetchable image
          const found = await findTopPhoto(candidates, watchCh);

          if (!found) {
            return interaction.editReply({
              content: "❌ لم أتمكن من العثور على صورة صالحة خلال آخر 7 أيام.",
            });
          }

          const { meta, url, totalReactions } = found;
          const authorId = meta.authorId;

          // Derive a clean filename from the URL (strip query params)
          const filename =
            url.split("/").pop()?.split("?")[0] || "top-photo.jpg";

          // Text only — image is sent as a real file attachment so it always renders
          const msgText = [
            `🏆 **أفضل صورة خلال آخر 7 أيام!**`,
            ``,
            `صاحب الصورة ${authorId ? `<@${authorId}>` : "غير معروف"}، وقد حققت ${totalReactions} تفاعل ❤️`,
            ``,
            `@here`,
          ].join("\n");

          const confirmRow = new ActionRowBuilder().addComponents(
            btn("confirm_top", "✅ إرسال", ButtonStyle.Success),
            btn("cancel_top", "❌ إلغاء", ButtonStyle.Danger),
          );

          // Preview: identical to the final send, just with buttons attached
          const previewMsg = await notifyCh.send({
            content: msgText,
            files: [new AttachmentBuilder(url, { name: filename })],
            components: [confirmRow],
          });

          await interaction.editReply({
            content: `📨 تم إرسال المعاينة في <#${cfg.notifyChannelId}> — وافق أو ارفض من هناك.`,
          });

          // ── Collect the approve / cancel click ──────────────────────────────
          previewMsg
            .awaitMessageComponent({
              filter: (i) =>
                (i.customId === "confirm_top" || i.customId === "cancel_top") &&
                isAllowed(cfg, i.user.id),
              time: 120_000,
            })
            .then(async (i) => {
              if (i.customId === "confirm_top") {
                // Re-upload the image — can't reuse the attachment from the preview message
                await watchCh.send({
                  content: msgText,
                  files: [new AttachmentBuilder(url, { name: filename })],
                  allowedMentions: { parse: ["everyone"] },
                });
                await i.update({
                  content: msgText + `\n\n✅ **تم الإرسال.**`,
                  components: [],
                });
              } else {
                await i.update({
                  content: msgText + `\n\n❌ **تم الإلغاء.**`,
                  components: [],
                });
              }
            })
            .catch(async () => {
              await previewMsg
                .edit({
                  content: msgText + `\n\n⏱️ **انتهت مهلة الموافقة.**`,
                  components: [],
                })
                .catch(() => null);
            });

          return; // collector runs async — we're done here
        } catch (err) {
          console.error("[top-photo]", err);
          return interaction.editReply({
            content: "❌ حدث خطأ غير متوقع أثناء البحث عن الصورة.",
          });
        }
      }

      case B.MOD_ADD:
        if (!owner)
          return interaction.reply({
            content: "Only the owner can do this.",
            ephemeral: false,
          });
        return interaction.showModal(
          modal(M.MOD_ADD, "Add Mod", "User ID", "123456789012345678", 17, 20),
        );

      case B.MOD_REMOVE:
        if (!owner)
          return interaction.reply({
            content: "Only the owner can do this.",
            ephemeral: false,
          });
        return interaction.showModal(
          modal(
            M.MOD_REMOVE,
            "Remove Mod",
            "User ID",
            "123456789012345678",
            17,
            20,
          ),
        );

      case B.MOD_LIST: {
        if (!owner)
          return interaction.reply({
            content: "Only the owner can do this.",
            ephemeral: false,
          });
        const list = cfg.modIds.length
          ? cfg.modIds.map((id) => `<@${id}>`).join(", ")
          : "None";
        return interaction.reply({
          content: `Mods: ${list}`,
          ephemeral: false,
        });
      }
    }
  }

  // ── Modals ─────────────────────────────────────────────────────────────────

  if (interaction.type === InteractionType.ModalSubmit) {
    const val = interaction.fields.getTextInputValue(F).trim();

    switch (interaction.customId) {
      case M.WATCH: {
        const channel = await resolveChannel(interaction, client, val);
        if (!channel) return;
        cfg.watchChannelId = channel.id;
        saveConfig(cfg);
        await interaction.reply({
          content: "Watch channel updated. Sync started.",
          ephemeral: false,
        });
        syncChannel(channel, data, cfg).catch((e) =>
          console.error("[sync]", e),
        );
        break;
      }

      case M.NOTIFY: {
        const channel = await resolveChannel(interaction, client, val);
        if (!channel) return;
        cfg.notifyChannelId = channel.id;
        saveConfig(cfg);
        await interaction.reply({
          content: "Notify channel updated.",
          ephemeral: false,
        });
        break;
      }

      case M.THRESHOLD: {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1) {
          return interaction.reply({
            content: "Goal must be a positive number.",
            ephemeral: false,
          });
        }
        cfg.reactionThreshold = n;
        saveConfig(cfg);
        await interaction.reply({ content: "Goal updated.", ephemeral: false });
        break;
      }

      case M.MOD_ADD: {
        if (!owner)
          return interaction.reply({
            content: "Only the owner can do this.",
            ephemeral: false,
          });
        if (!SNOWFLAKE_RE.test(val))
          return interaction.reply({
            content: "Invalid user ID.",
            ephemeral: false,
          });
        if (val === cfg.ownerId)
          return interaction.reply({
            content: "Owner cannot be added as mod.",
            ephemeral: false,
          });
        if (cfg.modIds.includes(val))
          return interaction.reply({
            content: "User is already a mod.",
            ephemeral: false,
          });
        cfg.modIds.push(val);
        saveConfig(cfg);
        await interaction.reply({ content: "Mod added.", ephemeral: false });
        break;
      }

      case M.MOD_REMOVE: {
        if (!owner)
          return interaction.reply({
            content: "Only the owner can do this.",
            ephemeral: false,
          });
        if (!SNOWFLAKE_RE.test(val))
          return interaction.reply({
            content: "Invalid user ID.",
            ephemeral: false,
          });
        if (!cfg.modIds.includes(val))
          return interaction.reply({
            content: "User is not a mod.",
            ephemeral: false,
          });
        cfg.modIds = cfg.modIds.filter((id) => id !== val);
        saveConfig(cfg);
        await interaction.reply({ content: "Mod removed.", ephemeral: false });
        break;
      }
    }

    await refreshPanel(interaction, cfg, owner);
  }
}

module.exports = { handleSettingsCommand, handleSettingsInteraction };
