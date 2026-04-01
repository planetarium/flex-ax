import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  inputPath: z.string().min(1, "INPUT_PATH is required"),
  googleCredentialsPath: z.string().min(1, "GOOGLE_CREDENTIALS_PATH is required"),
  spreadsheetId: z.string().optional(),
  spreadsheetName: z.string().optional(),
});

export type UploaderConfig = z.infer<typeof configSchema>;

export function loadConfig(): UploaderConfig {
  return configSchema.parse({
    inputPath: process.env.INPUT_PATH,
    googleCredentialsPath: process.env.GOOGLE_CREDENTIALS_PATH,
    spreadsheetId: process.env.SPREADSHEET_ID || undefined,
    spreadsheetName: process.env.SPREADSHEET_NAME || undefined,
  });
}
