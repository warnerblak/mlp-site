const X_API_URL = "https://api.x.com/2/tweets/search/recent";

const DEFAULT_QUERY =
  '(milady OR remilia OR "milady maker") lang:en -is:retweet';

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });

const cleanText = (value = "") =>
  String(value)
    .replace(/https:\/\/t\.co\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();

const classify = (text = "", username = "") => {
  const haystack = `${text} ${username}`.toLowerCase();

  if (haystack.includes("remilia")) {
    return "REMILIA";
  }

  if (
    haystack.includes("milady") ||
    haystack.includes("milady maker")
  ) {
    return "MILADY";
  }

  return "DISPATCH";
};

export async function GET() {
  const token = process.env.X_BEARER_TOKEN;

  if (!token) {
    return json(
      {
        ok: false,
        error: "X_BEARER_TOKEN is not configured.",
      },
      503
    );
  }

  const query =
    process.env.X_CULTURAL_WIRE_QUERY ||
    DEFAULT_QUERY;

  const url = new URL(X_API_URL);

  url.searchParams.set("query", query);
  url.searchParams.set("max_results", "10");
  url.searchParams.set("sort_order", "recency");

  url.searchParams.set(
    "tweet.fields",
    "author_id,created_at,public_metrics,lang"
  );

  url.searchParams.set(
    "expansions",
    "author_id"
  );

  url.searchParams.set(
    "user.fields",
    "name,username,verified,profile_image_url"
  );

  let response;

  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
    });
  } catch (error) {
    console.error("X API network error:", error);

    return json(
      {
        ok: false,
        error: "Could not reach the X API.",
      },
      502
    );
  }

  const payload = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    console.error(
      "X API error:",
      response.status,
      JSON.stringify(payload)
    );

    return json(
      {
        ok: false,
        error: "X API request failed.",
        status: response.status,
        detail:
          payload?.detail ||
          payload?.title ||
          payload?.errors?.[0]?.detail ||
          null,
      },
      502
    );
  }

  const users = new Map(
    (payload.includes?.users || []).map(
      (user) => [user.id, user]
    )
  );

  const items = (payload.data || []).map(
    (post) => {
      const author =
        users.get(post.author_id) || {};

      const username =
        author.username || "";

      return {
        id: post.id,

        category: classify(
          post.text,
          username
        ),

        text: cleanText(post.text),

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
            Boolean(author.verified),

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

        source_url: username
          ? `https://x.com/${username}/status/${post.id}`
          : `https://x.com/i/web/status/${post.id}`,
      };
    }
  );

  return json(
    {
      ok: true,
      source: "x",
      query,
      count: items.length,
      items,
      fetched_at:
        new Date().toISOString(),
    },
    200,
    {
      "cache-control":
        "public, s-maxage=300, stale-while-revalidate=900",
    }
  );
}
