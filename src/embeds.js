/**
 • Name: Ahmed Khawaja  
 • Student ID: 60104808  
 • Created On 03-03-2026-06h-43m
*/

"use strict";

const { EmbedBuilder } = require("discord.js");

const BRAND_COLOR = 0x5865f2; // Discord blurple

/**
 * @param {{
 *   title?:string, description?:string,
 *   fields?:{name:string,value:string,inline?:boolean}[],
 *   footer?:string, color?:number,
 * }} opts
 */
function buildEmbed({ title, description, fields, footer, color } = {}) {
  const e = new EmbedBuilder().setColor(color ?? BRAND_COLOR).setTimestamp();
  if (title) e.setTitle(title);
  if (description) e.setDescription(description);
  if (Array.isArray(fields) && fields.length) e.addFields(...fields);
  if (footer) e.setFooter({ text: footer });
  return e;
}

module.exports = { buildEmbed, BRAND_COLOR };
