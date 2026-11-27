//! The comment box: a small multi-line editor.
//!
//! Enter saves; Shift+Enter (where the terminal's keyboard protocol distinguishes it),
//! Alt+Enter and Ctrl+J insert a new line; Esc cancels. The cursor is a byte offset at a
//! grapheme boundary. Soft wraps are only for display.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// What a keystroke did to the compose box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ComposeAction {
    Edited,
    Save,
    Cancel,
}

#[derive(Debug, Default)]
pub(super) struct Compose {
    text: String,
    cursor: usize,
}

/// Display cells per row inside the comment box.
pub(super) const WRAP_WIDTH: usize = 45;

impl Compose {
    pub(super) fn with_text(text: &str) -> Self {
        Self { text: text.to_owned(), cursor: text.len() }
    }

    pub(super) fn value(&self) -> &str {
        &self.text
    }

    pub(super) fn handle_key(&mut self, key: KeyEvent, width: usize) -> ComposeAction {
        match key.code {
            KeyCode::Esc => return ComposeAction::Cancel,
            KeyCode::Enter if key.modifiers.intersects(KeyModifiers::SHIFT | KeyModifiers::ALT) => {
                self.insert_text("\n");
            }
            KeyCode::Enter => return ComposeAction::Save,
            KeyCode::Char('j' | 'J') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.insert_text("\n");
            }
            KeyCode::Backspace => self.replace(self.previous(), self.cursor, ""),
            KeyCode::Delete => self.replace(self.cursor, self.next(), ""),
            // Cmd+arrows arrive as Super+arrow (keyboard protocol) or as the Ctrl+A/Ctrl+E and
            // Alt+B/Alt+F that macOS terminals send for Cmd/Option+Left/Right.
            KeyCode::Up if key.modifiers.contains(KeyModifiers::SUPER) => self.cursor = 0,
            KeyCode::Down if key.modifiers.contains(KeyModifiers::SUPER) => self.cursor = self.text.len(),
            KeyCode::Left if key.modifiers.contains(KeyModifiers::SUPER) => self.line_start(),
            KeyCode::Right if key.modifiers.contains(KeyModifiers::SUPER) => self.line_end(),
            KeyCode::Char('a') if key.modifiers == KeyModifiers::CONTROL => self.line_start(),
            KeyCode::Char('e') if key.modifiers == KeyModifiers::CONTROL => self.line_end(),
            KeyCode::Left if key.modifiers.intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) => {
                self.word(-1);
            }
            KeyCode::Right if key.modifiers.intersects(KeyModifiers::ALT | KeyModifiers::CONTROL) => {
                self.word(1);
            }
            KeyCode::Char('b') if key.modifiers == KeyModifiers::ALT => self.word(-1),
            KeyCode::Char('f') if key.modifiers == KeyModifiers::ALT => self.word(1),
            KeyCode::Left => self.cursor = self.previous(),
            KeyCode::Right => self.cursor = self.next(),
            KeyCode::Up => self.move_vertical(-1, width),
            KeyCode::Down => self.move_vertical(1, width),
            KeyCode::Home => self.line_start(),
            KeyCode::End => self.line_end(),
            KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                self.replace(self.cursor, self.cursor, c.encode_utf8(&mut [0; 4]));
            }
            _ => {}
        }
        ComposeAction::Edited
    }

    /// Insert pasted text as typed characters, newlines included.
    pub(super) fn insert_text(&mut self, text: &str) {
        self.replace(self.cursor, self.cursor, &text.replace("\r\n", "\n").replace('\r', "\n"));
    }

    fn replace(&mut self, start: usize, end: usize, text: &str) {
        self.text.replace_range(start..end, text);
        // A combining mark or joiner can merge the text on either side of an edit.
        let after_edit = start + text.len();
        self.cursor = self
            .text
            .grapheme_indices(true)
            .find(|&(offset, _)| offset >= after_edit)
            .map_or(self.text.len(), |(offset, _)| offset);
    }

    fn previous(&self) -> usize {
        self.text[..self.cursor].grapheme_indices(true).next_back().map_or(0, |(offset, _)| offset)
    }

    fn next(&self) -> usize {
        self.cursor + self.text[self.cursor..].graphemes(true).next().map_or(0, str::len)
    }

    /// Start of the current logical line.
    fn line_start(&mut self) {
        self.cursor = self.text[..self.cursor].rfind('\n').map_or(0, |i| i + 1);
    }

    /// End of the current logical line.
    fn line_end(&mut self) {
        let rest = &self.text[self.cursor..];
        let line = rest.split('\n').next().unwrap_or_default();
        self.cursor += line.strip_suffix('\r').unwrap_or(line).len();
    }

    /// Jump to the previous word start or the next word end, skipping whitespace first.
    fn word(&mut self, direction: isize) {
        fn word_len<'a>(graphemes: impl Iterator<Item = &'a str>) -> usize {
            let mut graphemes = graphemes.peekable();
            let blank = |grapheme: &str| grapheme.chars().next().is_some_and(char::is_whitespace);
            let mut len = 0;
            while graphemes.peek().is_some_and(|g| blank(g)) {
                len += graphemes.next().map_or(0, str::len);
            }
            len + graphemes.take_while(|g| !blank(g)).map(str::len).sum::<usize>()
        }
        if direction < 0 {
            self.cursor -= word_len(self.text[..self.cursor].graphemes(true).rev());
        } else {
            self.cursor += word_len(self.text[self.cursor..].graphemes(true));
        }
    }

    /// Move to the display row above or below, landing on the nearest column at or left of
    /// the current one. Past the first or last row the cursor goes to the start or end.
    fn move_vertical(&mut self, delta: isize, width: usize) {
        let (_, spots) = self.layout(width);
        let (row, col) = cursor_cell(&spots, self.cursor);
        let last = spots.last().map_or(0, |spot| spot.1.0);
        let Some(target) = row.checked_add_signed(delta).filter(|&r| r <= last) else {
            self.cursor = if delta < 0 { 0 } else { self.text.len() };
            return;
        };
        let on_target = || spots.iter().filter(|(_, (row, _))| *row == target);
        self.cursor = on_target()
            .rfind(|(_, (_, column))| *column <= col)
            .or_else(|| on_target().next())
            .map_or(self.cursor, |(offset, _)| *offset);
    }

    /// The buffer wrapped to `width` display cells, with the cursor's (row, col) in that
    /// wrapping. Explicit newlines always break; a full row wraps to the next, and so does
    /// a cursor that would otherwise sit past the last cell of a full row.
    pub(super) fn wrapped(&self, width: usize) -> (Vec<String>, usize, usize) {
        let (lines, spots) = self.layout(width);
        let (row, col) = cursor_cell(&spots, self.cursor);
        (lines, row, col)
    }

    /// The display rows and the cell at each grapheme boundary. Use the same grapheme
    /// widths as Ratatui so emoji sequences occupy the same cells in the layout and buffer.
    fn layout(&self, width: usize) -> (Vec<String>, Vec<CursorStop>) {
        let width = width.max(1);
        let mut lines = Vec::new();
        let mut line = String::new();
        let mut spots = Vec::new();
        let mut used = 0;
        for (offset, grapheme) in self.text.grapheme_indices(true).chain([(self.text.len(), "")]) {
            let newline = grapheme.ends_with('\n');
            // Match the buffer's treatment of controls; show a placeholder if an entire
            // grapheme is wider than the text area (e.g. CJK in a one-cell-wide editor).
            let cells = if grapheme.contains(char::is_control) { 0 } else { grapheme.width() };
            let (symbol, cells) = if cells > width { ("�", 1) } else { (grapheme, cells) };
            let wrap = used == width || used + cells > width;
            if wrap {
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            spots.push((offset, (lines.len(), used)));
            if newline && !wrap {
                lines.push(std::mem::take(&mut line));
                used = 0;
            } else if !newline {
                line.push_str(symbol);
                used += cells;
            }
        }
        lines.push(line);
        (lines, spots)
    }
}

