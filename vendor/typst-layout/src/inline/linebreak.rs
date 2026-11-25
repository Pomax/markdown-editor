use std::ops::{Add, Sub};

use typst_library::engine::Engine;
use typst_library::layout::Abs;
use typst_library::model::Linebreaks;
use typst_library::text::is_default_ignorable;

use super::*;

/// The cost of a line or inline layout.
type Cost = f64;

// Cost parameters.
//
// We choose higher costs than the Knuth-Plass paper (which would be 50) because
// it hyphenates way to eagerly in Typst otherwise. Could be related to the
// ratios coming out differently since Typst doesn't have the concept of glue,
// so things work a bit differently.
const DEFAULT_RUNT_COST: Cost = 100.0;

// Other parameters.
const MIN_RATIO: f64 = -1.0;
const MIN_APPROX_RATIO: f64 = -0.5;
const BOUND_EPS: f64 = 1e-3;

/// A line break opportunity.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
pub enum Breakpoint {
    /// Just a normal opportunity (e.g. after a space).
    Normal,
    /// A mandatory breakpoint (after '\n' or at the end of the text).
    Mandatory,
}

impl Breakpoint {
    /// Trim a line before this breakpoint.
    pub fn trim(self, line: &str) -> &str {
        // Trim default ignorables.
        let line = line.trim_end_matches(is_default_ignorable);

        match self {
            // Trim whitespace.
            Self::Normal => line.trim_end_matches(char::is_whitespace),

            // Trim linebreaks.
            Self::Mandatory => line.trim_end_matches(is_mandatory_break),
        }
    }
}

/// Breaks the text into lines.
pub fn linebreak<'a>(
    engine: &Engine,
    p: &'a Preparation<'a>,
    width: Abs,
) -> Vec<Line<'a>> {
    match p.config.linebreaks {
        Linebreaks::Simple => linebreak_simple(engine, p, width),
        Linebreaks::Optimized => linebreak_optimized(engine, p, width),
    }
}

/// Performs line breaking in simple first-fit style. This means that we build
/// lines greedily, always taking the longest possible line. This may lead to
/// very unbalanced line, but is fast and simple.
#[typst_macros::time]
fn linebreak_simple<'a>(
    engine: &Engine,
    p: &'a Preparation<'a>,
    width: Abs,
) -> Vec<Line<'a>> {
    let mut lines = Vec::with_capacity(16);
    let mut start = 0;
    let mut last = None;

    breakpoints(p, |end, breakpoint| {
        // Compute the line and its size.
        let mut attempt = line(engine, p, start..end, breakpoint, lines.last());

        // If the line doesn't fit anymore, we push the last fitting attempt
        // into the stack and rebuild the line from the attempt's end. The
        // resulting line cannot be broken up further.
        if !width.fits(attempt.width) {
            if let Some((last_attempt, last_end)) = last.take() {
                lines.push(last_attempt);
                start = last_end;
                attempt = line(engine, p, start..end, breakpoint, lines.last());
            }
        }

        // Finish the current line if there is a mandatory line break (i.e. due
        // to "\n") or if the line doesn't fit horizontally already since then
        // no shorter line will be possible.
        if breakpoint == Breakpoint::Mandatory || !width.fits(attempt.width) {
            lines.push(attempt);
            start = end;
            last = None;
        } else {
            last = Some((attempt, end));
        }
    });

    if let Some((line, _)) = last {
        lines.push(line);
    }

    lines
}

/// Performs line breaking in optimized Knuth-Plass style. Here, we use more
/// context to determine the line breaks than in the simple first-fit style. For
/// example, we might choose to cut a line short even though there is still a
/// bit of space to improve the fit of one of the following lines. The
/// Knuth-Plass algorithm is based on the idea of "cost". A line which has a
/// very tight or very loose fit has a higher cost than one that is just right.
/// Ending a line with a hyphen incurs extra cost and endings two successive
/// lines with hyphens even more.
///
/// To find the layout with the minimal total cost the algorithm uses dynamic
/// programming: For each possible breakpoint, it determines the optimal layout
/// _up to that point_. It walks over all possible start points for a line
/// ending at that point and finds the one for which the cost of the line plus
/// the cost of the optimal layout up to the start point (already computed and
/// stored in dynamic programming table) is minimal. The final result is simply
/// the layout determined for the last breakpoint at the end of text.
#[typst_macros::time]
fn linebreak_optimized<'a>(
    engine: &Engine,
    p: &'a Preparation<'a>,
    width: Abs,
) -> Vec<Line<'a>> {
    let metrics = CostMetrics::compute(p);

    // Determines the exact costs of a likely good layout through Knuth-Plass
    // with approximate metrics. We can use this cost as an upper bound to prune
    // the search space in our proper optimization pass below.
    let upper_bound = linebreak_optimized_approximate(engine, p, width, &metrics);

    // Using the upper bound, perform exact optimized linebreaking.
    linebreak_optimized_bounded(engine, p, width, &metrics, upper_bound)
}

