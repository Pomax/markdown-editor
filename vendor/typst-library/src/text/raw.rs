use comemo::Tracked;
use ecow::{EcoString, EcoVec};
use typst_syntax::{split_newlines, Span, Spanned};
use unicode_segmentation::UnicodeSegmentation;

use super::Lang;
use crate::diag::{bail, SourceResult};
use crate::engine::Engine;
use crate::foundations::{
    cast, elem, scope, Content, Derived, NativeElement, OneOrMultiple, Packed, PlainText,
    Show, ShowSet, Smart, StyleChain, Styles, Synthesize, TargetElem,
};
use crate::html::{tag, HtmlElem};
use crate::layout::{BlockBody, BlockElem, Em, HAlignment};
use crate::loading::DataSource;
use crate::model::{Figurable, ParElem};
use crate::text::{FontFamily, FontList, LinebreakElem, LocalName, TextElem, TextSize};
use crate::World;

/// Raw text with optional syntax highlighting.
///
/// Displays the text verbatim and in a monospace font. This is typically used
/// to embed computer code into your document.
///
/// # Example
/// ````example
/// Adding `rbx` to `rcx` gives
/// the desired result.
///
/// What is ```rust fn main()``` in Rust
/// would be ```c int main()``` in C.
///
/// ```rust
/// fn main() {
///     println!("Hello World!");
/// }
/// ```
///
/// This has ``` `backticks` ``` in it
/// (but the spaces are trimmed). And
/// ``` here``` the leading space is
/// also trimmed.
/// ````
///
/// You can also construct a [`raw`] element programmatically from a string (and
/// provide the language tag via the optional [`lang`]($raw.lang) argument).
/// ```example
/// #raw("fn " + "main() {}", lang: "rust")
/// ```
///
/// # Syntax
/// This function also has dedicated syntax. You can enclose text in 1 or 3+
/// backticks (`` ` ``) to make it raw. Two backticks produce empty raw text.
/// This works both in markup and code.
///
/// When you use three or more backticks, you can additionally specify a
/// language tag for syntax highlighting directly after the opening backticks.
/// Within raw blocks, everything (except for the language tag, if applicable)
/// is rendered as is, in particular, there are no escape sequences.
///
/// The language tag is an identifier that directly follows the opening
/// backticks only if there are three or more backticks. If your text starts
/// with something that looks like an identifier, but no syntax highlighting is
/// needed, start the text with a single space (which will be trimmed) or use
/// the single backtick syntax. If your text should start or end with a
/// backtick, put a space before or after it (it will be trimmed).
#[elem(
    scope,
    title = "Raw Text / Code",
    Synthesize,
    Show,
    ShowSet,
    LocalName,
    Figurable,
    PlainText
)]
pub struct RawElem {
    /// The raw text.
    ///
    /// You can also use raw blocks creatively to create custom syntaxes for
    /// your automations.
    ///
    /// ````example
    /// // Parse numbers in raw blocks with the
    /// // `mydsl` tag and sum them up.
    /// #show raw.where(lang: "mydsl"): it => {
    ///   let sum = 0
    ///   for part in it.text.split("+") {
    ///     sum += int(part.trim())
    ///   }
    ///   sum
    /// }
    ///
    /// ```mydsl
    /// 1 + 2 + 3 + 4 + 5
    /// ```
    /// ````
    #[required]
    pub text: RawContent,

    /// Whether the raw text is displayed as a separate block.
    ///
    /// In markup mode, using one-backtick notation makes this `{false}`.
    /// Using three-backtick notation makes it `{true}` if the enclosed content
    /// contains at least one line break.
    ///
    /// ````example
    /// // Display inline code in a small box
    /// // that retains the correct baseline.
    /// #show raw.where(block: false): box.with(
    ///   fill: luma(240),
    ///   inset: (x: 3pt, y: 0pt),
    ///   outset: (y: 3pt),
    ///   radius: 2pt,
    /// )
    ///
    /// // Display block code in a larger block
    /// // with more padding.
    /// #show raw.where(block: true): block.with(
    ///   fill: luma(240),
    ///   inset: 10pt,
    ///   radius: 4pt,
    /// )
    ///
    /// With `rg`, you can search through your files quickly.
    /// This example searches the current directory recursively
    /// for the text `Hello World`:
    ///
    /// ```bash
    /// rg "Hello World"
    /// ```
    /// ````
    #[default(false)]
    pub block: bool,

