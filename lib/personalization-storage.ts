import type {
  BACKGROUND_ASSET_KEY,
  COMPLETION_SOUND_ASSET_KEY,
} from "./personalization";

export type PersonalizationAssetKey =
  | typeof BACKGROUND_ASSET_KEY
  | typeof COMPLETION_SOUND_ASSET_KEY;

export interface StoredPersonalizationAsset {
  blob: Blob;
  name: string;
  updatedAt: number;
}

const DATABASE_NAME = "pi-web-personalization";
const DATABASE_VERSION = 1;
const ASSET_STORE = "assets";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is not available"));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ASSET_STORE)) {
        database.createObjectStore(ASSET_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open personalization storage"));
    request.onblocked = () => reject(new Error("Personalization storage is blocked by another tab"));
  });
}

function runAssetRequest<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(ASSET_STORE, mode);
    const request = action(transaction.objectStore(ASSET_STORE));
    let result: T;

    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error ?? new Error("Personalization storage request failed"));
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Personalization storage transaction failed"));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Personalization storage transaction was aborted"));
    };
  }));
}

export async function loadPersonalizationAsset(
  key: PersonalizationAssetKey,
): Promise<StoredPersonalizationAsset | null> {
  const stored = await runAssetRequest<StoredPersonalizationAsset | undefined>(
    "readonly",
    (store) => store.get(key),
  );
  if (!stored || !(stored.blob instanceof Blob)) return null;
  return stored;
}

export async function savePersonalizationAsset(
  key: PersonalizationAssetKey,
  file: Blob,
  name: string,
): Promise<void> {
  const value: StoredPersonalizationAsset = {
    blob: file,
    name,
    updatedAt: Date.now(),
  };
  await runAssetRequest<IDBValidKey>("readwrite", (store) => store.put(value, key));
}

export async function deletePersonalizationAsset(key: PersonalizationAssetKey): Promise<void> {
  await runAssetRequest<undefined>("readwrite", (store) => store.delete(key));
}
