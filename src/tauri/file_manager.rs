//! File operations: the recent
//! files list (dedup, move-to-front, capped at ten), Save As extension
//! handling that pins Node's `path.extname`, lossy UTF-8 reads that keep a
//! byte order mark, and the HTML export file names and stylesheet
//! assembly. The dialog- and disk-driven parts live in the commands.

use std::path::{Path, PathBuf};

/// Maximum number of recent files to remember.
pub const MAX_RECENT_FILES: usize = 10;

/// The stylesheets that style the exported document, in load order.
#[allow(dead_code)]
pub const EXPORT_STYLESHEETS: [&str; 4] =
    ["main.css", "editor.css", "writing-view.css", "image.css"];

/// The backend file state: the open document path, whether it has
/// unsaved changes, and the recent files list.
pub struct FileManager {
    pub current_file_path: Option<String>,
    pub has_unsaved_changes: bool,
    pub recent_files: Vec<String>,
}

impl FileManager {
    /// Creates a file manager seeded with a recent files list.
    pub fn new(recent_files: Vec<String>) -> Self {
        Self {
            current_file_path: None,
            has_unsaved_changes: false,
            recent_files,
        }
    }
}

/// Adds a path to the recent files list: removes any existing entry,
/// prepends it, and trims the list to MAX_RECENT_FILES.
pub fn add_recent(recent: &mut Vec<String>, path: &str) {
    recent.retain(|existing| existing != path);
    recent.insert(0, path.to_string());
    recent.truncate(MAX_RECENT_FILES);
}

/// Removes a path from the recent files list.
pub fn remove_recent(recent: &mut Vec<String>, path: &str) {
    recent.retain(|existing| existing != path);
}

/// Node's `path.extname` for the last path segment: the extension from the
/// last dot, but empty when the only dot is the first character (a
/// dot-file) or there is no dot.
pub fn node_extname(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(0) | None => String::new(),
        Some(index) => base[index..].to_string(),
    }
}

/// The Save As target: appends `.md` when the path has no extension.
pub fn save_as_path(path: &str) -> String {
    if node_extname(path).is_empty() {
        format!("{path}.md")
    } else {
        path.to_string()
    }
}

/// Reads bytes as UTF-8 the way Node's `utf-8` did: invalid sequences
/// become U+FFFD and a byte order mark is kept.
pub fn read_utf8_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The exported HTML file path: `<name>.html` next to the document.
pub fn export_html_path(current: &Path) -> PathBuf {
    let dir = current.parent().unwrap_or_else(|| Path::new(""));
    let stem = current.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    dir.join(format!("{stem}.html"))
}

/// The exported stylesheet path: `default.css` next to the document.
pub fn export_css_path(current: &Path) -> PathBuf {
    current
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join("default.css")
}

/// Assembles the exported `default.css`: the document stylesheets joined
/// with newlines, followed by any extra CSS.
pub fn assemble_css(sheets: &[String], extra: &str) -> String {
    let mut all = sheets.to_vec();
    if !extra.is_empty() {
        all.push(extra.to_string());
    }
    all.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_moves_to_front_and_caps_recent_files() {
        let mut recent = Vec::new();
        add_recent(&mut recent, "a");
        add_recent(&mut recent, "b");
        assert_eq!(recent, vec!["b", "a"]);

        // Re-adding moves to the front without duplicating.
        add_recent(&mut recent, "a");
        assert_eq!(recent, vec!["a", "b"]);

        // The list is capped at ten, dropping the oldest.
        for i in 0..12 {
            add_recent(&mut recent, &format!("f{i}"));
        }
        assert_eq!(recent.len(), MAX_RECENT_FILES);
        assert_eq!(recent[0], "f11");
    }

    #[test]
    fn removes_a_recent_file() {
        let mut recent = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        remove_recent(&mut recent, "b");
        assert_eq!(recent, vec!["a", "c"]);
    }

    #[test]
    fn pins_node_extname() {
        assert_eq!(node_extname("name.md"), ".md");
        assert_eq!(node_extname("name"), "");
        assert_eq!(node_extname("name."), ".");
        assert_eq!(node_extname(".name"), "");
        assert_eq!(node_extname("dir/doc.markdown"), ".markdown");
    }

    #[test]
    fn appends_md_only_when_there_is_no_extension() {
        assert_eq!(save_as_path("doc"), "doc.md");
        assert_eq!(save_as_path(".name"), ".name.md");
        assert_eq!(save_as_path("doc.md"), "doc.md");
        assert_eq!(save_as_path("name."), "name.");
    }

    #[test]
    fn reads_utf8_with_replacement_and_keeps_the_bom() {
        let replaced = read_utf8_lossy(&[b'a', 0xff, b'b']);
        assert!(replaced.contains('\u{FFFD}'));
        assert!(replaced.starts_with('a'));

        let with_bom = read_utf8_lossy(&[0xEF, 0xBB, 0xBF, b'h', b'i']);
        assert!(with_bom.starts_with('\u{FEFF}'));
        assert!(with_bom.ends_with("hi"));
    }

    #[test]
    fn builds_export_paths() {
        let current = PathBuf::from("docs").join("report.md");
        assert_eq!(
            export_html_path(&current),
            PathBuf::from("docs").join("report.html")
        );
        assert_eq!(
            export_css_path(&current),
            PathBuf::from("docs").join("default.css")
        );
    }

    #[test]
    fn assembles_css() {
        let sheets = vec!["a {}".to_string(), "b {}".to_string()];
        assert_eq!(assemble_css(&sheets, "c {}"), "a {}\nb {}\nc {}");
        assert_eq!(assemble_css(&sheets, ""), "a {}\nb {}");
    }
}
