import QRCode from "qrcode";

export async function generateReservationQR(token: string): Promise<string> {
  const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (!base) {
    throw new Error("PUBLIC_URL no está definida");
  }
  const url = `${base}/checkin/${token}`;
  return QRCode.toDataURL(url, { margin: 1, width: 260, errorCorrectionLevel: "M" });
}
