/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * weekly.js — best-photo period announcement (manual only, via "Post Best Photo Now" button)
 *
 * Winner = message with the most UNIQUE human reactors (meta.reactorIds.length).
 * Window is (lastAnnouncedAt, now]. After sending we set lastAnnouncedAt = now.
 * Announcement is sent to the watch channel. No automatic scheduling — only when the button is clicked.
 */

const { getChannel, pruneChannel, saveData } = require("./storage");

/**
 * Sends the best-photo announcement now (called from settings button only).
 * @param {import("discord.js").Client}   client
 * @param {import("./storage").BotConfig} config
 * @param {import("./storage").BotData}   data
 * @param {Function}                      saveConfig
 * @returns {{ ok: boolean, noWinner?: boolean, error?: string }}
 */
async function sendWeeklyAnnouncementNow(client, config, data, saveConfig) {
  if (!config.weeklyEnabled) {
    return { ok: false, error: "weekly_disabled" };
  }

  const { watchChannelId, intervalDays, lastAnnouncedAt } = config;
  if (!watchChannelId) {
    return { ok: false, error: "no_watch_channel" };
  }

  const now = Date.now();
  const windowStart = lastAnnouncedAt;
  config.lastAnnouncedAt = now;
  saveConfig(config);

  const ch = getChannel(data, watchChannelId);
  if (pruneChannel(ch, config.retentionDays)) saveData(data);

  // ── Find winner ──────────────────────────────────────────────────────────
  let winnerKey = null;
  let winnerMeta = null;
  let winnerCount = 0;

  for (const [msgId, meta] of Object.entries(ch.messages)) {
    if (meta.postedAt <= windowStart) continue; // outside window
    if (!meta.reactorIds || meta.reactorIds.length === 0) continue;

    const count = meta.reactorIds.length;
    if (
      count > winnerCount ||
      (count === winnerCount && msgId > winnerKey) // tie-break: newer wins
    ) {
      winnerCount = count;
      winnerKey = msgId;
      winnerMeta = meta;
    }
  }

  // ── Fetch watch channel (announcements go here) ──────────────────────────
  const announceChannel = await client.channels
    .fetch(watchChannelId)
    .catch(() => null);
  if (!announceChannel) {
    config.lastAnnouncedAt = windowStart;
    saveConfig(config);
    return { ok: false, error: "channel_unavailable" };
  }

  // ── No winner ─────────────────────────────────────────────────────────────
  if (!winnerMeta || winnerCount === 0) {
    await announceChannel
      .send(
        `📷 **لا يوجد فائز هذه الفترة.**\n` +
          `لم تُسجَّل أي تفاعلات على الصور. استمروا في النشر والتفاعل! 🌟`,
      )
      .catch(() => null);
    return { ok: true, noWinner: true };
  }

  // ── Try to get the actual image from Discord ─────────────────────────────
  let imageUrl = winnerMeta.imageUrl ?? null;

  // If we stored a URL already, use it. Otherwise try to re-fetch the message.
  if (!imageUrl) {
    const watchChannel = await client.channels
      .fetch(watchChannelId)
      .catch(() => null);
    if (watchChannel) {
      const discordMsg = await watchChannel.messages
        .fetch(winnerKey)
        .catch(() => null);
      if (discordMsg) {
        const { pickImageUrl } = require("./photoUtils");
        imageUrl = pickImageUrl(discordMsg.attachments) ?? null;
        // Persist so we don't need to fetch again
        winnerMeta.imageUrl = imageUrl;
        saveData(data);
      }
    }
  }

  // ── Build announcement ───────────────────────────────────────────────────
  const authorMention = winnerMeta.authorId
    ? `<@${winnerMeta.authorId}>`
    : "أحد الأعضاء";
  const periodLabel = daysToArabic(intervalDays);

  const text = [
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🏅  **أفضل صورة — ${periodLabel}**`,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `- 📸  **صاحب الصورة:** ${authorMention}`,
    `- ❤️  **المتفاعلون:** ${winnerCount} شخص`,
    ``,
    `@here`,
  ].join("\n");

  await announceChannel.send(text).catch(() => null);

  // Send the photo after the text so it renders as a clean preview below.
  if (imageUrl) {
    await announceChannel.send(imageUrl).catch(() => null);
  }
  return { ok: true, noWinner: false };
}

/** @param {number} days @returns {string} */
function daysToArabic(days) {
  if (days === 1) return "اليوم الماضي";
  if (days === 7) return "الأسبوع الماضي";
  if (days === 14) return "الأسبوعين الماضيين";
  if (days === 30) return "الشهر الماضي";
  return `الـ ${days} أيام الماضية`;
}

module.exports = { sendWeeklyAnnouncementNow };