/// Performs line breaking in optimized Knuth-Plass style, but with an upper
/// bound on the cost. This allows us to skip many parts of the search space.
#[typst_macros::time]
fn linebreak_optimized_bounded<'a>(
    engine: &Engine,
    p: &'a Preparation<'a>,
    width: Abs,
    metrics: &CostMetrics,
    upper_bound: Cost,
) -> Vec<Line<'a>> {
    /// An entry in the dynamic programming table for inline layout optimization.
    struct Entry<'a> {
        pred: usize,
        total: Cost,
        line: Line<'a>,
        end: usize,
    }

    // Dynamic programming table.
    let mut table = vec![Entry { pred: 0, total: 0.0, line: Line::empty(), end: 0 }];

    let mut active = 0;
    let mut prev_end = 0;

    breakpoints(p, |end, breakpoint| {
        // Find the optimal predecessor.
        let mut best: Option<Entry> = None;

        // A lower bound for the cost of all following line attempts.
        let mut line_lower_bound = None;

        for (pred_index, pred) in table.iter().enumerate().skip(active) {
            let start = pred.end;
            let unbreakable = prev_end == start;

            // If the minimum cost we've established for the line is already
            // too much, skip this attempt.
            if line_lower_bound
                .is_some_and(|lower| pred.total + lower > upper_bound + BOUND_EPS)
            {
                continue;
            }

            // Build the line.
            let attempt = line(engine, p, start..end, breakpoint, Some(&pred.line));

            // Determine the cost of the line and its stretch ratio.
            let (line_ratio, line_cost) = ratio_and_cost(
                p,
                metrics,
                width,
                &attempt,
                breakpoint,
                unbreakable,
            );

            // If the line is overfull, we adjust the set of active candidate
            // line starts. This is the case if
            // - justification is on, but we'd need to shrink too much
            // - justification is off and the line just doesn't fit
            //
            // If this is the earliest breakpoint in the active set
            // (active == i), remove it from the active set. If there is an
            // earlier one (active < i), then the logically shorter line was
            // in fact longer (can happen with negative spacing) and we
            // can't trim the active set just yet.
            if line_ratio < metrics.min_ratio && active == pred_index {
                active += 1;
            }

            // The total cost of this line and its chain of predecessors.
            let total = pred.total + line_cost;

            // If the line is already underfull (`line_ratio > 0`), any shorter
            // slice of the line will be even more underfull. So it'll only get
            // worse from here and further attempts would also have a cost
            // exceeding `bound`. There is one exception: When the line has
            // negative spacing, we can't know for sure, so we don't assign the
            // lower bound in that case.
            if line_ratio > 0.0
                && line_lower_bound.is_none()
                && !attempt.has_negative_width_items()
            {
                line_lower_bound = Some(line_cost);
            }

            // If the cost already exceeds the upper bound, we don't need to
            // integrate this result into the table.
            if total > upper_bound + BOUND_EPS {
                continue;
            }

            // If this attempt is better than what we had before, take it!
            if best.as_ref().map_or(true, |best| best.total >= total) {
                best = Some(Entry { pred: pred_index, total, line: attempt, end });
            }
        }

        // If this is a mandatory break, all breakpoints before this one become
        // inactive since no line can span over the mandatory break.
        if breakpoint == Breakpoint::Mandatory {
            active = table.len();
        }

        table.extend(best);
        prev_end = end;
    });

    // Retrace the best path.
    let mut lines = Vec::with_capacity(16);
    let mut idx = table.len() - 1;

    // This should only happen if our bound was faulty. Which shouldn't happen!
    if table[idx].end != p.text.len() {
        #[cfg(debug_assertions)]
        panic!("bounded inline layout is incomplete");

        #[cfg(not(debug_assertions))]
        return linebreak_optimized_bounded(engine, p, width, metrics, Cost::INFINITY);
    }

    while idx != 0 {
        table.truncate(idx + 1);
        let entry = table.pop().unwrap();
        lines.push(entry.line);
        idx = entry.pred;
    }

    lines.reverse();
    lines
}

