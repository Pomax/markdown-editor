//! Drawing and visualization.

mod curve;
mod line;
mod paint;
mod path;
mod polygon;
mod rgb;
mod shape;
mod stroke;

pub use self::curve::*;
pub use self::line::*;
pub use self::paint::*;
pub use self::path::*;
pub use self::polygon::*;
pub use self::rgb::*;
pub use self::shape::*;
pub use self::stroke::*;

use crate::foundations::{Element, Scope};

/// Hook up all visualize definitions.
pub(super) fn define(global: &mut Scope) {
    global.start_category(crate::Category::Visualize);
    global.define_type::<Color>();
    global.define_type::<Stroke>();
    global.define_elem::<LineElem>();
    global.define_elem::<RectElem>();
    global.define_elem::<SquareElem>();
    global.define_elem::<EllipseElem>();
    global.define_elem::<CircleElem>();
    global.define_elem::<PolygonElem>();
    global.define_elem::<CurveElem>();
    global
        .define("path", Element::of::<PathElem>())
        .deprecated("the `path` function is deprecated, use `curve` instead");
    global.reset_category();
}
