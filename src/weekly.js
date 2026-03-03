/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * weekly.js — best-photo period announcement
 *
 * Winner metric
 * ─────────────
 * Winner = message with the most UNIQUE human reactors (meta.reactorIds.length),
 * counting each person only once regardless of how many different emoji they used.
 * Example: Ahmed reacts ❤️, Omar reacts 🚪 → 2 unique reactors, 2 points.
 * Anti-abuse: one person adding 10 different emoji is still just 1 unique reactor.
 *
 * Window logic
 * ────────────
 * The window is (lastAnnouncedAt, now].
 * After announcing we set lastAnnouncedAt = now.
 * The next window starts from that moment — no overlap, no gap, no re-winning.
 *
 * Photo delivery
 * ──────────────
 * We send the announcement text first, then try to send the winning photo as a
 * separate message with the image URL.  Discord auto-previews URLs, so no embed
 * needed.  If the message no longer exists in Discord we still post the text.
 *
 * Scheduling
 * ──────────
 * index.js calls tickWeekly() every CHECK_INTERVAL_MS (5 min).
 */

const { getChannel, pruneChannel, saveData } = require("./storage");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * @param {import("discord.js").Client}   client
 * @param {import("./storage").BotConfig} config
 * @param {import("./storage").BotData}   data
 * @param {Function}                      saveConfig
 */
async function tickWeekly(client, config, data, saveConfig) {
  if (!config.weeklyEnabled) return;

  const { watchChannelId, notifyChannelId, intervalDays, lastAnnouncedAt } =
    config;
  if (!watchChannelId || !notifyChannelId) return;

  const now = Date.now();
  const intervalMs = intervalDays * 24 * 60 * 60 * 1000;
  if (now < lastAnnouncedAt + intervalMs) return;

  // Stamp now immediately to prevent double-fire.
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

  // ── Fetch notify channel ─────────────────────────────────────────────────
  const notifyChannel = await client.channels
    .fetch(notifyChannelId)
    .catch(() => null);
  if (!notifyChannel) return;

  // ── No winner ─────────────────────────────────────────────────────────────
  if (!winnerMeta || winnerCount === 0) {
    await notifyChannel
      .send(
        `📷 **لا يوجد فائز هذه الفترة.**\n` +
          `لم تُسجَّل أي تفاعلات على الصور. استمروا في النشر والتفاعل! 🌟`,
      )
      .catch(() => null);
    return;
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

  await notifyChannel.send(text).catch(() => null);

  // Send the photo after the text so it renders as a clean preview below.
  if (imageUrl) {
    await notifyChannel.send(imageUrl).catch(() => null);
  }
}

/** @param {number} days @returns {string} */
function daysToArabic(days) {
  if (days === 1) return "اليوم الماضي";
  if (days === 7) return "الأسبوع الماضي";
  if (days === 14) return "الأسبوعين الماضيين";
  if (days === 30) return "الشهر الماضي";
  return `الـ ${days} أيام الماضية`;
}

module.exports = { tickWeekly, CHECK_INTERVAL_MS };
