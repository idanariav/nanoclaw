/**
 * Raw Drive REST access, scoped to `drive.file` (the connected OneCLI app
 * can only see files it created). Uploads go straight from the Gmail
 * attachment bytes to Drive inside this process — callers never see the
 * bytes, only the resulting file metadata.
 */
import { fetch } from 'undici';

import { getGmailSanitizerDispatcher } from './identity.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

const DESTINATION_FOLDER_NAME = 'NanoClaw Gmail Attachments';

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
  if (!folderIdPromise) folderIdPromise = findOrCreateDestinationFolder();
  return folderIdPromise;
}

export interface DriveUploadResult {
  driveFileId: string;
  webViewLink: string;
  filename: string;
  size: number;
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
