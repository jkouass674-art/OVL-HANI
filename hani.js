/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║                    🌟 HANI-MD V1.0 🌟                     ║
 * ║          Bot WhatsApp Intelligent & Performant            ║
 * ║                   Créé par H2025                          ║
 * ╚═══════════════════════════════════════════════════════════╝
 * 
 * Lancer avec: node hani.js
 * Scanne le QR code avec WhatsApp → Appareils connectés
 */

const fs = require("fs");
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode-terminal");
const {
  default: makeWASocket,
  makeCacheableSignalKeyStore,
  Browsers,
  delay,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
} = require("@whiskeysockets/baileys");

// ═══════════════════════════════════════════════════════════
// 📦 BASE DE DONNÉES SQLITE LÉGÈRE
// ═══════════════════════════════════════════════════════════

class HaniDatabase {
  constructor(dbPath = "./DataBase/hani.json") {
    this.dbPath = dbPath;
    this.data = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        return JSON.parse(fs.readFileSync(this.dbPath, "utf-8"));
      }
    } catch (e) {
      console.log("⚠️ Erreur chargement DB, création nouvelle...");
    }
    return {
      users: {},
      groups: {},
      settings: {},
      warns: {},
      banned: [],
      sudo: [],
      stats: { commands: 0, messages: 0, startTime: Date.now() }
    };
  }

  save() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
    } catch (e) {
      console.log("⚠️ Erreur sauvegarde DB:", e.message);
    }
  }

  // Utilisateurs
  getUser(jid) {
    if (!this.data.users[jid]) {
      this.data.users[jid] = { 
        xp: 0, 
        level: 1, 
        messages: 0, 
        lastSeen: Date.now(),
        name: ""
      };
    }
    return this.data.users[jid];
  }

  addXP(jid, amount = 5) {
    const user = this.getUser(jid);
    user.xp += amount;
    user.messages++;
    user.lastSeen = Date.now();
    
    // Level up si XP suffisant
    const xpNeeded = user.level * 100;
    if (user.xp >= xpNeeded) {
      user.level++;
      user.xp = 0;
      this.save();
      return { levelUp: true, newLevel: user.level };
    }
    
    // Sauvegarder toutes les 10 messages
    if (user.messages % 10 === 0) this.save();
    return { levelUp: false };
  }

  // Groupes
  getGroup(jid) {
    if (!this.data.groups[jid]) {
      this.data.groups[jid] = {
        welcome: true,
        antilink: false,
        antispam: false,
        antibot: false,
        antitag: false,
        mute: false,
        warns: {}
      };
    }
    return this.data.groups[jid];
  }

  // Warns
  addWarn(groupJid, userJid) {
    const group = this.getGroup(groupJid);
    group.warns[userJid] = (group.warns[userJid] || 0) + 1;
    this.save();
    return group.warns[userJid];
  }

  getWarns(groupJid, userJid) {
    return this.getGroup(groupJid).warns[userJid] || 0;
  }

  resetWarns(groupJid, userJid) {
    const group = this.getGroup(groupJid);
    delete group.warns[userJid];
    this.save();
  }

  // Ban
  isBanned(jid) {
    return this.data.banned.includes(jid);
  }

  ban(jid) {
    if (!this.isBanned(jid)) {
      this.data.banned.push(jid);
      this.save();
    }
  }

  unban(jid) {
    this.data.banned = this.data.banned.filter(b => b !== jid);
    this.save();
  }

  // Sudo
  isSudo(jid) {
    return this.data.sudo.includes(jid);
  }

  addSudo(jid) {
    if (!this.isSudo(jid)) {
      this.data.sudo.push(jid);
      this.save();
    }
  }

  removeSudo(jid) {
    this.data.sudo = this.data.sudo.filter(s => s !== jid);
    this.save();
  }

  // Stats
  incrementStats(key) {
    this.data.stats[key] = (this.data.stats[key] || 0) + 1;
  }
}

// ═══════════════════════════════════════════════════════════
// ⚙️ CONFIGURATION
// ═══════════════════════════════════════════════════════════

require("dotenv").config({ override: true });

const config = {
  BOT_NAME: "HANI-MD",
  VERSION: "1.0.0",
  PREFIXE: process.env.PREFIXE || ".",
  NOM_OWNER: process.env.NOM_OWNER || "H2025",
  NUMERO_OWNER: process.env.NUMERO_OWNER || "",
  MODE: process.env.MODE || "public",
  STICKER_PACK: "HANI-MD",
  STICKER_AUTHOR: "H2025",
};

const SESSION_FOLDER = "./DataBase/session/principale";
const db = new HaniDatabase();

// ═══════════════════════════════════════════════════════════
// 🛡️ ÉTATS DES PROTECTIONS (GLOBAL)
// ═══════════════════════════════════════════════════════════

const protectionState = {
  antidelete: true,
  anticall: true,
  antideletestatus: true,  // Pour sauvegarder les statuts automatiquement
};

// ═══════════════════════════════════════════════════════════
// 💾 STOCKAGE EN MÉMOIRE
// ═══════════════════════════════════════════════════════════

const messageStore = new Map();
const MAX_STORED_MESSAGES = 500;
const deletedMessages = [];
const MAX_DELETED_MESSAGES = 50;
const viewOnceMessages = new Map();
const spamTracker = new Map(); // Pour antispam

// Stockage des statuts
const statusStore = new Map();        // Tous les statuts reçus
const deletedStatuses = [];           // Statuts supprimés
const MAX_STORED_STATUSES = 100;
const MAX_DELETED_STATUSES = 50;

// ═══════════════════════════════════════════════════════════
// 🕵️ SYSTÈME DE SURVEILLANCE / TRACKING
// ═══════════════════════════════════════════════════════════

const activityTracker = new Map();    // Suivi d'activité par utilisateur
const watchList = new Set();          // Liste des numéros à surveiller
const mediaStore = new Map();         // Stockage des médias reçus par utilisateur
const MAX_MEDIA_PER_USER = 20;        // Max médias stockés par utilisateur

function trackActivity(jid, pushName, type, chatWith) {
  const number = jid?.split("@")[0];
  if (!number) return;
  
  if (!activityTracker.has(number)) {
    activityTracker.set(number, {
      name: pushName || "Inconnu",
      number: number,
      firstSeen: new Date().toLocaleString("fr-FR"),
      lastSeen: new Date().toLocaleString("fr-FR"),
      messageCount: 0,
      activities: [],
      chats: new Set()
    });
  }
  
  const tracker = activityTracker.get(number);
  tracker.name = pushName || tracker.name;
  tracker.lastSeen = new Date().toLocaleString("fr-FR");
  tracker.messageCount++;
  
  // Ajouter l'activité (garder les 50 dernières)
  tracker.activities.push({
    type: type,
    time: new Date().toLocaleString("fr-FR"),
    chat: chatWith
  });
  if (tracker.activities.length > 50) tracker.activities.shift();
  
  // Tracker les chats (groupes)
  if (chatWith) {
    tracker.chats.add(chatWith);
  }
}

// ═══════════════════════════════════════════════════════════
// 🔧 FONCTIONS UTILITAIRES
// ═══════════════════════════════════════════════════════════

// Formater un numéro au format +225 XX XX XX XX XX (Côte d'Ivoire)
function formatPhoneNumber(number) {
  if (!number) return "Inconnu";
  
  // Nettoyer le numéro (enlever @s.whatsapp.net, @g.us, etc.)
  let clean = number.toString().replace(/@.+$/, "").replace(/[^0-9]/g, "");
  
  // Format ivoirien: 225 + 10 chiffres
  if (clean.startsWith("225") && clean.length >= 12) {
    const prefix = "+225";
    const num = clean.substring(3); // Les 10 chiffres après 225
    // Formater: XX XX XX XX XX
    if (num.length >= 10) {
      return `${prefix} ${num.substring(0, 2)} ${num.substring(2, 4)} ${num.substring(4, 6)} ${num.substring(6, 8)} ${num.substring(8, 10)}`;
    }
    return `${prefix} ${num}`;
  }
  
  // Autres formats internationaux
  if (clean.length > 8) {
    return `+${clean}`;
  }
  
  return clean;
}

function getMessageText(msg) {
  if (!msg?.message) return "";
  const type = getContentType(msg.message);
  if (!type) return "";
  
  const content = msg.message[type];
  if (type === "conversation") return content || "";
  if (type === "extendedTextMessage") return content?.text || "";
  if (type === "imageMessage") return content?.caption || "";
  if (type === "videoMessage") return content?.caption || "";
  if (type === "documentMessage") return content?.caption || "";
  return "";
}

