---
name: flex-explore
description: flex.team의 신규 write API(결재 문서 작성·근태 신청·전자계약 등) 호출 시퀀스와 페이로드를 알아내야 할 때 사용한다. playwright-cli로 브라우저 세션을 붙여 XHR을 가로채 실제 호출을 캡처한다. flex-cli 서브커맨드를 새로 추가하기 전 사전 탐색용. Trigger - flex API 탐색, flex 페이로드 캡처, flex.team 작업을 flex-cli로 자동화하려는데 호출 시퀀스가 코드에 없는 경우.
---

# flex-explore — flex.team API 탐색

flex-cli 코드에는 GET 위주의 크롤만 들어 있다. 새 작업(결재 작성, 근태 신청 등)을
자동화하려면 **실제 UI 동작을 따라가며 호출 시퀀스/페이로드를 직접 캡처**해야 한다.
이 스킬은 그 표준 절차다.

## 언제

- flex-cli에 새 서브커맨드(write 계열)를 추가하기 전
- flex.team UI가 호출하는 실제 API 시그니처를 모를 때
- 다른 양식/도메인(워크플로우 외)을 자동화하려고 할 때

## 사전 준비

```bash
playwright-cli --version    # 없으면 playwright-cli 스킬 참조
```

## 절차

### 1) 자격증명 (macOS Keychain)

flex-ax가 한 번이라도 인증한 적 있으면 키링에 들어 있다.

```bash
EMAIL=$(jq -r .email ~/.flex-ax/config.json)
PASS=$(security find-generic-password -s flex-ax -a "$EMAIL" -w)
```

다른 OS면 keytar/`@napi-rs/keyring` 백엔드 직접 조회.

### 2) 브라우저 띄우고 로그인

```bash
playwright-cli -s=flex open https://flex.team/auth/login --persistent
```

flex 로그인은 2-step:
- 이메일 textbox 채우고 Enter → 비밀번호 폼이 같이 표시됨
- 비밀번호 fill → "로그인하기" 버튼 클릭
- `/home`으로 리다이렉트 되면 성공

### 3) XHR hook 설치 — 핵심

flex는 axios(XHR)를 쓰므로 fetch 가로채기는 안 통한다. XHR 자체를 후킹.

```bash
playwright-cli -s=flex eval "() => {
  window.__xhr = [];
  const O = XMLHttpRequest.prototype.open;
  const S = XMLHttpRequest.prototype.send;
  const SR = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function(m, u){ this.__m=m; this.__u=u; this.__h={}; return O.apply(this, arguments); };
  XMLHttpRequest.prototype.setRequestHeader = function(k,v){ try{this.__h[k]=v;}catch(e){}; return SR.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(b){
    const self = this;
    this.addEventListener('loadend', () => {
      try {
        const u = self.__u;
        if (!u) return;
        // 탐색 대상 URL 패턴만 (필요에 맞춰 수정)
        if (!u.match(/\\/(api|action)/) && !u.includes('flex-prod-storage')) return;
        let body = b;
        if (b instanceof FormData) body = '[FormData]';
        else if (b instanceof Blob) body = '[Blob ' + b.size + ' bytes]';
        else if (b instanceof ArrayBuffer) body = '[ArrayBuffer ' + b.byteLength + ' bytes]';
        let resp = null;
        try { resp = self.responseText; if (resp && resp.length > 8000) resp = resp.slice(0,8000)+'...[truncated]'; } catch(e){}
        window.__xhr.push({ method: self.__m, url: u, reqHeaders: self.__h, reqBody: body, status: self.status, respBody: resp });
      } catch(e){}
    });
    return S.apply(this, arguments);
  };
  return 'ok';
}"
```

> 주의: hook은 **hard navigation(`goto`/`reload`)에서 소실**된다. SPA 라우트 변경은 살아있다. 페이지 리로드가 일어났다면 다시 설치.

### 4) 대상 플로우 수동 실행

탐색하려는 작업을 UI 그대로 따라간다.

snapshot으로 ref 확인:
```bash
playwright-cli -s=flex snapshot
```

ref가 없는(스냅샷 최적화로 사라진) 버튼은 DOM 직접 클릭:
```bash
playwright-cli -s=flex eval "() => { for (const b of document.querySelectorAll('button')) { if (b.textContent.trim() === '보내기' && !b.disabled) { b.click(); return 'ok'; } } return 'not found'; }"
```

파일 업로드는 클릭과 upload를 **연달아** 호출(파일 chooser 모달이 살아 있을 때만):
```bash
playwright-cli -s=flex click <ref> && playwright-cli -s=flex upload ./sample.pdf
```

