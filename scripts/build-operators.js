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

/*
 * Respect workflow values where useful,
 * but keep them within safe limits.
 */
const CONCURRENCY = clampInt(
  process.env.MLP_ARCHIVE_CONCURRENCY,
  2,
  1,
  4
);

const FETCH_TIMEOUT_MS = clampInt(
  process.env.MLP_ARCHIVE_TIMEOUT_MS,
  20000,
  5000,
  30000
);

/*
 * Intentionally capped at 3.
 *
 * The old workflow may still pass 5,
 * but 5 rounds × 3 gateways × long
 * timeouts can make a handful of bad
 * operators consume the entire job.
 */
const RETRY_ROUNDS = clampInt(
  process.env.MLP_ARCHIVE_RETRIES,
  3,
  1,
  3
);

/*
 * Smaller batches make every GitHub
 * Action predictable and cumulative.
 */
const BATCH_SIZE = clampInt(
  process.env.MLP_ARCHIVE_BATCH_SIZE,
  50,
  1,
  100
);

const ALLOW_PARTIAL =
  process.env
    .MLP_ARCHIVE_ALLOW_PARTIAL === "1";

const FORCE =
  new Set(
    process.argv.slice(2)
  ).has("--force");


/* ============================================================
   BASIC HELPERS
   ============================================================ */

function clampInt(
  value,
  fallback,
  min,
  max
) {
  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed)
  ) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(parsed)
    )
  );
}


function pad(id) {
  return String(id)
    .padStart(3, "0");
}


function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function jitter(base) {
  return Math.floor(
    base *
    (
      0.8 +
      Math.random() * 0.4
    )
  );
}


/* ============================================================
   ERC-721 TOKEN URI
   ============================================================ */

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

  if (
    clean.length < 128
  ) {
    throw new Error(
      "Malformed ABI string response"
    );
  }

  const offsetBytes =
    Number.parseInt(
      clean.slice(
        0,
        64
      ),
      16
    );

  const offset =
    offsetBytes * 2;

  const lengthHex =
    clean.slice(
      offset,
      offset + 64
    );

  if (!lengthHex) {
    throw new Error(
      "Malformed ABI string length"
    );
  }

  const length =
    Number.parseInt(
      lengthHex,
      16
    );

  const start =
    offset + 64;

  const end =
    start +
    length * 2;

  const data =
    clean.slice(
      start,
      end
    );

  if (
    data.length !==
    length * 2
  ) {
    throw new Error(
      "Truncated ABI string response"
    );
  }

  return Buffer
    .from(
      data,
      "hex"
    )
    .toString("utf8");
}


/* ============================================================
   DATA / IPFS URI HELPERS
   ============================================================ */

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

  const payload =
    match[3] || "";

  return {
    mime,

    buffer:
      isBase64
        ? Buffer.from(
            payload,
            "base64"
          )
        : Buffer.from(
            decodeURIComponent(
              payload
            ),
            "utf8"
          ),
  };
}


function ipfsKey(uri) {
  if (
    !uri?.startsWith(
      "ipfs://"
    )
  ) {
    return null;
  }

  return uri
    .slice(7)
    .replace(
      /^ipfs\//,
      ""
    );
}


/*
 * Rotate the preferred gateway by
 * operator ID instead of hammering
 * Pinata/IPFS.io first every time.
 */
function rotatedGatewayUrls(
  uri,
  seed = 0
) {
  const key =
    ipfsKey(uri);

  if (!key) {
    return [uri];
  }

  const start =
    Math.abs(
      Number(seed) || 0
    ) %
    IPFS_GATEWAYS.length;

  const ordered = [];

  for (
    let i = 0;
    i <
    IPFS_GATEWAYS.length;
    i++
  ) {
    const gateway =
      IPFS_GATEWAYS[
        (
          start + i
        ) %
        IPFS_GATEWAYS.length
      ];

    ordered.push(
      gateway + key
    );
  }

  return ordered;
}