function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  if (days > 0) return `${days}j ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function isGroup(jid) {
  return jid?.endsWith("@g.us");
}

function extractNumber(jid) {
  return jid?.split("@")[0] || "";
}

function formatNumber(number) {
  return number.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
}

// ═══════════════════════════════════════════════════════════
// 🎨 MENUS ET TEXTES
// ═══════════════════════════════════════════════════════════

function getMainMenu(prefix) {
  return `
╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃    🌟 *HANI-MD V1.0* 🌟   
┃━━━━━━━━━━━━━━━━━━━━━━━━━
┃ 📌 Préfixe : *${prefix}*
┃ 🤖 Mode    : *${config.MODE}*
┃ 👑 Owner   : *${config.NOM_OWNER}*
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 📋 *MENU PRINCIPAL* ━━━╮
┃
┃ 📌 *GÉNÉRAL*
┃ ${prefix}ping - Tester le bot
┃ ${prefix}info - Infos du bot
┃ ${prefix}stats - Statistiques
┃ ${prefix}runtime - Temps en ligne
┃
┃ 👤 *UTILISATEUR*
┃ ${prefix}profil - Ton profil
┃ ${prefix}level - Ton niveau
┃ ${prefix}daily - Bonus quotidien
┃
┃ 👥 *GROUPE* (Admins)
┃ ${prefix}kick @user - Exclure
┃ ${prefix}add 2250000 - Ajouter
┃ ${prefix}promote @user - Promouvoir
┃ ${prefix}demote @user - Rétrograder
┃ ${prefix}link - Lien du groupe
┃ ${prefix}desc [texte] - Description
┃ ${prefix}tagall - Mentionner tous
┃ ${prefix}hidetag [msg] - Tag caché
┃
┃ 🛡️ *PROTECTIONS* (Groupe)
┃ ${prefix}antilink on/off
┃ ${prefix}antispam on/off
┃ ${prefix}antibot on/off
┃ ${prefix}antitag on/off
┃ ${prefix}mute on/off
┃ ${prefix}warn @user - Avertir
┃ ${prefix}unwarn @user - Retirer warn
┃ ${prefix}warnlist - Liste warns
┃
┃ 👁️ *VUE UNIQUE*
┃ ${prefix}vv - Récupérer (répondre)
┃ ${prefix}listvv - Liste interceptées
┃
┃ 🗑️ *ANTI-DELETE*
┃ ${prefix}antidelete on/off
┃ ${prefix}deleted - Voir supprimés
┃
┃ 📸 *STATUTS / STORIES*
┃ ${prefix}savestatus on/off - Auto-save
┃ ${prefix}deletedstatus - Statuts supprimés
┃ ${prefix}getstatus [n°] - Récupérer statut
┃ ${prefix}liststatus - Tous les statuts
┃
┃ 🎮 *FUN*
┃ ${prefix}sticker - Créer sticker
┃ ${prefix}emoji [😀] - Agrandir emoji
┃ ${prefix}dice - Lancer un dé
┃ ${prefix}flip - Pile ou face
┃ ${prefix}quote - Citation random
┃
┃ 🔧 *OUTILS*
┃ ${prefix}calc [expression]
┃ ${prefix}tts [texte] - Text to Speech
┃ ${prefix}tr [lang] [texte] - Traduire
┃
┃ 🕵️ *ESPIONNAGE*
┃ ${prefix}spy @user - Surveiller
┃ ${prefix}unspy @user - Arrêter surveillance
┃ ${prefix}spylist - Liste surveillés
┃ ${prefix}activity - Top 15 actifs
┃ ${prefix}activity @user - Voir activité
┃
┃ 📁 *EXTRACTION*
┃ ${prefix}extract @user - Médias reçus
┃ ${prefix}getmedia @user [n°] - Télécharger
┃ ${prefix}medialist - Tout voir
┃
┃ 👑 *OWNER SEULEMENT*
┃ ${prefix}ban @user - Bannir du bot
┃ ${prefix}unban @user - Débannir
┃ ${prefix}banlist - Liste bannis
┃ ${prefix}sudo @user - Ajouter sudo
┃ ${prefix}delsudo @user - Retirer sudo
┃ ${prefix}sudolist - Liste sudos
┃ ${prefix}broadcast [msg] - Diffuser
┃ ${prefix}restart - Redémarrer
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

💡 *Réponds en privé pour ne pas* 
*être vu par les autres!*
`;
}

// ═══════════════════════════════════════════════════════════
// 🎯 GESTIONNAIRE DE COMMANDES
// ═══════════════════════════════════════════════════════════

async function handleCommand(hani, msg, db) {
  const from = msg.key.remoteJid;
  const body = getMessageText(msg);
  if (!body || !body.startsWith(config.PREFIXE)) return;

  const [cmd, ...rest] = body.slice(config.PREFIXE.length).trim().split(/\s+/);
  const command = (cmd || "").toLowerCase();
  const args = rest.join(" ");
  const sender = msg.key.participant || msg.key.remoteJid;
  const pushName = msg.pushName || "Utilisateur";
  
  // Numéro du bot
  const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
  const isOwner = sender === formatNumber(config.NUMERO_OWNER) || extractNumber(sender) === config.NUMERO_OWNER;
  const isSudo = db.isSudo(sender) || isOwner;
  const isGroupMsg = isGroup(from);
  
  // Vérifier si banni
  if (db.isBanned(sender)) {
    return; // Ignorer les utilisateurs bannis
  }

  // Fonctions d'envoi
  const sendPrivate = (text) => hani.sendMessage(botNumber, { text });
  const sendHere = (text) => hani.sendMessage(from, { text });
  const isOwnChat = from === botNumber;
  const send = isOwnChat ? sendHere : sendPrivate;
  const reply = (text) => hani.sendMessage(from, { text }, { quoted: msg });

  // Récupérer le groupe
  const groupData = isGroupMsg ? db.getGroup(from) : null;
  
  // Vérifier les permissions d'admin
  let isAdmin = false;
  let isBotAdmin = false;
  let groupMetadata = null;
  
  if (isGroupMsg) {
    try {
      groupMetadata = await hani.groupMetadata(from);
      const admins = groupMetadata.participants
        .filter(p => p.admin)
        .map(p => p.id);
      isAdmin = admins.includes(sender);
      isBotAdmin = admins.includes(botNumber);
    } catch (e) {}
  }

  // Mentionné
  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant;

  // Incrémenter les stats
  db.incrementStats("commands");

  // ═══════════════════════════════════════════════════════════
  // 🎯 COMMANDES
  // ═══════════════════════════════════════════════════════════

  switch (command) {
    
    // ────────── GÉNÉRAL ──────────
    case "ping": {
      const start = Date.now();
      await send("🏓 Pong!");
      const latency = Date.now() - start;
      return send(`📶 Latence: ${latency}ms\n⚡ HANI-MD est opérationnel!`);
    }

    case "menu":
    case "help":
    case "aide": {
      return send(getMainMenu(config.PREFIXE));
    }

    case "info": {
      const uptime = formatUptime(Date.now() - db.data.stats.startTime);
      const infoText = `
╭━━━ 🤖 *HANI-MD INFO* ━━━╮
┃
┃ 📛 Nom: ${config.BOT_NAME}
┃ 📱 Version: ${config.VERSION}
┃ 👑 Owner: ${config.NOM_OWNER}
┃ 🔧 Préfixe: ${config.PREFIXE}
┃ 🌐 Mode: ${config.MODE}
┃
┃ 📊 *Statistiques*
┃ ⏱️ Uptime: ${uptime}
┃ 📨 Commandes: ${db.data.stats.commands}
┃ 👥 Utilisateurs: ${Object.keys(db.data.users).length}
┃ 🏘️ Groupes: ${Object.keys(db.data.groups).length}
┃
┃ 🛡️ *Protections actives*
┃ • Antidelete: ${protectionState.antidelete ? "✅" : "❌"}
┃ • Anticall: ${protectionState.anticall ? "✅" : "❌"}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━╯
`;
      return send(infoText);
    }

    case "stats": {
      const uptime = formatUptime(Date.now() - db.data.stats.startTime);
      return send(`📊 *Statistiques HANI-MD*

⏱️ En ligne depuis: ${uptime}
📨 Commandes exécutées: ${db.data.stats.commands}
💬 Messages traités: ${db.data.stats.messages || 0}
👥 Utilisateurs: ${Object.keys(db.data.users).length}
🏘️ Groupes: ${Object.keys(db.data.groups).length}
🚫 Bannis: ${db.data.banned.length}
👑 Sudos: ${db.data.sudo.length}`);
    }

    case "runtime":
    case "uptime": {
      const uptime = formatUptime(Date.now() - db.data.stats.startTime);
      return send(`⏱️ *Temps en ligne*\n\n🤖 HANI-MD fonctionne depuis: *${uptime}*`);
    }

    // ────────── UTILISATEUR ──────────
    case "profil":
    case "profile":
    case "me": {
      const user = db.getUser(sender);
      const xpNeeded = user.level * 100;
      const progress = Math.round((user.xp / xpNeeded) * 10);
      const progressBar = "█".repeat(progress) + "░".repeat(10 - progress);
      
      return send(`
