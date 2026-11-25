use std::fmt::{self, Debug, Formatter};

use ecow::EcoString;

use crate::foundations::{cast, Repr};
use crate::visualize::Color;

/// How a fill or stroke should be painted.
#[derive(Clone, Eq, PartialEq, Hash)]
pub enum Paint {
    /// A solid color.
    Solid(Color),
}

impl Paint {
    /// Unwraps a solid color used for text rendering.
    pub fn unwrap_solid(&self) -> Color {
        match self {
            Self::Solid(color) => *color,
        }
    }

    /// Turns this paint into a paint for a text decoration.
    pub fn as_decoration(&self) -> Self {
        self.clone()
    }
}

impl Debug for Paint {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        match self {
            Self::Solid(v) => v.fmt(f),
        }
    }
}

impl Repr for Paint {
    fn repr(&self) -> EcoString {
        match self {
            Self::Solid(color) => color.repr(),
        }
    }
}

impl<T: Into<Color>> From<T> for Paint {
    fn from(t: T) -> Self {
        Self::Solid(t.into())
    }
}

cast! {
    Paint,
    self => match self {
        Self::Solid(color) => color.into_value(),
    },
    color: Color => Self::Solid(color),
}
