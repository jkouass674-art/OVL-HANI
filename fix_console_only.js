const fs = require('fs');

// Lire le fichier
let content = fs.readFileSync('./hani.js', 'utf8');

// On va remplacer UNIQUEMENT les console.log (pas le HTML)
// Trouver tous les console.log et remplacer les emojis dedans

const emojiMap = {
  '📱': '[QR]',
  '⚙️': '[CFG]',
  '👑': '[OWNER]',
  '🌟': '*',
  '✅': '[OK]',
  '❌': '[X]',
  '⚠️': '[!]',
  '🔄': '[...]',
  '💾': '[SAVE]',
  '🤖': '[BOT]',
  '🌐': '[WEB]',
  '🛡️': '[SHIELD]',
  '💡': '[TIP]',
  '📨': '[MSG]',
  '⏳': '[WAIT]',
  '🚀': '[START]',
  '👁️': '[VIEW]',
  '🕵️': '[SPY]',
  '📥': '[DL]',
  '📤': '[UP]',
  '🔒': '[LOCK]',
  '🔓': '[UNLOCK]',
  '📝': '[NOTE]',
  '🎤': '[AUDIO]',
  '📷': '[IMG]',
  '🎬': '[VIDEO]',
  '📄': '[DOC]',
  '🔔': '[NOTIF]',
  '🔕': '[MUTE]',
  '💬': '[CHAT]',
  '🗑️': '[DEL]',
  '📊': '[STATS]',
  '🎮': '[GAME]',
  '🎵': '[MUSIC]',
};

// Remplacer les caractères de bordure Unicode UNIQUEMENT dans les console.log
const borderMap = {
  '╔': '+',
  '╗': '+',
  '╚': '+',
  '╝': '+',
  '╠': '+',
  '╣': '+',
  '╦': '+',
  '╩': '+',
  '═': '-',
  '║': '|',
  '─': '-',
  '│': '|',
  '┃': '|',
  '┌': '+',
  '┐': '+',
  '└': '+',
  '┘': '+',
  '├': '+',
  '┤': '+',
  '┬': '+',
  '┴': '+',
  '━': '-',
  '┏': '+',
  '┓': '+',
  '┗': '+',
  '┛': '+',
};

// Fonction pour remplacer les emojis/symboles dans une chaîne
function replaceInString(str) {
  let result = str;
  for (const [emoji, replacement] of Object.entries(emojiMap)) {
    result = result.split(emoji).join(replacement);
  }
  for (const [border, replacement] of Object.entries(borderMap)) {
    result = result.split(border).join(replacement);
  }
  return result;
}

// Trouver et remplacer dans les console.log seulement
// Pattern pour trouver console.log(...) avec template strings ou strings normales
const consoleLogPattern = /console\.log\s*\(\s*(`[\s\S]*?`|"[^"]*"|'[^']*')\s*\)/g;

let count = 0;
content = content.replace(consoleLogPattern, (match) => {
  const newMatch = replaceInString(match);
  if (newMatch !== match) count++;
  return newMatch;
});

// Aussi remplacer les console.log avec des expressions
const consoleLogPattern2 = /console\.log\s*\(\s*(`[\s\S]*?`)\s*\)/g;
content = content.replace(consoleLogPattern2, (match) => {
  const newMatch = replaceInString(match);
  if (newMatch !== match) count++;
  return newMatch;
});

// Sauvegarder
fs.writeFileSync('./hani.js', content, 'utf8');
console.log(`[OK] ${count} console.log modifies`);
console.log('Les emojis dans le HTML (page admin) sont preserves!');
