/**
 * ╔═══════════════════════════════════════════════════════════╗
 * ║           🗄️ HANI-MD - MySQL Database Module v2.0         ║
 * ║     Base de données externe pour persistance des données  ║
 * ║              MySQL2 v3.15+ - Dernière version             ║
 * ╚═══════════════════════════════════════════════════════════╝
 * 
 * Hébergeurs MySQL gratuits:
 * - PlanetScale: https://planetscale.com (5GB gratuit)
 * - Railway: https://railway.app (500MB gratuit)  
 * - FreeSQLDatabase: https://freesqldatabase.com
 * - db4free.net: https://db4free.net
 * - Clever Cloud: https://clever-cloud.com
 * - Aiven: https://aiven.io (free tier)
 * 
 * Format de connexion:
 * MYSQL_URL=mysql://user:password@host:port/database
 * ou variables séparées:
 * MYSQL_HOST=host
 * MYSQL_USER=user
 * MYSQL_PASSWORD=password
 * MYSQL_DATABASE=database
 * MYSQL_PORT=3306 (optionnel)
 * MYSQL_SSL=true (optionnel)
 */

const mysql = require('mysql2/promise');

let pool = null;
let isConnected = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ═══════════════════════════════════════════════════════════
// 🔌 CONNEXION AVANCÉE (MySQL2 v3.15+)
// ═══════════════════════════════════════════════════════════

async function connect() {
  try {
    const config = {
      waitForConnections: true,
      connectionLimit: 20,
      maxIdle: 10,
      idleTimeout: 60000,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      namedPlaceholders: true,
      dateStrings: true,
      timezone: 'local',
      multipleStatements: true,
      charset: 'utf8mb4'
    };

    // Support pour URL complète ou variables séparées
    if (process.env.MYSQL_URL) {
      pool = mysql.createPool({
        uri: process.env.MYSQL_URL,
        ...config
      });
    } else if (process.env.MYSQL_HOST) {
      pool = mysql.createPool({
        host: process.env.MYSQL_HOST,
        port: parseInt(process.env.MYSQL_PORT) || 3306,
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD,
        database: process.env.MYSQL_DATABASE,
        ssl: process.env.MYSQL_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
        ...config
      });
    } else {
      console.log("[!] MySQL non configuré - Mode local uniquement");
      return false;
    }

    // Tester la connexion
    const connection = await pool.getConnection();
    const [rows] = await connection.query('SELECT VERSION() as version');
    console.log(`[DB] MySQL Version: ${rows[0].version}`);
    connection.release();
    
    // Créer les tables si elles n'existent pas
    await createTables();
    
    isConnected = true;
    reconnectAttempts = 0;
    console.log("[OK] MySQL connecté avec succès!");
    
    // Ping automatique pour garder la connexion active
    setInterval(async () => {
      try {
        await pool.query('SELECT 1');
      } catch (e) {
        console.log("[!] MySQL ping failed, reconnecting...");
        await reconnect();
      }
    }, 30000);
    
    return true;
  } catch (error) {
    console.log("[X] Erreur connexion MySQL:", error.message);
    isConnected = false;
    return false;
  }
}

