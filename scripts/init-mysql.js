/**
 * 🗄️ Script d'initialisation MySQL pour HANI-MD
 * Crée toutes les tables nécessaires au fonctionnement du bot
 * 
 * Usage: node scripts/init-mysql.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

// Configuration MySQL
const getConfig = () => {
  if (process.env.MYSQL_URL) {
    return { uri: process.env.MYSQL_URL };
  }
  return {
    host: process.env.MYSQL_HOST || 'localhost',
    port: parseInt(process.env.MYSQL_PORT) || 3306,
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'hani_md',
    ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  };
};

// Schéma des tables
const TABLES = {
  // Configuration du bot
  bot_settings: `
    CREATE TABLE IF NOT EXISTS bot_settings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      bot_jid VARCHAR(50) UNIQUE NOT NULL,
      bot_name VARCHAR(100) DEFAULT 'HANI-MD',
      prefix VARCHAR(10) DEFAULT '.',
      mode ENUM('public', 'private') DEFAULT 'public',
      owner_numbers TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Utilisateurs
  users: `
    CREATE TABLE IF NOT EXISTS users (
      id INT PRIMARY KEY AUTO_INCREMENT,
      jid VARCHAR(50) UNIQUE NOT NULL,
      phone_number VARCHAR(20),
      push_name VARCHAR(100),
      is_sudo BOOLEAN DEFAULT FALSE,
      is_banned BOOLEAN DEFAULT FALSE,
      ban_reason TEXT,
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      message_count INT DEFAULT 0,
      INDEX idx_phone (phone_number),
      INDEX idx_banned (is_banned)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Groupes
  groups_config: `
    CREATE TABLE IF NOT EXISTS groups_config (
      id INT PRIMARY KEY AUTO_INCREMENT,
      group_jid VARCHAR(50) UNIQUE NOT NULL,
      group_name VARCHAR(200),
      welcome_enabled BOOLEAN DEFAULT FALSE,
      welcome_message TEXT,
      goodbye_enabled BOOLEAN DEFAULT FALSE,
      goodbye_message TEXT,
      antilink_enabled BOOLEAN DEFAULT FALSE,
      antilink_action ENUM('warn', 'kick', 'delete') DEFAULT 'warn',
      antispam_enabled BOOLEAN DEFAULT FALSE,
      antibot_enabled BOOLEAN DEFAULT FALSE,
      antitag_enabled BOOLEAN DEFAULT FALSE,
      only_admins BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Avertissements
  warnings: `
    CREATE TABLE IF NOT EXISTS warnings (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_jid VARCHAR(50) NOT NULL,
      group_jid VARCHAR(50),
      reason TEXT,
      warned_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_jid),
      INDEX idx_group (group_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Économie
  economy: `
    CREATE TABLE IF NOT EXISTS economy (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_jid VARCHAR(50) UNIQUE NOT NULL,
      balance BIGINT DEFAULT 0,
      bank BIGINT DEFAULT 0,
      last_daily TIMESTAMP NULL,
      last_weekly TIMESTAMP NULL,
      last_monthly TIMESTAMP NULL,
      last_work TIMESTAMP NULL,
      last_crime TIMESTAMP NULL,
      last_rob TIMESTAMP NULL,
      total_earned BIGINT DEFAULT 0,
      total_spent BIGINT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_balance (balance)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Niveaux et XP
  levels: `
    CREATE TABLE IF NOT EXISTS levels (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_jid VARCHAR(50) NOT NULL,
      group_jid VARCHAR(50),
      xp INT DEFAULT 0,
      level INT DEFAULT 1,
      messages INT DEFAULT 0,
      last_xp_gain TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_group (user_jid, group_jid),
      INDEX idx_level (level DESC),
      INDEX idx_xp (xp DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Messages programmés
  scheduled_messages: `
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INT PRIMARY KEY AUTO_INCREMENT,
      chat_jid VARCHAR(50) NOT NULL,
      message TEXT NOT NULL,
      scheduled_time DATETIME NOT NULL,
      repeat_type ENUM('once', 'daily', 'weekly', 'monthly') DEFAULT 'once',
      created_by VARCHAR(50),
      is_sent BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_scheduled (scheduled_time),
      INDEX idx_chat (chat_jid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Logs d'activité
  activity_logs: `
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      event_type VARCHAR(50) NOT NULL,
      user_jid VARCHAR(50),
      group_jid VARCHAR(50),
      details JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_event (event_type),
      INDEX idx_date (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Stickers personnalisés
  custom_stickers: `
    CREATE TABLE IF NOT EXISTS custom_stickers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(50) NOT NULL,
      file_id VARCHAR(200) NOT NULL,
      created_by VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `,

  // Contacts sauvegardés
  contacts: `
    CREATE TABLE IF NOT EXISTS contacts (
      id INT PRIMARY KEY AUTO_INCREMENT,
      jid VARCHAR(50) UNIQUE NOT NULL,
      phone_number VARCHAR(20),
      push_name VARCHAR(100),
      saved_name VARCHAR(100),
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_phone (phone_number)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `
};

// Fonction principale
async function initDatabase() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║     🗄️  INITIALISATION BASE DE DONNÉES HANI-MD       ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const config = getConfig();
  let connection;

  try {
    // Connexion
    console.log('📡 Connexion à MySQL...');
    
    if (config.uri) {
      connection = await mysql.createConnection(config.uri);
      console.log('✅ Connecté via MYSQL_URL');
    } else {
      // D'abord sans base de données pour la créer si nécessaire
      const { database, ...configWithoutDb } = config;
      connection = await mysql.createConnection(configWithoutDb);
      
      // Créer la base de données si elle n'existe pas
      console.log(`📦 Création de la base "${database}" si inexistante...`);
      await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      await connection.query(`USE \`${database}\``);
      console.log(`✅ Base de données "${database}" prête`);
    }

    // Créer les tables
    console.log('\n📋 Création des tables...\n');
    
    for (const [tableName, createSQL] of Object.entries(TABLES)) {
      try {
        await connection.query(createSQL);
        console.log(`   ✅ Table "${tableName}" créée/vérifiée`);
      } catch (err) {
        console.log(`   ❌ Erreur table "${tableName}": ${err.message}`);
      }
    }

    // Vérifier les tables créées
    const [tables] = await connection.query('SHOW TABLES');
    console.log(`\n📊 ${tables.length} tables dans la base de données`);

    // Résumé
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║           ✅ INITIALISATION TERMINÉE !                ║');
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('\n🚀 La base de données est prête pour HANI-MD !\n');

  } catch (error) {
    console.error('\n❌ ERREUR:', error.message);
    
    if (error.code === 'ENOTFOUND') {
      console.error('   → Le serveur MySQL est inaccessible');
      console.error('   → Vérifiez MYSQL_HOST ou MYSQL_URL');
    } else if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('   → Accès refusé - Vérifiez MYSQL_USER et MYSQL_PASSWORD');
    } else if (error.code === 'ECONNREFUSED') {
      console.error('   → Connexion refusée - MySQL est-il démarré ?');
    }
    
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
}

// Exécuter si appelé directement
if (require.main === module) {
  initDatabase();
}

module.exports = { initDatabase, TABLES };
