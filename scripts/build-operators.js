import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const CONTRACT =
  "0x88faff5ba343a9ba7ca9502723b28e64089e3dc8";

const SUPPLY = 620;

const OPENSEA_ASSET =
  `https://opensea.io/item/ethereum/${CONTRACT}`;

const RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://cloudflare-eth.com",
];

const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://dweb.link/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
];

const ROOT = process.cwd();

const DATA_DIR =
  path.join(ROOT, "data");

const FULL_DIR =
  path.join(
    ROOT,
    "operators",
    "full"
  );

const THUMB_DIR =
  path.join(
    ROOT,
    "operators",
    "thumbs"
  );

const ARCHIVE_PATH =
  path.join(
    DATA_DIR,
    "operators.json"
  );

const FAIL_PATH =
  path.join(
    DATA_DIR,
    "operator-build-failures.json"
  );

const CONCURRENCY = Math.max(
  1,
  Number(
    process.env
      .MLP_ARCHIVE_CONCURRENCY || 2
  )
);

const FETCH_TIMEOUT_MS = Math.max(
  1500,
  Number(
    process.env
      .MLP_ARCHIVE_TIMEOUT_MS || 20000
  )
);

const RETRIES = Math.max(
  1,
  Number(
    process.env
      .MLP_ARCHIVE_RETRIES || 5
  )
);

const BATCH_SIZE = Math.max(
  1,
  Number(
    process.env
      .MLP_ARCHIVE_BATCH_SIZE || 75
  )
);

const args =
  new Set(
    process.argv.slice(2)
  );

const FORCE =
  args.has("--force");

const ALLOW_PARTIAL =
  process.env
    .MLP_ARCHIVE_ALLOW_PARTIAL === "1";

function pad(id) {
  return String(id)
    .padStart(3, "0");
}

function tokenUriCalldata(id) {
  return (
    "0xc87b56dd" +
    BigInt(id)
      .toString(16)
      .padStart(64, "0")
  );
}

function decodeAbiString(hex) {
  if (
    !hex ||
    hex === "0x"
  ) {
    throw new Error(
      "Empty ABI response"
    );
  }

  const clean =
    hex.slice(2);

  const offset =
    Number.parseInt(
      clean.slice(0, 64),
      16
    ) * 2;

  const length =
    Number.parseInt(
      clean.slice(
        offset,
        offset + 64
      ),
      16
    );

  const data =
    clean.slice(
      offset + 64,
      offset + 64 +
        length * 2
    );

  return Buffer
    .from(
      data,
      "hex"
    )
    .toString("utf8");
}

function ipfsCandidates(uri) {
  if (!uri) {
    return [];
  }

  if (
    !uri.startsWith(
      "ipfs://"
    )
  ) {
    return [uri];
  }

  const key =
    uri
      .slice(7)
      .replace(
        /^ipfs\//,
        ""
      );

  return IPFS_GATEWAYS
    .map(
      (gateway) =>
        gateway + key
    );
}

function decodeDataUri(uri) {
  const match =
    /^data:([^;,]+)?(;base64)?,(.*)$/s
      .exec(
        uri || ""
      );

  if (!match) {
    return null;
  }

  const mime =
    match[1] ||
    "application/octet-stream";

  const isBase64 =
    Boolean(match[2]);

  const raw =
    match[3] || "";

  const buffer =
    isBase64
      ? Buffer.from(
          raw,
          "base64"
        )
      : Buffer.from(
          decodeURIComponent(
            raw
          ),
          "utf8"
        );

  return {
    mime,
    buffer,
  };
}

async function fetchWithTimeout(
  url,
  options = {},
  timeout =
    FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeout
    );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal:
          controller.signal,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function retry(
  fn,
  label
) {
  let lastError;

  for (
    let attempt = 1;
    attempt <= RETRIES;
    attempt++
  ) {
    try {
      return await fn(
        attempt
      );
    } catch (error) {
      lastError =
        error;

      if (
        attempt <
        RETRIES
      ) {
        const wait =
          Math.min(
            5000,
            500 *
              2 **
                (attempt - 1)
          );

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              wait
            )
        );
      }
    }
  }

  throw new Error(
    `${label}: ${
      lastError?.message ||
      lastError
    }`
  );
}