async function reconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.log("[X] Max reconnection attempts reached");
    return false;
  }
  reconnectAttempts++;
  console.log(`[...] Tentative reconnexion MySQL ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
  await new Promise(r => setTimeout(r, 5000));
  return connect();
}

async function disconnect() {
  if (pool) {
    await pool.end();
    isConnected = false;
    console.log("[OK] MySQL déconnecté");
  }
}

// ═══════════════════════════════════════════════════════════
// 📋 CRÉATION DES TABLES (Schema complet)
// ═══════════════════════════════════════════════════════════

async function createTables() {
  const tables = [
    // Table des utilisateurs
    `CREATE TABLE IF NOT EXISTS users (
      jid VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) DEFAULT '',
      xp INT DEFAULT 0,
      level INT DEFAULT 1,
      messages INT DEFAULT 0,
      last_seen BIGINT,
      is_banned BOOLEAN DEFAULT FALSE,
      is_sudo BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // Table des groupes
    `CREATE TABLE IF NOT EXISTS \`groups\` (
      jid VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) DEFAULT '',
      welcome BOOLEAN DEFAULT TRUE,
      antilink BOOLEAN DEFAULT FALSE,
      antispam BOOLEAN DEFAULT FALSE,
      antibot BOOLEAN DEFAULT FALSE,
      antitag BOOLEAN DEFAULT FALSE,
      mute BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // Table des warns
    `CREATE TABLE IF NOT EXISTS warns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_jid VARCHAR(100) NOT NULL,
      user_jid VARCHAR(100) NOT NULL,
      count INT DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_warn (group_jid, user_jid)
    )`,
    
    // Table des contacts
    `CREATE TABLE IF NOT EXISTS contacts (
      jid VARCHAR(100) PRIMARY KEY,
      name VARCHAR(255) DEFAULT '',
      phone VARCHAR(50) DEFAULT '',
      push_name VARCHAR(255) DEFAULT '',
      first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // Table des messages supprimés
    `CREATE TABLE IF NOT EXISTS deleted_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(100),
      from_jid VARCHAR(100),
      sender_jid VARCHAR(100),
      sender_name VARCHAR(255) DEFAULT '',
      group_name VARCHAR(255),
      text TEXT,
      media_type VARCHAR(50),
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_from (from_jid),
      INDEX idx_sender (sender_jid)
    )`,
    
    // Table des statuts supprimés
    `CREATE TABLE IF NOT EXISTS deleted_statuses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sender_jid VARCHAR(100),
      sender_name VARCHAR(255) DEFAULT '',
      sender_phone VARCHAR(50) DEFAULT '',
      media_type VARCHAR(50),
      caption TEXT,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_sender (sender_jid)
    )`,
    
    // Table des paramètres
    `CREATE TABLE IF NOT EXISTS settings (
      \`key\` VARCHAR(100) PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // Table des statistiques
    `CREATE TABLE IF NOT EXISTS stats (
      id INT PRIMARY KEY DEFAULT 1,
      commands INT DEFAULT 0,
      messages INT DEFAULT 0,
      start_time BIGINT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // Table de surveillance (spy)
    `CREATE TABLE IF NOT EXISTS surveillance (
      jid VARCHAR(100) PRIMARY KEY,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_messages INT DEFAULT 0,
      last_activity TIMESTAMP
    )`,
    
    // Table d'activité
    `CREATE TABLE IF NOT EXISTS activity (
      id INT AUTO_INCREMENT PRIMARY KEY,
      jid VARCHAR(100) NOT NULL,
      action_type VARCHAR(50),
      details TEXT,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_jid (jid),
      INDEX idx_time (timestamp)
    )`,
    
    // 🆕 Table des admins (pour le panel web)
    `CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('superadmin', 'admin', 'moderator') DEFAULT 'admin',
      email VARCHAR(255),
      last_login TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // 🆕 Table des sessions admin
    `CREATE TABLE IF NOT EXISTS admin_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT NOT NULL,
      token VARCHAR(255) UNIQUE NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE,
      INDEX idx_token (token),
      INDEX idx_expires (expires_at)
    )`,
    
    // 🆕 Table des logs admin
    `CREATE TABLE IF NOT EXISTS admin_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      admin_id INT,
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50),
      target_id VARCHAR(100),
      details JSON,
      ip_address VARCHAR(45),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_admin (admin_id),
      INDEX idx_action (action),
      INDEX idx_time (created_at)
    )`,
    
    // 🆕 Table des commandes personnalisées
    `CREATE TABLE IF NOT EXISTS custom_commands (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) UNIQUE NOT NULL,
      response TEXT NOT NULL,
      media_url TEXT,
      media_type VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      usage_count INT DEFAULT 0,
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // 🆕 Table des messages programmés
    `CREATE TABLE IF NOT EXISTS scheduled_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      target_jid VARCHAR(100) NOT NULL,
      message TEXT NOT NULL,
      media_url TEXT,
      media_type VARCHAR(50),
      scheduled_at TIMESTAMP NOT NULL,
      sent_at TIMESTAMP,
      status ENUM('pending', 'sent', 'failed', 'cancelled') DEFAULT 'pending',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_status (status),
      INDEX idx_scheduled (scheduled_at)
    )`,
    
    // 🆕 Table des réponses automatiques
    `CREATE TABLE IF NOT EXISTS auto_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      trigger_word VARCHAR(255) NOT NULL,
      trigger_type ENUM('exact', 'contains', 'startswith', 'regex') DEFAULT 'contains',
      response TEXT NOT NULL,
      media_url TEXT,
      media_type VARCHAR(50),
      is_active BOOLEAN DEFAULT TRUE,
      group_only BOOLEAN DEFAULT FALSE,
      private_only BOOLEAN DEFAULT FALSE,
      usage_count INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_trigger (trigger_word),
      INDEX idx_active (is_active)
    )`,
    
    // 🆕 Table de l'économie virtuelle
    `CREATE TABLE IF NOT EXISTS economy (
      jid VARCHAR(100) PRIMARY KEY,
      balance BIGINT DEFAULT 0,
      bank BIGINT DEFAULT 0,
      total_earned BIGINT DEFAULT 0,
      total_spent BIGINT DEFAULT 0,
      daily_claimed_at TIMESTAMP,
      weekly_claimed_at TIMESTAMP,
      work_cooldown TIMESTAMP,
      rob_cooldown TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
    
    // 🆕 Table des transactions économiques
    `CREATE TABLE IF NOT EXISTS economy_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_jid VARCHAR(100),
      to_jid VARCHAR(100),
      amount BIGINT NOT NULL,
      transaction_type VARCHAR(50) NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_from (from_jid),
      INDEX idx_to (to_jid),
      INDEX idx_type (transaction_type)
    )`,
    
    // 🆕 Table des backups
    `CREATE TABLE IF NOT EXISTS backups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      type ENUM('full', 'partial', 'session') DEFAULT 'full',
      size_bytes BIGINT,
      file_path TEXT,
      status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of tables) {
    try {
      await pool.execute(sql);
    } catch (error) {
      console.log("[!] Erreur création table:", error.message);
    }
  }
  
  // Initialiser les stats si vide
  await pool.execute(
    `INSERT IGNORE INTO stats (id, commands, messages, start_time) VALUES (1, 0, 0, ?)`,
    [Date.now()]
  );
}

