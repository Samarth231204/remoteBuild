import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { writeFile } from 'node:fs/promises';

export function printQrToTerminal(payload) {
  qrcodeTerminal.generate(payload, { small: true });
}

export async function saveQrPng(payload, filePath) {
  await QRCode.toFile(filePath, payload, { width: 400, margin: 2 });
  return filePath;
}