/* ============================================================
   FETCH HELPERS
   ============================================================ */

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs =
    FETCH_TIMEOUT_MS
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      timeoutMs
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


function retryAfterMs(
  response
) {
  const value =
    response.headers.get(
      "retry-after"
    );

  if (!value) {
    return 0;
  }

  const seconds =
    Number(value);

  if (
    Number.isFinite(
      seconds
    )
  ) {
    return Math.min(
      10000,
      Math.max(
        0,
        seconds * 1000
      )
    );
  }

  const date =
    Date.parse(value);

  if (
    Number.isFinite(date)
  ) {
    return Math.min(
      10000,
      Math.max(
        0,
        date -
        Date.now()
      )
    );
  }

  return 0;
}


/*
 * IMPORTANT:
 *
 * Gateways are deliberately tried
 * SEQUENTIALLY.
 *
 * The earlier builder fired every
 * public gateway simultaneously.
 * That multiplied traffic and helped
 * trigger 429 rate limits.
 */
async function fetchFromGateways(
  uri,
  seed,
  handler,
  label
) {
  const data =
    decodeDataUri(uri);

  if (data) {
    return handler({
      url:
        uri,

      data,

      response:
        null,
    });
  }

  let lastError;

  for (
    let round = 0;
    round <
    RETRY_ROUNDS;
    round++
  ) {
    const urls =
      rotatedGatewayUrls(
        uri,
        seed + round
      );

    for (
      const url of urls
    ) {
      try {
        const timeout =
          label === "image"
            ? Math.min(
                FETCH_TIMEOUT_MS,
                18000
              )
            : Math.min(
                FETCH_TIMEOUT_MS,
                12000
              );

        const response =
          await fetchWithTimeout(
            url,
            {},
            timeout
          );

        if (
          response.status === 429
        ) {
          const wait =
            retryAfterMs(
              response
            );

          if (wait) {
            await sleep(
              wait
            );
          }

          throw new Error(
            `${url} -> HTTP 429`
          );
        }

        if (
          !response.ok
        ) {
          throw new Error(
            `${url} -> HTTP ${response.status}`
          );
        }

        return await handler({
          url,

          data:
            null,

          response,
        });
      } catch (error) {
        lastError =
          error;
      }
    }

    if (
      round <
      RETRY_ROUNDS - 1
    ) {
      await sleep(
        jitter(
          800 *
          2 ** round
        )
      );
    }
  }

  throw new Error(
    `${label} unavailable: ${
      lastError?.message ||
      lastError
    }`
  );
}


/* ============================================================
   ETHEREUM RPC
   ============================================================ */

async function rpcTokenUri(id) {
  let lastError;

  for (
    let round = 0;
    round <
    RETRY_ROUNDS;
    round++
  ) {
    const start =
      (
        id + round
      ) %
      RPCS.length;

    for (
      let i = 0;
      i <
      RPCS.length;
      i++
    ) {
      const url =
        RPCS[
          (
            start + i
          ) %
          RPCS.length
        ];

      try {
        const response =
          await fetchWithTimeout(
            url,
            {
              method:
                "POST",

              headers: {
                "content-type":
                  "application/json",
              },

              body:
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
                }),
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

        return decodeAbiString(
          json.result
        );
      } catch (error) {
        lastError =
          error;
      }
    }

    if (
      round <
      RETRY_ROUNDS - 1
    ) {
      await sleep(
        jitter(
          600 *
          2 ** round
        )
      );
    }
  }

  throw new Error(
    `tokenURI(${id}) unavailable: ${
      lastError?.message ||
      lastError
    }`
  );
}


/* ============================================================
   METADATA
   ============================================================ */

async function fetchJsonUri(
  uri,
  id
) {
  return fetchFromGateways(
    uri,

    id,

    async ({
      data,
      response,
    }) => {
      const text =
        data
          ? data.buffer
              .toString(
                "utf8"
              )
          : await response
              .text();

      try {
        return JSON.parse(
          text
        );
      } catch {
        throw new Error(
          "Metadata response was not valid JSON"
        );
      }
    },

    "metadata"
  );
}