`playwright-cli upload`는 worktree 안 경로만 허용된다. `/tmp/`는 거부됨 — 작업 디렉토리에 복사 후 사용.

### 5) 본문 추출

```bash
# 호출 목록만
playwright-cli -s=flex eval "() => JSON.stringify((window.__xhr||[]).map(x => ({m:x.method, u:x.url.length>120?x.url.slice(0,120)+'...':x.url, s:x.status})), null, 2)"

# 특정 도메인 호출의 reqBody/respBody
playwright-cli -s=flex eval "() => JSON.stringify((window.__xhr||[]).filter(x => x.url.includes('<keyword>')), null, 2)"
```

본문이 거대하면 hook 안에서 `slice(0,8000)`으로 자르지만, 8000자 넘는 응답이 필요하면 hook의 limit을 늘리거나 특정 호출만 raw로 다시 dump.

### 6) 정리

```bash
playwright-cli -s=flex close
# 테스트로 만든 더미 파일/스냅샷도 같이 정리
```

## 흔한 함정

1. **fetch hook은 안 통한다** — flex는 axios(XHR). 위 XHR hook 사용.
2. **page reload로 hook 소실** — SPA navigation은 OK, `goto`/`reload`만 주의.
3. **`security find-generic-password`가 키링 prompt를 띄울 수 있다** — 한 번 허용하면 세션 동안 풀려있음.
4. **playwright-cli upload는 worktree 밖 경로 거부** — 파일을 작업 디렉토리에 복사 후 사용.
5. **`upload`는 클릭 직후에만 작동** — `[File chooser]: can be handled by upload` 모달 상태일 때.
6. **테스트 제출은 실제로 결재선에 나간다** — 제목/사유에 "[TEST] 즉시 반려 부탁" 명시 + 결재자에게 사전 양해. 금액은 1원.
7. **임시 fileKey vs 영구 fileKey** — pre-signed-url 응답은 임시(temp) fileKey. draft에 `uploaded:false`로 보내면 응답에서 영구 fileKey가 내려온다. 영구 fileKey + `uploaded:true`로 다시 갱신해야 submit 통과.
8. **S3 PUT은 별도 도메인** — `flex-prod-storage.s3.ap-northeast-2.amazonaws.com`. hook URL 필터에 포함시키지 않으면 누락.

## 표준 인증 헤더

캡처한 호출들의 공통 헤더 — 새 CLI 코드에서도 그대로 쓰면 됨. `apps/flex-cli/src/auth/index.ts`의 `apiHeaders(authCtx)`가 이걸 내준다.

- `x-flex-aid: <customerToken>` — 현재 법인 scope JWT
- `flexteam-deviceid: <uuid>` — 로그인 시 발급
- `x-flex-axios: base`
- `flexteam-productcode: FLEX`
- `flexteam-locale: ko`

S3 PUT은 위 헤더 없이 보낸다(AWS 서명은 URL에 동봉).

## 부록 — 이번에 캡처한 워크플로우 작성 시퀀스 (참조용)

비용 결제 요청 양식 + 첨부 1개로 다음 시퀀스가 200으로 검증됨. 다른 양식도 `templateKey`만 다를 가능성이 높음.

```
GET   /api/v3/approval-document-template/available-templates
POST  /action/v3/approval-document-template/templates/{tplKey}/resolve-policy
GET   /api/v2/file/restrictions/source-types

# 첨부 (3-step pre-signed)
POST  /api/v2/file/users/me/files/temporary/pre-signed-url
      body: { name, size, sourceType: "WORKFLOW_TASK_ATTACHMENT", sensitiveFile: false, mimeType }
      → { fileKey: "<temp>", uploadUrl: "https://flex-prod-storage.s3..." }
PUT   <uploadUrl>            # body = 파일 바이트, content-type 일치
GET   /api/v2/file/users/me/files/temporary/<temp>/pre-signed-url/verify

# Draft → 영구 fileKey 변환 → 제출
POST  /api/v3/approval-document/approval-documents/draft
      → { draft: { document: { documentKey: "<docKey>" } } }
POST  /api/v3/approval-document/approval-documents/draft?documentKey=<docKey>
      body.document.attachments=[{name, fileKey:"<temp>", uploaded:false}]
      → 응답의 attachments[].file.fileKey = "<perm>"
POST  /api/v3/approval-document/approval-documents?documentKey=<docKey>
      body.document.attachments=[{name, fileKey:"<perm>", uploaded:true}]
      → { document: { code: "2026-XXX", status: "IN_PROGRESS" } }
```

UI는 디바운스로 draft 갱신을 여러 번 흘려보내지만, **temp fileKey로 1회 draft → 응답에서 perm fileKey 추출 → 즉시 submit**으로 압축 가능해 보임 (구현 시 검증).
