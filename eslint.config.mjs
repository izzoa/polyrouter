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
      // design-sync (claude.ai/design) staged scaffolding + previews are not
      // part of the app's tsconfig project service — don't type-lint them.
      '.design-sync/**',
      '.ds-sync/**',
      'ds-bundle/**',
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
  {
    // Dashboard a11y guard (dashboard-core spec: controls are semantic & labeled).
    // Local rules instead of eslint-plugin-jsx-a11y, whose peer range stops at eslint 9.
    files: ['packages/frontend/src/**/*.tsx'],
    plugins: {
      'a11y-guard': {
        rules: {
          'no-noninteractive-click': {
            meta: {
              type: 'problem',
              schema: [],
              messages: {
                click:
                  'onClick on a non-interactive <{{name}}> — use <button type="button"> (or disable with a justification for pointer-only redundancy).',
              },
            },
            create(context) {
              const NONINTERACTIVE = new Set([
                'div',
                'span',
                'li',
                'tr',
                'td',
                'th',
                'p',
                'section',
                'article',
                'header',
                'footer',
                'main',
                'aside',
                'nav',
                'ul',
                'ol',
                'img',
                'svg',
              ]);
              const ACTIVATION = new Set(['onClick', 'onKeyDown', 'onKeyUp', 'onKeyPress']);
              return {
                JSXOpeningElement(node) {
                  const name = node.name.type === 'JSXIdentifier' ? node.name.name : null;
                  if (name === null) return;
                  const isBareAnchor =
                    name === 'a' &&
                    !node.attributes.some(
                      (a) => a.type === 'JSXAttribute' && a.name.name === 'href',
                    );
                  if (!NONINTERACTIVE.has(name) && !isBareAnchor) return;
                  const clicky = node.attributes.some(
                    (a) => a.type === 'JSXAttribute' && ACTIVATION.has(String(a.name.name)),
                  );
                  if (clicky) context.report({ node, messageId: 'click', data: { name } });
                },
              };
            },
          },
          'label-association': {
            meta: {
              type: 'problem',
              schema: [],
              messages: {
                orphan:
                  '<label> without `for` and without a nested control — associate it so the field is named.',
              },
            },
            create(context) {
              // Exact allowlist of components known to render a labelable control.
              const CONTROL_COMPONENTS = new Set(['HarnessSelect']);
              const containsControl = (node) => {
                if (node.type === 'JSXElement') {
                  const n = node.openingElement.name;
                  if (
                    n.type === 'JSXIdentifier' &&
                    (n.name === 'input' ||
                      n.name === 'select' ||
                      n.name === 'textarea' ||
                      CONTROL_COMPONENTS.has(n.name))
                  ) {
                    return true;
                  }
                }
                const kids = node.children ?? [];
                return kids.some((c) => containsControl(c));
              };
              return {
                JSXElement(node) {
                  const n = node.openingElement.name;
                  if (n.type !== 'JSXIdentifier' || n.name !== 'label') return;
                  const hasFor = node.openingElement.attributes.some(
                    (a) => a.type === 'JSXAttribute' && a.name.name === 'for',
                  );
                  if (!hasFor && !containsControl(node)) {
                    context.report({ node: node.openingElement, messageId: 'orphan' });
                  }
                },
              };
            },
          },
        },
      },
    },
    rules: {
      'a11y-guard/no-noninteractive-click': 'error',
      'a11y-guard/label-association': 'error',
    },
  },
);
