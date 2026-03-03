/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * settings.js — the entire admin UI
 *
 * Single entry point: user types  setlocket
 * Bot replies with a rich embed showing all current settings + two rows of buttons.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  PANEL LAYOUT                                           │
 * │                                                         │
 * │  Row 1 — Channels                                       │
 * │    [📺 Watch Channel]  [🔔 Notify Channel]              │
 * │                                                         │
 * │  Row 2 — Numbers                                        │
 * │    [🎯 Goal]  [⚡ Speed Window]  [📅 Interval (days)]   │
 * │    [🗄️ Retention (days)]                                 │
 * │                                                         │
 * │  Row 3 — Feature toggles (on/off, instant)              │
 * │    [Best-Photo ON/OFF]  [Dup-Check ON/OFF]              │
 * │    [Speed-Bonus ON/OFF] [Goal-Notify ON/OFF]            │
 * │                                                         │
 * │  Row 4 — Actions                                        │
 * │    [🔄 Reset Leaderboard]  [📢 Post Best Photo Now]     │
 * │    [📊 Dashboard]                                       │
 * │                                                         │
 * │  Row 5 — Mods (owner only)                              │
 * │    [➕ Add Mod]  [➖ Remove Mod]  [📋 List Mods]        │
 * └─────────────────────────────────────────────────────────┘
 *
 * Each number/channel button opens a Discord Modal.
 * Toggle buttons flip the boolean immediately with no modal.
 * All interaction replies are visible in the channel.
 * After every action the embed updates in-place.
 *
 * Permission model:
 *   Owner  → everything
 *   Mod    → rows 1–4  (channels, numbers, toggles, actions)
 *   Others → blocked
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
} = require("discord.js");

const { buildEmbed } = require("./embeds");
const { syncChannel } = require("./sync");
const { tickWeekly } = require("./weekly");
const { getChannel, isOwner, isAllowed } = require("./storage");

// ─────────────────────────────────────────────────────
// ID constants — keep short to stay under Discord's 100-char limit
// ─────────────────────────────────────────────────────

const B = {
  // Row 1 — channels
  WATCH: "s_watch",
  NOTIFY: "s_notify",
  // Row 2 — numbers
  THRESHOLD: "s_thresh",
  SPEED: "s_speed",
  INTERVAL: "s_interval",
  RETENTION: "s_retention",
  // Row 3 — toggles
  T_WEEKLY: "s_t_weekly",
  T_DUPCHECK: "s_t_dup",
  T_SPEEDBONUS: "s_t_spd",
  T_GOALNOTIFY: "s_t_goal",
  // Row 4 — actions
  RESET: "s_reset",
  POST_NOW: "s_postnow",
  DASHBOARD: "s_dash",
  // Row 5 — mods (owner only)
  MOD_ADD: "s_modadd",
  MOD_REMOVE: "s_modrem",
  MOD_LIST: "s_modlist",
};

const M = {
  WATCH: "m_watch",
  NOTIFY: "m_notify",
  THRESHOLD: "m_thresh",
  SPEED: "m_speed",
  INTERVAL: "m_interval",
  RETENTION: "m_retention",
  MOD_ADD: "m_modadd",
  MOD_REMOVE: "m_modrem",
};

const F = "f_val"; // single text-input field id used in all modals

const SNOWFLAKE_RE = /^\d{17,20}$/;

// ─────────────────────────────────────────────────────
// Settings embed
// ─────────────────────────────────────────────────────

