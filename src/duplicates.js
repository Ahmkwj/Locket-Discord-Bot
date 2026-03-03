"use strict";

/**
 * duplicates.js — live duplicate-photo detection
 *
 * Active only when config.duplicateCheckEnabled is true.
 * Fingerprint = attachment name + size + width + height + contentType.
 * If any image on a new message matches a stored sig, the message is
 * deleted, the poster is DM'd in Arabic, and the notify channel is informed.
 */

const { getChannel, pruneChannel } = require("./storage");
const { attachmentSignature, isImageAttachment } = require("./photoUtils");

/**
 * Returns true if any image on the message matches a known photo signature.
 * Also runs a throttled prune pass to keep data.json lean.
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
 * Deletes the duplicate message, DMs the poster, and notifies the notify channel.
 */
async function handleDuplicatePhoto(message, client, config) {
  // Delete first so other members don't see it
  await message.delete().catch(() => null);

  // DM the poster in Arabic
  await message.author
    .send(
      `⚠️ **تنبيه — صورة مكررة**\n` +
        `تم حذف رسالتك من <#${message.channel.id}> لأن الصورة مطابقة لصورة سبق نشرها في نفس الروم.\n` +
        `يُرجى التأكد من عدم تكرار الصور قبل النشر.`,
    )
    .catch(() => null); // DMs may be closed — non-fatal

  // Notify admins
  if (!config.notifyChannelId) return;
  const notifyChannel = await client.channels
    .fetch(config.notifyChannelId)
    .catch(() => null);
  await notifyChannel
    ?.send(
      `🚫 **صورة مكررة محذوفة**\n` +
        `> 👤 المُرسِل: ${message.author} (\`${message.author.id}\`)\n` +
        `> 📌 الروم: <#${message.channel.id}>`,
    )
    .catch(() => null);
}

module.exports = {
  checkDuplicatePhoto,
  registerPhotoSignatures,
  handleDuplicatePhoto,
};
