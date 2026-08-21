/**
 * Exercise the real ONNX gender pipeline.
 *
 *   npx tsx scripts/gender-check.ts                     # synthetic smoke test
 *   npx tsx scripts/gender-check.ts photo.jpg [...]     # run on real photos
 *
 * With no arguments it proves the wiring end to end: models load, tensors have
 * the shapes the graphs expect, and a face-free frame is correctly reported as
 * "no face" rather than a confident guess.
 *
 * With image paths it prints the verdict per file. That is how you confirm the
 * class order is right for your build of the model: run it on a few photos
 * whose gender you know, and if every answer is inverted, flip
 * GENDER_CLASS_ORDER (see .env.example).
 */
import fs from "fs";
import path from "path";
import jpeg from "jpeg-js";
import { OnnxGenderProvider } from "../src/services/gender/onnx";
import { GenderService, DEFAULT_GENDER_CONFIG } from "../src/services/gender/service";

const MODEL_DIR = process.env.GENDER_MODEL_DIR || path.join(process.cwd(), "models");

/** A flat grey frame — no face anywhere in it. */
function syntheticFrame(width = 640, height = 480): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const noise = (i * 37) % 24;
    data[i * 4 + 0] = 120 + noise;
    data[i * 4 + 1] = 120 + noise;
    data[i * 4 + 2] = 120 + noise;
    data[i * 4 + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data, width, height }, 90).data);
}

async function main(): Promise<void> {
  console.log(`model dir: ${MODEL_DIR}`);
  for (const f of ["detector.onnx", "genderage.onnx"]) {
    const p = path.join(MODEL_DIR, f);
    if (!fs.existsSync(p)) {
      console.error(`  MISSING ${f} — see server/README.md`);
      process.exit(1);
    }
    console.log(`  ${f}  ${(fs.statSync(p).size / 1024 / 1024).toFixed(2)} MB`);
  }

  const provider = new OnnxGenderProvider({ modelDir: MODEL_DIR });

  const t0 = Date.now();
  await provider.init();
  console.log(`\nmodels loaded in ${Date.now() - t0} ms, ready=${provider.isReady()}`);

  const images = process.argv.slice(2);

  if (images.length === 0) {
    console.log("\n--- synthetic frame (no face expected) ---");
    const result = await provider.infer(syntheticFrame());
    console.log(
      `  gender=${result.gender} confidence=${result.confidence} ` +
        `faces=${result.faceCount} latency=${result.latencyMs}ms`,
    );
    if (result.gender !== "unknown") {
      console.error("  ! a face-free frame produced a gender — check the detector threshold");
      process.exitCode = 1;
    } else {
      console.log("  OK: correctly reported no face");
    }

    // The service layer should turn that into a "no_face" outcome.
    const service = new GenderService(provider, DEFAULT_GENDER_CONFIG);
    console.log(
      `\n  service threshold=${DEFAULT_GENDER_CONFIG.threshold} ` +
        `provider=${service.getProviderName()}`,
    );
    console.log("\nPass image paths to test real photos.");
  } else {
    console.log("\n--- real images ---");
    for (const file of images) {
      if (!fs.existsSync(file)) {
        console.log(`  ${file}: NOT FOUND`);
        continue;
      }
      const buf = fs.readFileSync(file);
      const started = Date.now();
      const r = await provider.infer(buf);
      const verdict =
        r.gender === "unknown"
          ? "no face detected"
          : `${r.gender}  (${(r.confidence * 100).toFixed(1)}% confident)`;
      const age = r.age !== undefined ? `age~${r.age}` : "";
      console.log(
        `  ${path.basename(file).padEnd(28)} ${verdict.padEnd(30)} ${age.padEnd(8)} ` +
          `faces=${r.faceCount} ${Date.now() - started}ms`,
      );
    }
    console.log(
      "\nIf every answer is inverted, set GENDER_CLASS_ORDER=female,male in .env.",
    );
  }

  await provider.dispose();
}

main().catch((err) => {
  console.error("gender-check failed:", err);
  process.exit(1);
});
