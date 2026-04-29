---
name: flex-explore
description: Use when you need to discover the request sequence and payloads of a new flex.team write API (approval document creation, time-off request, e-contract, etc.) before adding a flex-cli subcommand. Attaches to a browser session via playwright-cli and intercepts XHR to capture real calls. Trigger - flex API exploration, flex payload capture, automating a flex.team action with flex-cli when the call sequence is not yet in the codebase.
---

# flex-explore — flex.team API discovery

The flex-cli code only contains GET-based crawlers. To automate a new action
(approval document creation, time-off request, etc.), you have to follow the
real UI flow and **capture the call sequence and payloads directly**. This
skill is the standard procedure for that.

## When

- Before adding a write-flavored subcommand to flex-cli
- When you don't know the actual API signatures the flex.team UI calls
- When automating a different form/domain (anything beyond what's already crawled)

## Prerequisites

```bash
playwright-cli --version    # if missing, see the playwright-cli skill
```

## Procedure

### 1) Credentials (macOS Keychain)

If flex-ax has authenticated at least once, the password is in the keyring.

```bash
EMAIL=$(jq -r .email ~/.flex-ax/config.json)
PASS=$(security find-generic-password -s flex-ax -a "$EMAIL" -w)
```

On other OSes, query the keytar / `@napi-rs/keyring` backend directly.

### 2) Open the browser and log in

```bash
playwright-cli -s=flex open https://flex.team/auth/login --persistent
```

flex login is 2-step:
- fill the email textbox and press Enter → the password form is revealed
- fill the password and click "로그인하기"
- redirect to `/home` indicates success

### 3) Install the XHR hook — the load-bearing step

flex uses axios (XHR), so a fetch interceptor will not catch anything. Hook
XHR itself.

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
        // URL filter — adjust to the flow you're exploring
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

> The hook is **lost on hard navigation (`goto` / `reload`)**. SPA route
> changes preserve it. If a full reload happens, reinstall.

### 4) Drive the target flow manually

Walk through the action in the UI exactly as a user would.

Capture refs with snapshot:
```bash
playwright-cli -s=flex snapshot
```

When a button has no ref (snapshot optimization can drop refs), click via DOM:
```bash
playwright-cli -s=flex eval "() => { for (const b of document.querySelectorAll('button')) { if (b.textContent.trim() === '보내기' && !b.disabled) { b.click(); return 'ok'; } } return 'not found'; }"
```

For file upload, run click and upload **back-to-back** (the file chooser modal
must still be active):
```bash
playwright-cli -s=flex click <ref> && playwright-cli -s=flex upload ./sample.pdf
```

`playwright-cli upload` only accepts paths inside the worktree. `/tmp/` is
rejected — copy the file into the working directory first.

### 5) Extract bodies

```bash
# call list only
playwright-cli -s=flex eval "() => JSON.stringify((window.__xhr||[]).map(x => ({m:x.method, u:x.url.length>120?x.url.slice(0,120)+'...':x.url, s:x.status})), null, 2)"

# reqBody / respBody for a specific endpoint
playwright-cli -s=flex eval "() => JSON.stringify((window.__xhr||[]).filter(x => x.url.includes('<keyword>')), null, 2)"
```

The hook truncates response bodies to 8000 chars. If a specific call needs
more, raise the slice limit or re-dump that one call raw.

### 6) Clean up

```bash
playwright-cli -s=flex close
# also remove dummy files / snapshots created for the test
```

## Common pitfalls

1. **Fetch hooks won't work** — flex uses axios (XHR). Use the XHR hook above.
2. **Page reload kills the hook** — SPA navigation is fine; only `goto` /
   `reload` matter.
3. **`security find-generic-password` may prompt the keyring** — once
   approved, it stays unlocked for the session.
4. **`playwright-cli upload` rejects paths outside the worktree** — copy the
   file into the working directory first.
5. **`upload` only works right after a click** — the
   `[File chooser]: can be handled by upload` modal must still be active.
6. **Test submissions actually go to real approvers** — put "[TEST] please
   reject" in the title and a reason field, give approvers a heads-up
   beforehand, and use 1 KRW for any amount field.
7. **Temp vs permanent fileKey** — the pre-signed-url response returns a
   temporary fileKey. POST it to draft with `uploaded:false` and the response
   will contain the permanent fileKey. Use that with `uploaded:true` on the
   final update before submit.
8. **S3 PUT is on a separate host** —
   `flex-prod-storage.s3.ap-northeast-2.amazonaws.com`. Include this in the
   hook's URL filter or it will be missed.

## Standard auth headers

The captured calls share these headers — new CLI code can reuse them as-is.
`apps/flex-cli/src/auth/index.ts` `apiHeaders(authCtx)` already produces this set.

- `x-flex-aid: <customerToken>` — customer-scoped JWT
- `flexteam-deviceid: <uuid>` — issued at login
- `x-flex-axios: base`
- `flexteam-productcode: FLEX`
- `flexteam-locale: ko`

S3 PUT is sent without these headers (AWS signature is in the URL).

## Appendix — captured workflow-document creation sequence (reference)

The following sequence was verified end-to-end (HTTP 200 throughout) for the
"비용 결제 요청" template with one attachment. Other templates likely differ
only in `templateKey`.

```
GET   /api/v3/approval-document-template/available-templates
POST  /action/v3/approval-document-template/templates/{tplKey}/resolve-policy
GET   /api/v2/file/restrictions/source-types

# Attachment (3-step pre-signed)
POST  /api/v2/file/users/me/files/temporary/pre-signed-url
      body: { name, size, sourceType: "WORKFLOW_TASK_ATTACHMENT", sensitiveFile: false, mimeType }
      → { fileKey: "<temp>", uploadUrl: "https://flex-prod-storage.s3..." }
PUT   <uploadUrl>            # body = file bytes, content-type must match
GET   /api/v2/file/users/me/files/temporary/<temp>/pre-signed-url/verify

# Draft → permanent fileKey swap → submit
POST  /api/v3/approval-document/approval-documents/draft
      → { draft: { document: { documentKey: "<docKey>" } } }
POST  /api/v3/approval-document/approval-documents/draft?documentKey=<docKey>
      body.document.attachments=[{name, fileKey:"<temp>", uploaded:false}]
      → response attachments[].file.fileKey = "<perm>"
POST  /api/v3/approval-document/approval-documents?documentKey=<docKey>
      body.document.attachments=[{name, fileKey:"<perm>", uploaded:true}]
      → { document: { code: "2026-XXX", status: "IN_PROGRESS" } }
```

The UI emits multiple debounced draft updates between these steps, but the
flow appears compressible to **one draft create + one draft update (to swap
temp→perm fileKey) + submit**. Verify on first implementation.
