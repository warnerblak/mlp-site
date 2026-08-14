const X_API_URL =
  "https://api.x.com/2/tweets/search/recent";

const DEFAULT_PRIMARY_ACCOUNTS = [
  "RemiliaCorp333",
  "MiladyMaker333",
];

const COMMUNITY_QUERY =
  '("milady maker" OR remilia OR "remilia collective" OR milady) lang:en -is:retweet -is:reply';

const BLOCKED_TERMS = [
  "retarded",
  "nigger",
  "faggot",
  "kike",
  "rape",
  "scam giveaway",
  "free mint dm",
];

const STRONG_TERMS = [
  "remilia",
  "milady maker",
  "remilia collective",
  "milady world",
  "bonkler",
  "remilio",
  "pixelady",
  "new net art",
  "network spirituality",
  "milady",
];

const json = (
  data,
  status = 200,
  extraHeaders = {}
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

const cleanText = (value = "") =>
  String(value)
    .replace(/https:\/\/t\.co\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeText = (value = "") =>
  cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const getPrimaryAccounts = () => {
  const custom =
    process.env.X_CULTURAL_WIRE_ACCOUNTS;

  if (!custom) {
    return DEFAULT_PRIMARY_ACCOUNTS;
  }

  return custom
    .split(",")
    .map((x) =>
      x.trim().replace(/^@/, "")
    )
    .filter(Boolean);
};

const primaryQuery = (accounts) => {
  const sources = accounts
    .map((account) => `from:${account}`)
    .join(" OR ");

  return `(${sources}) -is:retweet -is:reply`;
};

const containsBlockedTerm = (text = "") => {
  const haystack =
    String(text).toLowerCase();

  return BLOCKED_TERMS.some((term) =>
    haystack.includes(term)
  );
};

const relevanceScore = (text = "") => {
  const haystack =
    String(text).toLowerCase();

  let score = 0;

  for (const term of STRONG_TERMS) {
    if (haystack.includes(term)) {
      score +=
        term === "milady"
          ? 4
          : 8;
    }
  }

  if (
    haystack.includes("derivative") ||
    haystack.includes("pfp") ||
    haystack.includes("posting") ||
    haystack.includes("timeline") ||
    haystack.includes("culture") ||
    haystack.includes("meme")
  ) {
    score += 3;
  }

  return score;
};

const classify = ({
  text = "",
  username = "",
  primary = false,
}) => {
  const user =
    username.toLowerCase();

  if (primary) {
    if (
      user === "remiliacorp333"
    ) {
      return "REMILIA";
    }

    if (
      user === "miladymaker333"
    ) {
      return "MILADY";
    }

    return "PRIMARY";
  }

  const haystack =
    `${text} ${username}`.toLowerCase();

  if (
    haystack.includes("remilia")
  ) {
    return "REMILIA";
  }

  if (
    haystack.includes("milady")
  ) {
    return "MILADY";
  }

  return "COMMUNITY";
};

async function searchX(
  token,
  query,
  source
) {
  const url = new URL(X_API_URL);

  url.searchParams.set(
    "query",
    query
  );

  url.searchParams.set(
    "max_results",
    "10"
  );

  url.searchParams.set(
    "sort_order",
    "recency"
  );

  url.searchParams.set(
    "tweet.fields",
    [
      "author_id",
      "created_at",
      "public_metrics",
      "lang",
    ].join(",")
  );

  url.searchParams.set(
    "expansions",
    "author_id"
  );

  url.searchParams.set(
    "user.fields",
    [
      "name",
      "username",
      "verified",
      "profile_image_url",
    ].join(",")
  );

  const response = await fetch(url, {
    headers: {
      authorization:
        `Bearer ${token}`,

      accept:
        "application/json",
    },
  });

  const payload = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload?.detail ||
      payload?.title ||
      payload?.errors?.[0]?.detail ||
      `X API ${response.status}`
    );

    error.status =
      response.status;

    throw error;
  }

  const users = new Map(
    (
      payload.includes?.users ||
      []
    ).map((user) => [
      user.id,
      user,
    ])
  );

  return (
    payload.data || []
  ).map((post) => {
    const author =
      users.get(post.author_id) ||
      {};

    const username =
      author.username || "";

    const text =
      cleanText(post.text);

    return {
      id:
        post.id,

      source,

      primary:
        source === "primary",

      category:
        classify({
          text,
          username,
          primary:
            source === "primary",
        }),

      text,

      created_at:
        post.created_at || null,

      author: {
        id:
          author.id ||
          post.author_id ||
          null,

        name:
          author.name ||
          username ||
          "Unknown",

        username,

        verified:
          Boolean(
            author.verified
          ),

        profile_image_url:
          author.profile_image_url ||
          null,
      },

      metrics: {
        likes:
          post.public_metrics
            ?.like_count || 0,

        reposts:
          post.public_metrics
            ?.retweet_count || 0,

        replies:
          post.public_metrics
            ?.reply_count || 0,

        quotes:
          post.public_metrics
            ?.quote_count || 0,
      },

      source_url:
        username
          ? `https://x.com/${username}/status/${post.id}`
          : `https://x.com/i/web/status/${post.id}`,
    };
  });
}

