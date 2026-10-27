const locks = new Map<string, Promise<void>>();

export async function withTaskIntegrationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  const previous = locks.get(taskId) ?? Promise.resolve();
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const current = previous.then(() => promise);
  locks.set(taskId, current);
  await previous;
  try { return await operation(); }
  finally {
    resolve();
    if (locks.get(taskId) === current) locks.delete(taskId);
  }
}

export async function waitForTaskIntegration(taskId: string): Promise<void> {
  await locks.get(taskId);
}
