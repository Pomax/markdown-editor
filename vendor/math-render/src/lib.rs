//! LaTeX math -> SVG, entirely in Rust: `mitex` converts LaTeX math source
//! to Typst math source, then `typst` compiles it and `typst-svg` exports the
//! result. The font is the system's math font: Cambria Math or STIX Two Math.

use anyhow::{anyhow, Context, Result};
use std::sync::OnceLock;
use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Dict, IntoValue};
use typst::layout::{Abs, Frame, FrameItem, PagedDocument, Point, Transform};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::visualize::{CurveItem, Geometry};
use typst::{Library, World};

/// Uniform margin (in pt) kept around the formula's ink.
const INK_MARGIN_PT: f64 = 6.0;

// `mitex::convert_math` produces Typst source that isn't self-contained —
// it can reference runtime helper functions (e.g. `textmath` for LaTeX's
// `\text{...}`) that the real mitex *Typst package* normally supplies via
// its own `mitex-scope` dict, passed as `eval`'s `scope:` argument
// (confirmed against mitex's own `mimath` implementation, packages/mitex/
// mitex.typ: `eval("$" + res + "$", scope: mitex-scope)`). Since this
// crate calls the Rust `mitex::convert_math` directly rather than going
// through the Typst package (which itself just wraps a bundled WASM build
// of the same conversion), it needs that same `mitex-scope` value without
// the package's WASM plugin machinery — so only the plain-Typst spec
// files that define `mitex-scope` are vendored (see vendor/mitex/NOTICE.md),
// not `mitex.typ`/`lib.typ` themselves.
const MITEX_SPECS_MOD: &str = include_str!("../vendor/mitex/specs/mod.typ");
const MITEX_SPECS_PRELUDE: &str = include_str!("../vendor/mitex/specs/prelude.typ");
const MITEX_SPECS_STANDARD: &str = include_str!("../vendor/mitex/specs/latex/standard.typ");

// `#eval(inputs.body, mode: "markup", scope: mitex-scope)` renders the
// formula passed in through `sys.inputs`, so the fonts and sources are
// loaded once for all formulas. `width: auto, height: auto` shrinks the
// page to fit the formula, so the exported SVG is just the equation, not a
// full page.
//
// `margin: 6pt`, not something thinner: Typst's "auto" page sizing turned
// out to size the frame from the font's nominal line-height metrics, not
// each glyph's actual ink extent — confirmed directly on `\mathrm{j}`,
// whose descender genuinely reaches deeper than that nominal metric. At
// the original `0.2pt` margin the descender's bottom landed past the
// viewBox edge and got silently clipped (rendered as a tail-less "j" that
// read as "i" — a real bug hit in production, not a hypothetical one).
// Kept proportionally wider after the text-size bump below (a bigger font
// means a bigger descender in absolute pt terms too) rather than just
// enough for the size this was first measured at.
//
// `size: 16pt`: the live app's own text (`.md-paragraph` in style.css) is
// `1.1rem` (~13pt) — Typst's math default (11pt) rendered visibly smaller
// than that once embedded as an `<img>`, per user report. 16pt reads
// clearly larger than surrounding prose rather than just matching it,
// since a rendered-image formula sitting inline tends to read smaller
// than same-size real text even at equal nominal size.
const TEMPLATE: &str = r#"
#import sys: inputs
#import "/mitex/specs/mod.typ": mitex-scope
#set page(width: auto, height: auto, margin: 6pt, fill: none)
#set text(size: 16pt, fill: rgb(inputs.color))
#show math.equation: set text(font: ("Cambria Math", "STIX Two Math"))
#eval(inputs.body, mode: "markup", scope: mitex-scope)
"#;

/// The system's math font file: Cambria Math on Windows.
#[cfg(target_os = "windows")]
fn math_font_path() -> Option<String> {
    Some(r"C:\Windows\Fonts\cambria.ttc".into())
}

/// The system's math font file: STIX Two Math on macOS.
#[cfg(target_os = "macos")]
fn math_font_path() -> Option<String> {
    Some("/System/Library/Fonts/Supplemental/STIXTwoMath.otf".into())
}

/// The system's math font file: STIX Two Math on Linux, as `fc-list` finds it.
#[cfg(target_os = "linux")]
fn math_font_path() -> Option<String> {
    let output = std::process::Command::new("fc-list")
        .args(["-f", "%{file}\n", "STIX Two Math"])
        .output()
        .ok()?;
    String::from_utf8(output.stdout).ok()?.lines().next().map(str::to_string)
}