👤 *Ton Profil*

📛 Nom: ${pushName}
📱 Numéro: ${extractNumber(sender)}
⭐ Niveau: ${user.level}
✨ XP: ${user.xp}/${xpNeeded}
💬 Messages: ${user.messages}

📊 Progression:
[${progressBar}] ${progress * 10}%
`);
    }

    case "level":
    case "lvl":
    case "rank": {
      const user = db.getUser(sender);
      const xpNeeded = user.level * 100;
      return send(`⭐ *Niveau: ${user.level}*\n✨ XP: ${user.xp}/${xpNeeded}\n💬 Messages: ${user.messages}`);
    }

    case "daily":
    case "bonus": {
      const user = db.getUser(sender);
      const now = Date.now();
      const lastDaily = user.lastDaily || 0;
      const dayMs = 24 * 60 * 60 * 1000;
      
      if (now - lastDaily < dayMs) {
        const remaining = formatUptime(dayMs - (now - lastDaily));
        return send(`⏰ Tu as déjà réclamé ton bonus!\n⏳ Reviens dans: ${remaining}`);
      }
      
      const bonus = Math.floor(Math.random() * 50) + 50; // 50-100 XP
      user.xp += bonus;
      user.lastDaily = now;
      db.save();
      
      return send(`🎁 *Bonus quotidien!*\n\n✨ +${bonus} XP\n⭐ Total XP: ${user.xp}`);
    }

    // ────────── GROUPE ──────────
    case "kick":
    case "remove": {
      if (!isGroupMsg) return send("❌ Cette commande est réservée aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin pour utiliser cette commande.");
      if (!isBotAdmin) return send("❌ Je dois être admin pour exclure quelqu'un.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un ou réponds à son message.");
      
      try {
        await hani.groupParticipantsUpdate(from, [target], "remove");
        return reply(`✅ ${target.split("@")[0]} a été exclu du groupe.`);
      } catch (e) {
        return send("❌ Impossible d'exclure ce membre.");
      }
    }

    case "add": {
      if (!isGroupMsg) return send("❌ Cette commande est réservée aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      if (!isBotAdmin) return send("❌ Je dois être admin.");
      
      if (!args) return send("❌ Donne un numéro. Ex: .add 22550000000");
      
      const number = formatNumber(args);
      try {
        await hani.groupParticipantsUpdate(from, [number], "add");
        return reply(`✅ ${args} a été ajouté au groupe.`);
      } catch (e) {
        return send("❌ Impossible d'ajouter ce numéro. Vérifie le numéro ou les paramètres de confidentialité.");
      }
    }

    case "promote": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      if (!isBotAdmin) return send("❌ Je dois être admin.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      try {
        await hani.groupParticipantsUpdate(from, [target], "promote");
        return reply(`✅ ${target.split("@")[0]} est maintenant admin!`);
      } catch (e) {
        return send("❌ Erreur lors de la promotion.");
      }
    }

    case "demote": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      if (!isBotAdmin) return send("❌ Je dois être admin.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      try {
        await hani.groupParticipantsUpdate(from, [target], "demote");
        return reply(`✅ ${target.split("@")[0]} n'est plus admin.`);
      } catch (e) {
        return send("❌ Erreur lors de la rétrogradation.");
      }
    }

    case "link":
    case "grouplink": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isBotAdmin) return send("❌ Je dois être admin pour obtenir le lien.");
      
      try {
        const code = await hani.groupInviteCode(from);
        return send(`🔗 *Lien du groupe*\n\nhttps://chat.whatsapp.com/${code}`);
      } catch (e) {
        return send("❌ Impossible d'obtenir le lien.");
      }
    }

    case "desc":
    case "description":
    case "setdesc": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      if (!isBotAdmin) return send("❌ Je dois être admin.");
      if (!args) return send("❌ Donne une description. Ex: .desc Bienvenue!");
      
      try {
        await hani.groupUpdateDescription(from, args);
        return reply("✅ Description mise à jour!");
      } catch (e) {
        return send("❌ Erreur lors de la mise à jour.");
      }
    }

    case "tagall":
    case "all": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const participants = groupMetadata.participants.map(p => p.id);
      let text = args ? `📢 *${args}*\n\n` : "📢 *Annonce*\n\n";
      participants.forEach(p => {
        text += `@${p.split("@")[0]}\n`;
      });
      
      return hani.sendMessage(from, { text, mentions: participants });
    }

    case "hidetag": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const participants = groupMetadata.participants.map(p => p.id);
      const text = args || "📢 Message important";
      
      return hani.sendMessage(from, { text, mentions: participants });
    }

    // ────────── PROTECTIONS GROUPE ──────────
    case "antilink": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const param = args.toLowerCase();
      if (param === "on") groupData.antilink = true;
      else if (param === "off") groupData.antilink = false;
      else groupData.antilink = !groupData.antilink;
      db.save();
      
      return reply(`🔗 Antilink ${groupData.antilink ? "✅ activé" : "❌ désactivé"}`);
    }

    case "antispam": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const param = args.toLowerCase();
      if (param === "on") groupData.antispam = true;
      else if (param === "off") groupData.antispam = false;
      else groupData.antispam = !groupData.antispam;
      db.save();
      
      return reply(`🚫 Antispam ${groupData.antispam ? "✅ activé" : "❌ désactivé"}`);
    }

    case "antibot": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const param = args.toLowerCase();
      if (param === "on") groupData.antibot = true;
      else if (param === "off") groupData.antibot = false;
      else groupData.antibot = !groupData.antibot;
      db.save();
      
      return reply(`🤖 Antibot ${groupData.antibot ? "✅ activé" : "❌ désactivé"}`);
    }

    case "antitag": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      const param = args.toLowerCase();
      if (param === "on") groupData.antitag = true;
      else if (param === "off") groupData.antitag = false;
      else groupData.antitag = !groupData.antitag;
      db.save();
      
      return reply(`🏷️ Antitag ${groupData.antitag ? "✅ activé" : "❌ désactivé"}`);
    }

    case "mute":
    case "mutegroup": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      if (!isBotAdmin) return send("❌ Je dois être admin.");
      
      const param = args.toLowerCase();
      const mute = param === "on" || param === "";
      
      try {
        await hani.groupSettingUpdate(from, mute ? "announcement" : "not_announcement");
        return reply(mute ? "🔇 Groupe muté. Seuls les admins peuvent parler." : "🔊 Groupe démuté.");
      } catch (e) {
        return send("❌ Erreur lors du mute.");
      }
    }

    case "warn": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      const warns = db.addWarn(from, target);
      
      if (warns >= 3) {
        if (isBotAdmin) {
          await hani.groupParticipantsUpdate(from, [target], "remove");
          db.resetWarns(from, target);
          return reply(`⚠️ @${target.split("@")[0]} a atteint 3 warns et a été exclu!`, { mentions: [target] });
        }
        return reply(`⚠️ @${target.split("@")[0]} a 3 warns mais je ne suis pas admin pour l'exclure.`, { mentions: [target] });
      }
      
      return hani.sendMessage(from, { 
        text: `⚠️ @${target.split("@")[0]} a reçu un avertissement!\n📊 Warns: ${warns}/3`,
        mentions: [target]
      });
    }

    case "unwarn":
    case "resetwarn": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      if (!isAdmin && !isSudo) return send("❌ Tu dois être admin.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      db.resetWarns(from, target);
      return reply(`✅ Warns réinitialisés pour @${target.split("@")[0]}`, { mentions: [target] });
    }

    case "warnlist":
    case "warns": {
      if (!isGroupMsg) return send("❌ Réservé aux groupes.");
      
      const group = db.getGroup(from);
      const warnedUsers = Object.entries(group.warns).filter(([_, w]) => w > 0);
      
      if (warnedUsers.length === 0) return reply("✅ Aucun membre n'a de warns.");
      
      let text = "⚠️ *Liste des warns*\n\n";
      warnedUsers.forEach(([jid, count]) => {
        text += `• @${jid.split("@")[0]}: ${count}/3 warns\n`;
      });
      
      return hani.sendMessage(from, { 
        text, 
        mentions: warnedUsers.map(([jid]) => jid) 
      });
    }

    // ────────── VUE UNIQUE ──────────
    case "vv":
    case "viewonce":
    case "vo": {
      // Supprimer la commande envoyée pour qu'elle soit invisible
      try {
        await hani.sendMessage(from, { delete: msg.key });
      } catch (e) {}
      
      // Récupérer le contexte du message cité
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                          msg.message?.imageMessage?.contextInfo ||
                          msg.message?.videoMessage?.contextInfo;
      
      if (!contextInfo?.quotedMessage) {
        return sendPrivate("❌ Réponds à un message à vue unique pour le récupérer.");
      }
      
      const quotedMessage = contextInfo.quotedMessage;
      const stanzaId = contextInfo.stanzaId;
      
      // Chercher le contenu à vue unique dans différents endroits possibles
      let viewOnceContent = quotedMessage.viewOnceMessage || 
                            quotedMessage.viewOnceMessageV2 || 
                            quotedMessage.viewOnceMessageV2Extension;
      
      // Si pas trouvé directement, chercher dans le message stocké
      if (!viewOnceContent && stanzaId) {
        const stored = viewOnceMessages.get(stanzaId);
        if (stored && stored.message) {
          const storedMsg = stored.message.message;
          viewOnceContent = storedMsg?.viewOnceMessage || 
                           storedMsg?.viewOnceMessageV2 || 
                           storedMsg?.viewOnceMessageV2Extension;
        }
      }
      
      // Vérifier aussi si le message cité lui-même est un média (parfois le viewOnce est déjà déroulé)
      if (!viewOnceContent) {
        // Peut-être que le message cité EST le contenu viewOnce (image/video avec viewOnce: true)
        const mediaType = Object.keys(quotedMessage)[0];
        if (["imageMessage", "videoMessage", "audioMessage"].includes(mediaType)) {
          const mediaContent = quotedMessage[mediaType];
          if (mediaContent?.viewOnce === true) {
            viewOnceContent = { message: quotedMessage };
          }
        }
      }
      
      if (!viewOnceContent) {
        // Afficher les infos de debug
        const keys = Object.keys(quotedMessage);
        return sendPrivate(`❌ Ce n'est pas un message à vue unique.\n\n📋 Type détecté: ${keys.join(", ")}`);
      }
      
      try {
        const mediaMsg = viewOnceContent.message || viewOnceContent;
        const mediaType = Object.keys(mediaMsg).find(k => k.includes("Message")) || Object.keys(mediaMsg)[0];
        const media = mediaMsg[mediaType];
        
        if (!media) {
          return sendPrivate("❌ Impossible de lire le contenu du média.");
        }
        
        // Télécharger le média
        const stream = await downloadMediaMessage(
          { message: mediaMsg, key: { remoteJid: from, id: stanzaId } },
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
        );
        
        // Envoyer en privé (à soi-même)
        if (mediaType === "imageMessage" || mediaType.includes("image")) {
          await hani.sendMessage(botNumber, { 
            image: stream, 
            caption: "👁️ *Vue unique récupérée!*\n\n" + (media.caption || "") 
          });
        } else if (mediaType === "videoMessage" || mediaType.includes("video")) {
          await hani.sendMessage(botNumber, { 
            video: stream, 
            caption: "👁️ *Vue unique récupérée!*\n\n" + (media.caption || "") 
          });
        } else if (mediaType === "audioMessage" || mediaType.includes("audio")) {
          await hani.sendMessage(botNumber, { 
            audio: stream,
            mimetype: "audio/mp4"
          });
        } else {
          return sendPrivate("❌ Type de média non supporté: " + mediaType);
        }
        
        console.log(`👁️ Vue unique récupérée par ${pushName}`);
      } catch (e) {
        console.log("Erreur VV:", e);
        return sendPrivate("❌ Erreur: " + e.message);
      }
      return;
    }

    case "listvv":
    case "listviewonce": {
      if (viewOnceMessages.size === 0) return send("📭 Aucun message à vue unique intercepté.");
      
      let list = "👁️ *Messages à vue unique interceptés*\n\n";
      let i = 1;
      for (const [id, data] of viewOnceMessages) {
        list += `${i}. De: ${data.sender}\n   Type: ${data.type}\n   Date: ${data.date}\n\n`;
        i++;
      }
      return send(list);
    }

    // ────────── ANTI-DELETE ──────────
    case "antidelete": {
      const param = args.toLowerCase();
      if (param === "on") protectionState.antidelete = true;
      else if (param === "off") protectionState.antidelete = false;
      else protectionState.antidelete = !protectionState.antidelete;
      
      return send(`🗑️ Antidelete ${protectionState.antidelete ? "✅ activé" : "❌ désactivé"}`);
    }

    case "deleted":
    case "delmsg": {
      if (deletedMessages.length === 0) return send("📭 Aucun message supprimé intercepté.");
      
      let list = "🗑️ *Messages supprimés récents*\n\n";
      deletedMessages.slice(-10).forEach((del, i) => {
        list += `${i + 1}. De: ${del.sender}\n`;
        list += `   Type: ${del.type}\n`;
        if (del.text) list += `   "${del.text.substring(0, 50)}..."\n`;
        list += `   ${del.date}\n\n`;
      });
      return send(list);
    }

    // ────────── STATUTS / STORIES ──────────
    case "antideletestatus":
    case "savstatus":
    case "savestatus": {
      const param = args.toLowerCase();
      if (param === "on") protectionState.antideletestatus = true;
      else if (param === "off") protectionState.antideletestatus = false;
      else protectionState.antideletestatus = !protectionState.antideletestatus;
      
      return send(`📸 Sauvegarde auto des statuts ${protectionState.antideletestatus ? "✅ activée" : "❌ désactivée"}`);
    }

    case "deletedstatus":
    case "delstatus":
    case "statusdel": {
      if (deletedStatuses.length === 0) return send("📭 Aucun statut supprimé intercepté.");
      
      let list = "📸 *Statuts supprimés récents*\n\n";
      deletedStatuses.slice(-10).forEach((status, i) => {
        list += `${i + 1}. 👤 ${status.pushName}\n`;
        list += `   📱 ${status.sender.split("@")[0]}\n`;
        list += `   📝 Type: ${status.type}\n`;
        list += `   🕐 Posté: ${status.date}\n`;
        list += `   🗑️ Supprimé: ${status.deletedAt}\n\n`;
      });
      return send(list);
    }

    case "getstatus":
    case "sendstatus": {
      // Envoyer un statut supprimé spécifique
      const index = parseInt(args) - 1;
      if (isNaN(index) || index < 0 || index >= deletedStatuses.length) {
        return send(`❌ Numéro invalide. Utilise .deletedstatus pour voir la liste (1-${deletedStatuses.length})`);
      }
      
      const status = deletedStatuses[index];
      if (!status) return send("❌ Statut non trouvé.");
      
      try {
        let caption = `📸 *Statut #${index + 1}*\n\n`;
        caption += `👤 De: ${status.pushName}\n`;
        caption += `📱 ${status.sender.split("@")[0]}\n`;
        caption += `🕐 ${status.date}`;
        
        if (status.mediaBuffer) {
          if (status.type === "image") {
            await hani.sendMessage(botNumber, { 
              image: status.mediaBuffer, 
              caption: caption + (status.caption ? `\n\n"${status.caption}"` : "")
            });
          } else if (status.type === "video") {
            await hani.sendMessage(botNumber, { 
              video: status.mediaBuffer, 
              caption: caption + (status.caption ? `\n\n"${status.caption}"` : "")
            });
          } else if (status.type === "audio") {
            await send(caption);
            await hani.sendMessage(botNumber, { audio: status.mediaBuffer, mimetype: "audio/mp4" });
          }
        } else if (status.text) {
          await send(caption + `\n\n💬 "${status.text}"`);
        } else {
          await send(caption + "\n\n⚠️ Média non disponible");
        }
      } catch (e) {
        return send("❌ Erreur: " + e.message);
      }
      return;
    }

    case "liststatus":
    case "statuslist":
    case "allstatus": {
      if (statusStore.size === 0) return send("📭 Aucun statut sauvegardé.");
      
      let list = "📸 *Tous les statuts sauvegardés*\n\n";
      let i = 1;
      for (const [id, status] of statusStore) {
        list += `${i}. 👤 ${status.pushName}\n`;
        list += `   📝 ${status.type}\n`;
        list += `   🕐 ${status.date}\n\n`;
        i++;
        if (i > 20) {
          list += `... et ${statusStore.size - 20} autres\n`;
          break;
        }
      }
      return send(list);
    }

    // ────────── FUN ──────────
    case "sticker":
    case "s": {
      if (!quotedMsg) return send("❌ Réponds à une image ou vidéo pour créer un sticker.");
      
      const mediaType = getContentType(quotedMsg);
      if (!["imageMessage", "videoMessage"].includes(mediaType)) {
        return send("❌ Réponds à une image ou vidéo.");
      }
      
      try {
        const media = await downloadMediaMessage(
          { message: quotedMsg, key: msg.key },
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
        );
        
        await hani.sendMessage(from, {
          sticker: media,
          packname: config.STICKER_PACK,
          author: config.STICKER_AUTHOR
        });
      } catch (e) {
        return send("❌ Erreur création sticker: " + e.message);
      }
      return;
    }

    case "dice":
    case "de": {
      const result = Math.floor(Math.random() * 6) + 1;
      const diceEmojis = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
      return reply(`🎲 Le dé affiche: ${diceEmojis[result - 1]} *${result}*`);
    }

    case "flip":
    case "coinflip": {
      const result = Math.random() < 0.5 ? "Pile 🪙" : "Face 👑";
      return reply(`🪙 Résultat: *${result}*`);
    }

    case "quote":
    case "citation": {
      const quotes = [
        "La vie est ce qui arrive quand on est occupé à faire d'autres plans. - John Lennon",
        "Sois le changement que tu veux voir dans le monde. - Gandhi",
        "L'imagination est plus importante que le savoir. - Einstein",
        "La simplicité est la sophistication suprême. - Léonard de Vinci",
        "Le succès c'est d'aller d'échec en échec sans perdre son enthousiasme. - Churchill",
        "La seule façon de faire du bon travail est d'aimer ce que vous faites. - Steve Jobs",
        "Ce n'est pas la force, mais la persévérance, qui fait les grandes œuvres. - Samuel Johnson",
        "Le plus grand risque est de ne prendre aucun risque. - Mark Zuckerberg"
      ];
      return reply(`💭 *Citation du jour*\n\n"${quotes[Math.floor(Math.random() * quotes.length)]}"`);
    }

    // ────────── OUTILS ──────────
    case "calc":
    case "calculate": {
      if (!args) return send("❌ Donne une expression. Ex: .calc 5+5*2");
      
      try {
        // Sécurité: n'autoriser que les caractères mathématiques
        const sanitized = args.replace(/[^0-9+\-*/().%\s]/g, "");
        const result = eval(sanitized);
        return reply(`🔢 *Calculatrice*\n\n${sanitized} = *${result}*`);
      } catch (e) {
        return send("❌ Expression invalide.");
      }
    }

    // ────────── OWNER ──────────
    case "ban": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un à bannir.");
      
      db.ban(target);
      return reply(`🚫 @${target.split("@")[0]} est banni du bot.`, { mentions: [target] });
    }

    case "unban": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un à débannir.");
      
      db.unban(target);
      return reply(`✅ @${target.split("@")[0]} est débanni.`, { mentions: [target] });
    }

    case "banlist": {
      if (!isSudo) return send("❌ Commande réservée aux sudos.");
      
      if (db.data.banned.length === 0) return send("✅ Aucun utilisateur banni.");
      
      let list = "🚫 *Utilisateurs bannis*\n\n";
      db.data.banned.forEach((jid, i) => {
        list += `${i + 1}. @${jid.split("@")[0]}\n`;
      });
      return hani.sendMessage(from, { text: list, mentions: db.data.banned });
    }

    case "sudo":
    case "addsudo": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      db.addSudo(target);
      return reply(`👑 @${target.split("@")[0]} est maintenant sudo.`, { mentions: [target] });
    }

    case "delsudo":
    case "removesudo": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let target = mentioned[0] || quotedParticipant;
      if (!target) return send("❌ Mentionne quelqu'un.");
      
      db.removeSudo(target);
      return reply(`✅ @${target.split("@")[0]} n'est plus sudo.`, { mentions: [target] });
    }

    case "sudolist": {
      if (!isSudo) return send("❌ Commande réservée aux sudos.");
      
      if (db.data.sudo.length === 0) return send("📭 Aucun sudo configuré.");
      
      let list = "👑 *Sudos*\n\n";
      db.data.sudo.forEach((jid, i) => {
        list += `${i + 1}. @${jid.split("@")[0]}\n`;
      });
      return hani.sendMessage(from, { text: list, mentions: db.data.sudo });
    }

    case "anticall": {
      if (!isSudo) return send("❌ Commande réservée aux sudos.");
      
      const param = args.toLowerCase();
      if (param === "on") protectionState.anticall = true;
      else if (param === "off") protectionState.anticall = false;
      else protectionState.anticall = !protectionState.anticall;
      
      return send(`📞 Anticall ${protectionState.anticall ? "✅ activé" : "❌ désactivé"}`);
    }

    case "restart": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      await send("🔄 Redémarrage en cours...");
      process.exit(0);
    }

    case "broadcast":
    case "bc": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      if (!args) return send("❌ Donne un message à diffuser.");
      
      // Diffuser dans tous les groupes
      let sent = 0;
      for (const groupJid of Object.keys(db.data.groups)) {
        try {
          await hani.sendMessage(groupJid, { text: `📢 *Annonce HANI-MD*\n\n${args}` });
          sent++;
          await delay(1000);
        } catch (e) {}
      }
      return send(`✅ Message diffusé dans ${sent} groupes.`);
    }

    // ────────── 🕵️ SURVEILLANCE / SPY ──────────
    case "watch":
    case "spy":
    case "surveiller": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      // Ajouter un numéro à surveiller
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) return send("❌ Donne un numéro. Ex: .spy 2250150000000");
      
      watchList.add(targetNumber);
      return send(`🕵️ *Surveillance activée*\n\n📱 ${formatPhoneNumber(targetNumber)}\n\nTu recevras une alerte à chaque message de cette personne.`);
    }

    case "unwatch":
    case "unspy": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      
      if (!targetNumber) return send("❌ Donne un numéro.");
      
      watchList.delete(targetNumber);
      return send(`✅ Surveillance désactivée pour ${formatPhoneNumber(targetNumber)}`);
    }

    case "watchlist":
    case "spylist": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (watchList.size === 0) return send("📭 Aucune surveillance active.");
      
      let list = "🕵️ *Numéros surveillés*\n\n";
      let i = 1;
      for (const num of watchList) {
        list += `${i}. ${formatPhoneNumber(num)}\n`;
        i++;
      }
      return send(list);
    }

    case "activity":
    case "activite":
    case "track": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) {
        // Afficher les top utilisateurs actifs
        if (activityTracker.size === 0) return send("📭 Aucune activité enregistrée.");
        
        const sorted = [...activityTracker.values()]
          .sort((a, b) => b.messageCount - a.messageCount)
          .slice(0, 15);
        
        let list = "🕵️ *Activité récente (Top 15)*\n\n";
        sorted.forEach((user, i) => {
          list += `${i + 1}. *${user.name}*\n`;
          list += `   📱 ${formatPhoneNumber(user.number)}\n`;
          list += `   💬 ${user.messageCount} msgs\n`;
          list += `   🕐 Vu: ${user.lastSeen}\n\n`;
        });
        return send(list);
      }
      
      // Afficher l'activité d'un utilisateur spécifique
      const tracker = activityTracker.get(targetNumber);
      if (!tracker) return send(`❌ Aucune activité enregistrée pour ${formatPhoneNumber(targetNumber)}`);
      
      let text = `🕵️ *Activité de ${tracker.name}*\n`;
      text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      text += `📱 *Numéro:* ${formatPhoneNumber(tracker.number)}\n`;
      text += `📅 *1ère vue:* ${tracker.firstSeen}\n`;
      text += `🕐 *Dernière vue:* ${tracker.lastSeen}\n`;
      text += `💬 *Messages:* ${tracker.messageCount}\n`;
      
      // Groupes où l'utilisateur est actif
      if (tracker.chats.size > 0) {
        text += `\n🏘️ *Actif dans ${tracker.chats.size} groupe(s):*\n`;
        let j = 1;
        for (const chat of tracker.chats) {
          if (j <= 5) {
            text += `   ${j}. ${chat.split("@")[0]}\n`;
          }
          j++;
        }
        if (tracker.chats.size > 5) text += `   ... et ${tracker.chats.size - 5} autres\n`;
      }
      
      // Dernières activités
      if (tracker.activities.length > 0) {
        text += `\n📊 *Dernières activités:*\n`;
        tracker.activities.slice(-5).forEach(act => {
          text += `   • ${act.type?.replace("Message", "")} - ${act.time}\n`;
        });
      }
      
      return send(text);
    }

    case "clearactivity":
    case "cleartrack": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      activityTracker.clear();
      return send("✅ Historique d'activité effacé.");
    }

    case "tracklist":
    case "spiedlist": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (watchList.size === 0) {
        return send("📭 Aucun utilisateur sous surveillance.\n\nUtilise `.spy @user` pour commencer.");
      }
      
      let list = "🕵️ *Utilisateurs sous surveillance*\n━━━━━━━━━━━━━━━━━━━━━\n\n";
      let i = 1;
      for (const num of watchList) {
        const tracked = activityTracker.get(num);
        list += `${i}. 📱 ${formatPhoneNumber(num)}\n`;
        if (tracked) {
          list += `   👤 ${tracked.name}\n`;
          list += `   💬 ${tracked.messageCount} msgs\n`;
          list += `   🕐 ${tracked.lastSeen}\n`;
        } else {
          list += `   ⏳ En attente d'activité...\n`;
        }
        list += "\n";
        i++;
      }
      
      list += `📊 *Total:* ${watchList.size} surveillance(s) active(s)`;
      return send(list);
    }

    // ────────── 📁 EXTRACTION DE MÉDIAS ──────────
    case "extract":
    case "extraire":
    case "medias": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) {
        // Liste de tous les utilisateurs avec des médias
        if (mediaStore.size === 0) return send("📭 Aucun média stocké.\n\nLes médias sont automatiquement collectés quand quelqu'un t'envoie une image, vidéo, audio ou document.");
        
        let list = "📁 *Médias disponibles par utilisateur*\n━━━━━━━━━━━━━━━━━━━━━\n\n";
        let i = 1;
        for (const [num, medias] of mediaStore) {
          const firstMedia = medias[0];
          list += `${i}. ${formatPhoneNumber(num)}\n`;
          list += `   👤 ${firstMedia?.pushName || "Inconnu"}\n`;
          list += `   📊 ${medias.length} média(s)\n\n`;
          i++;
        }
        list += `\n💡 Utilise \`.extract @user\` ou \`.extract [numéro]\` pour voir les détails.`;
        return send(list);
      }
      
      const userMedias = mediaStore.get(targetNumber);
      if (!userMedias || userMedias.length === 0) {
        return send(`📭 Aucun média stocké pour ${formatPhoneNumber(targetNumber)}`);
      }
      
      let list = `📁 *Médias de ${formatPhoneNumber(targetNumber)}*\n`;
      list += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      userMedias.forEach((media, index) => {
        list += `*${index + 1}.* ${media.type?.toUpperCase()}\n`;
        list += `   📅 ${media.date}\n`;
        if (media.caption) list += `   💬 "${media.caption.substring(0, 50)}..."\n`;
        if (media.fileName) list += `   📄 ${media.fileName}\n`;
        list += "\n";
      });
      
      list += `\n💡 Utilise \`.getmedia ${targetNumber} [n°]\` pour télécharger.`;
      return send(list);
    }

    case "getmedia":
    case "dlmedia": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const parts = args?.split(" ") || [];
      let targetNumber = parts[0]?.replace(/[^0-9]/g, "");
      let mediaIndex = parseInt(parts[1]) - 1 || 0;
      
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) return send("❌ Usage: .getmedia [numéro] [n°]\nEx: .getmedia 2250150000000 1");
      
      const userMedias = mediaStore.get(targetNumber);
      if (!userMedias || userMedias.length === 0) {
        return send(`📭 Aucun média pour ${formatPhoneNumber(targetNumber)}`);
      }
      
      if (mediaIndex < 0 || mediaIndex >= userMedias.length) {
        return send(`❌ Numéro invalide. Ce contact a ${userMedias.length} média(s).`);
      }
      
      const media = userMedias[mediaIndex];
      
      try {
        const stream = await downloadMediaMessage(
          { message: media.message, key: media.key },
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
        );
        
        const caption = `📁 *Média extrait*\n\n👤 De: ${media.pushName}\n📱 ${formatPhoneNumber(targetNumber)}\n📅 ${media.date}\n📝 Type: ${media.type}${media.caption ? "\n\n💬 " + media.caption : ""}`;
        
        const botJid = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
        
        if (media.type === "image") {
          await hani.sendMessage(botJid, { image: stream, caption });
        } else if (media.type === "video") {
          await hani.sendMessage(botJid, { video: stream, caption });
        } else if (media.type === "audio") {
          await send(caption);
          await hani.sendMessage(botJid, { audio: stream, mimetype: "audio/mp4" });
        } else if (media.type === "document") {
          await hani.sendMessage(botJid, { 
            document: stream, 
            fileName: media.fileName || "document",
            caption 
          });
        }
        
        return;
      } catch (e) {
        return send(`❌ Impossible de télécharger ce média: ${e.message}`);
      }
    }

    case "medialist":
    case "allmedia": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (mediaStore.size === 0) return send("📭 Aucun média stocké.");
      
      let total = 0;
      let byType = { image: 0, video: 0, audio: 0, document: 0 };
      
      for (const [num, medias] of mediaStore) {
        total += medias.length;
        medias.forEach(m => {
          if (byType[m.type] !== undefined) byType[m.type]++;
        });
      }
      
      let text = `📁 *Statistiques médias*\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
      text += `👥 Utilisateurs: ${mediaStore.size}\n`;
      text += `📊 Total médias: ${total}\n\n`;
      text += `📸 Images: ${byType.image}\n`;
      text += `🎥 Vidéos: ${byType.video}\n`;
      text += `🎵 Audios: ${byType.audio}\n`;
      text += `📄 Documents: ${byType.document}\n`;
      text += `\n💡 Utilise \`.extract\` pour voir par utilisateur.`;
      
      return send(text);
    }

    case "clearmedia": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      
      if (targetNumber) {
        mediaStore.delete(targetNumber);
        return send(`✅ Médias supprimés pour ${formatPhoneNumber(targetNumber)}`);
      } else {
        mediaStore.clear();
        return send("✅ Tous les médias stockés ont été supprimés.");
      }
    }

    default:
      // Ne pas répondre pour les commandes inconnues
      return;
  }
}