/* ============================================================
   IMAGE FETCHING
   ============================================================ */

async function fetchBinaryUri(
  uri,
  id
) {
  return fetchFromGateways(
    uri,

    id + 17,

    async ({
      url,
      data,
      response,
    }) => {
      if (data) {
        return {
          buffer:
            data.buffer,

          mime:
            data.mime,

          sourceUrl:
            url,
        };
      }

      const arrayBuffer =
        await response
          .arrayBuffer();

      return {
        buffer:
          Buffer.from(
            arrayBuffer
          ),

        mime:
          response.headers
            .get(
              "content-type"
            ) || "",

        sourceUrl:
          url,
      };
    },

    "image"
  );
}


/* ============================================================
   DIRECTORIES / JSON
   ============================================================ */

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


async function readJson(
  file,
  fallback
) {
  try {
    return JSON.parse(
      await fs.readFile(
        file,
        "utf8"
      )
    );
  } catch {
    return fallback;
  }
}


async function readArchive() {
  const archive =
    await readJson(
      ARCHIVE_PATH,
      {}
    );

  return (
    archive &&
    typeof archive ===
      "object"
  )
    ? archive
    : {};
}


/*
 * operator-build-failures.json
 * is already part of your GitHub
 * Actions cache.
 *
 * We now use it as persistent retry
 * state as well.
 */
async function readFailureState() {
  const raw =
    await readJson(
      FAIL_PATH,
      []
    );

  const map =
    new Map();

  if (
    !Array.isArray(raw)
  ) {
    return map;
  }

  for (
    const item of raw
  ) {
    const id =
      Number(
        item?.id
      );

    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > SUPPLY
    ) {
      continue;
    }

    map.set(
      id,
      {
        id,

        attempts:
          Math.max(
            1,
            Number(
              item.attempts
            ) || 1
          ),

        lastError:
          String(
            item.lastError ||
            item.error ||
            ""
          ),

        lastAttemptAt:
          item.lastAttemptAt ||
          null,
      }
    );
  }

  return map;
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
      "webp",

    thumbnailFormat:
      "webp",
  };

  const temp =
    `${ARCHIVE_PATH}.tmp`;

  await fs.writeFile(
    temp,

    JSON.stringify(
      archive,
      null,
      2
    ) + "\n",

    "utf8"
  );

  await fs.rename(
    temp,
    ARCHIVE_PATH
  );
}


async function saveFailureState(
  failureState,
  missingIds
) {
  const missing =
    new Set(
      missingIds
    );

  const rows =
    [
      ...failureState
        .values(),
    ]
      .filter(
        (item) =>
          missing.has(
            item.id
          )
      )
      .sort(
        (a, b) =>
          a.id - b.id
      );

  const temp =
    `${FAIL_PATH}.tmp`;

  await fs.writeFile(
    temp,

    JSON.stringify(
      rows,
      null,
      2
    ) + "\n",

    "utf8"
  );

  await fs.rename(
    temp,
    FAIL_PATH
  );
}


/* ============================================================
   OUTPUT VALIDATION
   ============================================================ */

async function fileReady(
  file,
  minBytes = 256
) {
  try {
    const stat =
      await fs.stat(
        file
      );

    return (
      stat.isFile() &&
      stat.size >=
        minBytes
    );
  } catch {
    return false;
  }
}


function fullPath(id) {
  return path.join(
    FULL_DIR,
    `${pad(id)}.webp`
  );
}


function thumbPath(id) {
  return path.join(
    THUMB_DIR,
    `${pad(id)}.webp`
  );
}


async function outputExists(id) {
  const [
    full,
    thumb,
  ] =
    await Promise.all([
      fileReady(
        fullPath(id)
      ),

      fileReady(
        thumbPath(id)
      ),
    ]);

  return (
    full &&
    thumb
  );
}


