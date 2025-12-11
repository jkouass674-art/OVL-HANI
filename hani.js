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
const qrcodeWeb = require("qrcode"); // Pour générer QR en image web
const mysqlDB = require("./DataBase/mysql"); // MySQL pour persistance externe
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
// 📱 SYSTÈME QR CODE MULTI-UTILISATEURS
// ═══════════════════════════════════════════════════════════

// État global pour le QR Code
const qrState = {
  currentQR: null,           // QR code actuel (string)
  qrDataURL: null,           // QR code en base64 pour affichage web
  lastUpdate: null,          // Timestamp de la dernière mise à jour
  isConnected: false,        // État de connexion
  connectionStatus: "disconnected", // disconnected, waiting_qr, connecting, connected
  botInfo: null,             // Infos du bot connecté
  qrCount: 0,                // Nombre de QR générés
};

// ═══════════════════════════════════════════════════════════
// 📦 BASE DE DONNÉES HYBRIDE (Local + MySQL)
// ═══════════════════════════════════════════════════════════

class HaniDatabase {
  constructor(dbPath = "./DataBase/hani.json") {
    this.dbPath = dbPath;
    this.data = this.load();
    this.mysqlConnected = false;
    this.syncQueue = [];
    
    // Connexion MySQL en arrière-plan
    this.initMySQL();
  }

  async initMySQL() {
    try {
      if (process.env.MYSQL_URL || process.env.MYSQL_HOST) {
        const connected = await mysqlDB.connect();
        if (connected) {
          this.mysqlConnected = true;
          console.log("[OK] MySQL connecté - Les données seront synchronisées");
          
          // Charger les données depuis MySQL si disponible
          await this.loadFromMySQL();
          
          // Nettoyage automatique des anciennes données (30 jours)
          mysqlDB.cleanOldData(30).catch(() => {});
        }
      } else {
        console.log("[!] MySQL non configuré - Mode local uniquement");
      }
    } catch (e) {
      console.log("⚠️ MySQL non disponible:", e.message);
      this.mysqlConnected = false;
    }
  }

  async loadFromMySQL() {
    try {
      // Charger les stats depuis MySQL
      const stats = await mysqlDB.getStats();
      if (stats) {
        this.data.stats = { 
          ...this.data.stats, 
          commands: stats.commands || 0,
          messages: stats.messages || 0
        };
      }
      console.log("[STATS] Données MySQL chargées");
    } catch (e) {
      // Ignorer si pas de données
    }
  }

  load() {
    try {
      if (fs.existsSync(this.dbPath)) {
        return JSON.parse(fs.readFileSync(this.dbPath, "utf-8"));
      }
    } catch (e) {
      console.log("[!] Erreur chargement DB, création nouvelle...");
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
      // Sauvegarder localement
      fs.writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
      
      // Synchroniser avec MySQL en arrière-plan
      if (this.mysqlConnected) {
        this.syncToMySQL().catch(() => {});
      }
    } catch (e) {
      console.log("⚠️ Erreur sauvegarde DB:", e.message);
    }
  }