/// Rewrites a few common LaTeX shorthands mitex doesn't handle directly
/// into forms it does. `\cancel{X}` becomes `\xcancel{X}` — mitex defines
/// `\cancel` too, but as a bare `define-cmd(1)` with no handler, so it
/// passes its argument through with no strikethrough at all;
/// `\xcancel`/`\bcancel` are the entries that actually call `math.cancel`.
///
/// `\red{X}`/`\blue{X}` (bare color macros — not standard LaTeX/xcolor,
/// but a common author shorthand) just drop to plain `X`, discarding the
/// color rather than mapping to `\textcolor{red}{X}` as the name might
/// suggest: mitex's own `textcolor` spec entry (`vendor/mitex/specs/latex/
/// standard.typ`) is separately broken — `mitex::convert_math` tokenizes
/// the bare color name `red` as three individual math identifiers
/// (`r e d`, implicit-multiplication style) instead of a string, so the
/// generated Typst call ends up with the wrong argument count and Typst
/// rejects it ("missing argument: body"), confirmed directly against
/// `\textcolor{red}{x}` alone — not something this crate did to it, and
/// not worth a custom Typst command-spec just to color text in an SVG
/// that's otherwise legible in plain black. Recurses into each rewritten
/// argument so nesting (`\red{\cancel{X}}`) resolves correctly at every
/// level.
/// Base color names `\<color>{...}` shorthand recognizes, same list (and
/// `dark`/`light` prefix stripping) as `math-to-speech`'s color-command
/// vocabulary — kept in sync by hand since the two crates don't share a
/// dependency, but authors write the same shorthand commands in either
/// context.
const BASE_COLORS: &[&str] = &[
    "red", "green", "blue", "cyan", "magenta", "yellow", "black", "white", "gray", "grey", "brown", "orange", "pink",
    "purple", "teal", "olive",
];

fn is_color_command(name: &str) -> bool {
    let stripped = name.strip_prefix("dark").or_else(|| name.strip_prefix("light")).unwrap_or(name);
    BASE_COLORS.contains(&stripped)
}

fn canonicalize_shorthand_commands(tex: &str) -> String {
    let mut out = String::with_capacity(tex.len());
    let mut rest = tex;
    loop {
        let Some(backslash) = rest.find('\\') else {
            out.push_str(rest);
            break;
        };
        let after = &rest[backslash + 1..];
        let name_len = after.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(after.len());
        let name = &after[..name_len];
        // `\xcancel`/`\bcancel` are already valid mitex commands — only the
        // bare `\cancel` shorthand (a no-op passthrough in mitex) needs
        // rewriting.
        let is_cancel = name == "cancel";
        let is_color = is_color_command(name);
        if (!is_cancel && !is_color) || after[name_len..].as_bytes().first() != Some(&b'{') {
            // Not a recognized shorthand immediately followed by its `{`
            // argument — copy the backslash itself and resume scanning
            // right after it, so a later shorthand elsewhere in the string
            // is still found.
            out.push_str(&rest[..backslash + 1]);
            rest = after;
            continue;
        }

        out.push_str(&rest[..backslash]);
        let arg_start = backslash + 1 + name_len + 1;
        let Some(close_offset) = matching_brace_offset(&rest[arg_start..]) else {
            // Malformed input (no matching close brace) — leave the rest
            // of the string untouched rather than guessing.
            out.push_str(&rest[backslash..]);
            break;
        };
        let inner = canonicalize_shorthand_commands(&rest[arg_start..arg_start + close_offset]);
        // Replacement is always an *opening* delimiter matched by the
        // closing `}` appended below — `\red{X}` -> a plain `{X}` group
        // (color dropped, but the group itself must stay or e.g.
        // `\red{a+b}^2` would silently start meaning `a+b^2`, applying the
        // superscript to just `b`).
        out.push_str(if is_cancel { "\\xcancel{" } else { "{" });
        out.push_str(&inner);
        out.push('}');
        rest = &rest[arg_start + close_offset + 1..];
    }
    out
}