// ═══════════════════════════════════════════════════════════
// 🚀 DÉMARRAGE DU BOT
// ═══════════════════════════════════════════════════════════

let hani = null;

async function startBot() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║              🌟 HANI-MD V1.0 🌟                           ║
║         Bot WhatsApp Intelligent par H2025                ║
║                                                           ║
╠═══════════════════════════════════════════════════════════╣
║  📱 Scanne le QR code avec WhatsApp                       ║
║  ⚙️  Préfixe: ${config.PREFIXE.padEnd(42)}║
║  👑 Owner: ${config.NOM_OWNER.padEnd(44)}║
╚═══════════════════════════════════════════════════════════╝
`);

  // Créer les dossiers nécessaires
  if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER, { recursive: true });
  }
  if (!fs.existsSync("./DataBase")) {
    fs.mkdirSync("./DataBase", { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  hani = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    logger: pino({ level: "silent" }),
    browser: ["HANI-MD", "Chrome", "120.0.0"],
    keepAliveIntervalMs: 15000,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    retryRequestDelayMs: 2000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    emitOwnEvents: true,
    fireInitQueries: true,
  });

  // ────────── ÉVÉNEMENTS DE CONNEXION ──────────
  hani.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 SCANNE CE QR CODE AVEC WHATSAPP:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      console.log("🔄 Connexion en cours...");
    }

    if (connection === "open") {
      console.log(`
