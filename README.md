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

## flex-cli Executable

`apps/flex-cli` can be compiled into a standalone executable with Bun.

```bash
cd apps/flex-cli
bun install
bun run build:exe
```

The compiled binary is written to `apps/flex-cli/bun-dist/`.

## Migrating From Node-based Installs

The official `flex-cli` release is now a standalone Bun executable instead of a Node-distributed package.

If you are using an older Node-based install, reinstall once from the GitHub release assets for your platform:

- Windows: download `flex-ax-windows-x64.exe`
- macOS (Apple Silicon): download `flex-ax-darwin-arm64`
- Linux (x64): download `flex-ax-linux-x64`

After downloading:

1. Stop any running `flex-ax` process.
2. Replace your old `flex-ax` binary or shim with the downloaded executable.
3. On macOS/Linux, make it executable with `chmod +x`.
4. Run the new executable directly from its installed location.

After this one-time reinstall, `flex-ax update` will use the standalone executable update path.
