import WorkerFramework from './WorkerFramework.mjs';
import { eventBus, registry } from '../registry.mjs';

WorkerFramework.Init();

const { Con } = registry;

eventBus.subscribe('worker.test', (message) => {
  if (message) {
    Con.Print(`Reading back: ${message}\n`);
  }

  Con.Print('Dummy Worker reporting back!\n');
});
