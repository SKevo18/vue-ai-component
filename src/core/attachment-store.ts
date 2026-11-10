export interface AttachmentRecord {
  id: string;
  conversationId: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "text" | "image" | "pdf";
  blob: Blob;
}

const STORE = "attachments";
const CONVERSATION_INDEX = "conversationId";

export interface AttachmentStore {
  put(record: AttachmentRecord): Promise<void>;
  get(conversationId: string, id: string): Promise<AttachmentRecord | null>;
  removeConversation(conversationId: string): Promise<void>;
  clear(): Promise<void>;
}

export function createAttachmentStore(name: string): AttachmentStore {
  async function open(): Promise<IDBDatabase> {
    const request = indexedDB.open(name, 1);
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ["conversationId", "id"] });
      store.createIndex(CONVERSATION_INDEX, "conversationId");
    };
    request.onerror = () => reject(request.error ?? new Error("Cannot open attachment storage"));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Attachment storage is blocked by another tab"));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) {
        database.close();
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
    return promise;
  }

  async function transact<T>(mode: IDBTransactionMode, initial: T, run: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
    const database = await open();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE, mode);
    } catch (error) {
      database.close();
      throw error;
    }
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    let result = initial;
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Attachment storage transaction aborted"));
    };
    try {
      run(transaction.objectStore(STORE), (value) => {
        result = value;
      });
    } catch (error) {
      transaction.abort();
      reject(error);
    }
    return promise;
  }

  return {
    put: (record) => transact<void>("readwrite", undefined, (store) => void store.put(record)),
    get: (conversationId, id) =>
      transact<AttachmentRecord | null>("readonly", null, (store, result) => {
        const request = store.get([conversationId, id]);
        request.onsuccess = () => result((request.result as AttachmentRecord | undefined) ?? null);
      }),
    removeConversation: (conversationId) =>
      transact<void>("readwrite", undefined, (store) => {
        const request = store.index(CONVERSATION_INDEX).openKeyCursor(IDBKeyRange.only(conversationId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
      }),
    clear: () => transact<void>("readwrite", undefined, (store) => void store.clear()),
  };
}