/* ============================================================
   LOCAL REPAIR
   ============================================================ */

/*
 * If a full image survived a canceled
 * workflow but its thumbnail did not,
 * rebuild the thumb locally rather
 * than touching IPFS again.
 */
async function repairThumbnailFromFull(
  id
) {
  const full =
    fullPath(id);

  const thumb =
    thumbPath(id);

  if (
    !(await fileReady(full)) ||
    (await fileReady(thumb))
  ) {
    return false;
  }

  const temp =
    `${thumb}.tmp`;

  await sharp(full)
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
        84,

      effort:
        4,
    })
    .toFile(
      temp
    );

  await fs.rename(
    temp,
    thumb
  );

  return true;
}


/* ============================================================
   IMAGE BUILD
   ============================================================ */

async function buildImages(
  id,
  imageUri
) {
  if (
    await repairThumbnailFromFull(
      id
    )
  ) {
    const meta =
      await sharp(
        fullPath(id)
      )
        .metadata();

    return {
      sourceUrl:
        null,

      mime:
        "image/webp",

      width:
        meta.width ||
        null,

      height:
        meta.height ||
        null,

      repairedLocally:
        true,
    };
  }

  const {
    buffer,
    sourceUrl,
    mime,
  } =
    await fetchBinaryUri(
      imageUri,
      id
    );

  const input =
    sharp(
      buffer,
      {
        animated:
          false,
      }
    ).rotate();

  const metadata =
    await input
      .metadata();

  /*
   * Write to temporary files first.
   *
   * If GitHub kills a workflow during
   * image conversion, the next run
   * won't mistake a half-written file
   * for a finished operator.
   */
  const fullTemp =
    `${fullPath(id)}.tmp`;

  const thumbTemp =
    `${thumbPath(id)}.tmp`;

  await input
    .clone()
    .webp({
      lossless:
        true,

      effort:
        4,
    })
    .toFile(
      fullTemp
    );

  await input
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
        84,

      effort:
        4,
    })
    .toFile(
      thumbTemp
    );

  await fs.rename(
    fullTemp,
    fullPath(id)
  );

  await fs.rename(
    thumbTemp,
    thumbPath(id)
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

    repairedLocally:
      false,
  };
}


/* ============================================================
   ATTRIBUTES
   ============================================================ */

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


/* ============================================================
   BUILD ONE OPERATOR
   ============================================================ */

