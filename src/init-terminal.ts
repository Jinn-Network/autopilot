import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Writable as WritableStream } from 'node:stream';
import type {
  InitializationInteractor,
  InitializationProjectChoice,
} from './init.js';

class SecretAwareOutput extends WritableStream {
  muted = false;

  constructor(private readonly destination: Writable) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) this.destination.write(chunk, encoding);
    callback();
  }
}

export interface TerminalInitializationInteraction {
  readonly interactor: InitializationInteractor;
  close(): void;
}

export function createTerminalInitializationInteraction(input: {
  readonly input: Readable;
  readonly output: Writable;
}): TerminalInitializationInteraction {
  const secretOutput = new SecretAwareOutput(input.output);
  const terminal = 'isTTY' in input.input && input.input.isTTY === true;
  const readline = createInterface({
    input: input.input,
    output: secretOutput,
    terminal,
  });

  const askSecret = async (prompt: string): Promise<string> => {
    if (!terminal) {
      throw new Error(
        'Hidden credential input requires a terminal; use AUTOPILOT_GITHUB_*_TOKEN',
      );
    }
    input.output.write(prompt);
    secretOutput.muted = true;
    try {
      return (await readline.question('')).trim();
    } finally {
      secretOutput.muted = false;
      input.output.write('\n');
    }
  };

  const interactor: InitializationInteractor = {
    chooseProject: async (request): Promise<InitializationProjectChoice> => {
      const candidates = request.linked.length > 0
        ? request.linked
        : request.available;
      input.output.write(`\nProjects for ${request.repository}:\n`);
      for (const [index, project] of candidates.entries()) {
        const linked = request.linked.some((entry) => entry.id === project.id)
          ? ' (linked)'
          : '';
        input.output.write(
          `  ${index + 1}. ${project.title} (#${project.number})${linked}\n`,
        );
      }
      input.output.write(`  ${candidates.length + 1}. Create a new Project\n`);
      for (;;) {
        const answer = (await readline.question('Select a Project: ')).trim();
        const selected = Number(answer);
        if (
          Number.isSafeInteger(selected)
          && selected >= 1
          && selected <= candidates.length
        ) {
          const project = candidates[selected - 1]!;
          return {
            kind: 'existing',
            owner: project.owner,
            number: project.number,
          };
        }
        if (selected === candidates.length + 1) {
          const repositoryName = request.repository.split('/')[1] ?? 'Repository';
          const answerTitle = (await readline.question(
            `Project title [${repositoryName} Autopilot]: `,
          )).trim();
          return {
            kind: 'create',
            title: answerTitle === '' ? `${repositoryName} Autopilot` : answerTitle,
          };
        }
        input.output.write('Enter one of the listed numbers.\n');
      }
    },
    confirm: async (plan) => {
      input.output.write(
        `\nProposed changes for ${plan.repository} (${plan.project}):\n`,
      );
      for (const change of plan.changes) input.output.write(`  - ${change}\n`);
      const answer = (await readline.question('Apply these changes? [y/N] ')).trim();
      return answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes';
    },
    readCredentials: async () => {
      const implementationToken = await askSecret(
        'Implementation GitHub token (required): ',
      );
      if (implementationToken === '') {
        throw new Error('An implementation GitHub token is required');
      }
      const reviewToken = await askSecret(
        'Independent review GitHub token (optional; press Enter to skip): ',
      );
      return {
        implementationToken,
        ...(reviewToken === '' ? {} : { reviewToken }),
      };
    },
  };

  return {
    interactor,
    close: () => readline.close(),
  };
}