async function firstSuccessful(
  functions,
  label
) {
  const settled =
    await Promise.allSettled(
      functions.map(
        (fn) => fn()
      )
    );

  for (
    const result of settled
  ) {
    if (
      result.status ===
      "fulfilled"
    ) {
      return result.value;
    }
  }

  const detail =
    settled
      .filter(
        (result) =>
          result.status ===
          "rejected"
      )
      .map(
        (result) =>
          result.reason
            ?.message ||
          String(
            result.reason
          )
      )
      .join(" | ");

  throw new Error(
    `${label} unavailable${
      detail
        ? `: ${detail}`
        : ""
    }`
  );
}

async function rpcTokenUri(
  id
) {
  const body =
    JSON.stringify({
      jsonrpc:
        "2.0",
      id,
      method:
        "eth_call",
      params: [
        {
          to:
            CONTRACT,
          data:
            tokenUriCalldata(
              id
            ),
        },
        "latest",
      ],
    });

  const result =
    await retry(
      () =>
        firstSuccessful(
          RPCS.map(
            (url) =>
              async () => {
                const response =
                  await fetchWithTimeout(
                    url,
                    {
                      method:
                        "POST",
                      headers:
                        {
                          "content-type":
                            "application/json",
                        },
                      body,
                    },
                    Math.min(
                      FETCH_TIMEOUT_MS,
                      10000
                    )
                  );

                if (
                  !response.ok
                ) {
                  throw new Error(
                    `${url} -> HTTP ${response.status}`
                  );
                }

                const json =
                  await response
                    .json();

                if (
                  json.error
                ) {
                  throw new Error(
                    json.error
                      .message ||
                    "RPC error"
                  );
                }

                if (
                  !json.result
                ) {
                  throw new Error(
                    "RPC returned no result"
                  );
                }

                return json
                  .result;
              }
          ),
          `RPC tokenURI(${id})`
        ),
      `tokenURI(${id})`
    );

  return decodeAbiString(
    result
  );
}

async function fetchJsonUri(
  uri
) {
  const data =
    decodeDataUri(uri);

  if (data) {
    return JSON.parse(
      data.buffer
        .toString(
          "utf8"
        )
    );
  }

  return retry(
    () =>
      firstSuccessful(
        ipfsCandidates(
          uri
        ).map(
          (url) =>
            async () => {
              const response =
                await fetchWithTimeout(
                  url,
                  {
                    headers:
                      {
                        accept:
                          "application/json",
                      },
                  }
                );

              if (
                !response.ok
              ) {
                throw new Error(
                  `${url} -> HTTP ${response.status}`
                );
              }

              return response
                .json();
            }
        ),
        "metadata gateway"
      ),
    "metadata"
  );
}

async function fetchBinaryUri(
  uri
) {
  const data =
    decodeDataUri(uri);

  if (data) {
    return {
      buffer:
        data.buffer,
      sourceUrl:
        uri,
      mime:
        data.mime,
    };
  }

  return retry(
    () =>
      firstSuccessful(
        ipfsCandidates(
          uri
        ).map(
          (url) =>
            async () => {
              const response =
                await fetchWithTimeout(
                  url
                );

              if (
                !response.ok
              ) {
                throw new Error(
                  `${url} -> HTTP ${response.status}`
                );
              }

              const arrayBuffer =
                await response
                  .arrayBuffer();

              return {
                buffer:
                  Buffer.from(
                    arrayBuffer
                  ),
                sourceUrl:
                  url,
                mime:
                  response
                    .headers
                    .get(
                      "content-type"
                    ) || "",
              };
            }
        ),
        "image gateway"
      ),
    "image"
  );
}

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(
      DATA_DIR,
      {
        recursive:
          true,
      }
    ),

    fs.mkdir(
      FULL_DIR,
      {
        recursive:
          true,
      }
    ),

    fs.mkdir(
      THUMB_DIR,
      {
        recursive:
          true,
      }
    ),
  ]);
}

async function readArchive() {
  try {
    const data =
      JSON.parse(
        await fs.readFile(
          ARCHIVE_PATH,
          "utf8"
        )
      );

    return (
      data &&
      typeof data ===
        "object"
    )
      ? data
      : {};
  } catch {
    return {};
  }
}

async function saveArchive(
  archive
) {
  archive._meta = {
    contract:
      CONTRACT,

    supply:
      SUPPLY,

    generatedAt:
      new Date()
        .toISOString(),

    fullFormat:
      "lossless-webp",

    thumbnailFormat:
      "webp",
  };

  await fs.writeFile(
    ARCHIVE_PATH,
    JSON.stringify(
      archive,
      null,
      2
    ) + "\n"
  );
}

