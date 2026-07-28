type ProjectSyncListener = () => void;

const listeners = new Set<ProjectSyncListener>();

/**
 * Subscribe to project synchronization changes. This is intentionally a tiny
 * in-process signal rather than a second state store: SQLite and Supabase remain
 * the sources of truth, and screens simply refresh their current workspace.
 */
export const subscribeProjectSyncChanges = (
  listener: ProjectSyncListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyProjectSyncChanges = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One screen listener must not prevent other screens from refreshing.
    }
  }
};