// ═══════════════════════════════════════════════════════════
// 👤 UTILISATEURS
// ═══════════════════════════════════════════════════════════

async function getUser(jid) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM users WHERE jid = ?', [jid]);
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function updateUser(jid, data) {
  if (!isConnected) return false;
  try {
    const fields = [];
    const values = [];
    
    for (const [key, value] of Object.entries(data)) {
      const dbKey = key === 'lastSeen' ? 'last_seen' : 
                    key === 'isBanned' ? 'is_banned' : 
                    key === 'isSudo' ? 'is_sudo' : key;
      fields.push(`${dbKey} = ?`);
      values.push(value);
    }
    
    // Upsert
    await pool.execute(
      `INSERT INTO users (jid, ${Object.keys(data).map(k => 
        k === 'lastSeen' ? 'last_seen' : k === 'isBanned' ? 'is_banned' : k === 'isSudo' ? 'is_sudo' : k
      ).join(', ')}) 
       VALUES (?, ${Object.keys(data).map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${fields.join(', ')}`,
      [jid, ...Object.values(data), ...values]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function banUser(jid) {
  return updateUser(jid, { is_banned: true });
}

async function unbanUser(jid) {
  return updateUser(jid, { is_banned: false });
}

async function isBanned(jid) {
  const user = await getUser(jid);
  return user?.is_banned || false;
}

async function addSudo(jid) {
  return updateUser(jid, { is_sudo: true });
}

async function removeSudo(jid) {
  return updateUser(jid, { is_sudo: false });
}

async function isSudo(jid) {
  const user = await getUser(jid);
  return user?.is_sudo || false;
}

// ═══════════════════════════════════════════════════════════
// 👥 GROUPES
// ═══════════════════════════════════════════════════════════

async function getGroup(jid) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM `groups` WHERE jid = ?', [jid]);
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function updateGroup(jid, data) {
  if (!isConnected) return false;
  try {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const updates = Object.keys(data).map(k => `${k} = VALUES(${k})`).join(', ');
    
    await pool.execute(
      `INSERT INTO \`groups\` (jid, ${columns}) VALUES (?, ${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      [jid, ...Object.values(data)]
    );
    return true;
  } catch (error) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// ⚠️ WARNS
// ═══════════════════════════════════════════════════════════

async function addWarn(groupJid, userJid) {
  if (!isConnected) return 0;
  try {
    await pool.execute(
      `INSERT INTO warns (group_jid, user_jid, count) VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [groupJid, userJid]
    );
    const [rows] = await pool.execute(
      'SELECT count FROM warns WHERE group_jid = ? AND user_jid = ?',
      [groupJid, userJid]
    );
    return rows[0]?.count || 1;
  } catch (error) {
    return 0;
  }
}

async function getWarns(groupJid, userJid) {
  if (!isConnected) return 0;
  try {
    const [rows] = await pool.execute(
      'SELECT count FROM warns WHERE group_jid = ? AND user_jid = ?',
      [groupJid, userJid]
    );
    return rows[0]?.count || 0;
  } catch (error) {
    return 0;
  }
}

async function resetWarns(groupJid, userJid) {
  if (!isConnected) return;
  try {
    await pool.execute(
      'DELETE FROM warns WHERE group_jid = ? AND user_jid = ?',
      [groupJid, userJid]
    );
  } catch (error) {}
}

// ═══════════════════════════════════════════════════════════
// 📇 CONTACTS
// ═══════════════════════════════════════════════════════════

async function saveContact(jid, name, phone, pushName = '') {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT INTO contacts (jid, name, phone, push_name) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = ?, phone = ?, push_name = ?`,
      [jid, name, phone, pushName, name, phone, pushName]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getContact(jid) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM contacts WHERE jid = ?', [jid]);
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function searchContacts(query) {
  if (!isConnected) return [];
  try {
    const searchTerm = `%${query}%`;
    const [rows] = await pool.execute(
      'SELECT * FROM contacts WHERE name LIKE ? OR phone LIKE ? OR push_name LIKE ? LIMIT 50',
      [searchTerm, searchTerm, searchTerm]
    );
    return rows;
  } catch (error) {
    return [];
  }
}

async function getAllContacts() {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute('SELECT * FROM contacts ORDER BY last_seen DESC');
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 🗑️ MESSAGES SUPPRIMÉS
// ═══════════════════════════════════════════════════════════

async function saveDeletedMessage(data) {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT INTO deleted_messages (message_id, from_jid, sender_jid, sender_name, group_name, text, media_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [data.messageId, data.from, data.sender, data.senderName || '', data.groupName, data.text || '', data.mediaType]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getDeletedMessages(jid = null, limit = 20) {
  if (!isConnected) return [];
  try {
    let query = 'SELECT * FROM deleted_messages';
    const params = [];
    
    if (jid) {
      query += ' WHERE from_jid = ? OR sender_jid = ?';
      params.push(jid, jid);
    }
    
    query += ' ORDER BY deleted_at DESC LIMIT ?';
    params.push(limit);
    
    const [rows] = await pool.execute(query, params);
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 📸 STATUTS SUPPRIMÉS
// ═══════════════════════════════════════════════════════════

async function saveDeletedStatus(data) {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT INTO deleted_statuses (sender_jid, sender_name, sender_phone, media_type, caption)
       VALUES (?, ?, ?, ?, ?)`,
      [data.sender, data.senderName || '', data.senderPhone || '', data.mediaType, data.caption || '']
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getDeletedStatuses(senderJid = null, limit = 20) {
  if (!isConnected) return [];
  try {
    let query = 'SELECT * FROM deleted_statuses';
    const params = [];
    
    if (senderJid) {
      query += ' WHERE sender_jid = ?';
      params.push(senderJid);
    }
    
    query += ' ORDER BY deleted_at DESC LIMIT ?';
    params.push(limit);
    
    const [rows] = await pool.execute(query, params);
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 📊 STATISTIQUES
// ═══════════════════════════════════════════════════════════

async function getStats() {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM stats WHERE id = 1');
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function updateStats(data) {
  if (!isConnected) return false;
  try {
    const updates = [];
    const values = [];
    
    if (data.commands !== undefined) {
      updates.push('commands = ?');
      values.push(data.commands);
    }
    if (data.messages !== undefined) {
      updates.push('messages = ?');
      values.push(data.messages);
    }
    
    if (updates.length > 0) {
      await pool.execute(`UPDATE stats SET ${updates.join(', ')} WHERE id = 1`, values);
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function incrementStats(key) {
  if (!isConnected) return;
  try {
    await pool.execute(`UPDATE stats SET ${key} = ${key} + 1 WHERE id = 1`);
  } catch (error) {}
}

// ═══════════════════════════════════════════════════════════
// 🕵️ SURVEILLANCE
// ═══════════════════════════════════════════════════════════

async function addToSurveillance(jid) {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT IGNORE INTO surveillance (jid) VALUES (?)`,
      [jid]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function removeFromSurveillance(jid) {
  if (!isConnected) return false;
  try {
    await pool.execute('DELETE FROM surveillance WHERE jid = ?', [jid]);
    return true;
  } catch (error) {
    return false;
  }
}

async function getSurveillanceList() {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute('SELECT * FROM surveillance');
    return rows;
  } catch (error) {
    return [];
  }
}

async function isUnderSurveillance(jid) {
  if (!isConnected) return false;
  try {
    const [rows] = await pool.execute('SELECT jid FROM surveillance WHERE jid = ?', [jid]);
    return rows.length > 0;
  } catch (error) {
    return false;
  }
}

async function logActivity(jid, actionType, details) {
  if (!isConnected) return;
  try {
    await pool.execute(
      'INSERT INTO activity (jid, action_type, details) VALUES (?, ?, ?)',
      [jid, actionType, details]
    );
    // Mettre à jour last_activity
    await pool.execute(
      'UPDATE surveillance SET total_messages = total_messages + 1, last_activity = NOW() WHERE jid = ?',
      [jid]
    );
  } catch (error) {}
}

async function getActivity(jid, limit = 50) {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM activity WHERE jid = ? ORDER BY timestamp DESC LIMIT ?',
      [jid, limit]
    );
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 🧹 NETTOYAGE
// ═══════════════════════════════════════════════════════════

async function cleanOldData(daysToKeep = 30) {
  if (!isConnected) return;
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');
    
    await pool.execute('DELETE FROM deleted_messages WHERE deleted_at < ?', [cutoff]);
    await pool.execute('DELETE FROM deleted_statuses WHERE deleted_at < ?', [cutoff]);
    await pool.execute('DELETE FROM activity WHERE timestamp < ?', [cutoff]);
    await pool.execute('DELETE FROM admin_sessions WHERE expires_at < NOW()');
    await pool.execute('DELETE FROM admin_logs WHERE created_at < ?', [cutoff]);
    
    console.log(`[CLEAN] Données de plus de ${daysToKeep} jours nettoyées`);
  } catch (error) {}
}

// ═══════════════════════════════════════════════════════════
// 🔐 GESTION ADMINS (Panel Web)
// ═══════════════════════════════════════════════════════════

const crypto = require('crypto');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'HANI_MD_SALT_2025').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createAdmin(username, password, role = 'admin', email = null) {
  if (!isConnected) return null;
  try {
    const passwordHash = hashPassword(password);
    const [result] = await pool.execute(
      'INSERT INTO admins (username, password_hash, role, email) VALUES (?, ?, ?, ?)',
      [username, passwordHash, role, email]
    );
    return result.insertId;
  } catch (error) {
    console.log("[!] Erreur création admin:", error.message);
    return null;
  }
}

async function verifyAdmin(username, password) {
  if (!isConnected) return null;
  try {
    const passwordHash = hashPassword(password);
    const [rows] = await pool.execute(
      'SELECT * FROM admins WHERE username = ? AND password_hash = ? AND is_active = TRUE',
      [username, passwordHash]
    );
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function createAdminSession(adminId, ipAddress = null, userAgent = null) {
  if (!isConnected) return null;
  try {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    
    await pool.execute(
      'INSERT INTO admin_sessions (admin_id, token, ip_address, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)',
      [adminId, token, ipAddress, userAgent, expiresAt]
    );
    
    // Update last_login
    await pool.execute('UPDATE admins SET last_login = NOW() WHERE id = ?', [adminId]);
    
    return token;
  } catch (error) {
    return null;
  }
}

async function verifyAdminSession(token) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT a.*, s.expires_at, s.id as session_id 
       FROM admin_sessions s 
       JOIN admins a ON s.admin_id = a.id 
       WHERE s.token = ? AND s.expires_at > NOW() AND a.is_active = TRUE`,
      [token]
    );
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function deleteAdminSession(token) {
  if (!isConnected) return;
  try {
    await pool.execute('DELETE FROM admin_sessions WHERE token = ?', [token]);
  } catch (error) {}
}

async function logAdminAction(adminId, action, targetType = null, targetId = null, details = null, ipAddress = null) {
  if (!isConnected) return;
  try {
    await pool.execute(
      'INSERT INTO admin_logs (admin_id, action, target_type, target_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, action, targetType, targetId, details ? JSON.stringify(details) : null, ipAddress]
    );
  } catch (error) {}
}

async function getAdminLogs(adminId = null, limit = 100) {
  if (!isConnected) return [];
  try {
    let query = 'SELECT l.*, a.username FROM admin_logs l LEFT JOIN admins a ON l.admin_id = a.id';
    const params = [];
    
    if (adminId) {
      query += ' WHERE l.admin_id = ?';
      params.push(adminId);
    }
    
    query += ' ORDER BY l.created_at DESC LIMIT ?';
    params.push(limit);
    
    const [rows] = await pool.execute(query, params);
    return rows;
  } catch (error) {
    return [];
  }
}

async function getAllAdmins() {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute(
      'SELECT id, username, role, email, last_login, is_active, created_at FROM admins ORDER BY created_at'
    );
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 🤖 COMMANDES PERSONNALISÉES
// ═══════════════════════════════════════════════════════════

async function createCustomCommand(name, response, mediaUrl = null, mediaType = null, createdBy = null) {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT INTO custom_commands (name, response, media_url, media_type, created_by) 
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE response = ?, media_url = ?, media_type = ?, is_active = TRUE`,
      [name, response, mediaUrl, mediaType, createdBy, response, mediaUrl, mediaType]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getCustomCommand(name) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM custom_commands WHERE name = ? AND is_active = TRUE',
      [name]
    );
    if (rows[0]) {
      // Increment usage
      await pool.execute('UPDATE custom_commands SET usage_count = usage_count + 1 WHERE name = ?', [name]);
    }
    return rows[0] || null;
  } catch (error) {
    return null;
  }
}

async function getAllCustomCommands() {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute('SELECT * FROM custom_commands WHERE is_active = TRUE ORDER BY name');
    return rows;
  } catch (error) {
    return [];
  }
}

async function deleteCustomCommand(name) {
  if (!isConnected) return false;
  try {
    await pool.execute('UPDATE custom_commands SET is_active = FALSE WHERE name = ?', [name]);
    return true;
  } catch (error) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 📅 MESSAGES PROGRAMMÉS
// ═══════════════════════════════════════════════════════════

async function scheduleMessage(targetJid, message, scheduledAt, mediaUrl = null, mediaType = null, createdBy = null) {
  if (!isConnected) return null;
  try {
    const [result] = await pool.execute(
      'INSERT INTO scheduled_messages (target_jid, message, scheduled_at, media_url, media_type, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [targetJid, message, scheduledAt, mediaUrl, mediaType, createdBy]
    );
    return result.insertId;
  } catch (error) {
    return null;
  }
}

async function getPendingScheduledMessages() {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM scheduled_messages WHERE status = ? AND scheduled_at <= NOW()',
      ['pending']
    );
    return rows;
  } catch (error) {
    return [];
  }
}

async function updateScheduledMessageStatus(id, status) {
  if (!isConnected) return;
  try {
    const updates = status === 'sent' ? 'status = ?, sent_at = NOW()' : 'status = ?';
    await pool.execute(`UPDATE scheduled_messages SET ${updates} WHERE id = ?`, [status, id]);
  } catch (error) {}
}

async function getAllScheduledMessages(status = null) {
  if (!isConnected) return [];
  try {
    let query = 'SELECT * FROM scheduled_messages';
    const params = [];
    
    if (status) {
      query += ' WHERE status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY scheduled_at DESC';
    const [rows] = await pool.execute(query, params);
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 💬 RÉPONSES AUTOMATIQUES
// ═══════════════════════════════════════════════════════════

async function createAutoReply(triggerWord, response, triggerType = 'contains', options = {}) {
  if (!isConnected) return false;
  try {
    await pool.execute(
      `INSERT INTO auto_replies (trigger_word, trigger_type, response, media_url, media_type, group_only, private_only) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [triggerWord, triggerType, response, options.mediaUrl || null, options.mediaType || null, 
       options.groupOnly || false, options.privateOnly || false]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getAutoReplies(isGroup = false) {
  if (!isConnected) return [];
  try {
    let query = 'SELECT * FROM auto_replies WHERE is_active = TRUE';
    if (isGroup) {
      query += ' AND private_only = FALSE';
    } else {
      query += ' AND group_only = FALSE';
    }
    const [rows] = await pool.execute(query);
    return rows;
  } catch (error) {
    return [];
  }
}

async function checkAutoReply(text, isGroup = false) {
  if (!isConnected) return null;
  try {
    const replies = await getAutoReplies(isGroup);
    const lowerText = text.toLowerCase();
    
    for (const reply of replies) {
      const trigger = reply.trigger_word.toLowerCase();
      let matched = false;
      
      switch (reply.trigger_type) {
        case 'exact':
          matched = lowerText === trigger;
          break;
        case 'contains':
          matched = lowerText.includes(trigger);
          break;
        case 'startswith':
          matched = lowerText.startsWith(trigger);
          break;
        case 'regex':
          try {
            matched = new RegExp(reply.trigger_word, 'i').test(text);
          } catch (e) {}
          break;
      }
      
      if (matched) {
        // Increment usage
        await pool.execute('UPDATE auto_replies SET usage_count = usage_count + 1 WHERE id = ?', [reply.id]);
        return reply;
      }
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function deleteAutoReply(id) {
  if (!isConnected) return false;
  try {
    await pool.execute('UPDATE auto_replies SET is_active = FALSE WHERE id = ?', [id]);
    return true;
  } catch (error) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// 💰 ÉCONOMIE VIRTUELLE
// ═══════════════════════════════════════════════════════════

async function getEconomy(jid) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute('SELECT * FROM economy WHERE jid = ?', [jid]);
    if (!rows[0]) {
      // Créer un compte si n'existe pas
      await pool.execute('INSERT IGNORE INTO economy (jid) VALUES (?)', [jid]);
      return { jid, balance: 0, bank: 0, total_earned: 0, total_spent: 0 };
    }
    return rows[0];
  } catch (error) {
    return null;
  }
}

async function updateBalance(jid, amount, type = 'add') {
  if (!isConnected) return false;
  try {
    await getEconomy(jid); // Ensure account exists
    
    if (type === 'add') {
      await pool.execute(
        'UPDATE economy SET balance = balance + ?, total_earned = total_earned + ? WHERE jid = ?',
        [amount, amount, jid]
      );
    } else if (type === 'subtract') {
      await pool.execute(
        'UPDATE economy SET balance = balance - ?, total_spent = total_spent + ? WHERE jid = ?',
        [amount, amount, jid]
      );
    } else if (type === 'set') {
      await pool.execute('UPDATE economy SET balance = ? WHERE jid = ?', [amount, jid]);
    }
    return true;
  } catch (error) {
    return false;
  }
}

async function transferMoney(fromJid, toJid, amount) {
  if (!isConnected) return false;
  try {
    const fromAccount = await getEconomy(fromJid);
    if (!fromAccount || fromAccount.balance < amount) return false;
    
    await getEconomy(toJid); // Ensure recipient exists
    
    await pool.execute('UPDATE economy SET balance = balance - ? WHERE jid = ?', [amount, fromJid]);
    await pool.execute('UPDATE economy SET balance = balance + ? WHERE jid = ?', [amount, toJid]);
    
    // Log transaction
    await pool.execute(
      'INSERT INTO economy_transactions (from_jid, to_jid, amount, transaction_type, description) VALUES (?, ?, ?, ?, ?)',
      [fromJid, toJid, amount, 'transfer', 'User transfer']
    );
    
    return true;
  } catch (error) {
    return false;
  }
}

async function depositToBank(jid, amount) {
  if (!isConnected) return false;
  try {
    const account = await getEconomy(jid);
    if (!account || account.balance < amount) return false;
    
    await pool.execute(
      'UPDATE economy SET balance = balance - ?, bank = bank + ? WHERE jid = ?',
      [amount, amount, jid]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function withdrawFromBank(jid, amount) {
  if (!isConnected) return false;
  try {
    const account = await getEconomy(jid);
    if (!account || account.bank < amount) return false;
    
    await pool.execute(
      'UPDATE economy SET bank = bank - ?, balance = balance + ? WHERE jid = ?',
      [amount, amount, jid]
    );
    return true;
  } catch (error) {
    return false;
  }
}

async function getLeaderboard(limit = 10) {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute(
      'SELECT jid, balance, bank, (balance + bank) as total FROM economy ORDER BY total DESC LIMIT ?',
      [limit]
    );
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 📊 STATISTIQUES AVANCÉES
// ═══════════════════════════════════════════════════════════

async function getDashboardStats() {
  if (!isConnected) return null;
  try {
    const [userCount] = await pool.execute('SELECT COUNT(*) as count FROM users');
    const [groupCount] = await pool.execute('SELECT COUNT(*) as count FROM `groups`');
    const [contactCount] = await pool.execute('SELECT COUNT(*) as count FROM contacts');
    const [msgCount] = await pool.execute('SELECT COUNT(*) as count FROM deleted_messages');
    const [statusCount] = await pool.execute('SELECT COUNT(*) as count FROM deleted_statuses');
    const [stats] = await pool.execute('SELECT * FROM stats WHERE id = 1');
    
    return {
      users: userCount[0].count,
      groups: groupCount[0].count,
      contacts: contactCount[0].count,
      deletedMessages: msgCount[0].count,
      deletedStatuses: statusCount[0].count,
      commands: stats[0]?.commands || 0,
      messages: stats[0]?.messages || 0,
      uptime: stats[0]?.start_time ? Date.now() - stats[0].start_time : 0
    };
  } catch (error) {
    return null;
  }
}

async function getRecentActivity(limit = 50) {
  if (!isConnected) return [];
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM activity ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );
    return rows;
  } catch (error) {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// 🔧 UTILITAIRES
// ═══════════════════════════════════════════════════════════

async function query(sql, params = []) {
  if (!isConnected) return null;
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (error) {
    console.log("[!] Query error:", error.message);
    return null;
  }
}

async function getPool() {
  return pool;
}

// ═══════════════════════════════════════════════════════════
// 📤 EXPORTS
// ═══════════════════════════════════════════════════════════

module.exports = {
  connect,
  disconnect,
  reconnect,
  isConnected: () => isConnected,
  query,
  getPool,
  
  // Utilisateurs
  getUser,
  updateUser,
  banUser,
  unbanUser,
  isBanned,
  addSudo,
  removeSudo,
  isSudo,
  
  // Groupes
  getGroup,
  updateGroup,
  
  // Warns
  addWarn,
  getWarns,
  resetWarns,
  
  // Contacts
  saveContact,
  getContact,
  searchContacts,
  getAllContacts,
  
  // Messages supprimés
  saveDeletedMessage,
  getDeletedMessages,
  
  // Statuts supprimés
  saveDeletedStatus,
  getDeletedStatuses,
  
  // Stats
  getStats,
  updateStats,
  incrementStats,
  getDashboardStats,
  getRecentActivity,
  
  // Surveillance
  addToSurveillance,
  removeFromSurveillance,
  getSurveillanceList,
  isUnderSurveillance,
  logActivity,
  getActivity,
  
  // Admins (Panel Web)
  createAdmin,
  verifyAdmin,
  createAdminSession,
  verifyAdminSession,
  deleteAdminSession,
  logAdminAction,
  getAdminLogs,
  getAllAdmins,
  hashPassword,
  
  // Commandes personnalisées
  createCustomCommand,
  getCustomCommand,
  getAllCustomCommands,
  deleteCustomCommand,
  
  // Messages programmés
  scheduleMessage,
  getPendingScheduledMessages,
  updateScheduledMessageStatus,
  getAllScheduledMessages,
  
  // Réponses automatiques
  createAutoReply,
  getAutoReplies,
  checkAutoReply,
  deleteAutoReply,
  
  // Économie
  getEconomy,
  updateBalance,
  transferMoney,
  depositToBank,
  withdrawFromBank,
  getLeaderboard,
  
  // Nettoyage
  cleanOldData
};
