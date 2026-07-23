import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    env: {
      AUTOPILOT_REPOSITORY_SLUG: 'Jinn-Network/mono',
      AUTOPILOT_REPOSITORY_URL: 'https://github.com/Jinn-Network/mono.git',
      AUTOPILOT_REPOSITORY_REST_DATABASE_ID: '1190804373',
      AUTOPILOT_PROJECT_OWNER: 'Jinn-Network',
      AUTOPILOT_PROJECT_NUMBER: '1',
    },
  },
});
