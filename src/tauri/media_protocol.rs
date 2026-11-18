//! The `media` protocol, through which the page loads local image, audio
//! and video files. A request's path is `/` followed by the file's path,
//! percent-encoded. Only files with an image, audio or video extension
//! are served; every response says what it holds and carries
//! `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
//! sandbox`, so no served file can run script, and none carries a CORS
//! header, so a page script cannot read a file's bytes. Byte-range
//! requests are answered, so media can seek.

/// The most bytes one response carries for a range with no end, so a
/// large video is read a part at a time.
pub const MAX_CHUNK: u64 = 4 * 1024 * 1024;

/// The `Content-Type` of each extension the protocol serves.
const TYPES: [(&str, &str); 24] = [
    ("png", "image/png"),
    ("apng", "image/apng"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
    ("avif", "image/avif"),
    ("mp3", "audio/mpeg"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("oga", "audio/ogg"),
    ("opus", "audio/ogg"),
    ("m4a", "audio/mp4"),
    ("aac", "audio/aac"),
    ("flac", "audio/flac"),
    ("weba", "audio/webm"),
    ("mp4", "video/mp4"),
    ("m4v", "video/mp4"),
    ("webm", "video/webm"),
    ("ogv", "video/ogg"),
    ("mov", "video/quicktime"),
];

/// The `Content-Type` of a response that holds no file.
const NO_FILE_TYPE: &str = "text/plain; charset=utf-8";

/// A response: its status, its headers and its body.
#[derive(Debug)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

/// The files the protocol reads, passed in so the tests touch no disk.
pub trait Files {
    /// The file's length, or none when there is no such file.
    fn len(&self, path: &str) -> Option<u64>;
    /// Up to `length` bytes of the file, from `start`.
    fn read(&self, path: &str, start: u64, length: u64) -> std::io::Result<Vec<u8>>;
}

/// The files on disk.
pub struct Disk;

impl Files for Disk {
    fn len(&self, path: &str) -> Option<u64> {
        std::fs::metadata(path)
            .ok()
            .filter(std::fs::Metadata::is_file)
            .map(|metadata| metadata.len())
    }

    fn read(&self, path: &str, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(start))?;
        let mut body = Vec::new();
        file.take(length).read_to_end(&mut body)?;
        Ok(body)
    }
}

/// The `Content-Type` of a file the protocol serves, by its extension,
/// or none for any other file.
pub fn content_type(path: &str) -> Option<&'static str> {
    let name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    let (_, extension) = name.rsplit_once('.')?;
    let extension = extension.to_ascii_lowercase();
    TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}

/// The response to a request for a URL path, with the request's `Range`
/// header when it had one.
pub fn reply(url_path: &str, range: Option<&str>, files: &impl Files) -> Reply {
    let path = crate::image_path::percent_decode(url_path.strip_prefix('/').unwrap_or(url_path));
    let Some(mime) = content_type(&path) else {
        return no_file(403, Vec::new());
    };
    let Some(len) = files.len(&path) else {
        return no_file(404, Vec::new());
    };
    let Some(range) = range else {
        return match files.read(&path, 0, len) {
            Ok(body) => Reply {
                status: 200,
                headers: headers(
                    mime,
                    vec![
                        ("Content-Length", body.len().to_string()),
                        ("Accept-Ranges", "bytes".to_string()),
                    ],
                ),
                body,
            },
            Err(_) => no_file(404, Vec::new()),
        };
    };
    let Some((start, end)) = byte_range(range, len) else {
        return no_file(416, vec![("Content-Range", format!("bytes */{len}"))]);
    };
    match files.read(&path, start, end - start + 1) {
        Ok(body) => Reply {
            status: 206,
            headers: headers(
                mime,
                vec![
                    ("Content-Length", body.len().to_string()),
                    ("Content-Range", format!("bytes {start}-{end}/{len}")),
                    ("Accept-Ranges", "bytes".to_string()),
                ],
            ),
            body,
        },
        Err(_) => no_file(404, Vec::new()),
    }
}