/** @param {import("./storage").BotConfig} cfg */
function buildSettingsEmbed(cfg) {
  const on = "🟢 مفعّل";
  const off = "🔴 معطّل";
  const ch = (id) => (id ? `<#${id}>` : "—  *(غير محدد)*");

  const lastAnn = cfg.lastAnnouncedAt
    ? `<t:${Math.floor(cfg.lastAnnouncedAt / 1000)}:R>`
    : "لم يتم بعد";
  const nextAnn = cfg.lastAnnouncedAt
    ? `<t:${Math.floor((cfg.lastAnnouncedAt + cfg.intervalDays * 86_400_000) / 1000)}:R>`
    : "—";

  return buildEmbed({
    title: "⚙️  لوحة إعدادات البوت",
    description:
      "استخدم الأزرار أدناه للتحكم الكامل في البوت.\n" +
      "كل التغييرات تُطبَّق فوراً وتُحفظ تلقائياً.",
    fields: [
      // Row A — channels
      {
        name: "📺  قناة المراقبة",
        value: ch(cfg.watchChannelId),
        inline: true,
      },
      {
        name: "🔔  قناة الإشعارات",
        value: ch(cfg.notifyChannelId),
        inline: true,
      },
      { name: "\u200b", value: "\u200b", inline: true },
      // Row B — numbers
      {
        name: "🎯  الهدف",
        value: `**${cfg.reactionThreshold}** نقطة`,
        inline: true,
      },
      {
        name: "⚡  نافذة التفاعل السريع",
        value: `**${cfg.speedBonusMinutes}** دقيقة = ×2 نقطة`,
        inline: true,
      },
      {
        name: "📅  فترة إعلان أفضل صورة",
        value: `كل **${cfg.intervalDays}** يوم`,
        inline: true,
      },
      {
        name: "🗄️  مدة حفظ البيانات",
        value: `**${cfg.retentionDays}** يوم`,
        inline: true,
      },
      { name: "📢  آخر إعلان", value: lastAnn, inline: true },
      { name: "⏭️  الإعلان القادم", value: nextAnn, inline: true },
      // Row C — toggles
      {
        name: "🏅  إعلان أفضل صورة",
        value: cfg.weeklyEnabled ? on : off,
        inline: true,
      },
      {
        name: "🚫  كشف الصور المكررة",
        value: cfg.duplicateCheckEnabled ? on : off,
        inline: true,
      },
      {
        name: "⚡  مكافأة التفاعل السريع",
        value: cfg.speedBonusEnabled ? on : off,
        inline: true,
      },
      {
        name: "🏆  إشعار إتمام الهدف",
        value: cfg.goalNotifyEnabled ? on : off,
        inline: true,
      },
      // Row D — mods
      {
        name: "👥  المشرفون",
        value: cfg.modIds.length
          ? cfg.modIds.map((id) => `<@${id}>`).join("  ")
          : "لا يوجد مشرفون",
        inline: false,
      },
    ],
    footer: `المالك: ${cfg.ownerId}  •  اكتب setlocket لإعادة فتح هذه اللوحة`,
  });
}

// ─────────────────────────────────────────────────────
// Dashboard embed (leaderboard)
// ─────────────────────────────────────────────────────

/** @param {import("./storage").BotConfig} cfg @param {import("./storage").BotData} data */
function buildDashboardEmbed(cfg, data) {
  const { getChannel } = require("./storage");
  if (!cfg.watchChannelId) {
    return buildEmbed({
      title: "📊  لوحة الصدارة",
      description: "لم يتم تعيين قناة مراقبة بعد.",
    });
  }

  const ch = getChannel(data, cfg.watchChannelId);
  const medals = ["🥇", "🥈", "🥉"];

  const entries = Object.entries(ch.users)
    .map(([uid, u]) => ({
      uid,
      points: u.points,
      cycles: u.cycles,
      total: u.totalPoints,
    }))
    .filter((e) => e.points > 0 || e.cycles > 0)
    .sort((a, b) => b.points - a.points || b.cycles - a.cycles)
    .slice(0, 20);

  if (entries.length === 0) {
    return buildEmbed({
      title: "📊  لوحة الصدارة",
      description:
        "لا يوجد بيانات بعد.\nيبدأ التسجيل فور أول تفاعل على صورة. 🌟",
    });
  }

  const lines = entries.map(({ uid, points, cycles }, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const cycStr = cycles > 0 ? `  *(${cycles} جولة)*` : "";
    return `${medal}  <@${uid}> — **${points}** نقطة${cycStr}`;
  });

  return buildEmbed({
    title: "📊  لوحة الصدارة",
    description: lines.join("\n"),
    fields: [
      {
        name: "🎯  الهدف الحالي",
        value: `${cfg.reactionThreshold} نقطة`,
        inline: true,
      },
      {
        name: "⚡  المكافأة السريعة",
        value: `×2 خلال أول ${cfg.speedBonusMinutes} دقيقة`,
        inline: true,
      },
    ],
    footer: "يتحدث فور كل تفاعل",
  });
}

