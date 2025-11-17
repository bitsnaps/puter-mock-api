import { assert, assertEquals } from "@std/assert";
import "./main.js";

const BASE = "http://localhost:8000";

Deno.test("root endpoint", async () => {
  const res = await fetch(`${BASE}/`);
  assert(res.ok);
  const data = await res.json();
  assertEquals(data.status, "ok");
  assert(Array.isArray(data.endpoints));
});

Deno.test("KV set/get", async () => {
  const setRes = await fetch(`${BASE}/api/kv/set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "foo", value: "bar" }),
  });
  assert(setRes.ok);
  await setRes.json();
  const getRes = await fetch(`${BASE}/api/kv/get?key=foo`);
  assert(getRes.ok);
  const got = await getRes.json();
  assertEquals(got.value, "bar");
});

Deno.test("FS write/read/list/delete", async () => {
  const writeRes = await fetch(`${BASE}/api/fs/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "/docs/hello.txt", content: "hello" }),
  });
  assert(writeRes.ok);
  await writeRes.json();
  const readRes = await fetch(`${BASE}/api/fs/read?path=/docs/hello.txt`);
  assert(readRes.ok);
  const file = await readRes.json();
  assertEquals(file.content, "hello");
  const listRes = await fetch(`${BASE}/api/fs/list?path=/docs/`);
  assert(listRes.ok);
  const list = await listRes.json();
  assert(Array.isArray(list.items));
  const delRes = await fetch(`${BASE}/api/fs/delete?path=/docs/hello.txt`, {
    method: "DELETE",
  });
  assert(delRes.ok);
  await delRes.json();
});

Deno.test("AI chat non-stream mock", async () => {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock-echo",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
  assert(res.ok);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || "";
  assert(String(content).startsWith("Echo:"));
});

Deno.test("AI chat streaming mock", async () => {
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: true,
      model: "mock-echo",
      messages: [{ role: "user", content: "Hello streaming" }],
    }),
  });
  assert(res.ok);
  const reader = res.body?.getReader();
  assert(reader);
  const chunks = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  const text = chunks.join("");
  const lines = text.trim().split("\n");
  assert(lines.length >= 3);
  const first = JSON.parse(lines[0]);
  assertEquals(first.type, "start");
  const last = JSON.parse(lines[lines.length - 1]);
  assertEquals(last.type, "end");
});

Deno.test("AI models list", async () => {
  const res = await fetch(`${BASE}/api/ai/models`);
  assert(res.ok);
  const data = await res.json();
  assert(Array.isArray(data.models));
  assert(data.models.length >= 1);
  assert(typeof data.models[0].id === "string");
});

Deno.test("Login basic returns token", async () => {
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "secret" }),
  });
  assert(res.ok);
  const data = await res.json();
  assertEquals(data.proceed, true);
  assert(typeof data.token === "string");
});

Deno.test("Login with OTP flow", async () => {
  const startRes = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "bob-otp", password: "secret" }),
  });
  assert(startRes.ok);
  const start = await startRes.json();
  assertEquals(start.proceed, true);
  assertEquals(start.next_step, "otp");
  assert(typeof start.otp_jwt_token === "string");
  const otpRes = await fetch(`${BASE}/login/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: start.otp_jwt_token, code: "123456" }),
  });
  assert(otpRes.ok);
  const done = await otpRes.json();
  assertEquals(done.proceed, true);
  assertEquals(done.next_step, "complete");
  assert(typeof done.token === "string");
});

Deno.test("Logout with token", async () => {
  const loginRes = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "charlie", password: "secret" }),
  });
  assert(loginRes.ok);
  const login = await loginRes.json();
  const res = await fetch(`${BASE}/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${login.token}` },
  });
  assert(res.ok);
  const data = await res.json();
  assertEquals(data.proceed, true);
  assertEquals(data.status, "logged_out");
});
