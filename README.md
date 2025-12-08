# 🌟 HANI-MD - Bot WhatsApp Intelligent

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.0.0-blue.svg" alt="Version">
  <img src="https://img.shields.io/badge/Node.js-18+-green.svg" alt="Node.js">
  <img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License">
  <img src="https://img.shields.io/badge/WhatsApp-Multi--Device-brightgreen.svg" alt="WhatsApp">
</p>

<p align="center">
  <b>🔥 Bot WhatsApp puissant avec fonctionnalités avancées de surveillance, protection et extraction 🔥</b>
</p>

---

## ✨ Fonctionnalités Principales

### 🔐 Protection & Sécurité
| Fonction | Description |
|----------|-------------|
| Anti-Delete | Récupère automatiquement les messages supprimés |
| Anti-Spam | Protection contre le spam |
| Anti-Bot | Bloque les autres bots |
| Anti-Link | Supprime les liens non autorisés |
| Anti-Call | Bloque et rejette les appels |

### 🕵️ Surveillance Avancée
| Fonction | Description |
|----------|-------------|
| Spy Mode | Surveiller l'activité d'un utilisateur en temps réel |
| Interception Médias | Récupère automatiquement TOUTES les photos/vidéos des surveillés |
| Activity Tracker | Suivi complet: messages, groupes, dernière vue |
| Alertes instantanées | Notification à chaque activité |

### 👁️ Vue Unique (View Once)
- ✅ Interception automatique des photos/vidéos à vue unique
- ✅ Sauvegarde instantanée avant que l'expéditeur ne supprime
- ✅ Envoi en privé au propriétaire

### 📸 Statuts / Stories
- ✅ Sauvegarde automatique de tous les statuts
- ✅ Récupération des statuts supprimés
- ✅ Visualisation en privé

### 📁 Extraction de Médias
- ✅ Voir tous les médias reçus par utilisateur
- ✅ Télécharger images/vidéos/audios/documents
- ✅ Historique complet des fichiers

---

## 📋 Liste Complète des Commandes

### 📊 Général
| Commande | Description |
|----------|-------------|
| `.menu` | Afficher le menu complet |
| `.ping` | Vérifier la latence du bot |
| `.info` | Informations du bot |
| `.stats` | Statistiques d'utilisation |

### 🕵️ Espionnage & Surveillance
| Commande | Description |
|----------|-------------|
| `.spy @user` ou `.spy [numéro]` | Surveiller un utilisateur |
| `.unspy @user` | Arrêter la surveillance |
| `.spylist` | Liste des utilisateurs surveillés |
| `.activity` | Top 15 des utilisateurs les plus actifs |
| `.activity @user` | Voir l'activité détaillée d'un utilisateur |

### 📁 Extraction
| Commande | Description |
|----------|-------------|
| `.extract` | Liste des utilisateurs avec médias stockés |
| `.extract @user` | Voir les médias d'un utilisateur |
| `.getmedia [numéro] [n°]` | Télécharger un média spécifique |
| `.medialist` | Statistiques des médias stockés |
| `.clearmedia` | Supprimer les médias stockés |

### 🔐 Protection
| Commande | Description |
|----------|-------------|
| `.antidelete on/off` | Anti-suppression de messages |
| `.antispam on/off` | Anti-spam |
| `.anticall on/off` | Anti-appel |
| `.antilink on/off` | Anti-liens |
| `.antibot on/off` | Anti-bots |

### 👁️ Vue Unique
| Commande | Description |
|----------|-------------|
| `.vv` | Récupérer une vue unique (répondre au message) |
| `.listvv` | Liste des vues uniques interceptées |

### 📸 Statuts
| Commande | Description |
|----------|-------------|
| `.savestatus on/off` | Activer la sauvegarde auto |
| `.deletedstatus` | Voir les statuts supprimés |
| `.getstatus [n°]` | Récupérer un statut spécifique |
| `.liststatus` | Liste de tous les statuts |

### 👥 Groupe
| Commande | Description |
|----------|-------------|
| `.kick @user` | Expulser un membre |
| `.add [numéro]` | Ajouter un membre |
| `.promote @user` | Promouvoir en admin |
| `.demote @user` | Rétrograder |
| `.mute on/off` | Désactiver le bot |
| `.warn @user` | Avertir un membre |
| `.warnlist` | Liste des avertissements |

### 🎮 Fun
| Commande | Description |
|----------|-------------|
| `.sticker` | Créer un sticker (répondre à une image) |
| `.dice` | Lancer un dé |
| `.flip` | Pile ou face |
| `.quote` | Citation aléatoire |

### 🔧 Outils
| Commande | Description |
|----------|-------------|
| `.calc [expression]` | Calculatrice |
| `.tts [texte]` | Texte vers audio |
| `.tr [lang] [texte]` | Traduction |

### 👑 Owner Seulement
| Commande | Description |
|----------|-------------|
| `.ban @user` | Bannir du bot |
| `.unban @user` | Débannir |
| `.sudo @user` | Ajouter un admin bot |
| `.delsudo @user` | Retirer un admin bot |
| `.broadcast [msg]` | Diffuser dans tous les groupes |
| `.restart` | Redémarrer le bot |

---

## 🚀 Déploiement

### 📦 Installation Locale

```bash
# 1. Cloner le repo
git clone https://github.com/VOTRE_USERNAME/HANI-MD.git
cd HANI-MD

# 2. Installer les dépendances
npm install

# 3. Configurer le .env
cp .env.example .env
# Éditer .env avec vos informations

# 4. Lancer le bot
npm start

# 5. Scanner le QR code avec WhatsApp
```

### ☁️ Déploiement sur Render (Recommandé)

1. **Fork** ce repository sur GitHub
2. Allez sur [render.com](https://render.com) et connectez votre GitHub
3. Cliquez sur **New → Web Service**
4. Sélectionnez le repo **HANI-MD**
5. Configurez :
   - **Name**: `hani-md`
   - **Region**: `Frankfurt` (ou le plus proche)
   - **Build Command**: `npm install`
   - **Start Command**: `node hani.js`
6. Ajoutez les **Environment Variables** :
   ```
   PREFIXE = .
   NOM_OWNER = VotreNom
   NUMERO_OWNER = 22501XXXXXXXX
   MODE = public
   STICKER_PACK_NAME = HANI-MD
   STICKER_AUTHOR_NAME = VotreNom
   ```
7. Cliquez sur **Create Web Service**
8. Attendez le déploiement et scannez le QR code dans les logs

---

## ⚙️ Configuration

| Variable | Description | Exemple |
|----------|-------------|---------|
| `PREFIXE` | Préfixe des commandes | `.` |
| `NOM_OWNER` | Votre nom | `Hanie` |
| `NUMERO_OWNER` | Votre numéro WhatsApp (sans +) | `2250150252467` |
| `MODE` | `public` (tous) ou `private` (vous seul) | `public` |
| `STICKER_PACK_NAME` | Nom du pack de stickers | `HANI-MD` |
| `STICKER_AUTHOR_NAME` | Auteur des stickers | `Hanie` |

---

## 🔒 Sécurité

⚠️ **Important** :
- Ne partagez jamais votre fichier `.env`
- Ne partagez jamais le dossier `DataBase/session/`
- Utilisez les fonctionnalités de surveillance de manière éthique

---

## 📱 Support

- **Auteur**: H2025
- **Version**: 1.0.0
- **License**: MIT

---

<p align="center">
  <b>⭐ Si vous aimez ce projet, n'oubliez pas de mettre une étoile ! ⭐</b>
</p>
