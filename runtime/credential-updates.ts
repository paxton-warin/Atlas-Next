export type CredentialUpdate = { ticket: string; ticketExpiresAt: number };

// Transport initialization mutates the shipped engine's connector. Serialize
// the entire initialization/swap, not just the final assignment, so an older
// response cannot finish after a newer credential. Superseded queued work is
// discarded; failures leave the last working credential retryable.
export function orderedCredentialUpdates<T extends CredentialUpdate>(
  initial: CredentialUpdate,
  apply: (value: T) => Promise<void>,
) {
  let committed = initial;
  let newest = initial;
  let tail = Promise.resolve();
  return (value: T): Promise<boolean> => {
    if (
      !Number.isFinite(value.ticketExpiresAt) ||
      value.ticketExpiresAt <= 0 ||
      value.ticketExpiresAt < newest.ticketExpiresAt ||
      (value.ticketExpiresAt === newest.ticketExpiresAt &&
        value.ticket !== newest.ticket)
    )
      return Promise.resolve(false);
    newest = value;
    const work = tail.then(async () => {
      if (value.ticket !== newest.ticket) return false;
      if (value.ticket === committed.ticket) return true;
      try {
        await apply(value);
        committed = value;
        return true;
      } catch (error) {
        if (newest === value) newest = committed;
        throw error;
      }
    });
    tail = work.then(
      () => {},
      () => {},
    );
    return work;
  };
}