/// Runs the normal Knuth-Plass algorithm, but instead of building proper lines
/// (which is costly) to determine costs, it determines approximate costs using
/// cumulative arrays.
///
/// This results in a likely good inline layouts, for which we then compute
/// the exact cost. This cost is an upper bound for proper optimized
/// linebreaking. We can use it to heavily prune the search space.
#[typst_macros::time]
fn linebreak_optimized_approximate(
    engine: &Engine,
    p: &Preparation,
    width: Abs,
    metrics: &CostMetrics,
) -> Cost {
    // Determine the cumulative estimation metrics.
    let estimates = Estimates::compute(p);

    /// An entry in the dynamic programming table for inline layout optimization.
    struct Entry {
        pred: usize,
        total: Cost,
        end: usize,
        unbreakable: bool,
        breakpoint: Breakpoint,
    }

    // Dynamic programming table.
    let mut table = vec![Entry {
        pred: 0,
        total: 0.0,
        end: 0,
        unbreakable: false,
        breakpoint: Breakpoint::Mandatory,
    }];

    let mut active = 0;
    let mut prev_end = 0;

    breakpoints(p, |end, breakpoint| {
        // Find the optimal predecessor.
        let mut best: Option<Entry> = None;
        for (pred_index, pred) in table.iter().enumerate().skip(active) {
            let start = pred.end;
            let unbreakable = prev_end == start;

            // Whether the line is justified. This is not 100% accurate w.r.t
            // to line()'s behaviour, but good enough.
            let justify = p.config.justify && breakpoint != Breakpoint::Mandatory;

            // Estimate how much the line's spaces would need to be stretched to
            // make it the desired width. We trim at the end to not take into
            // account trailing spaces. This is, again, only an approximation of
            // the real behaviour of `line`.
            let trimmed_end = start + p.text[start..end].trim_end().len();
            let line_ratio = raw_ratio(
                p,
                width,
                estimates.widths.estimate(start..trimmed_end),
                estimates.stretchability.estimate(start..trimmed_end),
                estimates.shrinkability.estimate(start..trimmed_end),
                estimates.justifiables.estimate(start..trimmed_end),
            );

            // Determine the line's cost.
            let line_cost = raw_cost(
                metrics,
                breakpoint,
                line_ratio,
                justify,
                unbreakable,
                true,
            );

            // Adjust the set of active breakpoints.
            // See `linebreak_optimized` for details.
            if line_ratio < metrics.min_ratio && active == pred_index {
                active += 1;
            }

            // The total cost of this line and its chain of predecessors.
            let total = pred.total + line_cost;

            // If this attempt is better than what we had before, take it!
            if best.as_ref().map_or(true, |best| best.total >= total) {
                best = Some(Entry {
                    pred: pred_index,
                    total,
                    end,
                    unbreakable,
                    breakpoint,
                });
            }
        }

        // If this is a mandatory break, all breakpoints before this one become
        // inactive.
        if breakpoint == Breakpoint::Mandatory {
            active = table.len();
        }

        table.extend(best);
        prev_end = end;
    });

    // Retrace the best path.
    let mut indices = Vec::with_capacity(16);
    let mut idx = table.len() - 1;
    while idx != 0 {
        indices.push(idx);
        idx = table[idx].pred;
    }

    let mut pred = Line::empty();
    let mut start = 0;
    let mut exact = 0.0;

    // The cost that we optimized was only an approximate cost, so the layout we
    // got here is only likely to be good, not guaranteed to be the best. We now
    // computes its exact cost as that gives us a sound upper bound for the
    // proper optimization pass.
    for idx in indices.into_iter().rev() {
        let Entry { end, breakpoint, unbreakable, .. } = table[idx];

        let attempt = line(engine, p, start..end, breakpoint, Some(&pred));
        let (ratio, line_cost) =
            ratio_and_cost(p, metrics, width, &attempt, breakpoint, unbreakable);

        // If approximation produces a valid layout without too much shrinking,
        // exact layout is guaranteed to find the same layout. If, however, the
        // line is overfull, we do not have this guarantee. Then, our bound
        // becomes useless and actively harmful (it could be lower than what
        // optimal layout produces). Thus, we immediately bail with an infinite
        // bound in this case.
        if ratio < metrics.min_ratio {
            return Cost::INFINITY;
        }

        pred = attempt;
        start = end;
        exact += line_cost;
    }

    exact
}

/// Compute the stretch ratio and cost of a line.
#[allow(clippy::too_many_arguments)]
fn ratio_and_cost(
    p: &Preparation,
    metrics: &CostMetrics,
    available_width: Abs,
    attempt: &Line,
    breakpoint: Breakpoint,
    unbreakable: bool,
) -> (f64, Cost) {
    let ratio = raw_ratio(
        p,
        available_width,
        attempt.width,
        attempt.stretchability(),
        attempt.shrinkability(),
        attempt.justifiables(),
    );

    let cost = raw_cost(
        metrics,
        breakpoint,
        ratio,
        attempt.justify,
        unbreakable,
        false,
    );

    (ratio, cost)
}

