import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'vitest.config.ts'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	// Test files and stubs run in Node via Vitest — Obsidian-specific rules don't apply.
	{
		files: ['src/__tests__/**'],
		rules: {
			'obsidianmd/prefer-active-doc':    'off',
			'obsidianmd/prefer-window-timers': 'off',
			'obsidianmd/no-forbidden-elements': 'off',
			'obsidianmd/prefer-create-el':      'off',
		},
	},
	// URLs aren't prose — sentence-case's heuristics otherwise want the
	// scheme capitalized (e.g. "HTTPS://..."). Month names are proper nouns
	// (used as example text in the log month-format setting) and must stay
	// capitalized too.
	{
		rules: {
			'obsidianmd/ui/sentence-case': ['warn', {
				enforceCamelCaseLower: true,
				ignoreRegex: ['^\\w+:\\/\\/'],
				ignoreWords: ['July', 'Jul'],
			}],
		},
	},
);
