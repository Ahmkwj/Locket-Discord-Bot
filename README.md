# Locket Bot

A simple Discord bot that tracks photo reactions in one watch channel.

## What It Does

- Gives 1 point per unique reacted photo.
- Announces when a user reaches the goal.
- Resets that user's current cycle after a goal is reached.
- Syncs message/reaction history on startup and when watch channel is changed.
- Provides a simple control panel via `setlocket`.

## Removed Features

- No fast reaction bonus.
- No duplicate image detection.
- No top-image announcement.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create or update `config.json`:

```json
{
  "ownerId": "YOUR_DISCORD_USER_ID",
  "modIds": [],
  "watchChannelId": null,
  "notifyChannelId": null,
  "reactionThreshold": 100,
  "retentionDays": 30,
  "goalNotifyEnabled": true,
  "leaderboardEnabled": true
}
```

3. Set your bot token:

- Option A: add `token` in `config.json`
- Option B: set `DISCORD_TOKEN` in `.env`

4. Run:

```bash
npm start
```

## Command

- `setlocket` (owner/mod): opens the control panel.

## Control Panel

- Set Watch Channel
- Set Notify Channel
- Set Goal
- Set Retention
- Reset Scores
- View Leaderboard
- Add/Remove/List Mods (owner only)

## Required Bot Permissions

- View Channels
- Read Message History
- Send Messages
- Add Reactions (optional)

## Project Structure

- `src/index.js`: entry point and Discord events
- `src/storage.js`: config/data load/save and helpers
- `src/sync.js`: history sync logic
- `src/reactions.js`: live scoring and goal checks
- `src/settings.js`: control panel buttons/modals
- `src/embeds.js`: shared embed helper
