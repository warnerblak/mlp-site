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


/* ============================================================
   CONFIGURATION
   ============================================================ */

const CONCURRENCY =
  envInt(
    "MLP_ARCHIVE_CONCURRENCY",
    3,
    1,
    6
  );

const FETCH_TIMEOUT_MS =
  envInt(
    "MLP_ARCHIVE_TIMEOUT_MS",
    15000,
    5000,
    30000
  );

const GATEWAY_ROUNDS =
  envInt(
    "MLP_ARCHIVE_GATEWAY_ROUNDS",
    2,
    1,
    3
  );

const MAX_PASSES =
  envInt(
    "MLP_ARCHIVE_PASSES",
    4,
    1,
    10
  );

const CHECKPOINT_EVERY =
  envInt(
    "MLP_ARCHIVE_CHECKPOINT_EVERY",
    5,
    1,
    50
  );

const FORCE =
  process.argv.includes(
    "--force"
  );

const ALLOW_PARTIAL =
  process.env
    .MLP_ARCHIVE_ALLOW_PARTIAL === "1";


/*
 * GitHub Actions job limit is currently
 * 120 minutes in our workflow.
 *
 * Stop the downloader at 105 minutes if
 * necessary so GitHub still has time to
 * save the cache and artifact.
 *
 * A local run has no time limit unless
 * explicitly configured.
 */
const DEFAULT_MAX_RUN_MINUTES =
  process.env.GITHUB_ACTIONS === "true"
    ? 105
    : 0;

const MAX_RUN_MINUTES =
  envInt(
    "MLP_ARCHIVE_MAX_RUN_MINUTES",
    DEFAULT_MAX_RUN_MINUTES,
    0,
    10000
  );

const DEADLINE =
  MAX_RUN_MINUTES > 0
    ? Date.now() +
      MAX_RUN_MINUTES *
        60_000
    : Infinity;


const gatewayCooldowns =
  new Map();

let stopRequested =
  false;

let checkpointChain =
  Promise.resolve();


/* ============================================================
   GENERAL HELPERS
   ============================================================ */