  async syncToMySQL() {
    try {
      // Sync stats
      await mysqlDB.updateStats(this.data.stats);
      
      // Sync users (batch pour performance)
      for (const [jid, userData] of Object.entries(this.data.users)) {
        await mysqlDB.updateUser(jid, userData);
      }
      
      // Sync groups
      for (const [jid, groupData] of Object.entries(this.data.groups)) {
        await mysqlDB.updateGroup(jid, groupData);
      }
    } catch (e) {
      // Ignorer les erreurs de sync
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

  // Limitations utilisateurs
  isLimited(jid) {
    if (!this.data.limitedUsers) this.data.limitedUsers = {};
    return !!this.data.limitedUsers[jid];
  }

  getLimitations(jid) {
    if (!this.data.limitedUsers) this.data.limitedUsers = {};
    return this.data.limitedUsers[jid] || null;
  }

  isCommandBlocked(jid, command) {
    const limitations = this.getLimitations(jid);
    if (!limitations) return false;
    return limitations.blockedCommands?.includes(command) || false;
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

  // Approved Users (utilisateurs approuvés avec accès limité)
  isApproved(jid) {
    if (!this.data.approved) this.data.approved = [];
    return this.data.approved.includes(jid) || this.data.approved.some(n => jid.includes(n));
  }

  addApproved(jid) {
    if (!this.data.approved) this.data.approved = [];
    if (!this.isApproved(jid)) {
      this.data.approved.push(jid);
      this.save();
      return true;
    }
    return false;
  }

  removeApproved(jid) {
    if (!this.data.approved) this.data.approved = [];
    const before = this.data.approved.length;
    this.data.approved = this.data.approved.filter(s => s !== jid && !jid.includes(s) && !s.includes(jid.replace(/[^0-9]/g, '')));
    if (this.data.approved.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  getApprovedList() {
    return this.data.approved || [];
  }

  // Stats
  incrementStats(key) {
    this.data.stats[key] = (this.data.stats[key] || 0) + 1;
    // Sync avec MySQL
    if (this.mysqlConnected) {
      mysqlDB.incrementStats(key).catch(() => {});
    }
  }

  // === FONCTIONS MySQL ===

  // Sauvegarder un message supprimé
  async saveDeletedMessage(message, from, sender, senderName = '', groupName = null) {
    if (this.mysqlConnected) {
      try {
        let mediaType = null;
        if (message.message?.imageMessage) mediaType = "image";
        else if (message.message?.videoMessage) mediaType = "video";
        else if (message.message?.audioMessage) mediaType = "audio";
        else if (message.message?.documentMessage) mediaType = "document";
        
        await mysqlDB.saveDeletedMessage({
          messageId: message.key?.id,
          from,
          sender,
          senderName,
          groupName,
          text: message.message?.conversation || 
                message.message?.extendedTextMessage?.text || "",
          mediaType
        });
      } catch (e) {}
    }
  }

  // Récupérer les messages supprimés
  async getDeletedMessages(jid = null, limit = 20) {
    if (this.mysqlConnected) {
      try {
        return await mysqlDB.getDeletedMessages(jid, limit);
      } catch (e) {}
    }
    return [];
  }

  // Sauvegarder un statut supprimé
  async saveDeletedStatus(statusData) {
    if (this.mysqlConnected) {
      try {
        await mysqlDB.saveDeletedStatus(statusData);
      } catch (e) {}
    }
  }

  // Récupérer les statuts supprimés
  async getDeletedStatuses(sender = null, limit = 20) {
    if (this.mysqlConnected) {
      try {
        return await mysqlDB.getDeletedStatuses(sender, limit);
      } catch (e) {}
    }
    return [];
  }

  // Sauvegarder un contact
  async saveContact(jid, name, phone, pushName = '') {
    if (this.mysqlConnected) {
      try {
        await mysqlDB.saveContact(jid, name, phone, pushName);
      } catch (e) {}
    }
  }

  // Chercher un contact
  async searchContacts(query) {
    if (this.mysqlConnected) {
      try {
        return await mysqlDB.searchContacts(query);
      } catch (e) {}
    }
    return [];
  }

  // Tous les contacts
  async getAllContacts() {
    if (this.mysqlConnected) {
      try {
        return await mysqlDB.getAllContacts();
      } catch (e) {}
    }
    return [];
  }

  // === SURVEILLANCE ===
  
  async addToSurveillance(jid) {
    if (this.mysqlConnected) {
      return await mysqlDB.addToSurveillance(jid);
    }
    return false;
  }

  async removeFromSurveillance(jid) {
    if (this.mysqlConnected) {
      return await mysqlDB.removeFromSurveillance(jid);
    }
    return false;
  }

  async getSurveillanceList() {
    if (this.mysqlConnected) {
      return await mysqlDB.getSurveillanceList();
    }
    return [];
  }

  async isUnderSurveillance(jid) {
    if (this.mysqlConnected) {
      return await mysqlDB.isUnderSurveillance(jid);
    }
    return false;
  }

  async logActivity(jid, actionType, details) {
    if (this.mysqlConnected) {
      await mysqlDB.logActivity(jid, actionType, details);
    }
  }

  async getActivity(jid, limit = 50) {
    if (this.mysqlConnected) {
      return await mysqlDB.getActivity(jid, limit);
    }
    return [];
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
  SESSION_ID: process.env.SESSION_ID || "",  // Session encodée pour déploiement
};

const SESSION_FOLDER = "./DataBase/session/principale";
const db = new HaniDatabase();

// ═══════════════════════════════════════════════════════════
// 🔐 RESTAURATION DE SESSION DEPUIS SESSION_ID
// ═══════════════════════════════════════════════════════════

async function restoreSessionFromId() {
  const sessionId = config.SESSION_ID;
  
  if (!sessionId || !sessionId.startsWith("HANI-MD~")) {
    console.log("[QR] Pas de SESSION_ID, scan QR requis...");
    return false;
  }
  
  try {
    console.log("🔐 Restauration de session depuis SESSION_ID...");
    
    // Décoder la session
    const base64Data = sessionId.replace("HANI-MD~", "");
    const jsonString = Buffer.from(base64Data, "base64").toString("utf-8");
    const sessionBundle = JSON.parse(jsonString);
    
    // Créer le dossier si nécessaire
    if (!fs.existsSync(SESSION_FOLDER)) {
      fs.mkdirSync(SESSION_FOLDER, { recursive: true });
    }
    
    // Écrire les fichiers de session
    for (const [filename, base64Content] of Object.entries(sessionBundle)) {
      const filePath = path.join(SESSION_FOLDER, filename);
      const content = Buffer.from(base64Content, "base64");
      fs.writeFileSync(filePath, content);
    }
    
    console.log("[OK] Session restaurée avec succès !");
    return true;
  } catch (e) {
    console.error("❌ Erreur restauration session:", e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 🛡️ ÉTATS DES PROTECTIONS (GLOBAL) - TOUT ACTIVÉ AUTOMATIQUEMENT
// ═══════════════════════════════════════════════════════════

const protectionState = {
  antidelete: true,           // Messages supprimés → envoyés à Moi-même
  anticall: true,             // Rejeter les appels automatiquement
  antideletestatus: true,     // Statuts supprimés → envoyés à Moi-même
  autoViewOnce: true,         // Photos/Vidéos vue unique → envoyées à Moi-même
  autoViewOnceAudio: true,    // Vocaux écoute unique → envoyés à Moi-même
  autoSaveStatus: true,       // Tous les statuts → sauvegardés automatiquement
  // antibot désactivé - plus de blocage automatique des bots
  spyStatusViews: true,       // 👁️ Voir qui regarde mes statuts (même si désactivé)
  spyReadReceipts: true,      // 📖 Notifications lecture messages ACTIVÉ
  spyReplies: true,           // 🔔 Notifier quand quelqu'un répond (preuve de lecture!)
  spyPresence: true,          // 👀 Détecter qui ouvre ma discussion (en ligne/tape)
};

// Stockage des vues de statuts et lectures
const spyData = {
  statusViews: [],      // { viewer, viewerName, timestamp }
  messageReads: [],     // { reader, readerName, timestamp }
  replies: [],          // { replier, replierName, timestamp, preview } - Réponses reçues
  pendingMessages: {},  // Messages envoyés en attente de lecture { jid: timestamp }
  presenceDetected: [], // { jid, name, type, timestamp } - Présences détectées
  lastPresenceNotif: {}, // Anti-spam: dernière notification par JID
  maxEntries: 100,       // Garder les 100 derniers
  presenceCooldown: {},  // Cooldown pour éviter spam
  // 🆕 Nouvelles données espion avancées
  lastSeen: {},          // { jid: { lastOnline, lastOffline, name } } - Tracker connexion
  profileChanges: [],    // { jid, type: 'photo'|'bio'|'name', oldValue, newValue, timestamp }
  profileSnapshots: {},  // { jid: { photo, bio, name, lastCheck } } - Snapshots profils
  callHistory: [],       // { jid, name, type: 'audio'|'video', direction: 'in'|'out', timestamp, duration }
  groupActivity: [],     // { groupJid, groupName, action, participant, participantName, timestamp }
};

// 🆕 Configuration espion avancé
const spyConfig = {
  trackLastSeen: true,      // Tracker les connexions/déconnexions
  alertPhotoChange: true,   // Alerter si photo de profil change
  alertBioChange: true,     // Alerter si bio change
  alertNameChange: true,    // Alerter si nom change
  trackCalls: true,         // Historique des appels
  trackGroups: true,        // Surveillance des groupes
  ghostMode: false,         // Mode fantôme (invisible total)
  ghostModeAdvanced: {
    hideOnline: true,       // Ne pas montrer "en ligne"
    hideTyping: true,       // Ne pas montrer "en train d'écrire"
    hideRead: true,         // Ne pas envoyer les confirmations de lecture
    hideRecording: true,    // Ne pas montrer "enregistre un vocal"
  }
};

// 📅 MESSAGES PROGRAMMÉS (Scheduled Messages)
const scheduledMessages = [];
// Structure: { id, targetJid, targetName, message, scheduledTime, repeat, repeatInterval, active, createdAt }
// repeat: 'once' | 'daily' | 'weekly' | 'monthly'
// repeatInterval: pour personnalisé (en ms)

let schedulerInterval = null;
let ghostModeInterval = null; // Intervalle pour maintenir le mode ghost

// 👻 Fonction pour démarrer le mode ghost (maintenir invisible en continu)
function startGhostMode(hani) {
  if (ghostModeInterval) return; // Déjà actif
  
  // Envoyer immédiatement la présence "unavailable"
  try {
    hani.sendPresenceUpdate("unavailable");
    console.log("👻 [GHOST] Mode fantôme activé - Présence invisible");
  } catch (e) {
    console.log("👻 [GHOST] Erreur activation:", e.message);
  }
  
  // Maintenir la présence invisible toutes les 10 secondes
  ghostModeInterval = setInterval(async () => {
    if (!spyConfig.ghostMode) {
      stopGhostMode();
      return;
    }
    try {
      await hani.sendPresenceUpdate("unavailable");
    } catch (e) {
      // Ignorer les erreurs silencieusement
    }
  }, 10000); // Toutes les 10 secondes
}

// 👻 Fonction pour arrêter le mode ghost
function stopGhostMode(hani) {
  if (ghostModeInterval) {
    clearInterval(ghostModeInterval);
    ghostModeInterval = null;
    console.log("👻 [GHOST] Mode fantôme désactivé");
  }
  // Remettre visible si hani est fourni
  if (hani) {
    try {
      hani.sendPresenceUpdate("available");
    } catch (e) {}
  }
}

// Fonction pour vérifier et envoyer les messages programmés
function startScheduler(hani) {
  if (schedulerInterval) return; // Déjà démarré
  
  schedulerInterval = setInterval(async () => {
    const now = Date.now();
    const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
    
    for (const msg of scheduledMessages) {
      if (!msg.active) continue;
      
      // Vérifier si c'est l'heure
      if (now >= msg.scheduledTime) {
        try {
          // Envoyer le message
          await hani.sendMessage(msg.targetJid, { text: msg.message });
          
          console.log(`📅 [SCHEDULED] Message envoyé à ${msg.targetName}: "${msg.message.slice(0, 50)}..."`);
          
          // Notifier l'owner
          await hani.sendMessage(botNumber, { 
            text: `📅 *Message programmé envoyé*\n\n👤 À: ${msg.targetName}\n📱 ${msg.targetJid.split("@")[0]}\n💬 "${msg.message.slice(0, 100)}..."\n🕐 ${new Date().toLocaleString("fr-FR")}`
          });
          
          // Gérer la répétition
          if (msg.repeat === 'once') {
            msg.active = false;
          } else if (msg.repeat === 'daily') {
            msg.scheduledTime += 24 * 60 * 60 * 1000; // +24h
          } else if (msg.repeat === 'weekly') {
            msg.scheduledTime += 7 * 24 * 60 * 60 * 1000; // +7 jours
          } else if (msg.repeat === 'monthly') {
            msg.scheduledTime += 30 * 24 * 60 * 60 * 1000; // +30 jours
          } else if (msg.repeat === 'custom' && msg.repeatInterval) {
            msg.scheduledTime += msg.repeatInterval;
          }
        } catch (e) {
          console.log(`[!] Erreur envoi message programmé: ${e.message}`);
        }
      }
    }
  }, 30000); // Vérifier toutes les 30 secondes
  
  console.log("📅 [SCHEDULER] Système de messages programmés démarré");
}

// 📇 FONCTION pour détecter si c'est un LID (Linked ID) et pas un vrai numéro
const isLID = (number) => {
  if (!number) return true;
  const clean = String(number).replace(/[^0-9]/g, '');
  // Les LID sont généralement très longs (> 14 chiffres)
  // Les vrais numéros ont généralement 10-14 chiffres
  if (clean.length > 14) return true;
  // Si c'est un JID avec @lid
  if (String(number).includes("@lid")) return true;
  return false;
};

// 📇 FONCTION pour extraire un vrai numéro depuis un JID
const extractRealNumber = (jid) => {
  if (!jid) return null;
  // Si c'est un LID, on ne peut pas avoir le vrai numéro
  if (String(jid).includes("@lid")) return null;
  // Extraire le numéro avant @s.whatsapp.net
  const num = String(jid).split("@")[0].split(":")[0];
  if (isLID(num)) return null;
  return num;
};

// 📇 FONCTION GLOBALE pour formater un numéro de téléphone joliment
const formatPhoneForDisplay = (number) => {
  if (!number) return "Inconnu";
  const clean = String(number).replace(/[^0-9]/g, '');
  
  // Vérifier si c'est un LID (pas un vrai numéro)
  if (isLID(clean)) {
    return "❌ LID (pas un vrai numéro)";
  }
  
  // Côte d'Ivoire: +225 XX XX XX XX XX
  if (clean.length === 12 && clean.startsWith("225")) {
    return `+225 ${clean.slice(3,5)} ${clean.slice(5,7)} ${clean.slice(7,9)} ${clean.slice(9,11)} ${clean.slice(11)}`;
  } 
  // France: +33 X XX XX XX XX
  else if (clean.length === 11 && clean.startsWith("33")) {
    return `+33 ${clean.slice(2,3)} ${clean.slice(3,5)} ${clean.slice(5,7)} ${clean.slice(7,9)} ${clean.slice(9)}`;
  } 
  // Autre pays (numéro valide)
  else if (clean.length >= 10 && clean.length <= 14) {
    return `+${clean.slice(0,3)} ${clean.slice(3,6)} ${clean.slice(6,9)} ${clean.slice(9)}`;
  }
  return `+${clean}`;
};

// ═══════════════════════════════════════════════════════════
// 🎫 SYSTÈME DE PERMISSIONS - COMMANDES PAR NIVEAU
// ═══════════════════════════════════════════════════════════

// Commandes accessibles à TOUT LE MONDE (users normaux)
const publicCommands = [
  // Général
  "ping", "menu", "help", "info", "runtime", "uptime", "alive",
  // Permissions (chacun peut voir son niveau)
  "permissions", "myaccess", "mylevel", "whoami",
  // Fun basique
  "sticker", "s", "toimg", "toimage",
  // Téléchargement basique
  "tiktok", "tt", "ytmp3", "ytmp4", "play", "song", "video",
  // IA (limité)
  "gpt", "ai", "gemini",
  // Outils basiques
  "calc", "tts", "translate", "tr",
  // Profil
  "profil", "profile", "me", "level", "rank",
];

// Commandes pour utilisateurs APPROUVÉS (approved) - EXCLUSIVES (pas inclure public)
const approvedOnlyCommands = [
  // Téléchargement avancé
  "ig", "instagram", "fb", "facebook", "twitter", "x",
  "pinterest", "pin", "spotify", "mediafire",
  // Recherche
  "ytsearch", "lyrics", "weather", "meteo",
  // Images
  "imagine", "dalle", "image",
  // Jeux
  "slot", "dice", "flip", "rps",
];

// Toutes les commandes approved (pour compatibilité)
const approvedCommands = [...publicCommands, ...approvedOnlyCommands];

// Commandes pour SUDO (admins de confiance) - EXCLUSIVES (pas inclure approved)
const sudoOnlyCommands = [
  // Groupe (modération)
  "kick", "add", "promote", "demote", "mute", "unmute",
  "hidetag", "tagall", "antilink", "antispam",
  // Outils avancés
  "broadcast", "bc",
];

// Toutes les commandes sudo (pour compatibilité)
const sudoCommands = [...approvedCommands, ...sudoOnlyCommands];

// Commandes OWNER SEULEMENT (toi uniquement)
const ownerOnlyCommands = [
  // Contrôle total
  "eval", "exec", "shell", "restart", "shutdown",
  // Mode du bot
  "mode",
  // Gestion utilisateurs
  "ban", "unban", "sudo", "delsudo", "addsudo", "removesudo", "sudolist",
  "approve", "unapprove", "approved", "addapprove", "removeapprove", "delapprove", "approvelist", "approvedlist",
  // Protections
  "antidelete", "anticall", "viewonce", "audioonce", "savestatus",
  "protection", "antideletestatus",
  // Blocage WhatsApp
  "block", "unblock", "bloquer", "debloquer",
  // Configuration
  "setprefix", "setname", "setbio", "setpp", "setppgroup",
  // Debug
  "test", "debug", "clearsession",
  // Surveillance (tes fonctionnalités privées)
  "deleted", "delmsg", "deletedstatus", "delstatus", "statusdel",
  "vv", "viewonce", "getstatus", "spy", "track", "activity", "invisible",
  // Commandes espion séparées (basiques)
  "spyread", "quilit", "spyreply", "quirepond", "spypresence", "quiouvre", "quiecrit",
  "spyhistory", "spyall", "espionhistorique", "spystatus", "quivoitmesstatus",
  "spyon", "spyoff", "spyclear",
  // Commandes espion avancées
  "lastseen", "derniereconnexion", "online",
  "profilechanges", "changementsprofil", "alertprofil",
  "callhistory", "historiqueappels", "appels",
  "groupspy", "surveillancegroupe", "groupactivity",
  "ghost", "fantome",
  "spyexport", "exportspy", "exporterespion",
  "spystats", "statsespion", "statistiques",
  "trackconfig", "spyconfig", "configespion",
  // Messages programmés
  "schedule", "programmer", "planifier",
  "schedulerepeat", "programmerrepeat", "messagerecurrent",
  "schedulelist", "programmelist", "listeprogrammes",
  "scheduledel", "schedulecancel", "supprimerprogramme",
  "scheduleclear", "clearschedule",
  "schedulepause", "pauseprogramme",
];

// Liste des utilisateurs approuvés
const approvedUsers = new Set();

// 🤖 DÉTECTION BOT DÉSACTIVÉE
// La détection automatique et le blocage des bots sont désactivés

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
// 📇 BASE DE DONNÉES DES CONTACTS (Noms + Numéros réels)
// ═══════════════════════════════════════════════════════════

// Structure pour stocker TOUS les contacts rencontrés
const contactsDB = new Map();  // numéro -> { name, jid, firstSeen, lastSeen, ... }

// Ajouter ou mettre à jour un contact
function updateContact(jid, pushName, additionalData = {}) {
  if (!jid) return null;
  
  const number = jid.split("@")[0];
  if (!number || number.length < 8) return null;
  
  // Vérifier si c'est un vrai numéro (pas un ID de groupe)
  if (jid.endsWith("@g.us") || jid.includes("-")) return null;
  
  const now = new Date().toLocaleString("fr-FR");
  
  if (!contactsDB.has(number)) {
    // Nouveau contact
    contactsDB.set(number, {
      jid: jid,
      number: number,
      name: pushName || "Inconnu",
      formattedNumber: formatPhoneNumber(number),
      firstSeen: now,
      lastSeen: now,
      messageCount: 0,
      isBlocked: false,
      notes: "",
      ...additionalData
    });
    console.log(`📇 Nouveau contact: ${pushName || number} (${formatPhoneNumber(number)})`);
  } else {
    // Contact existant - mise à jour
    const contact = contactsDB.get(number);
    if (pushName && pushName.length > 1 && pushName !== "Inconnu") {
      contact.name = pushName;
    }
    contact.lastSeen = now;
    contact.messageCount++;
    // Fusionner les données additionnelles
    Object.assign(contact, additionalData);
  }
  
  return contactsDB.get(number);
}

// Récupérer un contact par numéro
function getContact(numberOrJid) {
  const number = numberOrJid?.split("@")[0]?.replace(/[^0-9]/g, "");
  return contactsDB.get(number) || null;
}

// Récupérer le nom d'un contact
function getContactName(numberOrJid) {
  const contact = getContact(numberOrJid);
  if (contact && contact.name && contact.name !== "Inconnu") {
    return contact.name;
  }
  // Fallback: numéro formaté
  const number = numberOrJid?.split("@")[0];
  return formatPhoneNumber(number);
}

// Lister tous les contacts
function getAllContacts() {
  return Array.from(contactsDB.values());
}

// Rechercher un contact par nom ou numéro
function searchContacts(query) {
  const q = query.toLowerCase();
  return getAllContacts().filter(c => 
    c.name.toLowerCase().includes(q) || 
    c.number.includes(q) ||
    c.formattedNumber.includes(q)
  );
}

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

// Valider si c'est un vrai numéro de téléphone (pas un ID de groupe/message)
function isValidPhoneNumber(num) {
  if (!num) return false;
  const cleaned = num.replace(/[^0-9]/g, "");
  // Un numéro valide a entre 10 et 15 chiffres
  return cleaned.length >= 10 && cleaned.length <= 15;
}

// Cache pour stocker les noms des contacts
const contactNamesCache = new Map();

// Stocker le nom d'un contact (accepte les numéros ET les LID)
function cacheContactName(jid, name) {
  if (jid && name && name.length > 1) {
    const num = jid.split("@")[0];
    // Accepter les numéros de téléphone valides OU les LID (identifiants internes WhatsApp)
    if (num && (isValidPhoneNumber(num) || /^\d{10,20}$/.test(num))) {
      contactNamesCache.set(num, name);
    }
  }
}

// Récupérer le nom d'un contact depuis le cache
function getCachedContactName(jid) {
  const num = jid?.split("@")[0];
  return contactNamesCache.get(num) || null;
}

// ═══════════════════════════════════════════════════════════
// 🎨 MENUS ET TEXTES (SIMPLIFIÉ)
// ═══════════════════════════════════════════════════════════

function getMainMenu(prefix, userRole = "user") {
  // Menu pour les USERS (accès basique)
  if (userRole === "user") {
    return `
╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃    🌟 *HANI-MD V1.0* 🌟   
┃━━━━━━━━━━━━━━━━━━━━━━━━━
┃ 📌 Préfixe : *${prefix}*
┃ 🤖 Mode    : *${config.MODE}*
┃ 👤 Ton rôle : *User*
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 👤 *MENU UTILISATEUR* ━━━╮
┃
┃ 📌 *GÉNÉRAL*
┃ ${prefix}menu - Ce menu
┃ ${prefix}ping - Tester le bot
┃ ${prefix}info - Infos du bot
┃ ${prefix}whoami - Qui suis-je?
┃
┃ 🔧 *OUTILS*
┃ ${prefix}sticker - Créer sticker
┃ ${prefix}calc [expression] - Calculer
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 🔒 *ACCÈS LIMITÉ* ━━━╮
┃
┃ ❌ Commandes de groupe
┃ ❌ Protections du bot
┃ ❌ Vue unique / Anti-delete
┃
┃ 💡 *Pour plus d'accès:*
┃ Demande à l'owner de t'approuver!
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;
  }
  
  // Menu pour les APPROVED (accès intermédiaire)
  if (userRole === "approved") {
    return `
╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃    🌟 *HANI-MD V1.0* 🌟   
┃━━━━━━━━━━━━━━━━━━━━━━━━━
┃ 📌 Préfixe : *${prefix}*
┃ 🤖 Mode    : *${config.MODE}*
┃ ✅ Ton rôle : *Approved*
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ ✅ *MENU APPROUVÉ* ━━━╮
┃
┃ 📌 *GÉNÉRAL*
┃ ${prefix}menu - Ce menu
┃ ${prefix}ping - Tester le bot
┃ ${prefix}info - Infos du bot
┃ ${prefix}whoami - Qui suis-je?
┃
┃ 🔧 *OUTILS*
┃ ${prefix}sticker - Créer sticker
┃ ${prefix}calc [expression] - Calculer
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 🔒 *NON DISPONIBLE* ━━━╮
┃ ❌ Commandes de groupe (admin)
┃ ❌ Protections du bot
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;
  }
  
  // Menu pour les SUDO (accès étendu)
  if (userRole === "sudo") {
    return `
╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃    🌟 *HANI-MD V1.0* 🌟   
┃━━━━━━━━━━━━━━━━━━━━━━━━━
┃ 📌 Préfixe : *${prefix}*
┃ 🤖 Mode    : *${config.MODE}*
┃ ⚡ Ton rôle : *Sudo*
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ ⚡ *MENU SUDO* ━━━╮
┃
┃ 📌 *GÉNÉRAL*
┃ ${prefix}ping, ${prefix}info, ${prefix}whoami
┃
┃ 🔧 *OUTILS*
┃ ${prefix}sticker, ${prefix}calc
┃
┃ 👥 *GROUPE*
┃ ${prefix}kick @user - Exclure
┃ ${prefix}add [n°] - Ajouter
┃ ${prefix}promote/@demote - Gérer admins
┃ ${prefix}link - Lien du groupe
┃ ${prefix}tagall - Mentionner tous
┃ ${prefix}hidetag [msg] - Tag caché
┃ ${prefix}warn/@unwarn - Avertissements
┃
┃ 👑 *GESTION USERS*
┃ ${prefix}approve/@unapprove - Approuver
┃ ${prefix}ban/@unban - Bannir
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 🔒 *RÉSERVÉ OWNER* ━━━╮
┃ ❌ ${prefix}sudo, ${prefix}delsudo
┃ ❌ Protections avancées
┃ ❌ Vue unique / Anti-delete
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯
`;
  }
  
  // Menu COMPLET pour OWNER
  return `
╭━━━━━━━━━━━━━━━━━━━━━━━━━╮
┃    🌟 *HANI-MD V1.0* 🌟   
┃━━━━━━━━━━━━━━━━━━━━━━━━━
┃ 📌 Préfixe : *${prefix}*
┃ 🤖 Mode    : *${config.MODE}*
┃ 👑 Ton rôle : *OWNER*
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━ 👑 *MENU OWNER COMPLET* ━━━╮
┃
┃ 📌 *GÉNÉRAL*
┃ ${prefix}ping - Tester le bot
┃ ${prefix}info - Infos du bot
┃ ${prefix}stats - Statistiques
┃ ${prefix}whoami - Qui suis-je?
┃
┃ 🔧 *OUTILS*
┃ ${prefix}sticker - Créer sticker
┃ ${prefix}calc [expression] - Calculer
┃
┃ 👥 *GROUPE*
┃ ${prefix}kick @user - Exclure
┃ ${prefix}add [n°] - Ajouter
┃ ${prefix}promote/@demote - Gérer admins
┃ ${prefix}link - Lien du groupe
┃ ${prefix}tagall - Mentionner tous
┃ ${prefix}hidetag [msg] - Tag caché
┃
┃ 🛡️ *PROTECTIONS*
┃ ${prefix}antilink on/off
┃ ${prefix}antispam on/off
┃ ${prefix}antibot on/off
┃ ${prefix}warn @user - Avertir
┃ ${prefix}warnlist - Liste warns
┃
┃ 👁️ *VUE UNIQUE*
┃ ${prefix}vv - Récupérer (répondre)
┃ ${prefix}listvv - Liste interceptées
┃ ${prefix}viewonce on/off
┃
┃ 🗑️ *ANTI-DELETE*
┃ ${prefix}antidelete on/off
┃ ${prefix}deleted - Voir supprimés
┃
┃ 📸 *STATUTS*
┃ ${prefix}savestatus on/off
┃ ${prefix}liststatus - Liste statuts
┃ ${prefix}getstatus [n°] - Récupérer
┃
┃ 👑 *GESTION USERS*
┃ ${prefix}approve/@unapprove
┃ ${prefix}sudo/@delsudo
┃ ${prefix}ban/@unban
┃ ${prefix}mode public/private
┃
┃ 🕵️ *ESPIONNAGE BASIQUE*
┃ ${prefix}spyon/spyoff - Mode espion
┃ ${prefix}spyread - Qui lit mes msg
┃ ${prefix}spyreply - Qui répond
┃ ${prefix}spypresence - Qui ouvre chat
┃ ${prefix}spystatus - Qui voit statuts
┃ ${prefix}spyhistory - Historique complet
┃ ${prefix}spyclear - Effacer données
┃
┃ 🔍 *ESPIONNAGE AVANCÉ*
┃ ${prefix}lastseen - Connexions trackées
┃ ${prefix}callhistory - Historique appels
┃ ${prefix}groupspy - Activité groupes
┃ ${prefix}profilechanges - Changements profil
┃ ${prefix}spystats [jour/semaine/mois]
┃ ${prefix}spyexport - Exporter données
┃ ${prefix}spyconfig - Configuration
┃ ${prefix}ghost on/off - Mode fantôme
┃
┃ 🎯 *SURVEILLANCE CIBLÉE*
┃ ${prefix}spy @user - Surveiller
┃ ${prefix}unspy @user - Arrêter
┃ ${prefix}spylist - Liste surveillés
┃ ${prefix}activity - Activité users
┃ ${prefix}stalk @user - Profil complet
┃ ${prefix}communs @user - Contacts mutuels
┃ ${prefix}quiamon - Qui a mon numéro?
┃
┃ 📅 *MESSAGES PROGRAMMÉS*
┃ ${prefix}schedule [n°] [heure] [msg]
┃ ${prefix}schedulerepeat [n°] [h] [freq] [msg]
┃ ${prefix}schedulelist - Voir programmés
┃ ${prefix}scheduledel [id] - Supprimer
┃ ${prefix}schedulepause [id] - Pause
┃ ${prefix}scheduleclear - Tout supprimer
┃
┃ ⚙️ *SYSTÈME*
┃ ${prefix}broadcast [msg]
┃ ${prefix}restart - Redémarrer
┃ ${prefix}invisible off/on - Visibilité
┃ ${prefix}protection - État protections
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━╯

💡 *Tu as accès à TOUTES les commandes!*
`;
}

// ═══════════════════════════════════════════════════════════
// 🎯 GESTIONNAIRE DE COMMANDES
// ═══════════════════════════════════════════════════════════

async function handleCommand(hani, msg, db) {
  const from = msg.key.remoteJid;
  const body = getMessageText(msg);
  
  // Debug: afficher le texte brut reçu
  console.log(`[DEBUG] Texte brut reçu: "${body}" | Préfixe attendu: "${config.PREFIXE}"`);
  
  if (!body || !body.startsWith(config.PREFIXE)) return;

  const [cmd, ...rest] = body.slice(config.PREFIXE.length).trim().split(/\s+/);
  const command = (cmd || "").toLowerCase();
  const args = rest.join(" ");
  const sender = msg.key.participant || msg.key.remoteJid;
  const pushName = msg.pushName || "Utilisateur";
  
  // Numéro du bot
  const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
  const botNumberClean = hani.user?.id?.split(":")[0] || "";
  
  // Vérification owner avec plusieurs formats
  const senderNumber = extractNumber(sender);
  // NE PAS supprimer les virgules ici ! On garde la chaîne originale pour split
  const ownerNumberRaw = config.NUMERO_OWNER || "";
  
  // Debug pour TOUTES les commandes owner
  console.log(`[CMD: ${command}] Sender: ${senderNumber} | Owners: ${ownerNumberRaw} | Bot: ${botNumberClean}`);
  
  // 🔐 PAS D'ENREGISTREMENT AUTOMATIQUE
  // Seul le propriétaire (celui qui a scanné le QR) peut utiliser le bot
  // Les amis/contacts ne sont PAS enregistrés automatiquement
  // Pour avoir leur propre bot, ils doivent scanner leur propre QR code
  
  // Vérification TRÈS SOUPLE pour owner:
  // Les NUMERO_OWNER dans .env sont owners (peut être plusieurs séparés par virgule)
  // Le numéro du bot LUI-MÊME peut aussi exécuter des commandes owner (pour le chat "Moi-même")
  const ownerNumbers = ownerNumberRaw.split(',').map(n => n.trim().replace(/[^0-9]/g, '')).filter(n => n.length > 0);
  
  // 👑 OWNERS HARDCODÉS (toujours propriétaires même si pas dans .env)
  const hardcodedOwners = ["22550252467", "225015025267", "66791824998402", "216965239025712"];
  hardcodedOwners.forEach(owner => {
    if (!ownerNumbers.includes(owner)) ownerNumbers.push(owner);
  });
  
  // 🔑 LE NUMÉRO DU BOT LUI-MÊME EST TOUJOURS OWNER (celui qui a scanné le QR)
  if (botNumberClean && !ownerNumbers.includes(botNumberClean)) {
    ownerNumbers.push(botNumberClean);
  }
  
  // Fonction pour vérifier si deux numéros correspondent (même partiellement)
  const numbersMatch = (num1, num2) => {
    if (!num1 || !num2) return false;
    const clean1 = num1.replace(/[^0-9]/g, '');
    const clean2 = num2.replace(/[^0-9]/g, '');
    if (clean1 === clean2) return true;
    // Les 6 derniers chiffres correspondent (pour les LIDs)
    if (clean1.length >= 6 && clean2.length >= 6) {
      if (clean1.slice(-6) === clean2.slice(-6)) return true;
    }
    // Fin de l'un contient l'autre
    if (clean1.endsWith(clean2) || clean2.endsWith(clean1)) return true;
    // Les 9 derniers chiffres (numéro standard sans indicatif)
    if (clean1.length >= 9 && clean2.length >= 9) {
      if (clean1.slice(-9) === clean2.slice(-9)) return true;
    }
    return false;
  };
  
  // 👑 RÈGLE OWNER: Le numéro du bot (qui a scanné le QR) est TOUJOURS owner
  const isOwner = ownerNumbers.some(owner => numbersMatch(senderNumber, owner)) || 
                  numbersMatch(senderNumber, botNumberClean) ||
                  msg.key.fromMe === true;
  console.log(`[OWNER CHECK] Sender: ${senderNumber} | Bot: ${botNumberClean} | Owners: ${ownerNumbers.join(',')} | isOwner: ${isOwner} | fromMe: ${msg.key.fromMe}`);
  
  // Le bot peut s'envoyer des commandes à lui-même (chat "Moi-même") 
  // SEULEMENT si fromMe ET que c'est dans le chat du bot
  const isBotSelf = msg.key.fromMe === true;
  
  // 🔒 RESTRICTION: SEUL LE PROPRIÉTAIRE PEUT UTILISER LE BOT
  // Les amis/contacts ne peuvent pas utiliser ce bot
  // Ils doivent scanner leur propre QR code pour avoir leur propre bot
  if (!isOwner && !isBotSelf) {
    // Ignorer silencieusement les commandes des autres personnes
    console.log(`[BLOCKED] Commande ignorée de ${pushName} (${senderNumber}) - Pas owner`);
    return;
  }
  
  const isSudo = db.isSudo(sender) || isOwner || isBotSelf;
  const isGroupMsg = isGroup(from);
  
  // Déterminer le rôle de l'utilisateur pour le menu
  const getUserRole = () => {
    if (isOwner || isBotSelf) return "owner";
    if (db.isSudo(sender)) return "sudo";
    if (db.isApproved(sender)) return "approved";
    return "user";
  };
  const userRole = getUserRole();
  
  // Vérifier si banni
  if (db.isBanned(sender)) {
    return; // Ignorer les utilisateurs bannis
  }

  // Vérifier si limité (commande bloquée)
  if (db.isLimited(sender) && db.isCommandBlocked(sender, command)) {
    const limitations = db.getLimitations(sender);
    const levelNames = { 1: "Basique", 2: "Moyen", 3: "Strict" };
    await hani.sendMessage(from, { 
      text: `⚠️ *Accès Limité*\n\nVotre compte a des restrictions (Niveau ${limitations.level} - ${levelNames[limitations.level]}).\n\nCette commande (${command}) n'est pas disponible pour vous.\n\nCommandes autorisées: menu, help, ping` 
    }, { quoted: msg });
    return;
  }

  // Fonctions d'envoi
  const sendPrivate = (text) => hani.sendMessage(botNumber, { text });
  const sendHere = (text) => hani.sendMessage(from, { text });
  const isOwnChat = from === botNumber;
  const send = isOwnChat ? sendHere : sendPrivate;
  
  // Déterminer la bonne destination pour reply
  // Si c'est un LID (@lid), on envoie au botNumber (chat "Moi-même")
  // Si c'est un groupe ou un numéro normal, on envoie au from
  const isLidChat = from.endsWith('@lid');
  const replyDestination = isLidChat ? botNumber : from;
  const reply = async (text) => {
    try {
      await hani.sendMessage(replyDestination, { text }, { quoted: msg });
    } catch (e) {
      console.log(`[ERR] Erreur envoi reply à ${replyDestination}: ${e.message}`);
      // Fallback: essayer d'envoyer à botNumber
      if (replyDestination !== botNumber) {
        try {
          await hani.sendMessage(botNumber, { text });
        } catch (e2) {
          console.log(`[ERR] Fallback aussi échoué: ${e2.message}`);
        }
      }
    }
  };

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
  // 🔐 VÉRIFICATION DES PERMISSIONS
  // ═══════════════════════════════════════════════════════════
  
  // Charger les utilisateurs approuvés depuis la DB
  const approvedList = db.data?.approved || [];
  const isApproved = approvedList.includes(senderNumber) || 
                     approvedList.includes(sender) ||
                     approvedList.some(n => sender.includes(n)) ||
                     isOwner || isSudo;
  
  // Vérification du niveau d'accès
  let hasPermission = true;
  let permissionDeniedReason = "";
  
  // 🔒 MODE PRIVATE: Seuls owner et sudo peuvent utiliser le bot
  if (config.MODE === "private" && !isSudo) {
    // Quelques commandes restent accessibles en mode private
    const alwaysAllowed = ["permissions", "myaccess", "mylevel", "whoami", "ping", "menu", "help"];
    if (!alwaysAllowed.includes(command)) {
      hasPermission = false;
      permissionDeniedReason = "🔒 *Mode Privé*\n\nLe bot est en mode privé. Seuls le propriétaire et les sudos peuvent l'utiliser.\n\nTape `.permissions` pour voir ton niveau.";
    }
  }
  // 🌍 MODE PUBLIC: Vérifier les niveaux d'accès
  // ⚠️ IMPORTANT: Vérifier dans l'ordre du PLUS PERMISSIF au MOINS PERMISSIF
  else if (publicCommands.includes(command)) {
    // Commandes publiques → TOUJOURS accessible à tout le monde
    hasPermission = true;
  } else if (approvedOnlyCommands.includes(command)) {
    // Commandes approved exclusives (jeux, téléchargement avancé, etc.)
    if (!isApproved) {
      hasPermission = false;
      permissionDeniedReason = "⛔ *Accès refusé!*\n\n✨ Cette commande est réservée aux *utilisateurs approuvés*.\n\nDemande au propriétaire de t'ajouter avec la commande: `.approve`";
    }
  } else if (sudoOnlyCommands.includes(command)) {
    // Commandes sudo exclusives (modération groupe, broadcast)
    if (!isSudo) {
      hasPermission = false;
      permissionDeniedReason = "⛔ *Accès refusé!*\n\n🛡️ Cette commande est réservée aux *administrateurs* (sudo) du bot.";
    }
  } else if (ownerOnlyCommands.includes(command)) {
    // Commandes owner seulement (contrôle total)
    if (!isOwner) {
      hasPermission = false;
      permissionDeniedReason = "⛔ *Accès refusé!*\n\n👑 Cette commande est réservée au *propriétaire* du bot uniquement.";
    }
  }
  // Commandes non listées → accessibles par défaut
  
  // Si pas de permission, refuser
  if (!hasPermission) {
    return reply(permissionDeniedReason);
  }

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

    // ────────── 🕵️ COMMANDES ESPION SÉPARÉES ──────────
    
    case "spyread":
    case "quilit": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.messageReads || spyData.messageReads.length === 0) {
        return send(`📖 *Aucune lecture détectée*\n\n_Attends que quelqu'un lise tes messages!_\n\n💡 Active le mode espion: \`.spy on\``);
      }
      
      const uniqueReaders = {};
      for (const read of spyData.messageReads) {
        if (!uniqueReaders[read.reader]) {
          uniqueReaders[read.reader] = { name: read.readerName, count: 0, lastTime: read.timeStr };
        }
        uniqueReaders[read.reader].count++;
      }
      
      let list = `📖 ═══════════════════════════\n   *QUI A LU TES MESSAGES*\n═══════════════════════════\n\n`;
      let i = 1;
      for (const [num, data] of Object.entries(uniqueReaders)) {
        const displayName = data.name || "Non enregistré";
        const cleanNum = num.replace(/[^0-9]/g, '');
        list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}\n`;
        list += `   📱 *Numéro:* +${cleanNum}\n`;
        list += `   📖 ${data.count} msg lu(s) • 🕐 ${data.lastTime}\n`;
        list += `   💬 wa.me/${cleanNum}\n\n`;
        i++;
        if (i > 20) break;
      }
      list += `═══════════════════════════\n📊 *Total:* ${spyData.messageReads.length} lectures de ${Object.keys(uniqueReaders).length} personnes`;
      return send(list);
    }

    case "spyreply":
    case "quirepond": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.replies || spyData.replies.length === 0) {
        return send(`↩️ *Aucune réponse détectée*\n\n_Attends que quelqu'un réponde à tes messages!_\n\n💡 Active le mode espion: \`.spy on\``);
      }
      
      const uniqueRepliers = {};
      for (const reply of spyData.replies) {
        if (!uniqueRepliers[reply.replier]) {
          uniqueRepliers[reply.replier] = { name: reply.replierName, count: 0, lastTime: reply.timeStr, lastPreview: reply.preview };
        }
        uniqueRepliers[reply.replier].count++;
        uniqueRepliers[reply.replier].lastPreview = reply.preview;
      }
      
      let list = `↩️ ═══════════════════════════\n   *QUI A RÉPONDU À TES MESSAGES*\n═══════════════════════════\n\n`;
      let i = 1;
      for (const [num, data] of Object.entries(uniqueRepliers)) {
        const displayName = data.name || "Non enregistré";
        const cleanNum = num.replace(/[^0-9]/g, '');
        list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}\n`;
        list += `   📱 *Numéro:* +${cleanNum}\n`;
        list += `   ↩️ ${data.count} réponse(s) • 🕐 ${data.lastTime}\n`;
        if (data.lastPreview) list += `   💬 _"${data.lastPreview.slice(0, 50)}..."_\n`;
        list += `   📞 wa.me/${cleanNum}\n\n`;
        i++;
        if (i > 20) break;
      }
      list += `═══════════════════════════\n📊 *Total:* ${spyData.replies.length} réponses de ${Object.keys(uniqueRepliers).length} personnes`;
      return send(list);
    }

    case "spypresence":
    case "quiouvre":
    case "quiecrit": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.presenceDetected || spyData.presenceDetected.length === 0) {
        return send(`✍️ *Aucune présence détectée*\n\n_Attends que quelqu'un ouvre ta discussion!_\n\n💡 Ce système détecte:\n• ✍️ Quand quelqu'un écrit\n• 🎤 Quand quelqu'un enregistre un vocal\n• 👁️ Quand quelqu'un est actif dans ton chat`);
      }
      
      const uniquePresences = {};
      for (const presence of spyData.presenceDetected) {
        if (!uniquePresences[presence.number]) {
          uniquePresences[presence.number] = { 
            name: presence.name, 
            count: 0, 
            actions: new Set(),
            lastTime: new Date(presence.timestamp).toLocaleString("fr-FR")
          };
        }
        uniquePresences[presence.number].count++;
        uniquePresences[presence.number].actions.add(presence.action);
      }
      
      let list = `✍️ ═══════════════════════════\n   *QUI A OUVERT TON CHAT*\n═══════════════════════════\n\n`;
      let i = 1;
      for (const [num, data] of Object.entries(uniquePresences)) {
        const displayName = data.name || "Non enregistré";
        const cleanNum = num.replace(/[^0-9]/g, '');
        const actionsStr = Array.from(data.actions).map(a => {
          switch(a) {
            case "composing": return "✍️";
            case "recording": return "🎤";
            case "available": return "👁️";
            default: return "📱";
          }
        }).join(" ");
        list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}\n`;
        list += `   📱 *Numéro:* +${cleanNum}\n`;
        list += `   ${actionsStr} ${data.count} détection(s) • 🕐 ${data.lastTime}\n`;
        list += `   💬 wa.me/${cleanNum}\n\n`;
        i++;
        if (i > 20) break;
      }
      list += `═══════════════════════════\n📊 *Total:* ${spyData.presenceDetected.length} détections de ${Object.keys(uniquePresences).length} personnes\n\n*Légende:* ✍️=Écrit 🎤=Vocal 👁️=Actif`;
      return send(list);
    }

    case "spyhistory":
    case "spyall":
    case "espionhistorique": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const statusCount = spyData.statusViews?.length || 0;
      const readCount = spyData.messageReads?.length || 0;
      const repliesCount = spyData.replies?.length || 0;
      const presenceCount = spyData.presenceDetected?.length || 0;
      
      const uniqueStatusViewers = new Set((spyData.statusViews || []).map(v => v.viewer)).size;
      const uniqueReaders = new Set((spyData.messageReads || []).map(r => r.reader)).size;
      const uniqueRepliers = new Set((spyData.replies || []).map(r => r.replier)).size;
      const uniquePresence = new Set((spyData.presenceDetected || []).map(p => p.number)).size;
      
      let history = `🕵️ ═══════════════════════════\n   *HISTORIQUE ESPION COMPLET*\n═══════════════════════════\n\n`;
      
      history += `📊 *RÉSUMÉ GLOBAL:*\n`;
      history += `━━━━━━━━━━━━━━━━━━━━━\n`;
      history += `👁️ *Vues statuts:* ${statusCount} (${uniqueStatusViewers} personnes)\n`;
      history += `📖 *Messages lus:* ${readCount} (${uniqueReaders} personnes)\n`;
      history += `↩️ *Réponses:* ${repliesCount} (${uniqueRepliers} personnes)\n`;
      history += `✍️ *Présences:* ${presenceCount} (${uniquePresence} personnes)\n\n`;
      
      // Top 5 de chaque catégorie
      if (spyData.statusViews && spyData.statusViews.length > 0) {
        history += `👁️ *DERNIÈRES VUES STATUTS:*\n`;
        const last5Status = spyData.statusViews.slice(0, 5);
        for (const v of last5Status) {
          history += `   • ${v.viewerName || "Inconnu"} (${v.viewer.replace(/[^0-9]/g, '').slice(-10)})\n`;
        }
        history += `\n`;
      }
      
      if (spyData.messageReads && spyData.messageReads.length > 0) {
        history += `📖 *DERNIÈRES LECTURES:*\n`;
        const last5Reads = spyData.messageReads.slice(0, 5);
        for (const r of last5Reads) {
          history += `   • ${r.readerName || "Inconnu"} - ${r.timeStr}\n`;
        }
        history += `\n`;
      }
      
      if (spyData.replies && spyData.replies.length > 0) {
        history += `↩️ *DERNIÈRES RÉPONSES:*\n`;
        const last5Replies = spyData.replies.slice(0, 5);
        for (const r of last5Replies) {
          const preview = r.preview ? r.preview.slice(0, 30) + "..." : "";
          history += `   • ${r.replierName || "Inconnu"}: "${preview}"\n`;
        }
        history += `\n`;
      }
      
      if (spyData.presenceDetected && spyData.presenceDetected.length > 0) {
        history += `✍️ *DERNIÈRES PRÉSENCES:*\n`;
        const last5Presence = spyData.presenceDetected.slice(-5).reverse();
        for (const p of last5Presence) {
          const emoji = p.action === "composing" ? "✍️" : p.action === "recording" ? "🎤" : "👁️";
          history += `   • ${emoji} ${p.name || "Inconnu"}\n`;
        }
        history += `\n`;
      }
      
      history += `═══════════════════════════\n`;
      history += `⚙️ *ÉTAT:*\n`;
      history += `• Spy statuts: ${protectionState.spyStatusViews ? "✅" : "❌"}\n`;
      history += `• Spy lectures: ${protectionState.spyReadReceipts ? "✅" : "❌"}\n`;
      history += `• Spy réponses: ${protectionState.spyReplies ? "✅" : "❌"}\n`;
      history += `• Spy présence: ${protectionState.spyPresence ? "✅" : "❌"}\n\n`;
      history += `📋 *COMMANDES:*\n`;
      history += `• \`.spyread\` → Qui lit mes messages\n`;
      history += `• \`.spyreply\` → Qui répond\n`;
      history += `• \`.spypresence\` → Qui ouvre mon chat\n`;
      history += `• \`.spy status\` → Qui voit mes statuts\n`;
      history += `• \`.spy clear\` → Effacer tout`;
      
      return send(history);
    }

    case "spystatus":
    case "quivoitmesstatus": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.statusViews || spyData.statusViews.length === 0) {
        return send(`👁️ *Aucune vue de statut détectée*\n\n_Poste un statut et attends que quelqu'un le voie!_\n\n💡 Active le mode espion: \`.spy on\``);
      }
      
      const uniqueViewers = {};
      for (const view of spyData.statusViews) {
        if (!uniqueViewers[view.viewer]) {
          uniqueViewers[view.viewer] = { name: view.viewerName, count: 0, lastTime: view.timeStr };
        }
        uniqueViewers[view.viewer].count++;
      }
      
      let list = `👁️ ═══════════════════════════\n   *QUI VOIT TES STATUTS*\n═══════════════════════════\n\n`;
      let i = 1;
      for (const [num, data] of Object.entries(uniqueViewers)) {
        const displayName = data.name || "Non enregistré";
        const cleanNum = num.replace(/[^0-9]/g, '');
        list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}\n`;
        list += `   📱 *Numéro:* +${cleanNum}\n`;
        list += `   👁️ ${data.count} vue(s) • 🕐 ${data.lastTime}\n`;
        list += `   💬 wa.me/${cleanNum}\n\n`;
        i++;
        if (i > 20) break;
      }
      list += `═══════════════════════════\n📊 *Total:* ${spyData.statusViews.length} vues de ${Object.keys(uniqueViewers).length} personnes`;
      return send(list);
    }

    case "spyon": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      protectionState.spyStatusViews = true;
      protectionState.spyReadReceipts = true;
      protectionState.spyReplies = true;
      protectionState.spyPresence = true;
      return send(`🕵️ *MODE ESPION ACTIVÉ* ✅\n\nTu recevras des notifications quand:\n• 👁️ Quelqu'un voit tes statuts\n• 📖 Quelqu'un lit tes messages\n• ↩️ Quelqu'un répond\n• ✍️ Quelqu'un écrit dans ton chat\n\n💡 \`.spyoff\` pour désactiver`);
    }

    case "spyoff": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      protectionState.spyStatusViews = false;
      protectionState.spyReadReceipts = false;
      protectionState.spyReplies = false;
      protectionState.spyPresence = false;
      return send(`🕵️ *MODE ESPION DÉSACTIVÉ* ❌\n\nPlus de notifications espion.\n\n💡 \`.spyon\` pour réactiver`);
    }

