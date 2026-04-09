import prettierConfig from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';
import { importX } from 'eslint-plugin-import-x';
import noRedundantContextualParameterTypes from './eslint-rules/no-redundant-contextual-parameter-types.ts';
import noSingleUsePassThroughHelper from './eslint-rules/no-single-use-pass-through-helper.ts';

const argonRules = {
  rules: {
    'no-single-use-pass-through-helper': noSingleUsePassThroughHelper,
    'no-redundant-contextual-parameter-types': noRedundantContextualParameterTypes,
  },
};

export default tseslint.config(
  tseslint.configs.recommendedTypeChecked,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  { ignores: ['**/node_modules/**', '**/lib/**/*.js', '**/target', 'e2e/scripts/**/*.mjs'] },
  {
    plugins: {
      argon: argonRules,
    },
    rules: {
      'argon/no-single-use-pass-through-helper': 'error',
      'argon/no-redundant-contextual-parameter-types': 'warn',
      'import-x/no-named-as-default-member': 'off',
      'import-x/no-named-as-default': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        {
          accessibility: 'explicit',
          overrides: {
            accessors: 'explicit',
            constructors: 'no-public',
            methods: 'explicit',
            properties: 'off',
            parameterProperties: 'explicit',
          },
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/restrict-template-expressions': [
        'warn',
        { allowNumber: true, allowBoolean: true, allowNullish: true },
      ],
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/no-floating-promises': ['error', { ignoreIIFE: true, ignoreVoid: true }],
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/consistent-type-assertions': [
        'warn',
        { assertionStyle: 'as', objectLiteralTypeAssertions: 'allow' },
      ],
      '@typescript-eslint/no-empty-function': ['warn', { allow: ['constructors', 'private-constructors'] }],
      '@typescript-eslint/no-var-requires': 'off',
      // keep the TS version, disable the base just in case
      'no-use-before-define': 'off',
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Looser in tests and scripts
  {
    files: ['**/*.test.ts', '**/__test__/**', 'scripts/**'],
    rules: {
      'argon/no-single-use-pass-through-helper': 'off',
      'argon/no-redundant-contextual-parameter-types': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'argon/no-single-use-pass-through-helper': 'off',
      'argon/no-redundant-contextual-parameter-types': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../src-vue/*', '../../src-vue/*', '../../../src-vue/*', '../../../../src-vue/*'],
              message: 'Import src-vue from e2e through the project-root src-vue/* path.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['e2e/flows/types/srcVue.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['src-vue/e2e/**/*.ts'],
    rules: {
      'argon/no-single-use-pass-through-helper': 'off',
      'argon/no-redundant-contextual-parameter-types': 'off',
    },
  },
  {
    files: ['core/src/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'error',
    },
  },
  {
    files: ['core/src/SqliteMigrations.ts', 'core/src/SqliteUtils.ts'],
    rules: {
      'import-x/no-nodejs-modules': ['error', { allow: ['node:sqlite'] }],
    },
  },
  {
    files: ['core/src/scripts/**/*.ts'],
    rules: {
      'import-x/no-nodejs-modules': 'off',
    },
  },
  {
    files: ['**/*.d.ts'],
    rules: {
      'argon/no-single-use-pass-through-helper': 'off',
      'argon/no-redundant-contextual-parameter-types': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    files: ['eslint-rules/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  prettierConfig,
);
