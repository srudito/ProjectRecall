type TranscriptionSyncListener = () => void;

const listeners = new Set<TranscriptionSyncListener>();

export const subscribeTranscriptionSyncChanges = (
  listener: TranscriptionSyncListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const notifyTranscriptionSyncChanges = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One screen listener must not prevent other screens from refreshing.
    }
  }
};