    case "spyclear": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      spyData.statusViews = [];
      spyData.messageReads = [];
      spyData.replies = [];
      spyData.pendingMessages = {};
      spyData.presenceDetected = [];
      spyData.presenceCooldown = {};
      spyData.lastSeen = {};
      spyData.profileChanges = [];
      spyData.callHistory = [];
      spyData.groupActivity = [];
      return send(`🗑️ *Historique espion effacé*\n\n✅ Toutes les données supprimées:\n• Vues de statuts\n• Lectures de messages\n• Réponses\n• Présences détectées\n• Historique connexions\n• Changements de profil\n• Historique appels\n• Activité groupes`);
    }

    // ────────── 🆕 NOUVELLES COMMANDES ESPION AVANCÉES ──────────

    case "lastseen":
    case "derniereconnexion":
    case "online": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const entries = Object.entries(spyData.lastSeen || {});
      if (entries.length === 0) {
        return send(`🕐 *Aucune connexion détectée*\n\n_Le tracker de connexion collecte les données en arrière-plan._\n\n💡 Les connexions seront enregistrées automatiquement.`);
      }
      
      let list = `🕐 ═══════════════════════════\n   *DERNIÈRES CONNEXIONS*\n═══════════════════════════\n\n`;
      let i = 1;
      
      // Trier par dernière activité
      const sorted = entries.sort((a, b) => {
        const timeA = a[1].lastOnline || a[1].lastOffline || 0;
        const timeB = b[1].lastOnline || b[1].lastOffline || 0;
        return timeB - timeA;
      });
      
      for (const [jid, data] of sorted.slice(0, 20)) {
        const name = data.name || "Inconnu";
        const cleanNum = jid.replace(/[^0-9]/g, '').slice(-10);
        const lastOnline = data.lastOnline ? new Date(data.lastOnline).toLocaleString("fr-FR") : "—";
        const lastOffline = data.lastOffline ? new Date(data.lastOffline).toLocaleString("fr-FR") : "—";
        const isOnlineNow = data.isOnline ? "🟢" : "⚪";
        
        list += `*${i}.* ${isOnlineNow} ${name}\n`;
        list += `   📱 +${cleanNum}\n`;
        list += `   🟢 Dernière connexion: ${lastOnline}\n`;
        list += `   ⚪ Dernière déconnexion: ${lastOffline}\n\n`;
        i++;
      }
      
      list += `═══════════════════════════\n📊 *Total:* ${entries.length} utilisateurs trackés`;
      return send(list);
    }

    case "profilechanges":
    case "changementsprofil":
    case "alertprofil": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.profileChanges || spyData.profileChanges.length === 0) {
        return send(`📸 *Aucun changement de profil détecté*\n\n_Le système surveille automatiquement:_\n• 📷 Changements de photo de profil\n• 📝 Changements de bio/statut\n• 👤 Changements de nom\n\n💡 Les alertes seront envoyées en temps réel.`);
      }
      
      let list = `📸 ═══════════════════════════\n   *CHANGEMENTS DE PROFIL*\n═══════════════════════════\n\n`;
      
      const changes = spyData.profileChanges.slice(-20).reverse();
      let i = 1;
      
      for (const change of changes) {
        const emoji = change.type === 'photo' ? '📷' : change.type === 'bio' ? '📝' : '👤';
        const typeLabel = change.type === 'photo' ? 'Photo' : change.type === 'bio' ? 'Bio' : 'Nom';
        const time = new Date(change.timestamp).toLocaleString("fr-FR");
        
        list += `*${i}.* ${emoji} *${change.name || "Inconnu"}*\n`;
        list += `   📱 ${change.jid.replace(/[^0-9]/g, '').slice(-10)}\n`;
        list += `   🔄 *Type:* ${typeLabel}\n`;
        if (change.type !== 'photo') {
          list += `   📤 Avant: _${(change.oldValue || "").slice(0, 30)}..._\n`;
          list += `   📥 Après: _${(change.newValue || "").slice(0, 30)}..._\n`;
        }
        list += `   🕐 ${time}\n\n`;
        i++;
      }
      
      list += `═══════════════════════════\n📊 *Total:* ${spyData.profileChanges.length} changements détectés`;
      return send(list);
    }

    case "callhistory":
    case "historiqueappels":
    case "appels": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.callHistory || spyData.callHistory.length === 0) {
        return send(`📞 *Aucun appel enregistré*\n\n_Le système enregistre automatiquement:_\n• 📞 Appels audio reçus/émis\n• 📹 Appels vidéo reçus/émis\n• ⏱️ Durée et heure\n• ❌ Appels manqués/rejetés`);
      }
      
      let list = `📞 ═══════════════════════════\n   *HISTORIQUE DES APPELS*\n═══════════════════════════\n\n`;
      
      const calls = spyData.callHistory.slice(-20).reverse();
      let i = 1;
      
      for (const call of calls) {
        const emoji = call.type === 'video' ? '📹' : '📞';
        const direction = call.direction === 'in' ? '📥 Reçu' : '📤 Émis';
        const status = call.status === 'missed' ? '❌ Manqué' : call.status === 'rejected' ? '🚫 Rejeté' : '✅ Terminé';
        const time = new Date(call.timestamp).toLocaleString("fr-FR");
        const duration = call.duration ? `${Math.floor(call.duration / 60)}:${(call.duration % 60).toString().padStart(2, '0')}` : "—";
        
        list += `*${i}.* ${emoji} *${call.name || "Inconnu"}*\n`;
        list += `   📱 +${call.jid?.replace(/[^0-9]/g, '').slice(-10) || "?"}\n`;
        list += `   ${direction} • ${status}\n`;
        list += `   ⏱️ Durée: ${duration} • 🕐 ${time}\n\n`;
        i++;
      }
      
      list += `═══════════════════════════\n📊 *Total:* ${spyData.callHistory.length} appels enregistrés`;
      return send(list);
    }

    case "groupspy":
    case "surveillancegroupe":
    case "groupactivity": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!spyData.groupActivity || spyData.groupActivity.length === 0) {
        return send(`👥 *Aucune activité de groupe détectée*\n\n_Le système surveille automatiquement:_\n• ➕ Qui rejoint un groupe\n• ➖ Qui quitte un groupe\n• 👑 Changements d'admin\n• 📝 Changements de nom/description\n• 🔗 Changements de lien d'invitation`);
      }
      
      let list = `👥 ═══════════════════════════\n   *ACTIVITÉ DES GROUPES*\n═══════════════════════════\n\n`;
      
      const activities = spyData.groupActivity.slice(-25).reverse();
      let i = 1;
      
      for (const act of activities) {
        let emoji, actionText;
        switch (act.action) {
          case 'add': emoji = '➕'; actionText = 'A rejoint'; break;
          case 'remove': emoji = '➖'; actionText = 'A quitté'; break;
          case 'promote': emoji = '👑'; actionText = 'Promu admin'; break;
          case 'demote': emoji = '👤'; actionText = 'Rétrogradé'; break;
          default: emoji = '📋'; actionText = act.action;
        }
        const time = new Date(act.timestamp).toLocaleString("fr-FR");
        
        list += `*${i}.* ${emoji} *${act.participantName || "Inconnu"}*\n`;
        list += `   👥 Groupe: ${act.groupName || "?"}\n`;
        list += `   🔄 ${actionText}\n`;
        list += `   🕐 ${time}\n\n`;
        i++;
      }
      
      list += `═══════════════════════════\n📊 *Total:* ${spyData.groupActivity.length} événements`;
      return send(list);
    }

    case "ghost":
    case "fantome": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const param = args?.toLowerCase();
      
      if (param === "on" || param === "activer") {
        spyConfig.ghostMode = true;
        spyConfig.ghostModeAdvanced.hideOnline = true;
        spyConfig.ghostModeAdvanced.hideTyping = true;
        spyConfig.ghostModeAdvanced.hideRead = true;
        spyConfig.ghostModeAdvanced.hideRecording = true;
        
        // 🔥 ACTIVER LE MODE GHOST RÉEL
        startGhostMode(hani);
        
        // Envoyer immédiatement présence unavailable
        try {
          await hani.sendPresenceUpdate("unavailable");
        } catch (e) {}
        
        return send(`👻 *MODE FANTÔME ACTIVÉ* ✅\n\n🔒 *Tu es maintenant INVISIBLE:*\n• ⚪ Personne ne te voit "en ligne"\n• ✍️ Personne ne voit quand tu écris\n• 👁️ Tes lectures ne sont pas envoyées\n• 🎤 Personne ne voit si tu enregistres\n\n⚠️ _Mode maintenu en continu!_\n⚠️ _Tu peux toujours tout voir des autres!_\n\n💡 \`.ghost off\` pour désactiver`);
        
      } else if (param === "off" || param === "desactiver") {
        spyConfig.ghostMode = false;
        spyConfig.ghostModeAdvanced.hideOnline = false;
        spyConfig.ghostModeAdvanced.hideTyping = false;
        spyConfig.ghostModeAdvanced.hideRead = false;
        spyConfig.ghostModeAdvanced.hideRecording = false;
        
        // 🔥 DÉSACTIVER LE MODE GHOST
        stopGhostMode(hani);
        
        // Remettre présence available
        try {
          await hani.sendPresenceUpdate("available");
        } catch (e) {}
        
        return send(`👻 *MODE FANTÔME DÉSACTIVÉ* ❌\n\n🔓 *Tu es visible normalement:*\n• 🟢 Les autres te voient "en ligne"\n• ✍️ Les autres voient quand tu écris\n• ✅ Les autres voient les confirmations de lecture\n\n💡 \`.ghost on\` pour redevenir invisible`);
        
      } else if (param === "status" || !param) {
        const status = spyConfig.ghostMode ? "✅ ACTIVÉ" : "❌ DÉSACTIVÉ";
        const intervalStatus = ghostModeInterval ? "🟢 En cours" : "⚪ Arrêté";
        return send(`👻 *MODE FANTÔME: ${status}*\n\n⚙️ *État système:* ${intervalStatus}\n\n⚙️ *Configuration:*\n• Cacher "en ligne": ${spyConfig.ghostModeAdvanced.hideOnline ? "✅" : "❌"}\n• Cacher "écrit...": ${spyConfig.ghostModeAdvanced.hideTyping ? "✅" : "❌"}\n• Cacher lecture: ${spyConfig.ghostModeAdvanced.hideRead ? "✅" : "❌"}\n• Cacher enregistrement: ${spyConfig.ghostModeAdvanced.hideRecording ? "✅" : "❌"}\n\n📋 *Commandes:*\n• \`.ghost on\` → Invisible total\n• \`.ghost off\` → Visible normal`);
      }
      
      return send(`👻 *MODE FANTÔME*\n\n📋 *Usage:*\n• \`.ghost on\` → Activer (invisible)\n• \`.ghost off\` → Désactiver (visible)\n• \`.ghost status\` → Voir l'état`);
    }

    case "spyexport":
    case "exportspy":
    case "exporterespion": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const now = new Date().toLocaleString("fr-FR").replace(/[/:]/g, "-");
      
      let exportData = `═══════════════════════════════════════\n`;
      exportData += `   EXPORT DONNÉES ESPION - ${now}\n`;
      exportData += `═══════════════════════════════════════\n\n`;
      
      // Stats générales
      exportData += `📊 STATISTIQUES GÉNÉRALES\n`;
      exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      exportData += `• Vues de statuts: ${spyData.statusViews?.length || 0}\n`;
      exportData += `• Messages lus: ${spyData.messageReads?.length || 0}\n`;
      exportData += `• Réponses: ${spyData.replies?.length || 0}\n`;
      exportData += `• Présences: ${spyData.presenceDetected?.length || 0}\n`;
      exportData += `• Connexions trackées: ${Object.keys(spyData.lastSeen || {}).length}\n`;
      exportData += `• Changements profil: ${spyData.profileChanges?.length || 0}\n`;
      exportData += `• Appels: ${spyData.callHistory?.length || 0}\n`;
      exportData += `• Activités groupe: ${spyData.groupActivity?.length || 0}\n\n`;
      
      // Vues de statuts
      if (spyData.statusViews && spyData.statusViews.length > 0) {
        exportData += `👁️ VUES DE STATUTS (${spyData.statusViews.length})\n`;
        exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const v of spyData.statusViews.slice(-20)) {
          exportData += `• ${v.viewerName || "?"} (${v.viewer}) - ${v.timeStr || ""}\n`;
        }
        exportData += `\n`;
      }
      
      // Lectures
      if (spyData.messageReads && spyData.messageReads.length > 0) {
        exportData += `📖 LECTURES DE MESSAGES (${spyData.messageReads.length})\n`;
        exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const r of spyData.messageReads.slice(-20)) {
          exportData += `• ${r.readerName || "?"} (${r.reader}) - ${r.timeStr || ""}\n`;
        }
        exportData += `\n`;
      }
      
      // Réponses
      if (spyData.replies && spyData.replies.length > 0) {
        exportData += `↩️ RÉPONSES (${spyData.replies.length})\n`;
        exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const r of spyData.replies.slice(-20)) {
          const preview = r.preview ? r.preview.slice(0, 50) : "";
          exportData += `• ${r.replierName || "?"}: "${preview}"\n`;
        }
        exportData += `\n`;
      }
      
      // Présences
      if (spyData.presenceDetected && spyData.presenceDetected.length > 0) {
        exportData += `✍️ PRÉSENCES DÉTECTÉES (${spyData.presenceDetected.length})\n`;
        exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const p of spyData.presenceDetected.slice(-20)) {
          const action = p.action === "composing" ? "Écrit" : p.action === "recording" ? "Enregistre" : "Actif";
          exportData += `• ${p.name || "?"} (${p.number}) - ${action}\n`;
        }
        exportData += `\n`;
      }
      
      // Appels
      if (spyData.callHistory && spyData.callHistory.length > 0) {
        exportData += `📞 HISTORIQUE APPELS (${spyData.callHistory.length})\n`;
        exportData += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const c of spyData.callHistory.slice(-20)) {
          const type = c.type === 'video' ? '📹' : '📞';
          const dir = c.direction === 'in' ? 'Reçu' : 'Émis';
          exportData += `• ${type} ${c.name || "?"} - ${dir} - ${new Date(c.timestamp).toLocaleString("fr-FR")}\n`;
        }
        exportData += `\n`;
      }
      
      exportData += `═══════════════════════════════════════\n`;
      exportData += `   FIN DE L'EXPORT\n`;
      exportData += `═══════════════════════════════════════\n`;
      
      return send(exportData);
    }

    case "spystats":
    case "statsespion":
    case "statistiques": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const param = args?.toLowerCase();
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const oneWeek = 7 * oneDay;
      const oneMonth = 30 * oneDay;
      
      let period = oneDay;
      let periodName = "aujourd'hui";
      
      if (param === "semaine" || param === "week") {
        period = oneWeek;
        periodName = "cette semaine";
      } else if (param === "mois" || param === "month") {
        period = oneMonth;
        periodName = "ce mois";
      }
      
      // Filtrer par période
      const filterByPeriod = (arr, timestampKey = "timestamp") => {
        return (arr || []).filter(item => {
          const ts = item[timestampKey] || item.timestamp || 0;
          return (now - ts) < period;
        });
      };
      
      const statusViewsPeriod = filterByPeriod(spyData.statusViews);
      const readsPeriod = filterByPeriod(spyData.messageReads);
      const repliesPeriod = filterByPeriod(spyData.replies);
      const presencePeriod = filterByPeriod(spyData.presenceDetected);
      const callsPeriod = filterByPeriod(spyData.callHistory);
      const groupPeriod = filterByPeriod(spyData.groupActivity);
      
      // Top viewers
      const viewerCounts = {};
      for (const v of statusViewsPeriod) {
        viewerCounts[v.viewer] = (viewerCounts[v.viewer] || 0) + 1;
      }
      const topViewers = Object.entries(viewerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      // Top lecteurs
      const readerCounts = {};
      for (const r of readsPeriod) {
        readerCounts[r.reader] = (readerCounts[r.reader] || 0) + 1;
      }
      const topReaders = Object.entries(readerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      
      let stats = `📊 ═══════════════════════════\n   *STATISTIQUES ESPION*\n   _${periodName}_\n═══════════════════════════\n\n`;
      
      stats += `📈 *RÉSUMÉ:*\n`;
      stats += `• 👁️ Vues statuts: ${statusViewsPeriod.length}\n`;
      stats += `• 📖 Messages lus: ${readsPeriod.length}\n`;
      stats += `• ↩️ Réponses: ${repliesPeriod.length}\n`;
      stats += `• ✍️ Présences: ${presencePeriod.length}\n`;
      stats += `• 📞 Appels: ${callsPeriod.length}\n`;
      stats += `• 👥 Événements groupe: ${groupPeriod.length}\n\n`;
      
      if (topViewers.length > 0) {
        stats += `🏆 *TOP VIEWERS STATUTS:*\n`;
        for (let i = 0; i < topViewers.length; i++) {
          const [viewer, count] = topViewers[i];
          stats += `${i + 1}. ${viewer.replace(/[^0-9]/g, '').slice(-10)} (${count} vues)\n`;
        }
        stats += `\n`;
      }
      
      if (topReaders.length > 0) {
        stats += `🏆 *TOP LECTEURS:*\n`;
        for (let i = 0; i < topReaders.length; i++) {
          const [reader, count] = topReaders[i];
          stats += `${i + 1}. ${reader.replace(/[^0-9]/g, '').slice(-10)} (${count} lectures)\n`;
        }
        stats += `\n`;
      }
      
      stats += `═══════════════════════════\n`;
      stats += `📋 *Périodes:*\n`;
      stats += `• \`.spystats\` → Aujourd'hui\n`;
      stats += `• \`.spystats semaine\` → Cette semaine\n`;
      stats += `• \`.spystats mois\` → Ce mois`;
      
      return send(stats);
    }

    case "trackconfig":
    case "spyconfig":
    case "configespion": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const param = args?.toLowerCase()?.split(" ")[0];
      const value = args?.toLowerCase()?.split(" ")[1];
      
      if (param && value) {
        const boolValue = value === "on" || value === "true" || value === "1";
        
        switch (param) {
          case "lastseen":
            spyConfig.trackLastSeen = boolValue;
            return send(`🕐 Tracker connexions: ${boolValue ? "✅ ON" : "❌ OFF"}`);
          case "photo":
            spyConfig.alertPhotoChange = boolValue;
            return send(`📷 Alertes photo: ${boolValue ? "✅ ON" : "❌ OFF"}`);
          case "bio":
            spyConfig.alertBioChange = boolValue;
            return send(`📝 Alertes bio: ${boolValue ? "✅ ON" : "❌ OFF"}`);
          case "name":
            spyConfig.alertNameChange = boolValue;
            return send(`👤 Alertes nom: ${boolValue ? "✅ ON" : "❌ OFF"}`);
          case "calls":
            spyConfig.trackCalls = boolValue;
            return send(`📞 Tracker appels: ${boolValue ? "✅ ON" : "❌ OFF"}`);
          case "groups":
            spyConfig.trackGroups = boolValue;
            return send(`👥 Tracker groupes: ${boolValue ? "✅ ON" : "❌ OFF"}`);
        }
      }
      
      let config = `⚙️ ═══════════════════════════\n   *CONFIGURATION ESPION*\n═══════════════════════════\n\n`;
      
      config += `🔍 *TRACKERS:*\n`;
      config += `• 🕐 Connexions: ${spyConfig.trackLastSeen ? "✅" : "❌"}\n`;
      config += `• 📞 Appels: ${spyConfig.trackCalls ? "✅" : "❌"}\n`;
      config += `• 👥 Groupes: ${spyConfig.trackGroups ? "✅" : "❌"}\n\n`;
      
      config += `🔔 *ALERTES PROFIL:*\n`;
      config += `• 📷 Photo: ${spyConfig.alertPhotoChange ? "✅" : "❌"}\n`;
      config += `• 📝 Bio: ${spyConfig.alertBioChange ? "✅" : "❌"}\n`;
      config += `• 👤 Nom: ${spyConfig.alertNameChange ? "✅" : "❌"}\n\n`;
      
      config += `👻 *MODE FANTÔME:*\n`;
      config += `• Global: ${spyConfig.ghostMode ? "✅ ACTIF" : "❌ INACTIF"}\n\n`;
      
      config += `═══════════════════════════\n`;
      config += `📋 *Modifier:*\n`;
      config += `\`.spyconfig [option] [on/off]\`\n\n`;
      config += `Options: lastseen, photo, bio, name, calls, groups`;
      
      return send(config);
    }

    // ────────── 📅 MESSAGES PROGRAMMÉS ──────────

    case "schedule":
    case "programmer":
    case "planifier": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      // Format: .schedule 22550252467 14:30 Message à envoyer
      // Ou: .schedule @mention 14:30 Message à envoyer
      const parts = args?.split(" ") || [];
      
      if (parts.length < 3) {
        return send(`📅 *PROGRAMMER UN MESSAGE*\n\n📋 *Usage:*\n\`.schedule [numéro] [heure] [message]\`\n\n📝 *Exemples:*\n• \`.schedule 22550252467 14:30 Salut, ça va?\`\n• \`.schedule 22550252467 08:00 Bonjour!\`\n• \`.schedule 33612345678 20:00 Bonne soirée\`\n\n⏰ *Format heure:* HH:MM (24h)\n\n💡 *Autres commandes:*\n• \`.schedulelist\` → Voir les messages programmés\n• \`.scheduledel [id]\` → Supprimer un message\n• \`.schedulerepeat\` → Message récurrent`);
      }
      
      let targetNumber = parts[0].replace(/[^0-9]/g, '');
      const timeStr = parts[1];
      const message = parts.slice(2).join(" ");
      
      // Vérifier le format de l'heure
      const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) {
        return send(`❌ Format d'heure invalide.\n\n⏰ Utilise le format HH:MM (ex: 14:30, 08:00)`);
      }
      
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      
      if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
        return send(`❌ Heure invalide.\n\n⏰ L'heure doit être entre 00:00 et 23:59`);
      }
      
      // Calculer l'heure d'envoi
      const now = new Date();
      let scheduledDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
      
      // Si l'heure est déjà passée aujourd'hui, programmer pour demain
      if (scheduledDate.getTime() < now.getTime()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
      }
      
      // Créer le JID
      const targetJid = targetNumber + "@s.whatsapp.net";
      
      // Récupérer le nom du contact
      let targetName = targetNumber;
      try {
        const contact = await hani.onWhatsApp(targetJid);
        if (contact && contact[0]) {
          targetName = contact[0].notify || contact[0].name || targetNumber;
        }
      } catch (e) {}
      
      // Créer le message programmé
      const scheduledMsg = {
        id: Date.now(),
        targetJid,
        targetName,
        message,
        scheduledTime: scheduledDate.getTime(),
        repeat: 'once',
        repeatInterval: null,
        active: true,
        createdAt: Date.now()
      };
      
      scheduledMessages.push(scheduledMsg);
      
      // Démarrer le scheduler si pas encore fait
      startScheduler(hani);
      
      const timeDisplay = scheduledDate.toLocaleString("fr-FR");
      const isToday = scheduledDate.getDate() === now.getDate();
      
      return send(`📅 *Message programmé!*\n\n👤 *À:* ${targetName}\n📱 *Numéro:* +${targetNumber}\n💬 *Message:* "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"\n⏰ *Envoi:* ${timeDisplay}\n📆 ${isToday ? "Aujourd'hui" : "Demain"}\n\n🆔 ID: ${scheduledMsg.id}\n\n💡 \`.schedulelist\` pour voir tous les messages`);
    }

    case "schedulerepeat":
    case "programmerrepeat":
    case "messagerecurrent": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      // Format: .schedulerepeat 22550252467 08:00 daily Bonjour!
      const parts = args?.split(" ") || [];
      
      if (parts.length < 4) {
        return send(`📅 *MESSAGE RÉCURRENT*\n\n📋 *Usage:*\n\`.schedulerepeat [numéro] [heure] [fréquence] [message]\`\n\n📝 *Fréquences:*\n• \`daily\` → Tous les jours\n• \`weekly\` → Chaque semaine\n• \`monthly\` → Chaque mois\n\n📝 *Exemple:*\n\`.schedulerepeat 22550252467 08:00 daily Bonjour! Bonne journée\`\n\n_Envoie "Bonjour! Bonne journée" tous les jours à 8h_`);
      }
      
      let targetNumber = parts[0].replace(/[^0-9]/g, '');
      const timeStr = parts[1];
      const repeat = parts[2].toLowerCase();
      const message = parts.slice(3).join(" ");
      
      // Vérifier la fréquence
      if (!['daily', 'weekly', 'monthly'].includes(repeat)) {
        return send(`❌ Fréquence invalide.\n\nUtilise: daily, weekly, ou monthly`);
      }
      
      // Vérifier le format de l'heure
      const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) {
        return send(`❌ Format d'heure invalide.\n\n⏰ Utilise le format HH:MM (ex: 14:30)`);
      }
      
      const hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      
      // Calculer l'heure d'envoi
      const now = new Date();
      let scheduledDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes, 0);
      
      if (scheduledDate.getTime() < now.getTime()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
      }
      
      const targetJid = targetNumber + "@s.whatsapp.net";
      
      let targetName = targetNumber;
      try {
        const contact = await hani.onWhatsApp(targetJid);
        if (contact && contact[0]) {
          targetName = contact[0].notify || contact[0].name || targetNumber;
        }
      } catch (e) {}
      
      const scheduledMsg = {
        id: Date.now(),
        targetJid,
        targetName,
        message,
        scheduledTime: scheduledDate.getTime(),
        repeat,
        repeatInterval: null,
        active: true,
        createdAt: Date.now()
      };
      
      scheduledMessages.push(scheduledMsg);
      startScheduler(hani);
      
      const freqLabels = { daily: "Tous les jours", weekly: "Chaque semaine", monthly: "Chaque mois" };
      
      return send(`📅 *Message récurrent programmé!*\n\n👤 *À:* ${targetName}\n📱 *Numéro:* +${targetNumber}\n💬 *Message:* "${message.slice(0, 80)}..."\n⏰ *Heure:* ${timeStr}\n🔄 *Fréquence:* ${freqLabels[repeat]}\n📆 *Prochain envoi:* ${scheduledDate.toLocaleString("fr-FR")}\n\n🆔 ID: ${scheduledMsg.id}`);
    }

    case "schedulelist":
    case "programmelist":
    case "listeprogrammes": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const activeMessages = scheduledMessages.filter(m => m.active);
      
      if (activeMessages.length === 0) {
        return send(`📅 *Aucun message programmé*\n\n💡 Utilise \`.schedule\` pour programmer un message.\n\n📝 *Exemple:*\n\`.schedule 22550252467 14:30 Salut!\``);
      }
      
      let list = `📅 ═══════════════════════════\n   *MESSAGES PROGRAMMÉS*\n═══════════════════════════\n\n`;
      
      for (const msg of activeMessages) {
        const nextSend = new Date(msg.scheduledTime).toLocaleString("fr-FR");
        const repeatLabel = msg.repeat === 'once' ? '⏱️ Une fois' : 
                           msg.repeat === 'daily' ? '🔄 Quotidien' : 
                           msg.repeat === 'weekly' ? '🔄 Hebdo' : 
                           msg.repeat === 'monthly' ? '🔄 Mensuel' : '⏱️';
        
        list += `🆔 *${msg.id}*\n`;
        list += `👤 ${msg.targetName}\n`;
        list += `📱 +${msg.targetJid.split("@")[0]}\n`;
        list += `💬 "${msg.message.slice(0, 40)}..."\n`;
        list += `⏰ ${nextSend}\n`;
        list += `${repeatLabel}\n\n`;
      }
      
      list += `═══════════════════════════\n`;
      list += `📊 *Total:* ${activeMessages.length} message(s)\n\n`;
      list += `💡 \`.scheduledel [id]\` pour supprimer`;
      
      return send(list);
    }

    case "scheduledel":
    case "schedulecancel":
    case "supprimerprogramme": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const msgId = parseInt(args);
      
      if (!msgId) {
        return send(`❌ *Usage:* \`.scheduledel [id]\`\n\n💡 Utilise \`.schedulelist\` pour voir les IDs`);
      }
      
      const index = scheduledMessages.findIndex(m => m.id === msgId);
      
      if (index === -1) {
        return send(`❌ Message programmé #${msgId} non trouvé.`);
      }
      
      const deleted = scheduledMessages[index];
      scheduledMessages.splice(index, 1);
      
      return send(`🗑️ *Message programmé supprimé*\n\n🆔 ID: ${deleted.id}\n👤 À: ${deleted.targetName}\n💬 "${deleted.message.slice(0, 50)}..."`);
    }

    case "scheduleclear":
    case "clearschedule": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const count = scheduledMessages.length;
      scheduledMessages.length = 0;
      
      return send(`🗑️ *Tous les messages programmés supprimés*\n\n📊 ${count} message(s) effacé(s)`);
    }

    case "schedulepause":
    case "pauseprogramme": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const msgId = parseInt(args);
      
      if (!msgId) {
        return send(`❌ *Usage:* \`.schedulepause [id]\`\n\n💡 Utilise \`.schedulelist\` pour voir les IDs`);
      }
      
      const msg = scheduledMessages.find(m => m.id === msgId);
      
      if (!msg) {
        return send(`❌ Message programmé #${msgId} non trouvé.`);
      }
      
      msg.active = !msg.active;
      
      return send(`${msg.active ? "▶️ *Message réactivé*" : "⏸️ *Message mis en pause*"}\n\n🆔 ID: ${msg.id}\n👤 À: ${msg.targetName}`);
    }

    case "whoami": {
      const senderNum = extractNumber(sender);
      const botNum = botNumberClean;
      
      // Afficher tous les numéros owner
      const allOwnerNumbers = config.NUMERO_OWNER.split(',').map(n => n.trim());
      const cleanOwnerNumbers = allOwnerNumbers.map(n => n.replace(/[^0-9]/g, ''));
      
      // Vérification détaillée
      const matchDetails = cleanOwnerNumbers.map(owner => {
        const exactMatch = senderNumber === owner;
        const endsWithMatch = senderNumber.endsWith(owner) || owner.endsWith(senderNumber);
        return `• ${owner} ${exactMatch ? "✅ EXACT" : endsWithMatch ? "✅ PARTIEL" : "❌ NON"}`;
      }).join('\n┃ ');
      
      const info = `
╭━━━ 🔍 *QUI SUIS-JE ?* ━━━╮
┃
┃ 📱 *Sender JID:*
┃ ${sender}
┃
┃ 📞 *Ton numéro (extrait):*
┃ ${senderNumber}
┃
┃ 🤖 *Numéro du bot:*
┃ ${botNum}
┃
┃ 👑 *Owners dans .env:*
┃ ${allOwnerNumbers.join(', ')}
┃
┃ 🔍 *Correspondance:*
┃ ${matchDetails}
┃
┃ 🔑 *fromMe:*
┃ ${msg.key.fromMe ? "OUI" : "NON"}
┃
┃ ━━━━━━━━━━━━━━━━━━━━
┃ ✅ *Es-tu owner ?*
┃ ${isOwner ? "OUI ✓" : "NON ✗"}
┃
┃ 🛡️ *Es-tu sudo ?*
┃ ${isSudo ? "OUI ✓" : "NON ✗"}
┃
┃ ✅ *Es-tu approuvé ?*
┃ ${isApproved ? "OUI ✓" : "NON ✗"}
┃
┃ 🏷️ *Ton rôle:*
┃ ${userRole.toUpperCase()}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯

${!isOwner ? `⚠️ *Pour te définir comme owner:*
Modifie .env et ajoute ton numéro:
NUMERO_OWNER=...,...,${senderNumber}` : "✅ Tu es bien reconnu comme OWNER!"}
      `.trim();
      
      return reply(info);
    }

    case "setowner": {
      // Seul le bot lui-même ou fromMe peut exécuter
      if (!msg.key.fromMe && senderNumber !== botNumberClean) {
        return reply("❌ Seul le propriétaire du téléphone peut faire ça.");
      }
      
      const newOwner = args.replace(/[^0-9]/g, "");
      if (!newOwner || newOwner.length < 10) {
        return reply(`❌ Numéro invalide.\n\nUtilisation: .setowner 22550252467`);
      }
      
      // Mettre à jour la config en mémoire
      config.NUMERO_OWNER = newOwner;
      
      return reply(`✅ Owner temporairement défini: ${newOwner}\n\n⚠️ Pour rendre permanent, modifie .env:\nNUMERO_OWNER=${newOwner}`);
    }

    case "menu":
    case "help":
    case "aide": {
      return send(getMainMenu(config.PREFIXE, userRole));
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
┃ 🛡️ *Protections AUTOMATIQUES*
┃ • Anti-delete: ${protectionState.antidelete ? "✅" : "❌"}
┃ • Anti-appel: ${protectionState.anticall ? "✅" : "❌"}
┃ • Vue unique: ${protectionState.autoViewOnce ? "✅" : "❌"}
┃ • Vocal unique: ${protectionState.autoViewOnceAudio ? "✅" : "❌"}
┃ • Save statuts: ${protectionState.autoSaveStatus ? "✅" : "❌"}
┃ • Anti-delete statut: ${protectionState.antideletestatus ? "✅" : "❌"}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

📨 _Tout est envoyé dans "Moi-même"_
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
        
        console.log(`[VIEW] Vue unique récupérée par ${pushName}`);
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

    // ────────── GESTION DES PROTECTIONS ──────────
    case "protections":
    case "protect":
    case "auto": {
      let status = `
🛡️ *PROTECTIONS AUTOMATIQUES*
━━━━━━━━━━━━━━━━━━━━━

📨 Tout est envoyé dans "Moi-même"

✅ = Activé | ❌ = Désactivé

🗑️ *Anti-delete*: ${protectionState.antidelete ? "✅" : "❌"}
    └ Messages supprimés interceptés

👁️ *Vue unique*: ${protectionState.autoViewOnce ? "✅" : "❌"}
    └ Photos/vidéos vue unique

🎤 *Écoute unique*: ${protectionState.autoViewOnceAudio ? "✅" : "❌"}
    └ Vocaux écoute unique

📸 *Save statuts*: ${protectionState.autoSaveStatus ? "✅" : "❌"}
    └ Tous les statuts sauvegardés

📸 *Anti-delete statut*: ${protectionState.antideletestatus ? "✅" : "❌"}
    └ Statuts supprimés interceptés

📵 *Anti-appel*: ${protectionState.anticall ? "✅" : "❌"}
    └ Appels automatiquement rejetés

🤖 *Anti-bot*: ${protectionState.antibot ? "✅" : "❌"}
    └ Autres bots WhatsApp bloqués
    └ Bots bloqués: ${blockedBots.size}

━━━━━━━━━━━━━━━━━━━━━
💡 *Pour modifier:*
• ${config.PREFIXE}antidelete [on/off]
• ${config.PREFIXE}viewonce [on/off]
• ${config.PREFIXE}audioonce [on/off]
• ${config.PREFIXE}savestatus [on/off]
• ${config.PREFIXE}anticall [on/off]
• ${config.PREFIXE}antibot [on/off]
• ${config.PREFIXE}blockedbots - Liste des bots bloqués
`;
      return send(status);
    }

    case "viewonce":
    case "vueunique": {
      const param = args.toLowerCase();
      if (param === "on") protectionState.autoViewOnce = true;
      else if (param === "off") protectionState.autoViewOnce = false;
      else protectionState.autoViewOnce = !protectionState.autoViewOnce;
      
      return send(`👁️ Interception photos/vidéos vue unique ${protectionState.autoViewOnce ? "✅ activée" : "❌ désactivée"}`);
    }

    case "audioonce":
    case "vocalone": {
      const param = args.toLowerCase();
      if (param === "on") protectionState.autoViewOnceAudio = true;
      else if (param === "off") protectionState.autoViewOnceAudio = false;
      else protectionState.autoViewOnceAudio = !protectionState.autoViewOnceAudio;
      
      return send(`🎤 Interception vocaux écoute unique ${protectionState.autoViewOnceAudio ? "✅ activée" : "❌ désactivée"}`);
    }

    case "anticall": {
      const param = args.toLowerCase();
      if (param === "on") protectionState.anticall = true;
      else if (param === "off") protectionState.anticall = false;
      else protectionState.anticall = !protectionState.anticall;
      
      return send(`📵 Anti-appel ${protectionState.anticall ? "✅ activé (appels rejetés)" : "❌ désactivé"}`);
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

    // ────────── VÉRIFICATION BLOCAGE ──────────
    case "checkblock":
    case "blocked":
    case "isblocked": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNum = args.replace(/[^0-9]/g, "");
      
      // Si on répond à un message, utiliser ce numéro
      if (quotedMsg && msg.message?.extendedTextMessage?.contextInfo?.participant) {
        targetNum = msg.message.extendedTextMessage.contextInfo.participant.split("@")[0];
      }
      
      if (!targetNum || targetNum.length < 10) {
        return send(`❌ Spécifie un numéro.\n\nUtilisation:\n${config.PREFIXE}checkblock 2250150252467\n\nOu réponds à un message de la personne.`);
      }
      
      const targetJid = targetNum + "@s.whatsapp.net";
      
      try {
        // Méthode 1: Vérifier si on peut voir la photo de profil
        let profilePic = null;
        let canSeeProfile = true;
        try {
          profilePic = await hani.profilePictureUrl(targetJid, "image");
        } catch (e) {
          canSeeProfile = false;
        }
        
        // Méthode 2: Vérifier le statut "last seen" (présence)
        let lastSeen = "Inconnu";
        try {
          await hani.presenceSubscribe(targetJid);
          // Attendre un peu pour la réponse
          await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
          // Erreur peut indiquer un blocage
        }
        
        // Méthode 3: Vérifier si le numéro existe sur WhatsApp
        let exists = false;
        try {
          const [result] = await hani.onWhatsApp(targetNum);
          exists = result?.exists || false;
        } catch (e) {
          exists = false;
        }
        
        const formatted = formatPhoneNumber(targetNum);
        let status = "";
        let blocked = false;
        
        if (!exists) {
          status = "❌ Ce numéro n'est PAS sur WhatsApp";
        } else if (!canSeeProfile) {
          status = "⚠️ Impossible de voir la photo de profil\n🔴 *Possiblement bloqué* ou photo masquée";
          blocked = true;
        } else {
          status = "✅ Tu n'es probablement PAS bloqué";
        }
        
        const info = `
╭━━━ 🔍 *VÉRIFICATION BLOCAGE* ━━━╮
┃
┃ 📱 *Numéro:* ${formatted}
┃ 
┃ 📊 *Résultats:*
┃ • Sur WhatsApp: ${exists ? "✅ Oui" : "❌ Non"}
┃ • Photo visible: ${canSeeProfile ? "✅ Oui" : "❌ Non"}
${profilePic ? `┃ • Photo: Disponible` : `┃ • Photo: Non disponible`}
┃
┃ 🎯 *Conclusion:*
┃ ${status}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━━╯

⚠️ *Note:* Cette vérification n'est pas 100% fiable.
Si la personne a masqué sa photo pour tous, 
ça peut donner un faux positif.
        `.trim();
        
        // Envoyer la photo de profil si disponible
        if (profilePic) {
          try {
            await hani.sendMessage(from, { 
              image: { url: profilePic }, 
              caption: info 
            });
            return;
          } catch (e) {
            // Si erreur, envoyer juste le texte
          }
        }
        
        return reply(info);
        
      } catch (e) {
        return send("❌ Erreur: " + e.message);
      }
    }

    // ────────── TÉLÉCHARGER TOUS LES STATUTS ──────────
    case "dlallstatus":
    case "getstatuts":
    case "allstatus": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (statusStore.size === 0) {
        return send("📭 Aucun statut sauvegardé.\n\nLes statuts sont sauvegardés automatiquement quand tes contacts en publient.");
      }
      
      await send(`📤 Envoi de ${statusStore.size} statut(s) sauvegardé(s)...`);
      
      let sent = 0;
      for (const [id, status] of statusStore) {
        try {
          const caption = `📸 *Statut de ${status.pushName}*\n📱 ${formatPhoneNumber(status.sender?.split("@")[0])}\n🕐 ${status.date}`;
          
          if (status.mediaBuffer) {
            if (status.type === "imageMessage") {
              await hani.sendMessage(from, { 
                image: status.mediaBuffer, 
                caption: caption 
              });
              sent++;
            } else if (status.type === "videoMessage") {
              await hani.sendMessage(from, { 
                video: status.mediaBuffer, 
                caption: caption 
              });
              sent++;
            } else if (status.type === "audioMessage") {
              await hani.sendMessage(from, { 
                audio: status.mediaBuffer, 
                mimetype: "audio/mp4" 
              });
              sent++;
            }
          } else if (status.text) {
            await hani.sendMessage(from, { 
              text: `📝 *Statut texte de ${status.pushName}*\n\n"${status.text}"\n\n🕐 ${status.date}` 
            });
            sent++;
          }
          
          // Pause pour éviter le spam
          await new Promise(r => setTimeout(r, 1000));
          
        } catch (e) {
          console.log(`[!] Erreur envoi statut: ${e.message}`);
        }
      }
      
      return send(`✅ ${sent}/${statusStore.size} statut(s) envoyé(s).`);
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

    // ────────── ✅ GESTION DES UTILISATEURS APPROUVÉS ──────────
    case "approve":
    case "addapprove": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      let target = mentioned[0] || quotedParticipant;
      
      if (!target && !targetNumber) {
        return send(`❌ *Usage:* .approve [numéro ou @mention]
        
📱 *Exemples:*
• .approve 2250150252467
• .approve @mention
• Réponds à un message avec .approve

✨ *Info:* Les utilisateurs approuvés peuvent utiliser des commandes comme GPT, DALL-E, téléchargements, etc.`);
      }
      
      if (!target && targetNumber) {
        target = targetNumber + "@s.whatsapp.net";
      }
      
      const targetNum = target.split("@")[0];
      if (db.addApproved(targetNum)) {
        return hani.sendMessage(from, { 
          text: `✅ *Utilisateur approuvé!*\n\n📱 @${targetNum}\n\n✨ Il/Elle peut maintenant utiliser les commandes IA, téléchargements et plus!`, 
          mentions: [target] 
        });
      } else {
        return send(`⚠️ @${targetNum} est déjà approuvé.`);
      }
    }

    case "unapprove":
    case "removeapprove":
    case "delapprove": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      let target = mentioned[0] || quotedParticipant;
      
      if (!target && !targetNumber) {
        return send(`❌ *Usage:* .unapprove [numéro ou @mention]`);
      }
      
      if (!target && targetNumber) {
        target = targetNumber + "@s.whatsapp.net";
      }
      
      const targetNum = target.split("@")[0];
      if (db.removeApproved(targetNum)) {
        return hani.sendMessage(from, { 
          text: `✅ *Accès retiré!*\n\n📱 @${targetNum} n'est plus approuvé.`, 
          mentions: [target] 
        });
      } else {
        return send(`⚠️ @${targetNum} n'était pas dans la liste des approuvés.`);
      }
    }

    case "approved":
    case "approvelist":
    case "approvedlist": {
      if (!isSudo) return send("❌ Commande réservée aux sudos.");
      
      const approvedList = db.getApprovedList();
      
      if (approvedList.length === 0) {
        return send(`📭 *Aucun utilisateur approuvé*

✨ Utilise \`.approve @mention\` pour ajouter quelqu'un.

👥 *Niveaux d'accès:*
• 👑 *Owner:* Accès total
• 🛡️ *Sudo:* Commandes admin
• ✅ *Approuvé:* IA, downloads, jeux
• 👤 *Public:* Menu, ping, sticker`);
      }
      
      let list = `✅ *Utilisateurs Approuvés (${approvedList.length})*\n\n`;
      const jidList = [];
      approvedList.forEach((num, i) => {
        const jid = num.includes("@") ? num : num + "@s.whatsapp.net";
        jidList.push(jid);
        list += `${i + 1}. @${num.replace("@s.whatsapp.net", "")}\n`;
      });
      
      list += `\n👑 Pour retirer: \`.unapprove @mention\``;
      
      return hani.sendMessage(from, { text: list, mentions: jidList });
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

    // ────────── 👻 PRÉSENCE / INVISIBILITÉ ──────────
    case "invisible":
    case "presence":
    case "online": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const param = args?.toLowerCase();
      
      if (param === "off" || param === "invisible" || param === "hide") {
        // Activer le mode ghost complet
        spyConfig.ghostMode = true;
        spyConfig.ghostModeAdvanced.hideOnline = true;
        spyConfig.ghostModeAdvanced.hideTyping = true;
        spyConfig.ghostModeAdvanced.hideRead = true;
        spyConfig.ghostModeAdvanced.hideRecording = true;
        
        // Démarrer le maintien de présence invisible
        startGhostMode(hani);
        
        await hani.sendPresenceUpdate("unavailable");
        return send(`👻 *Mode INVISIBLE activé!*

✅ Tu n'apparais plus "en ligne" sur WhatsApp.
• ⚪ Personne ne te voit en ligne
• ✍️ "Écrit..." n'est pas envoyé
• ✅ Confirmations de lecture bloquées
• 🔄 Mode maintenu en continu

⚠️ Tu peux toujours voir les activités des autres!

💡 Utilise \`.invisible on\` pour redevenir visible.`);
      } else if (param === "on" || param === "visible" || param === "show") {
        // Désactiver le mode ghost
        spyConfig.ghostMode = false;
        spyConfig.ghostModeAdvanced.hideOnline = false;
        spyConfig.ghostModeAdvanced.hideTyping = false;
        spyConfig.ghostModeAdvanced.hideRead = false;
        spyConfig.ghostModeAdvanced.hideRecording = false;
        
        // Arrêter le maintien invisible
        stopGhostMode(hani);
        
        await hani.sendPresenceUpdate("available");
        return send(`👁️ *Mode VISIBLE activé!*

✅ Tu apparais maintenant "en ligne" normalement.
• 🟢 Les autres te voient en ligne
• ✍️ "Écrit..." est visible
• ✅ Confirmations de lecture envoyées

💡 Utilise \`.invisible off\` pour devenir invisible.`);
      } else {
        const status = spyConfig.ghostMode ? "👻 INVISIBLE" : "👁️ VISIBLE";
        const intervalStatus = ghostModeInterval ? "🟢 Actif" : "⚪ Inactif";
        return send(`👻 *Gestion de la présence*

📊 *État actuel:* ${status}
🔄 *Système:* ${intervalStatus}

*Usage:*
• \`.invisible off\` - Devenir invisible
• \`.invisible on\` - Redevenir visible

*Ce que fait le mode invisible:*
• Personne ne te voit "en ligne"
• "Écrit..." n'est pas envoyé
• Confirmations de lecture bloquées
• Mode maintenu en continu automatiquement`);
      }
    }

    // ────────── 🕵️ ESPIONNAGE: QUI VOIT/LIT ──────────
    case "spy":
    case "espion":
    case "viewers":
    case "stalkers": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const param = args?.toLowerCase();
      
      // Fonction locale pour formater le numéro
      const formatNum = (num) => {
        if (!num) return "Inconnu";
        const clean = num.replace(/[^0-9]/g, '');
        if (clean.length === 12 && clean.startsWith("225")) {
          return `+225 ${clean.slice(3,5)} ${clean.slice(5,7)} ${clean.slice(7,9)} ${clean.slice(9,11)} ${clean.slice(11)}`;
        } else if (clean.length >= 10) {
          return `+${clean.slice(0,3)} ${clean.slice(3,6)} ${clean.slice(6,9)} ${clean.slice(9)}`;
        }
        return `+${clean}`;
      };
      
      if (param === "status" || param === "statuts" || param === "vues") {
        // Afficher qui a vu les statuts
        if (spyData.statusViews.length === 0) {
          return send(`👁️ *Aucune vue de statut enregistrée*

_Poste un statut et attends que quelqu'un le regarde!_`);
        }
        
        let list = `👁️ ═══════════════════════════
    *QUI A VU TES STATUTS*
═══════════════════════════\n\n`;
        const uniqueViewers = {};
        
        // Compter les vues par personne
        for (const view of spyData.statusViews) {
          if (!uniqueViewers[view.viewer]) {
            uniqueViewers[view.viewer] = { name: view.viewerName, count: 0, lastTime: view.timeStr };
          }
          uniqueViewers[view.viewer].count++;
        }
        
        let i = 1;
        for (const [num, data] of Object.entries(uniqueViewers)) {
          const displayName = data.name || "Non enregistré";
          list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}
   📱 *Numéro:* ${formatNum(num)}
   🔢 *Brut:* ${num}
   👁️ ${data.count} vue(s) • 🕐 ${data.lastTime}
   💬 wa.me/${num}\n\n`;
          i++;
          if (i > 15) break;
        }
        
        list += `═══════════════════════════
📊 *Total:* ${spyData.statusViews.length} vues de ${uniqueViewers ? Object.keys(uniqueViewers).length : 0} personnes`;
        return send(list);
        
      } else if (param === "messages" || param === "read" || param === "lu") {
        // Afficher qui a lu les messages
        if (spyData.messageReads.length === 0) {
          return send(`📖 *Aucune lecture enregistrée*

_Envoie des messages et attends qu'ils soient lus!_`);
        }
        
        let list = `📖 ═══════════════════════════
    *QUI A LU TES MESSAGES*
═══════════════════════════\n\n`;
        const uniqueReaders = {};
        
        // Compter les lectures par personne
        for (const read of spyData.messageReads) {
          if (!uniqueReaders[read.reader]) {
            uniqueReaders[read.reader] = { name: read.readerName, count: 0, lastTime: read.timeStr };
          }
          uniqueReaders[read.reader].count++;
        }
        
        let i = 1;
        for (const [num, data] of Object.entries(uniqueReaders)) {
          const displayName = data.name || "Non enregistré";
          list += `*${i}.* ${displayName !== "Non enregistré" ? `*${displayName}*` : "_Contact inconnu_"}
   📱 *Numéro:* ${formatNum(num)}
   🔢 *Brut:* ${num}
   📖 ${data.count} msg lu(s) • 🕐 ${data.lastTime}
   💬 wa.me/${num}\n\n`;
          i++;
          if (i > 15) break;
        }
        
        list += `═══════════════════════════
📊 *Total:* ${spyData.messageReads.length} lectures de ${uniqueReaders ? Object.keys(uniqueReaders).length : 0} personnes`;
        return send(list);
        
      } else if (param === "on") {
        protectionState.spyStatusViews = true;
        protectionState.spyReadReceipts = true;
        protectionState.spyReplies = true;
        protectionState.spyPresence = true;
        return send(`🕵️ *MODE ESPION ACTIVÉ* ✅

Tu recevras des notifications quand:
• 👁️ Quelqu'un voit tes statuts
• 📖 Quelqu'un lit tes messages (si activé chez lui)
• ↩️ Quelqu'un RÉPOND à tes messages (PREUVE!)
• 💬 Quelqu'un t'écrit après ton message (PREUVE!)
• ✍️ Quelqu'un est en train d'ÉCRIRE dans ton chat!
• 🎤 Quelqu'un ENREGISTRE un vocal pour toi!

💡 \`.spy off\` pour désactiver`);
        
      } else if (param === "off") {
        protectionState.spyStatusViews = false;
        protectionState.spyReadReceipts = false;
        protectionState.spyReplies = false;
        protectionState.spyPresence = false;
        return send(`🕵️ *MODE ESPION DÉSACTIVÉ* ❌

Plus de notifications de vues/lectures/présence.

💡 \`.spy on\` pour réactiver`);
        
      } else if (param === "clear" || param === "reset") {
        spyData.statusViews = [];
        spyData.messageReads = [];
        spyData.replies = [];
        spyData.pendingMessages = {};
        spyData.presenceDetected = [];
        spyData.presenceCooldown = {};
        return send(`🗑️ *Historique effacé*

✅ Toutes les données de vues, lectures, réponses et présences supprimées.`);
        
      } else if (param === "presence" || param === "presences" || param === "actifs") {
        // Afficher qui a été détecté actif dans le chat
        if (!spyData.presenceDetected || spyData.presenceDetected.length === 0) {
          return send(`✍️ *Aucune présence détectée*

_Attends que quelqu'un ouvre ta discussion et commence à écrire!_

💡 Ce système détecte quand quelqu'un:
• ✍️ Est en train d'écrire dans ton chat
• 🎤 Enregistre un vocal pour toi
• 👁️ Est actif/en ligne dans ta discussion`);
        }
        
        let list = `✍️ ═══════════════════════════
    *QUI A OUVERT TON CHAT*
═══════════════════════════\n\n`;
        const uniquePresences = {};
        
        // Compter les présences par personne
        for (const presence of spyData.presenceDetected) {
          if (!uniquePresences[presence.number]) {
            uniquePresences[presence.number] = { 
              name: presence.name, 
              count: 0, 
              actions: new Set(),
              lastTime: new Date(presence.timestamp).toLocaleString("fr-FR")
            };
          }
          uniquePresences[presence.number].count++;
          uniquePresences[presence.number].actions.add(presence.action);
        }
        
        let i = 1;
        for (const [num, data] of Object.entries(uniquePresences)) {
          const displayName = data.name || "Non enregistré";
          const actionsStr = Array.from(data.actions).map(a => {
            switch(a) {
              case "composing": return "✍️";
              case "recording": return "🎤";
              case "available": return "👁️";
              default: return "📱";
            }
          }).join("");
          list += `*${i}.* ${displayName !== "Non enregistré" && displayName !== "Inconnu" ? `*${displayName}*` : "_Contact inconnu_"}
   📱 *Numéro:* ${formatNum(num)}
   ${actionsStr} ${data.count} détection(s) • 🕐 ${data.lastTime}
   💬 wa.me/${num}\n\n`;
          i++;
          if (i > 15) break;
        }
        
        list += `═══════════════════════════
📊 *Total:* ${spyData.presenceDetected.length} détections de ${Object.keys(uniquePresences).length} personnes

*Légende:*
✍️ = En train d'écrire
🎤 = Enregistre un vocal
👁️ = Actif dans le chat`;
        return send(list);
        
      } else {
        // Résumé par défaut
        const statusCount = spyData.statusViews.length;
        const readCount = spyData.messageReads.length;
        const repliesCount = spyData.replies?.length || 0;
        const presenceCount = spyData.presenceDetected?.length || 0;
        const uniqueStatusViewers = new Set(spyData.statusViews.map(v => v.viewer)).size;
        const uniqueReadersCount = new Set(spyData.messageReads.map(r => r.reader)).size;
        const uniquePresenceCount = new Set((spyData.presenceDetected || []).map(p => p.number)).size;
        
        // Dernières personnes
        let lastViewers = "";
        let lastReaders = "";
        let lastPresences = "";
        
        if (spyData.statusViews.length > 0) {
          const last3 = spyData.statusViews.slice(0, 3);
          lastViewers = last3.map(v => {
            const name = v.viewerName || "Inconnu";
            return `• ${name} (${formatNum(v.viewer)})`;
          }).join("\n");
        }
        
        if (spyData.messageReads.length > 0) {
          const last3 = spyData.messageReads.slice(0, 3);
          lastReaders = last3.map(r => {
            const name = r.readerName || "Inconnu";
            const method = r.confirmedBy ? ` [${r.confirmedBy}]` : "";
            return `• ${name} (${formatNum(r.reader)})${method}`;
          }).join("\n");
        }
        
        if (spyData.presenceDetected && spyData.presenceDetected.length > 0) {
          const last3 = spyData.presenceDetected.slice(-3).reverse();
          lastPresences = last3.map(p => {
            const name = p.name || "Inconnu";
            const actionEmoji = p.action === "composing" ? "✍️" : p.action === "recording" ? "🎤" : "👁️";
            return `• ${actionEmoji} ${name} (${formatNum(p.number)})`;
          }).join("\n");
        }
        
        return send(`🕵️ ═══════════════════════════
      *MODE ESPION*
═══════════════════════════

📊 *STATISTIQUES:*
👁️ *Vues statuts:* ${statusCount} (${uniqueStatusViewers} personnes)
📖 *Messages lus:* ${readCount} (${uniqueReadersCount} personnes)
↩️ *Réponses reçues:* ${repliesCount}
✍️ *Présences détectées:* ${presenceCount} (${uniquePresenceCount} personnes)

${lastViewers ? `🔍 *Dernières vues statuts:*\n${lastViewers}\n` : ""}
${lastReaders ? `📖 *Dernières lectures confirmées:*\n${lastReaders}\n` : ""}
${lastPresences ? `✍️ *Derniers actifs dans ton chat:*\n${lastPresences}\n` : ""}
⚙️ *État actuel:*
• Spy statuts: ${protectionState.spyStatusViews ? "✅ ON" : "❌ OFF"}
• Spy lectures: ${protectionState.spyReadReceipts ? "✅ ON" : "❌ OFF"}
• Spy réponses: ${protectionState.spyReplies ? "✅ ON" : "❌ OFF"}
• Spy présence: ${protectionState.spyPresence ? "✅ ON" : "❌ OFF"}

═══════════════════════════
📋 *COMMANDES:*
• \`.spy status\` → Qui a vu tes statuts
• \`.spy messages\` → Qui a lu tes messages
• \`.spy presence\` → Qui a ouvert ton chat
• \`.spy on\` → Activer tout
• \`.spy off\` → Désactiver tout
• \`.spy clear\` → Effacer historique

_Détecte quand quelqu'un entre dans ta discussion même avec vues désactivées!_`);
      }
    }

    // ────────── 🔐 MODE & PERMISSIONS ──────────
    case "mode": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      const param = args?.toLowerCase();
      
      if (param === "public") {
        config.MODE = "public";
        return send(`🌍 *Mode PUBLIC activé!*

✅ Tout le monde peut utiliser le bot selon son niveau:
• 👑 *Owner:* Accès total
• 🛡️ *Sudo:* Commandes admin
• ✅ *Approuvé:* IA, downloads, jeux
• 👤 *Public:* Menu, ping, sticker

💡 Utilise \`.approve @user\` pour donner plus d'accès.`);
      } else if (param === "private") {
        config.MODE = "private";
        return send(`🔒 *Mode PRIVATE activé!*

⛔ Seuls l'Owner et les Sudos peuvent utiliser le bot.

💡 Utilise \`.mode public\` pour permettre l'accès aux autres.`);
      } else {
        return send(`🔐 *Mode actuel: ${config.MODE.toUpperCase()}*

*Usage:* \`.mode public\` ou \`.mode private\`

• *Public:* Tout le monde selon son niveau
• *Private:* Owner et Sudo uniquement`);
      }
    }

    case "permissions":
    case "myaccess":
    case "mylevel": {
      // Cette commande est accessible à tous
      const approvedList = db.getApprovedList();
      const userNum = senderNumber;
      
      let level = "👤 *PUBLIC*";
      let description = "Tu peux utiliser les commandes de base (menu, ping, sticker, info).";
      let commands = "`.menu`, `.ping`, `.sticker`, `.info`";
      
      if (isOwner) {
        level = "👑 *OWNER*";
        description = "Tu es le PROPRIÉTAIRE du bot. Tu as accès à TOUTES les commandes!";
        commands = "Toutes les commandes sans restriction.";
      } else if (isSudo) {
        level = "🛡️ *SUDO*";
        description = "Tu es administrateur du bot. Tu as accès aux commandes de gestion.";
        commands = "Gestion groupe, kick, ban, protections, + commandes approuvés.";
      } else if (db.isApproved(userNum)) {
        level = "✅ *APPROUVÉ*";
        description = "Tu es approuvé par l'owner. Tu as accès aux fonctionnalités avancées.";
        commands = "IA (GPT, DALL-E), téléchargements, jeux, conversions, + commandes publiques.";
      }
      
      return send(`╭━━━ 🔐 *TON NIVEAU D'ACCÈS* ━━━╮
┃
┃ ${level}
┃
┃ 📋 *Description:*
┃ ${description}
┃
┃ 🎯 *Commandes disponibles:*
┃ ${commands}
┃
╰━━━━━━━━━━━━━━━━━━━━━━━━━━╯

📊 *Hiérarchie du bot:*
• 👑 Owner → Accès total
• 🛡️ Sudo → Admin du bot
• ✅ Approuvé → Accès avancé
• 👤 Public → Accès basique

${!isOwner && !isSudo && !db.isApproved(userNum) ? "\n💡 *Tip:* Demande à l'owner de t'approuver pour plus d'accès!" : ""}`);
    }

    // ────────── 🚫 BLOCAGE WHATSAPP ──────────
    case "block":
    case "bloquer": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber || targetNumber.length < 10) {
        return send(`❌ *Usage:* .block [numéro]\n\n📱 *Exemples:*\n• .block 2250150252467\n• .block @mention\n• Réponds à un message avec .block`);
      }
      
      try {
        const targetJid = targetNumber + "@s.whatsapp.net";
        await hani.updateBlockStatus(targetJid, "block");
        return send(`✅ *Bloqué avec succès!*\n\n📱 ${formatPhoneNumber(targetNumber)}\n\n🚫 Cette personne ne peut plus:\n• Te voir en ligne\n• Voir ta photo de profil\n• T'envoyer de messages\n• Voir tes statuts`);
      } catch (e) {
        return send("❌ Erreur: " + e.message);
      }
    }

    case "unblock":
    case "debloquer": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber || targetNumber.length < 10) {
        return send(`❌ *Usage:* .unblock [numéro]\n\n📱 *Exemples:*\n• .unblock 2250150252467\n• .unblock @mention`);
      }
      
      try {
        const targetJid = targetNumber + "@s.whatsapp.net";
        await hani.updateBlockStatus(targetJid, "unblock");
        return send(`✅ *Débloqué avec succès!*\n\n📱 ${formatPhoneNumber(targetNumber)}`);
      } catch (e) {
        return send("❌ Erreur: " + e.message);
      }
    }

    case "blocklist":
    case "listblock":
    case "blocked": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      try {
        const blockedList = await hani.fetchBlocklist();
        
        if (!blockedList || blockedList.length === 0) {
          return send("📭 Aucun contact bloqué.");
        }
        
        let list = `🚫 *CONTACTS BLOQUÉS (${blockedList.length})*\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
        
        for (let i = 0; i < blockedList.length; i++) {
          const jid = blockedList[i];
          const num = jid.split("@")[0];
          list += `${i + 1}. ${formatPhoneNumber(num)}\n`;
        }
        
        list += `\n━━━━━━━━━━━━━━━━━━━━━\n💡 Utilise .unblock [numéro] pour débloquer`;
        
        return send(list);
      } catch (e) {
        return send("❌ Erreur: " + e.message);
      }
    }

    // ────────── 📇 GESTION DES CONTACTS ──────────
    case "contacts":
    case "contactlist":
    case "allcontacts": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      const allContacts = getAllContacts();
      
      if (allContacts.length === 0) {
        return send("📭 Aucun contact enregistré.\n\nLes contacts sont enregistrés automatiquement quand ils t'envoient des messages.");
      }
      
      // Trier par dernier message
      allContacts.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
      
      let list = `📇 *CONTACTS ENREGISTRÉS (${allContacts.length})*\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      const maxShow = 30;
      for (let i = 0; i < Math.min(allContacts.length, maxShow); i++) {
        const c = allContacts[i];
        list += `${i + 1}. *${c.name}*\n`;
        list += `   📱 ${c.formattedNumber}\n`;
        list += `   💬 ${c.messageCount || 0} msg\n`;
        list += `   🕐 ${c.lastSeen}\n\n`;
      }
      
      if (allContacts.length > maxShow) {
        list += `\n... et ${allContacts.length - maxShow} autres contacts`;
      }
      
      list += `\n━━━━━━━━━━━━━━━━━━━━━\n💡 .searchcontact [nom] pour chercher`;
      
      return send(list);
    }

    case "searchcontact":
    case "findcontact": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (!args) {
        return send(`❌ *Usage:* .searchcontact [nom ou numéro]\n\n📱 Exemples:\n• .searchcontact Jean\n• .searchcontact 0150252467`);
      }
      
      const results = searchContacts(args);
      
      if (results.length === 0) {
        return send(`❌ Aucun contact trouvé pour "${args}"`);
      }
      
      let list = `🔍 *RÉSULTATS POUR "${args}"*\n━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      for (let i = 0; i < Math.min(results.length, 15); i++) {
        const c = results[i];
        list += `${i + 1}. *${c.name}*\n`;
        list += `   📱 ${c.formattedNumber}\n`;
        list += `   💬 ${c.messageCount || 0} messages\n`;
        list += `   📅 Vu: ${c.lastSeen}\n\n`;
      }
      
      if (results.length > 15) {
        list += `\n... et ${results.length - 15} autres résultats`;
      }
      
      return send(list);
    }

    case "contactinfo":
    case "infocontact": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) {
        return send(`❌ *Usage:* .contactinfo [numéro ou @mention]`);
      }
      
      const contact = getContact(targetNumber);
      
      if (!contact) {
        return send(`❌ Contact non trouvé: ${formatPhoneNumber(targetNumber)}\n\nCe contact ne t'a jamais envoyé de message.`);
      }
      
      // Essayer de récupérer la photo de profil
      let profilePic = null;
      try {
        profilePic = await hani.profilePictureUrl(contact.jid, "image");
      } catch (e) {}
      
      const info = `
📇 *FICHE CONTACT*
━━━━━━━━━━━━━━━━━━━━━

👤 *Nom:* ${contact.name}
📱 *Numéro:* ${contact.formattedNumber}
🆔 *JID:* ${contact.jid}

📊 *Statistiques:*
┃ 💬 Messages: ${contact.messageCount || 0}
┃ 📅 Premier contact: ${contact.firstSeen}
┃ 🕐 Dernier contact: ${contact.lastSeen}
┃ 📝 Dernière activité: ${contact.lastActivity || "Inconnu"}

━━━━━━━━━━━━━━━━━━━━━
      `.trim();
      
      if (profilePic) {
        try {
          await hani.sendMessage(from, { image: { url: profilePic }, caption: info });
          return;
        } catch (e) {}
      }
      
      return send(info);
    }

    case "privacy":
    case "confidentialite": {
      const privacyHelp = `
🔒 *PARAMÈTRES DE CONFIDENTIALITÉ*
━━━━━━━━━━━━━━━━━━━━━

📱 *Dans WhatsApp → Paramètres → Confidentialité:*

┃ 📸 *Photo de profil:*
┃ → Tout le monde / Mes contacts / Personne
┃
┃ 👁️ *Dernière connexion:*
┃ → Tout le monde / Mes contacts / Personne
┃
┃ ✅ *Confirmations de lecture:*
┃ → Activer / Désactiver
┃
┃ 📝 *Infos (À propos):*
┃ → Tout le monde / Mes contacts / Personne
┃
┃ 👥 *Groupes:*
┃ → Tout le monde / Mes contacts / Mes contacts sauf...
┃
┃ 📍 *Localisation en direct:*
┃ → Personne / Partager avec...

━━━━━━━━━━━━━━━━━━━━━
💡 *Commandes du bot:*
• .block [n°] - Bloquer un contact
• .unblock [n°] - Débloquer
• .blocklist - Voir les bloqués

⚠️ *Note:* Tu ne peux PAS masquer ton numéro.
C'est ton identifiant WhatsApp.
      `.trim();
      
      return send(privacyHelp);
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
      
      if (!targetNumber || targetNumber.length < 8) {
        return send(`❌ *Usage:* .spy [numéro]\n\n📱 *Exemples:*\n• .spy 2250150252467\n• .spy +225 01 50 25 24 67\n• .spy @mention\n\n💡 Le numéro doit être au format international sans le +`);
      }
      
      // Vérifier si déjà surveillé
      if (watchList.has(targetNumber)) {
        return send(`⚠️ Ce numéro est déjà surveillé!\n\n📱 ${formatPhoneNumber(targetNumber)}`);
      }
      
      watchList.add(targetNumber);
      
      console.log(`[SPY] Surveillance ajoutée: ${targetNumber}`);
      console.log(`[SPY] Liste actuelle: ${[...watchList].join(", ")}`);
      
      let response = `🕵️ *SURVEILLANCE ACTIVÉE*\n`;
      response += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      response += `📱 *Numéro:* ${formatPhoneNumber(targetNumber)}\n`;
      response += `🔢 *ID interne:* ${targetNumber}\n\n`;
      response += `✅ Tu recevras une alerte à chaque:\n`;
      response += `   • Message texte\n`;
      response += `   • Photo/Vidéo envoyée\n`;
      response += `   • Audio/Document\n\n`;
      response += `📊 *Surveillés:* ${watchList.size} personne(s)\n\n`;
      response += `💡 Commandes:\n`;
      response += `   • .spylist - Voir la liste\n`;
      response += `   • .unspy ${targetNumber} - Arrêter`;
      
      return send(response);
    }

    case "unwatch":
    case "unspy": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      
      if (!targetNumber) {
        return send(`❌ *Usage:* .unspy [numéro]\n\n📱 Liste actuelle: ${watchList.size} surveillé(s)\nUtilise .spylist pour voir`);
      }
      
      if (!watchList.has(targetNumber)) {
        return send(`⚠️ Ce numéro n'est pas surveillé.\n\nUtilise .spylist pour voir la liste.`);
      }
      
      watchList.delete(targetNumber);
      console.log(`[SPY] Surveillance retirée: ${targetNumber}`);
      
      return send(`✅ *Surveillance désactivée*\n\n📱 ${formatPhoneNumber(targetNumber)}\n\n📊 Reste: ${watchList.size} surveillé(s)`);
    }

    case "watchlist":
    case "spylist": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      if (watchList.size === 0) {
        return send(`📭 *Aucune surveillance active*\n\n💡 Utilise .spy [numéro] pour commencer\n\nExemple: .spy 2250150252467`);
      }
      
      let list = `🕵️ *NUMÉROS SURVEILLÉS*\n`;
      list += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      let i = 1;
      for (const num of watchList) {
        const tracked = activityTracker.get(num);
        list += `*${i}.* ${formatPhoneNumber(num)}\n`;
        if (tracked) {
          list += `   👤 ${tracked.name}\n`;
          list += `   💬 ${tracked.messageCount} msg(s)\n`;
          list += `   🕐 Vu: ${tracked.lastSeen}\n`;
        } else {
          list += `   ⏳ En attente d'activité...\n`;
        }
        list += `\n`;
        i++;
      }
      
      list += `━━━━━━━━━━━━━━━━━━━━━\n`;
      list += `📊 *Total:* ${watchList.size} surveillance(s)`;
      
      return send(list);
    }

    case "testspy":
    case "spytest": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let info = `🕵️ *TEST SURVEILLANCE*\n`;
      info += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
      info += `📊 *Surveillés:* ${watchList.size}\n`;
      info += `📋 *Liste:*\n`;
      
      for (const num of watchList) {
        info += `   • ${num}\n`;
      }
      
      info += `\n🔍 *Dernier expéditeur détecté:*\n`;
      info += `   ${sender?.split("@")[0] || "Aucun"}\n`;
      
      return send(info);
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

    // ────────── 🔗 CONTACTS EN COMMUN ──────────
    case "communs":
    case "common":
    case "commoncontacts":
    case "mutual":
    case "quiconnait": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      await send("🔍 *Analyse des contacts en commun en cours...*\nScanning de tous vos groupes...");
      
      try {
        // Récupérer tous les groupes
        const groups = await hani.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);
        
        if (groupIds.length === 0) {
          return send("❌ Aucun groupe trouvé.");
        }
        
        // Map: numéro → { name, groups: [groupNames], inGroupsWith: Set(numéros) }
        const contactMap = new Map();
        const botNumber = hani.user?.id?.split(":")[0]?.split("@")[0];
        
        // Analyser chaque groupe
        for (const groupId of groupIds) {
          const group = groups[groupId];
          const groupName = group.subject || "Groupe sans nom";
          const participants = group.participants || [];
          
          // Ajouter chaque participant
          for (const p of participants) {
            const num = p.id?.split("@")[0]?.split(":")[0];
            if (!num || isLID(num)) continue;
            
            if (!contactMap.has(num)) {
              contactMap.set(num, {
                name: p.notify || p.name || "Inconnu",
                groups: [],
                inGroupsWith: new Set(),
                isAdmin: false
              });
            }
            
            const contact = contactMap.get(num);
            contact.groups.push(groupName);
            if (p.admin) contact.isAdmin = true;
            
            // Ajouter les autres participants comme "contacts en commun"
            for (const other of participants) {
              const otherNum = other.id?.split("@")[0]?.split(":")[0];
              if (otherNum && otherNum !== num && !isLID(otherNum)) {
                contact.inGroupsWith.add(otherNum);
              }
            }
          }
        }
        
        // Si un numéro cible est spécifié
        if (targetNumber) {
          const targetContact = contactMap.get(targetNumber);
          
          if (!targetContact) {
            return send(`❌ *${formatPhoneNumber(targetNumber)}* n'est dans aucun de vos groupes.`);
          }
          
          // Trouver les contacts en commun avec toi
          const myContacts = contactMap.get(botNumber)?.inGroupsWith || new Set();
          const targetContacts = targetContact.inGroupsWith;
          
          // Contacts en commun entre toi et la cible
          const commonWithTarget = [...targetContacts].filter(n => myContacts.has(n) && n !== botNumber);
          
          let text = `🔗 *CONTACTS EN COMMUN*\n`;
          text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
          text += `🎯 *Cible:* ${targetContact.name}\n`;
          text += `📱 *Numéro:* ${formatPhoneNumber(targetNumber)}\n`;
          text += `👑 *Admin:* ${targetContact.isAdmin ? "Oui" : "Non"}\n\n`;
          
          text += `🏘️ *Groupes en commun avec toi:*\n`;
          const commonGroups = targetContact.groups.filter(g => {
            // Vérifier si toi aussi tu es dans ce groupe
            for (const [num, c] of contactMap) {
              if (num === botNumber && c.groups.includes(g)) return true;
            }
            return false;
          });
          
          if (commonGroups.length > 0) {
            commonGroups.slice(0, 10).forEach((g, i) => {
              text += `   ${i + 1}. ${g}\n`;
            });
            if (commonGroups.length > 10) text += `   ... et ${commonGroups.length - 10} autres\n`;
          } else {
            text += `   Aucun groupe en commun\n`;
          }
          
          text += `\n👥 *Contacts mutuels (${commonWithTarget.length}):*\n`;
          if (commonWithTarget.length > 0) {
            commonWithTarget.slice(0, 15).forEach((num, i) => {
              const c = contactMap.get(num);
              text += `   ${i + 1}. ${c?.name || "Inconnu"} (${formatPhoneNumber(num)})\n`;
            });
            if (commonWithTarget.length > 15) text += `   ... et ${commonWithTarget.length - 15} autres\n`;
          } else {
            text += `   Aucun contact mutuel trouvé\n`;
          }
          
          text += `\n📊 *Stats:*\n`;
          text += `   • Dans ${targetContact.groups.length} groupe(s)\n`;
          text += `   • Connaît ${targetContact.inGroupsWith.size} personne(s)\n`;
          
          return send(text);
        }
        
        // Sans cible: afficher les personnes les plus "connectées"
        const sorted = [...contactMap.entries()]
          .filter(([num]) => num !== botNumber && !isLID(num))
          .sort((a, b) => b[1].inGroupsWith.size - a[1].inGroupsWith.size)
          .slice(0, 20);
        
        let text = `🔗 *TOP CONTACTS LES PLUS CONNECTÉS*\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        text += `📊 *${groupIds.length} groupes analysés*\n`;
        text += `👥 *${contactMap.size} contacts trouvés*\n\n`;
        
        sorted.forEach(([num, contact], i) => {
          const emoji = i < 3 ? ["🥇", "🥈", "🥉"][i] : `${i + 1}.`;
          text += `${emoji} *${contact.name}*\n`;
          text += `   📱 ${formatPhoneNumber(num)}\n`;
          text += `   🔗 Connaît ${contact.inGroupsWith.size} personnes\n`;
          text += `   🏘️ Dans ${contact.groups.length} groupe(s)\n\n`;
        });
        
        text += `💡 *Utilise* \`.communs @user\` *pour voir les détails d'un contact*`;
        
        return send(text);
        
      } catch (error) {
        console.error("[COMMUNS] Erreur:", error);
        return send(`❌ Erreur: ${error.message}`);
      }
    }

    // ────────── 🔍 QUI A MON NUMÉRO ──────────
    case "quiamon":
    case "whohasme":
    case "whosaveme": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      await send("🔍 *Recherche de qui a ton numéro...*");
      
      try {
        const groups = await hani.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);
        const botNumber = hani.user?.id?.split(":")[0]?.split("@")[0];
        
        // Personnes qui sont dans les mêmes groupes que toi
        const peopleWhoKnowMe = new Map();
        
        for (const groupId of groupIds) {
          const group = groups[groupId];
          const groupName = group.subject || "Groupe sans nom";
          const participants = group.participants || [];
          
          // Vérifier si le bot est dans ce groupe
          const botInGroup = participants.some(p => {
            const num = p.id?.split("@")[0]?.split(":")[0];
            return num === botNumber;
          });
          
          if (!botInGroup) continue;
          
          // Toutes les personnes de ce groupe ont potentiellement ton numéro
          for (const p of participants) {
            const num = p.id?.split("@")[0]?.split(":")[0];
            if (!num || num === botNumber || isLID(num)) continue;
            
            if (!peopleWhoKnowMe.has(num)) {
              peopleWhoKnowMe.set(num, {
                name: p.notify || p.name || "Inconnu",
                groups: [],
                isAdmin: false
              });
            }
            
            const person = peopleWhoKnowMe.get(num);
            person.groups.push(groupName);
            if (p.admin) person.isAdmin = true;
          }
        }
        
        // Trier par nombre de groupes en commun
        const sorted = [...peopleWhoKnowMe.entries()]
          .sort((a, b) => b[1].groups.length - a[1].groups.length);
        
        let text = `👁️ *QUI A TON NUMÉRO?*\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        text += `📊 *${peopleWhoKnowMe.size} personnes* sont dans tes groupes\n`;
        text += `🏘️ Elles peuvent avoir ton numéro!\n\n`;
        
        text += `🔝 *Top 20 (par groupes en commun):*\n\n`;
        
        sorted.slice(0, 20).forEach(([num, person], i) => {
          text += `${i + 1}. *${person.name}* ${person.isAdmin ? "👑" : ""}\n`;
          text += `   📱 ${formatPhoneNumber(num)}\n`;
          text += `   🏘️ ${person.groups.length} groupe(s) en commun\n\n`;
        });
        
        if (sorted.length > 20) {
          text += `... et ${sorted.length - 20} autres personnes\n\n`;
        }
        
        text += `💡 *Note:* Ces personnes peuvent voir ton numéro dans les groupes.`;
        
        return send(text);
        
      } catch (error) {
        console.error("[QUIAMON] Erreur:", error);
        return send(`❌ Erreur: ${error.message}`);
      }
    }

    // ────────── 🕵️ PROFIL STALKER ──────────
    case "stalk":
    case "stalker":
    case "profil":
    case "whois": {
      if (!isOwner) return send("❌ Commande réservée à l'owner.");
      
      let targetNumber = args?.replace(/[^0-9]/g, "");
      if (mentioned[0]) targetNumber = mentioned[0].split("@")[0];
      if (quotedParticipant) targetNumber = quotedParticipant.split("@")[0];
      
      if (!targetNumber) {
        return send(`🕵️ *PROFIL STALKER*\n\nUtilisation:\n• \`.stalk @user\`\n• \`.stalk 225XXXXXXXXXX\`\n\nObtiens toutes les infos d'un contact!`);
      }
      
      const targetJid = targetNumber + "@s.whatsapp.net";
      
      await send(`🔍 *Récupération du profil de ${formatPhoneNumber(targetNumber)}...*`);
      
      try {
        let text = `🕵️ *PROFIL STALKER*\n`;
        text += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
        text += `📱 *Numéro:* ${formatPhoneNumber(targetNumber)}\n`;
        
        // Récupérer le statut/bio
        try {
          const status = await hani.fetchStatus(targetJid);
          text += `📝 *Bio:* ${status?.status || "Pas de bio"}\n`;
          if (status?.setAt) {
            text += `📅 *Bio mise à jour:* ${new Date(status.setAt * 1000).toLocaleString("fr-FR")}\n`;
          }
        } catch (e) {
          text += `📝 *Bio:* Non disponible\n`;
        }
        
        // Vérifier présence dans groupes
        const groups = await hani.groupFetchAllParticipating();
        let groupCount = 0;
        let groupNames = [];
        let isAdminSomewhere = false;
        
        for (const groupId of Object.keys(groups)) {
          const group = groups[groupId];
          const participant = group.participants?.find(p => 
            p.id?.split("@")[0]?.split(":")[0] === targetNumber
          );
          if (participant) {
            groupCount++;
            groupNames.push(group.subject || "Sans nom");
            if (participant.admin) isAdminSomewhere = true;
          }
        }
        
        text += `\n🏘️ *Groupes en commun:* ${groupCount}\n`;
        if (groupNames.length > 0) {
          groupNames.slice(0, 5).forEach((g, i) => {
            text += `   ${i + 1}. ${g}\n`;
          });
          if (groupNames.length > 5) text += `   ... et ${groupNames.length - 5} autres\n`;
        }
        
        text += `\n👑 *Admin quelque part:* ${isAdminSomewhere ? "Oui" : "Non"}\n`;
        
        // Activité enregistrée
        const tracker = activityTracker.get(targetNumber);
        if (tracker) {
          text += `\n📊 *Activité enregistrée:*\n`;
          text += `   💬 ${tracker.messageCount} messages\n`;
          text += `   📅 Première vue: ${tracker.firstSeen}\n`;
          text += `   🕐 Dernière vue: ${tracker.lastSeen}\n`;
        }
        
        // Médias stockés
        const medias = mediaStore.get(targetNumber);
        if (medias) {
          text += `\n📁 *Médias reçus:* ${medias.length}\n`;
        }
        
        // Sous surveillance?
        if (watchList.has(targetNumber)) {
          text += `\n🔴 *Sous surveillance!*\n`;
        }
        
        // Banni?
        if (db.isBanned(targetJid)) {
          text += `\n🚫 *BANNI du bot*\n`;
        }
        
        // Récupérer la photo de profil
        try {
          const ppUrl = await hani.profilePictureUrl(targetJid, "image");
          if (ppUrl) {
            const response = await fetch(ppUrl);
            const buffer = Buffer.from(await response.arrayBuffer());
            return hani.sendMessage(from, { 
              image: buffer, 
              caption: text 
            }, { quoted: msg });
          }
        } catch (e) {
          // Pas de photo de profil
        }
        
        return send(text);
        
      } catch (error) {
        console.error("[STALK] Erreur:", error);
        return send(`❌ Erreur: ${error.message}`);
      }
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
+-----------------------------------------------------------+
|                                                           |
|              * HANI-MD V1.0 *                           |
|         Bot WhatsApp Intelligent par H2025                |
|                                                           |
+-----------------------------------------------------------+
|  [QR] Scanne le QR code avec WhatsApp                       |
|  [CFG]  Préfixe: ${config.PREFIXE.padEnd(42)}|
|  [OWNER] Owner: ${config.NOM_OWNER.padEnd(44)}|
+-----------------------------------------------------------+
`);

  // Créer les dossiers nécessaires
  if (!fs.existsSync("./DataBase")) {
    fs.mkdirSync("./DataBase", { recursive: true });
  }

  // Restaurer la session depuis SESSION_ID si disponible
  if (config.SESSION_ID) {
    await restoreSessionFromId();
  }
  
  // Créer le dossier session si nécessaire
  if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  // Compteur pour éviter les reconnexions infinies
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  let isConnected = false;

  // Sauvegarder les credentials immédiatement et régulièrement
  const saveCredsWrapper = async () => {
    try {
      await saveCreds();
      console.log("[SAVE] Session sauvegardée");
    } catch (e) {
      console.log("⚠️ Erreur sauvegarde session:", e.message);
    }
  };

  hani = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    logger: pino({ level: "silent" }),
    browser: ["HANI-MD", "Chrome", "1.0.0"],
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    retryRequestDelayMs: 2000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    emitOwnEvents: true,
    fireInitQueries: true,
    qrTimeout: 60000,
    getMessage: async (key) => {
      return { conversation: "" };
    },
  });

  // ────────── ÉVÉNEMENTS DE CONNEXION ──────────
  hani.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      reconnectAttempts = 0; // Reset quand on affiche le QR
      
      // Stocker le QR pour l'affichage web
      qrState.currentQR = qr;
      qrState.lastUpdate = Date.now();
      qrState.connectionStatus = "waiting_qr";
      qrState.qrCount++;
      
      // Générer le QR en image base64 pour le web
      try {
        qrState.qrDataURL = await qrcodeWeb.toDataURL(qr, {
          width: 300,
          margin: 2,
          color: { dark: "#000000", light: "#ffffff" }
        });
      } catch (e) {
        console.log("⚠️ Erreur génération QR image:", e.message);
      }
      
      console.log("\n[QR] SCANNE CE QR CODE AVEC WHATSAPP:\n");
      qrcode.generate(qr, { small: true });
      console.log("\n[WAIT] Tu as 60 secondes pour scanner...");
      console.log(`[WEB] Ou va sur: http://localhost:${process.env.PORT || 3000}/qr\n`);
    }

    if (connection === "connecting") {
      qrState.connectionStatus = "connecting";
      console.log("[...] Connexion en cours...");
    }

    if (connection === "open") {
      isConnected = true;
      qrState.isConnected = true;
      qrState.connectionStatus = "connected";
      qrState.currentQR = null;
      qrState.qrDataURL = null;
      
      const botNumber = hani.user?.id?.split(":")[0] || "";
      const botName = hani.user?.name || "HANI-MD";
      const botJid = botNumber + "@s.whatsapp.net";
      
      qrState.botInfo = {
        name: botName,
        number: botNumber,
        jid: botJid,
        connectedAt: new Date().toISOString()
      };
      
      // 🤖 ENREGISTRER LE BOT (celui qui a scanné le QR)
      // ATTENTION: Le bot n'est PAS l'owner ! L'owner est défini dans .env (NUMERO_OWNER)
      if (botNumber) {
        // Enregistrer le bot dans la base de données comme "bot" (pas owner!)
        if (!db.data.users[botJid]) {
          db.data.users[botJid] = {
            name: botName,
            role: "bot", // Le bot n'est PAS owner, c'est juste le bot
            messageCount: 0,
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString(),
            isBot: true
          };
        } else {
          db.data.users[botJid].name = botName;
          db.data.users[botJid].isBot = true;
          // Ne pas changer le role si déjà défini
        }
        db.save();
        console.log(`[DB] 🤖 Bot enregistré: ${botName} (${botNumber})`);
        console.log(`[DB] 👑 Owner défini dans .env: ${config.NUMERO_OWNER}`);
      }
      
      reconnectAttempts = 0;
      
      // Sauvegarder immédiatement après connexion réussie
      await saveCredsWrapper();
      
      // Sauvegarder encore après 2 secondes pour être sûr
      setTimeout(async () => {
        await saveCredsWrapper();
      }, 2000);
      
      // Sauvegarder périodiquement toutes les 5 minutes
      setInterval(async () => {
        if (isConnected) {
          await saveCredsWrapper();
        }
      }, 5 * 60 * 1000);
      
      console.log(`
+-----------------------------------------------------------+
|              [OK] HANI-MD CONNECTÉ !                        |
+-----------------------------------------------------------+
|  [BOT] Bot: ${(hani.user?.name || "HANI-MD").padEnd(47)}|
|  [QR] Numéro: ${(hani.user?.id?.split(":")[0] || "").padEnd(44)}|
|  [CFG]  Préfixe: ${config.PREFIXE.padEnd(42)}|
|  [WEB] Mode: ${config.MODE.padEnd(46)}|
+-----------------------------------------------------------+
|  [SHIELD] PROTECTIONS AUTOMATIQUES ACTIVÉES:                   |
|    [OK] Anti-delete messages                                |
|    [OK] Vue unique photos/vidéos                            |
|    [OK] Écoute unique vocaux                                |
|    [OK] Sauvegarde automatique statuts                      |
|    [OK] Anti-suppression statuts                            |
|    [OK] Anti-appel                                          |
|    [OK] Anti-bot (bloque autres bots)                       |
+-----------------------------------------------------------+
|  [TIP] Tape ${config.PREFIXE}menu pour voir les commandes              |
|  [MSG] Tout est envoyé automatiquement dans "Moi-même"       |
+-----------------------------------------------------------+
`);
      db.data.stats.startTime = Date.now();
      db.save();
    }

    if (connection === "close") {
      isConnected = false;
      qrState.isConnected = false;
      qrState.connectionStatus = "disconnected";
      qrState.botInfo = null;
      
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || "Inconnue";

      console.log(`\n[!] Déconnexion (code: ${statusCode}, raison: ${reason})`);

      // Session déconnectée manuellement, expirée, ou rejetée par WhatsApp (428)
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 428) {
        console.log("[X] Session expirée/rejetée. Suppression et nouveau QR...");
        if (fs.existsSync(SESSION_FOLDER)) {
          fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
          console.log("[OK] Session supprimée.");
        }
        reconnectAttempts = 0;
        await delay(3000);
        startBot();
      } 
      // Conflit de session
      else if (statusCode === 440) {
        console.log("[!] Conflit de session (WhatsApp Web ouvert ailleurs)");
        console.log("[TIP] Ferme les autres sessions WhatsApp Web.");
        reconnectAttempts++;
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          console.log(`[...] Tentative ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dans 10 secondes...`);
          await delay(10000);
          startBot();
        } else {
          console.log("[X] Trop de tentatives. Arrêt du bot.");
        }
      } 
      // Redémarrage requis par WhatsApp
      else if (statusCode === 515 || statusCode === 408) {
        console.log("[...] Redémarrage requis...");
        await delay(3000);
        startBot();
      }
      // Autres erreurs - reconnexion normale
      else {
        reconnectAttempts++;
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const waitTime = Math.min(5000 * reconnectAttempts, 30000);
          console.log(`[...] Tentative ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} dans ${waitTime/1000}s...`);
          await delay(waitTime);
          startBot();
        } else {
          console.log("[X] Trop de tentatives. Arrêt du bot.");
          console.log("[TIP] Relance manuellement avec: node hani.js");
        }
      }
    }
  });

  hani.ev.on("creds.update", saveCredsWrapper);

  // ────────── 📇 FONCTION POUR FORMATER UN NUMÉRO ──────────
  const formatPhoneForDisplay = (number) => {
    if (!number) return "Inconnu";
    const clean = number.replace(/[^0-9]/g, '');
    // Formater selon la longueur
    if (clean.length === 12 && clean.startsWith("225")) {
      // Côte d'Ivoire: +225 XX XX XX XX XX
      return `+225 ${clean.slice(3,5)} ${clean.slice(5,7)} ${clean.slice(7,9)} ${clean.slice(9,11)} ${clean.slice(11)}`;
    } else if (clean.length === 11 && clean.startsWith("33")) {
      // France: +33 X XX XX XX XX
      return `+33 ${clean.slice(2,3)} ${clean.slice(3,5)} ${clean.slice(5,7)} ${clean.slice(7,9)} ${clean.slice(9)}`;
    } else if (clean.length >= 10) {
      // Autre pays: +XXX XXX XXX XXX
      return `+${clean.slice(0,3)} ${clean.slice(3,6)} ${clean.slice(6,9)} ${clean.slice(9)}`;
    }
    return `+${clean}`;
  };

  // ────────── 👁️ ESPIONNAGE: QUI VOIT MES STATUTS ──────────
  // Capturer TOUTES les vues de statuts (même avec confirmations désactivées)
  hani.ev.on("message-receipt.update", async (updates) => {
    try {
      if (!protectionState.spyStatusViews) return; // Désactivé
      
      for (const update of updates) {
        const { key, receipt } = update;
        
        // Vérifier si c'est un statut (status@broadcast)
        if (key.remoteJid === "status@broadcast" && key.fromMe) {
          // Quelqu'un a vu MON statut
          const viewerJid = receipt.userJid;
          const viewerNumber = viewerJid?.split("@")[0];
          const viewerName = getContactName(viewerJid) || null;
          const timestamp = receipt.readTimestamp ? receipt.readTimestamp * 1000 : Date.now();
          const readTime = new Date(timestamp).toLocaleString("fr-FR");
          const formattedPhone = formatPhoneForDisplay(viewerNumber);
          
          // Stocker dans spyData
          spyData.statusViews.unshift({
            viewer: viewerNumber,
            viewerName: viewerName,
            viewerJid: viewerJid,
            timestamp: timestamp,
            timeStr: readTime
          });
          
          // Limiter le nombre d'entrées
          if (spyData.statusViews.length > spyData.maxEntries) {
            spyData.statusViews = spyData.statusViews.slice(0, spyData.maxEntries);
          }
          
          // Envoyer notification à moi-même
          const botJid = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
          
          // Message avec numéro très visible
          const displayName = viewerName || "Contact inconnu";
          const nameInfo = viewerName ? `👤 *Nom:* ${viewerName}` : `👤 *Contact:* Non enregistré`;
          
          await hani.sendMessage(botJid, {
            text: `👁️ ═══════════════════════
    *QUELQU'UN A VU TON STATUT*
═══════════════════════

${nameInfo}
📱 *Numéro:* ${formattedPhone}
🔢 *Brut:* ${viewerNumber}
🕐 *Heure:* ${readTime}

📞 *Appelle:* wa.me/${viewerNumber}
💬 *Écris:* wa.me/${viewerNumber}

═══════════════════════
💡 _.spy_ pour voir tout le monde`
          });
          
          console.log(`👁️ [STATUT VU] ${displayName} (${formattedPhone}) a vu ton statut`);
        }
      }
    } catch (e) {
      // Silencieux en cas d'erreur
    }
  });

  // ────────── 📖 ESPIONNAGE: QUI LIT MES MESSAGES ──────────
  // Capturer les confirmations de lecture (même désactivées côté destinataire)
  hani.ev.on("messages.update", async (updates) => {
    try {
      for (const update of updates) {
        const { key, update: msgUpdate } = update;
        
        // Si c'est mon message et il a été lu
        if (key.fromMe && msgUpdate.status === 4) { // status 4 = read/lu
          const recipientJid = key.remoteJid;
          
          // Ignorer les groupes et status@broadcast pour cette notification
          if (recipientJid?.includes("@g.us") || recipientJid === "status@broadcast") continue;
          
          const recipientNumber = recipientJid?.split("@")[0];
          
          // ⚠️ IGNORER LES LID (Linked ID) - ce ne sont pas de vrais numéros
          if (isLID(recipientNumber)) {
            console.log(`📖 [IGNORÉ] LID détecté, pas un vrai numéro: ${recipientNumber}`);
            continue;
          }
          
          const recipientName = getContactName(recipientJid) || null;
          const timestamp = Date.now();
          const readTime = new Date(timestamp).toLocaleString("fr-FR");
          const formattedPhone = formatPhoneForDisplay(recipientNumber);
          
          // Stocker dans spyData
          spyData.messageReads.unshift({
            reader: recipientNumber,
            readerName: recipientName,
            readerJid: recipientJid,
            timestamp: timestamp,
            timeStr: readTime
          });
          
          // Limiter le nombre d'entrées
          if (spyData.messageReads.length > spyData.maxEntries) {
            spyData.messageReads = spyData.messageReads.slice(0, spyData.maxEntries);
          }
          
          // Envoyer notification si activé
          if (protectionState.spyReadReceipts) {
            const botJid = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
            const displayName = recipientName || "Contact inconnu";
            const nameInfo = recipientName ? `👤 *Nom:* ${recipientName}` : `👤 *Contact:* Non enregistré`;
            
            await hani.sendMessage(botJid, {
              text: `📖 ═══════════════════════
    *MESSAGE LU PAR*
═══════════════════════

${nameInfo}
📱 *Numéro:* ${formattedPhone}
🔢 *Brut:* ${recipientNumber}
🕐 *Lu à:* ${readTime}

📞 *Appelle:* wa.me/${recipientNumber}
💬 *Écris:* wa.me/${recipientNumber}

═══════════════════════`
            });
          }
          
          console.log(`📖 [MESSAGE LU] ${recipientName || recipientNumber} (${formattedPhone}) a lu ton message`);
        }
      }
    } catch (e) {
      // Silencieux en cas d'erreur
    }
  });

  // ────────── GESTION DES CONTACTS ──────────
  // Mettre en cache les noms des contacts pour les utiliser dans les messages
  hani.ev.on("contacts.upsert", (contacts) => {
    for (const contact of contacts) {
      const jid = contact.id;
      const name = contact.name || contact.notify || contact.verifiedName;
      if (jid && name) {
        cacheContactName(jid, name);
        console.log(`📇 Contact mis en cache: ${name} (${jid.split("@")[0]})`);
      }
    }
  });

  hani.ev.on("contacts.update", (updates) => {
    for (const update of updates) {
      const jid = update.id;
      const name = update.name || update.notify || update.verifiedName;
      if (jid && name) {
        cacheContactName(jid, name);
      }
    }
  });

  // ────────── 🕵️ DÉTECTION DE PRÉSENCE (QUELQU'UN ENTRE DANS VOTRE CHAT) ──────────
  // Détecte quand quelqu'un est en train d'écrire ou est actif dans une discussion privée
  hani.ev.on("presence.update", async (presenceData) => {
    try {
      if (!protectionState.spyPresence) return;
      
      const { id: chatJid, presences } = presenceData;
      const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
      
      // Ignorer les groupes et les statuts
      if (!chatJid || chatJid.endsWith("@g.us") || chatJid === "status@broadcast") return;
      
      // Parcourir les présences détectées
      for (const [participantJid, presence] of Object.entries(presences || {})) {
        // Ignorer ma propre présence
        if (participantJid === botNumber || participantJid.split("@")[0] === hani.user?.id?.split(":")[0]) {
          continue;
        }
        
        // Détecter si quelqu'un est actif (composing = en train d'écrire, paused = vient de s'arrêter d'écrire)
        const lastKnownPresence = presence?.lastKnownPresence;
        
        // Événements intéressants : "composing" (écrit), "recording" (enregistre vocal), "available" (en ligne dans le chat)
        if (lastKnownPresence === "composing" || lastKnownPresence === "recording" || lastKnownPresence === "available") {
          
          const participantNumber = participantJid.split("@")[0];
          
          // ⚠️ IGNORER LES LID (Linked ID) - ce ne sont pas de vrais numéros
          if (isLID(participantNumber)) {
            console.log(`🕵️ [IGNORÉ] LID détecté dans présence: ${participantNumber}`);
            continue;
          }
          
          const cooldownKey = `${participantNumber}_${lastKnownPresence}`;
          const now = Date.now();
          
          // Cooldown de 10 minutes par personne et par type d'action pour éviter le spam
          const lastNotified = spyData.presenceCooldown[cooldownKey] || 0;
          if (now - lastNotified < 10 * 60 * 1000) {
            continue; // Déjà notifié récemment
          }
          
          // Marquer comme notifié
          spyData.presenceCooldown[cooldownKey] = now;
          
          // Formater le numéro pour affichage
          const formattedPhone = formatPhoneForDisplay ? formatPhoneForDisplay(participantNumber) : `+${participantNumber}`;
          const contactName = getCachedContactName(participantJid) || "Inconnu";
          const detectTime = new Date(now).toLocaleString("fr-FR");
          
          // Déterminer l'action
          let actionText, actionEmoji;
          switch (lastKnownPresence) {
            case "composing":
              actionText = "est en train d'écrire";
              actionEmoji = "✍️";
              break;
            case "recording":
              actionText = "enregistre un vocal";
              actionEmoji = "🎤";
              break;
            case "available":
              actionText = "est en ligne dans votre chat";
              actionEmoji = "👁️";
              break;
            default:
              actionText = "est actif";
              actionEmoji = "📱";
          }
          
          // Enregistrer la détection
          spyData.presenceDetected.push({
            participant: participantJid,
            number: participantNumber,
            name: contactName,
            action: lastKnownPresence,
            timestamp: now
          });
          
          // Limiter la taille de l'historique
          if (spyData.presenceDetected.length > spyData.maxEntries) {
            spyData.presenceDetected = spyData.presenceDetected.slice(-spyData.maxEntries);
          }
          
          // Envoyer notification au owner
          const ownerJid = config.NUMERO_OWNER.split(",")[0] + "@s.whatsapp.net";
          
          const notificationMsg = `╔═══════════════════════════════╗
║   🕵️ PRÉSENCE DÉTECTÉE 🕵️   ║
╠═══════════════════════════════╣
║ ${actionEmoji} Quelqu'un ${actionText}!
╠═══════════════════════════════╣
║ 👤 Nom: ${contactName}
║ 📞 Numéro: ${formattedPhone}
║ 🔗 Lien: wa.me/${participantNumber}
║ 🕐 Heure: ${detectTime}
╠═══════════════════════════════╣
║ 💡 Cette personne a ouvert
║    votre discussion privée!
╚═══════════════════════════════╝`;

          await hani.sendMessage(ownerJid, { text: notificationMsg });
          console.log(`🕵️ Présence détectée: ${contactName} (${participantNumber}) - ${lastKnownPresence}`);
        }
      }
    } catch (e) {
      // Silencieux en cas d'erreur
      console.log("Erreur presence.update:", e.message);
    }
  });

  // ────────── GESTION DES MESSAGES ──────────
  hani.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;

      const sender = msg.key.participant || msg.key.remoteJid;
      const from = msg.key.remoteJid;
      const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
      const senderName = msg.pushName || "Inconnu";
      
      // ═══════════════════════════════════════════════════════════
      // 🔔 DÉTECTION DES RÉPONSES = PREUVE DE LECTURE!
      // Si quelqu'un me répond ou m'envoie un message, il a forcément lu!
      // ═══════════════════════════════════════════════════════════
      if (!msg.key.fromMe && protectionState.spyReplies && from !== "status@broadcast" && !from?.endsWith("@g.us")) {
        const senderNumber = sender?.split("@")[0];
        
        // ⚠️ IGNORER LES LID (Linked ID) - ce ne sont pas de vrais numéros
        if (isLID(senderNumber)) {
          // Ne pas loguer pour éviter le spam, juste ignorer silencieusement
        } else {
        
        const formattedPhone = formatPhoneForDisplay ? formatPhoneForDisplay(senderNumber) : `+${senderNumber}`;
        const timestamp = Date.now();
        const readTime = new Date(timestamp).toLocaleString("fr-FR");
        
        // Extraire un aperçu du message
        const msgPreview = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text ||
                          msg.message?.imageMessage?.caption ||
                          msg.message?.videoMessage?.caption ||
                          (msg.message?.audioMessage ? "🎵 Vocal" : "") ||
                          (msg.message?.imageMessage ? "📷 Photo" : "") ||
                          (msg.message?.videoMessage ? "🎬 Vidéo" : "") ||
                          (msg.message?.stickerMessage ? "🎴 Sticker" : "") ||
                          "📩 Message";
        
        // Vérifier si c'est une réponse à mon message
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        const isReply = !!quotedMsg;
        
        // Vérifier si on a envoyé un message à cette personne récemment (dans les 24h)
        const pendingTime = spyData.pendingMessages[from];
        const isFollowUp = pendingTime && (timestamp - pendingTime < 24 * 60 * 60 * 1000);
        
        // Si c'est une réponse OU un suivi à notre message
        if (isReply || isFollowUp) {
          // Stocker l'info
          spyData.replies.unshift({
            replier: senderNumber,
            replierName: senderName,
            replierJid: from,
            timestamp: timestamp,
            timeStr: readTime,
            preview: msgPreview.slice(0, 50),
            isDirectReply: isReply
          });
          
          // Limiter les entrées
          if (spyData.replies.length > spyData.maxEntries) {
            spyData.replies = spyData.replies.slice(0, spyData.maxEntries);
          }
          
          // Ajouter aussi aux lectures confirmées
          spyData.messageReads.unshift({
            reader: senderNumber,
            readerName: senderName,
            readerJid: from,
            timestamp: timestamp,
            timeStr: readTime,
            confirmedBy: isReply ? "réponse" : "message"
          });
          
          // Limiter
          if (spyData.messageReads.length > spyData.maxEntries) {
            spyData.messageReads = spyData.messageReads.slice(0, spyData.maxEntries);
          }
          
          // Envoyer notification
          const actionType = isReply ? "RÉPONDU À TON MESSAGE" : "T'A ÉCRIT";
          
          await hani.sendMessage(botNumber, {
            text: `📖 ═══════════════════════════
    *${actionType}* ✅
═══════════════════════════

👤 *Nom:* ${senderName}
📱 *Numéro:* ${formattedPhone}
🔢 *Brut:* ${senderNumber}
🕐 *Quand:* ${readTime}

💬 *Aperçu:* ${msgPreview.slice(0, 40)}${msgPreview.length > 40 ? "..." : ""}

${isReply ? "↩️ _Cette personne a RÉPONDU à ton message!_" : "💡 _Cette personne t'a écrit après ton message!_"}

📞 wa.me/${senderNumber}

═══════════════════════════
_Preuve qu'elle a LU ton message!_ ✅`
          });
          
          console.log(`📖 [PREUVE LECTURE] ${senderName} (${formattedPhone}) a ${isReply ? "répondu" : "écrit"} - CONFIRMATION DE LECTURE!`);
          
          // Supprimer du pending
          delete spyData.pendingMessages[from];
        }
        } // Fermer le else (pas LID)
      }
      
      // Enregistrer les messages ENVOYÉS pour tracker les réponses
      if (msg.key.fromMe && from !== "status@broadcast" && !from?.endsWith("@g.us")) {
        spyData.pendingMessages[from] = Date.now();
      }
      
      // 🔍 DÉBOGAGE ULTRA-COMPLET: Afficher STRUCTURE de tous les messages
      const msgType = getContentType(msg.message);
      const msgKeys = Object.keys(msg.message || {});
      
      // Log spécial pour les audios et vocaux (TOUJOURS)
      if (!msg.key.fromMe) {
        const containsAudio = msgKeys.some(k => k.toLowerCase().includes("audio") || k.toLowerCase().includes("ptt"));
        const containsViewOnce = msgKeys.some(k => k.toLowerCase().includes("viewonce"));
        
        if (containsAudio || containsViewOnce) {
          console.log(`\n🔴 ------------------------------------------`);
          console.log(`🔴 MESSAGE AUDIO/VIEWONCE REÇU - STRUCTURE COMPLÈTE:`);
          console.log(`🔴 De: ${sender?.split("@")[0]} (${senderName})`);
          console.log(`🔴 Type principal: ${msgType}`);
          console.log(`🔴 Keys niveau 1: ${msgKeys.join(", ")}`);
          
          // Explorer chaque clé
          for (const key of msgKeys) {
            if (key === "messageContextInfo") continue; // Skip les métadonnées
            const value = msg.message[key];
            if (typeof value === "object" && value !== null) {
              const subKeys = Object.keys(value);
              console.log(`🔴   ${key} → ${subKeys.join(", ")}`);
              // Si c'est un viewOnce, explorer plus
              if (key.includes("viewOnce") && value.message) {
                const innerKeys = Object.keys(value.message);
                console.log(`🔴     message → ${innerKeys.join(", ")}`);
                for (const ik of innerKeys) {
                  if (typeof value.message[ik] === "object") {
                    console.log(`🔴       ${ik} → ${Object.keys(value.message[ik]).join(", ")}`);
                  }
                }
              }
              // Si c'est un audio, montrer les propriétés
              if (key.includes("audio") || key.includes("ptt")) {
                console.log(`🔴     viewOnce: ${value.viewOnce}`);
                console.log(`🔴     ptt: ${value.ptt}`);
                console.log(`🔴     seconds: ${value.seconds}`);
                console.log(`🔴     mimetype: ${value.mimetype}`);
              }
            }
          }
          console.log(`🔴 ------------------------------------------\n`);
        }
      }
      
      // Log pour TOUS les messages non-texte ou vides
      if (!msg.key.fromMe) {
        // Vérifier TOUS les formats possibles de viewOnce
        const hasViewOnce = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension;
        const hasAudioViewOnce = msg.message?.audioMessage?.viewOnce;
        const hasPttViewOnce = msg.message?.pttMessage?.viewOnce;
        
        // Vérifier si c'est un vocal (pour débogage)
        const isAudioType = msgType === "audioMessage" || msgType === "pttMessage" || 
                           msgKeys.includes("audioMessage") || msgKeys.includes("pttMessage");
        
        if (hasViewOnce || hasAudioViewOnce || hasPttViewOnce || isAudioType || 
            (msgType !== "extendedTextMessage" && msgType !== "conversation" && msgType !== "reactionMessage")) {
          console.log(`[MSG] [MSG REÇU] Type: ${msgType}`);
          console.log(`   Keys: ${msgKeys.join(", ")}`);
          console.log(`   De: ${sender?.split("@")[0]}`);
          console.log(`   ViewOnce: ${!!hasViewOnce} | AudioViewOnce: ${!!hasAudioViewOnce} | PttViewOnce: ${!!hasPttViewOnce}`);
          
          // Débogage détaillé pour viewOnce
          if (hasViewOnce) {
            const voContent = hasViewOnce;
            console.log(`   ViewOnce Content Keys: ${Object.keys(voContent).join(", ")}`);
            if (voContent.message) {
              const innerKeys = Object.keys(voContent.message);
              console.log(`   Inner Message Keys: ${innerKeys.join(", ")}`);
              // Si c'est un audio dans viewOnce
              if (innerKeys.includes("audioMessage") || innerKeys.includes("pttMessage")) {
                console.log(`   [AUDIO] VOCAL VUE UNIQUE DÉTECTÉ dans viewOnce!`);
              }
            }
          }
          
          // Débogage pour audio/ptt direct
          if (isAudioType) {
            const audio = msg.message?.audioMessage || msg.message?.pttMessage;
            console.log(`   [AUDIO] Audio direct - viewOnce: ${audio?.viewOnce}, ptt: ${audio?.ptt}, seconds: ${audio?.seconds}`);
          }
        }
      }
      
      // 📇 ENREGISTRER LE CONTACT DANS LA BASE
      if (!msg.key.fromMe && sender && !sender.endsWith("@g.us")) {
        updateContact(sender, senderName, {
          lastActivity: getContentType(msg.message),
          lastChat: from
        });
      }
      
      // 🤖 PROTECTION ANTI-BOT DÉSACTIVÉE
      
      // ═══════════════════════════════════════════════════════════
      // 👁️ INTERCEPTION AUTOMATIQUE DES VUES UNIQUES (Photos/Vidéos/Vocaux)
      // ═══════════════════════════════════════════════════════════
      
      // 1. Vues uniques classiques (photos/vidéos/audios)
      const viewOnceContent = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension;
      
      // DÉBOGAGE: Afficher tous les types de viewOnce détectés
      if (viewOnceContent) {
        console.log(`🔍 [VIEW-ONCE DEBUG] Contenu détecté!`);
        console.log(`   Message keys: ${Object.keys(msg.message || {}).join(", ")}`);
        console.log(`   ViewOnce keys: ${Object.keys(viewOnceContent || {}).join(", ")}`);
        if (viewOnceContent.message) {
          console.log(`   Inner message keys: ${Object.keys(viewOnceContent.message || {}).join(", ")}`);
        }
      }
      
      if (viewOnceContent && !msg.key.fromMe) {
        const mediaMsg = viewOnceContent.message;
        const mediaType = Object.keys(mediaMsg || {})[0] || "inconnu";
        
        // Déterminer si c'est un audio/vocal
        const isAudio = mediaType === "audioMessage" || mediaType === "pttMessage";
        const isImage = mediaType === "imageMessage";
        const isVideo = mediaType === "videoMessage";
        
        console.log(`[VIEW] VUE UNIQUE DÉTECTÉE de ${sender.split("@")[0]}`);
        console.log(`   Type: ${mediaType} | Audio: ${isAudio} | Image: ${isImage} | Video: ${isVideo}`);
        
        // Vérifier les protections appropriées
        const shouldIntercept = isAudio ? protectionState.autoViewOnceAudio : protectionState.autoViewOnce;
        
        if (!shouldIntercept) {
          console.log(`   ⏭️ Interception désactivée pour ce type`);
        } else {
          console.log(`   [OK] Interception en cours...`);
          
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
          
          // AUTOMATIQUEMENT télécharger et envoyer en privé
          try {
            // Créer un message formaté pour le téléchargement
            const downloadMsg = {
              key: msg.key,
              message: mediaMsg // Utiliser le message interne, pas viewOnceContent
            };
            
            const stream = await downloadMediaMessage(
              downloadMsg,
              "buffer",
              {},
              { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
            );
            
            if (stream && stream.length > 0) {
              console.log(`   📦 Buffer téléchargé: ${stream.length} bytes`);
              const media = mediaMsg[mediaType];
              const typeLabel = isAudio ? "🎤 VOCAL" : (isVideo ? "🎬 VIDÉO" : "📸 IMAGE");
              const caption = `${typeLabel} *VUE UNIQUE INTERCEPTÉ(E)!*\n━━━━━━━━━━━━━━━━━━━━━\n\n👤 *De:* ${msg.pushName || sender.split("@")[0]}\n📱 *Numéro:* ${formatPhoneNumber(sender.split("@")[0])}\n💬 *Chat:* ${from.endsWith("@g.us") ? "Groupe" : "Privé"}\n🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}\n${media?.caption ? `\n📝 *Légende:* ${media.caption}` : ""}`;
              
              if (isImage) {
                await hani.sendMessage(botNumber, { image: stream, caption });
                console.log(`[OK] Image vue unique envoyée à Moi-même`);
              } else if (isVideo) {
                await hani.sendMessage(botNumber, { video: stream, caption });
                console.log(`[OK] Vidéo vue unique envoyée à Moi-même`);
              } else if (isAudio) {
                // Envoyer le vocal comme PTT
                await hani.sendMessage(botNumber, { 
                  audio: stream, 
                  mimetype: media?.mimetype || "audio/ogg; codecs=opus",
                  ptt: true // Toujours comme vocal
                });
                await hani.sendMessage(botNumber, { text: caption });
                console.log(`[OK] Vocal vue unique envoyé à Moi-même`);
              }
            } else {
              console.log(`[!] Échec téléchargement vue unique: buffer vide`);
            }
          } catch (e) {
            console.log(`[!] Erreur téléchargement vue unique: ${e.message}`);
            // Fallback: essayer avec le message original
            try {
              console.log(`   [...] Tentative fallback avec message original...`);
              const stream2 = await downloadMediaMessage(
                msg,
                "buffer",
                {},
                { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
              );
              if (stream2 && stream2.length > 0) {
                console.log(`   📦 Fallback buffer: ${stream2.length} bytes`);
                const media = mediaMsg[mediaType];
                const typeLabel = isAudio ? "🎤 VOCAL" : (isVideo ? "🎬 VIDÉO" : "📸 IMAGE");
                const caption = `${typeLabel} *VUE UNIQUE INTERCEPTÉ(E)!*\n━━━━━━━━━━━━━━━━━━━━━\n\n👤 *De:* ${msg.pushName || sender.split("@")[0]}\n📱 *Numéro:* ${formatPhoneNumber(sender.split("@")[0])}\n🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}`;
                
                if (isImage) {
                  await hani.sendMessage(botNumber, { image: stream2, caption });
                } else if (isVideo) {
                  await hani.sendMessage(botNumber, { video: stream2, caption });
                } else if (isAudio) {
                  await hani.sendMessage(botNumber, { 
                    audio: stream2, 
                    mimetype: media?.mimetype || "audio/ogg; codecs=opus",
                    ptt: true
                  });
                  await hani.sendMessage(botNumber, { text: caption });
                }
                console.log(`[OK] Vue unique envoyée (fallback)`);
              }
            } catch (e2) {
              console.log(`[!] Fallback aussi échoué: ${e2.message}`);
            }
          }
        }
      }
      
      // 2. Vocaux "écoute unique" en format direct (non viewOnce wrapper) - Format alternatif
      const audioMsg = msg.message?.audioMessage;
      const pttMsg = msg.message?.pttMessage; // Format alternatif pour les vocaux
      
      // Vérifier les deux formats possibles de vocal écoute unique (format direct avec viewOnce flag)
      if ((audioMsg?.viewOnce || pttMsg?.viewOnce) && !msg.key.fromMe && protectionState.autoViewOnceAudio) {
        const voiceMsg = audioMsg || pttMsg;
        console.log(`[AUDIO] VOCAL ÉCOUTE UNIQUE (FORMAT DIRECT) détecté de ${sender.split("@")[0]}`);
        console.log(`[AUDIO] VOCAL ÉCOUTE UNIQUE DÉTECTÉ de ${sender.split("@")[0]}`);
        
        // AUTOMATIQUEMENT télécharger et envoyer en privé
        try {
          const stream = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: pino({ level: "silent" }), reuploadRequest: hani.updateMediaMessage }
          );
          
          if (stream && stream.length > 0) {
            const caption = `🎤 *VOCAL ÉCOUTE UNIQUE INTERCEPTÉ!*\n━━━━━━━━━━━━━━━━━━━━━\n\n👤 *De:* ${msg.pushName || sender.split("@")[0]}\n📱 *Numéro:* ${formatPhoneNumber(sender.split("@")[0])}\n💬 *Chat:* ${from.endsWith("@g.us") ? "Groupe" : "Privé"}\n🕐 *Heure:* ${new Date().toLocaleString("fr-FR")}`;
            
            // Envoyer le vocal comme PTT (message vocal)
            await hani.sendMessage(botNumber, { 
              audio: stream, 
              mimetype: voiceMsg?.mimetype || "audio/ogg; codecs=opus",
              ptt: true // Toujours en format vocal
            });
            
            // Puis envoyer le caption
            await hani.sendMessage(botNumber, { text: caption });
            
            console.log(`[OK] Vocal écoute unique envoyé à Moi-même`);
          }
        } catch (e) {
          console.log(`[!] Erreur sauvegarde vocal écoute unique: ${e.message}`);
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
            console.log(`[NOTE] Statut texte sauvegardé de ${msg.pushName || sender.split("@")[0]}`);
          }
          
        } catch (e) {
          console.log(`[!] Erreur sauvegarde statut: ${e.message}`);
        }
      }

      // Stocker pour anti-delete
      if (!msg.key.fromMe && msg.message) {
        // Extraire le vrai numéro de l'expéditeur
        const realSender = msg.key.participant || msg.key.remoteJid;
        const realNumber = realSender?.split("@")[0] || "";
        
        // Cacher le nom dans le cache des contacts
        if (msg.pushName && msg.pushName.length > 1) {
          cacheContactName(realSender, msg.pushName);
        }
        
        // Récupérer le nom: pushName > cache > numéro formaté
        let realName = msg.pushName && msg.pushName.length > 1 ? msg.pushName : null;
        if (!realName) realName = getCachedContactName(realSender);
        if (!realName && isValidPhoneNumber(realNumber)) realName = formatPhoneNumber(realNumber);
        if (!realName) realName = "Inconnu";
        
        // Ne stocker que si le numéro est valide (pas un ID de groupe corrompu)
        if (isValidPhoneNumber(realNumber)) {
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
        }
        
        // 🕵️ TRACKER L'ACTIVITÉ
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const isGroup = from?.endsWith("@g.us");
        trackActivity(senderJid, msg.pushName, getContentType(msg.message), isGroup ? from : null);
        
        // 🕵️ VÉRIFIER SI LA PERSONNE EST SURVEILLÉE
        const senderNum = senderJid?.split("@")[0];
        
        // Vérifier dans la watchList (plusieurs formats possibles)
        let isWatched = false;
        let matchedNumber = null;
        
        for (const watchedNum of watchList) {
          // Vérification exacte ou partielle (fin du numéro)
          if (senderNum === watchedNum || 
              senderNum?.endsWith(watchedNum) || 
              watchedNum?.endsWith(senderNum) ||
              senderNum?.includes(watchedNum) ||
              watchedNum?.includes(senderNum)) {
            isWatched = true;
            matchedNumber = watchedNum;
            break;
          }
        }
        
        if (isWatched) {
          console.log(`[SPY] ALERTE! Message de ${senderNum} (surveillé: ${matchedNumber})`);
          
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
              
              console.log(`[SPY] Média intercepté de ${watchedName} (${msgType})`);
            } catch (e) {
              console.log(`[!] Erreur interception média: ${e.message}`);
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
          // Récupérer les infos avec validation
          const senderNumber = storedMsg.realNumber || "";
          
          // Ignorer si le numéro n'est pas valide
          if (!isValidPhoneNumber(senderNumber)) {
            console.log(`[!] Message supprimé ignoré: numéro invalide (${senderNumber})`);
            continue;
          }
          
          // Récupérer le nom: base de contacts > stocké > formaté
          let senderName = null;
          const contactInfo = getContact(senderNumber);
          if (contactInfo && contactInfo.name !== "Inconnu") {
            senderName = contactInfo.name;
          }
          if (!senderName) senderName = storedMsg.pushName;
          if (!senderName || senderName === "Inconnu") {
            senderName = formatPhoneNumber(senderNumber);
          }
          
          console.log(`[DEL] Message supprimé de ${senderName} (${senderNumber})`);
          
          deletedMessages.push({
            sender: senderName,
            number: senderNumber,
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
            const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
            if (botNumber) {
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
              
              await hani.sendMessage(botNumber, { text });
              
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
                    await hani.sendMessage(botNumber, { image: stream, caption: mediaCaption });
                  } else if (storedMsg.type === "videoMessage") {
                    await hani.sendMessage(botNumber, { video: stream, caption: mediaCaption });
                  } else if (storedMsg.type === "audioMessage") {
                    await hani.sendMessage(botNumber, { audio: stream, mimetype: "audio/mp4" });
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
            const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
            if (botNumber) {
              const formattedStatusNumber = formatPhoneNumber(storedStatus.sender);
              
              let caption = `📸 *Statut supprimé!*\n\n`;
              caption += `👤 De: ${storedStatus.pushName}\n`;
              caption += `📱 Numéro: ${formattedStatusNumber}\n`;
              caption += `📝 Type: ${storedStatus.type}\n`;
              caption += `🕐 Posté: ${storedStatus.date}\n`;
              caption += `🗑️ Supprimé: ${new Date().toLocaleString("fr-FR")}`;
              
              if (storedStatus.mediaBuffer) {
                if (storedStatus.type === "image") {
                  await hani.sendMessage(botNumber, { 
                    image: storedStatus.mediaBuffer, 
                    caption: caption + (storedStatus.caption ? `\n\n💬 "${storedStatus.caption}"` : "")
                  });
                } else if (storedStatus.type === "video") {
                  await hani.sendMessage(botNumber, { 
                    video: storedStatus.mediaBuffer, 
                    caption: caption + (storedStatus.caption ? `\n\n💬 "${storedStatus.caption}"` : "")
                  });
                } else if (storedStatus.type === "audio") {
                  await hani.sendMessage(botNumber, { text: caption });
                  await hani.sendMessage(botNumber, { audio: storedStatus.mediaBuffer, mimetype: "audio/mp4" });
                }
              } else if (storedStatus.text) {
                caption += `\n\n💬 Contenu:\n"${storedStatus.text}"`;
                await hani.sendMessage(botNumber, { text: caption });
              } else {
                await hani.sendMessage(botNumber, { text: caption });
              }
              
              console.log(`[OK] Statut supprimé envoyé à toi-même`);
            }
          } catch (e) {
            console.log(`[!] Erreur envoi statut supprimé: ${e.message}`);
          }
        }
      }
    }
  });

  // ────────── ANTI-CALL ──────────
  hani.ev.on("call", async (calls) => {
    for (const call of calls || []) {
      // 🆕 ENREGISTRER L'APPEL DANS L'HISTORIQUE
      if (spyConfig.trackCalls) {
        try {
          const callerJid = call.from;
          const callerNumber = callerJid?.split("@")[0] || "";
          let callerName = "Inconnu";
          
          try {
            const contact = await hani.onWhatsApp(callerJid);
            if (contact && contact[0]) {
              callerName = contact[0].notify || contact[0].name || callerNumber;
            }
          } catch (e) {}
          
          const callEntry = {
            jid: callerJid,
            name: callerName,
            type: call.isVideo ? 'video' : 'audio',
            direction: 'in',
            status: call.status === 'offer' ? 'incoming' : call.status,
            timestamp: Date.now()
          };
          
          // Ajouter à l'historique
          if (!spyData.callHistory) spyData.callHistory = [];
          spyData.callHistory.unshift(callEntry);
          if (spyData.callHistory.length > 100) spyData.callHistory.pop();
          
          console.log(`📞 [CALL SPY] ${call.isVideo ? 'Vidéo' : 'Audio'} de ${callerName} (${callerNumber})`);
        } catch (e) {
          console.log(`[!] Erreur enregistrement appel: ${e.message}`);
        }
      }
      
      // ANTI-CALL: Rejeter si activé
      if (protectionState.anticall && call.status === "offer") {
        try {
          // Rejeter l'appel
          await hani.rejectCall(call.id, call.from);
          
          // Mettre à jour le statut dans l'historique
          if (spyData.callHistory && spyData.callHistory.length > 0) {
            spyData.callHistory[0].status = 'rejected';
          }
          
          // Envoyer un message personnalisé à la personne qui appelle
          const callerNumber = call.from?.split("@")[0] || "";
          const callType = call.isVideo ? "vidéo" : "vocal";
          
          const message = `📵 *Appel ${callType} refusé*
━━━━━━━━━━━━━━━━━━━━━

👋 Salut!

Je ne suis pas disponible pour les appels pour le moment.

📩 *Envoie-moi plutôt un message*, je te répondrai dès que possible!

_Ce message a été envoyé automatiquement._`;
          
          await hani.sendMessage(call.from, { text: message });
          
          // Notifier le propriétaire dans "Moi-même"
          const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
          const notif = `📵 *Appel ${callType} rejeté*\n\n👤 De: ${callerName}\n📱 ${formatPhoneNumber(callerNumber)}\n🕐 ${new Date().toLocaleString("fr-FR")}`;
          await hani.sendMessage(botNumber, { text: notif });
          
          console.log(`📵 Appel ${callType} rejeté de ${callerName}`);
        } catch (e) {
          console.log(`[!] Erreur anti-call: ${e.message}`);
        }
      }
    }
  });

  // ────────── 🆕 SURVEILLANCE DES GROUPES ──────────
  hani.ev.on("group-participants.update", async (update) => {
    if (!spyConfig.trackGroups) return;
    
    try {
      const { id: groupJid, participants, action } = update;
      
      // Récupérer les infos du groupe
      let groupName = "Groupe inconnu";
      try {
        const metadata = await hani.groupMetadata(groupJid);
        groupName = metadata?.subject || groupName;
      } catch (e) {}
      
      for (const participant of participants) {
        let participantName = "Inconnu";
        try {
          const contact = await hani.onWhatsApp(participant);
          if (contact && contact[0]) {
            participantName = contact[0].notify || contact[0].name || participant.split("@")[0];
          }
        } catch (e) {}
        
        const activity = {
          groupJid,
          groupName,
          action,
          participant,
          participantName,
          timestamp: Date.now()
        };
        
        // Ajouter à l'historique
        if (!spyData.groupActivity) spyData.groupActivity = [];
        spyData.groupActivity.unshift(activity);
        if (spyData.groupActivity.length > 200) spyData.groupActivity.pop();
        
        // Notification pour l'owner
        const botNumber = hani.user?.id?.split(":")[0] + "@s.whatsapp.net";
        let emoji, actionText;
        switch (action) {
          case 'add': emoji = '➕'; actionText = 'a rejoint'; break;
          case 'remove': emoji = '➖'; actionText = 'a quitté'; break;
          case 'promote': emoji = '👑'; actionText = 'promu admin'; break;
          case 'demote': emoji = '👤'; actionText = 'rétrogradé'; break;
          default: emoji = '📋'; actionText = action;
        }
        
        const notif = `${emoji} *Activité Groupe*\n\n👥 *${groupName}*\n👤 ${participantName}\n🔄 ${actionText}\n🕐 ${new Date().toLocaleString("fr-FR")}`;
        await hani.sendMessage(botNumber, { text: notif });
        
        console.log(`👥 [GROUP SPY] ${participantName} ${actionText} dans ${groupName}`);
      }
    } catch (e) {
      console.log(`[!] Erreur surveillance groupe: ${e.message}`);
    }
  });

  // ────────── 🆕 TRACKER DE PRÉSENCE (CONNEXION/DÉCONNEXION) ──────────
  hani.ev.on("presence.update", async (update) => {
    if (!spyConfig.trackLastSeen) return;
    
    try {
      const { id: jid, presences } = update;
      if (!presences) return;
      
      for (const [participantJid, presence] of Object.entries(presences)) {
        const cleanJid = participantJid.split("@")[0];
        
        // Ignorer le bot lui-même
        const botNumber = hani.user?.id?.split(":")[0];
        if (cleanJid === botNumber) continue;
        
        // Récupérer le nom
        let name = "Inconnu";
        try {
          const contact = await hani.onWhatsApp(participantJid);
          if (contact && contact[0]) {
            name = contact[0].notify || contact[0].name || cleanJid;
          }
        } catch (e) {}
        
        // Initialiser si nécessaire
        if (!spyData.lastSeen) spyData.lastSeen = {};
        if (!spyData.lastSeen[participantJid]) {
          spyData.lastSeen[participantJid] = { name };
        }
        
        // Mettre à jour selon le type de présence
        if (presence.lastKnownPresence === "available" || presence.lastKnownPresence === "composing" || presence.lastKnownPresence === "recording") {
          spyData.lastSeen[participantJid].lastOnline = Date.now();
          spyData.lastSeen[participantJid].isOnline = true;
          spyData.lastSeen[participantJid].name = name;
        } else if (presence.lastKnownPresence === "unavailable") {
          spyData.lastSeen[participantJid].lastOffline = Date.now();
          spyData.lastSeen[participantJid].isOnline = false;
          spyData.lastSeen[participantJid].name = name;
        }
      }
    } catch (e) {
      // Silencieux
    }
  });

  return hani;
}