async function outputExists(
  id
) {
  try {
    await Promise.all([
      fs.access(
        path.join(
          FULL_DIR,
          `${pad(
            id
          )}.webp`
        )
      ),

      fs.access(
        path.join(
          THUMB_DIR,
          `${pad(
            id
          )}.webp`
        )
      ),
    ]);

    return true;
  } catch {
    return false;
  }
}

async function buildImages(
  id,
  imageUri
) {
  const {
    buffer,
    sourceUrl,
    mime,
  } =
    await fetchBinaryUri(
      imageUri
    );

  const base =
    sharp(
      buffer,
      {
        animated:
          false,
      }
    ).rotate();

  const metadata =
    await base.metadata();

  await base
    .clone()
    .webp({
      lossless:
        true,
      effort:
        4,
    })
    .toFile(
      path.join(
        FULL_DIR,
        `${pad(
          id
        )}.webp`
      )
    );

  await base
    .clone()
    .resize({
      width:
        360,
      height:
        360,
      fit:
        "inside",
      withoutEnlargement:
        true,
      kernel:
        sharp.kernel
          .lanczos3,
    })
    .webp({
      quality:
        82,
      effort:
        4,
    })
    .toFile(
      path.join(
        THUMB_DIR,
        `${pad(
          id
        )}.webp`
      )
    );

  return {
    sourceUrl,
    mime,

    width:
      metadata.width ||
      null,

    height:
      metadata.height ||
      null,
  };
}

function normalizeAttributes(
  attributes
) {
  if (
    !Array.isArray(
      attributes
    )
  ) {
    return [];
  }

  return attributes
    .filter(
      (attribute) =>
        attribute &&
        typeof attribute ===
          "object"
    )
    .map(
      (attribute) => ({
        trait_type:
          String(
            attribute
              .trait_type ??
            attribute.type ??
            "Trait"
          ),

        value:
          attribute.value ??
          "",
      })
    );
}

async function buildOne(
  id,
  archive
) {
  const key =
    String(id);

  if (
    !FORCE &&
    archive[key] &&
    (await outputExists(
      id
    ))
  ) {
    return {
      id,
      status:
        "cached",
      token:
        archive[key],
    };
  }

  const tokenURI =
    await rpcTokenUri(
      id
    );

  const metadata =
    await fetchJsonUri(
      tokenURI
    );

  const imageUri =
    metadata.image ||
    metadata.image_url ||
    metadata.image_data;

  if (
    !imageUri ||
    typeof imageUri !==
      "string"
  ) {
    throw new Error(
      "Metadata has no usable image URI"
    );
  }

  const source =
    await buildImages(
      id,
      imageUri
    );

  const token = {
    id,

    name:
      metadata.name ||
      `Milady Line Printer #${id}`,

    description:
      metadata.description ||
      "Milady Line Printer operator.",

    thumbnail:
      `/operators/thumbs/${pad(
        id
      )}.webp`,

    image:
      `/operators/full/${pad(
        id
      )}.webp`,

    attributes:
      normalizeAttributes(
        metadata.attributes
      ),

    canonicalMetadata:
      tokenURI,

    canonicalImage:
      imageUri,

    opensea:
      `${OPENSEA_ASSET}/${id}`,

    source: {
      resolvedImageUrl:
        source.sourceUrl
          .startsWith(
            "data:"
          )
          ? null
          : source
              .sourceUrl,

      mime:
        source.mime ||
        null,

      width:
        source.width,

      height:
        source.height,
    },
  };

  archive[key] =
    token;

  return {
    id,
    status:
      "built",
    token,
  };
}

async function mapConcurrent(
  items,
  concurrency,
  worker
) {
  const results =
    new Array(
      items.length
    );

  let cursor =
    0;

  async function runner() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      results[index] =
        await worker(
          items[index],
          index
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            items.length
          ),
      },
      () => runner()
    )
  );

  return results;
}

