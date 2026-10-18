# TW Lua Debugger

A VS Code debugger for the Lua 5.1 scripts of Total War: WARHAMMER III. User
documentation is in [extension/README.md](extension/README.md); this file is
for working on the debugger itself.

## Layout

| Folder | What |
|---|---|
| `extension/` | The VS Code extension (TypeScript). `src/adapter/` is the debug adapter; it runs in the extension host (`DebugAdapterInlineImplementation`) and has no `vscode` dependency. |
| `debuggee/` | The in-game half: a mod with `script/_lib/mod/vscode-debuggee.lua` and bootstraps for frontend, campaign and battle. Shipped inside the extension and on the Steam Workshop. |
| `rpfm-interface/` | Rust (napi-rs) bindings to `rpfm_lib`, used to read Lua files from packs and to build packs. |
| `example/` | The example mod project. Shipped in the extension and copied (renamed, pointed at the user's game) by **TotalWar: Create Mod Project…**; `Run Extension` opens it. |

## How it works

```
VS Code --DAP (in process)--> TwLuaDebugSession (extension/src/adapter/session.ts)
                                  | path mapping, breakpoints, variable references
                                  v
                              FileTransport  <-- files -->  vscode-debuggee.lua (in the game)
                              <game folder>/tw_lua_debugger/{session.json,to_game,from_game}
```

The game's Lua has no sockets, so both sides append framed JSON
(`#<byte length>\n<json>`) to two files. `session.json` (with a random nonce)
tells the game a debugger is listening; the game checks it every second, so it
can attach at any time. On every Lua state (frontend, campaign, battle) the
debuggee sends `hello`; the adapter answers `welcome` with all breakpoints. See
`extension/src/adapter/protocol.ts` for the messages.

## Total War Lua quirks

Found by testing against Total War: WARHAMMER III (2026). The fake game in
`extension/test/lua/fixtures/run_game.lua` imitates them, so the tests catch
regressions.

- **Scripts run inside a coroutine**, not on the main thread. `debug.sethook`
  only hooks the calling thread, so the debuggee hooks whichever thread it is
  running in.
- **`string.find`, `string.sub` and `string.len` are replaced** by UTF-8 aware
  versions that count characters, and `find` does no pattern matching
  ([CA docs](https://chadvandy.github.io/tw_modding_resources/WH3/campaign/lua.html#function:string:find)).
  The protocol and JSON parser work in bytes, so the debuggee and
  `twdt_json.lua` use the standard functions, kept as `string.find_lua`,
  `string.sub_lua` and `string.len_lua`. (In testing, the replaced functions
  also did not return what the docs describe when called from the debuggee:
  `find` returned nothing and `sub` returned its last argument.)
- **`os.time()` does not advance**; `os.clock()` does. Use `os.clock` for timeouts.
- **Mod priority is the mod list order, first line wins.** When two mods
  contain the same file, the mod listed first in the mod list file wins (tested
  with four packs listed out of alphabetical order). It is not alphabetical, as
  RPFM's default merge assumes; the virtual sources merge in mod list order.
- **Chunk names are bare paths** such as `script\_lib\lib_core.lua` (no `@`).
- **Script globals live in their own environment**, not `_G`. The debuggee
  evaluates in its own chunk environment (`getfenv(1)`), which is the scripts'.
- **A file kept open does not see data appended later**, so the debuggee
  reopens `to_game` for every read.
- **The executable path must be quoted** on the command line, otherwise the
  game ignores the mod list (`launcher.ts`).
- `"trace": true` in a launch configuration makes the debuggee write
  `<game>/tw_lua_debugger/debuggee.log`.

## Building

Requirements: Node 20+, Rust (stable), and on Windows the Visual Studio C++
build tools (for Rust and for the Lua test interpreter).

```bash
cd rpfm-interface && npm run build
```

```bash
cd extension && npm ci && npm run build
```

`npm run build` bundles the extension with esbuild and copies the debuggee mod
and the native module into `extension/` so they end up in the VSIX.

## Testing

```bash
cd extension && npm run build-lua
```

downloads the official Lua 5.1.5 sources (SHA-256 checked) and builds
`.tools/lua51/lua51.exe`. Then:

```bash
npm test
```

runs the unit tests and the adapter integration tests, which drive the real
debuggee inside a fake game loop (`test/lua/fixtures/run_game.lua`) through the
Debug Adapter Protocol.

```bash
npm run test:vscode
```

runs the extension inside VS Code (downloaded into `.vscode-test/`), including
an end-to-end debug session. If Total War: WARHAMMER III is installed (or
`TW_GAME_DIR` is set) it also checks the virtual source files against the real
game packs, read only.

## Packaging

```bash
cd extension && npx vsce package --target win32-x64
```

The VSIX is platform specific because of the native module.

## Releasing

1. Bump `version` in `extension/package.json` and `MOD_VERSION` in
   `debuggee/script/_lib/mod/vscode-debuggee.lua` to the same value (a unit
   test fails if they differ; the extension warns users whose installed mod is
   a different version). Bump `PROTOCOL` in the Lua file and `PROTOCOL_VERSION`
   in `extension/src/adapter/protocol.ts` only when the message format changes.
2. Add the changes to `CHANGELOG.md`.
3. Push a `v<version>` tag. CI builds and tests everything, attaches the VSIX
   and `tw_lua_debugger.pack` to a GitHub release, and publishes to the
   Marketplace and Open VSX when the `VSCE_PAT` / `OVSX_PAT` secrets are set.
4. Update the Steam Workshop mod with that `tw_lua_debugger.pack`, using the
   game's mod uploader. Keep the file paths inside the pack unchanged so the
   new version replaces older copies.
