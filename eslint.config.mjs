import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaryConfigs from './eslint.boundaries.mjs';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.d.mts',
      '.changeset/**',
      'openspec/**',
      '**/drizzle.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Leading underscore marks an intentional discard (e.g. destructure-to-omit).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  ...boundaryConfigs,
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        module: 'writable',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
  {
    // Tests exercise dynamic HTTP response bodies and DB query rows that are
    // untyped by nature; the type-checked "no-unsafe-*" family is noise here
    // (production source keeps them). `preserve-caught-error` is likewise not
    // worth threading a cause through throwaway test scaffolding.
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
);
