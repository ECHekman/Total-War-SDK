import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/**', 'out-test/**', 'native/**', '**/*.d.ts'] },
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			curly: 'warn',
			eqeqeq: 'warn',
			'no-throw-literal': 'warn',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
		},
	},
);
