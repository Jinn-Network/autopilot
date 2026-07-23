export interface AutopilotInstallation {
  readonly kind: 'npm-global' | 'unsupported';
  readonly packageRoot: string;
  readonly executable: string;
  readonly version: string;
}

export interface UpgradeDependencies {
  installation: AutopilotInstallation;
  readonly wasRunning: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
  readonly waitStopped: () => Promise<void>;
  readonly packCurrent: () => Promise<string>;
  readonly install: (specification: string) => Promise<void>;
  readonly migrate: () => Promise<void>;
  readonly doctor: () => Promise<void>;
  readonly start: () => Promise<void>;
}

export interface UpgradeResult {
  readonly status: 'upgraded';
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly restarted: boolean;
}

export async function upgradeAutopilot(
  requestedVersion: string | undefined,
  dependencies: UpgradeDependencies,
): Promise<UpgradeResult> {
  const targetVersion = requestedVersion ?? 'latest';
  if (dependencies.installation.kind !== 'npm-global') {
    throw new Error(
      'This installation cannot be upgraded safely in place. Run '
      + `\`npm install --global @jinn-network/autopilot@${targetVersion}\` manually.`,
    );
  }
  const wasRunning = await dependencies.wasRunning();
  if (wasRunning) {
    await dependencies.stop();
    await dependencies.waitStopped();
  }
  const rollbackTarball = await dependencies.packCurrent();
  try {
    await dependencies.install(`@jinn-network/autopilot@${targetVersion}`);
    await dependencies.migrate();
    await dependencies.doctor();
    if (wasRunning) await dependencies.start();
  } catch (error) {
    try {
      await dependencies.install(rollbackTarball);
      await dependencies.doctor();
      if (wasRunning) await dependencies.start();
    } catch (rollbackError) {
      throw new Error(
        `Upgrade failed and rollback verification also failed: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }. Rollback material remains at ${rollbackTarball}.`,
        { cause: error },
      );
    }
    throw new Error(
      `Upgrade failed and was rolled back to ${dependencies.installation.version}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  return {
    status: 'upgraded',
    fromVersion: dependencies.installation.version,
    toVersion: targetVersion,
    restarted: wasRunning,
  };
}
