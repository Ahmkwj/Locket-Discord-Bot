"use strict";

/**
 * sync.js — channel sync engine
 *
 * For each message in the watch channel:
 *   1. Register photo signatures (duplicate guard).
 *   2. Store imageUrl (first image attachment) for the best-photo announcement.
 *   3. Collect unique human reactor IDs across ALL emoji → meta.reactorIds.
 *   4. Credit each unique reactor once on their leaderboard (1 pt for historical sync).
 *
 * Skip optimisation:
 *   If meta.syncedAt > 0 the message has been fully processed.
 *   We re-process only if it is still inside the speed-bonus window
 *   (fresh reactions may still be arriving and need accurate point allocation).
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
// Snowflake → unix-ms
// ─────────────────────────────────────────────

const DISCORD_EPOCH = 1_420_070_400_000n;

function snowflakeToMs(snowflake) {
  try {
    return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
  } catch {
    return Date.now();
  }
}

// ─────────────────────────────────────────────
// Emoji key (used as URL segment in reaction endpoint)
// ─────────────────────────────────────────────

function emojiKey(emoji) {
  if (!emoji) return null;
  if (emoji.id) return `${emoji.name}:${emoji.id}`;
  if (emoji.name) return encodeURIComponent(emoji.name);
  return null;
}

// ─────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────

/** Fetches ALL non-bot user IDs who placed a given reaction on a message. */
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
    for (const u of page) if (u.id && !u.bot) ids.push(u.id);
    if (page.length < 100) break;
    after = page[page.length - 1].id;
  }
  return ids;
}

/** Fetches one page of channel messages. */
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

  // 1. Register photo signatures for duplicate detection
  if (Array.isArray(raw.attachments)) {
    for (const att of raw.attachments) {
      if (!isImageAttachment(att)) continue;
      const sig = attachmentSignature(att);
      if (!ch.photoSigs[sig])
        ch.photoSigs[sig] = { messageId: msgId, addedAt: now };
    }
  }

  // 2. Pick first image URL (stored for the best-photo announcement)
  const imageUrl = pickImageUrl(raw.attachments ?? []);
  const rawReactions = Array.isArray(raw.reactions) ? raw.reactions : [];
  const meta = getMeta(ch, msgId, authorId, postedAt, imageUrl);

  // 3. Skip if already synced and outside speed-bonus window
  const alreadySynced = meta.syncedAt > 0;
  const inSpeedWindow =
    config.speedBonusEnabled &&
    now - postedAt < config.speedBonusMinutes * 60 * 1000;

  if (alreadySynced && !inSpeedWindow) return;

  if (rawReactions.length === 0) {
    meta.syncedAt = now;
    return;
  }

  // 4. Fetch unique reactors across all emoji
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

  // 5. Credit each reactor on their leaderboard (historical = 1 pt each)
  for (const userId of reactorSet) {
    if (userId === authorId) continue; // authors don't earn points on their own photos
    const user = getUser(ch, userId);
    if (user.rewarded.includes(msgId) || user.pending.includes(msgId)) continue;
    user.pending.push(msgId);
    user.points += 1;
    user.totalPoints += 1;
  }
}

// ─────────────────────────────────────────────
// Notify helper — sends a message to the notify channel
// ─────────────────────────────────────────────

async function sendNotify(config, client, text) {
  if (!config.notifyChannelId || !client) return;
  try {
    const ch = await client.channels.fetch(config.notifyChannelId);
    await ch.send(text);
  } catch {
    // Notification failure is non-fatal — just log and continue
    console.warn("[sync] Could not send notify message.");
  }
}

// ─────────────────────────────────────────────
// Public: syncChannel
// ─────────────────────────────────────────────

async function syncChannel(channel, data, config) {
  const channelId = channel.id;
  const rest = channel.client.rest;
  const client = channel.client;
  const ch = getChannel(data, channelId);
  const BATCH = 100;

  pruneChannel(ch, config.retentionDays);

  const isIncremental = ch.lastSeenMessageId !== null;
  const syncType = isIncremental ? "تزامن تدريجي" : "تزامن كامل";

  console.log(
    `[sync] ${isIncremental ? "incremental" : "full"} — #${channel.name} (${channelId})`,
  );

  await sendNotify(
    config,
    client,
    `🔄 **بدء التزامن** — ${syncType} لقناة <#${channelId}>\n` +
      `> جارٍ جمع البيانات، يرجى الانتظار…`,
  );

  let processed = 0;
  let newestId = ch.lastSeenMessageId;

  try {
    if (isIncremental) {
      // Fetch all messages NEWER than the last known one
      let after = ch.lastSeenMessageId;
      while (true) {
        const page = await fetchPage(rest, channelId, { after, limit: BATCH });
        if (page.length === 0) break;
        // Process newest → oldest within page for correct newestId tracking
        for (const raw of page) {
          await processMessage(raw, ch, rest, channelId, config);
          processed++;
          if (!newestId || raw.id > newestId) newestId = raw.id;
        }
        saveData(data); // save after each batch so progress is not lost
        if (page.length < BATCH) break;
        after = page[page.length - 1].id;
      }
    } else {
      // Full scan — walk backwards from the latest message
      let before;
      while (true) {
        const page = await fetchPage(rest, channelId, { before, limit: BATCH });
        if (page.length === 0) break;
        for (const raw of page) {
          await processMessage(raw, ch, rest, channelId, config);
          processed++;
          if (!newestId || raw.id > newestId) newestId = raw.id;
        }
        saveData(data); // save after each batch
        if (page.length < BATCH) break;
        before = page[page.length - 1].id;
      }
    }

    if (newestId) ch.lastSeenMessageId = newestId;
    saveData(data);

    const userCount = Object.keys(ch.users).length;
    console.log(
      `[sync] complete — ${processed} messages, ${userCount} users tracked`,
    );

    await sendNotify(
      config,
      client,
      `✅ **اكتمل التزامن**\n` +
        `> 📨 الرسائل المعالجة: **${processed}**\n` +
        `> 👥 المستخدمون المتتبَّعون: **${userCount}**\n` +
        `> 📌 الروم: <#${channelId}>`,
    );
  } catch (err) {
    console.error("[sync] error:", err);
    await sendNotify(
      config,
      client,
      `❌ **فشل التزامن**\n` +
        `> الروم: <#${channelId}>\n` +
        `> الخطأ: ${String(err.message || err)}`,
    );
    throw err;
  }
}

module.exports = { syncChannel, snowflakeToMs, emojiKey };
