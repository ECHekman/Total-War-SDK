/** Total War games the extension knows how to find and pack for. */
export interface GameDefinition {
	/** rpfm game key */
	key: string;
	title: string;
	steamFolder: string;
	exe: string;
	/** Folder under %APPDATA%/The Creative Assembly with the game's saves, logs and settings. */
	appDataFolder: string;
	/** Steam app id; Workshop items live in steamapps/workshop/content/<id>. */
	steamAppId: number;
}

export const GAMES: GameDefinition[] = [
	{ key: 'warhammer_3', title: 'Total War: WARHAMMER III', steamFolder: 'Total War WARHAMMER III', exe: 'Warhammer3.exe', appDataFolder: 'Warhammer3', steamAppId: 1142710 },
	{ key: 'warhammer_2', title: 'Total War: WARHAMMER II', steamFolder: 'Total War WARHAMMER II', exe: 'Warhammer2.exe', appDataFolder: 'Warhammer2', steamAppId: 594570 },
	{ key: 'three_kingdoms', title: 'Total War: THREE KINGDOMS', steamFolder: 'Total War THREE KINGDOMS', exe: 'Three_Kingdoms.exe', appDataFolder: 'ThreeKingdoms', steamAppId: 779340 },
	{ key: 'troy', title: 'A Total War Saga: TROY', steamFolder: 'Troy', exe: 'Troy.exe', appDataFolder: 'Troy', steamAppId: 1099410 },
	{ key: 'rome_2', title: 'Total War: ROME II', steamFolder: 'Total War Rome II', exe: 'Rome2.exe', appDataFolder: 'Rome2', steamAppId: 214950 },
];

export const DEFAULT_GAME = 'warhammer_3';

export function gameByKey(key: string | undefined): GameDefinition {
	return GAMES.find((g) => g.key === key) ?? GAMES[0];
}

/** Guesses the game from an executable name (Warhammer3.exe -> warhammer_3). */
export function gameForExecutable(exe: string): GameDefinition | undefined {
	const name = exe.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
	return GAMES.find((g) => g.exe.toLowerCase() === name);
}
