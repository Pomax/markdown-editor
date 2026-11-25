//! Colors.

use std::fmt::{self, Debug, Formatter};
use std::hash::{Hash, Hasher};
use std::str::FromStr;

use ecow::{eco_format, EcoString};
use typst_syntax::Spanned;

use crate::diag::{bail, At, SourceResult};
use crate::foundations::{cast, func, scope, ty, Args, Repr, Str};
use crate::layout::Ratio;

/// A color: red, green, blue and alpha components, each between 0 and 1.
///
/// Colors are made with [`rgb`]($color.rgb), from components or a
/// hexadecimal string, or are one of the predefined colors such as `{red}`.
#[ty(scope, cast)]
#[derive(Copy, Clone)]
pub struct Color {
    /// The red, green, blue and alpha components.
    components: [f32; 4],
}

#[scope]
impl Color {
    pub const BLACK: Self = Self::new(0.0, 0.0, 0.0, 1.0);
    pub const GRAY: Self = Self::new(0.6666666, 0.6666666, 0.6666666, 1.0);
    pub const WHITE: Self = Self::new(1.0, 1.0, 1.0, 1.0);
    pub const SILVER: Self = Self::new(0.8666667, 0.8666667, 0.8666667, 1.0);
    pub const NAVY: Self = Self::new(0.0, 0.121569, 0.247059, 1.0);
    pub const BLUE: Self = Self::new(0.0, 0.454902, 0.85098, 1.0);
    pub const AQUA: Self = Self::new(0.4980392, 0.858823, 1.0, 1.0);
    pub const TEAL: Self = Self::new(0.223529, 0.8, 0.8, 1.0);
    pub const EASTERN: Self = Self::new(0.13725, 0.615686, 0.678431, 1.0);
    pub const PURPLE: Self = Self::new(0.694118, 0.050980, 0.788235, 1.0);
    pub const FUCHSIA: Self = Self::new(0.941177, 0.070588, 0.745098, 1.0);
    pub const MAROON: Self = Self::new(0.521569, 0.078431, 0.294118, 1.0);
    pub const RED: Self = Self::new(1.0, 0.254902, 0.211765, 1.0);
    pub const ORANGE: Self = Self::new(1.0, 0.521569, 0.105882, 1.0);
    pub const YELLOW: Self = Self::new(1.0, 0.8627451, 0.0, 1.0);
    pub const OLIVE: Self = Self::new(0.239216, 0.6, 0.4392157, 1.0);
    pub const GREEN: Self = Self::new(0.1803922, 0.8, 0.2509804, 1.0);
    pub const LIME: Self = Self::new(0.0039216, 1.0, 0.4392157, 1.0);

    /// Create a color from red, green, blue and optional alpha components,
    /// each an integer from 0 to 255 or a ratio, or from a hexadecimal
    /// string of three, four, six or eight digits with an optional leading
    /// hash.
    #[func(title = "RGB")]
    pub fn rgb(
        args: &mut Args,
        /// The red component.
        #[external]
        red: Component,
        /// The green component.
        #[external]
        green: Component,
        /// The blue component.
        #[external]
        blue: Component,
        /// The alpha component.
        #[external]
        alpha: Component,
        /// Alternatively: The color in hexadecimal notation.
        #[external]
        hex: Str,
    ) -> SourceResult<Color> {
        Ok(if let Some(string) = args.find::<Spanned<Str>>()? {
            Self::from_str(&string.v).at(string.span)?
        } else {
            let Component(r) = args.expect("red component")?;
            let Component(g) = args.expect("green component")?;
            let Component(b) = args.expect("blue component")?;
            let Component(a) = args.eat()?.unwrap_or(Component(Ratio::one()));
            Self::new(r.get() as f32, g.get() as f32, b.get() as f32, a.get() as f32)
        })
    }

    /// The color in hexadecimal notation, with the alpha component only when
    /// the color is not opaque.
    #[func]
    pub fn to_hex(self) -> EcoString {
        let [r, g, b, a] = self.to_vec4_u8();
        if a == 255 {
            eco_format!("#{r:02x}{g:02x}{b:02x}")
        } else {
            eco_format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
        }
    }
}

