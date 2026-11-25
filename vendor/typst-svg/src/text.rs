use ecow::EcoString;
use ttf_parser::GlyphId;
use typst_library::layout::Ratio;
use typst_library::text::{Font, TextItem};
use typst_library::visualize::FillRule;
use typst_utils::hash128;

use crate::{SVGRenderer, SvgPathBuilder};

impl SVGRenderer {
    /// Render a text item as a group of outline glyphs.
    pub(super) fn render_text(&mut self, text: &TextItem) {
        let scale: f64 = text.size.to_pt() / text.font.units_per_em();

        self.xml.start_element("g");
        self.xml.write_attribute("class", "typst-text");
        self.xml.write_attribute("transform", "scale(1, -1)");

        let mut x: f64 = 0.0;
        for glyph in &text.glyphs {
            let id = GlyphId(glyph.id);
            let offset = x + glyph.x_offset.at(text.size).to_pt();
            self.render_outline_glyph(text, id, offset, scale);
            x += glyph.x_advance.at(text.size).to_pt();
        }

        self.xml.end_element();
    }

    /// Render a glyph defined by an outline.
    fn render_outline_glyph(
        &mut self,
        text: &TextItem,
        glyph_id: GlyphId,
        x_offset: f64,
        scale: f64,
    ) -> Option<()> {
        let scale = Ratio::new(scale);
        let path = convert_outline_glyph_to_path(&text.font, glyph_id, scale)?;
        let hash = hash128(&(&text.font, glyph_id, scale));
        let id = self.glyphs.insert_with(hash, || RenderedGlyph::Path(path));

        self.xml.start_element("use");
        self.xml.write_attribute_fmt("xlink:href", format_args!("#{id}"));
        self.xml.write_attribute_fmt("x", format_args!("{x_offset}"));
        self.write_fill(&text.fill, FillRule::default());
        if let Some(stroke) = &text.stroke {
            self.write_stroke(stroke);
        }
        self.xml.end_element();

        Some(())
    }

    /// Build the glyph definitions.
    pub(super) fn write_glyph_defs(&mut self) {
        if self.glyphs.is_empty() {
            return;
        }

        self.xml.start_element("defs");
        self.xml.write_attribute("id", "glyph");

        for (id, glyph) in self.glyphs.iter() {
            self.xml.start_element("symbol");
            self.xml.write_attribute("id", &id);
            self.xml.write_attribute("overflow", "visible");

            match glyph {
                RenderedGlyph::Path(path) => {
                    self.xml.start_element("path");
                    self.xml.write_attribute("d", &path);
                    self.xml.end_element();
                }
            }

            self.xml.end_element();
        }

        self.xml.end_element();
    }
}

/// Represents a glyph to be rendered.
pub enum RenderedGlyph {
    /// A path is a sequence of drawing commands.
    ///
    /// It is in the format of `M x y L x y C x1 y1 x2 y2 x y Z`.
    Path(EcoString),
}

/// Convert an outline glyph to an SVG path.
#[comemo::memoize]
fn convert_outline_glyph_to_path(
    font: &Font,
    id: GlyphId,
    scale: Ratio,
) -> Option<EcoString> {
    let mut builder = SvgPathBuilder::with_scale(scale);
    font.ttf().outline_glyph(id, &mut builder)?;
    Some(builder.0)
}
