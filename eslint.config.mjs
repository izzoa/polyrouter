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
          // `aria-modal` asserts that the rest of the page is hidden from assistive tech.
          // Writing it by hand is how two BodyCaptureCard dialogs came to claim it with no
          // focus trap, no Escape and no focus restore — the attributes without any of the
          // behaviour. `useModalSurface` supplies the attributes and the layer registration
          // together, so the two cannot come apart.
          'modal-surface-only': {
            meta: {
              type: 'problem',
              schema: [],
              messages: {
                raw: 'Raw `aria-modal` — use `useModalSurface()` and spread its props, so the registration and focus trap come with it.',
              },
            },
            create(context) {
              return {
                JSXAttribute(node) {
                  if (String(node.name.name) !== 'aria-modal') return;
                  context.report({ node, messageId: 'raw' });
                },
              };
            },
          },
          // An inline style beats any class on the properties it declares, so a media or
          // container query aimed at them parses, matches, and silently does nothing. That
          // trap has caught this project seven times — most recently on the two confirmation
          // dialogs, whose geometry sat in an object-form `style={{…}}` that an earlier
          // sweep missed because it only searched the string form.
          //
          // Scope covers registered overlay roots AND the sheet-layout descendants: the
          // drawer's header and body are not registered surfaces, so a rule watching only
          // roots would miss inline padding returning there.
          'no-inline-sheet-geometry': {
            meta: {
              type: 'problem',
              schema: [],
              messages: {
                inline:
                  'Inline `{{prop}}` on .{{cls}} — responsive CSS owns this surface’s geometry, and an inline style would silently outrank it. Move it to the class; keep only `z-index` inline.',
              },
            },
            create(context) {
              // Surfaces whose geometry responsive CSS owns.
              const GUARDED = new Set([
                'drawer',
                'drawer-head',
                'drawer-body',
                'modal-card',
                'modal-backdrop',
                'confirm-card',
                'overlay',
                'toast',
              ]);
              // `.mp-panel` is deliberately NOT guarded: the picker computes its position
              // at runtime against the viewport, so JS owns that geometry, not CSS. The
              // rule exists to catch inline styles that shadow a stylesheet rule — not to
              // ban runtime positioning that has nowhere else to live.
              // Everything that decides where a sheet is and how big. `z-index` is
              // deliberately absent: it is derived per-render from the layer registry and
              // has to be inline.
              const GEOMETRY =
                /^(position|top|right|bottom|left|inset(-\w+)?|width|height|(max|min)-(width|height)|transform|padding(-\w+)?|margin(-\w+)?|border-radius)$/;

              const classesOf = (opening) => {
                const attr = opening.attributes.find(
                  (a) => a.type === 'JSXAttribute' && String(a.name.name) === 'class',
                );
                if (!attr?.value) return [];
                if (attr.value.type === 'Literal') return String(attr.value.value).split(/\s+/);
                // Template/expression class lists: read the literal chunks, which is where
                // a guarded class name would appear.
                const src = context.sourceCode.getText(attr.value);
                return src.split(/[^\w-]+/);
              };

              const report = (node, prop, cls) =>
                context.report({ node, messageId: 'inline', data: { prop, cls } });

              return {
                JSXOpeningElement(node) {
                  const cls = classesOf(node).find((c) => GUARDED.has(c));
                  if (!cls) return;
                  const style = node.attributes.find(
                    (a) => a.type === 'JSXAttribute' && String(a.name.name) === 'style',
                  );
                  if (!style?.value) return;

                  // String form: style="position:fixed;padding:16px 20px"
                  if (style.value.type === 'Literal') {
                    for (const decl of String(style.value.value).split(';')) {
                      const prop = decl.split(':')[0]?.trim();
                      if (prop && GEOMETRY.test(prop)) report(style, prop, cls);
                    }
                    return;
                  }
                  // Object form: style={{ position: 'fixed', 'max-width': '440px' }}
                  const expr = style.value.expression;
                  if (expr?.type !== 'ObjectExpression') return;
                  for (const p of expr.properties) {
                    if (p.type !== 'Property') continue;
                    const prop =
                      p.key.type === 'Literal' ? String(p.key.value) : String(p.key.name ?? '');
                    if (GEOMETRY.test(prop)) report(p, prop, cls);
                  }
                },
              };
            },
          },
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
      'a11y-guard/modal-surface-only': 'error',
      'a11y-guard/no-inline-sheet-geometry': 'error',
      'a11y-guard/no-noninteractive-click': 'error',
      'a11y-guard/label-association': 'error',
    },
  },
);
