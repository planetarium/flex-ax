declare module "*.sql" {
  const content: string;
  export default content;
}

declare module "bun:sqlite" {
  interface Statement {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  }
}
