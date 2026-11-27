# Annotate TUI

The terminal reviewer is an owned component of **Open Annotate**. Source, tests,
builds and releases live in this repository; `tui/` is an ordinary subfolder.

## Source and build

- `src/`: terminal UI, Markdown layout, source mapping, comments, selection and export.
- `schema/`: annotation types and anchor resolution.
- `hosts/`: local transcript readers used by standalone review commands.
- `tests/`: command-line integration tests; unit tests live alongside the Rust modules.
- `binary.mjs`: one package-relative executable resolver shared by OpenCode and AGY.

From the repository root (Rust 1.96+ and Node 22+):

```sh
npm run build:tui
npm run check:tui
node tui/run.mjs --version
node tui/run.mjs document.md
```

Builds land in `tui/bin/<platform>-<arch>/annotate-tui` (`.exe` on Windows). The npm release
contains all supported executables; normal use needs neither Cargo nor another TUI install.
CI builds and tests macOS arm64/x64, Linux x64/arm64 and Windows x64 from these sources.
Linux x64 and arm64 target Ubuntu 22.04/glibc 2.35+.
Windows native tests run in CI; the OpenCode terminal handoff still needs Windows validation.

## Configuration and delivery

User layout and key settings live in `~/.config/opencode-annotate/tui.toml`
(`%APPDATA%/opencode-annotate/tui.toml` on Windows). A comfortable layout:

```toml
[ui]
horizontal_margin = 2
max_width = 168
doc_width = 120
```

`[prompts] what` is the instruction feedback adds once when it contains `what?` notes;
an empty string sends the notes alone. `annotate-tui config` prints the default.

Hosted reviews write their send intent for the adapter: `q` sends notes and returns,
and `Ctrl+C` returns to the adapter's confirmation while browsing. In a comment or edit
box, `Enter` saves, `Ctrl+S` saves and sends, and `Esc` cancels. Use `Shift+Enter` (on
terminals that distinguish it), `Alt+Enter`, or `Ctrl+J` to insert a line break.
The adapters own session targeting and delivery. Markdown labels such as `**题库：**把`
render in bold while selections still map to original source bytes.

The `PLANNOTATOR_*` environment names, internal library identifiers and annotation JSON
keys remain stable so existing retained drafts can be recovered. They do not fetch or
load anything from another project. `PLANNOTATOR_TUI_CONFIG` selects a private per-review
theme copy; the user's file stays intact.

Standalone annotation data defaults to `~/.local/share/opencode-annotate/tui`
(`%LOCALAPPDATA%/opencode-annotate/tui` on Windows). Hosted reviews use their own private
snapshot stores. An explicit `PLANNOTATOR_DATA_DIR` can still open a retained older draft.

## Herdr

