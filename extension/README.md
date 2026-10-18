# Total War Modding Tools

Make **Total War: WARHAMMER III** mods in Visual Studio Code. Debug the game's
Lua scripts while it runs, browse and edit the game database, check your mod
against the game, and pack and launch it, all from one extension.

> An unofficial community tool. Not affiliated with or endorsed by Creative
> Assembly or SEGA. Total War and WARHAMMER are trademarks of their owners.

## Quick start

1. Run **TotalWar: Create Mod Project…** from the Command Palette. It creates a
   small example campaign mod, finds your game through Steam, and opens the
   project.
2. Open `pack/script/campaign/mod/<your mod>.lua` and set a breakpoint in `on_heartbeat`.
3. Run and Debug (Ctrl+Shift+D) → **Launch into a save** → F5, and pick a save.

Before every launch the project's `totalwar-pack` task packs your mod and installs it.
The debug session then installs the debugger mod and lists it in the
project's mod list file, so there is nothing else to set up. The project's
README explains the rest.

## Features

### Lua debugger
- Breakpoints, conditional breakpoints, hit counts and logpoints.
- Step over, into and out; pause.
- Locals, upvalues and globals. Expand tables, functions and userdata
  metatables, and change values in the Variables view.
- Evaluate expressions and statements in the Debug Console, even while the game
  is running. Hover to evaluate while stopped.
- Break on `script_error()` (in the Breakpoints view). By default it only breaks
  when a mod script (a file in a `mod` folder) is involved, because the game's
  own scripts report errors during normal play. "All script_error() calls" and
  `error()` calls are available too.
- From Lua, `debuggee.print("warning", "text")` prints to the Debug Console
  (`log`, `warning` or `error`) and `debuggee.breakHere("why")` stops in the debugger.
- The game's script log (`out`, `print`) is mirrored to the Debug Console.
- The debugger follows the game between frontend, campaign and battle and keeps
  your breakpoints.

### Runtime tools (while a debug session is connected)
- **Campaign** view in Run and Debug shows the factions, their characters and
  regions, live from the game. Right-click to:
  - add money;
  - apply an effect bundle;
  - give a region to another faction;
  - add levels to, teleport or kill a character.
- **TotalWar: Start/Stop Event Monitor** lists the script events the game fires,
  with their faction, character, region and so on, in the `TW Script Events`
  output. `totalwar.eventMonitor.exclude` leaves out noisy events.
- **Run File / Run Selection in the Game** (editor context menu) runs Lua in the
  game's script environment. With `totalwar.hotReload`, saving a mod script runs it
  again in the game. Guard any listeners it adds, or they are added twice.
- **TotalWar: Start Profiler**, then **Stop Profiler and Show Results**, shows
  where the scripts spend their time, as the busiest functions and a flame graph.
  The sample interval is `totalwar.profiler.interval` Lua instructions.

### Virtual source files
Every file in the game's packs and in the mods in your mod list is available
as the read-only `totalwar:/` file system:
- `@basegame/` holds the game's own files and `@mods/<pack>/` holds each mod's
  files, so you can see where a file comes from.
- Lua files open as text, DB tables (`db/<table>/<file>`) open read-only in the
  table editor, and other files open in whatever editor you have for them.
- Stack frames open the copy the game actually runs: the first mod in the mod
  list that has the file, otherwise the game's own. A local copy is preferred
  when there is one, and a breakpoint in any copy stops in the copy that runs.

To keep the files in the Explorer, use a workspace file that includes them.
Adding a folder to a plain folder window restarts the extensions, which ends a
running debug session.

```jsonc
// my_mod.code-workspace
{ "folders": [ { "path": "." }, { "name": "Virtual TW Source Files", "uri": "totalwar:/" } ] }
```

You can also run **TotalWar: Show Virtual Source Files** while not debugging.

The game alone has over 700,000 files. **TotalWar: Filter Virtual Files…**
(also in the context menu of the virtual folders) hides kinds of files: audio,
animations, models, textures and so on. Folders left empty disappear. The
command writes the `totalwar.virtualFiles.exclude` setting, which also accepts
your own glob patterns (`*.wem`, `ui/skins/**`). Hidden files still open from
the debugger and from links.

