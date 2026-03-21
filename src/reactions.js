"use strict";

/**
 * reactions.js — live messageReactionAdd handler
 *
 * Fires every time any user reacts to any message in the watch channel.
 *
 * Rules:
 *   • Only messages with image/video attachments are counted.
 *   • A user earns 1 point per unique image they react to (any emoji counts).
 *   • Reacting multiple times on the same image = still 1 point.
 *   • Authors never earn points for reacting to their own photos.
 *   • When a user hits the goal, their score is announced in the notify
 *     channel and reset to 0 so they can start a new cycle.
 */

const { getChannel, getUser, getMeta } = require("./storage");
const { snowflakeToMs, checkGoal }     = require("./sync");

async function onReactionAdd(reaction, user, client, config, data, saveDataFn) {
  if (user.bot) return;

  // Resolve partials — bail if Discord returns an error
  try {
    if (reaction.partial)                 await reaction.fetch();
    if (reaction.message.partial)         await reaction.message.fetch();
    if (reaction.message.channel.partial) await reaction.message.channel.fetch();
  } catch {
    return;
  }

  const { watchChannelId, notifyChannelId } = config;
  if (!watchChannelId) return;
  if (reaction.message.channel.id !== watchChannelId) return;

  // Only count media messages
  const msg      = reaction.message;
  const hasMedia = msg.attachments.size > 0 ||
    msg.embeds.some((e) => e.data?.type === "image" || e.image || e.thumbnail);
  if (!hasMedia) return;

  const messageId = msg.id;
  const userId    = user.id;
  const authorId  = msg.author?.id ?? null;
  const postedAt  = snowflakeToMs(messageId);

  const ch         = getChannel(data, watchChannelId);
  const meta       = getMeta(ch, messageId, authorId, postedAt, null);
  const userRecord = getUser(ch, userId);

  // Track unique reactors on this message
  if (!meta.reactorIds.includes(userId)) {
    meta.reactorIds.push(userId);
  }

  // Credit the reactor — once per message per cycle; authors excluded
  const alreadyRewarded = userRecord.rewarded.includes(messageId);
  const alreadyPending  = userRecord.pending.includes(messageId);
  const isSelfReaction  = userId === authorId;

  if (!alreadyRewarded && !alreadyPending && !isSelfReaction) {
    userRecord.pending.push(messageId);
    userRecord.points      += 1;
    userRecord.totalPoints += 1;

    saveDataFn(data);

    // Check if goal is reached
    if (notifyChannelId && userRecord.points >= config.reactionThreshold) {
      const notifyChannel = await client.channels.fetch(notifyChannelId).catch(() => null);
      await checkGoal(userId, userRecord, config, notifyChannel);
      saveDataFn(data);
    }
  } else {
    saveDataFn(data);
  }
}

module.exports = { onReactionAdd };
