import sharp from "sharp";

export async function preprocessProductImage(input: Buffer) {
  let source = input;

  // Optional background removal. If not configured, normalization still runs.
  if (process.env.REMOVE_BG_API_KEY) {
    const form = new FormData();
    form.append("size", "auto");
    form.append("format", "png");
    form.append("image_file", new Blob([new Uint8Array(input)]), "product.png");
    const response = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": process.env.REMOVE_BG_API_KEY },
      body: form,
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`Background removal failed (${response.status}): ${await response.text()}`);
    source = Buffer.from(await response.arrayBuffer());
  }

  return sharp(source, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .normalize()
    .png({ compressionLevel: 9 })
    .toBuffer();
}
