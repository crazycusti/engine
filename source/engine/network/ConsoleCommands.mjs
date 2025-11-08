import { ConsoleCommand } from '../common/Cmd.mjs';
import { eventBus, registry } from '../registry.mjs';

let { NET, Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  NET = registry.NET;
  Con = registry.Con;
});

export class InviteCommand extends ConsoleCommand {
  run() {
    const listenAddress = NET.GetListenAddress();

    if (!listenAddress) {
      Con.PrintWarning('Cannot create invite link, not hosting.\n');
      return;
    }

    const shareLink = new URL(location.href);
    shareLink.searchParams.set('connect', listenAddress);
    shareLink.searchParams.delete('exec');

    // poor man’s share intent
    prompt('Share this link to invite players:', shareLink.toString());
  }
};
