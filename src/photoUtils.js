/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * Deterministic fingerprint for an image attachment.
 * Works with both discord.js Attachment objects and raw REST objects.
 */
function attachmentSignature(att) {
  return `${att.name ?? ""}|${att.size ?? ""}|${att.width ?? ""}|${att.height ?? ""}|${att.contentType ?? ""}`;
}

/** @param {{ name?:string|null, contentType?:string|null }} att */
function isImageAttachment(att) {
  return (
    (att.contentType != null && att.contentType.startsWith("image/")) ||
    /\.(jpe?g|png|gif|webp)$/i.test(att.name ?? "")
  );
}

/**
 * Picks the URL of the first image attachment from an array of attachment objects.
 * Works with both discord.js Attachment collections and raw REST attachment arrays.
 * @param {any} attachments  Collection (discord.js) or Array (REST)
 * @returns {string|null}
 */
function pickImageUrl(attachments) {
  const items =
    attachments instanceof Map ||
    (attachments && typeof attachments.values === "function")
      ? [...attachments.values()]
      : Array.isArray(attachments)
        ? attachments
        : [];

  for (const att of items) {
    if (!isImageAttachment(att)) continue;
    const url = att.url ?? att.proxy_url ?? null;
    if (url) return url;
  }
  return null;
}

module.exports = { attachmentSignature, isImageAttachment, pickImageUrl };
