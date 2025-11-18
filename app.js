/* eslint-disable global-require */
/* eslint-disable import/no-dynamic-require */
if (!process.env.__ALREADY_BOOTSTRAPPED_ENVS) require('dotenv').config();

const fs = require('fs');
const { createServer } = require('@app-core/server');
const { createConnection } = require('@app-core/mongoose');
const { createQueue } = require('@app-core/queue');

const canLogEndpointInformation = process.env.CAN_LOG_ENDPOINT_INFORMATION;

createConnection({
  uri: process.env.MONGODB_URI,
});

createQueue();

const server = createServer({
  port: process.env.PORT,
  JSONLimit: '150mb',
  enableCors: true,
});

const ENDPOINT_CONFIGS = [
  {
    path: './endpoints/onboarding/',
  },
];

// Load root level endpoints separately
const rootEndpointPath = './endpoints/';
const rootItems = fs.readdirSync(rootEndpointPath);
rootItems.forEach((item) => {
  const itemPath = `${rootEndpointPath}${item}`;
  const stat = fs.statSync(itemPath);

  // Only process .js files, skip directories and other files
  if (stat.isFile() && item.endsWith('.js') && item !== 'index.js') {
    const handler = require(itemPath);

    // Only add handlers that have proper method and path
    if (handler && handler.method && handler.path) {
      server.addHandler(handler);
    }
  }
});

function logEndpointMetaData(endpointConfigs) {
  const endpointData = [];
  const storageDirName = './endpoint-data';
  const EXEMPTED_ENDPOINTS_REGEX = /onboarding/;

  endpointConfigs.forEach((endpointConfig) => {
    const { path: basePath, options } = endpointConfig;

    const dirs = fs.readdirSync(basePath);

    dirs.forEach((file) => {
      const handler = require(`${basePath}${file}`);

      if (!EXEMPTED_ENDPOINTS_REGEX.test(basePath) && handler.middlewares?.length) {
        const entry = { method: handler.method, endpoint: handler.path };
        entry.name = file.replaceAll('-', ' ').replace('.js', '');
        entry.display_name = `can ${entry.name}`;

        if (options?.pathPrefix) {
          entry.endpoint = `${options.pathPrefix}${entry.endpoint}`;
          entry.name = `${entry.name} (${options.pathPrefix.replace('/', '')})`;
        }

        endpointData.push(entry);
      }
    });
  });

  if (!fs.existsSync(storageDirName)) {
    fs.mkdirSync(storageDirName);
  }

  fs.writeFileSync(`${storageDirName}/endpoints.json`, JSON.stringify(endpointData, null, 2), {
    encoding: 'utf-8',
  });
}

if (canLogEndpointInformation) {
  logEndpointMetaData(ENDPOINT_CONFIGS);
}

function setupEndpointHandlers(basePath, options = {}) {
  const items = fs.readdirSync(basePath);

  items.forEach((item) => {
    const itemPath = `${basePath}${item}`;
    const stat = fs.statSync(itemPath);

    // Only process .js files, skip directories and other files
    if (stat.isFile() && item.endsWith('.js')) {
      const handler = require(itemPath);

      if (options.pathPrefix) {
        handler.path = `${options.pathPrefix}${handler.path}`;
      }

      server.addHandler(handler);
    }
  });
}

ENDPOINT_CONFIGS.forEach((config) => {
  setupEndpointHandlers(config.path, config.options);
});

server.startServer();
