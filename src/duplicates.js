/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * duplicates.js — live duplicate photo detection
 *
 * Only active when config.duplicateCheckEnabled is true.
 * Fingerprint = attachment name + size + dimensions + contentType.
 * If any image on a new message matches a known sig, the message is deleted.
 */

const { getChannel, pruneChannel } = require("./storage");
const { attachmentSignature, isImageAttachment } = require("./photoUtils");

/**
 * Returns true if any image on the message matches a known photo signature.
 * Also runs a throttled prune pass so data.json stays lean.
 */
function checkDuplicatePhoto(message, config, data, saveDataFn) {
  if (!config.duplicateCheckEnabled) return false;
  if (!config.watchChannelId || message.channel.id !== config.watchChannelId)
    return false;
  if (message.attachments.size === 0) return false;

  const ch = getChannel(data, message.channel.id);
  if (pruneChannel(ch, config.retentionDays)) saveDataFn(data);

  for (const [, att] of message.attachments) {
    if (!isImageAttachment(att)) continue;
    if (ch.photoSigs[attachmentSignature(att)]) return true;
  }
  return false;
}

/**
 * Registers image signatures from a new, accepted (non-duplicate) message.
 */
function registerPhotoSignatures(message, config, data, saveDataFn) {
  if (!config.watchChannelId || message.channel.id !== config.watchChannelId)
    return;

  const ch = getChannel(data, message.channel.id);
  const now = Date.now();
  let changed = false;

  for (const [, att] of message.attachments) {
    if (!isImageAttachment(att)) continue;
    const sig = attachmentSignature(att);
    if (!ch.photoSigs[sig]) {
      ch.photoSigs[sig] = { messageId: message.id, addedAt: now };
      changed = true;
    }
  }
  if (changed) saveDataFn(data);
}

/**
 * Deletes the duplicate, DMs the poster, notifies the notify channel.
 */
async function handleDuplicatePhoto(message, client, config) {
  await message.delete().catch(() => null);

  await message.author
    .send(
      `⚠️ **تنبيه — صورة مكررة**\n` +
        `تم حذف صورتك من **${message.channel.name}** لأنها مطابقة لصورة سبق نشرها في نفس القناة.\n` +
        `يُرجى التأكد من عدم تكرار الصور قبل النشر.`,
    )
    .catch(() => null);

  if (!config.notifyChannelId) return;
  const notifyChannel = await client.channels
    .fetch(config.notifyChannelId)
    .catch(() => null);
  await notifyChannel
    ?.send(
      `🚫 **صورة مكررة** — حُذفت صورة من <#${message.channel.id}> أرسلها ${message.author}.`,
    )
    .catch(() => null);
}

module.exports = {
  checkDuplicatePhoto,
  registerPhotoSignatures,
  handleDuplicatePhoto,
};
