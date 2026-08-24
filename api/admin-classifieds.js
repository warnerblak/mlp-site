const SUPABASE_URL = process.env.SUPABASE_URL;

const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const j = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const headers = () => ({
  apikey: KEY,
  authorization: `Bearer ${KEY}`,
  "content-type": "application/json",
});

const isAdmin = (req) =>
  Boolean(
    process.env.CLASSIFIEDS_ADMIN_KEY &&
      (req.headers.get("authorization") || "") ===
        `Bearer ${process.env.CLASSIFIEDS_ADMIN_KEY}`
  );

export async function GET(req) {
  if (!isAdmin(req)) {
    return j({ error: "Unauthorized" }, 401);
  }

  if (!SUPABASE_URL || !KEY) {
    return j(
      { error: "Admin desk is not configured." },
      503
    );
  }

  const u = new URL(
    `${SUPABASE_URL}/rest/v1/classifieds`
  );

  u.searchParams.set("select", "*");
  u.searchParams.set(
    "order",
    "created_at.desc"
  );
  u.searchParams.set("limit", "100");

  const r = await fetch(u, {
    headers: headers(),
  });

  if (!r.ok) {
    const detail = await r
      .text()
      .catch(() => "");

    console.error(
      "Supabase admin queue read failed:",
      r.status,
      detail
    );

    return j(
      { error: "Could not read queue" },
      502
    );
  }

  return j({
    items: await r.json(),
  });
}

export async function PATCH(req) {
  if (!isAdmin(req)) {
    return j({ error: "Unauthorized" }, 401);
  }

  if (!SUPABASE_URL || !KEY) {
    return j(
      { error: "Admin desk is not configured." },
      503
    );
  }

  let x;

  try {
    x = await req.json();
  } catch {
    return j(
      { error: "Invalid JSON" },
      400
    );
  }

  const id = String(x.id || "");
  const action = String(x.action || "");

  if (
    !id ||
    ![
      "approve",
      "reject",
      "feature",
      "unfeature",
      "delete",
    ].includes(action)
  ) {
    return j(
      { error: "Invalid action" },
      400
    );
  }

  if (action === "delete") {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/classifieds?id=eq.${encodeURIComponent(
        id
      )}`,
      {
        method: "DELETE",
        headers: headers(),
      }
    );

    if (!r.ok) {
      const detail = await r
        .text()
        .catch(() => "");

      console.error(
        "Supabase classified delete failed:",
        r.status,
        detail
      );

      return j(
        { error: "Delete failed" },
        502
      );
    }

    return j({ ok: true });
  }

  const patch =
    action === "approve"
      ? { status: "approved" }
      : action === "reject"
      ? { status: "rejected" }
      : action === "feature"
      ? { featured: true }
      : { featured: false };

  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/classifieds?id=eq.${encodeURIComponent(
      id
    )}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(patch),
    }
  );

  if (!r.ok) {
    const detail = await r
      .text()
      .catch(() => "");

    console.error(
      "Supabase classified update failed:",
      r.status,
      detail
    );

    return j(
      { error: "Update failed" },
      502
    );
  }

  return j({ ok: true });
}
