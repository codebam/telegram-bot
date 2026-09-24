import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';


const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');


export default defineConfig(
	{ ignores: ['worker-configuration.d.ts'] },
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommendedTypeChecked,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.worker, ...globals.node },
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
			'@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }]
		}
	}
);