// ═══════════════════════════════════════════════════════════
// 🌐 SERVEUR WEB AVEC QR CODE
// ═══════════════════════════════════════════════════════════

const express = require("express");
const app = express();
const port = process.env.PORT || 3000;

// Middleware pour JSON et formulaires
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔐 SYSTÈME D'AUTHENTIFICATION ADMIN SÉCURISÉ
const ADMIN_CODE = "200700";
const adminSessions = new Map(); // Sessions actives

// Générer un token de session
function generateSessionToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Vérifier si une session est valide
function isValidSession(token) {
  if (!token || !adminSessions.has(token)) return false;
  const session = adminSessions.get(token);
  // Session expire après 1 heure
  if (Date.now() - session.createdAt > 3600000) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

// Route de login admin
app.post("/admin/login", (req, res) => {
  const { code } = req.body;
  if (code === ADMIN_CODE) {
    const token = generateSessionToken();
    adminSessions.set(token, { createdAt: Date.now(), ip: req.ip });
    console.log(`[ADMIN] 🔓 Connexion admin réussie depuis ${req.ip}`);
    res.json({ success: true, token });
  } else {
    console.log(`[ADMIN] ❌ Tentative de connexion échouée depuis ${req.ip}`);
    res.json({ success: false, message: "Code incorrect" });
  }
});

// Route de logout
app.post("/admin/logout", (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) adminSessions.delete(token);
  res.json({ success: true });
});

