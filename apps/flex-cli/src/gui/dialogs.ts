import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GuiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuiUnavailableError";
  }
}

class GuiCommandMissingError extends GuiUnavailableError {}

export interface GuiCredentials {
  email: string;
  password: string;
}

export async function promptGuiCredentials(defaultEmail: string): Promise<GuiCredentials> {
  const email = (await promptText({
    title: "flex-ax login",
    label: "Email",
    defaultValue: defaultEmail,
  })).trim();
  if (!email) {
    throw new GuiUnavailableError("이메일 입력이 비어있습니다.");
  }

  const password = await promptPassword(email);
  if (!password) {
    throw new GuiUnavailableError("비밀번호 입력이 비어있습니다.");
  }

  return { email, password };
}

export async function confirmGuiOverwrite(email: string): Promise<boolean> {
  return confirmDialog(
    "flex-ax login",
    `An OS keyring credential already exists for ${email}. Replace it?`,
    "Replace",
    "Cancel",
  );
}

export async function confirmGuiLogout(email: string): Promise<boolean> {
  return confirmDialog(
    "flex-ax logout",
    `Remove the OS keyring credential for ${email}?`,
    "Remove",
    "Cancel",
  );
}

async function promptText(options: {
  title: string;
  label: string;
  defaultValue: string;
}): Promise<string> {
  switch (process.platform) {
    case "darwin":
      return runAppleScriptText(options);
    case "win32":
      return runPowerShellText(options);
    default:
      return runLinuxText(options);
  }
}

async function promptPassword(email: string): Promise<string> {
  switch (process.platform) {
    case "darwin":
      return runAppleScriptPassword(email);
    case "win32":
      return runPowerShellPassword(email);
    default:
      return runLinuxPassword(email);
  }
}

async function confirmDialog(
  title: string,
  message: string,
  okLabel: string,
  cancelLabel: string,
): Promise<boolean> {
  switch (process.platform) {
    case "darwin":
      return runAppleScriptConfirm(title, message, okLabel, cancelLabel);
    case "win32":
      return runPowerShellConfirm(title, message, okLabel);
    default:
      return runLinuxConfirm(title, message, okLabel, cancelLabel);
  }
}

async function runAppleScriptText(options: {
  title: string;
  label: string;
  defaultValue: string;
}): Promise<string> {
  const script = `
on run argv
  set dialogTitle to item 1 of argv
  set dialogLabel to item 2 of argv
  set defaultValue to item 3 of argv
  display dialog dialogLabel default answer defaultValue with title dialogTitle buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
  return text returned of result
end run`;
  return runCommand("osascript", ["-e", script, options.title, options.label, options.defaultValue]);
}

async function runAppleScriptPassword(email: string): Promise<string> {
  const script = `
on run argv
  set emailAddress to item 1 of argv
  display dialog "Password for " & emailAddress default answer "" with hidden answer with title "flex-ax login" buttons {"Cancel", "OK"} default button "OK" cancel button "Cancel"
  return text returned of result
end run`;
  return runCommand("osascript", ["-e", script, email]);
}

async function runAppleScriptConfirm(
  title: string,
  message: string,
  okLabel: string,
  cancelLabel: string,
): Promise<boolean> {
  const script = `
on run argv
  set dialogTitle to item 1 of argv
  set dialogMessage to item 2 of argv
  set okLabel to item 3 of argv
  set cancelLabel to item 4 of argv
  display dialog dialogMessage with title dialogTitle buttons {cancelLabel, okLabel} default button okLabel cancel button cancelLabel
  return button returned of result
end run`;
  const output = await runCommand("osascript", ["-e", script, title, message, okLabel, cancelLabel]);
  return output === okLabel;
}

