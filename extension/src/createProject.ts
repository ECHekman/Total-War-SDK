import * as fs from 'node:fs';
import * as path from 'node:path';

/** Name used throughout the example project; replaced by the new mod's name. */
export const TEMPLATE_MOD_NAME = 'example_mod';
/** Executable path used in the example project; replaced by the detected one. */
export const TEMPLATE_EXECUTABLE = 'C:/Program Files (x86)/Steam/steamapps/common/Total War WARHAMMER III/Warhammer3.exe';

export function isValidModName(name: string): boolean {
	return /^[A-Za-z0-9_]+$/.test(name);
}

/**
 * Copies the example project to `targetDir`, renaming files and text from
 * `example_mod` to `modName` and pointing it at `executable`.
 * Returns the path of the created workspace file.
 */
export function createProjectFiles(templateDir: string, targetDir: string, modName: string, executable: string): string {
	if (!isValidModName(modName)) {
		throw new Error(`"${modName}" is not a valid mod name: use letters, digits and underscores.`);
	}
	if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
		throw new Error(`${targetDir} already exists and is not empty.`);
	}
	const exe = executable.replace(/\\/g, '/');

	const copy = (from: string, to: string): void => {
		fs.mkdirSync(to, { recursive: true });
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			const src = path.join(from, entry.name);
			const dst = path.join(to, entry.name.split(TEMPLATE_MOD_NAME).join(modName));
			if (entry.isDirectory()) {
				copy(src, dst);
			} else {
				const text = fs.readFileSync(src, 'utf8')
					.split(TEMPLATE_MOD_NAME).join(modName)
					.split(TEMPLATE_EXECUTABLE).join(exe);
				fs.writeFileSync(dst, text);
			}
		}
	};
	copy(templateDir, targetDir);
	return path.join(targetDir, `${modName}.code-workspace`);
}
