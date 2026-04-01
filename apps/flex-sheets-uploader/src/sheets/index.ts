import { google } from "googleapis";
import type { sheets_v4 } from "googleapis";
import type { SheetData } from "../types/sheet.js";
import type { UploadResult } from "../types/common.js";
import type { Logger } from "../logger/index.js";

export interface SheetsClient {
  /**
   * 새 스프레드시트를 생성하고 데이터를 업로드한다 (FR-011).
   */
  createAndUpload(name: string, sheets: SheetData[]): Promise<UploadResult>;

  /**
   * 기존 스프레드시트에 데이터를 덮어쓴다 (FR-012).
   */
  overwriteAndUpload(spreadsheetId: string, sheets: SheetData[]): Promise<UploadResult>;
}

/**
 * 시트 데이터 배열을 batchUpdate 형식의 ValueRange 배열로 변환한다.
 */
function toValueRanges(sheets: SheetData[]): sheets_v4.Schema$ValueRange[] {
  return sheets.map((sheet) => ({
    range: `'${sheet.title}'!A1`,
    values: [sheet.headers, ...sheet.rows],
  }));
}

/**
 * 업로드 결과를 구성한다.
 */
function buildUploadResult(
  spreadsheetId: string,
  sheets: SheetData[],
): UploadResult {
  return {
    spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    sheets: sheets.map((s) => ({
      title: s.title,
      rowCount: s.rows.length,
    })),
  };
}

/**
 * Google Sheets API 클라이언트를 생성한다.
 */
export async function createSheetsClient(
  credentialsPath: string,
  logger: Logger,
): Promise<SheetsClient> {
  logger.info("Google Sheets API 인증 시작...", { credentialsPath });

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheetsApi = google.sheets({ version: "v4", auth });

  logger.info("Google Sheets API 인증 완료");

  return {
    async createAndUpload(name: string, sheets: SheetData[]): Promise<UploadResult> {
      logger.info(`새 스프레드시트 생성: "${name}"`);

      // 1. 스프레드시트 생성 (시트 탭 포함)
      const createResponse = await sheetsApi.spreadsheets.create({
        requestBody: {
          properties: { title: name },
          sheets: sheets.map((s) => ({
            properties: { title: s.title },
          })),
        },
      });

      const spreadsheetId = createResponse.data.spreadsheetId!;
      logger.info("스프레드시트 생성 완료", { spreadsheetId });

      // 2. 데이터 기록 (batchUpdate)
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: toValueRanges(sheets),
        },
      });

      logger.info("데이터 기록 완료");

      return buildUploadResult(spreadsheetId, sheets);
    },

    async overwriteAndUpload(spreadsheetId: string, sheets: SheetData[]): Promise<UploadResult> {
      logger.info(`기존 스프레드시트 덮어쓰기: ${spreadsheetId}`);

      // 1. 기존 스프레드시트 접근 확인 및 기존 시트 목록 조회
      let existingSheets: sheets_v4.Schema$Sheet[];
      try {
        const getResponse = await sheetsApi.spreadsheets.get({
          spreadsheetId,
        });
        existingSheets = getResponse.data.sheets ?? [];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `스프레드시트에 접근할 수 없습니다 (ID: ${spreadsheetId}): ${message}`,
        );
      }

      // 2. 새 시트 추가 → 기존 시트 삭제 (batchUpdate)
      const requests: sheets_v4.Schema$Request[] = [];

      // 새 시트 추가
      for (const sheet of sheets) {
        requests.push({
          addSheet: {
            properties: { title: sheet.title },
          },
        });
      }

      // 기존 시트 삭제 (최소 1개 시트가 있어야 하므로 새 시트 추가 후 삭제)
      for (const existing of existingSheets) {
        const sheetId = existing.properties?.sheetId;
        if (sheetId != null) {
          requests.push({
            deleteSheet: { sheetId },
          });
        }
      }

      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests },
      });

      logger.info("기존 시트 교체 완료");

      // 3. 데이터 기록
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: toValueRanges(sheets),
        },
      });

      logger.info("데이터 기록 완료");

      return buildUploadResult(spreadsheetId, sheets);
    },
  };
}
