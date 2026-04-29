import { apiHeaders, HttpError, type AuthContext } from "../auth/index.js";

/**
 * workflow/* 모듈 전용 HTTP helper.
 *
 * crawlers/shared.ts 의 flexFetch/flexPost 도 비슷한 일을 하지만 두 가지 이유로 별도로 둔다:
 *   1) crawl은 read 전용이라 4xx 분기/typed 에러가 거의 필요 없는 반면, 워크플로우 작성은
 *      필수 필드 누락·결재선 미해석 등에서 4xx를 정확히 구분해야 한다 → HttpError로 통일.
 *   2) S3 pre-signed PUT은 인증 헤더 없이 raw body만 보내야 한다 → 별도 함수로 분리.
 */

interface HttpOptions {
  /** 추가/오버라이드할 헤더 */
  headers?: Record<string, string>;
}

export async function getJson<T>(
  authCtx: AuthContext,
  url: string,
  opts: HttpOptions = {},
): Promise<T> {
  const res = await fetch(url, { headers: apiHeaders(authCtx, opts.headers) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `GET ${url}`, text);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(
  authCtx: AuthContext,
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: apiHeaders(authCtx, opts.headers),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `POST ${url}`, text);
  }
  return (await res.json()) as T;
}

/**
 * S3 pre-signed URL에 raw 바이트를 PUT한다.
 * 인증 헤더는 동봉하지 않고 (URL 자체에 AWS 서명이 들어있음) content-type만 일치시킨다.
 */
export async function putRaw(
  url: string,
  body: Uint8Array,
  contentType: string,
): Promise<void> {
  // BodyInit 으로의 좁힘 — @types/node의 Uint8Array는 Generic으로 들고 다니지만 (ArrayBufferLike)
  // DOM 의 BufferSource 는 ArrayBuffer 한정이라 직대입이 거부된다. 런타임 호환은 보장됨.
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: body as BodyInit,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, `PUT ${url}`, text);
  }
}