The [Herdr TUI commands](../README.md#herdr) use an enabled plugin with ID `annotate`.
AGY review in Herdr.app uses hc and the app's peek without this manifest.
For a local setup on macOS (tested with Herdr 0.9.5), save this as `herdr-plugin.toml`
and run `herdr plugin link /absolute/path/to/plugin-directory`:

```toml
id = "annotate"
name = "Annotate"
version = "0.1.0"
min_herdr_version = "0.9.5"
platforms = ["macos"]

[[panes]]
id = "doc"
title = "Annotate"
placement = "overlay"
command = ["/absolute/path/to/annotate-tui", "herdr", "pane"]

# Optional: AGY overlay. Use absolute paths from the same Annotate installation.
[[panes]]
id = "agy"
title = "Annotate AGY"
placement = "overlay"
command = ["/absolute/path/to/agy-annotate", "tui-pane"]

[[panes]]
id = "agy-popup"
title = "Annotate AGY"
placement = "popup"
width = "90%"
height = "90%"
command = ["/absolute/path/to/annotate-tui", "herdr", "hosted-pane"]

[[actions]]
id = "review"
title = "Annotate latest reply"
contexts = ["pane"]
command = ["/absolute/path/to/agy-annotate", "herdr-review", "--binary", "/absolute/path/to/annotate-tui"]
```

For a built macOS checkout, use its executable `agy/cli.mjs` and the
native `tui/bin/darwin-arm64/annotate-tui` (or `darwin-x64` on Intel).

Add this to Herdr's `config.toml` and reload the server configuration:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "annotate.review"
description = "Annotate latest reply"
```

Press your prefix (default `Ctrl+B`) then `a` in the agent pane. The AGY action
opens a 90% × 90% modal using the pane manifest's `popup` placement. Herdr 0.9.5
does not accept `popup` as a `--placement` CLI override. Send rechecks the AGY
conversation before starting a turn in an idle/done pane or queuing to the AGY
hooks while Herdr reports it is working. A blocked, unknown, or changed
destination keeps the notes and shows the recovery path. With matching AGY
hooks, `/annotate` and `/annotate <local-document>` also open this popup before
the model runs. See the [AGY setup](../README.md#antigravity-agy-support) for
`SessionStart`, `PreInvocation`, and `Stop`. If the pane or conversation
cannot be verified, the skill handles the command instead.

`herdr pane` is the plugin entrypoint: it reads the file, reply or terminal source
passed by the launcher. Set `--placement overlay|split|tab|zoomed` on `herdr open`,
`herdr last` or `herdr terminal`; the default is `overlay`. If your Annotate
`tui.toml` uses `popup_width` or `popup_height`, remove those settings and
replace its `placement = "popup"` with a supported value. This does not
affect `placement = "popup"` in the Herdr plugin manifest above.
Agent delivery uses `herdr agent prompt`; a blocked send
leaves notes pending for a manual retry and attempts an OSC 52 clipboard copy.
OpenCode's `/annotate` clears the inherited `HERDR_*` variables before launching
the reviewer, so it does not use this route.

For AGY, the `agy-popup` pane runs `herdr hosted-pane` on a private Markdown
snapshot. The `agy` pane runs `agy-annotate tui-pane` for the skill fallback.
Keep the AGY pane focused while the popup opens. `q` sends pending notes and
closes; with no notes it just closes. `Ctrl+C` closes without sending.


## Local image-toolbar trial

The default toolbar remains Unicode. To opt in, add to the TUI config selected by
`PLANNOTATOR_TUI_CONFIG` (otherwise the platform-specific path above):

```toml
[ui]
toolbar_images = "/absolute/path/to/your/local/artwork"
toolbar_image_protocol = "kitty"
# Only needed when the terminal's window-size ioctl omits pixel dimensions:
# toolbar_image_cell_size = [8, 16] # measured cell width and height, not a guess
```

The directory must contain these four PNGs:
`emoji_thumbsup_v2.png`, `emoji_typing.png`, `emoji_done.png`, `emoji_get_v3.png`.
Supply artwork you are permitted to use. None is included in this repository or binary.
Missing or invalid assets/configuration stop startup before terminal ownership.

`kitty` explicitly asserts that you have verified **Kitty graphics with Unicode
placeholders** end to end; ordinary Kitty keyboard support or environment variables do
not establish this. This trial makes no graphics capability queries, offers no halfblock
substitution, rejects known incompatible terminals and tmux/screen/zellij, and changes no
multiplexer settings. Unknown transports still require your own verification. Disable by
removing all three `toolbar_image*` keys if your terminal cannot display it. Restart after
changing font/cell pixel size. A configured cell-size override takes precedence and skips
the ioctl; measure at the actual display's DPI, including through any PTY proxy.
Cell pixels determine the artwork canvas; the Kitty virtual placement declares its
column count and one-row height explicitly so the placeholder grid does not depend on
the terminal or PTY proxy reporting the same pixel dimensions.

Artwork is approximately square, centered at 85% of one cell row's height, with a bold,
action-colored key beside each
button. Buttons wrap; those that cannot fit completely are hidden without mouse targets.
Keys still work: `a` approval, `c` comment, Enter done, `g` get; `w`, `d`, `y`, Esc stay
key-only. Custom key bindings remain authoritative. Images are decoded/encoded once,
placements follow the Ratatui buffer diff, and only this instance's image IDs are freed
on normal/error exit.

For a query-free backend escape capture using generated gradient PNGs (not your artwork):

```sh
ANNOTATE_TEST_KITTY_CAPTURE="$TMPDIR/annotate-kitty.ansi" \
  cargo test --manifest-path tui/Cargo.toml kitty_backend_emits_cached_pixel_payload_and_owned_cleanup
```

This proves payload/placeholder output and cache behavior, not terminal compatibility.
The ordinary `--snapshot` command intentionally remains text-only and query-free.

The local November 10 trial rendered the selected four PNGs in an isolated Ghostty 1.4.0
window through ghost-complete 0.19.1. Dismiss and comment composition removed the images;
the exit capture contained four owned-image deletions and alternate-screen restoration.
This is a local opt-in experiment, not a release or a guarantee for other terminals.

## Ownership and provenance

This code was imported from the customized Plannotator TUI 0.9.4 codebase at source commit
`7615edea2fd2648ebaeaec50c1c75940408f361b`, including theme, viewport, input-method, send-key
and Markdown fixes. Subsequent development belongs here. There is no upstream remote,
submodule, registry dependency on Plannotator, download step or update/sync relationship.
Normal third-party Rust libraries are pinned in `Cargo.lock`.

Original MIT copyright and permission notices are preserved in [LICENSE](LICENSE).
Import provenance and the ownership decision are recorded in [sources.json](../sources.json).

| Date | Decision | Basis |
|---|---|---|
| 2026-10-28 | Own the terminal reviewer inside `opencode-annotate/tui/`; build and distribute it with the plugin. | `tui-ownership-decision` in the source register. |
| 2026-11-10 | Trial actual local PNG toolbar artwork rather than Unicode substitutes; retain four actions and keep third-party artwork out of distributed artifacts. | `real-image-toolbar-trial-20261110` in the source register. |

The integrated reviewer first shipped in **0.10.0**, with successful native CI on all
five supported platforms and verified npm executable bytes. Isolated OpenCode reviews
passed with theme inheritance, one-key sends, cancellation and captured-session delivery.
The redundant reviewer repository and local checkout were removed on 2026-10-29 after
publication verification; recoverable history is retained privately. `tui/` is the sole
maintained source. Releases follow the repository's [release process](../docs/releasing.md).