/// Byte offset (within `s`) of the `}` matching an already-consumed `{` —
/// i.e. `s` starts right after that opening brace. Tracks nesting depth so
/// e.g. `\cancel{X}}` inside a `\red{...}` argument doesn't stop early at
/// the wrong `}`.
fn matching_brace_offset(s: &str) -> Option<usize> {
    let mut depth = 1;
    for (i, c) in s.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// The fonts and source files every formula is compiled with. The first
/// source is the main file.
struct Resources {
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    sources: Vec<Source>,
}

fn resources() -> &'static Resources {
    static RESOURCES: OnceLock<Resources> = OnceLock::new();
    RESOURCES.get_or_init(|| {
        let fonts: Vec<Font> = math_font_path()
            .and_then(|path| std::fs::read(path).ok())
            .map(|data| Font::iter(Bytes::new(data)).collect())
            .unwrap_or_default();
        let sources = [
            ("/main.typ", TEMPLATE),
            ("/mitex/specs/mod.typ", MITEX_SPECS_MOD),
            ("/mitex/specs/prelude.typ", MITEX_SPECS_PRELUDE),
            ("/mitex/specs/latex/standard.typ", MITEX_SPECS_STANDARD),
        ]
        .into_iter()
        .map(|(path, text)| Source::new(FileId::new(None, VirtualPath::new(path)), text.into()))
        .collect();
        Resources { book: LazyHash::new(FontBook::from_fonts(&fonts)), fonts, sources }
    })
}

/// The Typst world a formula is compiled in.
struct MathWorld {
    library: LazyHash<Library>,
    resources: &'static Resources,
}

