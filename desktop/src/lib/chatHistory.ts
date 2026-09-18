import type { StreamEvent } from "./api";

let database: Promise<IDBDatabase> | undefined;
function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("aura-chat-history", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("conversations");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error);
    };
  }));
}
export async function readChatHistory(key: string): Promise<StreamEvent[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("conversations", "readonly")
      .objectStore("conversations")
      .get(key);
    request.onsuccess = () =>
      resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error);
  });
}
export async function writeChatHistory(
  key: string,
  events: StreamEvent[],
): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("conversations", "readwrite");
    transaction.objectStore("conversations").put(events, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
