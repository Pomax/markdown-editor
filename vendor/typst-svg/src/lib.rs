//! Rendering of Typst documents into SVG images.

mod fill;
mod shape;
mod text;

use std::collections::HashMap;
use std::fmt::{self, Display, Formatter, Write};

use ecow::EcoString;
use ttf_parser::OutlineBuilder;
use typst_library::layout::{
    Abs, Frame, FrameItem, FrameKind, GroupItem, Page, PagedDocument, Point, Ratio, Size,
    Transform,
};
use typst_library::visualize::Geometry;
use typst_utils::hash128;
use xmlwriter::XmlWriter;

use crate::text::RenderedGlyph;

/// Export a frame into a SVG file.
#[typst_macros::time(name = "svg")]
pub fn svg(page: &Page) -> String {
    let mut renderer = SVGRenderer::new();
    renderer.write_header(page.frame.size());
    renderer.render_page(Transform::identity(), page);
    renderer.finalize()
}

/// Export a frame into a SVG file.
#[typst_macros::time(name = "svg frame")]
pub fn svg_frame(frame: &Frame) -> String {
    let mut renderer = SVGRenderer::new();
    renderer.write_header(frame.size());
    renderer.render_frame(Transform::identity(), frame);
    renderer.finalize()
}

/// Export a document with potentially multiple pages into a single SVG file.
///
/// The padding will be added around and between the individual frames.
pub fn svg_merged(document: &PagedDocument, padding: Abs) -> String {
    let width = 2.0 * padding
        + document
            .pages
            .iter()
            .map(|page| page.frame.width())
            .max()
            .unwrap_or_default();
    let height = padding
        + document
            .pages
            .iter()
            .map(|page| page.frame.height() + padding)
            .sum::<Abs>();

    let mut renderer = SVGRenderer::new();
    renderer.write_header(Size::new(width, height));

    let [x, mut y] = [padding; 2];
    for page in &document.pages {
        renderer.render_page(Transform::translate(x, y), page);
        y += page.frame.height() + padding;
    }

    renderer.finalize()
}

/// Renders one or multiple frames to an SVG file.
struct SVGRenderer {
    /// The internal XML writer.
    xml: XmlWriter,
    /// Prepared glyphs.
    glyphs: Deduplicator<RenderedGlyph>,
    /// Clip paths are used to clip a group. A clip path is a path that defines
    /// the clipping region. The clip path is referenced by the `clip-path`
    /// attribute of the group. The clip path is in the format of `M x y L x y C
    /// x1 y1 x2 y2 x y Z`.
    clip_paths: Deduplicator<EcoString>,
}

impl SVGRenderer {
    /// Create a new SVG renderer with empty glyph and clip path.
    fn new() -> Self {
        SVGRenderer {
            xml: XmlWriter::new(xmlwriter::Options::default()),
            glyphs: Deduplicator::new('g'),
            clip_paths: Deduplicator::new('c'),
        }
    }

    /// Write the SVG header, including the `viewBox` and `width` and `height`
    /// attributes.
    fn write_header(&mut self, size: Size) {
        self.xml.start_element("svg");
        self.xml.write_attribute("class", "typst-doc");
        self.xml.write_attribute_fmt(
            "viewBox",
            format_args!("0 0 {} {}", size.x.to_pt(), size.y.to_pt()),
        );
        self.xml
            .write_attribute_fmt("width", format_args!("{}pt", size.x.to_pt()));
        self.xml
            .write_attribute_fmt("height", format_args!("{}pt", size.y.to_pt()));
        self.xml.write_attribute("xmlns", "http://www.w3.org/2000/svg");
        self.xml
            .write_attribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
        self.xml.write_attribute("xmlns:h5", "http://www.w3.org/1999/xhtml");
    }

    /// Render a page with the given transform.
    fn render_page(&mut self, ts: Transform, page: &Page) {
        if let Some(fill) = page.fill_or_white() {
            let shape = Geometry::Rect(page.frame.size()).filled(fill);
            self.render_shape(&shape);
        }

        self.render_frame(ts, &page.frame);
    }

    /// Render a frame with the given transform.
    fn render_frame(&mut self, ts: Transform, frame: &Frame) {
        self.xml.start_element("g");
        if !ts.is_identity() {
            self.xml.write_attribute("transform", &SvgMatrix(ts));
        }

        for (pos, item) in frame.items() {
            // File size optimization.
            // TODO: SVGs could contain links, couldn't they?
            if matches!(item, FrameItem::Link(_, _) | FrameItem::Tag(_)) {
                continue;
            }

            let x = pos.x.to_pt();
            let y = pos.y.to_pt();
            self.xml.start_element("g");
            self.xml
                .write_attribute_fmt("transform", format_args!("translate({x} {y})"));

            match item {
                FrameItem::Group(group) => self.render_group(group),
                FrameItem::Text(text) => self.render_text(text),
                FrameItem::Shape(shape, _) => self.render_shape(shape),
                FrameItem::Link(_, _) => unreachable!(),
                FrameItem::Tag(_) => unreachable!(),
            };

            self.xml.end_element();
        }

        self.xml.end_element();
    }

