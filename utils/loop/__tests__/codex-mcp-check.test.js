import { checkReviewMcp, reviewMcpIsEmpty } from '../codex-mcp-check.js';

/** @param {string} type @param {object} config */
const layer = (type, config) => ({ name: { type }, config });

/** @param {ReturnType<typeof layer>[]} layers */
const response = (layers) => ({
  config: { features: { apps: false, plugins: false } },
  layers,
});

const user = layer('user', { mcp_servers: { fixture: { enabled: false } } });
const managed = layer('enterpriseManaged', { mcp_servers: { fixture: {} } });
const system = layer('system', {});

test('should honor non-user layer precedence for a disabled managed server', () => {
  const disabled = layer('legacyManagedConfigTomlFromFile', {
    mcp_servers: { fixture: { enabled: false } },
  });

  expect(reviewMcpIsEmpty(response([disabled, user, managed, system]))).toBe(
    true
  );
});

test('should refuse a project-level override that masks active managed MCP in the probe', () => {
  const project = {
    ...layer('project', { mcp_servers: { fixture: { enabled: false } } }),
    disabledReason: 'The project is untrusted.',
  };

  expect(reviewMcpIsEmpty(response([project, user, managed, system]))).toBe(
    false
  );
});

test('should refuse a user layer that changes the cloud policy bootstrap identity', () => {
  const customAuth = layer('user', { cli_auth_credentials_store: 'keyring' });

  expect(reviewMcpIsEmpty(response([customAuth, system]))).toBe(false);
});

test('should refuse to verify MCP when integrations are forced on', () => {
  const config = response([user, system]);
  config.config.features.plugins = true;

  expect(reviewMcpIsEmpty(config)).toBe(false);
});

test('should reject a config reply without layer information', () => {
  expect(reviewMcpIsEmpty({ config: { mcp_servers: {} } })).toBe(false);
});

// Serve the same stdio handshake as Codex, with no model or MCP process.
const fakeAppServer = `
  import { createInterface } from 'node:readline';
  const { config, requirements } = JSON.parse(process.argv[1]);
  let initialized = false;
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.method === 'initialize') {
      console.log(JSON.stringify({ id: request.id, result: {} }));
    } else if (request.method === 'initialized') {
      initialized = true;
    } else if (initialized && request.method === 'config/read' &&
               request.params.includeLayers && request.params.cwd === process.cwd()) {
      console.log(JSON.stringify({ id: request.id, result: config }));
    } else if (initialized && request.method === 'configRequirements/read') {
      console.log(JSON.stringify({ id: request.id, result: { requirements } }));
    } else {
      process.exitCode = 1;
      break;
    }
  }
`;

test.each([
  ['user-only configuration', response([user, system]), null, true],
  [
    'managed MCP with the same name',
    response([user, managed, system]),
    null,
    false,
  ],
  [
    'managed Apps requirements',
    response([user, system]),
    { featureRequirements: { apps: true } },
    false,
  ],
  [
    'managed Plugins requirements',
    response([user, system]),
    { featureRequirements: { plugins: true } },
    false,
  ],
])(
  'should guard review dispatch for %s',
  async (_label, config, requirements, expected) => {
    const argv = [
      '--input-type=module',
      '-e',
      fakeAppServer,
      JSON.stringify({ config, requirements }),
    ];

    expect(await checkReviewMcp(process.execPath, argv, 2000)).toBe(expected);
  }
);
