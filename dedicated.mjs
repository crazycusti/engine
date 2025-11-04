#!/usr/bin/env node
import process from 'node:process';
import EngineLauncher from './source/engine/main-dedicated.mjs';

// make sure working directory is the directory of this script
process.chdir(new URL('./', import.meta.url).pathname);

await EngineLauncher.Launch();
