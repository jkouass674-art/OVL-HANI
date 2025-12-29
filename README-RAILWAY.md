# 🚂 Déploiement HANI-MD sur Railway

Guide complet pour déployer HANI-MD sur Railway avec MySQL.

---

## 📋 Pré-requis

- ✅ Compte [Railway](https://railway.app)
- ✅ Code sur GitHub (repo: `jkouass674-art/OVL-HANI`)
- ✅ Railway CLI installé (optionnel mais recommandé)

---

## 🚀 Méthode 1 : Déploiement via Interface Web

### Étape 1 : Créer le projet
1. Connectez-vous sur [Railway](https://railway.app)
2. Cliquez sur **"New Project"**
3. Sélectionnez **"Deploy from GitHub repo"**
4. Choisissez le repo `OVL-HANI`

### Étape 2 : Ajouter MySQL
1. Dans votre projet, cliquez sur **"+ New"**
2. Sélectionnez **"Database" → "MySQL"**
3. Railway créera automatiquement une base de données

### Étape 3 : Configurer les variables
Allez dans **Variables** de votre service et ajoutez :

```env
# === CONFIGURATION BOT ===
PREFIXE=.
NOM_OWNER=H2025
NUMERO_OWNER=22550252467
MODE=public
SESSION_ID=votre_session_id

# === STICKERS ===
STICKER_PACK_NAME=HANI-MD
STICKER_AUTHOR_NAME=H2025

# === MySQL (Automatique si lié) ===
# Railway remplit automatiquement ces variables si vous liez MySQL
MYSQL_URL=${{MySQL.MYSQL_URL}}
# OU manuellement :
MYSQL_HOST=${{MySQL.MYSQLHOST}}
MYSQL_USER=${{MySQL.MYSQLUSER}}
MYSQL_PASSWORD=${{MySQL.MYSQLPASSWORD}}
MYSQL_DATABASE=${{MySQL.MYSQLDATABASE}}
MYSQL_PORT=${{MySQL.MYSQLPORT}}

# === OPTIONS ===
NODE_ENV=production
PORT=3000
```

### Étape 4 : Lier MySQL au Bot
1. Cliquez sur votre service Bot
2. Allez dans **Variables**
3. Cliquez sur **"Add Reference"**
4. Sélectionnez votre service MySQL
5. Les variables seront automatiquement injectées

### Étape 5 : Déployer
Cliquez sur **"Deploy"** - Railway déploiera automatiquement !

---

## 🖥️ Méthode 2 : Déploiement via CLI (Terminal)

### Installation Railway CLI

```bash
# Windows (PowerShell Admin)
iwr https://raw.githubusercontent.com/railwayapp/cli/master/install.ps1 -useb | iex

# Ou via npm
npm install -g @railway/cli
```

### Commandes de déploiement

```bash
# 1. Connexion à Railway
railway login

# 2. Initialiser le projet (dans le dossier du bot)
railway init

# 3. Ajouter MySQL
railway add --database mysql

# 4. Configurer les variables
railway variables set PREFIXE="."
railway variables set NOM_OWNER="H2025"
railway variables set NUMERO_OWNER="22550252467"
railway variables set MODE="public"
railway variables set SESSION_ID="votre_session_id"
railway variables set STICKER_PACK_NAME="HANI-MD"
railway variables set STICKER_AUTHOR_NAME="H2025"

# 5. Déployer
railway up

# 6. Voir les logs
railway logs
```

---

## 🗄️ Configuration MySQL

### Variables MySQL Railway
Quand vous ajoutez MySQL sur Railway, ces variables sont créées :
- `MYSQLHOST` - Hôte de la base
- `MYSQLPORT` - Port (généralement 3306)
- `MYSQLUSER` - Utilisateur
- `MYSQLPASSWORD` - Mot de passe
- `MYSQLDATABASE` - Nom de la base
- `MYSQL_URL` - URL complète de connexion

### Format URL MySQL
```
mysql://user:password@host:port/database
```

### Tables créées automatiquement
Le bot crée automatiquement ces tables au démarrage :
- `bot_settings` - Configuration du bot
- `users` - Utilisateurs et permissions
- `groups` - Paramètres des groupes
- `banned` - Utilisateurs bannis
- `warnings` - Avertissements
- `economy` - Système économique
- Et plus...

---

## 🔧 Commandes utiles Railway CLI

```bash
# Voir le statut
railway status

# Voir les logs en temps réel
railway logs -f

# Ouvrir le dashboard
railway open

# Redémarrer le service
railway service restart

# Voir les variables
railway variables

# Exécuter une commande dans le container
railway run node --version

# Supprimer le projet
railway delete
```

---

## 🩺 Dépannage

### Le bot ne démarre pas
```bash
# Vérifier les logs
railway logs -f

# Vérifier les variables
railway variables
```

### Erreur MySQL "Connection refused"
1. Vérifiez que MySQL est bien lié au service
2. Vérifiez que `MYSQL_URL` ou les variables individuelles sont définies
3. Attendez 1-2 minutes après la création de MySQL

### Erreur "SESSION_ID invalid"
1. Générez un nouveau SESSION_ID : https://hani-session.onrender.com
2. Mettez à jour la variable dans Railway

### Port non accessible
Railway assigne automatiquement le port via `$PORT`. Le bot utilise `process.env.PORT || 3000`.

---

## 📊 Monitoring

### Health Check
Le bot expose `/health` pour le monitoring :
```
https://votre-app.up.railway.app/health
```

### Page QR Code
```
https://votre-app.up.railway.app/qr
```

---

## 💰 Plans Railway

| Plan | RAM | CPU | Stockage | Prix |
|------|-----|-----|----------|------|
| Hobby | 512MB | Shared | 1GB | $5/mois |
| Pro | 8GB | 8 vCPU | 100GB | $20/mois |

Le plan Hobby est suffisant pour HANI-MD.

---

## 🔗 Liens utiles

- [Railway Dashboard](https://railway.app/dashboard)
- [Railway Docs](https://docs.railway.app)
- [Railway CLI](https://docs.railway.app/develop/cli)
- [HANI-MD GitHub](https://github.com/jkouass674-art/OVL-HANI)

---

## ⚡ Déploiement rapide (1 clic)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/hani-md?referralCode=hani)

---

*Guide créé pour HANI-MD v1.1 - Dernière mise à jour: Décembre 2025*