impl World for MathWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.resources.book
    }

    fn main(&self) -> FileId {
        self.resources.sources[0].id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.resources
            .sources
            .iter()
            .find(|source| source.id() == id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(id.vpath().as_rootless_path().into()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        Err(FileError::NotFound(id.vpath().as_rootless_path().into()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.resources.fonts.get(index).cloned()
    }
}

/// Render `tex` (LaTeX math source, without surrounding `$`/`\(`/`\[`
/// delimiters) to standalone SVG bytes. `display` selects Typst's block
/// math style (roughly LaTeX's `$$...$$`/`\[...\]`) vs. inline style
/// (`$...$`/`\(...\)`). `color` is the text color as a hex string (e.g.
/// `"#000000"`), passed straight through to Typst's `rgb()` — the page
/// background itself is always transparent, so this is the only color
/// that needs to match the surrounding page (light vs. dark mode, etc.).
pub fn render_svg(tex: &str, display: bool, color: &str) -> Result<Vec<u8>> {
    let tex = canonicalize_shorthand_commands(tex);
    let typst_math = mitex::convert_math(&tex, None)
        .map_err(|e| anyhow!("failed to convert LaTeX to Typst: {e}"))?;
    let body = if display {
        format!("$ {typst_math} $")
    } else {
        format!("${typst_math}$")
    };

    let mut inputs = Dict::new();
    inputs.insert("body".into(), body.into_value());
    inputs.insert("color".into(), color.into_value());

    let world = MathWorld {
        library: LazyHash::new(Library::builder().with_inputs(inputs).build()),
        resources: resources(),
    };
    let doc: PagedDocument = typst::compile(&world)
        .output
        .map_err(|e| anyhow!("typst compile failed: {e:?}"))?;

    let page = doc.pages.first().context("typst produced no pages for this formula")?;
    let mut ink = None;
    ink_bounds(&page.frame, Transform::identity(), &mut ink);
    let [min_x, min_y, max_x, max_y] = ink.context("rendered formula has no visible ink")?;
    let (x, y) = (min_x - INK_MARGIN_PT, min_y - INK_MARGIN_PT);
    let width = max_x - min_x + 2.0 * INK_MARGIN_PT;
    let height = max_y - min_y + 2.0 * INK_MARGIN_PT;

    let svg = typst_svg::svg(page);
    let tag_end = svg.find('>').context("rendered SVG has no opening tag")?;
    let mut open_tag = svg[..tag_end].to_string();
    replace_attr(&mut open_tag, "viewBox", &format!("{x} {y} {width} {height}"))?;
    replace_attr(&mut open_tag, "width", &format!("{width}pt"))?;
    replace_attr(&mut open_tag, "height", &format!("{height}pt"))?;
    Ok(format!("{open_tag}{}", &svg[tag_end..]).into_bytes())
}

/// Grows `ink` (min x, min y, max x, max y, in pt) to cover every glyph
/// outline and shape in `frame`.
fn ink_bounds(frame: &Frame, ts: Transform, ink: &mut Option<[f64; 4]>) {
    for (pos, item) in frame.items() {
        let ts = ts.pre_concat(Transform::translate(pos.x, pos.y));
        match item {
            FrameItem::Group(group) => {
                ink_bounds(&group.frame, ts.pre_concat(group.transform), ink)
            }
            FrameItem::Text(text) => {
                let scale = text.size.to_pt() / text.font.units_per_em();
                let mut x = 0.0;
                for glyph in &text.glyphs {
                    let left = x + glyph.x_offset.at(text.size).to_pt();
                    let id = ttf_parser::GlyphId(glyph.id);
                    if let Some(rect) = text.font.ttf().glyph_bounding_box(id) {
                        let xs = [f64::from(rect.x_min), f64::from(rect.x_max)];
                        let ys = [f64::from(rect.y_max), f64::from(rect.y_min)];
                        add_box(ink, ts, xs.map(|ux| left + ux * scale), ys.map(|uy| -uy * scale));
                    }
                    x += glyph.x_advance.at(text.size).to_pt();
                }
            }
            FrameItem::Shape(shape, _) => {
                let half = shape.stroke.as_ref().map_or(0.0, |stroke| stroke.thickness.to_pt() / 2.0);
                let points = match &shape.geometry {
                    Geometry::Line(end) => vec![Point::zero(), *end],
                    Geometry::Rect(size) => vec![Point::zero(), Point::new(size.x, size.y)],
                    Geometry::Curve(curve) => curve
                        .0
                        .iter()
                        .flat_map(|item| match item {
                            CurveItem::Move(p) | CurveItem::Line(p) => vec![*p],
                            CurveItem::Cubic(a, b, c) => vec![*a, *b, *c],
                            CurveItem::Close => vec![],
                        })
                        .collect(),
                };
                for p in points {
                    let (px, py) = (p.x.to_pt(), p.y.to_pt());
                    add_box(ink, ts, [px - half, px + half], [py - half, py + half]);
                }
            }
            _ => {}
        }
    }
}

/// Grows `ink` to cover the box `xs` by `ys`, after `ts`.
fn add_box(ink: &mut Option<[f64; 4]>, ts: Transform, xs: [f64; 2], ys: [f64; 2]) {
    for x in xs {
        for y in ys {
            let p = Point::new(Abs::pt(x), Abs::pt(y)).transform(ts);
            let (x, y) = (p.x.to_pt(), p.y.to_pt());
            *ink = Some(match *ink {
                None => [x, y, x, y],
                Some([l, t, r, b]) => [l.min(x), t.min(y), r.max(x), b.max(y)],
            });
        }
    }
}

fn replace_attr(tag: &mut String, name: &str, new_value: &str) -> Result<()> {
    let needle = format!("{name}=\"");
    let value_start = tag.find(&needle).with_context(|| format!("SVG opening tag has no {name} attribute"))? + needle.len();
    let value_end = value_start
        + tag[value_start..].find('"').with_context(|| format!("SVG opening tag's {name} attribute has no closing quote"))?;
    tag.replace_range(value_start..value_end, new_value);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_svg_inline_produces_svg_bytes() {
        let svg = render_svg("x(t)", false, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    #[test]
    fn render_svg_display_produces_svg_bytes() {
        let svg = render_svg(r"x(t) = A \sin(\omega t)", true, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    #[test]
    fn render_svg_fraction_and_greek_letters() {
        let svg = render_svg(r"\frac{\pi}{2}", false, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    // Regression: `\text{...}` converts to a call to mitex's own
    // `textmath` runtime helper, which only exists if `mitex-scope` is
    // passed to `eval` — without it this failed with "unknown variable:
    // textmath" (a real bug hit in production, not a hypothetical one).
    #[test]
    fn render_svg_text_command_needs_mitex_scope() {
        let svg = render_svg(r"n^\text{th}", false, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    /// Extracts `viewBox`'s height and, for every `translate(x y)` +
    /// glyph `<path d="...">` pair in the SVG, checks the glyph's ink
    /// stays within `[0, height]` after the `scale(1, -1)` flip typst-svg
    /// always applies to text — i.e. nothing is clipped top or bottom.
    /// Deliberately simple (assumes path coordinates come in `x y` pairs,
    /// true for the M/L/C commands typst-svg emits) rather than a full SVG
    /// path parser — enough to catch the exact class of bug this guards.
    fn assert_no_glyph_clipping(svg: &str) {
        // `render_svg` crops `viewBox` to the formula's own ink plus a
        // margin, so `viewBox`'s origin is not `0 0`: min_y has to come from
        // the string.
        let viewbox: Vec<f64> = svg
            .split("viewBox=\"").nth(1).expect("viewBox present")
            .split('"').next().unwrap()
            .split_whitespace()
            .map(|n| n.parse().expect("viewBox value is a number"))
            .collect();
        let (min_y, height) = (viewbox[1], viewbox[3]);
        let y_range = min_y..=(min_y + height);

        for glyph in svg.split("<g transform=\"translate(").skip(1) {
            let coords = glyph.split(')').next().unwrap();
            let mut it = coords.split_whitespace();
            let _tx: f64 = it.next().unwrap().parse().unwrap();
            let ty: f64 = it.next().unwrap().parse().unwrap();

            let Some(path_start) = glyph.find("d=\"") else { continue };
            let path = &glyph[path_start + 3..];
            let path = &path[..path.find('"').unwrap()];

            let numbers: Vec<f64> = path
                .split(|c: char| c.is_whitespace() || c == ',')
                .filter_map(|t| {
                    let t = t.trim_start_matches(|c: char| c.is_ascii_alphabetic());
                    t.parse::<f64>().ok()
                })
                .collect();
            for pair in numbers.chunks(2) {
                let [_x, y] = pair else { continue };
                // scale(1, -1) flips the glyph's local y before translate.
                let screen_y = ty - y;
                assert!(
                    y_range.contains(&screen_y),
                    "glyph ink at screen_y={screen_y} falls outside viewBox y-range={y_range:?} — clipped: {svg}"
                );
            }
        }
    }

    #[test]
    fn render_svg_descender_is_not_clipped() {
        // \mathrm{j}'s descender is the exact glyph that motivated
        // widening the page margin — see TEMPLATE's comment.
        let svg = render_svg(r"\mathrm{j}", false, "#000000").unwrap();
        assert_no_glyph_clipping(&String::from_utf8(svg).unwrap());
    }

    #[test]
    fn render_svg_subscript_descender_is_not_clipped() {
        let svg = render_svg(r"g_j", false, "#000000").unwrap();
        assert_no_glyph_clipping(&String::from_utf8(svg).unwrap());
    }

    // `\red`/`\blue` (bare, not `\textcolor{red}{...}`) and `\cancel` (mitex
    // defines it as a no-op passthrough) all error or silently no-op
    // without `canonicalize_shorthand_commands` rewriting them first.
    #[test]
    fn render_svg_supports_red_blue_and_cancel() {
        let svg = render_svg(r"\red{x} \blue{y} \cancel{z}", false, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    // The real motivating case: color and cancel nested together, as units
    // canceling out in a derivation.
    #[test]
    fn render_svg_supports_nested_color_and_cancel() {
        let svg = render_svg(r"\red{\cancel{\text{cycle}}}", false, "#000000").unwrap();
        let text = String::from_utf8(svg).unwrap();
        assert!(text.starts_with("<svg"), "expected SVG output, got: {text}");
    }

    // The generalized color vocabulary — the real corpus of failures found
    // in "Digital Signals Theory" used `\purple`/`\magenta`/`\darkblue`/
    // `\cyan`, none of which were in the original two-color rewrite list.
    #[test]
    fn render_svg_supports_full_color_vocabulary() {
        for tex in [
            r"\purple{\theta}",
            r"\magenta{-\theta}",
            r"\darkblue{X[m]}",
            r"\cyan{a[0]}",
        ] {
            let svg = render_svg(tex, false, "#000000").unwrap_or_else(|e| panic!("{tex}: {e}"));
            let text = String::from_utf8(svg).unwrap();
            assert!(text.starts_with("<svg"), "{tex}: expected SVG output, got: {text}");
        }
    }

    #[test]
    fn canonicalize_shorthand_commands_rewrites_and_recurses() {
        assert_eq!(canonicalize_shorthand_commands(r"\red{x}"), r"{x}");
        assert_eq!(canonicalize_shorthand_commands(r"\blue{y}"), r"{y}");
        assert_eq!(canonicalize_shorthand_commands(r"\cancel{z}"), r"\xcancel{z}");
        assert_eq!(canonicalize_shorthand_commands(r"\red{\cancel{x}}"), r"{\xcancel{x}}");
        // The grouping brace survives even though the color itself is
        // dropped — without it, `\red{a+b}^2` would silently start meaning
        // `a+b^2` (superscript applying to just `b`) instead of `(a+b)^2`.
        assert_eq!(canonicalize_shorthand_commands(r"\red{a+b}^2"), r"{a+b}^2");
        // Untouched when none of the shorthands appear.
        assert_eq!(canonicalize_shorthand_commands(r"\frac{\pi}{2}"), r"\frac{\pi}{2}");
    }

    #[test]
    fn canonicalize_shorthand_commands_covers_full_color_vocabulary() {
        for color in ["purple", "magenta", "cyan", "darkblue", "green", "darkgreen", "lightgray"] {
            let tex = format!("\\{color}{{x}}");
            assert_eq!(canonicalize_shorthand_commands(&tex), "{x}", "color: {color}");
        }
        // Not a recognized color — left untouched (same as `\frac` above).
        assert_eq!(canonicalize_shorthand_commands(r"\ultraviolet{x}"), r"\ultraviolet{x}");
    }
}
