// deno run --allow-net --allow-env --allow-read --allow-write main.js
// This file provides a minimal Deno backend that mimics parts of Puter's API.
// - No external dependencies
// - Works on Deno Deploy (uses Deno.serve + Deno KV)
// - Simple auth model: derives a "user id" from Authorization header or anonymous
// - Implements basic routes: /api/simple, /api/hello, /api/randName
// - KV Store: /api/kv/set, /api/kv/get, /api/kv/delete, /api/kv/list
// - FS Store (KV-backed): /api/fs/write, /api/fs/read, /api/fs/mkdir, /api/fs/copy, /api/fs/move, /api/fs/delete, /api/fs/list
// - AI Chat (stub, optionally uses OPENAI_API_KEY if present): /api/ai/chat
//
// Notes:
// - For KV and FS, a mandatory "myscope_" prefix is used to avoid collisions (similar to docs).
// - FS is implemented on top of Deno KV and supports simple file/dir operations.
// - Responses are JSON and CORS-enabled for simple frontend usage.
// - Keep error messages concise; comments explain key parts inline.

const kv = await Deno.openKv();

// ------------------------------
// Utilities
// ------------------------------

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}

function badRequest(message = "Bad Request") {
  return json(400, { error: message });
}
function notFound(message = "Not Found") {
  return json(404, { error: message });
}
function ok(data) {
  return json(200, data);
}

function ensureScopeKey(key) {
  // Mimic the "add a mandatory prefix" described in docs
  if (!key.startsWith("myscope_")) return "myscope_" + key;
  return key;
}

function parseAuthUser(req) {
  // Simple user-id derivation:
  // - If Authorization: Bearer <token> => uid = token
  // - Else, uid = "anonymous"
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return "anonymous";
}

function randName() {
  // Minimalistic random name generator (similar to puter.randName)
  // Winds up with readable and short names.
  const nouns = [
    "sky",
    "river",
    "leaf",
    "stone",
    "tree",
    "star",
    "cloud",
    "wind",
    "sun",
    "moon",
  ];
  const adjs = [
    "blue",
    "quiet",
    "swift",
    "bright",
    "soft",
    "sharp",
    "calm",
    "wild",
    "bold",
    "misty",
  ];
  const i1 = Math.floor(Math.random() * adjs.length);
  const i2 = Math.floor(Math.random() * nouns.length);
  const tail = Math.random().toString(36).slice(2, 6);
  return `${adjs[i1]}-${nouns[i2]}-${tail}`;
}

// ------------------------------
// KV API
// ------------------------------
//
// Keys are stored under ["kv", uid, key]
// Values are stored as JSON directly.

async function kvSet(uid, key, value) {
  const scopedKey = ensureScopeKey(key);
  const k = ["kv", uid, scopedKey];
  await kv.set(k, value);
  return { saved: true, key: scopedKey };
}

async function kvGet(uid, key) {
  const scopedKey = ensureScopeKey(key);
  const k = ["kv", uid, scopedKey];
  const r = await kv.get(k);
  return r.value ?? null;
}

async function kvDelete(uid, key) {
  const scopedKey = ensureScopeKey(key);
  const k = ["kv", uid, scopedKey];
  const r = await kv.delete(k);
  return { deleted: r.ok, key: scopedKey };
}

async function kvList(uid, prefix = "") {
  const scopedPrefix = ensureScopeKey(prefix);
  const iter = kv.list({ prefix: ["kv", uid, scopedPrefix] });
  const items = [];
  for await (const entry of iter) {
    const keyArr = entry.key; // ["kv", uid, "myscope_..."]
    const k = keyArr[2];
    items.push({ key: k, value: entry.value });
  }
  return items;
}

// ------------------------------
// FS API (KV-backed)
// ------------------------------
//
// Filesystem object stored in KV:
// - Files are stored at key ["fs", uid, path] with value: { type: "file", ctime, mtime, size, content: Uint8Array }
// - Directories at ["fs", uid, dirPathWithSlash] with value: { type: "dir", ctime, mtime }
//
// Conventions:
// - Root dir is "/"
// - Directory keys always end with "/"
// - File keys never end with "/"

