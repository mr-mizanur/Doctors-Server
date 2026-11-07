const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../index");

async function withServer(run) {
  const server = app.listen(0);
  try { await run("http://127.0.0.1:" + server.address().port); }
  finally { await new Promise((resolve,reject)=>server.close(err=>err?reject(err):resolve())); }
}

test("GET / displays API welcome information", async () => withServer(async base => {
  const response = await fetch(base+"/");
  assert.equal(response.status, 200);
  const body=await response.json();
  assert.match(body.message,/Express.js/);
  assert.match(body.security,/role=admin/);
}));

test("MongoDB user.role, not a role claimed by session, determines authorization", async () => {
  const originalFetch=global.fetch;
  const originalDb=app.locals.getDb;
  let role="user";
  let seen=0;
  app.locals.getDb=async()=>({
    users:{findOne:async query=>{seen++;assert.equal(query.email,"person@example.com");return {email:query.email,role};}},
    doctors:{countDocuments:async()=>2},
    patients:{
      countDocuments:async()=>3,
      aggregate:()=>({toArray:async()=>[]})
    }
  });
  global.fetch=async (url,options)=>{
    if(String(url).includes("/api/auth/get-session"))
      return new Response(JSON.stringify({
        session:{id:"verified-session-id"},
        user:{id:"auth-user-id",email:"person@example.com",role:"admin"}
      }),{status:200,headers:{"content-type":"application/json"}});
    return originalFetch(url,options);
  };
  try {
    await withServer(async base => {
      const request=async()=>originalFetch(base+"/api/stats",{headers:{Cookie:"better-auth.session_token=mock"}});
      let res=await request();
      assert.equal(res.status,403); // Forged/cached admin role does not matter.
      role="admin";
      res=await request();
      assert.equal(res.status,200); // Atlas promotion takes effect without re-login.
      const data=await res.json();
      assert.equal(data.totalDoctors,2);
      assert.equal(data.totalPatients,3);
      role="user";
      res=await request();
      assert.equal(res.status,403); // Revocation takes effect without re-login.
      assert.equal(seen,3);
    });
  } finally {global.fetch=originalFetch;app.locals.getDb=originalDb;}
});
