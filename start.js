/**
 * OVL-MD-V2 - Connexion directe par QR Code
 * Lance ce fichier avec: node start.js
 * Scanne le QR code qui s'affiche dans le terminal avec WhatsApp
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
} = require("@whiskeysockets/baileys");

// Charger la configuration
require("dotenv").config({ override: true });

const config = {
  PREFIXE: process.env.PREFIXE || ".",
  NOM_OWNER: process.env.NOM_OWNER || "Owner",
  NUMERO_OWNER: process.env.NUMERO_OWNER || "",
  MODE: process.env.MODE || "public",
  STICKER_PACK_NAME: process.env.STICKER_PACK_NAME || "OVL-MD-V2",
  STICKER_AUTHOR_NAME: process.env.STICKER_AUTHOR_NAME || "OVL",
};

// Dossier de session
const SESSION_FOLDER = "./DataBase/session/principale";

// États simples pour activer/désactiver des protections (en mémoire)
const protectionState = {
  antilink: false,
  antispam: false,
  antibot: false,
  anticall: false,
  antitag: false,
  antidelete: true,  // Activé par défaut pour voir les messages supprimés
};

// Stockage des messages pour anti-delete (garde les 500 derniers messages)
const messageStore = new Map();
const MAX_STORED_MESSAGES = 500;

// Stockage des messages supprimés
const deletedMessages = [];
const MAX_DELETED_MESSAGES = 50;

// Extraction textuelle d'un message Baileys
function getMessageText(msg) {
  const type = Object.keys(msg.message || {})[0];
  if (!type) return "";
  if (type === "conversation") return msg.message.conversation || "";
  if (type === "extendedTextMessage") return msg.message.extendedTextMessage?.text || "";
  if (type === "imageMessage") return msg.message.imageMessage?.caption || "";
  if (type === "videoMessage") return msg.message.videoMessage?.caption || "";
  return "";
}

// Stockage des messages à vue unique interceptés
const viewOnceMessages = new Map();

// Réponses basiques et lisibles (bypass du code obfusqué)
async function handleCommand(ovl, msg) {
  const from = msg.key.remoteJid;
  const body = getMessageText(msg);
  if (!body || !body.startsWith(config.PREFIXE)) return;

  const [cmd, ...rest] = body.slice(config.PREFIXE.length).trim().split(/\s+/);
  const command = (cmd || "").toLowerCase();
  const args = rest.join(" ");

  // Numéro du bot (pour envoyer en privé)
  const botNumber = ovl.user?.id?.split(":")[0] + "@s.whatsapp.net";
  
  // Fonction pour répondre en privé (à soi-même)
  const sendPrivate = (text) => ovl.sendMessage(botNumber, { text });
  
  // Fonction pour répondre dans le chat actuel
  const sendHere = (text) => ovl.sendMessage(from, { text });

  const toggle = (key) => {
    protectionState[key] = !protectionState[key];
    return protectionState[key];
  };

  // Par défaut, répondre en privé sauf si on est déjà dans notre propre chat
  const isOwnChat = from === botNumber;
  const send = isOwnChat ? sendHere : sendPrivate;

  switch (command) {
    case "ping":
      return send("🏓 Pong! Le bot est en ligne.");
    case "menu":
    case "help": {
      const menuText = `
╭━━━━━━━━━━━━━━━━━━━━━╮
┃    🤖 OVL-MD-V2 (clean) 
┃━━━━━━━━━━━━━━━━━━━━━
┃ Préfixe : ${config.PREFIXE}
┃ Mode    : ${config.MODE}
┃ Owner   : ${config.NOM_OWNER}
┃
┃ 📌 Commandes générales :
┃ ${config.PREFIXE}ping
┃ ${config.PREFIXE}info
┃
┃ 👁️ Vue unique (View Once) :
┃ ${config.PREFIXE}vv (répondre à un msg)
┃ ${config.PREFIXE}listvv
┃
┃ 🗑️ Messages supprimés :
┃ ${config.PREFIXE}antidelete on/off
┃ ${config.PREFIXE}deleted (voir supprimés)
┃
┃ 🛡️ Protections :
┃ ${config.PREFIXE}antilink on/off
┃ ${config.PREFIXE}antispam on/off
┃ ${config.PREFIXE}antibot on/off
┃ ${config.PREFIXE}anticall on/off
┃ ${config.PREFIXE}antitag on/off
╰━━━━━━━━━━━━━━━━━━━━━╯`;
      return send(menuText);
    }
    case "info": {
      const infoText = `
🤖 OVL-MD-V2
• Numéro : ${ovl.user?.id?.split(":")[0] || "inconnu"}
• Owner  : ${config.NOM_OWNER}
• Mode   : ${config.MODE}
• Préfixe: ${config.PREFIXE}
• Antidelete: ${protectionState.antidelete ? "✅ Activé" : "❌ Désactivé"}
`;
      return send(infoText);
    }
    
    // === COMMANDES MESSAGES SUPPRIMÉS ===
    case "deleted":
    case "delmsg":
    case "msgdel": {
      if (deletedMessages.length === 0) {
        return send("📭 Aucun message supprimé intercepté récemment.");
      }
      
      let list = "🗑️ *Messages supprimés récents :*\n\n";
      const recent = deletedMessages.slice(-10); // Les 10 derniers
      recent.forEach((del, i) => {
        list += `${i + 1}. De: ${del.sender}\n`;
        list += `   Chat: ${del.chat}\n`;
        list += `   Type: ${del.type}\n`;
        if (del.text) list += `   Texte: "${del.text.substring(0, 100)}${del.text.length > 100 ? '...' : ''}"\n`;
        list += `   Date: ${del.date}\n\n`;
      });
      return send(list);
    }
    
    // === COMMANDES VUE UNIQUE ===
    case "vv":
    case "viewonce":
    case "vo": {
      // Récupérer le message auquel on répond
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      if (!quotedMsg) {
        return send("❌ Réponds à un message à vue unique pour le récupérer.");
      }
      
      // Vérifier si c'est un message à vue unique
      const viewOnceMsg = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2 || quotedMsg.viewOnceMessageV2Extension;
      if (!viewOnceMsg) {
        return send("❌ Ce message n'est pas un message à vue unique.");
      }
      
      try {
        const mediaMsg = viewOnceMsg.message;
        const mediaType = Object.keys(mediaMsg)[0];
        const media = mediaMsg[mediaType];
        
        // Télécharger le média
        const stream = await downloadMediaMessage(
          { message: mediaMsg, key: msg.key },
          "buffer",
          {},
          { logger: pino({ level: "silent" }), reuploadRequest: ovl.updateMediaMessage }
        );
        
        // Destination : privé si pas dans son propre chat
        const dest = isOwnChat ? from : botNumber;
        
        // Renvoyer le média sans vue unique (en privé)
        if (mediaType === "imageMessage") {
          await ovl.sendMessage(dest, { 
            image: stream, 
            caption: "👁️ Vue unique récupérée :\n" + (media.caption || "") 
          });
        } else if (mediaType === "videoMessage") {
          await ovl.sendMessage(dest, { 
            video: stream, 
            caption: "👁️ Vue unique récupérée :\n" + (media.caption || "") 
          });
        } else if (mediaType === "audioMessage") {
          await ovl.sendMessage(dest, { 
            audio: stream,
            mimetype: "audio/mp4"
          });
        } else {
          return send("❌ Type de média non supporté.");
        }
        
        console.log(`👁️ Vue unique récupérée pour ${from} (envoyée en privé)`);
      } catch (e) {
        console.log("⚠️ Erreur viewonce:", e.message);
        return send("❌ Impossible de récupérer ce média à vue unique.");
      }
      return;
    }
    
    case "listvv":
    case "listviewonce": {
      if (viewOnceMessages.size === 0) {
        return send("📭 Aucun message à vue unique intercepté récemment.");
      }
      
      let list = "👁️ *Messages à vue unique interceptés :*\n\n";
      let i = 1;
      for (const [id, data] of viewOnceMessages) {
        list += `${i}. De: ${data.sender}\n   Type: ${data.type}\n   Date: ${data.date}\n\n`;
        i++;
      }
      return send(list);
    }
    
    case "antilink":
    case "antispam":
    case "antibot":
    case "anticall":
    case "antitag":
    case "antidelete": {
      const key = command;
      const param = args.toLowerCase();
      if (param === "on") protectionState[key] = true;
      else if (param === "off") protectionState[key] = false;
      else protectionState[key] = toggle(key);
      return send(`🛡️ ${key} ${protectionState[key] ? "activé" : "désactivé"}.`);
    }
    default:
      return send(`❓ Commande inconnue : ${config.PREFIXE}${command}`);
  }
}

// Variable pour stocker l'instance du bot
let ovl = null;

async function startBot() {
  console.log("\n");
  console.log("╔════════════════════════════════════════╗");
  console.log("║       🤖 OVL-MD-V2 - Bot WhatsApp      ║");
  console.log("║    Connexion directe par QR Code       ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("\n");

  // Créer le dossier de session s'il n'existe pas
  if (!fs.existsSync(SESSION_FOLDER)) {
    fs.mkdirSync(SESSION_FOLDER, { recursive: true });
  }

  // Charger l'état d'authentification
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

  // Créer la connexion WhatsApp avec paramètres optimisés pour la stabilité
  ovl = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: "silent" }).child({ level: "silent" }),
      ),
    },
    logger: pino({ level: "silent" }),
    browser: ["OVL-MD-V2", "Chrome", "120.0.0"],  // Browser personnalisé plus stable
    keepAliveIntervalMs: 15000,         // Ping toutes les 15s pour maintenir la connexion active
    markOnlineOnConnect: false,         // Ne pas marquer en ligne (plus discret)
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,             // Ne pas synchroniser l'historique (plus stable)
    retryRequestDelayMs: 2000,          // Délai entre les tentatives
    connectTimeoutMs: 60000,            // Timeout de connexion plus long (60s)
    defaultQueryTimeoutMs: 60000,       // Timeout des requêtes plus long
    emitOwnEvents: true,                // Recevoir ses propres messages
    fireInitQueries: true,              // Initialiser les requêtes au démarrage
  });

  // Gérer les événements de connexion
  ovl.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 SCANNE CE QR CODE AVEC WHATSAPP:");
      console.log("   Menu → Appareils connectés → Connecter un appareil\n");
      qrcode.generate(qr, { small: true });
      console.log("\n");
    }

    if (connection === "connecting") {
      console.log("🔄 Connexion en cours...");
    }

    if (connection === "open") {
      console.log("\n");
      console.log("╔════════════════════════════════════════╗");
      console.log("║     ✅ CONNEXION RÉUSSIE !             ║");
      console.log("╚════════════════════════════════════════╝");
      console.log("\n");
      console.log("📊 Informations du bot:");
      console.log(`   • Préfixe: ${config.PREFIXE}`);
      console.log(`   • Mode: ${config.MODE}`);
      console.log(`   • Owner: ${config.NOM_OWNER}`);
      console.log("\n");
      console.log("🛡️ Commandes de protection disponibles:");
      console.log(`   • ${config.PREFIXE}antilink on/off`);
      console.log(`   • ${config.PREFIXE}antispam on/off`);
      console.log(`   • ${config.PREFIXE}antibot on/off`);
      console.log(`   • ${config.PREFIXE}anticall on/off`);
      console.log(`   • ${config.PREFIXE}antitag on/off`);
      console.log("\n");
      console.log("💡 Tape " + config.PREFIXE + "menu sur WhatsApp pour voir toutes les commandes");
      console.log("\n");

      // On ne charge plus les modules obfusqués pour éviter les erreurs (ex: sharp).
      console.log(
        "ℹ️ Modules obfusqués ignorés. Utilise les commandes simples intégrées (ping, menu, info, protections).",
      );
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || "Inconnue";

      console.log(`\n⚠️ Connexion fermée (code: ${statusCode}, raison: ${reason})`);

      // Reconnexion immédiate pour tous les cas sauf loggedOut explicite
      if (statusCode === DisconnectReason.loggedOut) {
        // Déconnexion manuelle - supprimer la session et redemander un QR
        console.log("❌ Déconnexion manuelle détectée depuis WhatsApp.");
        console.log("🔄 Suppression de la session et nouveau QR dans 3 secondes...");
        
        // Supprimer la session
        if (fs.existsSync(SESSION_FOLDER)) {
          fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
        }
        
        await delay(3000);
        startBot();
      } else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost ||
                 statusCode === DisconnectReason.timedOut ||
                 statusCode === DisconnectReason.restartRequired) {
        // Reconnexion rapide pour les problèmes de connexion temporaires
        console.log("🔄 Reconnexion immédiate...");
        await delay(1000);
        startBot();
      } else {
        // Autres erreurs - reconnexion standard
        console.log("🔄 Reconnexion dans 2 secondes...");
        await delay(2000);
        startBot();
      }
    }
  });

  // Sauvegarder les credentials
  ovl.ev.on("creds.update", saveCreds);

  // Gérer les messages avec le handler lisible ci-dessus
  ovl.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0];
      if (!msg || !msg.message) return;
      
      // Intercepter les messages à vue unique automatiquement
      const viewOnceContent = msg.message.viewOnceMessage || msg.message.viewOnceMessageV2 || msg.message.viewOnceMessageV2Extension;
      if (viewOnceContent && !msg.key.fromMe) {
        const sender = msg.key.remoteJid;
        const mediaMsg = viewOnceContent.message;
        const mediaType = Object.keys(mediaMsg || {})[0] || "inconnu";
        
        // Stocker le message à vue unique
        viewOnceMessages.set(msg.key.id, {
          sender: sender,
          type: mediaType.replace("Message", ""),
          date: new Date().toLocaleString("fr-FR"),
          message: msg
        });
        
        // Garder seulement les 20 derniers
        if (viewOnceMessages.size > 20) {
          const firstKey = viewOnceMessages.keys().next().value;
          viewOnceMessages.delete(firstKey);
        }
        
        console.log(`👁️ Vue unique interceptée de ${sender} (${mediaType})`);
      }
      
      // Stocker tous les messages pour anti-delete
      if (!msg.key.fromMe && msg.message) {
        const msgType = Object.keys(msg.message)[0];
        messageStore.set(msg.key.id, {
          key: msg.key,
          message: msg.message,
          sender: msg.key.remoteJid,
          pushName: msg.pushName || "Inconnu",
          timestamp: new Date(),
          type: msgType,
          text: getMessageText(msg)
        });
        
        // Limiter la taille du store
        if (messageStore.size > MAX_STORED_MESSAGES) {
          const firstKey = messageStore.keys().next().value;
          messageStore.delete(firstKey);
        }
      }
      
      // Log pour déboguer
      const body = getMessageText(msg);
      if (body) {
        console.log(`📩 Message reçu: "${body}" de ${msg.key.remoteJid} (fromMe: ${msg.key.fromMe})`);
      }
      
      // Traiter les commandes (même les messages envoyés par soi-même)
      await handleCommand(ovl, msg);
    } catch (e) {
      console.log("⚠️ Erreur message:", e.message);
    }
  });

  // Gérer les messages supprimés (messages.update)
  ovl.ev.on("messages.update", async (updates) => {
    if (!protectionState.antidelete) return;
    
    for (const update of updates) {
      // Détecter si le message a été supprimé
      if (update.update?.messageStubType === 1 || update.update?.message === null) {
        const msgId = update.key?.id;
        const storedMsg = messageStore.get(msgId);
        
        if (storedMsg) {
          console.log(`🗑️ Message supprimé détecté de ${storedMsg.sender}`);
          
          // Ajouter aux messages supprimés
          deletedMessages.push({
            sender: storedMsg.pushName,
            chat: storedMsg.sender,
            type: storedMsg.type?.replace("Message", "") || "texte",
            text: storedMsg.text,
            date: new Date().toLocaleString("fr-FR"),
            originalMessage: storedMsg
          });
          
          // Limiter la taille
          if (deletedMessages.length > MAX_DELETED_MESSAGES) {
            deletedMessages.shift();
          }
          
          // Envoyer le message supprimé à toi-même
          try {
            const myJid = ovl.user?.id;
            if (myJid) {
              let notifText = `🗑️ *Message supprimé détecté*\n\n`;
              notifText += `👤 De: ${storedMsg.pushName}\n`;
              notifText += `💬 Chat: ${storedMsg.sender}\n`;
              notifText += `📝 Type: ${storedMsg.type?.replace("Message", "")}\n`;
              notifText += `🕐 Date: ${new Date().toLocaleString("fr-FR")}\n`;
              if (storedMsg.text) {
                notifText += `\n📄 Contenu:\n"${storedMsg.text}"`;
              }
              
              await ovl.sendMessage(myJid, { text: notifText });
              
              // Si c'était un média, essayer de le renvoyer
              if (storedMsg.type === "imageMessage" || storedMsg.type === "videoMessage" || storedMsg.type === "audioMessage") {
                try {
                  const stream = await downloadMediaMessage(
                    { message: storedMsg.message, key: storedMsg.key },
                    "buffer",
                    {},
                    { logger: pino({ level: "silent" }), reuploadRequest: ovl.updateMediaMessage }
                  );
                  
                  if (storedMsg.type === "imageMessage") {
                    await ovl.sendMessage(myJid, { image: stream, caption: "🗑️ Image supprimée" });
                  } else if (storedMsg.type === "videoMessage") {
                    await ovl.sendMessage(myJid, { video: stream, caption: "🗑️ Vidéo supprimée" });
                  } else if (storedMsg.type === "audioMessage") {
                    await ovl.sendMessage(myJid, { audio: stream, mimetype: "audio/mp4" });
                  }
                } catch (mediaErr) {
                  console.log("⚠️ Impossible de récupérer le média supprimé");
                }
              }
            }
          } catch (e) {
            console.log("⚠️ Erreur notification antidelete:", e.message);
          }
        }
      }
    }
  });

  // Gérer les appels basiquement (bloquer si anticall actif)
  ovl.ev.on("call", async (calls) => {
    for (const call of calls || []) {
      if (call.status === "offer" && protectionState.anticall) {
        try {
          await ovl.rejectCall(call.id, call.from);
          await ovl.sendMessage(call.from, { text: "❌ Les appels sont désactivés sur ce bot." });
        } catch (e) {
          // Ignorer
        }
      }
    }
  });

  return ovl;
}

// Démarrer le serveur Express pour garder le bot actif
const express = require("express");
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🤖 OVL-MD-V2 Bot WhatsApp est en ligne !");
});

app.listen(port, () => {
  console.log(`🌐 Serveur web actif sur le port ${port}`);
});

// Lancer le bot
startBot().catch((err) => {
  console.error("❌ Erreur de démarrage:", err.message);
});

// Gérer les erreurs non capturées
process.on("uncaughtException", (err) => {
  console.log("⚠️ Erreur non capturée:", err.message);
});

process.on("unhandledRejection", (err) => {
  console.log("⚠️ Promesse rejetée:", err.message);
});
