"use strict";

/**
 * sync.js — channel history scanner
 *
 * On every bot start:
 *   • First run  → full scan of entire channel history
 *   • Later runs → incremental scan (only messages newer than lastSeenMessageId)
 *
 * During scan:
 *   - A single status message is sent to the notify channel and edited live.
 *   - Goal announcements fire in real-time as users cross the threshold,
 *     exactly as if the bot had been running since the very first message.
 *     A user with 350 historical points will get 3 announcements and end
 *     the sync at 50 points — perfectly on track for the next cycle.
 *
 * Only messages with image/video attachments earn points.
 * One point per unique image reacted to, per user. Authors excluded.
 */

const { Routes } = require("discord-api-types/v10");
const { makeURLSearchParams } = require("@discordjs/rest");

const { getChannel, getUser, getMeta, saveData } = require("./storage");

const DISCORD_EPOCH = 1_420_070_400_000n;
const BATCH = 100; // Discord max per request
const PROGRESS_EVERY = 100; // edit status message every N messages

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function snowflakeToMs(snowflake) {
  try {
    return Number((BigInt(snowflake) >> 22n) + DISCORD_EPOCH);
  } catch {
    return Date.now();
  }
}

function emojiKey(emoji) {
  if (!emoji) return null;
  if (emoji.id) return `${emoji.name}:${emoji.id}`;
  if (emoji.name) return encodeURIComponent(emoji.name);
  return null;
}

/** True if a raw REST message object contains an image or video attachment. */
function messageHasMedia(raw) {
  if (Array.isArray(raw.attachments) && raw.attachments.length > 0) return true;
  if (
    Array.isArray(raw.embeds) &&
    raw.embeds.some((e) => e.type === "image" || e.image || e.thumbnail)
  )
    return true;
  return false;
}

// ─────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────