const editorialScore = (item) => {
  const metrics =
    item.metrics || {};

  let score = 0;

  if (item.primary) {
    score += 100;
  }

  if (
    item.category === "REMILIA"
  ) {
    score += 20;
  }

  if (
    item.category === "MILADY"
  ) {
    score += 15;
  }

  score +=
    relevanceScore(
      item.text
    );

  score +=
    Math.min(
      metrics.likes || 0,
      100
    ) * 0.15;

  score +=
    Math.min(
      metrics.reposts || 0,
      50
    ) * 0.4;

  score +=
    Math.min(
      metrics.quotes || 0,
      30
    ) * 0.5;

  score +=
    Math.min(
      metrics.replies || 0,
      50
    ) * 0.08;

  if (item.created_at) {
    const ageHours =
      (
        Date.now() -
        new Date(
          item.created_at
        ).getTime()
      ) /
      3600000;

    score +=
      Math.max(
        0,
        12 - ageHours
      ) * 0.2;
  }

  return Number(
    score.toFixed(2)
  );
};

const isUsefulCommunityPost = (
  item
) => {
  if (item.primary) {
    return true;
  }

  const raw =
    item.text || "";

  const text =
    normalizeText(raw);

  if (
    containsBlockedTerm(raw)
  ) {
    return false;
  }

  if (
    text.length < 35
  ) {
    return false;
  }

  const words =
    text.split(" ");

  if (
    words.length < 6
  ) {
    return false;
  }

  const metrics =
    item.metrics || {};

  const engagement =
    (metrics.likes || 0) +
    (metrics.reposts || 0) * 2 +
    (metrics.quotes || 0) * 2 +
    (metrics.replies || 0);

  const relevance =
    relevanceScore(raw);

  if (
    relevance >= 8
  ) {
    return true;
  }

  if (
    relevance >= 4 &&
    engagement >= 6
  ) {
    return true;
  }

  return false;
};

const dedupe = (items) => {
  const seenIds =
    new Set();

  const seenText =
    new Set();

  const output = [];

  for (
    const item of items
  ) {
    if (
      seenIds.has(item.id)
    ) {
      continue;
    }

    const textKey =
      normalizeText(
        item.text
      );

    if (
      !textKey ||
      seenText.has(
        textKey
      )
    ) {
      continue;
    }

    seenIds.add(
      item.id
    );

    seenText.add(
      textKey
    );

    output.push(item);
  }

  return output;
};

const limitAuthors = (
  items
) => {
  const counts =
    new Map();

  const output = [];

  for (
    const item of items
  ) {
    const username =
      (
        item.author
          ?.username ||
        "unknown"
      ).toLowerCase();

    const current =
      counts.get(
        username
      ) || 0;

    const limit =
      item.primary
        ? 3
        : 1;

    if (
      current >= limit
    ) {
      continue;
    }

    counts.set(
      username,
      current + 1
    );

    output.push(item);
  }

  return output;
};

export async function GET() {
  const token =
    process.env
      .X_BEARER_TOKEN;

  if (!token) {
    return json(
      {
        ok: false,

        error:
          "X_BEARER_TOKEN is not configured.",
      },
      503
    );
  }

  const accounts =
    getPrimaryAccounts();

  const officialQuery =
    primaryQuery(
      accounts
    );

  const communityQuery =
    process.env
      .X_CULTURAL_WIRE_QUERY ||
    COMMUNITY_QUERY;

  let primary = [];
  let community = [];

  const results =
    await Promise.allSettled([
      searchX(
        token,
        officialQuery,
        "primary"
      ),

      searchX(
        token,
        communityQuery,
        "community"
      ),
    ]);

  if (
    results[0].status ===
    "fulfilled"
  ) {
    primary =
      results[0].value;
  } else {
    console.error(
      "Primary Cultural Wire error:",
      results[0].reason
    );
  }

  if (
    results[1].status ===
    "fulfilled"
  ) {
    community =
      results[1].value;
  } else {
    console.error(
      "Community Cultural Wire error:",
      results[1].reason
    );
  }

  if (
    results.every(
      (result) =>
        result.status ===
        "rejected"
    )
  ) {
    const reason =
      results[0].reason ||
      results[1].reason;

    return json(
      {
        ok: false,

        error:
          "X Cultural Wire requests failed.",

        status:
          reason?.status ||
          502,

        detail:
          reason?.message ||
          null,
      },
      502
    );
  }

  let candidates = [
    ...primary,
    ...community,
  ];

  candidates =
    candidates.filter(
      isUsefulCommunityPost
    );

  candidates =
    dedupe(
      candidates
    );

  candidates =
    candidates.map(
      (item) => ({
        ...item,

        editorial_score:
          editorialScore(
            item
          ),
      })
    );

  candidates.sort(
    (a, b) =>
      b.editorial_score -
      a.editorial_score
  );

  candidates =
    limitAuthors(
      candidates
    );

  const items =
    candidates
      .filter(
        (item) =>
          item.primary ||
          item.editorial_score >= 18
      )
      .slice(
        0,
        8
      );

  return json(
    {
      ok: true,

      source: "x",

      version: 3,

      primary_accounts:
        accounts,

      queries: {
        primary:
          officialQuery,

        community:
          communityQuery,
      },

      candidates: {
        primary:
          primary.length,

        community:
          community.length,

        after_filtering:
          candidates.length,

        published:
          items.length,
      },

      count:
        items.length,

      items,

      fetched_at:
        new Date()
          .toISOString(),
    },
    200,
    {
      /*
        Cache Cultural Wire for 15 minutes.
        After expiry, Vercel may serve the
        existing wire while revalidating.
      */
      "cache-control":
        "public, s-maxage=900, stale-while-revalidate=1800",
    }
  );
}
