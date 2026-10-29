const locks = new Map<string, Promise<void>>();
const repositoryLocks = new Map<string, Promise<void>>();

async function withLock<T>(queue: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const current = previous.then(() => promise);
  queue.set(key, current);
  await previous;
  try { return await operation(); }
  finally {
    resolve();
    if (queue.get(key) === current) queue.delete(key);
  }
}

export function withTaskIntegrationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  return withLock(locks, taskId, operation);
}

export function withRepositoryIntegrationLock<T>(repositoryPath: string, operation: () => Promise<T>): Promise<T> {
  return withLock(repositoryLocks, repositoryPath, operation);
}

export async function waitForTaskIntegration(taskId: string): Promise<void> {
  await locks.get(taskId);
}