/// Answers a request to the `media` protocol from the files on disk.
pub fn handle(request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    let reply = reply(request.uri().path(), range, &Disk);
    let mut response = tauri::http::Response::builder().status(reply.status);
    for (name, value) in reply.headers {
        response = response.header(name, value);
    }
    response
        .body(reply.body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

/// A response that holds no file, with its status and any extra headers.
fn no_file(status: u16, extra: Vec<(&'static str, String)>) -> Reply {
    Reply {
        status,
        headers: headers(NO_FILE_TYPE, extra),
        body: Vec::new(),
    }
}

/// A response's headers: its `Content-Type`, the two that keep a served
/// file from running script, and any extra ones.
fn headers(content_type: &str, extra: Vec<(&'static str, String)>) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("Content-Type", content_type.to_string()),
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("Content-Security-Policy", "sandbox".to_string()),
    ];
    headers.extend(extra);
    headers
}

/// The first and last byte a `Range` header asks for, cut to fit the file
/// and to at most one chunk when it gives no end, or none when it asks
/// for nothing the file holds. Only the first range of several is
/// answered.
fn byte_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let (first, last) = spec.split(',').next()?.trim().split_once('-')?;
    if len == 0 {
        return None;
    }
    let (start, end) = if first.is_empty() {
        let suffix: u64 = last.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = first.parse().ok()?;
        let end = if last.is_empty() {
            start.saturating_add(MAX_CHUNK - 1)
        } else {
            last.parse().ok()?
        };
        (start, end.min(len - 1))
    };
    (start <= end).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Files held in memory, by path.
    struct Memory(HashMap<String, Vec<u8>>);

    impl Files for Memory {
        fn len(&self, path: &str) -> Option<u64> {
            self.0.get(path).map(|bytes| bytes.len() as u64)
        }

        fn read(&self, path: &str, start: u64, length: u64) -> std::io::Result<Vec<u8>> {
            let bytes = self
                .0
                .get(path)
                .ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?;
            let start = start as usize;
            let end = (start + length as usize).min(bytes.len());
            Ok(bytes[start..end].to_vec())
        }
    }

    /// An image, a video, a text file and an SVG with an upper-case
    /// extension.
    fn files() -> Memory {
        Memory(HashMap::from([
            (
                "C:\\images\\photo one.png".to_string(),
                b"0123456789".to_vec(),
            ),
            ("/notes/clip.mp4".to_string(), vec![7; 10]),
            ("C:\\notes\\readme.txt".to_string(), b"secret".to_vec()),
            ("C:\\images\\drawing.SVG".to_string(), b"<svg/>".to_vec()),
        ]))
    }

    /// The URL path of the image.
    const PHOTO: &str = "/C%3A%5Cimages%5Cphoto%20one.png";

    /// A header's value, by name in any case.
    fn header<'a>(reply: &'a Reply, name: &str) -> Option<&'a str> {
        reply
            .headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn media_protocol_serves_an_image_by_its_percent_encoded_path() {
        let reply = reply(PHOTO, None, &files());
        assert_eq!(reply.status, 200);
        assert_eq!(header(&reply, "Content-Type"), Some("image/png"));
        assert_eq!(header(&reply, "Content-Length"), Some("10"));
        assert_eq!(header(&reply, "Accept-Ranges"), Some("bytes"));
        assert_eq!(reply.body, b"0123456789");
    }

    #[test]
    fn media_protocol_serves_a_posix_path_and_types_by_extension_in_any_case() {
        let video = reply("/%2Fnotes%2Fclip.mp4", None, &files());
        assert_eq!(video.status, 200);
        assert_eq!(header(&video, "Content-Type"), Some("video/mp4"));
        let svg = reply("/C%3A%5Cimages%5Cdrawing.SVG", None, &files());
        assert_eq!(header(&svg, "Content-Type"), Some("image/svg+xml"));
        assert_eq!(content_type("song.MP3"), Some("audio/mpeg"));
        assert_eq!(content_type("clip.webm"), Some("video/webm"));
        assert_eq!(content_type("photo.jpeg"), Some("image/jpeg"));
    }

    #[test]
    fn media_protocol_refuses_a_file_that_is_not_an_image_audio_or_video() {
        assert_eq!(content_type("readme.txt"), None);
        assert_eq!(content_type("page.html"), None);
        assert_eq!(content_type("no-extension"), None);
        let reply = reply("/C%3A%5Cnotes%5Creadme.txt", None, &files());
        assert_eq!(reply.status, 403);
        assert!(reply.body.is_empty());
    }

    #[test]
    fn media_protocol_answers_a_missing_file_with_404() {
        let reply = reply("/C%3A%5Cimages%5Cmissing.png", None, &files());
        assert_eq!(reply.status, 404);
        assert!(reply.body.is_empty());
    }

    #[test]
    fn media_protocol_answers_byte_ranges() {
        let middle = reply(PHOTO, Some("bytes=2-5"), &files());
        assert_eq!(middle.status, 206);
        assert_eq!(header(&middle, "Content-Range"), Some("bytes 2-5/10"));
        assert_eq!(header(&middle, "Content-Length"), Some("4"));
        assert_eq!(middle.body, b"2345");

        let open_ended = reply(PHOTO, Some("bytes=7-"), &files());
        assert_eq!(header(&open_ended, "Content-Range"), Some("bytes 7-9/10"));
        assert_eq!(open_ended.body, b"789");

        let suffix = reply(PHOTO, Some("bytes=-3"), &files());
        assert_eq!(header(&suffix, "Content-Range"), Some("bytes 7-9/10"));
        assert_eq!(suffix.body, b"789");

        let past_the_end = reply(PHOTO, Some("bytes=20-30"), &files());
        assert_eq!(past_the_end.status, 416);
        assert_eq!(header(&past_the_end, "Content-Range"), Some("bytes */10"));
        assert!(past_the_end.body.is_empty());
    }

    #[test]
    fn media_protocol_answers_a_range_with_no_end_with_at_most_one_chunk() {
        let size = MAX_CHUNK + 10;
        let files = Memory(HashMap::from([(
            "/videos/long.mp4".to_string(),
            vec![1; size as usize],
        )]));
        let reply = reply("/%2Fvideos%2Flong.mp4", Some("bytes=0-"), &files);
        assert_eq!(reply.status, 206);
        assert_eq!(
            header(&reply, "Content-Range"),
            Some(format!("bytes 0-{}/{size}", MAX_CHUNK - 1).as_str())
        );
        assert_eq!(reply.body.len() as u64, MAX_CHUNK);
    }

    #[test]
    fn media_protocol_sends_the_safety_headers_and_no_cors_header_on_every_response() {
        let files = files();
        let replies = [
            reply(PHOTO, None, &files),
            reply(PHOTO, Some("bytes=2-5"), &files),
            reply(PHOTO, Some("bytes=20-30"), &files),
            reply("/C%3A%5Cnotes%5Creadme.txt", None, &files),
            reply("/C%3A%5Cimages%5Cmissing.png", None, &files),
        ];
        for reply in &replies {
            assert!(header(reply, "Content-Type").is_some(), "{reply:?}");
            assert_eq!(header(reply, "X-Content-Type-Options"), Some("nosniff"));
            assert_eq!(header(reply, "Content-Security-Policy"), Some("sandbox"));
            assert!(
                reply
                    .headers
                    .iter()
                    .all(|(name, _)| !name.to_ascii_lowercase().starts_with("access-control-")),
                "{reply:?}"
            );
        }
    }
}