async function runPowerShellText(options: {
  title: string;
  label: string;
  defaultValue: string;
}): Promise<string> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $args[0]
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(420, 130)
$label = New-Object System.Windows.Forms.Label
$label.Text = $args[1]
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(12, 16)
$box = New-Object System.Windows.Forms.TextBox
$box.Text = $args[2]
$box.Width = 390
$box.Location = New-Object System.Drawing.Point(12, 44)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = "OK"
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = New-Object System.Drawing.Point(246, 86)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel"
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(327, 86)
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($box.Text) } else { exit 1 }`;
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    options.title,
    options.label,
    options.defaultValue,
  ]);
}

async function runPowerShellPassword(email: string): Promise<string> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = "flex-ax login"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(420, 130)
$label = New-Object System.Windows.Forms.Label
$label.Text = "Password for " + $args[0]
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(12, 16)
$box = New-Object System.Windows.Forms.TextBox
$box.Width = 390
$box.UseSystemPasswordChar = $true
$box.Location = New-Object System.Drawing.Point(12, 44)
$ok = New-Object System.Windows.Forms.Button
$ok.Text = "OK"
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = New-Object System.Drawing.Point(246, 86)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = "Cancel"
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object System.Drawing.Point(327, 86)
$form.Controls.AddRange(@($label, $box, $ok, $cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
if ($form.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($box.Text) } else { exit 1 }`;
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    email,
  ]);
}

async function runPowerShellConfirm(title: string, message: string, okLabel: string): Promise<boolean> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$result = [System.Windows.Forms.MessageBox]::Show($args[1], $args[0], [System.Windows.Forms.MessageBoxButtons]::OKCancel, [System.Windows.Forms.MessageBoxIcon]::Question)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($args[2]) } else { exit 1 }`;
  const output = await runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    title,
    message,
    okLabel,
  ]);
  return output === okLabel;
}

async function runLinuxText(options: {
  title: string;
  label: string;
  defaultValue: string;
}): Promise<string> {
  try {
    return await runCommand("zenity", [
      "--entry",
      "--title",
      options.title,
      "--text",
      options.label,
      "--entry-text",
      options.defaultValue,
    ]);
  } catch (error) {
    if (!isCommandMissing(error)) throw error;
    return runCommand("kdialog", [
      "--title",
      options.title,
      "--inputbox",
      options.label,
      options.defaultValue,
    ]);
  }
}

async function runLinuxPassword(email: string): Promise<string> {
  try {
    return await runCommand("zenity", [
      "--password",
      "--title",
      "flex-ax login",
      "--text",
      `Password for ${email}`,
    ]);
  } catch (error) {
    if (!isCommandMissing(error)) throw error;
    return runCommand("kdialog", ["--title", "flex-ax login", "--password", `Password for ${email}`]);
  }
}

async function runLinuxConfirm(
  title: string,
  message: string,
  okLabel: string,
  cancelLabel: string,
): Promise<boolean> {
  try {
    await runCommand("zenity", [
      "--question",
      "--title",
      title,
      "--text",
      message,
      "--ok-label",
      okLabel,
      "--cancel-label",
      cancelLabel,
    ]);
    return true;
  } catch (error) {
    if (!isCommandMissing(error)) throw error;
    await runCommand("kdialog", ["--title", title, "--yesno", message, "--yes-label", okLabel, "--no-label", cancelLabel]);
    return true;
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: 0,
      maxBuffer: 1024 * 64,
    });
    return stdout.replace(/\r?\n$/, "");
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new GuiCommandMissingError(guiInstallHint());
    }
    throw new GuiUnavailableError("GUI 입력이 취소되었거나 실행할 수 없습니다.");
  }
}

function isCommandMissing(error: unknown): boolean {
  return (
    error instanceof GuiCommandMissingError ||
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === 127)
  );
}

function guiInstallHint(): string {
  if (process.platform === "linux") {
    return "GUI 입력 도구를 찾을 수 없습니다. zenity 또는 kdialog를 설치하거나 `flex-ax login`을 사용하세요.";
  }
  return "GUI 입력 도구를 실행할 수 없습니다. `flex-ax login`을 사용하세요.";
}