function envInt(
  name,
  fallback,
  min,
  max
) {
  const value =
    Number(
      process.env[name]
    );

  if (
    !Number.isFinite(value)
  ) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(
      max,
      Math.floor(value)
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


function jitter(ms) {
  return Math.max(
    0,
    Math.floor(
      ms *
        (
          0.8 +
          Math.random() *
            0.4
        )
    )
  );
}


function timeRemaining() {
  return DEADLINE ===
    Infinity
    ? Infinity
    : DEADLINE -
        Date.now();
}


function shouldStop() {
  return (
    stopRequested ||
    timeRemaining() <=
      60_000
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
    clean.length <
    128
  ) {
    throw new Error(
      "Malformed ABI string response"
    );
  }

  const offset =
    Number.parseInt(
      clean.slice(
        0,
        64
      ),
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

  if (
    !Number.isFinite(
      length
    )
  ) {
    throw new Error(
      "Malformed ABI string length"
    );
  }

  const start =
    offset + 64;

  const data =
    clean.slice(
      start,
      start +
        length * 2
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
    .toString(
      "utf8"
    );
}


/* ============================================================
   URI HANDLING
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

  return {
    mime:
      match[1] ||
      "application/octet-stream",

    buffer:
      match[2]
        ? Buffer.from(
            match[3] ||
              "",
            "base64"
          )
        : Buffer.from(
            decodeURIComponent(
              match[3] ||
                ""
            ),
            "utf8"
          ),
  };
}


function normalizeResourceUri(
  uri
) {
  if (
    typeof uri !==
    "string"
  ) {
    return uri;
  }

  const value =
    uri.trim();

  if (
    value.startsWith(
      "ar://"
    )
  ) {
    return (
      "https://arweave.net/" +
      value.slice(5)
    );
  }

  return value;
}


function resourceCandidates(
  uri,
  seed = 0
) {
  const value =
    normalizeResourceUri(
      uri
    );

  if (!value) {
    return [];
  }

  if (
    !value.startsWith(
      "ipfs://"
    )
  ) {
    return [value];
  }

  const key =
    value
      .slice(7)
      .replace(
        /^ipfs\//,
        ""
      );

  const start =
    Math.abs(
      Number(seed) ||
      0
    ) %
    IPFS_GATEWAYS.length;

  const urls = [];

  for (
    let i = 0;
    i <
    IPFS_GATEWAYS.length;
    i++
  ) {
    urls.push(
      IPFS_GATEWAYS[
        (
          start + i
        ) %
        IPFS_GATEWAYS.length
      ] + key
    );
  }

  return urls;
}


function extractImageUri(
  metadata
) {
  if (
    typeof metadata?.image ===
      "string" &&
    metadata.image.trim()
  ) {
    return metadata
      .image
      .trim();
  }

  if (
    typeof metadata
      ?.image_url ===
      "string" &&
    metadata
      .image_url
      .trim()
  ) {
    return metadata
      .image_url
      .trim();
  }

  if (
    typeof metadata
      ?.image_data ===
      "string" &&
    metadata
      .image_data
      .trim()
  ) {
    const raw =
      metadata
        .image_data
        .trim();

    if (
      /^<svg[\s>]/i
        .test(raw)
    ) {
      return (
        "data:image/svg+xml;base64," +
        Buffer
          .from(
            raw,
            "utf8"
          )
          .toString(
            "base64"
          )
      );
    }

    return raw;
  }

  throw new Error(
    "Metadata has no usable image URI"
  );
}


/* ============================================================
   NETWORK
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
    clearTimeout(
      timer
    );
  }
}


function cooldownKey(url) {
  try {
    return new URL(url)
      .host;
  } catch {
    return url;
  }
}


function retryAfterMs(
  response
) {
  const value =
    response
      .headers
      .get(
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
      30000,
      Math.max(
        0,
        seconds * 1000
      )
    );
  }

  const when =
    Date.parse(value);

  if (
    Number.isFinite(
      when
    )
  ) {
    return Math.min(
      30000,
      Math.max(
        0,
        when -
          Date.now()
      )
    );
  }

  return 0;
}


async function waitForCooldown(
  url
) {
  const until =
    gatewayCooldowns
      .get(
        cooldownKey(
          url
        )
      ) || 0;

  if (
    until >
    Date.now()
  ) {
    await sleep(
      Math.min(
        until -
          Date.now(),
        10000
      )
    );
  }
}


function setCooldown(
  url,
  ms
) {
  gatewayCooldowns.set(
    cooldownKey(url),
    Date.now() +
      Math.max(
        ms,
        3000
      )
  );
}


/*
 * Try gateways sequentially instead of
 * firing all three simultaneously.
 *
 * This dramatically reduces 429 spam.
 */
async function fetchResource(
  uri,
  seed,
  label,
  handler
) {
  const data =
    decodeDataUri(
      uri
    );

  if (data) {
    return handler({
      url:
        uri,

      response:
        null,

      data,
    });
  }

  const candidates =
    resourceCandidates(
      uri,
      seed
    );

  if (
    !candidates.length
  ) {
    throw new Error(
      `${label} has no usable URL`
    );
  }

  let lastError;

  for (
    let round = 0;
    round <
    GATEWAY_ROUNDS;
    round++
  ) {
    for (
      let i = 0;
      i <
      candidates.length;
      i++
    ) {
      if (
        shouldStop()
      ) {
        throw new Error(
          "Run deadline reached"
        );
      }

      const url =
        candidates[
          (
            i + round
          ) %
          candidates.length
        ];

      try {
        await waitForCooldown(
          url
        );

        const timeout =
          label ===
          "image"
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
          response.status ===
          429
        ) {
          setCooldown(
            url,
            retryAfterMs(
              response
            ) ||
              jitter(
                5000
              )
          );

          throw new Error(
            `${url} -> HTTP 429`
          );
        }

        if (
          response.status >=
          500
        ) {
          setCooldown(
            url,
            jitter(
              2000
            )
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
          response,
          data:
            null,
        });
      } catch (
        error
      ) {
        lastError =
          error;
      }
    }

    if (
      round <
      GATEWAY_ROUNDS -
        1
    ) {
      await sleep(
        jitter(
          750 *
          2 ** round
        )
      );
    }
  }

  throw new Error(
    `${label} unavailable: ${
      lastError
        ?.message ||
      lastError ||
      "unknown error"
    }`
  );
}


/* ============================================================
   ETHEREUM RPC
   ============================================================ */

async function rpcTokenUri(
  id
) {
  let lastError;

  for (
    let round = 0;
    round < 2;
    round++
  ) {
    for (
      let i = 0;
      i <
      RPCS.length;
      i++
    ) {
      if (
        shouldStop()
      ) {
        throw new Error(
          "Run deadline reached"
        );
      }

      const url =
        RPCS[
          (
            id +
            round +
            i
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

            10000
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
      } catch (
        error
      ) {
        lastError =
          error;
      }
    }

    if (
      round === 0
    ) {
      await sleep(
        jitter(
          500
        )
      );
    }
  }

  throw new Error(
    `tokenURI(${id}) unavailable: ${
      lastError
        ?.message ||
      lastError
    }`
  );
}


/* ============================================================
   METADATA + IMAGE FETCHING
   ============================================================ */

async function fetchJsonUri(
  uri,
  id
) {
  return fetchResource(
    uri,
    id,
    "metadata",

    async ({
      response,
      data,
    }) => {
      const text =
        data
          ? data
              .buffer
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
    }
  );
}


async function fetchBinaryUri(
  uri,
  id
) {
  return fetchResource(
    uri,
    id + 17,
    "image",

    async ({
      url,
      response,
      data,
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

      return {
        buffer:
          Buffer.from(
            await response
              .arrayBuffer()
          ),

        mime:
          response
            .headers
            .get(
              "content-type"
            ) || "",

        sourceUrl:
          url,
      };
    }
  );
}


/* ============================================================
   FILES
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
  const data =
    await readJson(
      ARCHIVE_PATH,
      {}
    );

  return (
    data &&
    typeof data ===
      "object" &&
    !Array.isArray(
      data
    )
  )
    ? data
    : {};
}


async function readFailureState() {
  const raw =
    await readJson(
      FAIL_PATH,
      []
    );

  const state =
    new Map();

  if (
    !Array.isArray(raw)
  ) {
    return state;
  }

  for (
    const item of raw
  ) {
    const id =
      Number(
        item?.id
      );

    if (
      !Number.isInteger(
        id
      ) ||
      id < 1 ||
      id > SUPPLY
    ) {
      continue;
    }

    state.set(
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

  return state;
}


async function atomicWriteJson(
  file,
  value
) {
  const temp =
    `${file}.tmp`;

  await fs.writeFile(
    temp,
    JSON.stringify(
      value,
      null,
      2
    ) + "\n",
    "utf8"
  );

  await fs.rename(
    temp,
    file
  );
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

  await atomicWriteJson(
    ARCHIVE_PATH,
    archive
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
          a.id -
          b.id
      );

  await atomicWriteJson(
    FAIL_PATH,
    rows
  );
}


/* ============================================================
   IMAGE FILES
   ============================================================ */

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


async function outputExists(
  id
) {
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


/*
 * Remove leftover temporary files from
 * a previously interrupted run.
 */
async function cleanupTemps() {
  for (
    const dir of [
      DATA_DIR,
      FULL_DIR,
      THUMB_DIR,
    ]
  ) {
    let names = [];

    try {
      names =
        await fs.readdir(
          dir
        );
    } catch {
      continue;
    }

    await Promise.all(
      names
        .filter(
          (name) =>
            name.endsWith(
              ".tmp"
            )
        )
        .map(
          (name) =>
            fs.rm(
              path.join(
                dir,
                name
              ),
              {
                force:
                  true,
              }
            )
        )
    );
  }
}


/*
 * If the full image already exists but
 * the thumbnail is missing, rebuild the
 * thumb locally instead of hitting IPFS.
 */
async function repairThumbnailFromFull(
  id
) {
  if (
    !(
      await fileReady(
        fullPath(id)
      )
    ) ||
    await fileReady(
      thumbPath(id)
    )
  ) {
    return false;
  }

  const temp =
    `${thumbPath(id)}.tmp`;

  await sharp(
    fullPath(id)
  )
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
    thumbPath(id)
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

  const meta =
    await input
      .metadata();

  const fullTemp =
    `${fullPath(id)}.tmp`;

  const thumbTemp =
    `${thumbPath(id)}.tmp`;

  try {
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
  } catch (
    error
  ) {
    await Promise.all([
      fs.rm(
        fullTemp,
        {
          force:
            true,
        }
      ),

      fs.rm(
        thumbTemp,
        {
          force:
            true,
        }
      ),
    ]);

    throw error;
  }

  return {
    sourceUrl,
    mime,

    width:
      meta.width ||
      null,

    height:
      meta.height ||
      null,

    repairedLocally:
      false,
  };
}


/* ============================================================
   METADATA NORMALIZATION
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


function applyImageInfo(
  record,
  id,
  source
) {
  record.thumbnail =
    `/operators/thumbs/${pad(
      id
    )}.webp`;

  record.image =
    `/operators/full/${pad(
      id
    )}.webp`;

  record.source = {
    ...(
      record.source ||
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
            record.source
              ?.resolvedImageUrl ||
            null
          ),

    mime:
      source.mime ||
      record.source
        ?.mime ||
      null,

    width:
      source.width ??
      record.source
        ?.width ??
      null,

    height:
      source.height ??
      record.source
        ?.height ??
      null,
  };

  delete record
    .buildStatus;

  return record;
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

  let existing =
    archive[key];


  /*
   * Completely finished already.
   */
  if (
    !FORCE &&
    existing &&
    await outputExists(
      id
    )
  ) {
    return {
      id,
      status:
        "cached",
    };
  }


  /*
   * Metadata already exists.
   *
   * Only retry the image instead of
   * hitting Ethereum + metadata again.
   */
  if (
    !FORCE &&
    existing
      ?.canonicalImage
  ) {
    const source =
      await buildImages(
        id,
        existing
          .canonicalImage
      );

    archive[key] =
      applyImageInfo(
        existing,
        id,
        source
      );

    return {
      id,

      status:
        source
          .repairedLocally
          ? "repaired"
          : "image-rebuilt",
    };
  }


  /*
   * New operator.
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
    extractImageUri(
      metadata
    );


  /*
   * Save metadata in memory BEFORE
   * attempting the image.
   *
   * If the image gateway fails, the next
   * pass can retry only the image.
   */
  existing = {
    id,

    name:
      metadata.name ||
      `Milady Line Printer #${id}`,

    description:
      metadata.description ||
      "Milady Line Printer operator.",

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

    buildStatus:
      "metadata-only",

    source:
      existing
        ?.source ||
      {},
  };

  archive[key] =
    existing;


  const source =
    await buildImages(
      id,
      imageUri
    );

  archive[key] =
    applyImageInfo(
      existing,
      id,
      source
    );

  return {
    id,
    status:
      "built",
  };
}


/* ============================================================
   ARCHIVE STATE
   ============================================================ */

async function getMissingIds(
  archive
) {
  const missing = [];

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


/*
 * Operators with fewer historical
 * failures are tried first.
 *
 * Difficult tokens cannot permanently
 * block the rest of the collection.
 */
function sortByAttempts(
  ids,
  failureState
) {
  return [
    ...ids,
  ].sort(
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
  );
}


/* ============================================================
   CHECKPOINTING
   ============================================================ */

function queueCheckpoint(
  archive,
  failureState
) {
  checkpointChain =
    checkpointChain.then(
      async () => {
        const missing =
          await getMissingIds(
            archive
          );

        await saveArchive(
          archive
        );

        await saveFailureState(
          failureState,
          missing
        );
      }
    );

  return checkpointChain;
}


/* ============================================================
   CONCURRENCY
   ============================================================ */

async function runConcurrent(
  ids,
  worker
) {
  let cursor =
    0;

  async function runner() {
    while (
      !shouldStop()
    ) {
      const index =
        cursor++;

      if (
        index >=
        ids.length
      ) {
        return;
      }

      await worker(
        ids[index],
        index
      );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            CONCURRENCY,
            Math.max(
              1,
              ids.length
            )
          ),
      },

      () => runner()
    )
  );
}


/* ============================================================
   FINAL VALIDATION
   ============================================================ */

async function finalValidate(
  archive
) {
  const missing = [];

  const badRecords = [];

  for (
    let id = 1;
    id <= SUPPLY;
    id++
  ) {
    const record =
      archive[
        String(id)
      ];

    if (
      !record ||
      !record.name ||
      !Array.isArray(
        record.attributes
      )
    ) {
      badRecords.push(
        id
      );
    }

    if (
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

  return {
    missing,
    badRecords,
  };
}


/* ============================================================
   MAIN
   ============================================================ */

async function main() {
  await ensureDirs();

  await cleanupTemps();

  const archive =
    await readArchive();

  const failureState =
    await readFailureState();

  let missing =
    await getMissingIds(
      archive
    );


  console.log(
    "MLP ONE-SHOT STATIC ARCHIVE"
  );

  console.log(
    `Contract: ${CONTRACT}`
  );

  console.log(
    `Supply: ${SUPPLY}`
  );

  console.log(
    `Workers: ${CONCURRENCY}`
  );

  console.log(
    `Max passes: ${MAX_PASSES}`
  );

  console.log(
    `Gateway rounds per attempt: ${GATEWAY_ROUNDS}`
  );

  console.log(
    `Missing at start: ${missing.length}`
  );

  console.log(
    `Already complete: ${
      SUPPLY -
      missing.length
    }`
  );

  console.log(
    `Run limit: ${
      MAX_RUN_MINUTES >
      0
        ? `${MAX_RUN_MINUTES} minutes`
        : "unlimited"
    }`
  );

  console.log("");


  let totalSucceeded =
    0;

  let totalFailedAttempts =
    0;

  let operationsSinceCheckpoint =
    0;


  /*
   * PASS 1:
   * attempt every missing operator.
   *
   * PASS 2+:
   * attempt only what remains.
   */
  for (
    let pass = 1;
    pass <= MAX_PASSES;
    pass++
  ) {
    missing =
      await getMissingIds(
        archive
      );

    if (
      !missing.length ||
      shouldStop()
    ) {
      break;
    }


    const ids =
      sortByAttempts(
        missing,
        failureState
      );


    let finished =
      0;

    let passSucceeded =
      0;

    let passFailed =
      0;


    console.log(
      "================================================"
    );

    console.log(
      `PASS ${pass}/${MAX_PASSES}`
    );

    console.log(
      `Attempting ${ids.length} missing operators`
    );

    console.log(
      "================================================"
    );


    await runConcurrent(
      ids,

      async (id) => {
        try {
          const result =
            await buildOne(
              id,
              archive
            );

          finished++;


          if (
            result.status !==
            "cached"
          ) {
            passSucceeded++;

            totalSucceeded++;
          }


          failureState.delete(
            id
          );


          console.log(
            `[${
              String(
                finished
              ).padStart(
                3,
                "0"
              )
            }/${
              String(
                ids.length
              ).padStart(
                3,
                "0"
              )
            }] #${pad(
              id
            )} ${result.status} ✓`
          );
        } catch (
          error
        ) {
          finished++;

          passFailed++;

          totalFailedAttempts++;


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
                error
                  ?.message ||
                String(
                  error
                ),

              lastAttemptAt:
                new Date()
                  .toISOString(),
            }
          );


          console.error(
            `[${
              String(
                finished
              ).padStart(
                3,
                "0"
              )
            }/${
              String(
                ids.length
              ).padStart(
                3,
                "0"
              )
            }] #${pad(
              id
            )} FAILED — ${
              error
                ?.message ||
              error
            }`
          );
        }


        operationsSinceCheckpoint++;


        if (
          operationsSinceCheckpoint >=
          CHECKPOINT_EVERY
        ) {
          operationsSinceCheckpoint =
            0;

          await queueCheckpoint(
            archive,
            failureState
          );
        }
      }
    );


    await queueCheckpoint(
      archive,
      failureState
    );


    missing =
      await getMissingIds(
        archive
      );


    console.log("");

    console.log(
      `PASS ${pass} RESULT`
    );

    console.log(
      `Succeeded this pass: ${passSucceeded}`
    );

    console.log(
      `Failed attempts this pass: ${passFailed}`
    );

    console.log(
      `Remaining: ${missing.length}`
    );

    console.log("");


    if (
      !missing.length ||
      shouldStop()
    ) {
      break;
    }


    /*
     * Give public gateways a small rest
     * before attacking only the failures.
     */
    const pauseMs =
      Math.min(
        15000,
        3000 *
          pass
      );


    console.log(
      `Cooling down ${
        Math.round(
          pauseMs /
          1000
        )
      }s before next pass...`
    );


    await sleep(
      pauseMs
    );
  }


  /*
   * Final guaranteed checkpoint.
   */
  await queueCheckpoint(
    archive,
    failureState
  );

  await checkpointChain;


  const validation =
    await finalValidate(
      archive
    );


  const complete =
    SUPPLY -
    validation
      .missing
      .length;


  console.log(
    "================================================"
  );

  console.log(
    "FINAL ARCHIVE STATUS"
  );

  console.log(
    `COMPLETE OPERATORS: ${complete} / ${SUPPLY}`
  );

  console.log(
    `MISSING IMAGE SETS: ${
      validation
        .missing
        .length
    }`
  );

  console.log(
    `INVALID/MISSING JSON RECORDS: ${
      validation
        .badRecords
        .length
    }`
  );

  console.log(
    `SUCCEEDED THIS RUN: ${totalSucceeded}`
  );

  console.log(
    `FAILED ATTEMPTS THIS RUN: ${totalFailedAttempts}`
  );


  if (
    validation
      .missing
      .length
  ) {
    console.log(
      `REMAINING IDS: ${
        validation
          .missing
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
    "================================================"
  );


  if (
    validation
      .missing
      .length ===
      0 &&
    validation
      .badRecords
      .length ===
      0
  ) {
    console.log(
      "ARCHIVE COMPLETE — 620 / 620 VERIFIED"
    );

    return;
  }


  if (
    shouldStop()
  ) {
    console.log(
      "RUN STOPPED SAFELY BEFORE DEADLINE — PROGRESS CHECKPOINTED"
    );
  } else {
    console.log(
      "ARCHIVE STILL PARTIAL AFTER ALL RETRY PASSES — PROGRESS CHECKPOINTED"
    );
  }


  if (
    !ALLOW_PARTIAL
  ) {
    process.exitCode =
      1;
  }
}


/* ============================================================
   SAFE SHUTDOWN
   ============================================================ */

async function requestStop(
  signal
) {
  if (
    stopRequested
  ) {
    return;
  }

  stopRequested =
    true;

  console.log(
    `\n${signal} received — finishing current requests and saving progress...`
  );

  try {
    await checkpointChain;
  } catch (
    error
  ) {
    console.error(
      "Checkpoint flush failed:",
      error
    );
  }
}


process.on(
  "SIGINT",
  () =>
    void requestStop(
      "SIGINT"
    )
);


process.on(
  "SIGTERM",
  () =>
    void requestStop(
      "SIGTERM"
    )
);


/* ============================================================
   START
   ============================================================ */

main().catch(
  async (error) => {
    console.error(
      error
    );

    try {
      await checkpointChain;
    } catch {
      // Best effort.
    }

    process.exitCode =
      1;
  }
);
