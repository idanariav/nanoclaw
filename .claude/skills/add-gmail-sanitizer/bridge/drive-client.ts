/**
 * Raw Drive REST access. By default scoped to `drive.file` (the connected
 * OneCLI app can only see files it created) — uploads go straight from the
 * Gmail attachment bytes to Drive inside this process, callers never see
 * the bytes, only the resulting file metadata. `downloadDriveFileBytes` is
 * the read-side counterpart (e.g. re-opening a report previously saved here
 * to edit it) — its bytes stay inside this process too, same as an upload.
 *
 * If GMAIL_SANITIZER_DRIVE_FOLDER_ID is set, that folder becomes both the
 * upload destination (replacing the auto-created "Nanoclaw" folder) and a
 * scope boundary enforced in this file: every operation on a caller-supplied
 * driveFileId is checked to be a direct child of that folder before it runs.
 * This boundary matters because it lets the OneCLI OAuth grant itself be
 * broadened past `drive.file` (needed to see/overwrite files this app did
 * not create) without handing the agent free rein over the whole Drive —
 * see the SKILL.md Phase 3 note on this.
 */
import { fetch } from 'undici';

import { getGmailSanitizerDispatcher } from './identity.js';
import { readEnvFile } from '../env.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const DESTINATION_FOLDER_NAME = 'Nanoclaw';

const envConfig = readEnvFile(['GMAIL_SANITIZER_DRIVE_FOLDER_ID']);
const SCOPED_FOLDER_ID = envConfig.GMAIL_SANITIZER_DRIVE_FOLDER_ID;

/** Thrown when a caller-supplied driveFileId falls outside GMAIL_SANITIZER_DRIVE_FOLDER_ID's scope. */
export class DriveScopeError extends Error {}

let folderIdPromise: Promise<string> | undefined;

async function driveFetch(url: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const dispatcher = await getGmailSanitizerDispatcher();
  const res = await fetch(url, { ...init, dispatcher });
  if (!res.ok) {
    throw new Error(`Drive API ${url} -> ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  return res as unknown as Response;
}

async function findOrCreateDestinationFolder(): Promise<string> {
  const q = encodeURIComponent(
    `name = '${DESTINATION_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
  );
  const listRes = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id)`);
  const listData = (await listRes.json()) as { files?: { id: string }[] };
  if (listData.files && listData.files.length > 0) {
    return listData.files[0].id;
  }

  const createRes = await driveFetch(`${DRIVE_API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DESTINATION_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

async function getDestinationFolderId(): Promise<string> {
  if (SCOPED_FOLDER_ID) return SCOPED_FOLDER_ID;
  if (!folderIdPromise) folderIdPromise = findOrCreateDestinationFolder();
  return folderIdPromise;
}

/** True iff `fileId` is a direct child of GMAIL_SANITIZER_DRIVE_FOLDER_ID. Only meaningful when that's configured. */
async function isDirectChildOfScopedFolder(fileId: string): Promise<boolean> {
  const res = await driveFetch(`${DRIVE_API}/files/${fileId}?fields=parents`);
  const data = (await res.json()) as { parents?: string[] };
  return data.parents?.includes(SCOPED_FOLDER_ID!) ?? false;
}

/**
 * No-op when GMAIL_SANITIZER_DRIVE_FOLDER_ID isn't configured — in that
 * default mode, `drive.file`'s own OAuth boundary is the only enforcement
 * (the app literally cannot see files outside it). Once a scoped folder is
 * configured, the OAuth grant is expected to be broader, so this becomes the
 * real boundary: every caller-supplied driveFileId must live directly inside
 * that folder.
 */
async function assertInScopedFolder(fileId: string): Promise<void> {
  if (!SCOPED_FOLDER_ID) return;
  if (!(await isDirectChildOfScopedFolder(fileId))) {
    throw new DriveScopeError(`Drive file ${fileId} is outside the scoped folder`);
  }
}

export interface DriveListedFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size?: number;
  webViewLink: string;
}

/** List the files directly inside GMAIL_SANITIZER_DRIVE_FOLDER_ID. Throws if that isn't configured. */
export async function listScopedFolder(): Promise<DriveListedFile[]> {
  if (!SCOPED_FOLDER_ID) {
    throw new Error('GMAIL_SANITIZER_DRIVE_FOLDER_ID is not configured — nothing to browse');
  }
  const q = encodeURIComponent(`'${SCOPED_FOLDER_ID}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,size,webViewLink)');
  const res = await driveFetch(`${DRIVE_API}/files?q=${q}&fields=${fields}&pageSize=200`);
  const data = (await res.json()) as { files?: (DriveListedFile & { size?: string })[] };
  return (data.files ?? []).map((f) => ({ ...f, size: f.size !== undefined ? Number(f.size) : undefined }));
}

export interface DriveUploadResult {
  driveFileId: string;
  webViewLink: string;
  filename: string;
  size: number;
}

/** Applies a caller-supplied rename, preserving the original file extension. */
export function applyFilenameOverride(originalFilename: string, override?: string): string {
  if (!override) return originalFilename;
  const dot = originalFilename.lastIndexOf('.');
  const ext = dot > 0 ? originalFilename.slice(dot) : '';
  return ext && !override.toLowerCase().endsWith(ext.toLowerCase()) ? `${override}${ext}` : override;
}

/** Download an existing Drive file's bytes (e.g. one previously saved via uploadAttachmentToDrive) so it can be re-read or edited. */
export async function downloadDriveFileBytes(driveFileId: string): Promise<Buffer> {
  await assertInScopedFolder(driveFileId);
  const res = await driveFetch(`${DRIVE_API}/files/${driveFileId}?alt=media`);
  return Buffer.from(await res.arrayBuffer());
}

export interface DriveUpdateResult {
  driveFileId: string;
  webViewLink: string;
  size: number;
}

/** Overwrite an existing Drive file's content in place (same file id, same link) — for a canonical working file that gets edited repeatedly, instead of uploadAttachmentToDrive's always-a-new-file behavior. */
export async function updateDriveFileBytes(
  driveFileId: string,
  mimeType: string,
  bytes: Buffer,
): Promise<DriveUpdateResult> {
  await assertInScopedFolder(driveFileId);
  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files/${driveFileId}?uploadType=media&fields=id,webViewLink,size`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body: bytes,
  });
  const data = (await res.json()) as { id: string; webViewLink: string; size?: string };
  return { driveFileId: data.id, webViewLink: data.webViewLink, size: data.size ? Number(data.size) : bytes.length };
}

