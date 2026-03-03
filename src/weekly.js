"use strict";

/**
 * weekly.js — best-photo announcement (manual only, triggered by the settings button)
 *
 * Winner = message with the most UNIQUE human reactors (meta.reactorIds.length)
 * in the window (lastAnnouncedAt, now].
 *
 * Announcement is sent to the WATCH channel so the photo renders inline.
 * After sending, lastAnnouncedAt is updated to now.
 *
 * There is NO automatic scheduler — this runs only when an admin clicks
 * "Post Best Photo Now" in the settings panel.
 */

const { getChannel, pruneChannel, saveData } = require("./storage");
const { pickImageUrl } = require("./photoUtils");

/**
 * @param {import("discord.js").Client}   client
 * @param {import("./storage").BotConfig} config
 * @param {import("./storage").BotData}   data
 * @param {Function}                      saveConfig
 * @returns {Promise<{ ok:boolean, noWinner?:boolean, error?:string }>}
 */
async function sendWeeklyAnnouncementNow(client, config, data, saveConfig) {
  if (!config.weeklyEnabled) return { ok: false, error: "weekly_disabled" };

  const { watchChannelId, intervalDays, lastAnnouncedAt } = config;
  if (!watchChannelId) return { ok: false, error: "no_watch_channel" };

  // Fetch the watch channel early so we can fail fast
  const announceChannel = await client.channels
    .fetch(watchChannelId)
    .catch(() => null);
  if (!announceChannel) return { ok: false, error: "channel_unavailable" };

  const now = Date.now();
  const windowStart = lastAnnouncedAt;

  // Advance the timestamp immediately — prevents double-posting if the button
  // is clicked twice in quick succession
  config.lastAnnouncedAt = now;
  saveConfig(config);

  const ch = getChannel(data, watchChannelId);
  if (pruneChannel(ch, config.retentionDays)) saveData(data);

  // ── Find the winning message ─────────────────────────────────────────────
  let winnerKey = null;
  let winnerMeta = null;
  let winnerCount = 0;

  for (const [msgId, meta] of Object.entries(ch.messages)) {
    if (meta.postedAt <= windowStart) continue; // outside window
    if (!meta.reactorIds || meta.reactorIds.length === 0) continue;

    const count = meta.reactorIds.length;
    // Tie-break: newer message wins
    if (
      count > winnerCount ||
      (count === winnerCount && winnerKey && msgId > winnerKey)
    ) {
      winnerCount = count;
      winnerKey = msgId;
      winnerMeta = meta;
    }
  }

  // ── No winner ─────────────────────────────────────────────────────────────
  if (!winnerMeta || winnerCount === 0) {
    await announceChannel
      .send(
        `📷 **لا يوجد فائز هذه الفترة**\n` +
          `> لم تُسجَّل أي تفاعلات على الصور خلال هذه الفترة.\n` +
          `> استمروا في النشر والتفاعل! 🌟`,
      )
      .catch(() => null);
    return { ok: true, noWinner: true };
  }

  // ── Resolve image URL ─────────────────────────────────────────────────────
  let imageUrl = winnerMeta.imageUrl ?? null;

  if (!imageUrl) {
    // Try to fetch the original Discord message to get its attachment URL
    const discordMsg = await announceChannel.messages
      .fetch(winnerKey)
      .catch(() => null);
    if (discordMsg) {
      imageUrl = pickImageUrl(discordMsg.attachments) ?? null;
      if (imageUrl) {
        winnerMeta.imageUrl = imageUrl;
        saveData(data);
      }
    }
  }

  // ── Build and send the announcement ──────────────────────────────────────
  const authorMention = winnerMeta.authorId
    ? `<@${winnerMeta.authorId}>`
    : "أحد الأعضاء";
  const periodLabel = daysToArabic(intervalDays);

  const text = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🏅  **أفضل صورة — ${periodLabel}**`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `> 📸 **صاحب الصورة:** ${authorMention}`,
    `> ❤️ **عدد المتفاعلين:** ${winnerCount} شخص`,
    ``,
    `@here`,
  ].join("\n");

  await announceChannel.send(text).catch(() => null);

  // Send the image as a separate message so it renders as a clean preview
  if (imageUrl) {
    await announceChannel.send(imageUrl).catch(() => null);
  }

  return { ok: true, noWinner: false };
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function daysToArabic(days) {
  if (days === 1) return "اليوم الماضي";
  if (days === 7) return "الأسبوع الماضي";
  if (days === 14) return "الأسبوعين الماضيين";
  if (days === 30) return "الشهر الماضي";
  return `الـ ${days} أيام الماضية`;
}

module.exports = { sendWeeklyAnnouncementNow };