╔═══════════════════════════════════════════════════════════╗
║              ✅ HANI-MD CONNECTÉ !                        ║
╠═══════════════════════════════════════════════════════════╣
║  🤖 Bot: ${(hani.user?.name || "HANI-MD").padEnd(47)}║
║  📱 Numéro: ${(hani.user?.id?.split(":")[0] || "").padEnd(44)}║
║  ⚙️  Préfixe: ${config.PREFIXE.padEnd(42)}║
║  🌐 Mode: ${config.MODE.padEnd(46)}║
╠═══════════════════════════════════════════════════════════╣
║  💡 Tape ${config.PREFIXE}menu pour voir les commandes              ║
╚═══════════════════════════════════════════════════════════╝
`);
      db.data.stats.startTime = Date.now();
      db.save();
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || "Inconnue";

      console.log(`\n⚠️ Déconnexion (code: ${statusCode}, raison: ${reason})`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.log("❌ Session expirée. Suppression et nouveau QR...");
        if (fs.existsSync(SESSION_FOLDER)) {
          fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
        }
        await delay(3000);
        startBot();
      } else if (statusCode === 440) {
        // Conflit de session - autre WhatsApp Web ouvert
        console.log("⚠️ Conflit de session détecté (WhatsApp Web ouvert ailleurs)");
        console.log("💡 Ferme les autres sessions WhatsApp Web et relance le bot.");
        console.log("🔄 Tentative de reconnexion dans 10 secondes...");
        await delay(10000);
        startBot();
      } else if (statusCode === 515) {
        // Redémarrage requis
        console.log("🔄 Redémarrage requis, reconnexion dans 3 secondes...");
        await delay(3000);
        startBot();
      } else {
        console.log("🔄 Reconnexion dans 5 secondes...");
        await delay(5000);
        startBot();
      }
    }
  });

  hani.ev.on("creds.update", saveCreds);

  // ────────── GESTION DES MESSAGES ──────────
  hani.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      const from = msg.key.remoteJid;
      const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
      
      // Intercepter les vues uniques et les sauvegarder automatiquement
      const viewOnceContent = msg.message.viewOnceMessage || msg.message.viewOnceMessageV2 || msg.message.viewOnceMessageV2Extension;
      if (viewOnceContent && !msg.key.fromMe) {
        const mediaMsg = viewOnceContent.message;
        const mediaType = Object.keys(mediaMsg || {})[0] || "inconnu";
        
        // Stocker le message complet
        viewOnceMessages.set(msg.key.id, {
          sender: sender,
          from: from,
          type: mediaType.replace("Message", ""),
          date: new Date().toLocaleString("fr-FR"),
          message: msg,
          mediaMessage: mediaMsg
        });
        
        if (viewOnceMessages.size > 50) {
          viewOnceMessages.delete(viewOnceMessages.keys().next().value);
        }
        
        console.log(`👁️ Vue unique interceptée de ${sender.split("@")[0]} (${mediaType})`);
        
        // AUTOMATIQUEMENT télécharger et envoyer en privé
        try {
          const stream = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
          );
          
          const media = mediaMsg[mediaType];
          const caption = `👁️ *Vue unique interceptée!*\n\n👤 De: ${msg.pushName || sender.split("@")[0]}\n💬 Chat: ${from.split("@")[0]}\n🕐 ${new Date().toLocaleString("fr-FR")}\n\n${media?.caption || ""}`;
          
          if (mediaType === "imageMessage") {
            await hani.sendMessage(botNumber, { image: stream, caption });
          } else if (mediaType === "videoMessage") {
            await hani.sendMessage(botNumber, { video: stream, caption });
          } else if (mediaType === "audioMessage") {
            await hani.sendMessage(botNumber, { audio: stream, mimetype: "audio/mp4" });
            await hani.sendMessage(botNumber, { text: caption });
          }
          
          console.log(`✅ Vue unique sauvegardée automatiquement`);
        } catch (e) {
          console.log(`⚠️ Erreur sauvegarde auto vue unique: ${e.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════
      // 📸 INTERCEPTER ET SAUVEGARDER LES STATUTS AUTOMATIQUEMENT
      // ═══════════════════════════════════════════════════════════
      if (from === "status@broadcast" && !msg.key.fromMe && protectionState.antideletestatus) {
        const statusType = getContentType(msg.message);
        
        // Télécharger et sauvegarder le statut immédiatement
        try {
          const statusData = {
            id: msg.key.id,
            sender: sender,
            pushName: msg.pushName || "Inconnu",
            type: statusType?.replace("Message", "") || "inconnu",
            date: new Date().toLocaleString("fr-FR"),
            timestamp: Date.now(),
            message: msg
          };
          
          // Sauvegarder dans le store
          statusStore.set(msg.key.id, statusData);
          
          // Limiter la taille
          if (statusStore.size > MAX_STORED_STATUSES) {
            statusStore.delete(statusStore.keys().next().value);
          }
          
          // Télécharger le média si c'est une image/vidéo
          if (["imageMessage", "videoMessage", "audioMessage"].includes(statusType)) {
            const stream = await downloadMediaMessage(
              msg,
              "buffer",
              {},
              { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
            );
            
            // Sauvegarder le buffer
            statusData.mediaBuffer = stream;
            statusData.caption = msg.message[statusType]?.caption || "";
            
            console.log(`📸 Statut sauvegardé de ${msg.pushName || sender.split("@")[0]} (${statusType})`);
          } else if (statusType === "extendedTextMessage") {
            statusData.text = msg.message.extendedTextMessage?.text || "";
            console.log(`📝 Statut texte sauvegardé de ${msg.pushName || sender.split("@")[0]}`);
          }
          
        } catch (e) {
          console.log(`⚠️ Erreur sauvegarde statut: ${e.message}`);
        }
      }

      // Stocker pour anti-delete
      if (!msg.key.fromMe && msg.message) {
        // Extraire le vrai numéro de l'expéditeur
        const realSender = msg.key.participant || msg.key.remoteJid;
        const realNumber = realSender?.split("@")[0] || "Inconnu";
        const realName = msg.pushName && msg.pushName.length > 1 ? msg.pushName : realNumber;
        
        messageStore.set(msg.key.id, {
          key: msg.key,
          message: msg.message,
          sender: msg.key.remoteJid,
          participant: msg.key.participant,
          realSender: realSender,
          realNumber: realNumber,
          pushName: realName,
          timestamp: new Date(),
          type: getContentType(msg.message),
          text: getMessageText(msg)
        });
        
        if (messageStore.size > MAX_STORED_MESSAGES) {
          messageStore.delete(messageStore.keys().next().value);
        }
        
        // 🕵️ TRACKER L'ACTIVITÉ
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const isGroup = from?.endsWith("@g.us");
        trackActivity(senderJid, msg.pushName, getContentType(msg.message), isGroup ? from : null);
        
        // Alerte si la personne est dans la watchlist
        const senderNum = senderJid?.split("@")[0];
        if (watchList.has(senderNum)) {
          const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
          const watchedName = msg.pushName && msg.pushName.length > 1 ? msg.pushName : "Inconnu";
          
          // 📸 INTERCEPTER AUTOMATIQUEMENT LES MÉDIAS DES SURVEILLÉS
          const msgType = getContentType(msg.message);
          if (["imageMessage", "videoMessage", "audioMessage", "documentMessage"].includes(msgType)) {
            try {
              const stream = await downloadMediaMessage(
                msg,
                "buffer",
                {},
                { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
              );
              
              const mediaContent = msg.message[msgType];
              let caption = `🕵️ *MÉDIA INTERCEPTÉ*\n`;
              caption += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
              caption += `👤 *De:* ${watchedName}\n`;
              caption += `📱 *Numéro:* ${formatPhoneNumber(senderNum)}\n`;
              caption += `💬 *Vers:* ${isGroup ? "Groupe " + from.split("@")[0] : "Chat privé"}\n`;
              caption += `📝 *Type:* ${msgType.replace("Message", "")}\n`;
              caption += `🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}\n`;
              caption += `━━━━━━━━━━━━━━━━━━━━━\n`;
              if (mediaContent?.caption) {
                caption += `\n💬 *Légende:* "${mediaContent.caption}"`;
              }
              
              if (msgType === "imageMessage") {
                await hani.sendMessage(botNumber, { image: stream, caption });
              } else if (msgType === "videoMessage") {
                await hani.sendMessage(botNumber, { video: stream, caption });
              } else if (msgType === "audioMessage") {
                await hani.sendMessage(botNumber, { text: caption });
                await hani.sendMessage(botNumber, { audio: stream, mimetype: "audio/mp4", ptt: true });
              } else if (msgType === "documentMessage") {
                await hani.sendMessage(botNumber, { 
                  document: stream, 
                  fileName: mediaContent?.fileName || "document",
                  caption 
                });
              }
              
              console.log(`🕵️ Média intercepté de ${watchedName} (${msgType})`);
            } catch (e) {
              console.log(`⚠️ Erreur interception média: ${e.message}`);
            }
          } else {
            // Alerter pour les messages texte
            let alertText = `🕵️ *ALERTE SURVEILLANCE*\n`;
            alertText += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
            alertText += `👤 *Nom:* ${watchedName}\n`;
            alertText += `📱 *Numéro:* ${formatPhoneNumber(senderNum)}\n`;
            alertText += `💬 *Chat:* ${isGroup ? "Groupe" : "Message privé"}\n`;
            if (isGroup) {
              alertText += `🏘️ *Groupe:* ${from.split("@")[0]}\n`;
            }
            alertText += `📝 *Type:* ${getContentType(msg.message)?.replace("Message", "")}\n`;
            alertText += `🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}\n`;
            alertText += `━━━━━━━━━━━━━━━━━━━━━\n`;
            if (getMessageText(msg)) {
              alertText += `\n📄 *Contenu:*\n"${getMessageText(msg).substring(0, 200)}"`;
            }
            await hani.sendMessage(botNumber, { text: alertText });
          }
        }
        
        // 📁 STOCKER LES MÉDIAS REÇUS POUR EXTRACTION
        const msgType = getContentType(msg.message);
        if (["imageMessage", "videoMessage", "audioMessage", "documentMessage"].includes(msgType)) {
          try {
            const senderForMedia = senderJid?.split("@")[0];
            if (!mediaStore.has(senderForMedia)) {
              mediaStore.set(senderForMedia, []);
            }
            
            const userMedia = mediaStore.get(senderForMedia);
            userMedia.push({
              id: msg.key.id,
              type: msgType.replace("Message", ""),
              key: msg.key,
              message: msg.message,
              pushName: realName,
              date: new Date().toLocaleString("fr-FR"),
              caption: msg.message[msgType]?.caption || "",
              fileName: msg.message[msgType]?.fileName || ""
            });
            
            // Garder seulement les MAX derniers
            if (userMedia.length > MAX_MEDIA_PER_USER) {
              userMedia.shift();
            }
            
            console.log(`📁 Média stocké de ${senderForMedia} (${msgType})`);
          } catch (e) {}
        }
      }

      // XP et niveau
      if (!msg.key.fromMe) {
        const result = db.addXP(sender, 5);
        if (result.levelUp) {
          const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
          await hani.sendMessage(botNumber, { 
            text: `🎉 *Level Up!*\n\n@${sender.split("@")[0]} est maintenant niveau ${result.newLevel}!`,
            mentions: [sender]
          });
        }
      }

      // Stats
      db.incrementStats("messages");

      // Commandes
      await handleCommand(hani, msg, db);
      
    } catch (e) {
      console.log("⚠️ Erreur message:", e.message);
    }
  });

  // ────────── ANTI-DELETE ──────────
  hani.ev.on("messages.update", async (updates) => {
    if (!protectionState.antidelete) return;
    
    for (const update of updates) {
      if (update.update?.messageStubType === 1 || update.update?.message === null) {
        const storedMsg = messageStore.get(update.key?.id);
        
        if (storedMsg) {
          console.log(`🗑️ Message supprimé de ${storedMsg.pushName}`);
          
          deletedMessages.push({
            sender: storedMsg.pushName,
            chat: storedMsg.sender,
            type: storedMsg.type?.replace("Message", "") || "texte",
            text: storedMsg.text,
            date: new Date().toLocaleString("fr-FR"),
            originalMessage: storedMsg
          });
          
          if (deletedMessages.length > MAX_DELETED_MESSAGES) {
            deletedMessages.shift();
          }
          
          try {
            const myJid = hani.user?.id;
            if (myJid) {
              // Notification détaillée avec nom ET numéro complet formaté
              // Utiliser les champs stockés correctement
              const senderNumber = storedMsg.realNumber || storedMsg.participant?.split("@")[0] || storedMsg.sender?.split("@")[0] || "Inconnu";
              const senderName = storedMsg.pushName || "Inconnu";
              const chatJid = storedMsg.sender || storedMsg.key?.remoteJid;
              const isGroupChat = chatJid?.endsWith("@g.us");
              
              // Format numéro: +225 XX XX XX XX XX
              const formattedNumber = formatPhoneNumber(senderNumber);
              
              let text = `🗑️ *MESSAGE SUPPRIMÉ DÉTECTÉ*\n`;
              text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
              text += `👤 *Nom:* ${senderName}\n`;
              text += `📱 *Numéro:* ${formattedNumber}\n`;
              text += `💬 *Chat:* ${isGroupChat ? "Groupe" : "Privé"}\n`;
              if (isGroupChat) {
                text += `🏘️ *Groupe:* ${chatJid?.split("@")[0]}\n`;
              }
              text += `📝 *Type:* ${storedMsg.type?.replace("Message", "") || "texte"}\n`;
              text += `🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}\n`;
              text += `━━━━━━━━━━━━━━━━━━━━━\n`;
              if (storedMsg.text) {
                text += `\n📄 *Contenu:*\n"${storedMsg.text}"`;
              }
              
              await hani.sendMessage(myJid, { text });
              
              // Renvoyer le média si applicable
              if (["imageMessage", "videoMessage", "audioMessage"].includes(storedMsg.type)) {
                try {
                  const stream = await downloadMediaMessage(
                    { message: storedMsg.message, key: storedMsg.key },
                    "buffer",
                    {},
                    { logger: pino({ level: "silent" }) }
                  );
                  
                  const mediaCaption = `🗑️ *Média supprimé*\n👤 ${senderName}\n📱 ${formattedNumber}`;
                  
                  if (storedMsg.type === "imageMessage") {
                    await hani.sendMessage(myJid, { image: stream, caption: mediaCaption });
                  } else if (storedMsg.type === "videoMessage") {
                    await hani.sendMessage(myJid, { video: stream, caption: mediaCaption });
                  } else if (storedMsg.type === "audioMessage") {
                    await hani.sendMessage(myJid, { audio: stream, mimetype: "audio/mp4" });
                  }
                } catch (e) {}
              }
            }
          } catch (e) {}
        }
        
        // ═══════════════════════════════════════════════════════════
        // 📸 DÉTECTER LES STATUTS SUPPRIMÉS
        // ═══════════════════════════════════════════════════════════
        const storedStatus = statusStore.get(update.key?.id);
        if (storedStatus && protectionState.antideletestatus) {
          console.log(`📸 Statut supprimé détecté de ${storedStatus.pushName}`);
          
          // Ajouter aux statuts supprimés
          deletedStatuses.push({
            ...storedStatus,
            deletedAt: new Date().toLocaleString("fr-FR")
          });
          
          if (deletedStatuses.length > MAX_DELETED_STATUSES) {
            deletedStatuses.shift();
          }
          
          // Envoyer le statut supprimé à soi-même
          try {
            const myJid = hani.user?.id;
            if (myJid) {
              const formattedStatusNumber = formatPhoneNumber(storedStatus.sender);
              
              let caption = `📸 *Statut supprimé!*\n\n`;
              caption += `👤 De: ${storedStatus.pushName}\n`;
              caption += `📱 Numéro: ${formattedStatusNumber}\n`;
              caption += `📝 Type: ${storedStatus.type}\n`;
              caption += `🕐 Posté: ${storedStatus.date}\n`;
              caption += `🗑️ Supprimé: ${new Date().toLocaleString("fr-FR")}`;
              
              if (storedStatus.mediaBuffer) {
                if (storedStatus.type === "image") {
                  await hani.sendMessage(myJid, { 
                    image: storedStatus.mediaBuffer, 
                    caption: caption + (storedStatus.caption ? `\n\n💬 "${storedStatus.caption}"` : "")
                  });
                } else if (storedStatus.type === "video") {
                  await hani.sendMessage(myJid, { 
                    video: storedStatus.mediaBuffer, 
                    caption: caption + (storedStatus.caption ? `\n\n💬 "${storedStatus.caption}"` : "")
                  });
                } else if (storedStatus.type === "audio") {
                  await hani.sendMessage(myJid, { text: caption });
                  await hani.sendMessage(myJid, { audio: storedStatus.mediaBuffer, mimetype: "audio/mp4" });
                }
              } else if (storedStatus.text) {
                caption += `\n\n💬 Contenu:\n"${storedStatus.text}"`;
                await hani.sendMessage(myJid, { text: caption });
              } else {
                await hani.sendMessage(myJid, { text: caption });
              }
              
              console.log(`✅ Statut supprimé envoyé à toi-même`);
            }
          } catch (e) {
            console.log(`⚠️ Erreur envoi statut supprimé: ${e.message}`);
          }
        }
      }
    }
  });

  // ────────── ANTI-CALL ──────────
  hani.ev.on("call", async (calls) => {
    if (!protectionState.anticall) return;
    
    for (const call of calls || []) {
      if (call.status === "offer") {
        try {
          await hani.rejectCall(call.id, call.from);
          await hani.sendMessage(call.from, { 
            text: "❌ Les appels sont désactivés sur HANI-MD.\n📩 Envoie un message à la place!" 
          });
        } catch (e) {}
      }
    }
  });

  return hani;
}

