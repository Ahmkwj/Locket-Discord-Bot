"use strict";

/**
 * reactions.js — live messageReactionAdd handler
 *
 * On every reaction in the watch channel:
 *   1. Update meta.reactorIds (the unique-reactor list used by the best-photo picker).
 *   2. Credit the reactor once per message per cycle (speed-bonus-aware).
 *   3. If the user crosses the goal threshold, announce it and reset their cycle.
 *
 * Authors never earn points on their own photos.
 */

const {
  getChannel,
  getUser,
  getMeta,
  saveData,
  reactionPoints,
} = require("./storage");
const { snowflakeToMs } = require("./sync");
const { pickImageUrl } = require("./photoUtils");

async function onReactionAdd(reaction, user, client, config, data, saveDataFn) {
  if (user.bot) return;

  // Resolve partials — bail if Discord returns an error (deleted msg, no perms, etc.)
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (reaction.message.channel.partial)
      await reaction.message.channel.fetch();
  } catch {
    return;
  }

  const { watchChannelId, notifyChannelId } = config;
  if (!watchChannelId) return;
  if (reaction.message.channel.id !== watchChannelId) return;

  const messageId = reaction.message.id;
  const userId = user.id;
  const authorId = reaction.message.author?.id ?? null;
  const now = Date.now();
  const postedAt = snowflakeToMs(messageId);
  const imageUrl = pickImageUrl(reaction.message.attachments);

  const ch = getChannel(data, watchChannelId);
  const meta = getMeta(ch, messageId, authorId, postedAt, imageUrl);
  const userRecord = getUser(ch, userId);

  // 1. Update unique-reactor list (used by weekly/best-photo picker)
  if (!meta.reactorIds.includes(userId)) {
    meta.reactorIds.push(userId);
  }

  // 2. Credit leaderboard — once per message per cycle; authors excluded
  const alreadyRewarded = userRecord.rewarded.includes(messageId);
  const alreadyPending = userRecord.pending.includes(messageId);
  const isSelfReaction = userId === authorId;

  if (!alreadyRewarded && !alreadyPending && !isSelfReaction) {
    const pts = reactionPoints(postedAt, now, config);
    userRecord.pending.push(messageId);
    userRecord.points += pts;
    userRecord.totalPoints += pts;
  }

  saveDataFn(data);

  // 3. Goal check
  if (!config.goalNotifyEnabled) return;
  if (!notifyChannelId) return;
  if (alreadyRewarded || alreadyPending || isSelfReaction) return;
  if (userRecord.points < config.reactionThreshold) return;

  // ── Goal reached ──────────────────────────────────────────────────────────
  const notifyChannel = await client.channels
    .fetch(notifyChannelId)
    .catch(() => null);
  if (!notifyChannel) return;

  userRecord.cycles += 1;
  const pts = reactionPoints(postedAt, now, config);
  const speedNote =
    config.speedBonusEnabled && pts === 2
      ? "\n> ⚡ **تفاعل سريع!** (ضعف النقاط)"
      : "";

  await notifyChannel
    .send(
      `🏆 **${user} أكمل الهدف!**\n` +
        `> 🎯 الهدف: **${config.reactionThreshold}** نقطة\n` +
        `> 🔄 الجولة رقم: **${userRecord.cycles}**\n` +
        `> 📊 إجمالي النقاط: **${userRecord.totalPoints}**` +
        speedNote,
    )
    .catch(() => null);

  // Move pending → rewarded so this cycle's messages can never earn credit again
  const rewardedSet = new Set(userRecord.rewarded);
  for (const id of userRecord.pending) rewardedSet.add(id);
  userRecord.rewarded = [...rewardedSet];
  userRecord.pending = [];
  userRecord.points = 0;
  saveDataFn(data);
}

module.exports = { onReactionAdd };
