// ── Module: storage · internal ───────────────────────────────────────────────
// The concrete Firebase/GCS implementation of StorageAdapter: signed upload/
// download URLs, docx download, and reading/writing the history.json object. The
// only file that talks to firebase-admin. Object keys are namespaced per active
// grade/subject via the docsPrefix/historyKey helpers from context/state.
import { createRequire } from "node:module";
import { CONFIG, DOCX_MIME } from "../config.js";
import { docsPrefix, docKey, historyKey, previewKey } from "../context/index.js";
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
  cert: (serviceAccountPathOrObject: string | object) => unknown;
  applicationDefault: () => unknown;
  getApps: () => unknown[];
};
const fbStorage = require("firebase-admin/storage") as { getStorage: () => { bucket: () => GcsBucket } };

function initFirebase(): void {
  if (!CONFIG.firebaseBucket) {
    throw new Error("Firebase is not configured. Set FIREBASE_STORAGE_BUCKET (and SERVICE_ACCOUNT_KEY_PATH when not running on GCP).");
  }
  if (fbApp.getApps().length === 0) {
    // Credential precedence: key file (local) > key JSON content (hosts where a
    // file mount is impractical) > Application Default Credentials (GCP runtime;
    // signed URLs then need roles/iam.serviceAccountTokenCreator on the SA).
    const credential = CONFIG.serviceAccountKeyPath
      ? fbApp.cert(CONFIG.serviceAccountKeyPath)
      : CONFIG.serviceAccountKeyJson
        ? fbApp.cert(JSON.parse(CONFIG.serviceAccountKeyJson))
        : fbApp.applicationDefault();
    fbApp.initializeApp({ credential, storageBucket: CONFIG.firebaseBucket });
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
    async createPreviewUpload(relPath) {
      // Preview objects are throwaway, so a SHORTER 10-minute lifetime than the
      // 15-minute canonical URLs — long enough to upload the generated .docx and
      // open it, short enough that a preview link doesn't linger. Both the write
      // (PUT) and read (GET) URLs are signed for the SAME previews/ object key,
      // so the caller uploads to `uploadUrl` and hands the human `downloadUrl`.
      const key = previewKey(relPath);
      const f = bucket().file(key);
      const expiresMs = Date.now() + 10 * 60 * 1000;
      const [uploadUrl] = await f.getSignedUrl({ version: "v4", action: "write", expires: expiresMs, contentType: DOCX_MIME });
      const [downloadUrl] = await f.getSignedUrl({ version: "v4", action: "read", expires: expiresMs });
      return { uploadUrl, downloadUrl, objectKey: key, contentType: DOCX_MIME, expiresAt: new Date(expiresMs).toISOString() };
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

// ── Context-free object helpers (app-layer use) ──────────────────────────────
// Read/write small objects at an absolute key (caller includes any prefix).
// Unlike the adapter methods above these don't depend on the active context —
// the HTTP entry uses them to persist each user's grade/subject selection,
// which by definition exists outside any active context.
export async function readGlobalObject(key: string): Promise<string | null> {
  initFirebase();
  const f = fbStorage.getStorage().bucket().file(key);
  const [exists] = await f.exists();
  if (!exists) return null;
  const [buf] = await f.download();
  return buf.toString("utf8");
}

export async function writeGlobalObject(key: string, text: string): Promise<void> {
  initFirebase();
  await fbStorage.getStorage().bucket().file(key).save(text, { contentType: "application/json", resumable: false });
}
