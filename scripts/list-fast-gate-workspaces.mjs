import { MANDATORY_FAST_TEST_WORKSPACES } from './fast-gate-workspace-policy.mjs';

process.stdout.write(`${MANDATORY_FAST_TEST_WORKSPACES.join('\n')}\n`);
