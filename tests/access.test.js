const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../index");

test("protected REST API rejects anonymous and regular user sessions", async () => {
  const originalFetch = global.fetch;
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    // No cookie is never authenticated.
    let res = await originalFetch(base + "/api/stats");
    assert.equal(res.status, 401);

    // Simulate a valid Better Auth user who has not been promoted.
    global.fetch = async (input, options) => {
      if (String(input).includes("/api/auth/get-session"))
        return new Response(JSON.stringify({
          session: { id: "test-session-id" },
          user: { email: "member@example.com", role: "user" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      return originalFetch(input, options);
    };
    res = await originalFetch(base + "/api/stats", {headers: {Cookie:"better-auth.session_token=test"}});
    assert.equal(res.status, 403);
    assert.match((await res.json()).error,/Administrator role required/);

    res = await originalFetch(base + "/api/doctors", {
      method:"POST",
      headers: {Cookie:"better-auth.session_token=test","Content-Type":"application/json"},
      body: JSON.stringify({name:"No access", specialty:"GP", hospital:"No"})
    });
    assert.equal(res.status,403);

    // A legacy user without any role must also be denied.
    global.fetch = async (input, options) => {
      if (String(input).includes("/api/auth/get-session"))
        return new Response(JSON.stringify({
          session: { id: "legacy-session-id" },
          user: { email: "legacy@example.com" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      return originalFetch(input, options);
    };
    res = await originalFetch(base + "/api/stats", {headers:{Cookie:"better-auth.session_token=legacy"}});
    assert.equal(res.status,403);
  } finally {
    global.fetch = originalFetch;
    await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve()));
  }
});