async function main() {
  await ensureDirs();

  const archive =
    await readArchive();

  const failures =
    [];

  const allIds =
    Array.from(
      {
        length:
          SUPPLY,
      },
      (
        _,
        index
      ) =>
        index + 1
    );

  const missingIds =
    [];

  for (
    const id of allIds
  ) {
    const key =
      String(id);

    const complete =
      archive[key] &&
      (await outputExists(id));

    if (
      FORCE ||
      !complete
    ) {
      missingIds.push(
        id
      );
    }
  }

  const ids =
    missingIds.slice(
      0,
      BATCH_SIZE
    );

  console.log(
    "MLP STATIC ARCHIVE"
  );

  console.log(
    `Contract: ${CONTRACT}`
  );

  console.log(
    `Supply:   ${SUPPLY}`
  );

  console.log(
    `Workers:  ${CONCURRENCY}`
  );

  console.log(
    `Batch:    ${BATCH_SIZE}`
  );

  console.log(
    `Missing before run: ${missingIds.length}`
  );

  console.log(
    `Attempting this run: ${ids.length}`
  );

  console.log(
    `Force:    ${
      FORCE
        ? "YES"
        : "NO"
    }`
  );

  console.log(
    `Partial:  ${
      ALLOW_PARTIAL
        ? "YES"
        : "NO"
    }`
  );

  console.log("");

  if (
    ids.length === 0
  ) {
    console.log(
      "NO MISSING OPERATORS"
    );

    console.log(
      "Archive already appears complete."
    );
  }

  let completed =
    0;

  await mapConcurrent(
    ids,
    CONCURRENCY,
    async (id) => {
      try {
        const result =
          await buildOne(
            id,
            archive
          );

        completed++;

        const mark =
          result.status ===
          "cached"
            ? "cache"
            : "metadata ✓ image ✓ thumb ✓";

        console.log(
          `[${pad(
            completed
          )}/${pad(
            ids.length
          )}] #${pad(
            id
          )} ${mark}`
        );

        if (
          result.status ===
          "built" &&
          completed % 10 ===
            0
        ) {
          await saveArchive(
            archive
          );
        }

        return result;
      } catch (
        error
      ) {
        completed++;

        failures.push({
          id,

          error:
            error?.message ||
            String(
              error
            ),
        });

        console.error(
          `[${pad(
            completed
          )}/${pad(
            ids.length
          )}] #${pad(
            id
          )} FAILED — ${
            error?.message ||
            error
          }`
        );

        return null;
      }
    }
  );

  await saveArchive(
    archive
  );

  await fs.writeFile(
    FAIL_PATH,
    JSON.stringify(
      failures,
      null,
      2
    ) + "\n"
  );

  const records =
    Object.keys(
      archive
    ).filter(
      (key) =>
        /^\d+$/.test(
          key
        )
    ).length;

  const imageChecks =
    await Promise.all(
      allIds.map(
        async (id) => ({
          id,

          ok:
            await outputExists(
              id
            ),
        })
      )
    );

  const missingImages =
    imageChecks
      .filter(
        (item) =>
          !item.ok
      )
      .map(
        (item) =>
          item.id
      );

  console.log("");

  console.log(
    "========================================"
  );

  if (
    records ===
      SUPPLY &&
    missingImages.length ===
      0
  ) {
    console.log(
      "ARCHIVE COMPLETE"
    );

    console.log(
      `${SUPPLY} / ${SUPPLY} OPERATORS VERIFIED`
    );

    console.log(
      "========================================"
    );

    return;
  }

  console.log(
    "ARCHIVE INCOMPLETE"
  );

  console.log(
    `JSON RECORDS: ${records} / ${SUPPLY}`
  );

  console.log(
    `FAILED THIS RUN: ${failures.length}`
  );

  console.log(
    `MISSING IMAGE SETS: ${missingImages.length}`
  );

  console.log(
    `REMAINING OPERATORS: ${missingImages.length}`
  );

  if (
    failures.length
  ) {
    console.log(
      `FAILED IDS THIS RUN: ${
        failures
          .map(
            (item) =>
              item.id
          )
          .join(", ")
      }`
    );
  }

  console.log(
    `Details: ${
      path.relative(
        ROOT,
        FAIL_PATH
      )
    }`
  );

  console.log(
    "========================================"
  );

  if (
    ALLOW_PARTIAL
  ) {
    console.log(
      "PARTIAL ARCHIVE SAVED — SAFE TO RESUME ON NEXT RUN"
    );

    return;
  }

  process.exitCode =
    1;
}

main().catch(
  (error) => {
    console.error(
      error
    );

    process.exitCode =
      1;
  }
);
