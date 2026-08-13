const URL = process.env.SUPABASE_URL,
  KEY =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY;

const cats = new Set([
  "wanted",
  "for-sale",
  "seeking",
  "help-wanted",
  "public-notice",
  "personals",
]);

const j = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...h,
    },
  });

const hd = (x = {}) => ({
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
  ...x,
});

const clean = (s, n) =>
  String(s ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, n);

const goodUrl = (s) => {
  if (!s) return "";
  try {
    const u = new URL(s);
    return ["http:", "https:"].includes(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
};

async function fp(req) {
  const ip = (req.headers.get("x-forwarded-for") || "unknown")
    .split(",")[0]
    .trim();

  const ua = req.headers.get("user-agent") || "";
  const salt = process.env.CLASSIFIEDS_HASH_SALT || "mlp";

  const raw = new TextEncoder().encode(
    `${salt}|${ip}|${ua.slice(0, 180)}`
  );

  const hash = await crypto.subtle.digest("SHA-256", raw);

  return [...new Uint8Array(hash)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET() {
  if (!URL || !KEY) {
    return j({
      items: [],
      configured: false,
    });
  }

  const u = new URL(`${URL}/rest/v1/classifieds`);

  u.searchParams.set(
    "select",
    "id,category,headline,body,handle,url,created_at,expires_at,featured"
  );

  u.searchParams.set("status", "eq.approved");
  u.searchParams.set(
    "expires_at",
    `gt.${new Date().toISOString()}`
  );
  u.searchParams.set(
    "order",
    "featured.desc,created_at.desc"
  );
  u.searchParams.set("limit", "20");

  const r = await fetch(u, {
    headers: hd(),
  });

  if (!r.ok) {
    return j(
      { error: "Could not read classifieds" },
      502
    );
  }

  return j(
    {
      items: await r.json(),
      configured: true,
    },
    200,
    {
      "cache-control":
        "public, s-maxage=60, stale-while-revalidate=300",
    }
  );
}

export async function POST(req) {
  if (!URL || !KEY) {
    return j(
      {
        error:
          "Classified desk is not configured yet.",
      },
      503
    );
  }

  if (
    process.env.CLASSIFIEDS_SUBMISSIONS_OPEN !==
    "true"
  ) {
    return j(
      {
        error:
          "Classified submissions are not open yet.",
      },
      403
    );
  }

  let x;

  try {
    x = await req.json();
  } catch {
    return j({ error: "Invalid JSON" }, 400);
  }

  const category = clean(x.category, 32);
  const headline = clean(x.headline, 70);
  const body = clean(x.body, 320);
  const handle = clean(x.handle, 64);
  const url = goodUrl(clean(x.url, 400));

  const days = [7, 14].includes(Number(x.days))
    ? Number(x.days)
    : 7;

  if (!cats.has(category)) {
    return j(
      { error: "Choose a valid section." },
      400
    );
  }

  if (headline.length < 4) {
    return j(
      { error: "Headline is too short." },
      400
    );
  }

  if (body.length < 10) {
    return j(
      { error: "Classified copy is too short." },
      400
    );
  }

  const hash = await fp(req);

  const since = new Date(
    Date.now() - 3600000
  ).toISOString();

  const q = new URL(
    `${URL}/rest/v1/classifieds`
  );

  q.searchParams.set("select", "id");
  q.searchParams.set(
    "submitter_hash",
    `eq.${hash}`
  );
  q.searchParams.set(
    "created_at",
    `gte.${since}`
  );

  const cr = await fetch(q, {
    headers: hd({
      prefer: "count=exact",
    }),
  });

  const count = Number(
    (
      cr.headers.get("content-range") || ""
    ).split("/")[1] || 0
  );

  if (
    Number.isFinite(count) &&
    count >= 3
  ) {
    return j(
      {
        error:
          "Too many submissions. Try again later.",
      },
      429
    );
  }

  const created = new Date();

  const expires = new Date(
    created.getTime() +
      days * 86400000
  );

  const rec = {
    category,
    headline,
    body,
    handle: handle || null,
    url: url || null,
    status: "pending",
    featured: false,
    created_at: created.toISOString(),
    expires_at: expires.toISOString(),
    submitter_hash: hash,
  };

  const r = await fetch(
    `${URL}/rest/v1/classifieds`,
    {
      method: "POST",
      headers: hd({
        prefer: "return=minimal",
      }),
      body: JSON.stringify(rec),
    }
  );

  if (!r.ok) {
    return j(
      {
        error:
          "Could not send classified to press.",
      },
      502
    );
  }

  return j(
    {
      ok: true,
      status: "pending",
    },
    202
  );
}