### Game Database
The DB tables (units, buildings, effects, ...) show the values the game uses
for your mod list. Each row shows the pack it comes from and the rows it
overrides. Within a table, fragments load by file name (`!!!my_mod` before the
game's `data__`), and the first row with a given key wins.

- The **Game Database** view in Run and Debug lists the tables. Click one to
  open it as a sortable, filterable grid (or use **TotalWar: Open DB Table…**).
  Click a reference cell to open the row it points to.
- In the Debug Console, `:db <table> [key filter]` or `:db <key>` looks up rows.
  It works without the game running.
- Hover a key string in Lua (`"wh_main_emp_inf_swordsmen"`) to see its row and
  its texts, for example a unit's on-screen name (`totalwar.dbHover`).
- **TotalWar: Show Conflicts Between Mods in the Mod List** lists the files and
  DB rows that more than one mod in the mod list contains, and which one the game uses.

### DB and loc editors
Opening a table file in your mod (`pack/db/<table>/<file>`) shows it in the
same grid, editable. Saving writes the binary table, and the `totalwar-pack` task packs it.

- Double-click a cell (or press Enter or F2) to edit it. Booleans toggle, and
  numbers are checked against the column type. Reference columns suggest the
  game's keys and outline unknown ones. Ctrl+click a reference to open the row
  it points to.
- **Add row** (with the schema's defaults), **Duplicate**, **Delete** (Del), and
  **Import from game…**, which copies rows from the game's tables as your mod
  list has them. Undo, redo, Save and Revert work as usual.
- The **effect** column says what each row does in the game:
  - adds a new row;
  - overrides another pack's row (the changed cells are highlighted);
  - loses to a file that sorts first;
  - repeats a key used earlier in the file.
- **TotalWar: New DB Table…** (also in the Explorer's context menu on a folder)
  creates an empty fragment, named `!!!<mod>` by default.
- **Loc files** (`*.loc`, `*.loc.tsv`) open in the same grid (key, text,
  tooltip). **TotalWar: New Loc File…** creates one.
- **TSV for git**: tables and loc files can also be kept as RPFM's TSV text
  (`<file>.tsv`, `<file>.loc.tsv`), which diffs and merges in git. They open in
  the same editor, and the `totalwar-pack` task packs them as binary files at their own
  path without `.tsv`. `totalwar.newTableFormat` picks the format of new files.
- **TotalWar: Copy Game Entity into the Mod…** (also the copy button on a table
  in the Game Database view) copies a unit, building, effect bundle, and so on
  under a new key. It copies:
  - the entity's own row;
  - the rows whose key contains its key (a unit's `land_units` row, ...);
  - the link rows that tie it to other things (recruitment permissions, unit
    sets, the buildings that recruit it), with a new id;
  - its texts.

  Rows it only refers to (factions, castes, armour types) stay shared. A
  preview lists the tables; uncheck the ones you don't want. The rows go into
  `!!!<mod>` files in the mod's `pack/db/<table>/` and `pack/text/db/`.

Decoding tables needs an RPFM schema. It is downloaded from
[rpfm-schemas](https://github.com/Frodo45127/rpfm-schemas) daily (or with
**TotalWar: Update DB Schema**), and a copy ships with the extension as a
fallback. Point `totalwar.dbSchemaPath` at RPFM's schemas folder to use your own.

### Mod checks
In a mod project, the Problems view checks the mod's tables and loc files
against the game and the mod list (`totalwar.modDiagnostics`, or run **TotalWar:
Check Mod DB Tables and Loc Files**). It reports:
- table versions older than the game's, which crash the game. **TotalWar:
  Migrate DB Table to the Game's Version** rewrites the table; it is also in
  the Explorer's context menu;
- references to keys that don't exist;
- repeated keys;
- new rows without loc text.

### Lua IntelliSense
Completion, signatures and documentation for the game's script library: `cm`,
`core`, `bm`, the campaign and battle managers, and about 2,700 other documented
functions. They are generated from CA's own doc comments in the game's scripts
and regenerated after a game update.
- `core:add_listener` completes the game's event names.
- In any Lua string, DB keys complete (`"wh_main_emp_inf_sw` →
  `wh_main_emp_inf_swordsmen`, showing the table it is in). Known keys are
  Ctrl+clickable to open their row (`totalwar.dbCompletion`).

Run **TotalWar: Set Up Lua IntelliSense**, which is offered once in a mod
project. It uses the Lua extension (`sumneko.lua`, installed on request) and
sets its workspace settings (`Lua.runtime.version` 5.1, `Lua.workspace.library`).

### Packing and dependencies
The `totalwar-pack` task builds a `.pack` from a folder and installs it into the game.
Mods can depend on Steam Workshop items, other packs, or other mods you develop;
see [Mods that depend on other mods](#mods-that-depend-on-other-mods).

## Using it with an existing mod

Open your mod's folder and press F5. Without a `launch.json`, the extension
finds the game through Steam and starts it. Every debug session installs the
debugger mod shipped with the extension into the game's `data` folder and lists
it in the mod list file, so the debugger always matches the extension.

To customise the launch, create a `launch.json` (Run and Debug → "create a
launch.json file" → "Total War Lua"):

```jsonc
{
	"name": "Launch Total War",
	"type": "totalwar-lua",
	"request": "launch",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe",
	"modListFile": "used_mods.txt",
	// optional: skip the frontend and load a save
	"arguments": "game_startup_mode campaign_load \"My Save.save\";",
	// optional: where your own Lua files are (the folder that contains "script")
	"sourceFilesPath": "${workspaceFolder}/pack",
	// optional: pack and install your mod before every launch
	"preLaunchTask": "Pack my mod"
}
```

```jsonc
// tasks.json
{
	"label": "Pack my mod",
	"type": "totalwar-pack",
	"packfilesDirectory": "pack",
	"modName": "my_mod.pack",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe"
}
```

### Starting the game yourself
Use `"request": "attach"` to connect to a game you start yourself, for example
from the game's launcher. The game connects within a second, and you can attach
before or after starting it. The launcher writes `used_mods.txt` itself, so the
debugger mod has to be enabled there. Run **TotalWar: Install Debugger Mod into
Game** once, then enable `tw_lua_debugger` in the launcher. Attaching also
updates the installed debugger mod (the game uses the new copy after a restart)
and warns when the mod list doesn't include it.

## Launch options

| Option | Default | |
|---|---|---|
| `executable` | | The game executable. Required. |
| `modListFile` | `used_mods.txt` | Mod list file (next to the executable) passed to the game. |
| `arguments` | | Extra command line, e.g. `game_startup_mode campaign_load "x.save";` |
| `env` | | Extra environment variables. |
| `sourceFilesPath` | | Folder with your Lua sources, searched before the workspace and the packs. |
| `installDebuggerMod` | `true` | Install the debugger mod and list it in `modListFile` before the session starts. |
| `terminateDebuggee` | `true` | Close the game when you stop debugging (launch only). |
| `captureOutput` | `true` | Mirror the script log (`out`, `print`) to the Debug Console. |
| `trace` | `false` | Log the messages between VS Code and the game. |

## Mods that depend on other mods

Declare dependencies in the `totalwar-pack` task, and use a mod list file that belongs
to the project (not `used_mods.txt`):

```jsonc
// tasks.json
{
	"label": "Pack my mod",
	"type": "totalwar-pack",
	"packfilesDirectory": "pack",
	"modName": "my_mod.pack",
	"executable": "C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe",
	"modListFile": "my_mod_mods.txt",
	"dependencies": [
		"2789857593",                                                  // Steam Workshop item id
		"some_mod.pack",                                                // a pack in the game's data folder
		"D:/mods/other_mod.pack",                                       // any pack file
		{ "folder": "../other_mod/pack", "modName": "other_mod.pack" } // a mod you develop: packed too
	]
}
```

Before every launch the task resolves the dependencies, packs folder
dependencies, and rewrites `my_mod_mods.txt` completely:
`add_working_directory` lines for Workshop items and other folders, then your
mod, then the dependencies. The debug session adds the debugger mod after that.
In Total War the mod listed **first** wins when two mods contain the same file,
so your mod can override files of its dependencies. Use the same `modListFile`
in the launch configuration.

Workshop dependencies download themselves. When an item, or an item it lists
as required on its Workshop page, is not downloaded, the task asks to subscribe
to it through Steam (Steam must be running). It waits for the download and lists
the required items after yours. `totalwar.autoSubscribeDependencies` can set this
to `always` or `never`. With `never`, a missing item stops the launch with a
link to subscribe yourself. What Steam reports about required items is
remembered for a day.

To debug into a dependency you develop yourself, add its project folder to your
`.code-workspace`, and its files then open from there. Other dependencies'
scripts are in the virtual source files (`@mods/<pack>/`).

## Good to know

- When the game switches between frontend, campaign and battle, it rebuilds its
  Lua state. The debugger reconnects automatically and keeps your breakpoints.
  It does not respond during loading screens.
- **Breakpoints slow Lua down.** While at least one breakpoint is set, the
  debugger checks every line of script code (Lua 5.1 offers nothing cheaper),
  which makes scripts run several times slower. Without breakpoints there is
  no cost. Remove breakpoints you no longer need, especially during long AI turns.
- Only one debugger mod may be active. If the old TW Lua Debugger mod from the
  Steam Workshop is still enabled, the Debug Console says so: disable it or
  unsubscribe from it.
- If VS Code is closed or crashes, the game notices within a few seconds and
  carries on. A game paused at a breakpoint resumes by itself.
- The `totalwar-pack` task converts `.tsv` files (RPFM's format) to binary DB tables and
  loc files. RPFM writes floats in TSV with fewer digits, so a value like
  `0.90000004` comes back as `0.9`.
- WARHAMMER III is the tested game. The other games in the `totalwar.game` setting
  (WARHAMMER II, THREE KINGDOMS, TROY, ROME II) are experimental and untested.

## Thanks

The debugger is based on the [devCAT Lua debugger](https://github.com/devcat-studio/VSCodeLuaDebug).
Pack files are read and written with [RPFM](https://github.com/Frodo45127/rpfm).
