/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

/**
 * storage.js — config and data persistence
 *
 * ═══════════════════════════════════════════
 * config.json shape
 * ═══════════════════════════════════════════
 * {
 *   "token":              "BOT_TOKEN",
 *   "ownerId":            "DISCORD_USER_ID",
 *   "modIds":             [],
 *
 *   // Channels
 *   "watchChannelId":     null,
 *   "notifyChannelId":    null,
 *
 *   // Leaderboard / goal
 *   "reactionThreshold":  100,      pts needed to complete a cycle
 *   "speedBonusMinutes":  60,       minutes after post where reaction = 2 pts
 *
 *   // Best-photo announcement
 *   "intervalDays":       7,        days between announcements
 *   "lastAnnouncedAt":    0,        unix-ms of last announcement
 *
 *   // Data retention
 *   "retentionDays":      30,       days to keep message / sig data
 *
 *   // Feature toggles  (all true by default)
 *   "weeklyEnabled":          true,   enable/disable best-photo announcements
 *   "duplicateCheckEnabled":  true,   enable/disable duplicate photo detection
 *   "speedBonusEnabled":      true,   enable/disable the 2x speed bonus
 *   "goalNotifyEnabled":      true,   enable/disable goal-reached notifications
 *   "leaderboardEnabled":     true,   enable/disable the leaderboard command
 * }
 *
 * ═══════════════════════════════════════════
 * data.json shape
 * ═══════════════════════════════════════════
 * {
 *   "channels": {
 *     "<channelId>": {
 *       "lastSeenMessageId": "snowflake | null",
 *       "lastPrunedAt": 0,
 *
 *       "photoSigs": {
 *         "<sig>": { "messageId": "snowflake", "addedAt": 1700000000000 }
 *       },
 *
 *       "messages": {
 *         "<messageId>": {
 *           "authorId":      "userId | null",
 *           "postedAt":      1700000000000,
 *           "imageUrl":      "https://... | null",  ← first image URL in message
 *           "reactorIds":    ["userId", ...],        ← unique human reactors (all emoji combined)
 *           "syncedAt":      0                       ← last time reactor list was fully fetched
 *         }
 *       },
 *
 *       "users": {
 *         "<userId>": {
 *           "points":      42,       current-cycle score
 *           "pending":     [],       msg IDs reacted to this cycle
 *           "rewarded":    [],       msg IDs counted in past cycles
 *           "cycles":      0,        completed goal cycles
 *           "totalPoints": 0         all-time points
 *         }
 *       }
 *     }
 *   }
 * }
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.resolve(__dirname, "..", "config.json");
const DATA_PATH = path.resolve(__dirname, "..", "data.json");

const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // prune at most once per 6 h

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

/** @param {unknown} raw @returns {BotConfig} */
function validateConfig(raw) {
  if (!raw || typeof raw !== "object")
    throw new TypeError("config.json must be a JSON object");
  if (typeof raw.token !== "string" || !raw.token.trim())
    throw new TypeError("config.json: `token` must be a non-empty string");
  if (typeof raw.ownerId !== "string" || !raw.ownerId.trim())
    throw new TypeError("config.json: `ownerId` must be a non-empty string");

  return {
    token: raw.token.trim(),
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

    // Feature toggles
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

function saveConfig(cfg) {
  atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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

/** @param {string|null} authorId @param {number} postedAt @param {string|null} imageUrl */
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
// Migration
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
  // Back-compat: old format used emojiCounts / topCount
  let reactorIds = arr(m.reactorIds);
  if (
    reactorIds.length === 0 &&
    m.emojiCounts &&
    typeof m.emojiCounts === "object"
  ) {
    // Cannot recover individual user IDs from counts — just leave empty; sync will rebuild
    reactorIds = [];
  }
  return {
    authorId: str(m.authorId),
    postedAt: posNum(m.postedAt, 0),
    imageUrl: str(m.imageUrl),
    reactorIds,
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
  // Back-compat: old array-based photoSigs
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
  // Very old flat format
  const channels = {};
  for (const [cid, a] of Object.entries(raw?.photoSignatures ?? {})) {
    if (!Array.isArray(a)) continue;
    channels[cid] = defaultChannel();
    for (const item of a) {
      if (!item) continue;
      const sig = typeof item === "string" ? item : item.sig;
      const addedAt = item?.addedAt ?? Date.now();
      if (sig) channels[cid].photoSigs[sig] = { messageId: null, addedAt };
    }
  }
  return { channels };
}

function loadData() {
  try {
    return migrate(JSON.parse(fs.readFileSync(DATA_PATH, "utf8")));
  } catch {
    return { channels: {} };
  }
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
  // Backfill imageUrl if it was stored as null previously
  if (imageUrl && !ch.messages[msgId].imageUrl)
    ch.messages[msgId].imageUrl = imageUrl;
  return ch.messages[msgId];
}

// ─────────────────────────────────────────────
// Pruning
// ─────────────────────────────────────────────

/**
 * Removes photo sigs, message metas, and cleans user arrays for entries
 * older than retentionDays.  Throttled to once per PRUNE_INTERVAL_MS unless forced.
 * @param {ChannelData} ch
 * @param {number}      retentionDays
 * @param {boolean}     [force=false]
 * @returns {boolean}  true if anything changed
 */
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

/**
 * Returns 2 pts if within speedBonusMinutes, else 1.
 * Always returns 1 if speedBonusEnabled is false.
 */
function reactionPoints(postedAt, reactedAt, cfg) {
  if (!cfg.speedBonusEnabled) return 1;
  return reactedAt - postedAt <= cfg.speedBonusMinutes * 60 * 1000 ? 2 : 1;
}

// ─────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────

function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

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
 * @typedef {{
 *   token:string, ownerId:string, modIds:string[],
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
 * @typedef {{
 *   lastSeenMessageId:string|null, lastPrunedAt:number,
 *   photoSigs:Record<string,{messageId:string|null,addedAt:number}>,
 *   messages:Record<string,MessageMeta>,
 *   users:Record<string,UserData>,
 * }} ChannelData
 *
 * @typedef {{ channels:Record<string,ChannelData> }} BotData
 */