type CursorStop = (usize, (usize, usize));

fn cursor_cell(spots: &[CursorStop], cursor: usize) -> (usize, usize) {
    spots.iter().find(|(offset, _)| *offset == cursor).map_or((0, 0), |(_, cell)| *cell)
}

#[cfg(test)]
mod tests {
    use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use unicode_segmentation::UnicodeSegmentation;

    use super::{Compose, WRAP_WIDTH};

    fn at(text: &str, cursor: usize) -> Compose {
        let mut compose = Compose::with_text(text);
        compose.cursor = text.grapheme_indices(true).nth(cursor).map_or(text.len(), |(offset, _)| offset);
        compose
    }

    #[test]
    fn cursor_after_a_full_wide_row_moves_to_the_next_row() {
        let (lines, row, col) = Compose::with_text("翟敏").wrapped(4);
        assert_eq!((lines, row, col), (vec!["翟敏".to_owned(), String::new()], 1, 0));
    }

    #[test]
    fn cursor_before_a_wrapping_wide_char_sits_with_that_char() {
        let (lines, row, col) = at("abc敏", 3).wrapped(4);
        assert_eq!((lines, row, col), (vec!["abc".to_owned(), "敏".to_owned()], 1, 0));
    }

    #[test]
    fn cursor_moves_over_graphemes_at_their_display_width() {
        let mut compose = Compose::with_text("a中👩‍💻e\u{301}");
        for expected in [6, 5, 3, 1, 0] {
            let (_, row, col) = compose.wrapped(20);
            assert_eq!((row, col), (0, expected));
            press(&mut compose, KeyCode::Left, KeyModifiers::NONE);
        }
        assert_eq!(press(&mut compose, KeyCode::Right, KeyModifiers::NONE), 1);
        press(&mut compose, KeyCode::Delete, KeyModifiers::NONE);
        press(&mut compose, KeyCode::Right, KeyModifiers::NONE);
        press(&mut compose, KeyCode::Backspace, KeyModifiers::NONE);
        assert_eq!(compose.value(), "ae\u{301}");
    }

