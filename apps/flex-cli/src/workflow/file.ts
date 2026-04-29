import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AuthContext } from "../auth/index.js";
import { getJson, postJson, putRaw } from "./http.js";
import type { PreSignedUrlResponse, UploadedAttachment } from "./types.js";

/**
 * 워크플로우 첨부파일 업로드 3단계.
 *   1) pre-signed URL 발급 → temp fileKey + S3 PUT URL
 *   2) S3에 파일 바이트를 직접 PUT
 *   3) 서버에 verify 호출 → S3 객체 존재 확인 + verifiedAt 마킹
 *
 * 주의: 여기서 받는 fileKey는 "임시" 키다. draft에 attachments[fileKey, uploaded:false]
 * 형태로 한 번 등록한 뒤 응답에서 영구 fileKey를 꺼내는 변환 단계는 document.ts 가 담당.
 */
export async function uploadAttachment(
  authCtx: AuthContext,
  baseUrl: string,
  filePath: string,
): Promise<UploadedAttachment> {
  const absolute = path.resolve(filePath);
  const stats = await stat(absolute);
  if (!stats.isFile()) {
    throw new Error(`첨부 대상이 일반 파일이 아닙니다: ${filePath}`);
  }
  const name = path.basename(absolute);
  const mimeType = guessMimeType(name);
  const bytes = await readFile(absolute);

  const presigned = await postJson<PreSignedUrlResponse>(
    authCtx,
    `${baseUrl}/api/v2/file/users/me/files/temporary/pre-signed-url`,
    {
      name,
      size: stats.size,
      sourceType: "WORKFLOW_TASK_ATTACHMENT",
      sensitiveFile: false,
      mimeType,
    },
  );

  await putRaw(presigned.uploadUrl, bytes, mimeType);

  // verify 응답이 200이면 이후 draft에 fileKey를 등록할 수 있다는 신호.
  // 응답 본문은 verifiedAt 정도만 들어 있어 굳이 들고 다닐 필요 없으므로 throw away.
  await getJson<unknown>(
    authCtx,
    `${baseUrl}/api/v2/file/users/me/files/temporary/${encodeURIComponent(presigned.fileKey)}/pre-signed-url/verify`,
  );

  return {
    fileKey: presigned.fileKey,
    name,
    size: stats.size,
    mimeType,
  };
}

/**
 * 확장자로 MIME을 추정한다. 공식 mime-db를 통째로 끌어오는 대신
 * 워크플로우 첨부에서 흔한 12개 정도만 다루고 나머지는 octet-stream으로 떨어진다.
 *
 * application/octet-stream 으로 보내도 서버는 접수하지만, 미리보기/검색에서 손해를 보므로
 * 자주 쓰는 포맷은 명시한다.
 */
function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".heic":
      return "image/heic";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".xls":
      return "application/vnd.ms-excel";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".ppt":
      return "application/vnd.ms-powerpoint";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
