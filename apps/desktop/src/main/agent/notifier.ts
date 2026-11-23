// apps/desktop/src/main/agent/notifier.ts
//
// Desktop notifications for the agent (D15): libnotify on Linux, no action
// buttons, clicking one runs `onClick`.
import { Notification } from 'electron';

export interface Notifier {
  show(o: { title: string; body: string; onClick?: () => void }): { close(): void };
}

export function electronNotifier(): Notifier {
  return {
    show(o) {
      if (!Notification.isSupported()) return { close() {} };
      const n = new Notification({ title: o.title, body: o.body });
      if (o.onClick) n.on('click', o.onClick);
      n.show();
      return { close: () => { try { n.close(); } catch { /* already gone */ } } };
    },
  };
}
