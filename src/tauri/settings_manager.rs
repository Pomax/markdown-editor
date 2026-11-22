//! Application settings, persisted in SQLite: a `settings(key, value)` table, JSON-encoded
//! values, WAL mode and a 5 second busy timeout. The database lives in the
//! app config directory, or in the test settings directory under TESTING.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};

/// The settings database file name.
const DB_FILE: &str = "settings.db";

/// The settings database path: the app config directory, or the test
/// settings directory when one is set and TESTING is on.
pub fn db_path(app_config_dir: &Path, testing: bool, testing_dir: Option<String>) -> PathBuf {
    if testing {
        if let Some(dir) = testing_dir {
            return Path::new(&dir).join(DB_FILE);
        }
    }
    app_config_dir.join(DB_FILE)
}

/// Parses a stored value as JSON, falling back to the raw string when it
/// does not parse.
fn parse_stored(raw: String) -> Value {
    serde_json::from_str(&raw).unwrap_or(Value::String(raw))
}

/// Settings store backed by SQLite.
pub struct SettingsManager {
    conn: Connection,
}

impl SettingsManager {
    /// Opens (creating if needed) the settings database at a path.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open(path)?)
    }

    /// Opens an in-memory settings database, for tests.
    #[cfg(test)]
    pub fn in_memory() -> rusqlite::Result<Self> {
        Self::from_connection(Connection::open_in_memory()?)
    }

    /// Configures a connection with WAL, the busy timeout and the table.
    fn from_connection(conn: Connection) -> rusqlite::Result<Self> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )?;
        Ok(Self { conn })
    }

    /// Returns a setting, or None when the key is absent.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
            .map(parse_stored)
    }

    /// Stores a setting as JSON.
    pub fn set(&self, key: &str, value: &Value) {
        let serialized = value.to_string();
        let _ = self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, serialized],
        );
    }

    /// Deletes a setting, returning whether a row was removed. No command
    /// exposes it yet.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn delete(&self, key: &str) -> bool {
        self.conn
            .execute("DELETE FROM settings WHERE key = ?1", [key])
            .map(|changed| changed > 0)
            .unwrap_or(false)
    }

    /// Returns every setting as a JSON object.
    pub fn get_all(&self) -> Map<String, Value> {
        let mut map = Map::new();
        let Ok(mut stmt) = self.conn.prepare("SELECT key, value FROM settings") else {
            return map;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) else {
            return map;
        };
        for (key, raw) in rows.flatten() {
            map.insert(key, parse_stored(raw));
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn target_db(name: &str) -> PathBuf {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("target");
        std::fs::create_dir_all(&path).ok();
        path.push(format!("settings-test-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn sets_gets_and_deletes_values() {
        let settings = SettingsManager::in_memory().unwrap();
        settings.set("theme", &json!("dark"));
        assert_eq!(settings.get("theme"), Some(json!("dark")));
        assert!(settings.delete("theme"));
        assert_eq!(settings.get("theme"), None);
        assert!(!settings.delete("theme"));
    }

    #[test]
    fn returns_none_for_a_missing_key() {
        let settings = SettingsManager::in_memory().unwrap();
        assert_eq!(settings.get("absent"), None);
    }

    #[test]
    fn keeps_a_stored_null() {
        let settings = SettingsManager::in_memory().unwrap();
        settings.set("maybe", &Value::Null);
        assert_eq!(settings.get("maybe"), Some(Value::Null));
    }

    #[test]
    fn returns_an_unparseable_value_raw() {
        let settings = SettingsManager::in_memory().unwrap();
        settings
            .conn
            .execute(
                "INSERT INTO settings (key, value) VALUES ('legacy', 'not json')",
                [],
            )
            .unwrap();
        assert_eq!(
            settings.get("legacy"),
            Some(Value::String("not json".into()))
        );
    }

    #[test]
    fn get_all_returns_every_setting() {
        let settings = SettingsManager::in_memory().unwrap();
        settings.set("a", &json!(1));
        settings.set("b", &json!("two"));
        let all = settings.get_all();
        assert_eq!(all.get("a"), Some(&json!(1)));
        assert_eq!(all.get("b"), Some(&json!("two")));
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn uses_wal_and_a_five_second_busy_timeout() {
        let path = target_db("wal");
        let settings = SettingsManager::open(&path).unwrap();
        let mode: String = settings
            .conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let timeout: i64 = settings
            .conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(timeout, 5000);
        drop(settings);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn honours_the_settings_dir_override_only_under_testing() {
        let config = Path::new("/config");
        let testing_dir = Some("/testdir".to_string());
        assert_eq!(
            db_path(config, true, testing_dir.clone()),
            Path::new("/testdir").join("settings.db")
        );
        assert_eq!(
            db_path(config, false, testing_dir),
            config.join("settings.db")
        );
        assert_eq!(db_path(config, true, None), config.join("settings.db"));
    }
}
