import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPreviewImageBytes } from "./preview-image";

const TEST_PROJECT = "999999";
const DIR = path.join(process.cwd(), "public", "project-images", TEST_PROJECT);
// 1x1 transparent PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("getPreviewImageBytes", () => {
  test("accepts underscore view names (exterior_street etc.) and generates a watermarked preview", async () => {
    await mkdir(DIR, { recursive: true });
    await writeFile(path.join(DIR, "exterior_street.png"), TINY_PNG);

    const result = await getPreviewImageBytes(TEST_PROJECT, "exterior_street", "png");
    expect(result).not.toBeNull();
    expect(result!.mime).toBe("image/jpeg");
    expect(result!.bytes.length).toBeGreaterThan(0);

    // Cached preview written to disk.
    const cached = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(DIR, "exterior_street.preview.jpg")).catch(() => null),
    );
    expect(cached).not.toBeNull();
    expect(cached!.length).toBeGreaterThan(0);
  });

  test("rejects invalid project ids and view names", async () => {
    expect(await getPreviewImageBytes("abc", "exterior_street", "jpg")).toBeNull();
    expect(await getPreviewImageBytes(TEST_PROJECT, "../../etc", "jpg")).toBeNull();
  });
});