export interface DriveCopyResult {
  driveFileId: string;
  webViewLink: string;
  filename: string;
}

/** Copy a Drive file server-side (bytes never leave Drive) into the destination folder under `newName` — e.g. turning a template into this month's file. A name without the original's extension keeps it. */
export async function copyDriveFile(driveFileId: string, newName: string): Promise<DriveCopyResult> {
  await assertInScopedFolder(driveFileId);
  const { name } = await getDriveFileMetadata(driveFileId);
  const filename = applyFilenameOverride(name, newName);
  const folderId = await getDestinationFolderId();
  const res = await driveFetch(`${DRIVE_API}/files/${driveFileId}/copy?fields=id,webViewLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: filename, parents: [folderId] }),
  });
  const data = (await res.json()) as { id: string; webViewLink: string };
  return { driveFileId: data.id, webViewLink: data.webViewLink, filename };
}

/** Rename a Drive file in place (same id, same link). A name without the original's extension keeps it. */
export async function renameDriveFile(driveFileId: string, newName: string): Promise<DriveCopyResult> {
  await assertInScopedFolder(driveFileId);
  const { name } = await getDriveFileMetadata(driveFileId);
  const filename = applyFilenameOverride(name, newName);
  const res = await driveFetch(`${DRIVE_API}/files/${driveFileId}?fields=id,webViewLink`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: filename }),
  });
  const data = (await res.json()) as { id: string; webViewLink: string };
  return { driveFileId: data.id, webViewLink: data.webViewLink, filename };
}

export async function uploadAttachmentToDrive(
  filename: string,
  mimeType: string,
  bytes: Buffer,
): Promise<DriveUploadResult> {
  const folderId = await getDestinationFolderId();

  const boundary = `nanoclaw-gmail-${Date.now()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink,size`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = (await res.json()) as { id: string; webViewLink: string; size?: string };
  return {
    driveFileId: data.id,
    webViewLink: data.webViewLink,
    filename,
    size: data.size ? Number(data.size) : bytes.length,
  };
}
