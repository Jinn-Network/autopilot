function decodeRuntimeLiteral(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

/** SDK-owned marketplace repository slug, decoded for distributable builds. */
export const JINN_MONO_REPOSITORY = decodeRuntimeLiteral('Smlubi1OZXR3b3JrL21vbm8=');

/** Task worktree parent directory used by local dispatch. */
export const JINN_MONO_WORKTREES_DIR = decodeRuntimeLiteral('amlubi1tb25vX3dvcmt0cmVlcw==');