    /// Render a group. If the group has `clips` set to true, a clip path will
    /// be created.
    fn render_group(&mut self, group: &GroupItem) {
        self.xml.start_element("g");
        self.xml.write_attribute("class", "typst-group");

        if let Some(label) = group.label {
            self.xml.write_attribute("data-typst-label", &label.resolve());
        }

        if let Some(clip_curve) = &group.clip {
            let hash = hash128(&group);
            let id =
                self.clip_paths.insert_with(hash, || shape::convert_curve(clip_curve));
            self.xml.write_attribute_fmt("clip-path", format_args!("url(#{id})"));
        }

        self.render_frame(group.transform, &group.frame);
        self.xml.end_element();
    }

    /// Finalize the SVG file. This must be called after all rendering is done.
    fn finalize(mut self) -> String {
        self.write_glyph_defs();
        self.write_clip_path_defs();
        self.xml.end_document()
    }

    /// Build the clip path definitions.
    fn write_clip_path_defs(&mut self) {
        if self.clip_paths.is_empty() {
            return;
        }

        self.xml.start_element("defs");
        self.xml.write_attribute("id", "clip-path");

        for (id, path) in self.clip_paths.iter() {
            self.xml.start_element("clipPath");
            self.xml.write_attribute("id", &id);
            self.xml.start_element("path");
            self.xml.write_attribute("d", &path);
            self.xml.end_element();
            self.xml.end_element();
        }

        self.xml.end_element();
    }
}

/// Deduplicates its elements. It is used to deduplicate glyphs and clip paths.
/// The `H` is the hash type, and `T` is the value type. The `PREFIX` is the
/// prefix of the index. This is used to distinguish between glyphs and clip
/// paths.
#[derive(Debug, Clone)]
struct Deduplicator<T> {
    kind: char,
    vec: Vec<(u128, T)>,
    present: HashMap<u128, Id>,
}

impl<T> Deduplicator<T> {
    fn new(kind: char) -> Self {
        Self { kind, vec: Vec::new(), present: HashMap::new() }
    }

    /// Inserts a value into the vector. If the hash is already present, returns
    /// the index of the existing value and `f` will not be called. Otherwise,
    /// inserts the value and returns the id of the inserted value.
    #[must_use = "returns the index of the inserted value"]
    fn insert_with<F>(&mut self, hash: u128, f: F) -> Id
    where
        F: FnOnce() -> T,
    {
        *self.present.entry(hash).or_insert_with(|| {
            let index = self.vec.len();
            self.vec.push((hash, f()));
            Id(self.kind, hash, index)
        })
    }

    /// Iterate over the elements alongside their ids.
    fn iter(&self) -> impl Iterator<Item = (Id, &T)> {
        self.vec
            .iter()
            .enumerate()
            .map(|(i, (id, v))| (Id(self.kind, *id, i), v))
    }

    /// Returns true if the deduplicator is empty.
    fn is_empty(&self) -> bool {
        self.vec.is_empty()
    }
}

/// Identifies a `<def>`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Ord, PartialOrd, Hash)]
struct Id(char, u128, usize);

impl Display for Id {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        write!(f, "{}{:0X}", self.0, self.1)
    }
}

/// Displays as an SVG matrix.
struct SvgMatrix(Transform);

impl Display for SvgMatrix {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        // Convert a [`Transform`] into a SVG transform string.
        // See https://developer.mozilla.org/en-US/docs/Web/SVG/Attribute/transform
        write!(
            f,
            "matrix({} {} {} {} {} {})",
            self.0.sx.get(),
            self.0.ky.get(),
            self.0.kx.get(),
            self.0.sy.get(),
            self.0.tx.to_pt(),
            self.0.ty.to_pt()
        )
    }
}

/// A builder for SVG path.
struct SvgPathBuilder(pub EcoString, pub Ratio);

impl SvgPathBuilder {
    fn with_scale(scale: Ratio) -> Self {
        Self(EcoString::new(), scale)
    }

    fn scale(&self) -> f32 {
        self.1.get() as f32
    }

    /// Create a rectangle path. The rectangle is created with the top-left
    /// corner at (0, 0). The width and height are the size of the rectangle.
    fn rect(&mut self, width: f32, height: f32) {
        self.move_to(0.0, 0.0);
        self.line_to(0.0, height);
        self.line_to(width, height);
        self.line_to(width, 0.0);
        self.close();
    }

}

impl Default for SvgPathBuilder {
    fn default() -> Self {
        Self(Default::default(), Ratio::one())
    }
}

/// A builder for SVG path. This is used to build the path for a glyph.
impl ttf_parser::OutlineBuilder for SvgPathBuilder {
    fn move_to(&mut self, x: f32, y: f32) {
        let scale = self.scale();
        write!(&mut self.0, "M {} {} ", x * scale, y * scale).unwrap();
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let scale = self.scale();
        write!(&mut self.0, "L {} {} ", x * scale, y * scale).unwrap();
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let scale = self.scale();
        write!(
            &mut self.0,
            "Q {} {} {} {} ",
            x1 * scale,
            y1 * scale,
            x * scale,
            y * scale
        )
        .unwrap();
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let scale = self.scale();
        write!(
            &mut self.0,
            "C {} {} {} {} {} {} ",
            x1 * scale,
            y1 * scale,
            x2 * scale,
            y2 * scale,
            x * scale,
            y * scale
        )
        .unwrap();
    }

    fn close(&mut self) {
        write!(&mut self.0, "Z ").unwrap();
    }
}
