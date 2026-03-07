type PersistStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;

function createMemoryStorage(): PersistStorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
  };
}

const memoryStorage = createMemoryStorage();

export function getPersistStorage(): PersistStorageLike {
  if (typeof localStorage !== "undefined") {
    const candidate = localStorage as Partial<PersistStorageLike>;
    if (
      typeof candidate.getItem === "function" &&
      typeof candidate.setItem === "function" &&
      typeof candidate.removeItem === "function" &&
      typeof candidate.clear === "function"
    ) {
      return candidate as PersistStorageLike;
    }
  }
  return memoryStorage;
}
