# example_mod

A small Total War: WARHAMMER III campaign mod, set up for the TW Lua Debugger.
Create your own copy with **TotalWar: Create Mod Project…** (Command Palette),
or open this folder's `example_mod.code-workspace` directly.

## Layout

| | |
|---|---|
| `pack/` | The mod's files, laid out like the pack: `pack/script/campaign/mod/example_mod.lua`. Add `db/`, `text/`, … here too. |
| `example_mod.code-workspace` | Open this (File → Open Workspace from File). It adds **Virtual TW Source Files**: every Lua script in the game's packs, read-only. |
| `.vscode/launch.json` | **Launch into a save** (asks which save), **Launch to the main menu**, **Attach to the running game**. |
| `.vscode/tasks.json` | **Pack example_mod**: runs before every launch (see below). |

Before each launch the pack task:

1. packs `pack/` into `out/example_mod.pack` and copies it into the game's `data` folder;
2. installs the debugger mod (`tw_lua_debugger.pack`) from the extension;
3. lists both in `example_mod_mods.txt` next to the game executable.

The game is started with that mod list, so only the debugger and this mod are
loaded. Your `used_mods.txt` and the official launcher are not involved.
Change `executable` in `launch.json` and `tasks.json` if the game is installed
somewhere else (**Create Mod Project** fills it in for you).

## Depending on other mods

List them under `"dependencies"` in `.vscode/tasks.json` (there is a commented
example): Workshop item ids, pack names or paths, or another project folder of
yours. Before every launch the task then writes `example_mod_mods.txt`
completely: this mod first, the debugger mod, then the dependencies in the order
listed. In Total War the mod listed first wins when two mods contain the same
file, so this mod can override its dependencies.

A dependency you develop yourself (`{ "folder": ..., "modName": ... }`) is
packed before every launch too. Add its project folder to
`example_mod.code-workspace` so breakpoints in its scripts open the local files.
Dependencies' scripts also show up in **Virtual TW Source Files** under
`@mods/<pack>/`.

## Try it

1. Open `pack/script/campaign/mod/example_mod.lua` and set a breakpoint on the
   first line of `on_heartbeat` (`heartbeats = heartbeats + 1`).
2. Run and Debug (Ctrl+Shift+D) → **Launch into a save** → F5, pick a save.
3. About 10 seconds after the campaign map appears the game pauses at your
   breakpoint. The **Variables**, **Call Stack** and **Breakpoints** views are
   in Run and Debug; hover a variable to see its value; step with F10/F11.
4. In the Debug Console (Ctrl+Shift+Y) try `cm:model():turn_number()`,
   `faction_stats`, or type `cm:` for completions.
5. Set a breakpoint in `on_turn_start` and end your turn.
6. Stop debugging (Shift+F5) closes the game.

Also try a conditional breakpoint (`heartbeats % 3 == 0`), a logpoint
(`heartbeat {heartbeats} on turn {turn}`), and **Pause** while the game runs.