    #[test]
    fn a_newline_after_a_full_row_does_not_make_an_extra_blank_row() {
        let (lines, row, col) = Compose::with_text("中文\nx").wrapped(4);
        assert_eq!((lines, row, col), (vec!["中文".to_owned(), "x".to_owned()], 1, 1));
    }

    fn press(compose: &mut Compose, code: KeyCode, modifiers: KeyModifiers) -> usize {
        compose.handle_key(KeyEvent::new(code, modifiers), WRAP_WIDTH);
        compose.cursor
    }

    #[test]
    fn up_and_down_follow_wrapped_rows() {
        let mut compose = at("abcdefghij", 6);
        compose.move_vertical(-1, 4);
        assert_eq!(compose.cursor, 2, "row 1 col 2 -> row 0 col 2");
        compose.move_vertical(1, 4);
        compose.move_vertical(1, 4);
        assert_eq!(compose.cursor, 10, "the short last row clamps to its end");
        compose.move_vertical(1, 4);
        assert_eq!(compose.cursor, 10);
        compose.move_vertical(-1, 4);
        compose.move_vertical(-1, 4);
        compose.move_vertical(-1, 4);
        assert_eq!(compose.cursor, 0, "past the first row goes to the start");
    }

    #[test]
    fn up_and_down_cross_newlines_and_wide_chars() {
        let mut compose = at("翟敏翟\nabcd", 6);
        compose.move_vertical(-1, 4);
        assert_eq!(compose.cursor, "翟敏翟".len(), "col 2 of 'abcd' -> after the wrapped 翟");
        compose.move_vertical(-1, 4);
        assert_eq!(compose.cursor, "翟".len(), "col 2 on the first row is after 翟");
    }

    #[test]
    fn up_and_down_move_within_one_long_paragraph() {
        let text = "x".repeat(WRAP_WIDTH * 2);
        let mut compose = at(&text, WRAP_WIDTH + 3);
        assert_eq!(press(&mut compose, KeyCode::Up, KeyModifiers::NONE), 3);
        assert_eq!(press(&mut compose, KeyCode::Down, KeyModifiers::NONE), WRAP_WIDTH + 3);
    }

    #[test]
    fn command_and_option_arrows_jump() {
        let mut compose = at("one two\nthree four", 12);
        assert_eq!(press(&mut compose, KeyCode::Left, KeyModifiers::SUPER), 8);
        assert_eq!(press(&mut compose, KeyCode::Right, KeyModifiers::SUPER), 18);
        assert_eq!(press(&mut compose, KeyCode::Char('a'), KeyModifiers::CONTROL), 8);
        assert_eq!(press(&mut compose, KeyCode::Char('e'), KeyModifiers::CONTROL), 18);
        assert_eq!(press(&mut compose, KeyCode::Left, KeyModifiers::ALT), 14);
        assert_eq!(press(&mut compose, KeyCode::Char('b'), KeyModifiers::ALT), 8);
        assert_eq!(press(&mut compose, KeyCode::Char('b'), KeyModifiers::ALT), 4);
        assert_eq!(press(&mut compose, KeyCode::Char('f'), KeyModifiers::ALT), 7);
        assert_eq!(press(&mut compose, KeyCode::Right, KeyModifiers::ALT), 13);
        assert_eq!(press(&mut compose, KeyCode::Up, KeyModifiers::SUPER), 0);
        assert_eq!(press(&mut compose, KeyCode::Down, KeyModifiers::SUPER), 18);
        assert_eq!(compose.value(), "one two\nthree four", "jumps never insert text");
    }

    #[test]
    fn cursor_never_lands_past_the_wrap_width() {
        for text in ["abcd", "ab敏", "翟敏\nx", "敏敏敏敏敏"] {
            for cursor in 0..=text.chars().count() {
                let (_, _, col) = at(text, cursor).wrapped(4);
                assert!(col < 4, "{text:?} cursor {cursor} -> col {col}");
            }
        }
    }
}