// ═══════════════════════════════════════════════════════════
// 🌐 SERVEUR WEB (KEEP ALIVE)
// ═══════════════════════════════════════════════════════════

const express = require("express");
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  const uptime = formatUptime(Date.now() - db.data.stats.startTime);
  res.send(`
    <html>
      <head>
        <title>HANI-MD</title>
        <style>
          body { font-family: Arial; background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .container { text-align: center; padding: 40px; background: rgba(255,255,255,0.1); border-radius: 20px; }
          h1 { font-size: 3em; margin: 0; }
          .status { color: #00ff88; font-size: 1.5em; margin: 20px 0; }
          .stats { color: #aaa; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🌟 HANI-MD 🌟</h1>
          <div class="status">✅ En ligne</div>
          <div class="stats">
            ⏱️ Uptime: ${uptime}<br>
            📨 Commandes: ${db.data.stats.commands}<br>
            👥 Utilisateurs: ${Object.keys(db.data.users).length}
          </div>
        </div>
      </body>
    </html>
  `);
});

app.listen(port, () => {
  console.log(`🌐 Serveur web sur le port ${port}`);
});

// ═══════════════════════════════════════════════════════════
// 🚀 LANCEMENT
// ═══════════════════════════════════════════════════════════

startBot().catch((err) => {
  console.error("❌ Erreur de démarrage:", err.message);
});

process.on("uncaughtException", (err) => {
  console.log("⚠️ Erreur:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.log("⚠️ Rejet:", err.message);
});