/// Determine the stretch ratio for a line given raw metrics.
///
/// - A ratio < min_ratio indicates an overfull line.
/// - A negative ratio indicates a line that needs shrinking.
/// - A ratio of zero indicates a perfect line.
/// - A positive ratio indicates a line that needs stretching.
fn raw_ratio(
    p: &Preparation,
    available_width: Abs,
    line_width: Abs,
    stretchability: Abs,
    shrinkability: Abs,
    justifiables: usize,
) -> f64 {
    // Determine how much the line's spaces would need to be stretched
    // to make it the desired width.
    let mut delta = available_width - line_width;

    // Avoid possible floating point errors in previous calculation.
    if delta.approx_eq(Abs::zero()) {
        delta = Abs::zero();
    }

    // Determine how much stretch or shrink is natural.
    let adjustability = if delta >= Abs::zero() { stretchability } else { shrinkability };

    // Observations:
    // - `delta` is negative for a line that needs shrinking and positive for a
    //   line that needs stretching.
    // - `adjustability` must be non-negative to make sense.
    // - `ratio` inherits the sign of `delta`.
    let mut ratio = delta / adjustability.max(Abs::zero());

    // The most likely cause of a NaN result is that `delta` was zero. This
    // often happens with monospace fonts and CJK texts. It means that the line
    // already fits perfectly, so `ratio` should be zero then.
    if ratio.is_nan() {
        ratio = 0.0;
    }

    // If the ratio exceeds 1, we should stretch above the natural
    // stretchability using justifiables.
    if ratio > 1.0 {
        // We should stretch the line above its stretchability. Now
        // calculate the extra amount. Also, don't divide by zero.
        let extra_stretch = (delta - adjustability) / justifiables.max(1) as f64;
        // Normalize the amount by half the em size.
        ratio = 1.0 + extra_stretch / (p.config.font_size / 2.0);
    }

    // The min value must be < MIN_RATIO, but how much smaller doesn't matter
    // since overfull lines have hard-coded huge costs anyway.
    //
    // The max value is clamped to 10 since it doesn't really matter whether a
    // line is stretched 10x or 20x.
    ratio.clamp(MIN_RATIO - 1.0, 10.0)
}

/// Compute the cost of a line given raw metrics.
///
/// This mostly follows the formula in the Knuth-Plass paper, but there are some
/// adjustments.
fn raw_cost(
    metrics: &CostMetrics,
    breakpoint: Breakpoint,
    ratio: f64,
    justify: bool,
    unbreakable: bool,
    approx: bool,
) -> Cost {
    // Determine the stretch/shrink cost of the line.
    let badness = if ratio < metrics.min_ratio(approx) {
        // Overfull line always has maximum cost.
        1_000_000.0
    } else if breakpoint != Breakpoint::Mandatory || justify || ratio < 0.0 {
        // If the line shall be justified or needs shrinking, it has normal
        // badness with cost 100|ratio|^3. We limit the ratio to 10 as to not
        // get to close to our maximum cost.
        100.0 * ratio.abs().powi(3)
    } else {
        // If the line shouldn't be justified and doesn't need shrink, we don't
        // pay any cost.
        0.0
    };

    // Compute penalties.
    let mut penalty = 0.0;

    // Penalize runts (lone words before a mandatory break / at the end).
    if unbreakable && breakpoint == Breakpoint::Mandatory {
        penalty += metrics.runt_cost;
    }

    // From the Knuth-Plass Paper: $ (1 + beta_j + pi_j)^2 $.
    //
    // We add one to minimize the number of lines when everything else is more
    // or less equal.
    (1.0 + badness + penalty).powi(2)
}

/// Calls `f` for all possible points in the text where lines can broken.
///
/// Yields for each breakpoint the text index, whether the break is mandatory
/// (after `\n`) and whether a hyphen is required (when breaking inside of a
/// word).
///
/// This is an internal instead of an external iterator because it makes the
/// code much simpler and the consumers of this function don't need the
/// composability and flexibility of external iteration anyway.
fn breakpoints(p: &Preparation, mut f: impl FnMut(usize, Breakpoint)) {
    let text = p.text;

    // Single breakpoint at the end for empty text.
    if text.is_empty() {
        f(0, Breakpoint::Mandatory);
        return;
    }

    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let end = i + c.len_utf8();
        let next = chars.peek().map(|&(_, n)| n);
        if end == text.len() {
            break;
        }
        if is_mandatory_break(c) {
            if !(c == '\r' && next == Some('\n')) {
                f(end, Breakpoint::Mandatory);
            }
        } else if c.is_whitespace()
            && !matches!(c, '\u{A0}' | '\u{2007}' | '\u{202F}')
            && !next.is_some_and(char::is_whitespace)
        {
            f(end, Breakpoint::Normal);
        }
    }

    f(text.len(), Breakpoint::Mandatory);
}

