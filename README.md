# Total War Modding Tools

A VS Code extension for making Total War: WARHAMMER III mods: a debugger for
the game's Lua 5.1 scripts, the game database and DB/loc editors, mod checks,
Lua IntelliSense and pack tools. User documentation is in
[extension/README.md](extension/README.md) (the Marketplace page); this file is
for working on the extension itself.

An unofficial community tool, not affiliated with Creative Assembly or SEGA.

## Layout

| Folder | What |
|---|---|
| `extension/` | The VS Code extension (TypeScript). `src/adapter/` is the debug adapter; it runs in the extension host (`DebugAdapterInlineImplementation`) and has no `vscode` dependency. |
| `debuggee/` | The in-game half: a mod with `script/_lib/mod/vscode-debuggee.lua` and bootstraps for frontend, campaign and battle. Shipped inside the extension; every debug session packs it into `<game>/data/tw_lua_debugger.pack` (`extension/src/installMod.ts`). |
| `rpfm-interface/` | Rust (napi-rs) bindings to `rpfm_lib`, used to read packs and DB tables and to build packs. |
| `steam-helper/` | Rust helper that subscribes to and downloads Steam Workshop items that `totalwar-pack` task dependencies need. |
| `example/` | The example mod project. Shipped in the extension and copied (renamed, pointed at the user's game) by **TotalWar: Create Mod Project…**; `Run Extension` opens it. |

## How it works

```
VS Code --DAP (in process)--> TwLuaDebugSession (extension/src/adapter/session.ts)
                                  | path mapping, breakpoints, variable references
                                  v
                              FileTransport  <-- files -->  vscode-debuggee.lua (in the game)
                              <game folder>/tw_lua_debugger/{session.json,to_game,from_game}
```

Before the session starts (after any `preLaunchTask`), the adapter factory in
`extension.ts` builds the debuggee into the game's `data` folder and, for
launch, adds it to the mod list file, so the game always runs the debuggee
that matches the extension.

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

One-time setup:

1. Create the publisher `Fietspompje` at
   <https://marketplace.visualstudio.com/manage> (sign in with the Microsoft
   account that should own the extension). The ID must match `publisher` in
   `extension/package.json`.
2. Create a personal access token at <https://dev.azure.com> (User settings →
   Personal access tokens): organization **All accessible organizations**,
   scope **Marketplace → Manage**. Add it to the GitHub repository as the
   `VSCE_PAT` secret (Settings → Secrets and variables → Actions).
3. Optional, for Open VSX (VSCodium, Cursor and others): sign in at
   <https://open-vsx.org>, sign the publisher agreement, create a token, run
   `npx ovsx create-namespace Fietspompje -p <token>` once and add the token as
   the `OVSX_PAT` secret.

Every release:

1. Bump `version` in `extension/package.json` and `MOD_VERSION` in
   `debuggee/script/_lib/mod/vscode-debuggee.lua` to the same value. A unit
   test fails if they differ, and the Debug Console reports a game still
   running an older debuggee (it was started before the extension updated
   the pack). Bump `PROTOCOL` in the Lua file and `PROTOCOL_VERSION` in
   `extension/src/adapter/protocol.ts` only when the message format changes.
2. Add the changes to `CHANGELOG.md`.
3. Push a `v<version>` tag on `main`. CI builds and tests everything, attaches
   the VSIX to a GitHub release, and publishes it to the Marketplace
   (`Fietspompje.total-war-modding-tools`) and Open VSX when the `VSCE_PAT` / `OVSX_PAT`
   secrets are set. The build fails if the tag does not match the version.

To publish by hand instead (after `cd rpfm-interface && npm run build`):

```bash
cd extension && npx vsce login Fietspompje && npm run publish
```
