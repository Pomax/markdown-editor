//! Solid color fills.

use ecow::EcoString;
use typst_library::visualize::{Color, FillRule, Paint};

use crate::SVGRenderer;

impl SVGRenderer {
    /// Write a fill attribute.
    pub(super) fn write_fill(&mut self, fill: &Paint, fill_rule: FillRule) {
        match fill {
            Paint::Solid(color) => self.xml.write_attribute("fill", &color.encode()),
        }
        match fill_rule {
            FillRule::NonZero => self.xml.write_attribute("fill-rule", "nonzero"),
            FillRule::EvenOdd => self.xml.write_attribute("fill-rule", "evenodd"),
        }
    }
}

/// Encode the color as an SVG color.
pub trait ColorEncode {
    /// Encode the color.
    fn encode(&self) -> EcoString;
}

impl ColorEncode for Color {
    fn encode(&self) -> EcoString {
        self.to_hex()
    }
}