async function fetchReactorIds(rest, channelId, msgId, key) {
  const ids = [];
  let after;

  while (true) {
    const page = await rest
      .get(Routes.channelMessageReaction(channelId, msgId, key), {
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

async function fetchPage(rest, channelId, opts = {}) {
  const params = { limit: opts.limit ?? BATCH };
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
// Per-message processing
// Returns the list of user IDs that were credited points on this message.
// ─────────────────────────────────────────────

async function processMessage(raw, ch, rest, channelId) {
  const msgId = raw.id;
  const postedAt = snowflakeToMs(msgId);
  const authorId = raw.author?.id ?? null;
  const now = Date.now();

  const imageUrl =
    Array.isArray(raw.attachments) && raw.attachments.length > 0
      ? (raw.attachments[0].url ?? null)
      : null;

  const meta = getMeta(ch, msgId, authorId, postedAt, imageUrl);

  if (meta.syncedAt > 0) return []; // already processed — skip

  if (!messageHasMedia(raw)) {
    meta.syncedAt = now;
    return [];
  }

  const rawReactions = Array.isArray(raw.reactions) ? raw.reactions : [];

  if (rawReactions.length === 0) {
    meta.syncedAt = now;
    return [];
  }

  // Collect every unique human reactor across all emoji
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

  // Award one point per reactor (self-reactions excluded)
  const credited = [];

  for (const userId of reactorSet) {
    if (userId === authorId) continue;

    const user = getUser(ch, userId);
    if (user.rewarded.includes(msgId) || user.pending.includes(msgId)) continue;

    user.pending.push(msgId);
    user.points += 1;
    user.totalPoints += 1;
    credited.push(userId);
  }

  return credited;
}

// ─────────────────────────────────────────────
// Goal check — fires announcements and resets for a single user.
//
// Uses Math.floor so bulk-accumulated points work correctly:
//   250 points → 2 announcements fired, user ends at 50.
//
// This is called both:
//   • During sync, after each individual credit (normal case: 1 point at a time)
//   • In sweepPendingGoals after sync (catches legacy data where goals were
//     never fired because the bot was offline or ran old code)
// ─────────────────────────────────────────────

async function checkGoal(userId, userRecord, config, notifyChannel) {
  if (userRecord.points < config.reactionThreshold) return;

  const completedCycles = Math.floor(
    userRecord.points / config.reactionThreshold,
  );
  const remainder = userRecord.points % config.reactionThreshold;

  for (let i = 0; i < completedCycles; i++) {
    userRecord.cycles += 1;

    if (notifyChannel) {
      await notifyChannel
        .send(
          `🎉 <@${userId}> reached the goal of **${config.reactionThreshold}** reaction points!\n` +
            `📈 All-time total: **${userRecord.totalPoints}** pts · Cycle **#${userRecord.cycles}** complete.\n` +
            `Their score has been reset — the hunt begins again! 🔁`,
        )
        .catch(() => null);
    }
  }

  // Move all pending → rewarded so those messages never earn credit again
  const rewardedSet = new Set(userRecord.rewarded);
  for (const id of userRecord.pending) rewardedSet.add(id);
  userRecord.rewarded = [...rewardedSet];
  userRecord.pending = [];
  userRecord.points = remainder;
}

// ─────────────────────────────────────────────
// Sweep — runs after every sync to catch any users whose points
// crossed the goal while the bot was offline or on old code.
// ─────────────────────────────────────────────

async function sweepPendingGoals(ch, config, notifyChannel, data) {
  let fired = false;

  for (const [userId, userRecord] of Object.entries(ch.users)) {
    if (userRecord.points >= config.reactionThreshold) {
      await checkGoal(userId, userRecord, config, notifyChannel);
      fired = true;
    }
  }

  if (fired) saveData(data);
}

// ─────────────────────────────────────────────
// Main sync entry point
// ─────────────────────────────────────────────

async function syncChannel(channel, data, config) {
  const channelId = channel.id;
  const rest = channel.client.rest;
  const client = channel.client;
  const ch = getChannel(data, channelId);

  const incremental = ch.lastSeenMessageId !== null;

  // ── Fetch notify channel once — reused for status + goal announcements ─────
  let notifyChannel = null;
  if (config.notifyChannelId) {
    notifyChannel = await client.channels
      .fetch(config.notifyChannelId)
      .catch(() => null);
    if (!notifyChannel) console.warn("[sync] notify channel not found");
  }

  // ── Send live status message ───────────────────────────────────────────────
  let statusMsg = null;
  if (notifyChannel) {
    statusMsg = await notifyChannel
      .send(
        incremental
          ? `🔄 Syncing <#${channelId}>... Checking for new messages since last run.`
          : `🔄 Syncing <#${channelId}>... Full scan started — reading entire channel history. This may take a while ⏳`,
      )
      .catch(() => null);
  }

  const editStatus = async (text) => {
    if (statusMsg) await statusMsg.edit(text).catch(() => null);
  };

  let processed = 0;
  let newestId = ch.lastSeenMessageId;

  const spinners = ["⏳", "🔄", "📡", "🔃"];
  const spinner = () =>
    spinners[Math.floor(processed / PROGRESS_EVERY) % spinners.length];

  const reportProgress = async () => {
    await editStatus(
      `${spinner()} Syncing <#${channelId}>... **${processed}** messages scanned so far...`,
    );
  };

  // ── Shared scan loop body ──────────────────────────────────────────────────
  const handlePage = async (page) => {
    for (const raw of page) {
      const credited = await processMessage(raw, ch, rest, channelId);

      // Fire goal notifications immediately, exactly as if bot were live
      for (const userId of credited) {
        await checkGoal(userId, getUser(ch, userId), config, notifyChannel);
      }

      processed++;
      if (!newestId || raw.id > newestId) newestId = raw.id;
      if (processed % PROGRESS_EVERY === 0) await reportProgress();
    }
  };

  try {
    if (incremental) {
      // ── Scan forward from last checkpoint ─────────────────────────────────
      let after = ch.lastSeenMessageId;

      while (true) {
        const page = await fetchPage(rest, channelId, { after, limit: BATCH });
        if (page.length === 0) break;

        await handlePage(page);
        saveData(data);

        if (page.length < BATCH) break;
        after = page[page.length - 1].id;
      }
    } else {
      // ── Full scan: walk backwards through entire history ───────────────────
      let before;

      while (true) {
        const page = await fetchPage(rest, channelId, { before, limit: BATCH });
        if (page.length === 0) break;

        await handlePage(page);
        saveData(data);

        if (page.length < BATCH) break;
        before = page[page.length - 1].id;
      }
    }

    if (newestId) ch.lastSeenMessageId = newestId;
    saveData(data);

    // Final sweep: fire any goal notifications that were missed while the bot
    // was offline or running old code (handles existing data.json points too)
    await sweepPendingGoals(ch, config, notifyChannel, data);

    const memberCount = Object.keys(ch.users).length;

    await editStatus(
      `✅ **Sync complete** for <#${channelId}>!\n` +
        `📊 **${processed}** messages scanned · **${memberCount}** members tracked.`,
    );
  } catch (err) {
    await editStatus(
      `❌ Sync failed for <#${channelId}>: ${String(err.message || err)}`,
    );
    throw err;
  }
}

module.exports = { syncChannel, snowflakeToMs, emojiKey, checkGoal };
