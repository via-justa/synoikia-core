import { EventEmitter } from 'node:events';

/** In-process event bus (design §9.1) for notifiers and admin SSE; payloads never carry params or secrets. */
export interface CoreEventMap {
  'instance.status': [{ instanceId: string; slug: string; status: string; error?: string }];
  'plugin.crashed': [{ instanceId: string; slug: string; error: string }];
  'sync.completed': [
    {
      instanceId: string;
      slug: string;
      added: number;
      pendingReview: string[];
      newGroups: string[];
      rulesDisabled?: number;
    },
  ];
  'sync.failed': [{ instanceId: string; slug: string; error: string }];
  'auth.lockout': [{ username: string; ip?: string; surface?: 'admin' | 'mcp' }];
}

export type CoreEventName = keyof CoreEventMap;

export const CORE_EVENT_NAMES: CoreEventName[] = [
  'instance.status',
  'plugin.crashed',
  'sync.completed',
  'sync.failed',
  'auth.lockout',
];

export class CoreEvents extends EventEmitter<CoreEventMap> {
  constructor() {
    super();
    // Several subscribers (notifier channels, SSE clients) is normal; don't warn at 10.
    this.setMaxListeners(0);
  }
}
