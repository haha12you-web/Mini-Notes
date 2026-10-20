import type { Note } from "./shared";

export type LocalDraft = { token: string; note: Note; savedAt: string };
const prefix = "mini-notes:draft:v1:";

function key(userId: string, noteId: string): string {
  return `${prefix}${encodeURIComponent(userId)}:${encodeURIComponent(noteId)}`;
}

export function readLocalDraft(userId: string, noteId: string, storage = window.localStorage): LocalDraft | null {
  const raw = storage.getItem(key(userId, noteId));
  if (!raw) return null;
  const value = JSON.parse(raw) as LocalDraft;
  if (typeof value.token !== "string" || value.note?.id !== noteId ||
      typeof value.note.updatedAt !== "string" || !Array.isArray(value.note.content)) {
    throw new Error("Invalid local draft");
  }
  return value;
}

// Synchronous writes also work during pagehide/beforeunload. Quota/security errors
// deliberately propagate: the UI must never claim an unpersisted draft is safe.
export function writeLocalDraft(userId: string, note: Note, storage = window.localStorage): string {
  const token = crypto.randomUUID();
  storage.setItem(key(userId, note.id), JSON.stringify({ token, note, savedAt: new Date().toISOString() }));
  storage.setItem(`${prefix}${encodeURIComponent(userId)}:last`, note.id);
  return token;
}

export function removeLocalDraft(userId: string, noteId: string, token: string, storage = window.localStorage): void {
  // An old response must not delete edits persisted after its request started.
  if (readLocalDraft(userId, noteId, storage)?.token !== token) return;
  storage.removeItem(key(userId, noteId));
  if (storage.getItem(`${prefix}${encodeURIComponent(userId)}:last`) === noteId) {
    storage.removeItem(`${prefix}${encodeURIComponent(userId)}:last`);
  }
}

export function lastLocalDraftId(userId: string, storage = window.localStorage): string | null {
  return storage.getItem(`${prefix}${encodeURIComponent(userId)}:last`);
}

export function sameEditableNote(a: Note, b: Note): boolean {
  return a.title === b.title && a.icon === b.icon && a.titleSize === b.titleSize &&
    JSON.stringify(a.titleSegments) === JSON.stringify(b.titleSegments) &&
    JSON.stringify(a.content) === JSON.stringify(b.content);
}

export function retryableSaveStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
