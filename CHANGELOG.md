# Changelog

## 2.0.0

A rewrite of the debug adapter. The C# `DebugAdapter.exe` is gone; the adapter
now runs inside VS Code (TypeScript, `@vscode/debugadapter`).

### Breaking changes
- The debug type is now `tw-lua` (was `lua`, which clashed with other Lua
  debuggers). The extension offers to update old launch configurations, or run
  **TotalWar: Migrate Old "lua" Launch Configurations**.
- The in-game debugger mod speaks a new protocol. Update the Steam Workshop mod
  or run **TotalWar: Install Debugger Mod into Game**. An old mod is detected
  and reported in the Debug Console.
- The `encoding` launch option was removed; messages are always UTF-8.

### New
- **TotalWar: Create Mod Project…** creates a ready-to-debug example mod
  (script, launch configurations, pack task, workspace with the virtual
  sources) for your game install.
- `pack` task option `dependencies`: Workshop item ids, packs or local mod
  folders the mod needs; the task resolves and packs them and writes the
  project's mod list (your mod first, so it wins over its dependencies).
- The virtual sources merge mods in mod list order (first wins), as the game
  does, instead of RPFM's alphabetical order.
- `pack` task option `includeDebuggerMod`: installs the debugger mod and lists
  it in the mod list file before every launch.
- Launch configurations can ask for a campaign save with the
  `twdev.pickSaveGame` command input (newest first).
- Conditional breakpoints, hit counts and logpoints.
- Break on `script_error()` from mod scripts (on by default), on every
  `script_error()` including the game's own (off by default), and on `error()` calls.
- Pause stops at the next line of script code instead of inside the poller.
- Change variables from the Variables view; evaluate statements and
  assignments in the Debug Console, also while the game is running.
- Hover evaluation, table previews, coroutines shown as threads.
- The game's script log (`out`, `print`) is mirrored to the Debug Console
  (`captureOutput`).
- Stack frames in pack files open from the virtual `twsource:/` file system;
  local copies (`sourceFilesPath`, workspace folders) are preferred.
- Attaching works at any time: the game picks up a debug session within a
  second, also after VS Code was restarted.
- Breakpoints survive frontend -> campaign -> battle switches.
- The virtual source folder is split by origin: `@basegame/` for the game's
  own files, `@mods/<pack>/` for each mod's. Stack frames open the copy the
  game runs.
- The virtual source folder includes all of the game's own packs (from its
  manifest) plus the mods in the mod list, and reloads when the mod list
  changes.
- A "waiting for the game" notification replaces the WinForms window.
- `F5` without a `launch.json` finds the game through Steam.

- The debugger mod changes nothing in the game until VS Code connects, and
  restores the functions it wrapped when it disconnects.
- `"trace": true` also makes the game write `tw_lua_debugger/debuggee.log`.
- Debug Console completions (also `obj:` methods of the game's interfaces),
  exception details with a Lua traceback, large tables shown in pages, and a
  Loaded Scripts view.
- If VS Code goes away, the game resumes (when paused) or detaches by itself
  within a few seconds instead of waiting forever; stale sessions are ignored.
- The communication files are started over when they grow past 1 MB.
- A different debugger mod version in the game is reported in the Debug Console.

- Modding SDK:
  - Workshop dependencies of the `pack` task, and the items they require, are
    subscribed to and downloaded through Steam when missing
    (`twdev.autoSubscribeDependencies`).
  - Lua IntelliSense for the game's script library (LuaLS stubs generated from
    CA's doc comments), event name completion for `add_listener`, DB key
    completion and Ctrl+click in Lua strings.
  - DB tables and loc files as RPFM TSV (packed as binary), a loc file editor,
    loc texts in the DB key hover.
  - Mod checks in the Problems view (outdated table versions, broken
    references, repeated keys, missing loc), table migration to the game's
    version, and a report of conflicts between the mods in the mod list.
  - Copy a game entity (unit, building, ...) with its rows and texts into the mod.
  - Campaign view, event monitor, running code in the game (and hot reload) and
    a sampling profiler while the game is connected.

### Fixed
- Stopping a game that Steam had restarted could stop other running copies of
  the game; now only copies started by the debug session are stopped.
- Launching from a folder with spaces (e.g. `Program Files (x86)`) ignored the
  mod list, so the debugger mod never loaded.
- Requests with backslashes (e.g. evaluated strings) were corrupted.
- The `pack` task kept running after an error and ignored the normalised mod
  name when installing.
- The virtual file system reported every path as existing.
