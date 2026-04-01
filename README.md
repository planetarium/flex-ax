# flex-ax

flex (HR SaaS)를 AI 친화적인 형태로 전환(AX)하는 monorepo 프로젝트.

## 구조

```
flex-ax/
├── apps/          # 애플리케이션
├── packages/      # 공유 패키지
├── turbo.json     # Turborepo 설정
└── package.json   # 루트 워크스페이스 설정
```

## 기술 스택

- **Monorepo**: pnpm workspaces + Turborepo
- **Language**: TypeScript
- **Runtime**: Node.js >= 20

## 시작하기

```bash
pnpm install
pnpm dev
```