    /// The language to syntax-highlight in.
    ///
    /// Apart from typical language tags known from Markdown, this supports the
    /// `{"typ"}`, `{"typc"}`, and `{"typm"}` tags for
    /// [Typst markup]($reference/syntax/#markup),
    /// [Typst code]($reference/syntax/#code), and
    /// [Typst math]($reference/syntax/#math), respectively.
    ///
    /// ````example
    /// ```typ
    /// This is *Typst!*
    /// ```
    ///
    /// This is ```typ also *Typst*```, but inline!
    /// ````
    #[borrowed]
    pub lang: Option<EcoString>,

    /// The horizontal alignment that each line in a raw block should have.
    /// This option is ignored if this is not a raw block (if specified
    /// `block: false` or single backticks were used in markup mode).
    ///
    /// By default, this is set to `{start}`, meaning that raw text is
    /// aligned towards the start of the text direction inside the block
    /// by default, regardless of the current context's alignment (allowing
    /// you to center the raw block itself without centering the text inside
    /// it, for example).
    ///
    /// ````example
    /// #set raw(align: center)
    ///
    /// ```typc
    /// let f(x) = x
    /// code = "centered"
    /// ```
    /// ````
    #[default(HAlignment::Start)]
    pub align: HAlignment,

    /// Additional syntax definitions to load. The syntax definitions should be
    /// in the [`sublime-syntax` file format](https://www.sublimetext.com/docs/syntax.html).
    ///
    /// You can pass any of the following values:
    ///
    /// - A path string to load a syntax file from the given path. For more
    ///   details about paths, see the [Paths section]($syntax/#paths).
    /// - Raw bytes from which the syntax should be decoded.
    /// - An array where each item is one the above.
    ///
    /// ````example
    /// #set raw(syntaxes: "SExpressions.sublime-syntax")
    ///
    /// ```sexp
    /// (defun factorial (x)
    ///   (if (zerop x)
    ///     ; with a comment
    ///     1
    ///     (* x (factorial (- x 1)))))
    /// ```
    /// ````
    #[parse(match args.named("syntaxes")? {
        Some(sources) => Some(RawSyntax::load(engine.world, sources)?),
        None => None,
    })]
    #[fold]
    pub syntaxes: Derived<OneOrMultiple<DataSource>, Vec<RawSyntax>>,

    /// The theme to use for syntax highlighting. Themes should be in the
    /// [`tmTheme` file format](https://www.sublimetext.com/docs/color_schemes_tmtheme.html).
    ///
    /// You can pass any of the following values:
    ///
    /// - `{none}`: Disables syntax highlighting.
    /// - `{auto}`: Highlights with Typst's default theme.
    /// - A path string to load a theme file from the given path. For more
    ///   details about paths, see the [Paths section]($syntax/#paths).
    /// - Raw bytes from which the theme should be decoded.
    ///
    /// Applying a theme only affects the color of specifically highlighted
    /// text. It does not consider the theme's foreground and background
    /// properties, so that you retain control over the color of raw text. You
    /// can apply the foreground color yourself with the [`text`] function and
    /// the background with a [filled block]($block.fill). You could also use
    /// the [`xml`] function to extract these properties from the theme.
    ///
    /// ````example
    /// #set raw(theme: "halcyon.tmTheme")
    /// #show raw: it => block(
    ///   fill: rgb("#1d2433"),
    ///   inset: 8pt,
    ///   radius: 5pt,
    ///   text(fill: rgb("#a2aabc"), it)
    /// )
    ///
    /// ```typ
    /// = Chapter 1
    /// #let hi = "Hello World"
    /// ```
    /// ````
    #[parse(match args.named::<Spanned<Smart<Option<DataSource>>>>("theme")? {
        Some(Spanned { v: Smart::Custom(Some(source)), span }) => Some(Smart::Custom(
            Some(RawTheme::load(engine.world, Spanned::new(source, span))?)
        )),
        Some(Spanned { v: Smart::Custom(None), .. }) => Some(Smart::Custom(None)),
        Some(Spanned { v: Smart::Auto, .. }) => Some(Smart::Auto),
        None => None,
    })]
    #[borrowed]
    pub theme: Smart<Option<Derived<DataSource, RawTheme>>>,

    /// The size for a tab stop in spaces. A tab is replaced with enough spaces to
    /// align with the next multiple of the size.
    ///
    /// ````example
    /// #set raw(tab-size: 8)
    /// ```tsv
    /// Year	Month	Day
    /// 2000	2	3
    /// 2001	2	1
    /// 2002	3	10
    /// ```
    /// ````
    #[default(2)]
    pub tab_size: usize,

    /// The stylized lines of raw text.
    ///
    /// Made accessible for the [`raw.line` element]($raw.line).
    /// Allows more styling control in `show` rules.
    #[synthesized]
    pub lines: Vec<Packed<RawLine>>,
}

