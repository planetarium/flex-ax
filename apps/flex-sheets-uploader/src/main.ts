import { loadConfig } from "./config/index.js";
import { createLogger } from "./logger/index.js";
import { readInputData } from "./reader/index.js";
import { transformAll } from "./transformer/index.js";
import { createSheetsClient } from "./sheets/index.js";
import type { UploadResult } from "./types/common.js";

function generateSpreadsheetName(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `flex-workflow-data-${yyyy}-${mm}-${dd}`;
}

async function main() {
  const logger = createLogger();

  // 1. 설정 로딩
  logger.info("설정 로딩...");
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("설정 로딩 실패. .env 파일을 확인하세요.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
  logger.info("설정 로딩 완료", {
    inputPath: config.inputPath,
    spreadsheetId: config.spreadsheetId ?? "(새로 생성)",
  });

  // 2. JSON 데이터 읽기
  let readResult;
  try {
    readResult = await readInputData(config.inputPath, logger);
  } catch (error) {
    logger.error("JSON 데이터 읽기 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  logger.info("JSON 데이터 읽기 완료", {
    templates: readResult.templates.length,
    instances: readResult.instances.length,
    attendances: readResult.attendances.length,
    crawlReport: readResult.crawlReport ? "있음" : "없음",
    errors: readResult.errors.length,
  });

  // 3. 스프레드시트 변환
  logger.info("스프레드시트 변환 시작...");
  const transformResult = transformAll(readResult);
  logger.info("스프레드시트 변환 완료", {
    sheetCount: transformResult.sheets.length,
    totalRows: transformResult.sheets.reduce((sum, s) => sum + s.rows.length, 0),
  });

  // 4. Google Sheets 인증
  let sheetsClient;
  try {
    sheetsClient = await createSheetsClient(config.googleCredentialsPath, logger);
  } catch (error) {
    logger.error("Google Sheets API 인증 실패", {
      error: error instanceof Error ? error.message : String(error),
      credentialsPath: config.googleCredentialsPath,
    });
    process.exit(1);
  }

  // 5. Google Sheets 업로드
  let uploadResult: UploadResult;
  try {
    if (config.spreadsheetId) {
      uploadResult = await sheetsClient.overwriteAndUpload(
        config.spreadsheetId,
        transformResult.sheets,
      );
    } else {
      const name = config.spreadsheetName ?? generateSpreadsheetName();
      uploadResult = await sheetsClient.createAndUpload(name, transformResult.sheets);
    }
  } catch (error) {
    logger.error("Google Sheets 업로드 실패", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }

  // 6. 결과 요약 출력
  console.log("\n");
  console.log("=".repeat(60));
  console.log("  업로드 결과 요약");
  console.log("=".repeat(60));
  console.log(`  스프레드시트 URL: ${uploadResult.spreadsheetUrl}`);
  console.log("-".repeat(60));

  for (const sheet of uploadResult.sheets) {
    console.log(`  ${sheet.title}: ${sheet.rowCount}행`);
  }

  console.log("-".repeat(60));

  if (readResult.errors.length > 0) {
    console.log(`  건너뛴 파일: ${readResult.errors.length}건`);
    for (const err of readResult.errors) {
      console.log(`    - ${err.filePath}: ${err.reason}`);
    }
  } else {
    console.log("  건너뛴 파일: 0건");
  }

  console.log("=".repeat(60));
}

main();
