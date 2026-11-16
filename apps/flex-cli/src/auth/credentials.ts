/** 화면에 보이는 한 줄 입력 (이메일·인증 코드용). 프롬프트는 stderr — stdout은 명령 결과 전용. */
export function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("TTY가 아니라 입력을 받을 수 없습니다."));
      return;
    }
    import("node:readline/promises").then(async ({ createInterface }) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(prompt);
        resolve(answer.trim());
      } catch (err) {
        reject(err);
      } finally {
        rl.close();
      }
    });
  });
}
