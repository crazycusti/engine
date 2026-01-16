import Cmd from '../../common/Cmd.mjs';
import { eventBus, registry } from '../../registry.mjs';
import { Action, Label, Spacer } from './MenuItem.mjs';
import { MenuPage, VerticalLayout } from './MenuPage.mjs';

let { M, PR } = registry;

eventBus.subscribe('registry.frozen', () => {
  ({ M, PR } = registry);
});

// Menu (not connected)
// - player profile
// - list of servers
// - create game

// Menu (connected)
// - player profile
// - invite others
// - disconnect

// Menu: create game
// - coop / deathmatch
// - map selection
// - start game

export default class MultiplayerMainMenu extends MenuPage {
  // eslint-disable-next-line @typescript-eslint/require-await
  async init() {
    // M.m_multi is arriving later
    this.titlePic = M.p_multi;

    // const serverFields = PR.QuakeJS.ServerGameAPI.GetServerInfoFields();
    // const mapList = PR.QuakeJS.ServerGameAPI.GetMapList();

    // TODO: add server fields
    // for (const serverField of serverFields) {
    // }

    this.items.push(new Label({ label: 'Start Game:' }));

    // for (const map of mapList) {
    //   const action = new Action({
    //     label: map.label,
    //     action() {
    //       M.CloseMenu();

    //       ClientLifecycle.startGame.startMultiplayerGame(map.name);
    //     },
    //   });
    //   this.items.push(action);
    // }

    this.items.push(new Action({
      label: 'Start deathmatch',
      action() {
        M.CloseMenu();
        Cmd.ExecuteString('exec dm.cfg');
      },
    }));

    this.items.push(new Action({
      label: 'Start co-op game',
      action() {
        M.CloseMenu();
        Cmd.ExecuteString('exec coop.cfg');
      },
    }));

    this.items.push(new Spacer());

    if (registry.urlFns.signalingURL) {
      this.items.push(new Label({ label: 'Join Game:' }));

      this.items.push(new Action({
        label: 'Find Servers',
        action() {
          const url = new URL(registry.urlFns.signalingURL());
          url.pathname = '/';
          window.open(url, '_blank');
        },
      }));
    }
  }

  constructor() {
    const layout = new VerticalLayout({
      startY: 40,
      spacing: 8,
      labelX: 48,
      valueX: 220,
      cursorX: 32,
    });

    super({
      layout,
    });
  }
};
