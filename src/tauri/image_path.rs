//! Image helpers: the rename name
//! check that refuses anything but a plain file name, and the
//! document-relative image path conversion that pins Node's
//! `path.relative` for Windows, including the `file:///` prefix and the
//! case-insensitive comparison.

/// Whether a name is a plain file name: non-empty, with no path
/// separator and not a current- or parent-directory reference.
pub fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\'])
}

/// Renames an image to a new name in its own folder: a rename to the same path changes nothing, an existing
/// target is refused, and the rename's own error is passed on. Returns
/// the new path, or the error's message. Whether a path exists and the
/// rename itself are passed in.
pub fn rename_image(
    old_path: &str,
    new_name: &str,
    exists: impl Fn(&std::path::Path) -> bool,
    rename: impl Fn(&std::path::Path, &std::path::Path) -> std::io::Result<()>,
) -> Result<String, String> {
    let directory = std::path::Path::new(old_path)
        .parent()
        .unwrap_or_else(|| std::path::Path::new(""));
    let new_path = directory.join(new_name);
    let new_path_text = new_path.to_string_lossy().into_owned();
    if new_path_text == old_path {
        return Ok(new_path_text);
    }
    if exists(&new_path) {
        return Err(format!("A file named \"{new_name}\" already exists."));
    }
    rename(std::path::Path::new(old_path), &new_path)
        .map(|()| new_path_text)
        .map_err(|error| error.to_string())
}

/// Converts an absolute image path to a `./`-prefixed path relative to
/// the document's folder when the image sits at or below it, otherwise
/// returns the original value.
pub fn to_relative(image_path: &str, document_path: &str) -> String {
    if image_path.is_empty() || document_path.is_empty() {
        return image_path.to_string();
    }
    let (image_drive, image_segments) = split_path(&strip_file_url(image_path));
    let (document_drive, mut document_segments) = split_path(document_path);
    // The document folder is the document path without its file name.
    document_segments.pop();

    if !image_drive.eq_ignore_ascii_case(&document_drive)
        || image_segments.len() <= document_segments.len()
    {
        return image_path.to_string();
    }
    for (folder, image) in document_segments.iter().zip(image_segments.iter()) {
        if !folder.eq_ignore_ascii_case(image) {
            return image_path.to_string();
        }
    }
    format!("./{}", image_segments[document_segments.len()..].join("/"))
}

/// Strips a `file:///` prefix and percent-decodes the rest, leaving any
/// other path untouched.
fn strip_file_url(path: &str) -> String {
    match path.strip_prefix("file:///") {
        Some(rest) => percent_decode(rest),
        None => path.to_string(),
    }
}

/// Splits a path into its drive (for example `C:`, or empty) and its
/// normalized segments, resolving `.` and `..` and treating both slash
/// kinds as separators.
pub fn split_path(path: &str) -> (String, Vec<String>) {
    let unified = path.replace('\\', "/");
    let mut drive = String::new();
    let mut segments: Vec<String> = Vec::new();
    for part in unified.split('/').filter(|part| !part.is_empty()) {
        if drive.is_empty() && segments.is_empty() && part.ends_with(':') {
            drive = part.to_string();
        } else if part == "." {
        } else if part == ".." {
            segments.pop();
        } else {
            segments.push(part.to_string());
        }
    }
    (drive, segments)
}

/// Percent-decodes a string, leaving invalid escapes as written.
pub fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The numeric value of a hexadecimal digit byte.
fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_rename_requires_a_plain_file_name() {
        assert!(is_plain_file_name("photo.png"));
        assert!(is_plain_file_name("a b.jpg"));
        assert!(!is_plain_file_name("sub/photo.png"));
        assert!(!is_plain_file_name("sub\\photo.png"));
        assert!(!is_plain_file_name(".."));
        assert!(!is_plain_file_name("."));
        assert!(!is_plain_file_name(""));
    }

    #[test]
    fn to_relative_returns_a_dot_slash_path_under_the_document() {
        assert_eq!(
            to_relative("C:\\docs\\img\\a.png", "C:\\docs\\note.md"),
            "./img/a.png"
        );
        assert_eq!(
            to_relative("C:\\docs\\a.png", "C:\\docs\\note.md"),
            "./a.png"
        );
    }

    #[test]
    fn to_relative_keeps_the_original_outside_the_document_folder() {
        assert_eq!(
            to_relative("C:\\other\\a.png", "C:\\docs\\note.md"),
            "C:\\other\\a.png"
        );
        assert_eq!(to_relative("D:\\a.png", "C:\\docs\\note.md"), "D:\\a.png");
    }

    #[test]
    fn to_relative_is_case_insensitive_and_strips_a_file_url() {
        assert_eq!(
            to_relative("C:\\Docs\\img\\a.png", "c:\\docs\\note.md"),
            "./img/a.png"
        );
        assert_eq!(
            to_relative("file:///C:/docs/img/a.png", "C:\\docs\\note.md"),
            "./img/a.png"
        );
        assert_eq!(
            to_relative("file:///C:/docs/my%20img/a.png", "C:\\docs\\note.md"),
            "./my img/a.png"
        );
    }

    #[test]
    fn to_relative_passes_empty_inputs_through() {
        assert_eq!(to_relative("", "C:\\docs\\note.md"), "");
        assert_eq!(to_relative("C:\\docs\\a.png", ""), "C:\\docs\\a.png");
    }
}
