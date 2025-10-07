import WorkerFramework from './WorkerFramework.mjs';
import { eventBus, registry } from '../registry.mjs';

import { Navigation, NavMeshOutOfDateException } from './Navigation.mjs';
import Vector from '../../shared/Vector.mjs';
import Mod, { BrushModel } from '../common/Mod.mjs';

WorkerFramework.Init();

const { Con } = registry;

const navigation = new Navigation();

eventBus.subscribe('nav.load', async (mapname) => {
  // we need the world model for checking checksums
  // NOTE: we cannot use SV’s worldmodel, neither can we generate the navmesh over here yet.
  navigation.worldmodel = /** @type {BrushModel} */ (await Mod.ForNameAsync(`maps/${mapname}.bsp`));

  Con.Print('Navigation: loading navigation graph...\n');

  try {
    await navigation.load(mapname);

    Con.Print('Navigation: navigation graph loaded on worker thread!\n');
  } catch (e) {
    // unusable navmesh, trigger a rebuild
    if (e instanceof NavMeshOutOfDateException) {
      WorkerFramework.Publish('nav.build');
    }
  }
});

eventBus.subscribe('nav.path.request', (id, start, end) => {
  const path = navigation.findPath(new Vector(...start), new Vector(...end));

  WorkerFramework.Publish('nav.path.response', id, path);
});