// API pour vérifier l'état admin
app.get("/api/admin/check", (req, res) => {
  const token = req.headers['x-admin-token'];
  res.json({ valid: isValidSession(token) });
});

// API pour les stats admin (protégée)
app.get("/api/admin/stats", async (req, res) => {
  const token = req.headers['x-admin-token'];
  console.log('[ADMIN API] /stats - Token:', token ? 'présent' : 'absent');
  
  if (!isValidSession(token)) {
    console.log('[ADMIN API] /stats - Session invalide');
    return res.status(401).json({ error: "Non autorisé" });
  }
  
  try {
    console.log('[ADMIN API] /stats - Chargement des données...');
    const users = db.data.users || {};
    const userList = Object.entries(users);
    const banned = db.data.banned || [];
    const limited = db.data.limitedUsers || {};
    
    let mysqlStats = null;
    if (mysqlDB.isConnected()) {
      mysqlStats = await mysqlDB.getDashboardStats();
    }
    
    res.json({
      success: true,
      local: {
        totalUsers: userList.length,
        owners: userList.filter(([_, u]) => u.role === "owner").length,
        sudos: userList.filter(([_, u]) => u.role === "sudo").length,
        approved: userList.filter(([_, u]) => u.role === "approved").length,
        banned: banned.length,
        limited: Object.keys(limited).length,
        messages: db.data.stats?.messages || 0,
        commands: db.data.stats?.commands || 0,
        users: userList.map(([jid, user]) => ({
          jid: jid,
          number: jid.split("@")[0],
          name: user.name || "Inconnu",
          role: user.role || "user",
          messages: user.messageCount || 0,
          isBanned: banned.includes(jid),
          isLimited: !!limited[jid],
          limitations: limited[jid] || null,
          lastSeen: user.lastSeen || null,
          isBot: user.isBot || false
        }))
      },
      mysql: {
        connected: mysqlDB.isConnected(),
        stats: mysqlStats
      },
      bot: {
        connected: qrState.isConnected,
        status: qrState.connectionStatus,
        info: qrState.botInfo
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🚫 API pour BANNIR un utilisateur
app.post("/api/admin/ban", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: "JID requis" });
    
    if (!db.data.banned) db.data.banned = [];
    
    if (!db.data.banned.includes(jid)) {
      db.data.banned.push(jid);
      db.save();
      console.log(`[ADMIN] 🚫 Utilisateur banni: ${jid}`);
    }
    
    res.json({ success: true, message: `${jid} a été banni` });
  } catch (error) {
    console.error("[ADMIN ERROR] Ban:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// ✅ API pour DÉBANNIR un utilisateur
app.post("/api/admin/unban", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: "JID requis" });
    
    if (!db.data.banned) db.data.banned = [];
    
    const index = db.data.banned.indexOf(jid);
    if (index > -1) {
      db.data.banned.splice(index, 1);
      db.save();
      console.log(`[ADMIN] ✅ Utilisateur débanni: ${jid}`);
    }
    
    res.json({ success: true, message: `${jid} a été débanni` });
  } catch (error) {
    console.error("[ADMIN ERROR] Unban:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// ⚠️ API pour LIMITER un utilisateur (restreindre commandes)
app.post("/api/admin/limit", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid, level } = req.body;
    if (!jid) return res.status(400).json({ error: "JID requis" });
    
    if (!db.data.limitedUsers) db.data.limitedUsers = {};
    
    // Niveaux de limitation:
    // 1 = Basique (menu, help seulement)
    // 2 = Moyen (pas de téléchargement, pas d'IA)
    // 3 = Strict (commandes fun seulement)
    
    db.data.limitedUsers[jid] = {
      level: level || 1,
      blockedCommands: getBlockedCommands(level || 1),
      limitedAt: new Date().toISOString()
    };
    db.save();
    
    console.log(`[ADMIN] ⚠️ Utilisateur limité (niveau ${level}): ${jid}`);
    res.json({ success: true, message: `${jid} limité au niveau ${level}` });
  } catch (error) {
    console.error("[ADMIN ERROR] Limit:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// Fonction pour obtenir les commandes bloquées par niveau
function getBlockedCommands(level) {
  const levels = {
    1: ['owner', 'sudo', 'ban', 'unban', 'setowner', 'restart', 'eval', 'exec'],
    2: ['owner', 'sudo', 'ban', 'unban', 'setowner', 'restart', 'eval', 'exec', 
        'ytmp3', 'ytmp4', 'play', 'video', 'tiktok', 'insta', 'fb', 'twitter',
        'gpt', 'ia', 'gemini', 'dalle', 'imagine'],
    3: ['owner', 'sudo', 'ban', 'unban', 'setowner', 'restart', 'eval', 'exec',
        'ytmp3', 'ytmp4', 'play', 'video', 'tiktok', 'insta', 'fb', 'twitter',
        'gpt', 'ia', 'gemini', 'dalle', 'imagine', 'sticker', 'toimg',
        'groupe', 'kick', 'add', 'promote', 'demote', 'antilink', 'antispam']
  };
  return levels[level] || levels[1];
}

// ✅ API pour RETIRER les limitations
app.post("/api/admin/unlimit", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: "JID requis" });
    
    if (!db.data.limitedUsers) db.data.limitedUsers = {};
    
    if (db.data.limitedUsers[jid]) {
      delete db.data.limitedUsers[jid];
      db.save();
      console.log(`[ADMIN] ✅ Limitations retirées: ${jid}`);
    }
    
    res.json({ success: true, message: `Limitations retirées pour ${jid}` });
  } catch (error) {
    console.error("[ADMIN ERROR] Unlimit:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// 🗑️ API pour SUPPRIMER un utilisateur de la base
app.post("/api/admin/delete", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid } = req.body;
    if (!jid) return res.status(400).json({ error: "JID requis" });
    
    // Admin a le contrôle total - peut supprimer n'importe qui
    if (!db.data.users) db.data.users = {};
    
    if (db.data.users[jid]) {
      delete db.data.users[jid];
      db.save();
      console.log(`[ADMIN] 🗑️ Utilisateur supprimé: ${jid}`);
    }
    
    res.json({ success: true, message: `${jid} supprimé` });
  } catch (error) {
    console.error("[ADMIN ERROR] Delete:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// 👑 API pour changer le RÔLE d'un utilisateur
app.post("/api/admin/role", (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    if (!isValidSession(token)) {
      return res.status(401).json({ error: "Non autorisé" });
    }
    
    const { jid, role } = req.body;
    if (!jid || !role) return res.status(400).json({ error: "JID et rôle requis" });
    
    const validRoles = ['user', 'approved', 'sudo', 'owner'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Rôle invalide" });
    }
    
    if (!db.data.users) db.data.users = {};
    
    if (!db.data.users[jid]) {
      db.data.users[jid] = { name: "Inconnu", messageCount: 0 };
    }
    
    db.data.users[jid].role = role;
    db.save();
    
    console.log(`[ADMIN] 👑 Rôle changé: ${jid} → ${role}`);
    res.json({ success: true, message: `${jid} est maintenant ${role}` });
  } catch (error) {
    console.error("[ADMIN ERROR] Role:", error.message);
    res.status(500).json({ error: "Erreur serveur: " + error.message });
  }
});

// 🔐 PAGE ADMIN SÉCURISÉE - Code d'accès: 200700
app.get("/admin", async (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔐 HANI-MD Super Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #fff;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
    .header {
      text-align: center;
      padding: 20px 0;
      border-bottom: 2px solid rgba(255,255,255,0.1);
      margin-bottom: 20px;
    }
    .header h1 { font-size: 2em; margin-bottom: 5px; }
    .header h1 span { color: #00d4ff; }
    .status-indicator {
      display: inline-block;
      padding: 5px 15px;
      border-radius: 20px;
      font-size: 0.8em;
      margin: 5px;
    }
    .status-online { background: #6bcb77; }
    .status-offline { background: #ff6b6b; }
    
    /* Login */
    .login-box {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 40px;
      max-width: 400px;
      margin: 50px auto;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .login-box h2 { margin-bottom: 20px; }
    .login-box input {
      width: 100%;
      padding: 15px;
      border: none;
      border-radius: 10px;
      font-size: 1.2em;
      text-align: center;
      margin-bottom: 15px;
      background: rgba(255,255,255,0.9);
      color: #333;
      letter-spacing: 5px;
    }
    .login-box button {
      width: 100%;
      padding: 15px;
      border: none;
      border-radius: 10px;
      font-size: 1.1em;
      background: linear-gradient(135deg, #00d4ff, #0099cc);
      color: #fff;
      cursor: pointer;
    }
    .error-msg { color: #ff6b6b; margin-top: 10px; display: none; }
    .dashboard { display: none; }
    
    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: rgba(255,255,255,0.1);
      border-radius: 12px;
      padding: 15px;
      text-align: center;
    }
    .stat-card .emoji { font-size: 1.5em; }
    .stat-card .number { font-size: 1.5em; font-weight: bold; color: #00d4ff; }
    .stat-card .label { font-size: 0.75em; color: rgba(255,255,255,0.7); }
    
    /* Tabs */
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .tab-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tab-btn:hover { background: rgba(255,255,255,0.2); }
    .tab-btn.active { background: #00d4ff; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    
    /* Users Table */
    .users-section {
      background: rgba(255,255,255,0.05);
      border-radius: 15px;
      padding: 20px;
      overflow-x: auto;
    }
    .search-box {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      flex-wrap: wrap;
    }
    .search-box input {
      flex: 1;
      min-width: 200px;
      padding: 10px 15px;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    .search-box input::placeholder { color: rgba(255,255,255,0.5); }
    .filter-select {
      padding: 10px 15px;
      border: none;
      border-radius: 8px;
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.1); }
    th { background: rgba(0,212,255,0.2); font-size: 0.85em; }
    tr:hover { background: rgba(255,255,255,0.05); }
    
    .role-badge {
      padding: 4px 10px;
      border-radius: 15px;
      font-size: 0.75em;
      font-weight: bold;
    }
    .role-owner { background: #ff6b6b; }
    .role-sudo { background: #ffd93d; color: #333; }
    .role-approved { background: #6bcb77; }
    .role-user { background: #4d96ff; }
    
    .status-badge {
      padding: 4px 8px;
      border-radius: 10px;
      font-size: 0.7em;
    }
    .status-active { background: #6bcb77; }
    .status-banned { background: #ff6b6b; }
    .status-limited { background: #ffd93d; color: #333; }
    
    /* Action Buttons */
    .action-btns { display: flex; gap: 5px; flex-wrap: wrap; }
    .action-btn {
      padding: 5px 10px;
      border: none;
      border-radius: 5px;
      font-size: 0.75em;
      cursor: pointer;
      transition: transform 0.2s;
    }
    .action-btn:hover { transform: scale(1.05); }
    .btn-ban { background: #ff6b6b; color: #fff; }
    .btn-unban { background: #6bcb77; color: #fff; }
    .btn-limit { background: #ffd93d; color: #333; }
    .btn-unlimit { background: #4d96ff; color: #fff; }
    .btn-delete { background: #333; color: #fff; }
    .btn-role { background: #9c27b0; color: #fff; }
    
    /* Quick Actions */
    .quick-actions {
      display: flex;
      gap: 10px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .quick-btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.9em;
      transition: all 0.2s;
    }
    .quick-btn:hover { transform: translateY(-2px); }
    .btn-primary { background: #00d4ff; color: #fff; }
    .btn-danger { background: #ff6b6b; color: #fff; }
    .btn-success { background: #6bcb77; color: #fff; }
    
    /* Modal */
    .modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal.show { display: flex; }
    .modal-content {
      background: #1a1a2e;
      border-radius: 15px;
      padding: 30px;
      max-width: 400px;
      width: 90%;
      border: 1px solid rgba(255,255,255,0.2);
    }
    .modal-content h3 { margin-bottom: 20px; }
    .modal-content select, .modal-content input {
      width: 100%;
      padding: 12px;
      border: none;
      border-radius: 8px;
      margin-bottom: 15px;
      background: rgba(255,255,255,0.1);
      color: #fff;
    }
    .modal-btns { display: flex; gap: 10px; }
    .modal-btns button { flex: 1; padding: 12px; border: none; border-radius: 8px; cursor: pointer; }
    
    /* Toast */
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 15px 25px;
      border-radius: 10px;
      color: #fff;
      z-index: 2000;
      animation: slideIn 0.3s;
    }
    .toast.success { background: #6bcb77; }
    .toast.error { background: #ff6b6b; }
    @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
    
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(3, 1fr); }
      table { font-size: 0.8em; }
      .action-btns { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔐 <span>HANI-MD</span> Super Admin</h1>
      <div id="botStatus" class="status-indicator status-offline">⏳ Chargement...</div>
    </div>
    
    <!-- Login -->
    <div id="loginPage" class="login-box">
      <h2>🔑 Accès Owner</h2>
      <p style="color:rgba(255,255,255,0.6);margin-bottom:20px;font-size:0.9em">Zone réservée au propriétaire</p>
      <input type="password" id="codeInput" placeholder="••••••" maxlength="6">
      <button onclick="login()">🚀 Accéder</button>
      <p id="errorMsg" class="error-msg">❌ Code incorrect</p>
    </div>
    
    <!-- Dashboard -->
    <div id="dashboard" class="dashboard">
      <!-- Quick Actions -->
      <div class="quick-actions">
        <button class="quick-btn btn-primary" onclick="refreshStats()">🔄 Actualiser</button>
        <a href="/qr" class="quick-btn btn-success" style="text-decoration:none">📱 QR Code</a>
        <button class="quick-btn btn-danger" onclick="logout()">🚪 Déconnexion</button>
      </div>
      
      <!-- Stats -->
      <div class="stats-grid">
        <div class="stat-card">
          <div class="emoji">👥</div>
          <div class="number" id="statUsers">0</div>
          <div class="label">Total Users</div>
        </div>
        <div class="stat-card">
          <div class="emoji">👑</div>
          <div class="number" id="statOwners">0</div>
          <div class="label">Owners</div>
        </div>
        <div class="stat-card">
          <div class="emoji">⚡</div>
          <div class="number" id="statSudos">0</div>
          <div class="label">Sudos</div>
        </div>
        <div class="stat-card">
          <div class="emoji">🚫</div>
          <div class="number" id="statBanned">0</div>
          <div class="label">Bannis</div>
        </div>
        <div class="stat-card">
          <div class="emoji">⚠️</div>
          <div class="number" id="statLimited">0</div>
          <div class="label">Limités</div>
        </div>
        <div class="stat-card">
          <div class="emoji">📨</div>
          <div class="number" id="statMessages">0</div>
          <div class="label">Messages</div>
        </div>
      </div>
      
      <!-- Users Management -->
      <div class="users-section">
        <h3 style="margin-bottom:15px">👥 Gestion des Utilisateurs</h3>
        
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="🔍 Rechercher par numéro ou nom..." onkeyup="filterUsers()">
          <select id="filterRole" class="filter-select" onchange="filterUsers()">
            <option value="">Tous les rôles</option>
            <option value="owner">👑 Owner</option>
            <option value="sudo">⚡ Sudo</option>
            <option value="approved">✅ Approved</option>
            <option value="user">👤 User</option>
          </select>
          <select id="filterStatus" class="filter-select" onchange="filterUsers()">
            <option value="">Tous les statuts</option>
            <option value="active">✅ Actifs</option>
            <option value="banned">🚫 Bannis</option>
            <option value="limited">⚠️ Limités</option>
          </select>
        </div>
        
        <div style="overflow-x:auto;">
          <table>
            <thead>
              <tr>
                <th>📱 Numéro</th>
                <th>👤 Nom</th>
                <th>🎭 Rôle</th>
                <th>📊 Statut</th>
                <th>💬 Msgs</th>
                <th>⚡ Actions</th>
              </tr>
            </thead>
            <tbody id="usersTableBody">
              <tr><td colspan="6" style="text-align:center;padding:30px">Chargement...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Modal Limitation -->
  <div id="limitModal" class="modal">
    <div class="modal-content">
      <h3>⚠️ Limiter l'utilisateur</h3>
      <p id="limitUserName" style="margin-bottom:15px;color:#aaa"></p>
      <select id="limitLevel">
        <option value="1">Niveau 1 - Basique (menu, help seulement)</option>
        <option value="2">Niveau 2 - Pas de téléchargement ni IA</option>
        <option value="3">Niveau 3 - Commandes fun uniquement</option>
      </select>
      <div class="modal-btns">
        <button onclick="closeModal()" style="background:#666;color:#fff">Annuler</button>
        <button onclick="confirmLimit()" style="background:#ffd93d;color:#333">Appliquer</button>
      </div>
    </div>
  </div>
  
  <!-- Modal Rôle -->
  <div id="roleModal" class="modal">
    <div class="modal-content">
      <h3>👑 Changer le rôle</h3>
      <p id="roleUserName" style="margin-bottom:15px;color:#aaa"></p>
      <select id="newRole">
        <option value="user">👤 User - Accès normal</option>
        <option value="approved">✅ Approved - Accès vérifié</option>
        <option value="sudo">⚡ Sudo - Accès étendu</option>
        <option value="owner">👑 Owner - Accès total</option>
      </select>
      <div class="modal-btns">
        <button onclick="closeModal()" style="background:#666;color:#fff">Annuler</button>
        <button onclick="confirmRole()" style="background:#9c27b0;color:#fff">Appliquer</button>
      </div>
    </div>
  </div>

  <script>
    let adminToken = localStorage.getItem('hani_admin_token');
    let allUsers = [];
    let currentUserJid = null;
    
    window.onload = function() {
      if (adminToken) checkSession();
      document.getElementById('codeInput').addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
    };
    
    async function login() {
      const code = document.getElementById('codeInput').value;
      const errorMsg = document.getElementById('errorMsg');
      errorMsg.style.display = 'none';
      
      try {
        const res = await fetch('/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        const data = await res.json();
        
        if (data.success) {
          adminToken = data.token;
          localStorage.setItem('hani_admin_token', adminToken);
          showDashboard();
        } else {
          errorMsg.style.display = 'block';
          document.getElementById('codeInput').value = '';
        }
      } catch (e) {
        errorMsg.textContent = '❌ Erreur de connexion';
        errorMsg.style.display = 'block';
      }
    }
    
    async function checkSession() {
      try {
        const res = await fetch('/api/admin/check', { headers: { 'X-Admin-Token': adminToken } });
        const data = await res.json();
        if (data.valid) showDashboard();
        else { localStorage.removeItem('hani_admin_token'); adminToken = null; }
      } catch (e) { localStorage.removeItem('hani_admin_token'); adminToken = null; }
    }
    
    function showDashboard() {
      document.getElementById('loginPage').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      refreshStats();
    }
    
    function logout() {
      fetch('/admin/logout', { method: 'POST', headers: { 'X-Admin-Token': adminToken } });
      localStorage.removeItem('hani_admin_token');
      adminToken = null;
      location.reload();
    }
    
    async function refreshStats() {
      try {
        const res = await fetch('/api/admin/stats', { headers: { 'X-Admin-Token': adminToken } });
        if (res.status === 401) { logout(); return; }
        const data = await res.json();
        if (!data.success) return;
        
        // Bot status
        const botStatus = document.getElementById('botStatus');
        botStatus.className = 'status-indicator ' + (data.bot.connected ? 'status-online' : 'status-offline');
        botStatus.textContent = data.bot.connected ? '🟢 Bot Connecté' : '🔴 Déconnecté';
        
        // Stats
        document.getElementById('statUsers').textContent = data.local.totalUsers;
        document.getElementById('statOwners').textContent = data.local.owners;
        document.getElementById('statSudos').textContent = data.local.sudos;
        document.getElementById('statBanned').textContent = data.local.banned || 0;
        document.getElementById('statLimited').textContent = data.local.limited || 0;
        document.getElementById('statMessages').textContent = data.local.messages;
        
        // Users
        allUsers = data.local.users || [];
        renderUsers(allUsers);
        
      } catch (e) { console.error('Erreur:', e); }
    }
    
    function renderUsers(users) {
      const tbody = document.getElementById('usersTableBody');
      if (!users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:30px">Aucun utilisateur</td></tr>';
        return;
      }
      
      tbody.innerHTML = users.map(u => {
        let statusBadge = '<span class="status-badge status-active">✅ Actif</span>';
        if (u.isBanned) statusBadge = '<span class="status-badge status-banned">🚫 Banni</span>';
        else if (u.isLimited) statusBadge = '<span class="status-badge status-limited">⚠️ Limité</span>';
        
        // Échapper les valeurs pour éviter les problèmes de syntaxe
        const safeJid = u.jid.replace(/'/g, "\\\\'");
        const safeName = (u.name || 'Inconnu').replace(/'/g, "\\\\'");
        const safeRole = u.role || 'user';
        
        // Admin a le contrôle total sur tous les utilisateurs, y compris les owners
        let actions = '';
        if (u.isBanned) {
          actions += '<button class="action-btn btn-unban" onclick="unbanUser(\\'' + safeJid + '\\')">✅ Débannir</button>';
        } else {
          actions += '<button class="action-btn btn-ban" onclick="banUser(\\'' + safeJid + '\\')">🚫 Bannir</button>';
        }
        
        if (u.isLimited) {
          actions += '<button class="action-btn btn-unlimit" onclick="unlimitUser(\\'' + safeJid + '\\')">🔓 Délimiter</button>';
        } else {
          actions += '<button class="action-btn btn-limit" onclick="openLimitModal(\\'' + safeJid + '\\', \\'' + safeName + '\\')">⚠️ Limiter</button>';
        }
        
        actions += '<button class="action-btn btn-role" onclick="openRoleModal(\\'' + safeJid + '\\', \\'' + safeName + '\\', \\'' + safeRole + '\\')">👑</button>';
        actions += '<button class="action-btn btn-delete" onclick="deleteUser(\\'' + safeJid + '\\')">🗑️</button>';
        
        return '<tr>' +
          '<td>' + u.number + '</td>' +
          '<td>' + (u.name || 'Inconnu') + (u.isBot ? ' 🤖' : '') + '</td>' +
          '<td><span class="role-badge role-' + safeRole + '">' + safeRole + '</span></td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + (u.messages || 0) + '</td>' +
          '<td><div class="action-btns">' + actions + '</div></td>' +
          '</tr>';
      }).join('');
    }
    
    function filterUsers() {
      const search = document.getElementById('searchInput').value.toLowerCase();
      const roleFilter = document.getElementById('filterRole').value;
      const statusFilter = document.getElementById('filterStatus').value;
      
      let filtered = allUsers.filter(u => {
        const matchSearch = u.number.includes(search) || u.name.toLowerCase().includes(search);
        const matchRole = !roleFilter || u.role === roleFilter;
        let matchStatus = true;
        if (statusFilter === 'banned') matchStatus = u.isBanned;
        else if (statusFilter === 'limited') matchStatus = u.isLimited;
        else if (statusFilter === 'active') matchStatus = !u.isBanned && !u.isLimited;
        return matchSearch && matchRole && matchStatus;
      });
      
      renderUsers(filtered);
    }
    
    async function banUser(jid) {
      if (!confirm('Bannir cet utilisateur ?')) return;
      await apiAction('/api/admin/ban', { jid });
    }
    
    async function unbanUser(jid) {
      await apiAction('/api/admin/unban', { jid });
    }
    
    function openLimitModal(jid, name) {
      currentUserJid = jid;
      document.getElementById('limitUserName').textContent = name + ' (' + jid.split('@')[0] + ')';
      document.getElementById('limitModal').classList.add('show');
    }
    
    async function confirmLimit() {
      const level = document.getElementById('limitLevel').value;
      await apiAction('/api/admin/limit', { jid: currentUserJid, level: parseInt(level) });
      closeModal();
    }
    
    async function unlimitUser(jid) {
      await apiAction('/api/admin/unlimit', { jid });
    }
    
    function openRoleModal(jid, name, currentRole) {
      currentUserJid = jid;
      document.getElementById('roleUserName').textContent = name + ' (' + jid.split('@')[0] + ')';
      document.getElementById('newRole').value = currentRole;
      document.getElementById('roleModal').classList.add('show');
    }
    
    async function confirmRole() {
      const role = document.getElementById('newRole').value;
      await apiAction('/api/admin/role', { jid: currentUserJid, role });
      closeModal();
    }
    
    async function deleteUser(jid) {
      if (!confirm('Supprimer définitivement cet utilisateur ?')) return;
      await apiAction('/api/admin/delete', { jid });
    }
    
    async function apiAction(url, body) {
      try {
        console.log('[ADMIN] Appel API:', url, body);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
          body: JSON.stringify(body)
        });
        
        if (!res.ok) {
          const errorText = await res.text();
          console.error('[ADMIN] Erreur HTTP:', res.status, errorText);
          showToast('Erreur HTTP ' + res.status + ': ' + errorText, 'error');
          return;
        }
        
        const data = await res.json();
        console.log('[ADMIN] Réponse:', data);
        showToast(data.message || (data.success ? 'Succès!' : (data.error || 'Erreur')), data.success ? 'success' : 'error');
        if (data.success) refreshStats();
      } catch (e) {
        console.error('[ADMIN] Exception:', e);
        showToast('Erreur: ' + e.message, 'error');
      }
    }
    
    function closeModal() {
      document.querySelectorAll('.modal').forEach(m => m.classList.remove('show'));
      currentUserJid = null;
    }
    
    function showToast(msg, type) {
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.textContent = msg;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    }
    
    // Auto-refresh toutes les 30s
    setInterval(refreshStats, 30000);
  </script>
</body>
</html>
  `);
});

// Health check pour Render
app.get("/health", (req, res) => {
  res.status(200).json({ 
    status: "ok", 
    uptime: process.uptime(),
    connected: qrState.isConnected,
    connectionStatus: qrState.connectionStatus,
    mysql: mysqlDB.isConnected()
  });
});

// 🗄️ API MySQL Status - Test de connexion
app.get("/api/mysql-status", async (req, res) => {
  try {
    const isConnected = mysqlDB.isConnected();
    let stats = null;
    let tables = [];
    
    if (isConnected) {
      stats = await mysqlDB.getDashboardStats();
      // Liste des tables
      const pool = await mysqlDB.getPool();
      if (pool) {
        const [rows] = await pool.query('SHOW TABLES');
        tables = rows.map(r => Object.values(r)[0]);
      }
    }
    
    res.json({
      success: true,
      mysql: {
        connected: isConnected,
        host: process.env.MYSQL_HOST || 'Non configuré',
        database: process.env.MYSQL_DATABASE || 'Non configuré',
        tables: tables,
        stats: stats
      },
      local: {
        users: Object.keys(db.data.users || {}).length,
        groups: Object.keys(db.data.groups || {}).length,
        stats: db.data.stats
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      mysql: { connected: false },
      timestamp: new Date().toISOString()
    });
  }
});

// 🔄 API pour tester la connexion MySQL
app.post("/api/mysql-test", async (req, res) => {
  try {
    if (mysqlDB.isConnected()) {
      // Test de lecture/écriture
      await mysqlDB.incrementStats('commands');
      const stats = await mysqlDB.getStats();
      res.json({
        success: true,
        message: "MySQL fonctionne correctement!",
        test: {
          read: true,
          write: true,
          stats: stats
        }
      });
    } else {
      // Tenter une connexion
      const connected = await mysqlDB.connect();
      res.json({
        success: connected,
        message: connected ? "Connexion MySQL établie!" : "Échec de connexion - Vérifiez vos identifiants"
      });
    }
  } catch (error) {
    res.json({
      success: false,
      error: error.message
    });
  }
});

// API pour obtenir l'état du QR (pour AJAX) - Accessible publiquement pour la page QR
app.get("/api/qr-status", (req, res) => {
  res.json({
    status: qrState.connectionStatus,
    isConnected: qrState.isConnected,
    hasQR: !!qrState.qrDataURL,
    qrDataURL: qrState.qrDataURL,
    lastUpdate: qrState.lastUpdate,
    qrCount: qrState.qrCount,
    botInfo: qrState.botInfo
  });
});

// 📸 PAGE QR SIMPLE - Affiche juste l'image QR (plus fiable)
app.get("/qr-simple", (req, res) => {
  if (qrState.isConnected) {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>✅ HANI-MD Connecté</title>
  <style>
    body { font-family: Arial; background: #1a1a2e; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; flex-direction: column; }
    h1 { color: #4CAF50; font-size: 3em; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <h1>✅ Connecté!</h1>
  <p>Le bot HANI-MD est maintenant actif.</p>
  <p style="margin-top: 20px;"><a href="/" style="color: #9c27b0;">← Retour</a></p>
</body>
</html>`);
  } else if (qrState.qrDataURL) {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="5">
  <title>📱 HANI-MD - Scanne le QR</title>
  <style>
    body { font-family: Arial; background: #1a1a2e; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; flex-direction: column; }
    img { border-radius: 15px; box-shadow: 0 0 30px rgba(156,39,176,0.5); }
    h2 { color: #9c27b0; margin-bottom: 20px; }
    p { color: #aaa; font-size: 0.9em; margin-top: 15px; }
    .refresh { color: #ff9800; }
  </style>
</head>
<body>
  <h2>📱 Scanne avec WhatsApp</h2>
  <img src="${qrState.qrDataURL}" alt="QR Code" width="300">
  <p>⏱️ Page auto-refresh toutes les 5 secondes</p>
  <p class="refresh">Si expiré, attendez le nouveau QR...</p>
</body>
</html>`);
  } else {
    res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3">
  <title>⏳ HANI-MD - En attente</title>
  <style>
    body { font-family: Arial; background: #1a1a2e; color: #fff; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; flex-direction: column; }
    .loader { width: 50px; height: 50px; border: 5px solid #333; border-top: 5px solid #9c27b0; border-radius: 50%; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { margin-top: 20px; color: #aaa; }
  </style>
</head>
<body>
  <div class="loader"></div>
  <p>Génération du QR code en cours...</p>
  <p style="font-size: 0.8em;">Page auto-refresh toutes les 3 secondes</p>
</body>
</html>`);
  }
});

// 📱 PAGE QR CODE - SÉCURISÉE (Owner uniquement)
app.get("/qr", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🔐 HANI-MD - QR Code Privé</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .logo { font-size: 3em; margin-bottom: 10px; }
    h1 { color: #fff; font-size: 2em; margin-bottom: 5px; }
    .subtitle { color: #aaa; font-size: 0.9em; margin-bottom: 20px; }
    
    .qr-container {
      background: white;
      border-radius: 16px;
      padding: 20px;
      margin: 15px 0;
      min-height: 280px;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    }
    .qr-container img { max-width: 100%; border-radius: 8px; }
    
    .countdown-bar {
      height: 6px;
      background: linear-gradient(90deg, #4CAF50, #8BC34A);
      border-radius: 3px;
      margin: 10px 0;
      transition: width 1s linear;
    }
    .countdown-bar.warning { background: linear-gradient(90deg, #ff9800, #ffc107); }
    .countdown-bar.danger { background: linear-gradient(90deg, #f44336, #ff5722); }
    
    .countdown-text {
      color: #fff;
      font-size: 1.2em;
      font-weight: bold;
      margin: 10px 0;
    }
    .countdown-text.warning { color: #ffc107; }
    .countdown-text.danger { color: #f44336; animation: pulse 0.5s infinite; }
    
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    
    .status {
      padding: 12px 24px;
      border-radius: 50px;
      font-weight: bold;
      margin: 15px 0;
      display: inline-block;
    }
    .status.waiting { background: #ff9800; color: #000; }
    .status.waiting_qr { background: #2196F3; color: #fff; }
    .status.connecting { background: #9c27b0; color: #fff; }
    .status.connected { background: #4CAF50; color: #fff; }
    .status.disconnected { background: #f44336; color: #fff; }
    
    .refresh-btn {
      background: linear-gradient(135deg, #9c27b0, #673ab7);
      color: #fff;
      border: none;
      padding: 12px 30px;
      border-radius: 25px;
      font-size: 1em;
      cursor: pointer;
      margin: 10px 5px;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .refresh-btn:hover {
      transform: scale(1.05);
      box-shadow: 0 5px 20px rgba(156, 39, 176, 0.4);
    }
    .refresh-btn:disabled {
      background: #666;
      cursor: not-allowed;
      transform: none;
    }
    
    .instructions {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 15px;
      margin-top: 15px;
      text-align: left;
    }
    .instructions h3 { color: #fff; margin-bottom: 10px; font-size: 1em; }
    .instructions ol { color: #ccc; padding-left: 20px; font-size: 0.9em; }
    .instructions li { margin: 8px 0; line-height: 1.4; }
    
    .bot-info {
      background: rgba(76, 175, 80, 0.2);
      border: 2px solid #4CAF50;
      border-radius: 16px;
      padding: 25px;
      margin-top: 20px;
    }
    .bot-info h3 { color: #4CAF50; margin-bottom: 15px; font-size: 1.5em; }
    .bot-info p { color: #fff; margin: 8px 0; font-size: 1.1em; }
    
    .loader {
      width: 60px;
      height: 60px;
      border: 5px solid rgba(0,0,0,0.1);
      border-left-color: #2196F3;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    
    .error-box {
      background: rgba(244, 67, 54, 0.2);
      border: 1px solid #f44336;
      border-radius: 12px;
      padding: 20px;
      margin: 15px 0;
      color: #fff;
    }
    
    .qr-expired {
      text-align: center;
      padding: 30px;
    }
    .qr-expired .icon { font-size: 4em; margin-bottom: 10px; }
    .qr-expired p { color: #ff9800; font-size: 1.1em; margin: 10px 0; }
    
    .footer {
      margin-top: 20px;
      color: #666;
      font-size: 0.8em;
    }
    .footer a { color: #9c27b0; text-decoration: none; }
    
    .debug-info {
      background: rgba(0,0,0,0.3);
      border-radius: 8px;
      padding: 10px;
      margin-top: 15px;
      font-size: 0.75em;
      color: #888;
      text-align: left;
    }
    
    @media (max-width: 500px) {
      .container { padding: 20px; }
      .logo { font-size: 2em; }
      h1 { font-size: 1.5em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🌟</div>
    <h1>HANI-MD</h1>
    <p class="subtitle">Bot WhatsApp Intelligent par H2025</p>
    
    <div id="status-container">
      <div class="status disconnected" id="status-badge">⏳ Chargement...</div>
    </div>
    
    <div id="countdown-container" style="display:none;">
      <div class="countdown-text" id="countdown-text">⏱️ 60 secondes restantes</div>
      <div class="countdown-bar" id="countdown-bar" style="width: 100%"></div>
    </div>
    
    <div class="qr-container" id="qr-container">
      <div class="loader"></div>
    </div>
    
    <div id="buttons-container">
      <button class="refresh-btn" id="refresh-btn" onclick="forceRefresh()">🔄 Nouveau QR Code</button>
    </div>
    
    <div id="instructions" class="instructions">
      <h3>📱 Comment scanner :</h3>
      <ol>
        <li>Ouvre <strong>WhatsApp</strong> sur ton téléphone</li>
        <li>Menu <strong>⋮</strong> → <strong>Appareils connectés</strong></li>
        <li>Clique <strong>"Connecter un appareil"</strong></li>
        <li><strong>Scanne rapidement</strong> le QR code (60s max)</li>
      </ol>
    </div>
    
    <div id="bot-info" class="bot-info" style="display:none;">
      <h3>🎉 Connecté avec succès!</h3>
      <p id="bot-name">🤖 Chargement...</p>
      <p id="bot-number">📱 Chargement...</p>
      <p style="margin-top:15px;font-size:0.9em;color:#8BC34A;">Le bot est maintenant actif!</p>
    </div>
    
    <div class="debug-info" id="debug-info">
      <strong>Debug:</strong> <span id="debug-status">Initialisation...</span><br>
      <strong>QR Count:</strong> <span id="debug-qr-count">0</span> | 
      <strong>Last Update:</strong> <span id="debug-last-update">-</span>
    </div>
    
    <div class="footer">
      <p>Créé avec ❤️ par <a href="#">H2025</a></p>
      <p><a href="/">← Retour</a> | <a href="/admin">🔐 Admin</a></p>
    </div>
  </div>

  <script>
    let lastQrCount = 0;
    let qrStartTime = null;
    let countdownInterval = null;
    const QR_TIMEOUT = 60; // 60 secondes
    
    function startCountdown() {
      qrStartTime = Date.now();
      document.getElementById('countdown-container').style.display = 'block';
      
      if (countdownInterval) clearInterval(countdownInterval);
      
      countdownInterval = setInterval(() => {
        if (!qrStartTime) return;
        
        const elapsed = Math.floor((Date.now() - qrStartTime) / 1000);
        const remaining = Math.max(0, QR_TIMEOUT - elapsed);
        const percent = (remaining / QR_TIMEOUT) * 100;
        
        const bar = document.getElementById('countdown-bar');
        const text = document.getElementById('countdown-text');
        
        bar.style.width = percent + '%';
        
        if (remaining <= 10) {
          bar.className = 'countdown-bar danger';
          text.className = 'countdown-text danger';
          text.textContent = '⚠️ ' + remaining + 's - SCANNE VITE!';
        } else if (remaining <= 20) {
          bar.className = 'countdown-bar warning';
          text.className = 'countdown-text warning';
          text.textContent = '⏱️ ' + remaining + ' secondes restantes';
        } else {
          bar.className = 'countdown-bar';
          text.className = 'countdown-text';
          text.textContent = '⏱️ ' + remaining + ' secondes restantes';
        }
        
        if (remaining <= 0) {
          showExpired();
        }
      }, 1000);
    }
    
    function stopCountdown() {
      if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
      }
      qrStartTime = null;
      document.getElementById('countdown-container').style.display = 'none';
    }
    
    function showExpired() {
      stopCountdown();
      document.getElementById('qr-container').innerHTML = '<div class="qr-expired"><div class="icon">⏰</div><p><strong>QR Code expiré!</strong></p><p>Clique sur le bouton pour en générer un nouveau</p></div>';
      document.getElementById('status-badge').textContent = '⏰ QR Expiré';
      document.getElementById('status-badge').className = 'status disconnected';
    }
    
    async function forceRefresh() {
      const btn = document.getElementById('refresh-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Chargement...';
      
      // Recharger la page pour forcer un nouveau QR
      window.location.reload();
    }
    
    async function updateQR() {
      try {
        const response = await fetch('/api/qr-status');
        const data = await response.json();
        
        // Debug info
        document.getElementById('debug-status').textContent = data.status;
        document.getElementById('debug-qr-count').textContent = data.qrCount || 0;
        document.getElementById('debug-last-update').textContent = data.lastUpdate ? new Date(data.lastUpdate).toLocaleTimeString() : '-';
        
        const statusBadge = document.getElementById('status-badge');
        const qrContainer = document.getElementById('qr-container');
        const instructions = document.getElementById('instructions');
        const botInfo = document.getElementById('bot-info');
        const refreshBtn = document.getElementById('refresh-btn');
        
        if (data.status === 'connected' || data.isConnected) {
          // CONNECTÉ !
          stopCountdown();
          statusBadge.textContent = '✅ Connecté';
          statusBadge.className = 'status connected';
          qrContainer.innerHTML = '<div style="text-align:center;color:#4CAF50;font-size:5em;">✓</div>';
          instructions.style.display = 'none';
          botInfo.style.display = 'block';
          refreshBtn.style.display = 'none';
          
          if (data.botInfo) {
            document.getElementById('bot-name').textContent = '🤖 ' + (data.botInfo.name || 'HANI-MD');
            document.getElementById('bot-number').textContent = '📱 ' + (data.botInfo.number || 'Connecté');
          }
          
        } else if (data.hasQR && data.qrDataURL) {
          // QR CODE DISPONIBLE
          statusBadge.textContent = '📱 Scanne le QR Code!';
          statusBadge.className = 'status waiting_qr';
          
          // Nouveau QR code?
          if (data.qrCount !== lastQrCount) {
            lastQrCount = data.qrCount;
            qrContainer.innerHTML = '<img src="' + data.qrDataURL + '" alt="QR Code" />';
            startCountdown();
          }
          
          instructions.style.display = 'block';
          botInfo.style.display = 'none';
          refreshBtn.style.display = 'inline-block';
          refreshBtn.disabled = false;
          refreshBtn.textContent = '🔄 Nouveau QR Code';
          
        } else if (data.status === 'connecting') {
          // CONNEXION EN COURS
          stopCountdown();
          statusBadge.textContent = '🔄 Connexion en cours...';
          statusBadge.className = 'status connecting';
          qrContainer.innerHTML = '<div class="loader"></div><p style="color:#333;margin-top:15px;">Vérification...</p>';
          refreshBtn.disabled = true;
          
        } else {
          // EN ATTENTE
          statusBadge.textContent = '⏳ En attente du QR...';
          statusBadge.className = 'status waiting';
          qrContainer.innerHTML = '<div class="loader"></div><p style="color:#333;margin-top:15px;">Génération du QR code...</p>';
          refreshBtn.disabled = false;
        }
        
      } catch (error) {
        console.error('Erreur:', error);
        document.getElementById('debug-status').textContent = 'Erreur: ' + error.message;
      }
    }
    
    // Première mise à jour immédiate
    updateQR();
    
    // Actualisation toutes les 2 secondes
    setInterval(updateQR, 2000);
  </script>
</body>
</html>
  `);
});

// Page d'accueil mise à jour
app.get("/", (req, res) => {
  const uptime = formatUptime(Date.now() - db.data.stats.startTime);
  const statusColor = qrState.isConnected ? "#4CAF50" : "#ff9800";
  const statusText = qrState.isConnected ? "✅ Connecté" : "⏳ En attente de connexion";
  
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HANI-MD - Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: linear-gradient(135deg, #0f0c29, #302b63, #24243e);
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      background: rgba(255,255,255,0.1);
      backdrop-filter: blur(10px);
      border-radius: 24px;
      padding: 40px;
      max-width: 500px;
      width: 100%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { color: #fff; font-size: 2.5em; margin-bottom: 10px; }
    .status {
      display: inline-block;
      padding: 10px 20px;
      border-radius: 50px;
      font-weight: bold;
      margin: 15px 0;
      background: ${statusColor};
      color: ${qrState.isConnected ? '#fff' : '#000'};
    }
    .stats {
      background: rgba(255,255,255,0.05);
      border-radius: 12px;
      padding: 20px;
      margin: 20px 0;
    }
    .stat-item {
      display: flex;
      justify-content: space-between;
      padding: 10px 0;
      border-bottom: 1px solid rgba(255,255,255,0.1);
      color: #fff;
    }
    .stat-item:last-child { border: none; }
    .stat-value { color: #4CAF50; font-weight: bold; }
    .btn {
      display: inline-block;
      padding: 15px 30px;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
      text-decoration: none;
      border-radius: 50px;
      font-weight: bold;
      margin: 10px;
      transition: transform 0.3s;
    }
    .btn:hover { transform: scale(1.05); }
    .btn.secondary { background: rgba(255,255,255,0.1); }
    .footer { color: #666; margin-top: 30px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🌟 HANI-MD</h1>
    <p style="color:#aaa;">Bot WhatsApp Intelligent par H2025</p>
    
    <div class="status">${statusText}</div>
    
    <div class="stats">
      <div class="stat-item">
        <span>⏱️ Uptime</span>
        <span class="stat-value">${uptime}</span>
      </div>
      <div class="stat-item">
        <span>📨 Commandes</span>
        <span class="stat-value">${db.data.stats.commands}</span>
      </div>
      <div class="stat-item">
        <span>👥 Utilisateurs</span>
        <span class="stat-value">${Object.keys(db.data.users).length}</span>
      </div>
      <div class="stat-item">
        <span>🏘️ Groupes</span>
        <span class="stat-value">${Object.keys(db.data.groups).length}</span>
      </div>
      <div class="stat-item">
        <span>🌐 Mode</span>
        <span class="stat-value">${config.MODE}</span>
      </div>
    </div>
    
    <a href="/qr" class="btn">📱 Scanner QR Code</a>
    <a href="/health" class="btn secondary">🔍 Health Check</a>
    
    <div class="footer">
      <p>Version 1.0 | <a href="https://github.com/itestmypartner/HANI" style="color:#9c27b0;">GitHub</a></p>
    </div>
  </div>
</body>
</html>
  `);
});

app.listen(port, () => {
  console.log(`[WEB] Serveur web sur le port ${port}`);
  console.log(`[QR] Page QR Code: http://localhost:${port}/qr`);
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