async function buildOne(
  id,
  archive
) {
  const key =
    String(id);

  const existing =
    archive[key];

  /*
   * Fully complete local record.
   */
  if (
    !FORCE &&
    existing &&
    (await outputExists(id))
  ) {
    return {
      id,

      status:
        "cached",

      token:
        existing,
    };
  }

  /*
   * Metadata already exists but image
   * files are missing.
   *
   * Reuse canonicalImage so we don't
   * repeat tokenURI + metadata calls.
   */
  if (
    !FORCE &&
    existing &&
    typeof existing
      .canonicalImage ===
      "string" &&
    existing.canonicalImage
  ) {
    const source =
      await buildImages(
        id,
        existing
          .canonicalImage
      );

    existing.thumbnail =
      `/operators/thumbs/${pad(
        id
      )}.webp`;

    existing.image =
      `/operators/full/${pad(
        id
      )}.webp`;

    existing.source = {
      ...(
        existing.source ||
        {}
      ),

      resolvedImageUrl:
        source.sourceUrl
          ?.startsWith(
            "data:"
          )
          ? null
          : (
              source.sourceUrl ||
              existing.source
                ?.resolvedImageUrl ||
              null
            ),

      mime:
        source.mime ||
        existing.source
          ?.mime ||
        null,

      width:
        source.width,

      height:
        source.height,
    };

    archive[key] =
      existing;

    return {
      id,

      status:
        source
          .repairedLocally
          ? "repaired"
          : "image-rebuilt",

      token:
        existing,
    };
  }

  /*
   * Completely new operator.
   */
  const tokenURI =
    await rpcTokenUri(
      id
    );

  const metadata =
    await fetchJsonUri(
      tokenURI,
      id
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
          ?.startsWith(
            "data:"
          )
          ? null
          : (
              source.sourceUrl ||
              null
            ),

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


/* ============================================================
   CONCURRENCY
   ============================================================ */

async function mapConcurrent(
  items,
  concurrency,
  worker
) {
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
}


/* ============================================================
   MISSING RECORDS
   ============================================================ */

async function getMissingIds(
  archive
) {
  const missing =
    [];

  for (
    let id = 1;
    id <= SUPPLY;
    id++
  ) {
    if (
      FORCE ||
      !archive[
        String(id)
      ] ||
      !(
        await outputExists(
          id
        )
      )
    ) {
      missing.push(
        id
      );
    }
  }

  return missing;
}


/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  await ensureDirs();

  const archive =
    await readArchive();

  const failureState =
    await readFailureState();

  const missingBefore =
    await getMissingIds(
      archive
    );

  /*
   * CRITICAL IMPROVEMENT:
   *
   * Least-attempted operators go first.
   *
   * A handful of stubborn IDs can no
   * longer occupy the first 50 slots
   * forever and prevent the remaining
   * collection from being attempted.
   */
  const ids =
    [
      ...missingBefore,
    ]
      .sort(
        (a, b) => {
          const attemptsA =
            failureState
              .get(a)
              ?.attempts ||
            0;

          const attemptsB =
            failureState
              .get(b)
              ?.attempts ||
            0;

          if (
            attemptsA !==
            attemptsB
          ) {
            return (
              attemptsA -
              attemptsB
            );
          }

          return a - b;
        }
      )
      .slice(
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
    `Retry rounds: ${RETRY_ROUNDS}`
  );

  console.log(
    `Missing before run: ${missingBefore.length}`
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
  }

  let finished =
    0;

  let successes =
    0;

  let failuresThisRun =
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

        finished++;
        successes++;

        /*
         * Success means previous failure
         * history is no longer relevant.
         */
        failureState.delete(
          id
        );

        console.log(
          `[${pad(
            finished
          )}/${pad(
            ids.length
          )}] #${pad(
            id
          )} ${result.status} ✓`
        );

        /*
         * Save frequently.
         *
         * A canceled workflow should lose
         * at most a handful of operators.
         */
        if (
          successes %
          5 ===
          0
        ) {
          await saveArchive(
            archive
          );
        }
      } catch (error) {
        finished++;
        failuresThisRun++;

        const previous =
          failureState
            .get(id);

        failureState.set(
          id,
          {
            id,

            attempts:
              (
                previous
                  ?.attempts ||
                0
              ) + 1,

            lastError:
              error?.message ||
              String(error),

            lastAttemptAt:
              new Date()
                .toISOString(),
          }
        );

        console.error(
          `[${pad(
            finished
          )}/${pad(
            ids.length
          )}] #${pad(
            id
          )} FAILED — ${
            error?.message ||
            error
          }`
        );
      }
    }
  );

  /*
   * Always persist what succeeded.
   */
  await saveArchive(
    archive
  );

  const missingAfter =
    await getMissingIds(
      archive
    );

  await saveFailureState(
    failureState,
    missingAfter
  );

  const records =
    Object.keys(
      archive
    )
      .filter(
        (key) =>
          /^\d+$/.test(
            key
          )
      )
      .length;

  console.log("");

  console.log(
    "========================================"
  );

  if (
    missingAfter.length ===
      0 &&
    records ===
      SUPPLY
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
    `SUCCEEDED THIS RUN: ${successes}`
  );

  console.log(
    `FAILED THIS RUN: ${failuresThisRun}`
  );

  console.log(
    `REMAINING OPERATORS: ${missingAfter.length}`
  );

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
