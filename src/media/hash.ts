import sharp from "sharp";

/** 평균 해시(aHash) — 재인코딩·리사이즈에 강한 지각적 해시 (8x8=64bit) */
export async function aHash(buf: Buffer): Promise<bigint> {
  const size = 8;
  const data = await sharp(buf, { failOn: "none" })
    .greyscale()
    .resize(size, size, { fit: "fill" })
    .raw()
    .toBuffer();
  let sum = 0;
  for (const b of data) sum += b;
  const avg = sum / data.length;
  let bits = 0n;
  for (let i = 0; i < data.length; i++) {
    bits = (bits << 1n) | (data[i]! > avg ? 1n : 0n);
  }
  return bits;
}

/** 두 해시의 해밍 거리 (0=동일) */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let c = 0;
  while (x) {
    c += Number(x & 1n);
    x >>= 1n;
  }
  return c;
}
