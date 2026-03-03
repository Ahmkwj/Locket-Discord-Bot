/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * reactions.js — live messageReactionAdd handler
 *
 * On every reaction:
 *   1. Update meta.reactorIds (the unique-reactor list used by the weekly winner).
 *   2. Credit the user once on their personal leaderboard (speed-bonus-aware).
 *   3. Check if the user has crossed the goal threshold and announce if so.
 */

const { getChannel, getUser, getMeta, reactionPoints } = require("./storage");
const { snowflakeToMs, emojiKey } = require("./sync");
const { pickImageUrl } = require("./photoUtils");

/**
 * @param {import("discord.js").MessageReaction} reaction
 * @param {import("discord.js").User}            user
 * @param {import("discord.js").Client}          client
 * @param {import("./storage").BotConfig}        config
 * @param {import("./storage").BotData}          data
 * @param {Function}                             saveDataFn
 */
async function onReactionAdd(reaction, user, client, config, data, saveDataFn) {
  if (user.bot) return;

  // Resolve partials — skip if fetch fails (permissions / deleted message).
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
  const now = Date.now();
  const postedAt = snowflakeToMs(messageId);
  const authorId = reaction.message.author?.id ?? null;

  // Pick image URL from the message (for weekly winner announcement).
  const imageUrl = pickImageUrl(reaction.message.attachments);

  const ch = getChannel(data, watchChannelId);
  const meta = getMeta(ch, messageId, authorId, postedAt, imageUrl);
  const userRecord = getUser(ch, userId);

  // ── 1. Update unique-reactor list ────────────────────────────────────────
  if (!meta.reactorIds.includes(userId)) {
    meta.reactorIds.push(userId);
  }

  // ── 2. Credit leaderboard (once per message per user per cycle) ──────────
  const alreadyRewarded = userRecord.rewarded.includes(messageId);
  const alreadyPending = userRecord.pending.includes(messageId);

  if (!alreadyRewarded && !alreadyPending) {
    const pts = reactionPoints(postedAt, now, config);
    userRecord.pending.push(messageId);
    userRecord.points += pts;
    userRecord.totalPoints += pts;
  }

  saveDataFn(data);

  // ── 3. Check goal ─────────────────────────────────────────────────────────
  if (!config.goalNotifyEnabled) return;
  if (!notifyChannelId) return;
  if (alreadyRewarded || alreadyPending) return;
  if (userRecord.points < config.reactionThreshold) return;

  // Goal reached.
  const notifyChannel = await client.channels
    .fetch(notifyChannelId)
    .catch(() => null);
  if (!notifyChannel) return;

  userRecord.cycles += 1;
  const speedNote =
    config.speedBonusEnabled && reactionPoints(postedAt, now, config) === 2
      ? " ⚡ (تفاعل سريع!)"
      : "";

  await notifyChannel
    .send(
      `🏆 **${user} أكمل الهدف!**${speedNote}\n` +
        `> تفاعل مع **${config.reactionThreshold}** نقطة\n` +
        `> الجولة رقم: **${userRecord.cycles}** • إجمالي النقاط: **${userRecord.totalPoints}**`,
    )
    .catch(() => null);

  // Move pending → rewarded so these IDs can never earn credit again.
  const rewardedSet = new Set(userRecord.rewarded);
  for (const id of userRecord.pending) rewardedSet.add(id);
  userRecord.rewarded = [...rewardedSet];
  userRecord.pending = [];
  userRecord.points = 0;
  saveDataFn(data);
}

module.exports = { onReactionAdd };
