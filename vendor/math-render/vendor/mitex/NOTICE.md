Vendored from https://github.com/mitex-rs/mitex (`packages/mitex/specs/`),
licensed Apache-2.0. Only the runtime `mitex-scope` spec files are vendored
— not `mitex.typ`/`lib.typ` (the Typst-package entry points, which call
into a bundled WASM plugin for the LaTeX→Typst conversion itself; this
crate does that conversion via the `mitex` *Rust* crate instead, and only
needs the resulting scope of Typst functions/symbols that converted source
references, e.g. `textmath` for `\text{...}`).
