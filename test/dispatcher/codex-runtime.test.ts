import { describe, expect, it } from 'vitest';
import {
  assertCodexRuntimeReady,
  codexExecArgs,
  codexReasoningEffort,
  CODEX_BIN_ENV,
} from '../../src/dispatcher/codex-runtime.js';

describe('codex runtime (#152)', () => {
  it.each([
    ['Low', 'low'],
    ['Medium', 'medium'],
    ['High', 'high'],
    ['XHigh', 'xhigh'],
    ['Max', 'xhigh'],
  ] as const)('maps board effort %s to reasoning effort %s', (effort, expected) => {
    expect(codexReasoningEffort(effort)).toBe(expected);
  });

  it('leaves reasoning effort to Codex when the board carries none', () => {
    expect(codexReasoningEffort(null)).toBeNull();
  });

  it('launches an unattended exec in the worktree with the prompt last', () => {
    const args = codexExecArgs('PROMPT', { effort: 'High', workspace: '/wt' });
    expect(args[0]).toBe('exec');
    expect(args[args.indexOf('-C') + 1]).toBe('/wt');
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args[args.indexOf('-c') + 1]).toBe('model_reasoning_effort=high');
    expect(args).not.toContain('-m');
    expect(args.at(-1)).toBe('PROMPT');
  });

  it('passes the model only when configured, and no reasoning without effort', () => {
    const args = codexExecArgs('P', { model: 'gpt-5.6-sol', effort: null, workspace: '/wt' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.6-sol');
    expect(args).not.toContain('-c');
  });

  it('accepts a binary whose version probe succeeds', () => {
    expect(() => assertCodexRuntimeReady('codex', { probe: () => ({ status: 0 }) }))
      .not.toThrow();
  });

  it('names a missing binary and the variable that points at it', () => {
    expect(() => assertCodexRuntimeReady('/nope/codex', { exists: () => false }))
      .toThrow(new RegExp(CODEX_BIN_ENV));
  });

  it('reports the last line of a failing probe and how to fix it', () => {
    expect(() => assertCodexRuntimeReady('codex', {
      probe: () => ({ status: 1, stderr: 'boom\nnot logged in' }),
    })).toThrow(/not logged in.*codex login/s);
  });
});
