import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
	globalIgnores(['dist/', 'coverage/']),
	js.configs.recommended,
	tseslint.configs.recommended,
	{ languageOptions: { globals: globals.node } },
	{
		// Default exports interact badly with mixed ESM/CJS consumers
		name: 'no default exports in source',
		files: ['src/**'],
		rules: {
			'no-restricted-exports': [
				'error',
				{
					restrictDefaultExports: {
						direct: true,
						named: true,
						defaultFrom: true,
						namedFrom: true,
						namespaceFrom: true,
					},
				},
			],
		},
	},
])