#[scope]
impl RawElem {
    #[elem]
    type RawLine;
}

impl RawElem {
    /// The supported language names and tags.
    pub fn languages() -> Vec<(&'static str, Vec<&'static str>)> {
        vec![
            ("Typst", vec!["typ"]),
            ("Typst (code)", vec!["typc"]),
            ("Typst (math)", vec!["typm"]),
        ]
    }
}

impl Synthesize for Packed<RawElem> {
    fn synthesize(&mut self, _: &mut Engine, styles: StyleChain) -> SourceResult<()> {
        let seq = self.highlight(styles);
        self.push_lines(seq);
        Ok(())
    }
}

impl Packed<RawElem> {
    #[comemo::memoize]
    fn highlight(&self, styles: StyleChain) -> Vec<Packed<RawLine>> {
        let elem = self.as_ref();
        plain_lines(preprocess(&elem.text, styles, self.span())).collect()
    }
}

/// The lines of raw text, without highlighting.
fn plain_lines(
    lines: EcoVec<(EcoString, Span)>,
) -> impl Iterator<Item = Packed<RawLine>> {
    let count = lines.len() as i64;
    lines.into_iter().enumerate().map(move |(i, (line, line_span))| {
        Packed::new(RawLine::new(
            i as i64 + 1,
            count,
            line.clone(),
            TextElem::packed(line).spanned(line_span),
        ))
        .spanned(line_span)
    })
}

impl Show for Packed<RawElem> {
    #[typst_macros::time(name = "raw", span = self.span())]
    fn show(&self, _: &mut Engine, styles: StyleChain) -> SourceResult<Content> {
        let lines = self.lines().map(|v| v.as_slice()).unwrap_or_default();

        let mut seq = EcoVec::with_capacity((2 * lines.len()).saturating_sub(1));
        for (i, line) in lines.iter().enumerate() {
            if i != 0 {
                seq.push(LinebreakElem::shared().clone());
            }

            seq.push(line.clone().pack());
        }

        let mut realized = Content::sequence(seq);

        if TargetElem::target_in(styles).is_html() {
            return Ok(HtmlElem::new(if self.block(styles) {
                tag::pre
            } else {
                tag::code
            })
            .with_body(Some(realized))
            .pack()
            .spanned(self.span()));
        }

        if self.block(styles) {
            // Align the text before inserting it into the block.
            realized = realized.aligned(self.align(styles).into());
            realized = BlockElem::new()
                .with_body(Some(BlockBody::Content(realized)))
                .pack()
                .spanned(self.span());
        }

        Ok(realized)
    }
}

impl ShowSet for Packed<RawElem> {
    fn show_set(&self, styles: StyleChain) -> Styles {
        let mut out = Styles::new();
        out.set(TextElem::set_overhang(false));
        out.set(TextElem::set_lang(Lang::ENGLISH));
        out.set(TextElem::set_hyphenate(Smart::Custom(false)));
        out.set(TextElem::set_size(TextSize(Em::new(0.8).into())));
        out.set(TextElem::set_font(FontList(vec![FontFamily::new("DejaVu Sans Mono")])));
        out.set(TextElem::set_cjk_latin_spacing(Smart::Custom(None)));
        if self.block(styles) {
            out.set(ParElem::set_justify(false));
        }
        out
    }
}

impl LocalName for Packed<RawElem> {
    const KEY: &'static str = "raw";
}

impl Figurable for Packed<RawElem> {}

impl PlainText for Packed<RawElem> {
    fn plain_text(&self, text: &mut EcoString) {
        text.push_str(&self.text.get());
    }
}

