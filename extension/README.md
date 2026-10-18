# TW Lua Debugger

Debug the Lua scripts of **Total War: WARHAMMER III** from Visual Studio Code:
breakpoints, stepping, variables, the Debug Console and the game's own script
files, while the game runs.

## Quick start

Run **TotalWar: Create Mod Project…** from the Command Palette. It creates a
small example campaign mod, set up for debugging, pointing at your game
(found through Steam), and opens it. Then:

1. open `pack/script/campaign/mod/<your mod>.lua` and set a breakpoint in `on_heartbeat`;
2. Run and Debug (Ctrl+Shift+D) → **Launch into a save** → F5 and pick a save.

Before every launch the project's `pack` task packs your mod, installs it and
the debugger mod, and lists both in the project's own mod list file; nothing
else to set up. The project's README explains the rest.

## Setup for an existing mod

1. Install the debugger mod into the game. Either:
   - run **TotalWar: Install Debugger Mod into Game** from the Command Palette, or
   - subscribe to the [Steam Workshop mod](https://steamcommunity.com/sharedfiles/filedetails/?id=2864762290)
     (version 2) and enable it in the launcher.
2. Open your mod's folder in VS Code and press `F5`. Without a `launch.json`
   the extension finds the game through Steam and starts it. To customise it,
   create a `launch.json` (Run and Debug -> "create a launch.json file" ->
   "Total War Lua"):

```jsonc
{
	"name": "Launch Total War",
	"type": "tw-lua",
	"request": "launch",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe",
	"modListFile": "used_mods.txt",
	// optional: skip the frontend and load a save
	"arguments": "game_startup_mode campaign_load \"My Save.save\";",
	// optional: where your own Lua files are (the folder that contains "script")
	"sourceFilesPath": "${workspaceFolder}/pack"
}
```

Use `"request": "attach"` to connect to a game you start yourself (for example
from the launcher). The game connects within a second; you can attach before or
after starting it.

## Launch options

| Option | Default | |
|---|---|---|
| `executable` | | The game executable. Required. |
| `modListFile` | `used_mods.txt` | Mod list file (next to the executable) passed to the game. |
| `arguments` | | Extra command line, e.g. `game_startup_mode campaign_load "x.save";` |
| `env` | | Extra environment variables. |
| `sourceFilesPath` | | Folder with your Lua sources, searched before the workspace and the packs. |
| `terminateDebuggee` | `true` | Close the game when you stop debugging (launch only). |
| `captureOutput` | `true` | Mirror the script log (`out`, `print`) to the Debug Console. |
| `trace` | `false` | Log the messages between VS Code and the game. |

## Features

- Breakpoints, conditional breakpoints, hit counts and logpoints.
- Step over, into and out; pause.
- Locals, upvalues and globals; expand tables, functions and userdata
  metatables; change values in the Variables view.
- Evaluate expressions and statements in the Debug Console, also while the game
  is running; hover to evaluate while stopped.
- Break on `script_error()` (Breakpoints view): by default only when a mod script
  (a file in a `mod` folder) is involved, since the game's own scripts report
  errors during normal play. "All script_error() calls" and `error()` calls are
  available too.
- Print to the Debug Console from Lua: `debuggee.print("warning", "text")`
  (`log`, `warning` or `error`). Stop from code: `debuggee.breakHere("why")`.
- **While the game runs** (a Total War debug session is connected):
  - **Campaign** view in Run and Debug: the factions, their characters and
    regions, live from the game. Right-click to add money, apply an effect
    bundle, give a region to another faction, add levels to, teleport or kill a
    character. Refresh with the view's button.
  - **TotalWar: Start/Stop Event Monitor** lists the script events the game
    fires (with their faction, character, region, ...) in the `TW Script Events`
    output. `twdev.eventMonitor.exclude` leaves out noisy ones.
  - **Run File / Run Selection in the Game** (editor context menu) runs Lua in
    the game's script environment. With `twdev.hotReload`, saving a mod script
    runs it again in the game; guard listeners it adds, or they are added twice.
  - **TotalWar: Start Profiler**, then **Stop Profiler and Show Results**:
    where the scripts spend their time, as the busiest functions and a flame
    graph (sampled every `twdev.profiler.interval` Lua instructions).
- **Virtual source files**: every file of the game's packs and of the mods in
  your mod list, as the read-only `twsource:/` file system. Lua files open as
  text, DB tables (`db/<table>/<file>`) read-only in the DB table editor, and
  other types in whatever editor you have for them: `@basegame/`
  holds the game's own files and `@mods/<pack>/` each mod's own files, so you
  can see where a file comes from. A file that a mod overrides appears in both;
  stack frames open the copy the game actually runs (the first mod in the mod
  list that has it, else the game's), when there is no local copy. A
  breakpoint in any copy stops in the copy that runs. To always see them in the Explorer,
  use a workspace file with the folder in it (adding a folder to a plain folder
  window restarts the extensions, which ends a running debug session):

  ```jsonc
  // my_mod.code-workspace
  { "folders": [ { "path": "." }, { "name": "Virtual TW Source Files", "uri": "twsource:/" } ] }
  ```

  Or run **TotalWar: Show Virtual Source Files** while not debugging.

  The game alone has over 700,000 files. **TotalWar: Filter Virtual Files…**
  (also in the context menu of the virtual folders) hides kinds of files
  (audio, animations, models, textures, …); folders left empty disappear. It
  writes the `twdev.virtualFiles.exclude` setting, which also takes your own
  glob patterns (`*.wem`, `ui/skins/**`). Hidden files still open from the
  debugger and links.
- **Game Database**: the DB tables (units, buildings, effects, ...) with the
  values the game uses for your mod list. Each row shows the pack it comes from
  and the rows it overrides. Within a table, fragments load by file name
  (`!!!my_mod` before the game's `data__`), and the first row with a key wins.
  - The **Game Database** view in Run and Debug lists the tables. Click one to
    open it as a sortable, filterable grid (also **TotalWar: Open DB Table…**).
    Click a reference cell to open the row it points to.
  - `:db <table> [key filter]` or `:db <key>` in the Debug Console. This also
    works while the game is not connected.
  - Hover a key string in Lua (`"wh_main_emp_inf_swordsmen"`) to see its row
    (`twdev.dbHover`).

- **Lua IntelliSense**: completion, signatures and documentation for the
  game's script library (`cm`, `core`, `bm`, the campaign and battle managers
  and ~2700 other documented functions), generated from CA's own doc comments
  in the game's scripts and regenerated after a game update. `core:add_listener`
  completes the game's event names. Run **TotalWar: Set Up Lua IntelliSense**
  (offered once in a mod project): it uses the Lua extension (`sumneko.lua`,
  installed on request) and sets its workspace settings (`Lua.runtime.version`
  5.1, `Lua.workspace.library`).
  - In any Lua string, DB keys complete (`"wh_main_emp_inf_sw` →
    `wh_main_emp_inf_swordsmen`, with the table it is in), and known keys are
    Ctrl+clickable to open their row (`twdev.dbCompletion`).

- **DB table editor**: opening a table file in your mod (`pack/db/<table>/<file>`)
  shows it in the same grid, editable. Saving writes the binary table, and the
  `pack` task packs it.
  - Double-click a cell (or press Enter or F2) to edit it. Booleans toggle;
    numbers are checked against the column type; reference columns suggest the
    game's keys and outline unknown ones. Ctrl+click a reference to open the row
    it points to.
  - **Add row** (the schema's defaults), **Duplicate**, **Delete** (Del), and
    **Import from game…** to copy rows from the game's tables as your mod list
    has them. Undo, redo, Save and Revert work as usual.
  - The **effect** column tells what each row does in the game: a new row,
    overrides another pack's row (the changed cells are highlighted), loses to a
    file that sorts first, or repeats a key earlier in the file.
  - **TotalWar: New DB Table…** (also in the Explorer's context menu on a folder)
    creates an empty fragment, named `!!!<mod>` by default.
  - **TSV for git**: tables and loc files can also be kept as RPFM's TSV text
    (`<file>.tsv`, `<file>.loc.tsv`), which diffs and merges in git. They open
    in the same editor, and the `pack` task packs them as the binary file, at
    their own path without `.tsv`. `twdev.newTableFormat` picks the format of
    new files.
  - **Loc files** (`*.loc`, `*.loc.tsv`) open in the same grid (key, text,
    tooltip); **TotalWar: New Loc File…** creates one. Hovering a DB key in Lua
    shows its texts (e.g. a unit's on-screen name).
  - **Problems view**: in a mod project the mod's tables and loc files are
    checked against the game and the mod list: a table version older than the
    game's (it crashes the game; **TotalWar: Migrate DB Table to the Game's
    Version** rewrites it, also in the Explorer's context menu), references to
    keys that don't exist, repeated keys, and new rows without loc text
    (`twdev.modDiagnostics`, **TotalWar: Check Mod DB Tables and Loc Files**).
  - **TotalWar: Copy Game Entity into the Mod…** (also the copy button on a
    table in the Game Database view) copies a unit, building, effect bundle, ...
    under a new key: its row, the rows whose key contains its key (a unit's
    `land_units` row, ...), the link rows that tie it to other things
    (recruitment permissions, unit sets, the buildings that recruit it, with a
    new id), and its texts. Rows it only refers to (factions, castes, armour
    types) stay shared. A preview lists the tables; uncheck the ones you don't
    want. The rows go into `!!!<mod>` files in the mod's `pack/db/<table>/` and
    `pack/text/db/`.
  - **TotalWar: Show Conflicts Between Mods in the Mod List** lists the files
    and DB rows that several mods in the mod list have, and which one the game
    uses.

  Decoding needs an RPFM schema. It is downloaded from
  [rpfm-schemas](https://github.com/Frodo45127/rpfm-schemas) (refreshed daily, or
  with **TotalWar: Update DB Schema**), with a copy shipped as a fallback. Point
  `twdev.dbSchemaPath` at RPFM's schemas folder to use your own.
- **`pack` task**: build a `.pack` from a folder and install it:

```jsonc
// tasks.json
{
	"label": "Pack my mod",
	"type": "pack",
	"packfilesDirectory": "pack",
	"modName": "my_mod.pack",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe"
}
```

Add `"preLaunchTask": "Pack my mod"` to the launch configuration to pack and
install before every run.

## Mods that depend on other mods

Declare them in the `pack` task and use a mod list file that belongs to the
project (not `used_mods.txt`):

```jsonc
// tasks.json
{
	"label": "Pack my mod",
	"type": "pack",
	"packfilesDirectory": "pack",
	"modName": "my_mod.pack",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe",
	"modListFile": "my_mod_mods.txt",
	"includeDebuggerMod": true,
	"dependencies": [
		"2789857593",                                                  // Steam Workshop item id (subscribed)
		"some_mod.pack",                                                // a pack in the game's data folder
		"D:/mods/other_mod.pack",                                       // any pack file
		{ "folder": "../other_mod/pack", "modName": "other_mod.pack" } // a mod you develop: packed too
	]
}
```

Before every launch the task resolves them, packs folder dependencies, and writes
`my_mod_mods.txt` completely: `add_working_directory` lines for Workshop items
and other folders, then your mod, the debugger mod and the dependencies. In
Total War the mod listed **first** wins when two mods contain the same file, so
your mod can override files of its dependencies. Use the same `modListFile` in
the launch configuration.

Workshop dependencies download themselves: when an item, or an item it lists
as required on its Workshop page, is not downloaded, the task asks to subscribe
to it through Steam (Steam must be running), waits for the download and lists
the required items after yours. `twdev.autoSubscribeDependencies` sets this to
`always` or `never` (then a missing item stops the launch with a link to
subscribe yourself). What Steam says about required items is remembered for a day.

To debug into a dependency you develop yourself, add its project folder to your
`.code-workspace`; its files then open from there. Other dependencies' scripts
are in the virtual source files (`@mods/<pack>/`).

## Good to know

- When the game switches between frontend, campaign and battle it rebuilds its
  Lua state. The debugger reconnects automatically and keeps your breakpoints;
  during loading screens it does not respond.
- Only one debugger mod may be active. If an old (1.x) version is still
  enabled, the Debug Console tells you to update it.
- The launcher writes `used_mods.txt` itself. When you start the game from the
  launcher, enable the debugger mod there.
- Coming from 1.x? Launch configurations change from `"type": "lua"` to
  `"type": "tw-lua"`; the extension offers to update them.
- **Breakpoints slow Lua down.** While at least one breakpoint is set, the
  debugger checks every line of script code (Lua 5.1 offers nothing cheaper),
  which makes scripts run several times slower. Without breakpoints there is no
  cost. Remove breakpoints you no longer need, especially during long AI turns.
- If VS Code is closed or crashes, the game notices within a few seconds and
  carries on; a game paused at a breakpoint resumes by itself.
- The `pack` task converts `.tsv` files (RPFM's format) to binary DB tables and
  loc files. RPFM writes floats in TSV with fewer digits, so a value like
  `0.90000004` comes back as `0.9`.
- WARHAMMER III is the tested game. Other games in the `twdev.game` setting
  (WARHAMMER II, THREE KINGDOMS, TROY, ROME II) are experimental and untested.

## Thanks

Based on the [devCAT Lua debugger](https://github.com/devcat-studio/VSCodeLuaDebug).
Pack files are read and written with [RPFM](https://github.com/Frodo45127/rpfm).
