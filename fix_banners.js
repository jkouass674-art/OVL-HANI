const fs = require('fs');

// Lire le fichier
let content = fs.readFileSync('./hani.js', 'utf8');

// Remplacer les emojis par des tags ASCII
const emojiReplacements = [
  // Emojis courants
  ['📱', '[QR]'],
  ['⚙️', '[CFG]'],
  ['👑', '[OWNER]'],
  ['🌟', '*'],
  ['✅', '[OK]'],
  ['❌', '[X]'],
  ['⚠️', '[!]'],
  ['🔄', '[...]'],
  ['💾', '[SAVE]'],
  ['🤖', '[BOT]'],
  ['🌐', '[WEB]'],
  ['🛡️', '[SHIELD]'],
  ['💡', '[TIP]'],
  ['📨', '[MSG]'],
  ['⏳', '[WAIT]'],
  ['🚀', '[START]'],
  ['👁️', '[VIEW]'],
  ['🕵️', '[SPY]'],
  ['📥', '[DL]'],
  ['📤', '[UP]'],
  ['🔒', '[LOCK]'],
  ['🔓', '[UNLOCK]'],
  ['📝', '[NOTE]'],
  ['🎤', '[AUDIO]'],
  ['📷', '[IMG]'],
  ['🎬', '[VIDEO]'],
  ['📄', '[DOC]'],
  ['🔔', '[NOTIF]'],
  ['🔕', '[MUTE]'],
  ['💬', '[CHAT]'],
  ['🗑️', '[DEL]'],
  ['📊', '[STATS]'],
  ['🎮', '[GAME]'],
  ['🎵', '[MUSIC]'],
  ['❤️', '<3'],
  ['👍', '[+1]'],
  ['👎', '[-1]'],
  ['🔥', '[HOT]'],
  ['⭐', '[*]'],
  ['💥', '[!]'],
  ['🎯', '[TARGET]'],
  ['📌', '[PIN]'],
  ['🔗', '[LINK]'],
  ['⬇️', '[DOWN]'],
  ['⬆️', '[UP]'],
  ['➡️', '->'],
  ['⬅️', '<-'],
  ['↩️', '<-'],
  ['🔴', '(!)'],
  ['🟢', '(OK)'],
  ['🟡', '(?)'],
  ['🔵', '(i)'],
  ['⚪', '(o)'],
  ['⚫', '(x)'],
  // Symboles de bordure Unicode qui s'affichent mal
  ['╔', '+'],
  ['╗', '+'],
  ['╚', '+'],
  ['╝', '+'],
  ['╠', '+'],
  ['╣', '+'],
  ['╦', '+'],
  ['╩', '+'],
  ['═', '-'],
  ['║', '|'],
  ['─', '-'],
  ['│', '|'],
  ['┃', '|'],
  ['┌', '+'],
  ['┐', '+'],
  ['└', '+'],
  ['┘', '+'],
  ['├', '+'],
  ['┤', '+'],
  ['┬', '+'],
  ['┴', '+'],
  ['━', '-'],
  ['┏', '+'],
  ['┓', '+'],
  ['┗', '+'],
  ['┛', '+'],
];

// Appliquer tous les remplacements
let count = 0;
for (const [emoji, replacement] of emojiReplacements) {
  const regex = new RegExp(emoji, 'g');
  const matches = content.match(regex);
  if (matches) {
    count += matches.length;
    content = content.replace(regex, replacement);
  }
}

// Écrire le fichier
fs.writeFileSync('./hani.js', content, 'utf8');
console.log(`[OK] ${count} remplacements effectues dans hani.js`);
console.log('Relance le bot avec: node hani.js');

