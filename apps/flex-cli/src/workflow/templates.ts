import type { AuthContext } from "../auth/index.js";
import { getJson } from "./http.js";
import type { AvailableTemplate } from "./types.js";

interface AvailableTemplatesResponse {
  templates?: AvailableTemplate[];
}

/**
 * 작성자가 실제로 작성 가능한 양식 목록을 조회한다.
 *
 * crawl은 `/api/v3/approval-document-template/templates` 를 쓰지만 그쪽은
 * "관리자가 보는 모든 양식" 이라 사용자에게 권한이 없는 양식까지 나온다.
 * 작성 플로우에서는 권한 필터된 `available-templates` 가 맞다.
 */
export async function listAvailableTemplates(
  authCtx: AuthContext,
  baseUrl: string,
): Promise<AvailableTemplate[]> {
  const data = await getJson<AvailableTemplatesResponse>(
    authCtx,
    `${baseUrl}/api/v3/approval-document-template/available-templates`,
  );
  return data.templates ?? [];
}

/**
 * 사용자가 입력한 키 또는 이름으로 양식 한 건을 찾는다.
 *
 * 매칭 우선순위:
 *   1) templateKey 완전 일치
 *   2) name 완전 일치 (대소문자 무시)
 *   3) name이 부분 일치하는 후보가 정확히 1건이면 그것
 *
 * 부분 일치 후보가 2건 이상이면 사용자에게 명시적 선택을 요구하기 위해 에러로 던진다.
 */
export function findTemplate(
  templates: AvailableTemplate[],
  query: string,
): AvailableTemplate {
  const exactKey = templates.find((t) => t.templateKey === query);
  if (exactKey) return exactKey;

  const lowerQuery = query.toLowerCase();
  const exactName = templates.find((t) => t.name.toLowerCase() === lowerQuery);
  if (exactName) return exactName;

  const partial = templates.filter((t) => t.name.toLowerCase().includes(lowerQuery));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `"${query}" 와(과) 부분 일치하는 양식이 ${partial.length}개입니다. ` +
        `templateKey나 정확한 이름을 사용하세요: ${partial.map((t) => `"${t.name}"`).join(", ")}`,
    );
  }
  throw new Error(`"${query}" 에 매칭되는 양식이 없습니다 (${templates.length}개 중)`);
}
