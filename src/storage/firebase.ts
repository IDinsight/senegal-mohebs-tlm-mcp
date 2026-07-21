import { createRequire } from "node:module";
import { CONFIG, DOCX_MIME } from "../config.js";
import { docsPrefix, docKey, historyKey } from "../context-state.js";
import type { StorageAdapter, StoredObject, HistoryFile } from "../types.js";

const require = createRequire(import.meta.url);

interface GcsFile {
  name: string;
  metadata?: { md5Hash?: string; updated?: string; size?: string };
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[{ md5Hash?: string; updated?: string }]>;
  download(): Promise<[Buffer]>;
  getSignedUrl(opts: { version: "v4"; action: "read" | "write"; expires: number; contentType?: string }): Promise<[string]>;
  save(data: string, opts?: { contentType?: string; resumable?: boolean }): Promise<void>;
}
interface GcsBucket {
  getFiles(opts: { prefix: string }): Promise<[GcsFile[]]>;
  file(path: string): GcsFile;
}

const fbApp = require("firebase-admin/app") as {
  initializeApp: (opts: { credential: unknown; storageBucket: string }) => unknown;
  cert: (serviceAccountPathOrObject: string) => unknown;
  getApps: () => unknown[];
};
const fbStorage = require("firebase-admin/storage") as { getStorage: () => { bucket: () => GcsBucket } };

function initFirebase(): void {
  if (!CONFIG.serviceAccountKeyPath || !CONFIG.firebaseBucket) {
    throw new Error("Firebase is not configured. Set SERVICE_ACCOUNT_KEY_PATH and FIREBASE_STORAGE_BUCKET.");
  }
  if (fbApp.getApps().length === 0) {
    fbApp.initializeApp({ credential: fbApp.cert(CONFIG.serviceAccountKeyPath), storageBucket: CONFIG.firebaseBucket });
  }
}

const bucket = () => fbStorage.getStorage().bucket();

export function createFirebaseStorage(): StorageAdapter {
  initFirebase();
  return {
    async listDocuments() {
      const [files] = await bucket().getFiles({ prefix: docsPrefix() });
      const out: StoredObject[] = [];
      for (const f of files) {
        const name = f.name;
        if (name === docsPrefix() || name.endsWith("/")) continue;
        out.push({ relPath: name.slice(docsPrefix().length), md5: f.metadata?.md5Hash ?? null, updated: f.metadata?.updated ?? null });
      }
      return out;
    },
    async getObjectMd5(relPath) {
      const f = bucket().file(docKey(relPath));
      const [exists] = await f.exists();
      if (!exists) return null;
      const [md] = await f.getMetadata();
      return md.md5Hash ?? null;
    },
    async downloadDocx(relPath) {
      const [buf] = await bucket().file(docKey(relPath)).download();
      return buf;
    },
    async createUploadUrl(relPath) {
      const expiresMs = Date.now() + 15 * 60 * 1000;
      const [url] = await bucket().file(docKey(relPath)).getSignedUrl({ version: "v4", action: "write", expires: expiresMs, contentType: DOCX_MIME });
      return { url, objectKey: docKey(relPath), contentType: DOCX_MIME, expiresAt: new Date(expiresMs).toISOString() };
    },
    async createDownloadUrl(relPath) {
      const f = bucket().file(docKey(relPath));
      const [exists] = await f.exists();
      const expiresMs = Date.now() + 15 * 60 * 1000;
      const [url] = await f.getSignedUrl({ version: "v4", action: "read", expires: expiresMs });
      return { url, objectKey: docKey(relPath), expiresAt: new Date(expiresMs).toISOString(), exists };
    },
    async readHistory() {
      const f = bucket().file(historyKey());
      const [exists] = await f.exists();
      if (!exists) return null;
      const [buf] = await f.download();
      return JSON.parse(buf.toString("utf8")) as HistoryFile;
    },
    async writeHistory(h) {
      await bucket().file(historyKey()).save(JSON.stringify(h, null, 2), { contentType: "application/json", resumable: false });
    },
  };
}
