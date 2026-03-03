/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * sync.js — channel sync engine
 *
 * For each message:
 *   1. Register photo signatures (duplicate guard).
 *   2. Store imageUrl (first image attachment) for the weekly announcement.
 *   3. Collect unique reactor IDs across ALL emoji into meta.reactorIds.
 *   4. Credit each unique reactor once on their personal leaderboard.
 *
 * Per-message skip optimisation:
 *   If meta.syncedAt > 0 the reactor list was already fetched for this message.
 *   We skip re-fetching unless the message is still within the speed-bonus window
 *   (new reactions may still be arriving).
 *
 * Snowflake → ms: (BigInt(id) >> 22n) + 1_420_070_400_000n
 */

const { Routes } = require("discord-api-types/v10");
const { makeURLSearchParams } = require("@discordjs/rest");
const {
  getChannel,
  getUser,
  getMeta,
  pruneChannel,
  saveData,
  reactionPoints,
} = require("./storage");
const {
  attachmentSignature,
  isImageAttachment,
  pickImageUrl,
} = require("./photoUtils");

// ─────────────────────────────────────────────
// Snowflake util
// ─────────────────────────────────────────────

const DISCORD_EPOCH = 1_420_070_400_000n;

/** @param {string} snowflake @returns {number} unix-ms */
function snowflakeToMs(snowflake) {
  try {
    return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
  } catch {
    return Date.now();
  }
}

// ─────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────

/** @returns {string|null} */
function emojiKey(emoji) {
  if (!emoji) return null;
  if (emoji.id) return `${emoji.name}:${emoji.id}`;
  if (emoji.name) return encodeURIComponent(emoji.name);
  return null;
}

/** Returns all non-bot user IDs who reacted with emojiId. */
async function fetchReactorIds(rest, channelId, msgId, emojiId) {
  const ids = [];
  let after;
  while (true) {
    const page = await rest
      .get(Routes.channelMessageReaction(channelId, msgId, emojiId), {
        query: makeURLSearchParams({ limit: 100, ...(after && { after }) }),
      })
      .catch(() => []);
    if (!Array.isArray(page) || page.length === 0) break;
    for (const u of page) {
      if (u.id && !u.bot) ids.push(u.id);
    }
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  return ids;
}

/** @returns {Promise<any[]>} */
async function fetchPage(rest, channelId, opts = {}) {
  const params = { limit: opts.limit ?? 100 };
  if (opts.before) params.before = opts.before;
  if (opts.after) params.after = opts.after;
  const result = await rest
    .get(Routes.channelMessages(channelId), {
      query: makeURLSearchParams(params),
    })
    .catch(() => []);
  return Array.isArray(result) ? result : [];
}

// ─────────────────────────────────────────────
// Per-message processor
// ─────────────────────────────────────────────

async function processMessage(raw, ch, rest, channelId, config) {
  const msgId = raw.id;
  const postedAt = snowflakeToMs(msgId);
  const authorId = raw.author?.id ?? null;
  const now = Date.now();

  // 1. Photo signatures
  if (Array.isArray(raw.attachments)) {
    for (const att of raw.attachments) {
      if (!isImageAttachment(att)) continue;
      const sig = attachmentSignature(att);
      if (!ch.photoSigs[sig])
        ch.photoSigs[sig] = { messageId: msgId, addedAt: now };
    }
  }

  // 2. Image URL for announcement (pick first image from attachments)
  const imageUrl = pickImageUrl(raw.attachments ?? []);

  const rawReactions = Array.isArray(raw.reactions) ? raw.reactions : [];
  const meta = getMeta(ch, msgId, authorId, postedAt, imageUrl);

  // 3. Skip reactor fetch if already synced and outside speed window
  const alreadySynced = meta.syncedAt > 0;
  const inSpeedWindow =
    config.speedBonusEnabled &&
    now - postedAt < config.speedBonusMinutes * 60 * 1000;

  if (alreadySynced && !inSpeedWindow) return;

  if (rawReactions.length === 0) {
    meta.syncedAt = now;
    return;
  }

  // 4. Collect unique reactor IDs across ALL emoji
  const reactorSet = new Set();
  for (const r of rawReactions) {
    if (!r.count) continue;
    const key = emojiKey(r.emoji);
    if (!key) continue;
    const ids = await fetchReactorIds(rest, channelId, msgId, key);
    for (const id of ids) reactorSet.add(id);
  }

  meta.reactorIds = [...reactorSet];
  meta.syncedAt = now;

  // 5. Credit each unique reactor on their leaderboard
  //    Historical sync: 1 point (cannot know if they were fast at the time)
  for (const userId of reactorSet) {
    const user = getUser(ch, userId);
    if (user.rewarded.includes(msgId)) continue;
    if (!user.pending.includes(msgId)) {
      user.pending.push(msgId);
      user.points += 1;
      user.totalPoints += 1;
    }
  }
}

// ─────────────────────────────────────────────
// Public: syncChannel
// ─────────────────────────────────────────────

async function syncChannel(channel, data, config) {
  const channelId = channel.id;
  const rest = channel.client.rest;
  const ch = getChannel(data, channelId);
  const BATCH = 100;

  pruneChannel(ch, config.retentionDays);

  const isIncremental = ch.lastSeenMessageId !== null;
  console.log(
    `[sync] ${isIncremental ? "incremental" : "full"} — #${channel.name} (${channelId})`,
  );

  let processed = 0;
  let newestId = ch.lastSeenMessageId;

  if (isIncremental) {
    let after = ch.lastSeenMessageId;
    while (true) {
      const page = await fetchPage(rest, channelId, { after, limit: BATCH });
      if (page.length === 0) break;
      for (const raw of page) {
        await processMessage(raw, ch, rest, channelId, config);
        processed++;
        if (!newestId || raw.id > newestId) newestId = raw.id;
      }
      if (page.length < BATCH) break;
      after = page[page.length - 1].id;
    }
  } else {
    let before;
    while (true) {
      const page = await fetchPage(rest, channelId, { before, limit: BATCH });
      if (page.length === 0) break;
      for (const raw of page) {
        await processMessage(raw, ch, rest, channelId, config);
        processed++;
        if (!newestId || raw.id > newestId) newestId = raw.id;
      }
      if (page.length < BATCH) break;
      before = page[page.length - 1].id;
    }
  }

  if (newestId) ch.lastSeenMessageId = newestId;
  saveData(data);
  console.log(
    `[sync] complete — ${processed} messages, ${Object.keys(ch.users).length} users tracked`,
  );

  const userCount = Object.keys(ch.users).length;
  const mode = isIncremental ? "تحديث" : "مزامنة كاملة";
  await channel
    .send(
      `\u2705 **${mode} انتهت.**\n` +
        `تمت معالجة ${processed} رسالة، ${userCount} مستخدم في التتبع.`,
    )
    .catch(() => null);
}

module.exports = { syncChannel, snowflakeToMs, emojiKey };
