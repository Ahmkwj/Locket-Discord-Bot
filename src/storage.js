"use strict";

/**
 * storage.js — config and data persistence
 *
 * config.json  : bot settings (token read from .env via DISCORD_TOKEN, never saved back)
 * data.json    : runtime state — channels, users, and message metadata
 *
 * Both files live in the project ROOT (one level above src/).
 * Writes are atomic: write to .tmp → rename.
 *
 * Message data is kept forever — we never prune it, so a message that was
 * already counted can never be double-counted in a future sync.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_PATH = path.join(ROOT, "data.json");

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

function validateConfig(raw) {
  if (!raw || typeof raw !== "object")
    throw new TypeError("config.json must be a JSON object");

  const token =
    (typeof raw.token === "string" && raw.token.trim()) ||
    (process.env.DISCORD_TOKEN && process.env.DISCORD_TOKEN.trim());
  if (!token)
    throw new TypeError("DISCORD_TOKEN must be set in .env or config.json");

  if (typeof raw.ownerId !== "string" || !raw.ownerId.trim())
    throw new TypeError("config.json: `ownerId` must be a non-empty string");

  return {
    token,
    ownerId: raw.ownerId.trim(),
    modIds: Array.isArray(raw.modIds)
      ? raw.modIds.filter((id) => typeof id === "string" && id.trim())
      : [],
    watchChannelId: str(raw.watchChannelId),
    notifyChannelId: str(raw.notifyChannelId),
    reactionThreshold: posInt(raw.reactionThreshold, 100),
  };
}

function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Failed to load config.json: ${err.message}`);
  }
  return validateConfig(raw);
}

/** Saves config WITHOUT the token (token stays in .env only). */
function saveConfig(cfg) {
  const out = { ...cfg };
  delete out.token;
  atomicWrite(CONFIG_PATH, JSON.stringify(out, null, 2));
}

// ─────────────────────────────────────────────
// Data defaults
// ─────────────────────────────────────────────

function defaultChannel() {
  return {
    lastSeenMessageId: null,
    messages: {},
    users: {},
  };
}

function defaultUser() {
  return { points: 0, pending: [], rewarded: [], cycles: 0, totalPoints: 0 };
}

function defaultMeta(authorId, postedAt, imageUrl = null) {
  return {
    authorId: authorId ?? null,
    postedAt: postedAt ?? Date.now(),
    imageUrl: imageUrl ?? null,
    reactorIds: [],
    syncedAt: 0,
  };
}

// ─────────────────────────────────────────────
// Migration — tolerates old / empty / corrupt data.json
// ─────────────────────────────────────────────

function migrateUser(u) {
  if (!u || typeof u !== "object") return defaultUser();
  return {
    points: posNum(u.points, 0),
    pending: arr(u.pending),
    rewarded: arr(u.rewarded),
    cycles: posInt(u.cycles, 0),
    totalPoints: posNum(u.totalPoints, 0),
  };
}

function migrateMeta(m) {
  if (!m || typeof m !== "object") return defaultMeta(null, 0);
  return {
    authorId: str(m.authorId),
    postedAt: posNum(m.postedAt, 0),
    imageUrl: str(m.imageUrl),
    reactorIds: arr(m.reactorIds),
    syncedAt: posNum(m.syncedAt, 0),
  };
}

function migrateChannel(ch) {
  if (!ch || typeof ch !== "object") return defaultChannel();

  const users = {};
  for (const [uid, u] of Object.entries(ch.users ?? {}))
    users[uid] = migrateUser(u);

  const messages = {};
  for (const [mid, m] of Object.entries(ch.messages ?? {}))
    messages[mid] = migrateMeta(m);

  return {
    lastSeenMessageId: str(ch.lastSeenMessageId),
    messages,
    users,
  };
}

function migrate(raw) {
  if (
    raw?.channels &&
    typeof raw.channels === "object" &&
    !Array.isArray(raw.channels)
  ) {
    const channels = {};
    for (const [cid, ch] of Object.entries(raw.channels))
      channels[cid] = migrateChannel(ch);
    return { channels };
  }
  return { channels: {} };
}

// ─────────────────────────────────────────────
// Data load / save
// ─────────────────────────────────────────────

function loadData() {
  let raw = null;
  try {
    const text = fs.readFileSync(DATA_PATH, "utf8").trim();
    if (text) raw = JSON.parse(text);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[storage] data.json unreadable (${err.message}), starting fresh.`,
      );
    }
  }

  const data = migrate(raw ?? {});

  if (!fs.existsSync(DATA_PATH)) {
    try {
      atomicWrite(DATA_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("[storage] Could not create data.json:", e.message);
    }
  }

  return data;
}

function saveData(data) {
  atomicWrite(DATA_PATH, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────
// Accessors
// ─────────────────────────────────────────────

function getChannel(data, channelId) {
  if (!data.channels[channelId]) data.channels[channelId] = defaultChannel();
  return data.channels[channelId];
}

function getUser(ch, userId) {
  if (!ch.users[userId]) ch.users[userId] = defaultUser();
  return ch.users[userId];
}

function getMeta(ch, msgId, authorId, postedAt, imageUrl) {
  if (!ch.messages[msgId])
    ch.messages[msgId] = defaultMeta(authorId, postedAt, imageUrl);
  // Backfill imageUrl if previously stored as null
  if (imageUrl && !ch.messages[msgId].imageUrl)
    ch.messages[msgId].imageUrl = imageUrl;
  return ch.messages[msgId];
}

// ─────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────

const isOwner = (cfg, uid) => uid === cfg.ownerId;
const isMod = (cfg, uid) => cfg.modIds.includes(uid);
const isAllowed = (cfg, uid) => isOwner(cfg, uid) || isMod(cfg, uid);

// ─────────────────────────────────────────────
// Atomic write
// ─────────────────────────────────────────────

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

// ─────────────────────────────────────────────
// Tiny coercers
// ─────────────────────────────────────────────

const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
const posNum = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v) => (Array.isArray(v) ? v : []);

// ─────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────

module.exports = {
  loadConfig,
  saveConfig,
  loadData,
  saveData,
  getChannel,
  getUser,
  getMeta,
  isOwner,
  isMod,
  isAllowed,
  defaultChannel,
  defaultUser,
  defaultMeta,
};
