#!/usr/bin/env node
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EngineLauncher from './source/engine/main-dedicated.mjs';

// When running from dist/dedicated.mjs, use repository root as cwd.
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = scriptDir.endsWith('/dist') ? resolve(scriptDir, '..') : scriptDir;
process.chdir(rootDir);

await EngineLauncher.Launch();
