// Legacy call sites consume these live bindings while the configuration
// boundary is threaded through the final internal ports. The public package
// has no repository fallback: its entry point configures these bindings from
// strict repository configuration before a lifecycle operation can run.
export let ORG = process.env.AUTOPILOT_PROJECT_OWNER ?? '';
export let REPO = process.env.AUTOPILOT_REPOSITORY_SLUG ?? '';
export let REPO_REST_DATABASE_ID = Number(
  process.env.AUTOPILOT_REPOSITORY_REST_DATABASE_ID ?? '0',
);
export let PROJECT_NUMBER = Number(process.env.AUTOPILOT_PROJECT_NUMBER ?? '0');

export function configureRepositoryConstants(input: {
  readonly repositorySlug: string;
  readonly repositoryRestDatabaseId: number;
  readonly projectOwner: string;
  readonly projectNumber: number;
}): void {
  REPO = input.repositorySlug;
  REPO_REST_DATABASE_ID = input.repositoryRestDatabaseId;
  ORG = input.projectOwner;
  PROJECT_NUMBER = input.projectNumber;
}
