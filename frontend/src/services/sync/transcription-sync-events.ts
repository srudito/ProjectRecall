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


type TranscriptionRequestSubmittedListener = () => void;
const requestSubmittedListeners = new Set<TranscriptionRequestSubmittedListener>();

export const subscribeTranscriptionRequestSubmissions = (
  listener: TranscriptionRequestSubmittedListener,
): (() => void) => {
  requestSubmittedListeners.add(listener);
  return () => {
    requestSubmittedListeners.delete(listener);
  };
};

export const notifyTranscriptionRequestSubmitted = (): void => {
  for (const listener of requestSubmittedListeners) {
    try {
      listener();
    } catch {
      // Background result wake-up must not block request completion/UI updates.
    }
  }
};