/// The content of the raw text.
#[derive(Debug, Clone, Hash, PartialEq)]
pub enum RawContent {
    /// From a string.
    Text(EcoString),
    /// From lines of text.
    Lines(EcoVec<(EcoString, Span)>),
}

impl RawContent {
    /// Returns or synthesizes the text content of the raw text.
    fn get(&self) -> EcoString {
        match self.clone() {
            RawContent::Text(text) => text,
            RawContent::Lines(lines) => {
                let mut lines = lines.into_iter().map(|(s, _)| s);
                if lines.len() <= 1 {
                    lines.next().unwrap_or_default()
                } else {
                    lines.collect::<Vec<_>>().join("\n").into()
                }
            }
        }
    }
}

cast! {
    RawContent,
    self => self.get().into_value(),
    v: EcoString => Self::Text(v),
}

/// A syntax for highlighting, which cannot be loaded: raw text is not
/// highlighted.
#[derive(Debug, Clone, PartialEq, Hash)]
pub struct RawSyntax;

impl RawSyntax {
    /// Refuses to load syntaxes.
    fn load(
        _: Tracked<dyn World + '_>,
        sources: Spanned<OneOrMultiple<DataSource>>,
    ) -> SourceResult<Derived<OneOrMultiple<DataSource>, Vec<RawSyntax>>> {
        bail!(sources.span, "syntax highlighting is not supported");
    }
}

/// A theme for highlighting, which cannot be loaded: raw text is not
/// highlighted.
#[derive(Debug, Clone, PartialEq, Hash)]
pub struct RawTheme;

impl RawTheme {
    /// Refuses to load a theme.
    fn load(
        _: Tracked<dyn World + '_>,
        source: Spanned<DataSource>,
    ) -> SourceResult<Derived<DataSource, Self>> {
        bail!(source.span, "syntax highlighting is not supported");
    }
}

/// A highlighted line of raw text.
///
/// This is a helper element that is synthesized by [`raw`] elements.
///
/// It allows you to access various properties of the line, such as the line
/// number, the raw non-highlighted text, the highlighted text, and whether it
/// is the first or last line of the raw block.
#[elem(name = "line", title = "Raw Text / Code Line", Show, PlainText)]
pub struct RawLine {
    /// The line number of the raw line inside of the raw block, starts at 1.
    #[required]
    pub number: i64,

    /// The total number of lines in the raw block.
    #[required]
    pub count: i64,

    /// The line of raw text.
    #[required]
    pub text: EcoString,

    /// The highlighted raw text.
    #[required]
    pub body: Content,
}

impl Show for Packed<RawLine> {
    #[typst_macros::time(name = "raw.line", span = self.span())]
    fn show(&self, _: &mut Engine, _styles: StyleChain) -> SourceResult<Content> {
        Ok(self.body.clone())
    }
}

impl PlainText for Packed<RawLine> {
    fn plain_text(&self, text: &mut EcoString) {
        text.push_str(&self.text);
    }
}

fn preprocess(
    text: &RawContent,
    styles: StyleChain,
    span: Span,
) -> EcoVec<(EcoString, Span)> {
    if let RawContent::Lines(lines) = text {
        if lines.iter().all(|(s, _)| !s.contains('\t')) {
            return lines.clone();
        }
    }

    let mut text = text.get();
    if text.contains('\t') {
        let tab_size = RawElem::tab_size_in(styles);
        text = align_tabs(&text, tab_size);
    }
    split_newlines(&text)
        .into_iter()
        .map(|line| (line.into(), span))
        .collect()
}

/// Replace tabs with spaces to align with multiples of `tab_size`.
fn align_tabs(text: &str, tab_size: usize) -> EcoString {
    let replacement = " ".repeat(tab_size);
    let divisor = tab_size.max(1);
    let amount = text.chars().filter(|&c| c == '\t').count();

    let mut res = EcoString::with_capacity(text.len() - amount + amount * tab_size);
    let mut column = 0;

    for grapheme in text.graphemes(true) {
        match grapheme {
            "\t" => {
                let required = tab_size - column % divisor;
                res.push_str(&replacement[..required]);
                column += required;
            }
            "\n" => {
                res.push_str(grapheme);
                column = 0;
            }
            _ => {
                res.push_str(grapheme);
                column += 1;
            }
        }
    }

    res
}
