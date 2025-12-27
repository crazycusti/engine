import { ConsoleCommand } from '../common/Cmd.mjs';
import { eventBus, registry } from '../registry.mjs';

let { NET, Con } = registry;

eventBus.subscribe('registry.frozen', () => {
  NET = registry.NET;
  Con = registry.Con;
});

export class InviteCommand extends ConsoleCommand {
  async run() {
    const listenAddress = NET.GetListenAddress();

    if (!listenAddress) {
      Con.PrintWarning('Cannot create invite link, not hosting.\n');
      return;
    }

    const shareLink = new URL(location.href);
    shareLink.searchParams.set('connect', listenAddress);
    shareLink.searchParams.delete('exec');

    try {
      await navigator.clipboard.writeText(shareLink.toString());
      Con.Print(`This link has been copied to your clipboard:\n${shareLink.toString()}\n`);
    // eslint-disable-next-line no-unused-vars
    } catch (err) {
      prompt('Share this link to invite players:', shareLink.toString());
    }
  }
};