/// Whether a line must break after this character.
fn is_mandatory_break(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{B}' | '\u{C}' | '\u{85}' | '\u{2028}' | '\u{2029}')
}

/// Resolved metrics relevant for cost computation.
struct CostMetrics {
    min_ratio: f64,
    min_approx_ratio: f64,
    runt_cost: Cost,
}

impl CostMetrics {
    /// Compute shared metrics for inline layout optimization.
    fn compute(p: &Preparation) -> Self {
        Self {
            // When justifying, we may stretch spaces below their natural width.
            min_ratio: if p.config.justify { MIN_RATIO } else { 0.0 },
            min_approx_ratio: if p.config.justify { MIN_APPROX_RATIO } else { 0.0 },
            // Costs.
            runt_cost: DEFAULT_RUNT_COST * p.config.costs.runt().get(),
        }
    }

    /// The minimum line ratio we allow for shrinking. For approximate layout,
    /// we allow less because otherwise we get an invalid layout fairly often,
    /// which makes our bound useless.
    fn min_ratio(&self, approx: bool) -> f64 {
        if approx {
            self.min_approx_ratio
        } else {
            self.min_ratio
        }
    }
}

/// Estimated line metrics.
///
/// Allows to get a quick estimate of a metric for a line between two byte
/// positions.
struct Estimates {
    widths: CumulativeVec<Abs>,
    stretchability: CumulativeVec<Abs>,
    shrinkability: CumulativeVec<Abs>,
    justifiables: CumulativeVec<usize>,
}

impl Estimates {
    /// Compute estimations for approximate Knuth-Plass layout.
    fn compute(p: &Preparation) -> Self {
        let cap = p.text.len();

        let mut widths = CumulativeVec::with_capacity(cap);
        let mut stretchability = CumulativeVec::with_capacity(cap);
        let mut shrinkability = CumulativeVec::with_capacity(cap);
        let mut justifiables = CumulativeVec::with_capacity(cap);

        for (range, item) in p.items.iter() {
            if let Item::Text(shaped) = item {
                for g in shaped.glyphs.iter() {
                    let byte_len = g.range.len();
                    let stretch = g.stretchability().0 + g.stretchability().1;
                    let shrink = g.shrinkability().0 + g.shrinkability().1;
                    widths.push(byte_len, g.x_advance.at(shaped.size));
                    stretchability.push(byte_len, stretch.at(shaped.size));
                    shrinkability.push(byte_len, shrink.at(shaped.size));
                    justifiables.push(byte_len, g.is_justifiable() as usize);
                }
            } else {
                widths.push(range.len(), item.natural_width());
            }

            widths.adjust(range.end);
            stretchability.adjust(range.end);
            shrinkability.adjust(range.end);
            justifiables.adjust(range.end);
        }

        Self {
            widths,
            stretchability,
            shrinkability,
            justifiables,
        }
    }
}

/// An accumulative array of a metric.
struct CumulativeVec<T> {
    total: T,
    summed: Vec<T>,
}

impl<T> CumulativeVec<T>
where
    T: Default + Copy + Add<Output = T> + Sub<Output = T>,
{
    /// Create a new instance with the given capacity.
    fn with_capacity(capacity: usize) -> Self {
        let total = T::default();
        let mut summed = Vec::with_capacity(capacity);
        summed.push(total);
        Self { total, summed }
    }

    /// Adjust to cover the given byte length.
    fn adjust(&mut self, len: usize) {
        self.summed.resize(len, self.total);
    }

    /// Adds a new segment with the given byte length and metric.
    fn push(&mut self, byte_len: usize, metric: T) {
        self.total = self.total + metric;
        for _ in 0..byte_len {
            self.summed.push(self.total);
        }
    }

    /// Estimates the metrics for the line spanned by the range.
    #[track_caller]
    fn estimate(&self, range: Range) -> T {
        self.get(range.end) - self.get(range.start)
    }

    /// Get the metric at the given byte position.
    #[track_caller]
    fn get(&self, index: usize) -> T {
        match index.checked_sub(1) {
            None => T::default(),
            Some(i) => self.summed[i],
        }
    }
}