// ─────────────────────────────────────────────────────
// Action rows
// ─────────────────────────────────────────────────────

/** @param {import("./storage").BotConfig} cfg @param {boolean} ownerViewing */
function buildRows(cfg, ownerViewing) {
  const tog = (enabled) =>
    enabled ? ButtonStyle.Success : ButtonStyle.Secondary;

  const row1 = new ActionRowBuilder().addComponents(
    btn(B.WATCH, "📺 قناة المراقبة", ButtonStyle.Primary),
    btn(B.NOTIFY, "🔔 قناة الإشعارات", ButtonStyle.Primary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    btn(B.THRESHOLD, "🎯 الهدف", ButtonStyle.Primary),
    btn(B.SPEED, "⚡ نافذة التفاعل السريع", ButtonStyle.Primary),
    btn(B.INTERVAL, "📅 فترة الإعلان", ButtonStyle.Primary),
    btn(B.RETENTION, "🗄️ مدة حفظ البيانات", ButtonStyle.Secondary),
  );

  const row3 = new ActionRowBuilder().addComponents(
    btn(
      B.T_WEEKLY,
      cfg.weeklyEnabled ? "🏅 إعلان أفضل صورة ✓" : "🏅 إعلان أفضل صورة ✗",
      tog(cfg.weeklyEnabled),
    ),
    btn(
      B.T_DUPCHECK,
      cfg.duplicateCheckEnabled ? "🚫 كشف المكررات ✓" : "🚫 كشف المكررات ✗",
      tog(cfg.duplicateCheckEnabled),
    ),
    btn(
      B.T_SPEEDBONUS,
      cfg.speedBonusEnabled ? "⚡ مكافأة سريعة ✓" : "⚡ مكافأة سريعة ✗",
      tog(cfg.speedBonusEnabled),
    ),
    btn(
      B.T_GOALNOTIFY,
      cfg.goalNotifyEnabled ? "🏆 إشعار الهدف ✓" : "🏆 إشعار الهدف ✗",
      tog(cfg.goalNotifyEnabled),
    ),
  );

  const row4 = new ActionRowBuilder().addComponents(
    btn(B.RESET, "🔄 إعادة ضبط الصدارة", ButtonStyle.Danger),
    btn(B.POST_NOW, "📢 نشر أفضل صورة الآن", ButtonStyle.Success),
    btn(B.DASHBOARD, "📊 الصدارة", ButtonStyle.Secondary),
  );

  const rows = [row1, row2, row3, row4];

  if (ownerViewing) {
    rows.push(
      new ActionRowBuilder().addComponents(
        btn(B.MOD_ADD, "➕ إضافة مشرف", ButtonStyle.Secondary),
        btn(B.MOD_REMOVE, "➖ إزالة مشرف", ButtonStyle.Secondary),
        btn(B.MOD_LIST, "📋 قائمة المشرفين", ButtonStyle.Secondary),
      ),
    );
  }

  return rows;
}

const btn = (id, label, style) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

// ─────────────────────────────────────────────────────
// Modal factories
// ─────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

async function resolveChannel(interaction, client, rawId) {
  if (!SNOWFLAKE_RE.test(rawId)) {
    await interaction.reply({
      content:
        "❌ معرّف القناة غير صالح — يجب أن يكون رقماً من 17 إلى 20 خانة.",
      ephemeral: false,
    });
    return null;
  }
  const ch = await client.channels.fetch(rawId).catch(() => null);
  if (!ch) {
    await interaction.reply({
      content: "❌ لم يتم العثور على القناة أو البوت لا يملك صلاحية الوصول.",
      ephemeral: false,
    });
    return null;
  }
  return ch;
}

/** Refresh the settings embed in the original message. */
async function refreshPanel(interaction, cfg, ownerViewing) {
  await interaction.message
    ?.edit({
      embeds: [buildSettingsEmbed(cfg)],
      components: buildRows(cfg, ownerViewing),
    })
    .catch(() => null);
}

// ─────────────────────────────────────────────────────
// Public: open settings panel
// ─────────────────────────────────────────────────────

/**
 * Called when an allowed user sends "setlocket".
 * @param {import("discord.js").Message}  message
 * @param {import("./storage").BotConfig} cfg
 */
async function handleSettingsCommand(message, cfg) {
  if (!isAllowed(cfg, message.author.id)) return;
  const owner = isOwner(cfg, message.author.id);

  await message.reply({
    embeds: [buildSettingsEmbed(cfg)],
    components: buildRows(cfg, owner),
  });
}

// ─────────────────────────────────────────────────────
// Public: interaction handler  (buttons + modal submits)
// ─────────────────────────────────────────────────────

/**
 * @param {import("discord.js").Interaction} interaction
 * @param {import("discord.js").Client}      client
 * @param {import("./storage").BotConfig}    cfg
 * @param {import("./storage").BotData}      data
 * @param {Function} saveConfig
 * @param {Function} saveData
 */
async function handleSettingsInteraction(
  interaction,
  client,
  cfg,
  data,
  saveConfig,
  saveData,
) {
  // Permission gate
  if (!isAllowed(cfg, interaction.user.id)) {
    await interaction.reply({
      content: "⛔ ليس لديك صلاحية للوصول إلى هذه الإعدادات.",
      ephemeral: false,
    });
    return;
  }

  const owner = isOwner(cfg, interaction.user.id);

  // ── BUTTONS ────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    switch (interaction.customId) {
      // ── Channels (open modals) ─────────────────────────────────────────────
      case B.WATCH:
        return interaction.showModal(
          modal(
            M.WATCH,
            "تعيين قناة المراقبة",
            "معرّف القناة",
            "مثال: 1234567890123456789",
            17,
            20,
          ),
        );
      case B.NOTIFY:
        return interaction.showModal(
          modal(
            M.NOTIFY,
            "تعيين قناة الإشعارات",
            "معرّف القناة",
            "مثال: 1234567890123456789",
            17,
            20,
          ),
        );

      // ── Numbers (open modals) ──────────────────────────────────────────────
      case B.THRESHOLD:
        return interaction.showModal(
          modal(
            M.THRESHOLD,
            "تغيير الهدف",
            `عدد النقاط المطلوبة (الحالي: ${cfg.reactionThreshold})`,
            "مثال: 100",
            1,
            6,
          ),
        );
      case B.SPEED:
        return interaction.showModal(
          modal(
            M.SPEED,
            "نافذة التفاعل السريع",
            `دقائق من النشر (الحالي: ${cfg.speedBonusMinutes})`,
            "1 – 1440",
            1,
            4,
          ),
        );
      case B.INTERVAL:
        return interaction.showModal(
          modal(
            M.INTERVAL,
            "فترة إعلان أفضل صورة",
            `عدد الأيام (الحالي: ${cfg.intervalDays})`,
            "1 – 365",
            1,
            3,
          ),
        );
      case B.RETENTION:
        return interaction.showModal(
          modal(
            M.RETENTION,
            "مدة حفظ البيانات (أيام)",
            `عدد الأيام (الحالي: ${cfg.retentionDays})`,
            "1 – 365",
            1,
            3,
          ),
        );

      // ── Toggles (instant, no modal) ────────────────────────────────────────
      case B.T_WEEKLY:
        cfg.weeklyEnabled = !cfg.weeklyEnabled;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ إعلان أفضل صورة: **${cfg.weeklyEnabled ? "مفعّل" : "معطّل"}**`,
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);

      case B.T_DUPCHECK:
        cfg.duplicateCheckEnabled = !cfg.duplicateCheckEnabled;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ كشف الصور المكررة: **${cfg.duplicateCheckEnabled ? "مفعّل" : "معطّل"}**`,
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);

      case B.T_SPEEDBONUS:
        cfg.speedBonusEnabled = !cfg.speedBonusEnabled;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ مكافأة التفاعل السريع: **${cfg.speedBonusEnabled ? "مفعّلة" : "معطّلة"}**`,
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);

      case B.T_GOALNOTIFY:
        cfg.goalNotifyEnabled = !cfg.goalNotifyEnabled;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ إشعار إتمام الهدف: **${cfg.goalNotifyEnabled ? "مفعّل" : "معطّل"}**`,
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);

      // ── Actions ────────────────────────────────────────────────────────────
      case B.RESET: {
        if (!cfg.watchChannelId) {
          return interaction.reply({
            content: "❌ لم يتم تعيين قناة مراقبة بعد.",
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
          content:
            "✅ **تمت إعادة ضبط لوحة الصدارة.**\n> الجولات المكتملة والنقاط الإجمالية محفوظة.",
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);
      }

      case B.POST_NOW: {
        // Force-post by temporarily zeroing lastAnnouncedAt.
        const saved = cfg.lastAnnouncedAt;
        cfg.lastAnnouncedAt = 0;
        await tickWeekly(client, cfg, data, saveConfig);
        // If tickWeekly didn't fire (channels not set etc.), restore.
        if (cfg.lastAnnouncedAt === 0) cfg.lastAnnouncedAt = saved;
        await interaction.reply({
          content: "✅ تم نشر إعلان أفضل صورة.",
          ephemeral: false,
        });
        return refreshPanel(interaction, cfg, owner);
      }

      case B.DASHBOARD: {
        await interaction.reply({
          embeds: [buildDashboardEmbed(cfg, data)],
          ephemeral: false,
        });
        return;
      }

      // ── Mods (owner only) ──────────────────────────────────────────────────
      case B.MOD_ADD:
        if (!owner)
          return interaction.reply({
            content: "⛔ هذا الخيار للمالك فقط.",
            ephemeral: false,
          });
        return interaction.showModal(
          modal(
            M.MOD_ADD,
            "إضافة مشرف",
            "معرّف المستخدم (User ID)",
            "مثال: 1234567890123456789",
            17,
            20,
          ),
        );

      case B.MOD_REMOVE:
        if (!owner)
          return interaction.reply({
            content: "⛔ هذا الخيار للمالك فقط.",
            ephemeral: false,
          });
        return interaction.showModal(
          modal(
            M.MOD_REMOVE,
            "إزالة مشرف",
            "معرّف المستخدم (User ID)",
            "مثال: 1234567890123456789",
            17,
            20,
          ),
        );

      case B.MOD_LIST: {
        if (!owner)
          return interaction.reply({
            content: "⛔ هذا الخيار للمالك فقط.",
            ephemeral: false,
          });
        const list = cfg.modIds.length
          ? cfg.modIds
              .map((id, i) => `${i + 1}. <@${id}> — \`${id}\``)
              .join("\n")
          : "لا يوجد مشرفون حالياً.";
        return interaction.reply({
          content: `👥 **قائمة المشرفين:**\n${list}`,
          ephemeral: false,
        });
      }
    }
  }

  // ── MODAL SUBMITS ──────────────────────────────────────────────────────────
  if (interaction.type === InteractionType.ModalSubmit) {
    const val = interaction.fields.getTextInputValue(F).trim();

    switch (interaction.customId) {
      // ── Channel modals ──────────────────────────────────────────────────────
      case M.WATCH: {
        const channel = await resolveChannel(interaction, client, val);
        if (!channel) return;
        cfg.watchChannelId = channel.id;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ تم تعيين قناة المراقبة على <#${channel.id}>.\n> جارٍ مزامنة البيانات في الخلفية…`,
          ephemeral: false,
        });
        syncChannel(channel, data, cfg).catch((e) =>
          console.error("[sync error]", e),
        );
        break;
      }

      case M.NOTIFY: {
        const channel = await resolveChannel(interaction, client, val);
        if (!channel) return;
        cfg.notifyChannelId = channel.id;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ تم تعيين قناة الإشعارات على <#${channel.id}>.`,
          ephemeral: false,
        });
        break;
      }

      // ── Number modals ───────────────────────────────────────────────────────
      case M.THRESHOLD: {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1)
          return interaction.reply({
            content: "❌ أدخل رقماً صحيحاً أكبر من صفر.",
            ephemeral: false,
          });

        const old = cfg.reactionThreshold;
        cfg.reactionThreshold = n;
        saveConfig(cfg);

        let note = "";
        if (cfg.watchChannelId && n < old) {
          // New goal is lower → reset current-cycle progress to prevent instant wins.
          const ch = getChannel(data, cfg.watchChannelId);
          for (const u of Object.values(ch.users)) {
            u.pending = [];
            u.points = 0;
          }
          saveData(data);
          note =
            "\n> ⚠️ الهدف الجديد أصغر — تم إعادة ضبط التقدم الحالي لجميع المستخدمين.";
        }
        await interaction.reply({
          content: `✅ تم تعيين الهدف على **${n}** نقطة.${note}`,
          ephemeral: false,
        });
        break;
      }

      case M.SPEED: {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1 || n > 1440)
          return interaction.reply({
            content: "❌ أدخل عدداً بين 1 و 1440 دقيقة.",
            ephemeral: false,
          });
        cfg.speedBonusMinutes = n;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ نافذة التفاعل السريع: **${n}** دقيقة.`,
          ephemeral: false,
        });
        break;
      }

      case M.INTERVAL: {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1 || n > 365)
          return interaction.reply({
            content: "❌ أدخل عدداً بين 1 و 365.",
            ephemeral: false,
          });
        cfg.intervalDays = n;
        cfg.lastAnnouncedAt = Date.now(); // reset timer from now
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ سيتم نشر إعلان أفضل صورة كل **${n}** يوم.\n> تم إعادة ضبط المؤقّت.`,
          ephemeral: false,
        });
        break;
      }

      case M.RETENTION: {
        const n = parseInt(val, 10);
        if (!Number.isInteger(n) || n < 1 || n > 365)
          return interaction.reply({
            content: "❌ أدخل عدداً بين 1 و 365.",
            ephemeral: false,
          });
        cfg.retentionDays = n;
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ مدة حفظ البيانات: **${n}** يوم.`,
          ephemeral: false,
        });
        break;
      }

      // ── Mod modals ──────────────────────────────────────────────────────────
      case M.MOD_ADD: {
        if (!owner)
          return interaction.reply({
            content: "⛔ هذا الخيار للمالك فقط.",
            ephemeral: false,
          });
        if (!SNOWFLAKE_RE.test(val))
          return interaction.reply({
            content: "❌ معرّف المستخدم غير صالح.",
            ephemeral: false,
          });
        if (val === cfg.ownerId)
          return interaction.reply({
            content: "❌ المالك لا يحتاج إلى إضافته كمشرف.",
            ephemeral: false,
          });
        if (cfg.modIds.includes(val))
          return interaction.reply({
            content: "⚠️ هذا المستخدم مشرف بالفعل.",
            ephemeral: false,
          });
        cfg.modIds.push(val);
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ تمت إضافة <@${val}> كمشرف.`,
          ephemeral: false,
        });
        break;
      }

      case M.MOD_REMOVE: {
        if (!owner)
          return interaction.reply({
            content: "⛔ هذا الخيار للمالك فقط.",
            ephemeral: false,
          });
        if (!SNOWFLAKE_RE.test(val))
          return interaction.reply({
            content: "❌ معرّف المستخدم غير صالح.",
            ephemeral: false,
          });
        if (!cfg.modIds.includes(val))
          return interaction.reply({
            content: "⚠️ هذا المستخدم ليس مشرفاً.",
            ephemeral: false,
          });
        cfg.modIds = cfg.modIds.filter((id) => id !== val);
        saveConfig(cfg);
        await interaction.reply({
          content: `✅ تمت إزالة <@${val}> من قائمة المشرفين.`,
          ephemeral: false,
        });
        break;
      }
    }

    // Refresh embed after every modal submit.
    await refreshPanel(interaction, cfg, owner);
  }
}

module.exports = { handleSettingsCommand, handleSettingsInteraction };
