# Locket Bot

A Discord bot that tracks photo-reaction engagement in a dedicated channel.

## Features

| Feature | How it works |
|---|---|
| **Reaction counting** | Each user earns 1 point per photo reacted to (one credit per photo, regardless of how many emoji) |
| **Speed bonus** | Reacting within the configurable window (default 60 min) earns **2 points** instead of 1 |
| **Goal & reset** | When a user's points hit the threshold, the notify channel is announced, their counter resets, and their cycle count increments |
| **Most-reacted photo** | On a configurable interval (default 7 days) the bot posts the photo with the most unique reactors to the notify channel |
| **Duplicate guard** | If a photo's metadata fingerprint matches an existing one, the message is deleted, the poster is DM'd in Arabic, and the notify channel is informed |
| **Startup sync** | Every time the bot starts, it incrementally syncs any messages/reactions that arrived while offline — no manual command needed |
| **Settings UI** | One `settings` command opens an embed with buttons → modals, replacing all individual commands |

## Setup

### 1. Prerequisites
- Node.js ≥ 18
- A Discord bot with **Message Content Intent** and **Server Members Intent** enabled in the Developer Portal

### 2. Install
```bash
npm install
```

### 3. Create `config.json` in the project root
```json
{
  "token":              "YOUR_BOT_TOKEN",
  "allowedUserId":      "DISCORD_USER_ID_OF_ADMIN",
  "watchChannelId":     null,
  "notifyChannelId":    null,
  "reactionThreshold":  100,
  "speedBonusMinutes":  60,
  "weeklyIntervalMs":   604800000,
  "lastWeeklyAt":       0
}
```

### 4. Run
```bash
npm start
```

## Commands

| Command | Who | Description |
|---|---|---|
| `settings` | Admin only | Opens the settings panel with all configuration buttons |
| `toplocket` | Admin only | Shows the current-cycle leaderboard |

### Settings panel buttons

| Button | What it does |
|---|---|
| تعيين قناة المراقبة | Set the photo watch channel (triggers a full/incremental sync) |
| تعيين قناة الإشعارات | Set the notification channel |
| تغيير الهدف | Change the point threshold. **If new < old**, pending progress is reset. If new > old, existing progress is kept. |
| نافذة التفاعل السريع | Minutes after posting during which a reaction earns 2 pts (default 60) |
| فترة إعلان أفضل صورة | How many days between "most-reacted photo" announcements (default 7) |
| إعادة ضبط لوحة الصدارة | Clears all current-cycle points. Past cycles (rewarded list) are preserved. |
| نشر أفضل صورة الآن | Force-posts the weekly winner immediately |

## Required bot permissions

Invite integer: **395137336384**

| Permission | Reason |
|---|---|
| View Channels | Read the watch channel |
| Read Message History | Sync historical messages |
| Send Messages | Replies and notifications |
| Manage Messages | Delete duplicate photos |
| Use External Emojis | Emoji in embeds |

## Project structure

```
locket-bot/
├── src/
│   ├── index.js        Entry point — client, events, startup sync
│   ├── storage.js      Config + data persistence, atomic writes, accessors
│   ├── embeds.js       Shared embed builder
│   ├── photoUtils.js   Attachment fingerprinting (shared by sync + duplicates)
│   ├── sync.js         Channel sync engine (incremental + full)
│   ├── reactions.js    Live messageReactionAdd handler
│   ├── duplicates.js   Live duplicate-photo detection + handling
│   ├── weekly.js       Most-reacted photo announcement scheduler
│   ├── settings.js     Settings command, buttons, and modals
│   └── leaderboard.js  toplocket command
├── config.json         Created by you (never commit this)
├── data.json           Auto-generated at runtime
└── package.json
```

## data.json shape

```json
{
  "channels": {
    "<channelId>": {
      "lastSeenMessageId": "snowflake",
      "photoSigs": {
        "<fingerprint>": { "messageId": "snowflake", "addedAt": 1700000000000 }
      },
      "messages": {
        "<messageId>": {
          "authorId": "userId",
          "postedAt": 1700000000000,
          "reactorIds": ["userId", "..."]
        }
      },
      "users": {
        "<userId>": {
          "points":      42,
          "pending":     ["msgId"],
          "rewarded":    ["msgId"],
          "cycles":      3,
          "totalPoints": 142
        }
      }
    }
  }
}
```
