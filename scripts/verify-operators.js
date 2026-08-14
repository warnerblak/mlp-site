import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SUPPLY = 620;
const ROOT = process.cwd();

const ARCHIVE_PATH = path.join(
  ROOT,
  "data",
  "operators.json"
);

const FULL_DIR = path.join(
  ROOT,
  "operators",
  "full"
);

const THUMB_DIR = path.join(
  ROOT,
  "operators",
  "thumbs"
);

const pad = (id) =>
  String(id).padStart(3, "0");

async function exists(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function main() {
  let archive;

  try {
    archive = JSON.parse(
      await fs.readFile(
        ARCHIVE_PATH,
        "utf8"
      )
    );
  } catch {
    console.error(
      `Cannot read ${ARCHIVE_PATH}`
    );
    process.exit(1);
  }

  const failures = [];

  for (
    let id = 1;
    id <= SUPPLY;
    id++
  ) {
    const token =
      archive[String(id)];

    if (!token) {
      failures.push(
        `#${pad(id)} missing JSON record`
      );
      continue;
    }

    if (!token.name) {
      failures.push(
        `#${pad(id)} missing name`
      );
    }

    if (
      !Array.isArray(
        token.attributes
      )
    ) {
      failures.push(
        `#${pad(
          id
        )} attributes is not an array`
      );
    }

    const full = path.join(
      FULL_DIR,
      `${pad(id)}.webp`
    );

    const thumb = path.join(
      THUMB_DIR,
      `${pad(id)}.webp`
    );

    if (
      !(await exists(full))
    ) {
      failures.push(
        `#${pad(
          id
        )} missing full image`
      );
    }

    if (
      !(await exists(thumb))
    ) {
      failures.push(
        `#${pad(
          id
        )} missing thumbnail`
      );
    }
  }

  if (failures.length) {
    console.error(
      `ARCHIVE VERIFY FAILED — ${failures.length} issue(s)`
    );

    failures.forEach(
      (failure) =>
        console.error(
          `- ${failure}`
        )
    );

    process.exit(1);
  }

  console.log(
    "ARCHIVE VERIFIED"
  );

  console.log(
    "620 / 620 JSON records"
  );

  console.log(
    "620 / 620 full images"
  );

  console.log(
    "620 / 620 thumbnails"
  );
}

main();
