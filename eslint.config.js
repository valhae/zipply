import js from '@eslint/js';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Security: untrusted strings (names, filenames, errors) must only ever be rendered as text.
const RAW_HTML_SINK =
  'Raw HTML sinks are banned: render untrusted strings as React text (SECURITY_DECISIONS SD-09).';
const rawHtmlSinks = [
  { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: RAW_HTML_SINK },
  {
    selector:
      'AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]',
    message: RAW_HTML_SINK,
  },
  { selector: "CallExpression[callee.property.name='insertAdjacentHTML']", message: RAW_HTML_SINK },
  {
    selector:
      "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: RAW_HTML_SINK,
  },
];

// Runtime boundaries: browser code and Worker code never import each other; only @zipply/protocol is shared.
const crossRuntime = (forbidden, message) => ({
  'no-restricted-imports': ['error', { patterns: [{ group: forbidden, message }] }],
});

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.wrangler/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': ['error', ...rawHtmlSinks],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['*.js', '*.ts', 'apps/*/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat['recommended-latest'],
  },
  { files: ['apps/web/src/**/*.tsx'], ...jsxA11y.flatConfigs.recommended },
  {
    files: ['apps/web/**'],
    rules: crossRuntime(
      ['**/apps/signaling/**', '**/signaling/src/**', '@zipply/signaling', '@zipply/signaling/*'],
      'Browser code must not import Worker code; share via @zipply/protocol.',
    ),
  },
  {
    files: ['apps/signaling/**'],
    rules: crossRuntime(
      [
        '**/apps/web/**',
        '**/web/src/**',
        '@zipply/web',
        '@zipply/web/*',
        'react',
        'react-dom',
        'react-dom/*',
      ],
      'Worker code must not import browser code; share via @zipply/protocol.',
    ),
  },
  {
    files: ['packages/protocol/**'],
    rules: crossRuntime(
      ['**/apps/**', '@zipply/web', '@zipply/signaling', 'react', 'react-dom', 'cloudflare:*'],
      '@zipply/protocol must stay runtime-neutral (no app, React or Workers imports).',
    ),
  },
);