impl Color {
    /// A color from its components, each between 0 and 1.
    pub const fn new(red: f32, green: f32, blue: f32, alpha: f32) -> Self {
        Self { components: [red, green, blue, alpha] }
    }

    /// A color from its components, each between 0 and 255.
    pub fn from_u8(red: u8, green: u8, blue: u8, alpha: u8) -> Self {
        Self::new(
            f32::from(red) / 255.0,
            f32::from(green) / 255.0,
            f32::from(blue) / 255.0,
            f32::from(alpha) / 255.0,
        )
    }

    /// The color itself, which is already RGB.
    pub fn to_rgb(self) -> Self {
        self
    }

    /// The red, green, blue and alpha components, each between 0 and 1.
    pub fn to_vec4(self) -> [f32; 4] {
        self.components
    }

    /// The red, green, blue and alpha components, each between 0 and 255.
    pub fn to_vec4_u8(self) -> [u8; 4] {
        self.components.map(|c| (c * 255.0).round() as u8)
    }

    /// The alpha component.
    pub fn alpha(&self) -> Option<f32> {
        Some(self.components[3])
    }

    /// The color with another alpha component.
    pub fn with_alpha(mut self, alpha: f32) -> Self {
        self.components[3] = alpha;
        self
    }
}

impl Debug for Color {
    fn fmt(&self, f: &mut Formatter) -> fmt::Result {
        write!(f, "rgb({:?})", self.to_hex())
    }
}

impl Repr for Color {
    fn repr(&self) -> EcoString {
        eco_format!("rgb({})", self.to_hex().repr())
    }
}

impl PartialEq for Color {
    fn eq(&self, other: &Self) -> bool {
        self.components == other.components
    }
}

impl Eq for Color {}

impl Hash for Color {
    fn hash<H: Hasher>(&self, state: &mut H) {
        for c in self.components {
            c.to_bits().hash(state);
        }
    }
}

impl FromStr for Color {
    type Err = &'static str;

    /// Constructs a new color from hex strings like the following:
    /// - `#aef` (shorthand, with leading hash),
    /// - `7a03c2` (without alpha),
    /// - `abcdefff` (with alpha).
    ///
    /// The hash is optional and both lower and upper case are fine.
    fn from_str(hex_str: &str) -> Result<Self, Self::Err> {
        let hex_str = hex_str.strip_prefix('#').unwrap_or(hex_str);
        if hex_str.chars().any(|c| !c.is_ascii_hexdigit()) {
            return Err("color string contains non-hexadecimal letters");
        }

        let len = hex_str.len();
        let long = len == 6 || len == 8;
        let short = len == 3 || len == 4;
        let alpha = len == 4 || len == 8;
        if !long && !short {
            return Err("color string has wrong length");
        }

        let mut values: [u8; 4] = [u8::MAX; 4];
        for elem in if alpha { 0..4 } else { 0..3 } {
            let item_len = if long { 2 } else { 1 };
            let pos = elem * item_len;

            let item = &hex_str[pos..(pos + item_len)];
            values[elem] = u8::from_str_radix(item, 16).unwrap();

            if short {
                // Duplicate number for shorthand notation, i.e. `a` -> `aa`
                values[elem] += values[elem] * 16;
            }
        }

        Ok(Self::from_u8(values[0], values[1], values[2], values[3]))
    }
}

/// A color component: an integer from 0 to 255 or a ratio.
pub struct Component(Ratio);

cast! {
    Component,
    self => self.0.into_value(),
    v: i64 => match v {
        0 ..= 255 => Self(Ratio::new(v as f64 / 255.0)),
        _ => bail!("number must be between 0 and 255"),
    },
    v: Ratio => if (0.0 ..= 1.0).contains(&v.get()) {
        Self(v)
    } else {
        bail!("ratio must be between 0% and 100%");
    },
}
