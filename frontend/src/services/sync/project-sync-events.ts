type MetadataSyncListener = () => void;

const listeners = new Set<MetadataSyncListener>();

/**
 * Subscribe to metadata synchronization changes. SQLite and Supabase remain
 * the sources of truth; this signal only tells active screens to refresh their
 * current workspace or entity.
 */
export const subscribeMetadataSyncChanges = (
  listener: MetadataSyncListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyMetadataSyncChanges = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One screen listener must not prevent other screens from refreshing.
    }
  }
};

// Backward-compatible aliases retained for the verified Project Sync v1 code.
export const subscribeProjectSyncChanges = subscribeMetadataSyncChanges;
export const notifyProjectSyncChanges = notifyMetadataSyncChanges;
