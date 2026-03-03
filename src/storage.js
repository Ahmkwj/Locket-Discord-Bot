"use strict";

/**
 * storage.js — config and data persistence
 *
 * config.json  : bot settings (token read from .env via DISCORD_TOKEN, never saved back)
 * data.json    : runtime state — channels, users, photo sigs, message metadata
 *
 * Both files live in the project ROOT (one level above src/).
 * Writes are atomic: write to .tmp → rename.
 */

const fs = require("fs");
const path = require("path");

// Project root is one level above src/
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");
const DATA_PATH = path.join(ROOT, "data.json");

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // at most once per 6 h

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
    speedBonusMinutes: posInt(raw.speedBonusMinutes, 60),
    intervalDays: posInt(raw.intervalDays, 7),
    lastAnnouncedAt: posNum(raw.lastAnnouncedAt, 0),
    retentionDays: posInt(raw.retentionDays, 30),
    weeklyEnabled: bool(raw.weeklyEnabled, true),
    duplicateCheckEnabled: bool(raw.duplicateCheckEnabled, true),
    speedBonusEnabled: bool(raw.speedBonusEnabled, true),
    goalNotifyEnabled: bool(raw.goalNotifyEnabled, true),
    leaderboardEnabled: bool(raw.leaderboardEnabled, true),
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
    lastPrunedAt: 0,
    photoSigs: {},
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

  // Back-compat: old array-based photoSigs / photoSignatures
  const photoSigs =
    ch.photoSigs && typeof ch.photoSigs === "object" ? { ...ch.photoSigs } : {};
  if (Array.isArray(ch.photoSignatures)) {
    for (const item of ch.photoSignatures) {
      if (!item) continue;
      const sig = typeof item === "string" ? item : item.sig;
      const addedAt =
        typeof item === "object" && typeof item.addedAt === "number"
          ? item.addedAt
          : Date.now();
      if (sig && !photoSigs[sig]) photoSigs[sig] = { messageId: null, addedAt };
    }
  }

  return {
    lastSeenMessageId: str(ch.lastSeenMessageId),
    lastPrunedAt: posNum(ch.lastPrunedAt, 0),
    photoSigs,
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
  // data.json may be missing, empty, or contain invalid JSON — handle all cases
  let raw = null;
  try {
    const text = fs.readFileSync(DATA_PATH, "utf8").trim();
    if (text) raw = JSON.parse(text); // SyntaxError if corrupt
  } catch (err) {
    if (err.code !== "ENOENT") {
      // File exists but is empty or corrupt — log and start fresh
      console.warn(
        `[storage] data.json unreadable (${err.message}), starting fresh.`,
      );
    }
  }

  const data = migrate(raw ?? {});

  // Always ensure the file exists on disk with valid JSON
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
// Pruning
// ─────────────────────────────────────────────

function pruneChannel(ch, retentionDays, force = false) {
  const now = Date.now();
  if (!force && now - ch.lastPrunedAt < PRUNE_INTERVAL_MS) return false;

  ch.lastPrunedAt = now;
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let changed = false;

  for (const [sig, e] of Object.entries(ch.photoSigs)) {
    if (e.addedAt < cutoff) {
      delete ch.photoSigs[sig];
      changed = true;
    }
  }

  const pruned = new Set();
  for (const [mid, m] of Object.entries(ch.messages)) {
    if (m.postedAt < cutoff) {
      delete ch.messages[mid];
      pruned.add(mid);
      changed = true;
    }
  }

  if (pruned.size > 0) {
    for (const u of Object.values(ch.users)) {
      const pb = u.pending.length,
        rb = u.rewarded.length;
      u.pending = u.pending.filter((id) => !pruned.has(id));
      u.rewarded = u.rewarded.filter((id) => !pruned.has(id));
      if (u.pending.length !== pb || u.rewarded.length !== rb) changed = true;
    }
  }

  return changed;
}

// ─────────────────────────────────────────────
// Permissions
// ─────────────────────────────────────────────

const isOwner = (cfg, uid) => uid === cfg.ownerId;
const isMod = (cfg, uid) => cfg.modIds.includes(uid);
const isAllowed = (cfg, uid) => isOwner(cfg, uid) || isMod(cfg, uid);

// ─────────────────────────────────────────────
// Points
// ─────────────────────────────────────────────

function reactionPoints(postedAt, reactedAt, cfg) {
  if (!cfg.speedBonusEnabled) return 1;
  return reactedAt - postedAt <= cfg.speedBonusMinutes * 60 * 1000 ? 2 : 1;
}

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
const bool = (v, d) => (typeof v === "boolean" ? v : d);
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
  pruneChannel,
  isOwner,
  isMod,
  isAllowed,
  reactionPoints,
  defaultChannel,
  defaultUser,
  defaultMeta,
};

/**
 * @typedef {{ token:string, ownerId:string, modIds:string[],
 *   watchChannelId:string|null, notifyChannelId:string|null,
 *   reactionThreshold:number, speedBonusMinutes:number,
 *   intervalDays:number, lastAnnouncedAt:number, retentionDays:number,
 *   weeklyEnabled:boolean, duplicateCheckEnabled:boolean,
 *   speedBonusEnabled:boolean, goalNotifyEnabled:boolean, leaderboardEnabled:boolean,
 * }} BotConfig
 *
 * @typedef {{ points:number, pending:string[], rewarded:string[], cycles:number, totalPoints:number }} UserData
 *
 * @typedef {{ authorId:string|null, postedAt:number, imageUrl:string|null, reactorIds:string[], syncedAt:number }} MessageMeta
 *
 * @typedef {{ lastSeenMessageId:string|null, lastPrunedAt:number,
 *   photoSigs:Record<string,{messageId:string|null,addedAt:number}>,
 *   messages:Record<string,MessageMeta>, users:Record<string,UserData> }} ChannelData
 *
 * @typedef {{ channels:Record<string,ChannelData> }} BotData
 */
