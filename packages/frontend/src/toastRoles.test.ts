/**
 * A failure never travels the confirmation path (adopt-design-tokens-v2 task 10.2, design.md
 * D13; dashboard-core "A failure still reported by toast is an alert").
 *
 * The toast has two always-mounted regions: a polite `role="status"` region for
 * confirmations, cleared after 4s, and a `role="alert"` region for failures, cleared after 8s.
 * `say()` is the confirmation path and `sayFailure()` the failure path. Before this change one
 * `say()` carried both, so about twenty failures — every `say(err(e))` catch site, the
 * clipboard failure, `Connection failed — …`, `Sync failed — …` — were announced politely as
 * confirmations and gone in under two seconds.
 *
 * This guard reads every source under `src` (tests excepted) through the TypeScript AST and
 * fails any `say(…)` call — bare or as a member, `app.say(…)` — whose message reads as a
 * failure: it contains `err(`, `failed`, `Couldn’t` / `Couldn't` / `Could not`, or `Max ` (a
 * refused action). The argument is read branch by branch: a ternary's condition is not a
 * message, but each of its two results is, so a ternary that mixes a confirmation with a
 * failure fails, and a condition that merely mentions `failed` does not. Each site is named by
 * its file and line.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = import.meta.dirname;

/** The words that mark a message as a failure (design.md D13). Case-sensitive, as written. */
export const FAILURE_MARKERS: readonly string[] = [
  'err(',
  'failed',
  'Couldn’t',
  "Couldn't",
  'Could not',
  'Max ',
];

export interface FailureSite {
  file: string;
  line: number;
  /** The message branch that reads as a failure, as written in the source. */
  message: string;
  marker: string;
}

/** The message branches of one `say(…)` argument: a ternary yields each result (never its
 * condition), parentheses are looked through, and anything else is one message. */
function messageBranches(node: ts.Expression): ts.Expression[] {
  if (ts.isParenthesizedExpression(node)) return messageBranches(node.expression);
  if (ts.isConditionalExpression(node))
    return [...messageBranches(node.whenTrue), ...messageBranches(node.whenFalse)];
  return [node];
}

/** True for `say(…)` and `<anything>.say(…)` — never `sayFailure(…)`. */
function isSay(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'say';
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text === 'say';
  return false;
}

/** Every `say(…)` message branch in one source that reads as a failure. */
export function failureSites(file: string, source: string): FailureSite[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const out: FailureSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSay(node)) {
      const arg = node.arguments[0];
      if (arg !== undefined) {
        for (const branch of messageBranches(arg)) {
          const text = branch.getText(sf);
          // The marker that occurs first in the message names it.
          const marker = FAILURE_MARKERS.map((m) => ({ m, at: text.indexOf(m) }))
            .filter((x) => x.at >= 0)
            .sort((a, b) => a.at - b.at)[0]?.m;
          if (marker !== undefined) {
            out.push({
              file,
              line: sf.getLineAndCharacterOfPosition(branch.getStart(sf)).line + 1,
              message: text.replace(/\s+/g, ' '),
              marker,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Every application source under `src`: `.ts` and `.tsx`, tests excepted (a test may say
 * a failure on purpose, as this one's own probes do). */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
        out.push(p);
    }
  };
  walk(SRC);
  return out.sort();
}

const describeSite = (s: FailureSite): string =>
  `${s.file}:${String(s.line)} say(${s.message}) — "${s.marker}" reads as a failure; use sayFailure()`;

describe('a failure is never sent through the confirmation toast (D13)', () => {
  it('no say(…) message, read branch by branch, reads as a failure', () => {
    const sites = sourceFiles().flatMap((p) =>
      failureSites(relative(SRC, p), readFileSync(p, 'utf8')),
    );
    expect(sites.map(describeSite)).toEqual([]);
  });

  it('reads the store, where every toast is raised', () => {
    // Non-vacuity: the walk reaches the file that holds `say` and `sayFailure`, and that file
    // really does raise confirmations through `say(` — so an empty result above is a reading,
    // not a walk that found nothing.
    const files = sourceFiles().map((p) => relative(SRC, p));
    expect(files).toContain(join('state', 'appState.ts'));
    const store = readFileSync(join(SRC, 'state', 'appState.ts'), 'utf8');
    expect(store.match(/\bsay\(/g)?.length ?? 0, 'say( calls in the store').toBeGreaterThan(20);
    expect(/\bsayFailure\(/.test(store), 'the store has a sayFailure( path').toBe(true);
  });
});

describe('the guard reads what it claims to (self-check)', () => {
  const probe = (src: string): string[] =>
    failureSites('probe.ts', src).map((s) => `${String(s.line)}:${s.marker}`);

  it('names each failure marker, on its line', () => {
    expect(
      probe(
        [
          'say(err(e));',
          'say(`Sync failed — ${m}`);',
          'say(`Couldn’t remove ${n}: ${err(e)}`);',
          'say("Couldn\'t load");',
          "app.say('Could not reach it');",
          'say(`Max ${String(n)} models per tier`);',
        ].join('\n'),
      ),
    ).toEqual(['1:err(', '2:failed', '3:Couldn’t', "4:Couldn't", '5:Could not', '6:Max ']);
  });

  it('reads a ternary branch by branch, never its condition', () => {
    // A mixed ternary fails on its failure branch only.
    expect(probe("say(r.ok ? 'Connection ok' : `Connection failed — ${r.message}`);")).toEqual([
      '1:failed',
    ]);
    // A condition that mentions `failed` is not a message.
    expect(probe("say(failed === null ? 'Band cleared' : 'Duplicates removed');")).toEqual([]);
    // Nested and parenthesised branches are reached.
    expect(probe("say(a ? 'Saved' : (b ? 'Created' : err(e)));")).toEqual(['1:err(']);
  });

  it('leaves the failure path and confirmations alone', () => {
    expect(
      probe(
        [
          'sayFailure(err(e));',
          "sayFailure('Copy failed — select the text manually');",
          "say('Copied');",
          'say(`Agent ${a.name} deleted`);',
          "if (failed === null && verified) say('Band cleared');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
