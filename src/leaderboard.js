/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

const { buildEmbed } = require("./embeds");
const { getChannel, isAllowed } = require("./storage");

const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * @param {import("discord.js").Message}  message
 * @param {import("./storage").BotConfig} config
 * @param {import("./storage").BotData}   data
 */
async function handleLeaderboard(message, config, data) {
  if (!isAllowed(config, message.author.id)) return;

  if (!config.watchChannelId) {
    await message.reply({
      content: "❌ لم يتم تعيين قناة مراقبة بعد.",
      ephemeral: false,
    });
    return;
  }

  const ch = getChannel(data, config.watchChannelId);

  const entries = Object.entries(ch.users)
    .map(([userId, u]) => ({ userId, points: u.points, cycles: u.cycles }))
    .filter((e) => e.points > 0 || e.cycles > 0)
    .sort((a, b) => b.points - a.points || b.cycles - a.cycles)
    .slice(0, 20);

  if (entries.length === 0) {
    await message.reply({
      embeds: [
        buildEmbed({
          title: "🏆 لوحة الصدارة",
          description:
            "لا يوجد تفاعلات مسجلة حتى الآن.\nابدأ بالتفاعل مع صور الآخرين لتظهر هنا! 🌟",
        }),
      ],
    });
    return;
  }

  const lines = entries.map(({ userId, points, cycles }, i) => {
    const medal = MEDALS[i] ?? `**${i + 1}.**`;
    const cycleStr = cycles > 0 ? `  *(${cycles} جولة مكتملة)*` : "";
    return `${medal} <@${userId}> — **${points}** نقطة${cycleStr}`;
  });

  await message.reply({
    embeds: [
      buildEmbed({
        title: "🏆 لوحة الصدارة",
        description: lines.join("\n"),
        fields: [
          {
            name: "🎯 الهدف الحالي",
            value: `${config.reactionThreshold} نقطة`,
            inline: true,
          },
          {
            name: "⚡ المكافأة السريعة",
            value: `أول ${config.speedBonusMinutes} دقيقة = نقطتان`,
            inline: true,
          },
        ],
        footer: "يتم تحديث النقاط فور كل تفاعل",
      }),
    ],
  });
}

module.exports = { handleLeaderboard };
