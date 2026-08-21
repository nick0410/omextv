#!/usr/bin/env node
/**
 * Download the ONNX weights the local gender provider needs.
 *
 *   npm run models:fetch            # models only
 *   npm run models:fetch -- --fixtures   # also the sample images used by tests
 *
 * The weights are ~24 MB and deliberately not committed, so a fresh clone runs
 * against the mock provider until this is run.
 *
 * Every file is verified against a recorded SHA-256. A mismatch aborts rather
 * than leaving a half-written model on disk that would fail confusingly at
 * inference time.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

const ROOT = "https://github.com/onnx/models/raw/main/validated/vision/body_analysis";
const MODEL_DIR = process.env.GENDER_MODEL_DIR || path.join(process.cwd(), "models");

const MODELS = [
  {
    name: "detector.onnx",
    url: `${ROOT}/ultraface/models/version-RFB-320.onnx`,
    bytes: 1270727,
    sha256: "34cd7e60aeff28744c657de7a3dc64e872d506741de66987f3426f2b79f88017",
    what: "UltraFace RFB-320 face detector",
  },
  {
    name: "genderage.onnx",
    url: "https://huggingface.co/public-data/insightface/resolve/main/models/buffalo_l/genderage.onnx",
    bytes: 1322532,
    sha256: "4fde69b1c810857b88c64a335084f1c3fe8f01246c9a191b48c7bb756d6652fb",
    what: "InsightFace genderage (buffalo_l) — gender + age",
  },
];

const FIXTURES = [
  { name: "fixtures/kid.jpg", url: `${ROOT}/age_gender/dependencies/kid.jpg` },
  { name: "fixtures/faces1.jpg", url: `${ROOT}/ultraface/dependencies/1.jpg` },
  { name: "fixtures/faces2.jpg", url: `${ROOT}/ultraface/dependencies/2.jpg` },
];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (d) => hash.update(d))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write to a temp name first so an interrupted run cannot leave a truncated
  // file that looks valid to the loader.
  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

async function main() {
  const wantFixtures = process.argv.includes("--fixtures");
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  console.log(`target: ${MODEL_DIR}\n`);

  for (const model of MODELS) {
    const dest = path.join(MODEL_DIR, model.name);

    if (fs.existsSync(dest)) {
      const have = await sha256(dest);
      if (have === model.sha256) {
        console.log(`✓ ${model.name} already present and verified`);
        continue;
      }
      console.log(`… ${model.name} checksum differs, re-downloading`);
    }

    console.log(`↓ ${model.name} — ${model.what} (${(model.bytes / 1e6).toFixed(1)} MB)`);
    await download(model.url, dest);

    const got = await sha256(dest);
    if (got !== model.sha256) {
      fs.unlinkSync(dest);
      throw new Error(
        `checksum mismatch for ${model.name}\n  expected ${model.sha256}\n  got      ${got}`,
      );
    }
    console.log(`  verified ${got.slice(0, 16)}…`);
  }

  if (wantFixtures) {
    console.log("");
    for (const fixture of FIXTURES) {
      const dest = path.join(MODEL_DIR, fixture.name);
      if (fs.existsSync(dest)) {
        console.log(`✓ ${fixture.name} already present`);
        continue;
      }
      console.log(`↓ ${fixture.name}`);
      await download(fixture.url, dest);
    }
  }

  console.log("\nDone. Set GENDER_PROVIDER=onnx, then:");
  console.log("  npx tsx scripts/gender-check.ts");
}

main().catch((err) => {
  console.error(`\nfetch-models failed: ${err.message}`);
  process.exit(1);
});