function normalizePath(path) {
  if (!path || typeof path !== "string") return "/";
  try {
    // Clean multiple slashes, keep leading slash
    path = "/" + path.replace(/^\/*/, "").replace(/\/*$/, "");
    if (path === "/") return "/";
    return path;
  } catch (_) {
    return "/";
  }
}

function isDirPath(path) {
  return path === "/" || path.endsWith("/");
}

function asDirPath(path) {
  path = normalizePath(path);
  if (path === "/") return "/";
  return path.endsWith("/") ? path : path + "/";
}

function asFilePath(path) {
  path = normalizePath(path);
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function parentDirOf(path) {
  path = normalizePath(path);
  if (path === "/") return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/";
  return "/" + parts.slice(0, -1).join("/") + "/";
}

async function ensureDir(uid, dirPath) {
  const dp = asDirPath(dirPath);
  const key = ["fs", uid, dp];
  const r = await kv.get(key);
  if (!r.value) {
    const now = Date.now();
    await kv.set(key, { type: "dir", ctime: now, mtime: now });
  }
}

async function fsStat(uid, path) {
  // Returns value or null
  const key = ["fs", uid, isDirPath(path) ? asDirPath(path) : asFilePath(path)];
  const r = await kv.get(key);
  return r.value ?? null;
}

async function fsWrite(uid, path, contentBytes) {
  // Ensure parent dir exists, then write file
  const fp = asFilePath(path);
  const pdir = parentDirOf(fp);
  if (!pdir) return { error: "Cannot write to root" };
  await ensureDir(uid, pdir);
  const now = Date.now();
  const val = {
    type: "file",
    ctime: now,
    mtime: now,
    size: contentBytes.byteLength,
    content: contentBytes,
  };
  await kv.set(["fs", uid, fp], val);
  return { saved: true, path: fp, size: contentBytes.byteLength };
}

async function fsRead(uid, path) {
  const fp = asFilePath(path);
  const r = await kv.get(["fs", uid, fp]);
  const v = r.value;
  if (!v || v.type !== "file") return null;
  return v;
}

async function fsMkdir(uid, dirPath) {
  const dp = asDirPath(dirPath);
  const pdir = parentDirOf(dp);
  if (pdir) await ensureDir(uid, pdir);
  await ensureDir(uid, dp);
  return { created: true, path: dp };
}

async function fsDelete(uid, path) {
  // If it's a file, delete it
  // If it's a dir, delete recursively
  const isDir = isDirPath(path) || ((await fsStat(uid, path))?.type === "dir");
  if (!isDir) {
    const fp = asFilePath(path);
    await kv.delete(["fs", uid, fp]);
    return { deleted: true, path: fp };
  }

  // Recursive delete of dir subtree
  const dp = asDirPath(path);
  const iter = kv.list({ prefix: ["fs", uid, dp] });
  let count = 0;
  for await (const entry of iter) {
    await kv.delete(entry.key);
    count++;
  }
  // Delete the directory entry itself
  await kv.delete(["fs", uid, dp]);
  return { deleted: true, path: dp, removedChildren: count };
}

async function fsCopy(uid, src, dest) {
  // Handles file->file and file->directory copy.
  const s = await fsStat(uid, src);
  if (!s) return { error: "Source not found" };

  // If source is dir, copy recursively
  if (s.type === "dir") {
    const sd = asDirPath(src);
    const dd = asDirPath(dest);
    await ensureDir(uid, dd);

    // Copy subtree
    const iter = kv.list({ prefix: ["fs", uid, sd] });
    for await (const entry of iter) {
      const rel = entry.key[2].slice(sd.length - 1); // includes leading slash in sd except root edge
      const target = (dd + rel).replace(/\/{2,}/g, "/");
      if (entry.value?.type === "dir") {
        await ensureDir(uid, target);
      } else if (entry.value?.type === "file") {
        await fsWrite(uid, target, entry.value.content);
      }
    }
    return { copied: true, from: sd, to: dd };
  }

  // Source is file
  const fpSrc = asFilePath(src);
  // If dest ends with "/", copy inside directory with same filename
  let targetPath = dest;
  if (isDirPath(dest)) {
    const dd = asDirPath(dest);
    await ensureDir(uid, dd);
    const baseName = fpSrc.split("/").pop();
    targetPath = dd + baseName;
  }
  await fsWrite(uid, targetPath, s.content);
  return { copied: true, from: fpSrc, to: asFilePath(targetPath) };
}

async function fsMove(uid, src, dest) {
  // Move implemented as copy + delete
  const copyRes = await fsCopy(uid, src, dest);
  if (copyRes.error) return copyRes;
  await fsDelete(uid, src);
  return { moved: true, from: src, to: dest };
}

async function fsList(uid, dirPath) {
  const dp = asDirPath(dirPath || "/");
  // Ensure directory exists
  await ensureDir(uid, dp);

  // List immediate children by scanning prefix
  const iter = kv.list({ prefix: ["fs", uid, dp] });
  const seen = new Map();
  for await (const entry of iter) {
    const full = entry.key[2]; // the path (with or without trailing slash)
    const rel = full.slice(dp.length);
    if (!rel) continue;
    const first = rel.split("/")[0];
    if (!first) continue;

    // Child may be a file or a subdir
    const childPath = dp + first + (rel.indexOf("/") !== -1 ? "/" : "");
    if (!seen.has(childPath)) {
      seen.set(
        childPath,
        entry.value?.type || (childPath.endsWith("/") ? "dir" : "file"),
      );
    }
  }

  // Build final list with stats
  const items = [];
  for (const [childPath, guessedType] of seen.entries()) {
    const st = await fsStat(uid, childPath);
    if (st) {
      items.push({
        name: childPath.split("/").filter(Boolean).pop() || "/",
        path: childPath,
        type: st.type,
        size: st.type === "file" ? st.size : 0,
        mtime: st.mtime,
        ctime: st.ctime,
      });
    } else {
      // If missing, fallback to guessed type
      items.push({
        name: childPath.split("/").filter(Boolean).pop() || "/",
        path: childPath,
        type: guessedType,
        size: 0,
        mtime: null,
        ctime: null,
      });
    }
  }

  return items.sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------
// AI Chat (stub with optional OpenAI passthrough)
// ------------------------------
//
// POST /api/ai/chat
// Body:
// {
//   "messages": [
//     { "role": "user", "content": "Hello" },
//     ...
//   ]
// }
//
// If OPENAI_API_KEY is set, attempts to call OpenAI's Chat Completions (gpt-4o-mini).
// Otherwise, responds with a trivial assistant message.

function safeEnv(name) {
  try {
    return Deno.env.get(name) || undefined;
  } catch (_) {
    return undefined;
  }
}

function estimateTokensFromText(text) {
  const len = (text || "").length;
  return Math.max(1, Math.floor(len / 4));
}

function estimatePromptTokens(messages) {
  const joined = (messages || []).map((m) => String(m?.content || "")).join(
    "\n",
  );
  return estimateTokensFromText(joined);
}

async function recordUsage(uid, usage) {
  try {
    const key = ["ai_usage", uid, Date.now()];
    await kv.set(key, usage);
  } catch (_) {
    // silent catch
  }
}

async function aiChatComplete(uid, messages, model) {
  const openaiKey = safeEnv("OPENAI_API_KEY");
  const openaiBase = safeEnv("OPENAI_BASE_URL") || "https://api.openai.com";
  const selectedModel = model || (openaiKey ? "gpt-4o-mini" : "mock-echo");

  if (
    !openaiKey || selectedModel === "mock-echo" ||
    selectedModel.startsWith("mock:")
  ) {
    const lastUser = [...messages].reverse().find((m) =>
      m.role === "user"
    )?.content || "";
    const reply = `Echo: ${String(lastUser).slice(0, 200)}`;
    const usage = {
      prompt_tokens: estimatePromptTokens(messages),
      completion_tokens: estimateTokensFromText(reply),
      total_tokens: estimatePromptTokens(messages) +
        estimateTokensFromText(reply),
      model: selectedModel,
      provider: "mock",
    };
    await recordUsage(uid, usage);
    return {
      object: "chat.completion",
      model: selectedModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      }],
      usage,
      provider: "mock",
    };
  }

  const payload = { model: selectedModel, messages, temperature: 0.2 };
  const url = `${openaiBase.replace(/\/$/, "")}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const reply = `AI error (${res.status}): ${text.slice(0, 200)}`;
    const usage = {
      prompt_tokens: estimatePromptTokens(messages),
      completion_tokens: estimateTokensFromText(reply),
      total_tokens: estimatePromptTokens(messages) +
        estimateTokensFromText(reply),
      model: selectedModel,
      provider: "openai",
    };
    await recordUsage(uid, usage);
    return {
      object: "chat.completion",
      model: selectedModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      }],
      usage,
      provider: "openai",
    };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  const usage = {
    prompt_tokens: data?.usage?.prompt_tokens ?? estimatePromptTokens(messages),
    completion_tokens: data?.usage?.completion_tokens ??
      estimateTokensFromText(content),
    total_tokens:
      (data?.usage?.prompt_tokens ?? estimatePromptTokens(messages)) +
      (data?.usage?.completion_tokens ?? estimateTokensFromText(content)),
    model: selectedModel,
    provider: "openai",
  };
  await recordUsage(uid, usage);
  return {
    object: "chat.completion",
    model: selectedModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage,
    provider: "openai",
  };
}

async function aiAvailableModels() {
  const openaiKey = safeEnv("OPENAI_API_KEY");
  const openaiBase = safeEnv("OPENAI_BASE_URL") || "https://api.openai.com";
  const models = [{
    id: "mock-echo",
    provider: "mock",
    type: "chat",
    context: 4096,
  }];
  if (!openaiKey) return models;
  const url = `${openaiBase.replace(/\/$/, "")}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${openaiKey}` },
    });
    if (!res.ok) return models;
    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data : [];
    const normalized = list.map((m) => ({
      id: String(m.id),
      provider: "openai",
      type: "chat",
      context: 128000,
    }));
    return models.concat(normalized);
  } catch (_) {
    return models;
  }
}

async function aiChatStream(uid, messages, model) {
  const res = await aiChatComplete(uid, messages, model);
  const text = res?.choices?.[0]?.message?.content ?? "";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: "start", model: res.model }) + "\n",
        ),
      );
      const parts = String(text).split(/\s+/);
      for (const p of parts) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({ type: "delta", data: p + " " }) + "\n",
          ),
        );
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: "usage", usage: res.usage }) + "\n",
        ),
      );
      controller.enqueue(
        encoder.encode(JSON.stringify({ type: "end" }) + "\n"),
      );
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", ...CORS_HEADERS },
  });
}

// ------------------------------
// Routing
// ------------------------------

async function handle(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const { pathname, searchParams } = url;
  const uid = parseAuthUser(req);

  // Root
  if (req.method === "GET" && pathname === "/") {
    return ok({
      name: "Puter-like API (Deno)",
      status: "ok",
      endpoints: [
        "/api/simple",
        "/api/hello",
        "/api/randName",
        "/api/kv/set (POST)",
        "/api/kv/get (GET)",
        "/api/kv/delete (DELETE)",
        "/api/kv/list (GET)",
        "/api/fs/write (POST)",
        "/api/fs/read (GET)",
        "/api/fs/mkdir (POST)",
        "/api/fs/copy (POST)",
        "/api/fs/move (POST)",
        "/api/fs/delete (DELETE)",
        "/api/fs/list (GET)",
        "/api/ai/chat (POST)",
        "/api/ai/models (GET)",
      ],
      user: uid,
    });
  }

  // Simple examples based on docs
  if (req.method === "GET" && pathname === "/api/simple") {
    return ok({ status: "ok" });
  }
  if (req.method === "GET" && pathname === "/api/hello") {
    return ok({ message: "Hello, World!" });
  }

  // Rand name
  if (req.method === "GET" && pathname === "/api/randName") {
    return ok({ name: randName() });
  }

  // ------------- KV ENDPOINTS -------------
  if (req.method === "POST" && pathname === "/api/kv/set") {
    let body = null;
    try {
      body = await req.json();
    } catch (_) {
      return badRequest("Invalid JSON body");
    }
    const key = body?.key;
    const value = body?.value;
    if (!key || value === undefined) {
      return badRequest("Key and value required");
    }
    const r = await kvSet(uid, key, value);
    return ok(r);
  }

  if (req.method === "GET" && pathname === "/api/kv/get") {
    const key = searchParams.get("key");
    if (!key) return badRequest("Key required");
    const v = await kvGet(uid, key);
    return ok({ key: ensureScopeKey(key), value: v });
  }

  if (req.method === "DELETE" && pathname === "/api/kv/delete") {
    const key = searchParams.get("key");
    if (!key) return badRequest("Key required");
    const r = await kvDelete(uid, key);
    return ok(r);
  }

  if (req.method === "GET" && pathname === "/api/kv/list") {
    const prefix = searchParams.get("prefix") || "";
    const items = await kvList(uid, prefix);
    return ok({ items });
  }

  // ------------- FS ENDPOINTS -------------
  if (req.method === "POST" && pathname === "/api/fs/write") {
    // Body: { path, content, encoding? = "utf8" | "base64" }
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON");
    }
    const path = body?.path;
    const content = body?.content;
    const encoding = (body?.encoding || "utf8").toLowerCase();
    if (!path || content === undefined || content === null) {
      return badRequest("path and content are required");
    }

    // Decode content into bytes
    let bytes;
    try {
      if (encoding === "base64") {
        bytes = Uint8Array.from(atob(String(content)), (c) => c.charCodeAt(0));
      } else {
        bytes = new TextEncoder().encode(String(content));
      }
    } catch {
      return badRequest("Failed to decode content");
    }

    const res = await fsWrite(uid, path, bytes);
    if (res.error) return badRequest(res.error);
    return ok(res);
  }

  if (req.method === "GET" && pathname === "/api/fs/read") {
    // Query: path, encoding? = "utf8" | "base64"
    const path = searchParams.get("path");
    if (!path) return badRequest("path is required");
    const encoding = (searchParams.get("encoding") || "utf8").toLowerCase();

    const v = await fsRead(uid, path);
    if (!v) return notFound("File not found");
    let content;
    if (encoding === "base64") {
      content = btoa(String.fromCharCode(...new Uint8Array(v.content)));
    } else {
      content = new TextDecoder().decode(new Uint8Array(v.content));
    }
    return ok({
      path: asFilePath(path),
      size: v.size,
      mtime: v.mtime,
      ctime: v.ctime,
      encoding,
      content,
    });
  }

  if (req.method === "POST" && pathname === "/api/fs/mkdir") {
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON");
    }
    const path = body?.path;
    if (!path) return badRequest("path is required");
    const r = await fsMkdir(uid, path);
    return ok(r);
  }

  if (req.method === "POST" && pathname === "/api/fs/copy") {
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON");
    }
    const src = body?.src;
    const dest = body?.dest;
    if (!src || !dest) return badRequest("src and dest are required");
    const r = await fsCopy(uid, src, dest);
    if (r.error) return badRequest(r.error);
    return ok(r);
  }

  if (req.method === "POST" && pathname === "/api/fs/move") {
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON");
    }
    const src = body?.src;
    const dest = body?.dest;
    if (!src || !dest) return badRequest("src and dest are required");
    const r = await fsMove(uid, src, dest);
    if (r.error) return badRequest(r.error);
    return ok(r);
  }

  if (req.method === "DELETE" && pathname === "/api/fs/delete") {
    const path = searchParams.get("path");
    if (!path) return badRequest("path is required");
    const r = await fsDelete(uid, path);
    return ok(r);
  }

  if (req.method === "GET" && pathname === "/api/fs/list") {
    const path = searchParams.get("path") || "/";
    const items = await fsList(uid, path);
    return ok({ path: asDirPath(path), items });
  }

  // ------------- AI ENDPOINT -------------
  if (req.method === "POST" && pathname === "/api/ai/chat") {
    let body;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON");
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const model = body?.model || undefined;
    const stream = Boolean(body?.stream);
    if (stream) {
      return await aiChatStream(uid, messages, model);
    }
    const r = await aiChatComplete(uid, messages, model);
    return ok(r);
  }

  if (req.method === "GET" && pathname === "/api/ai/models") {
    return ok({ models: await aiAvailableModels() });
  }

  // ------------- USER INFO -------------
  if (req.method === "GET" && pathname === "/api/user") {
    // Very simple user info endpoint (mimics automatic auth availability)
    return ok({ username: uid, authenticated: uid !== "anonymous" });
  }

  return notFound("Route not found");
}

// ------------------------------
// Server bootstrap
// ------------------------------
//
// Deno.serve works both locally and on Deno Deploy.

Deno.serve(handle);
