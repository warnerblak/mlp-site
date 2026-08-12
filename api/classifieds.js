const URL = process.env.SUPABASE_URL;
const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET() {
  const result = {
    ok: true,
    environment: {
      SUPABASE_URL_present: Boolean(URL),
      SUPABASE_SECRET_KEY_present: Boolean(
        process.env.SUPABASE_SECRET_KEY
      ),
      SUPABASE_SERVICE_ROLE_KEY_present: Boolean(
        process.env.SUPABASE_SERVICE_ROLE_KEY
      ),
    },
    checks: {
      supabase_reachable: false,
      classifieds_table_reachable: false,
    },
  };

  if (!URL || !KEY) {
    result.ok = false;
    result.error = "Missing required Supabase environment variable(s).";
    return json(result, 500);
  }

  try {
    const health = await fetch(`${URL}/rest/v1/`, {
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
      },
    });

    result.checks.supabase_reachable = health.ok;

    const table = await fetch(
      `${URL}/rest/v1/classifieds?select=id&limit=1`,
      {
        headers: {
          apikey: KEY,
          authorization: `Bearer ${KEY}`,
        },
      }
    );

    result.checks.classifieds_table_reachable = table.ok;

    if (!health.ok || !table.ok) {
      result.ok = false;
      result.supabase_status = health.status;
      result.classifieds_status = table.status;

      try {
        const body = await table.text();
        result.safe_error = body.slice(0, 500);
      } catch {}

      return json(result, 500);
    }

    return json(result, 200);
  } catch (err) {
    result.ok = false;
    result.error =
      "Function reached diagnostics but failed during fetch.";
    result.message =
      err instanceof Error ? err.message : String(err);

    return json(result, 500);
  }
}
